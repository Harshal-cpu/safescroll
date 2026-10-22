"""Reproduce SafeScroll's browser-compatible image-safety model.

The upstream ResNet-50 is pinned and hash-verified. Static QDQ quantization is
not used because quantising ResNet activations without a representative private
training set materially changes logits. Instead, weights are symmetrically
quantised per output channel and restored by standard DequantizeLinear nodes.
This gives the ~4x file-size reduction and preserves numerical behaviour while
avoiding the ConvInteger operators unsupported by ONNX Runtime Web 1.14.

Requires the maintainer's Python environment to provide numpy, onnx, and
onnxruntime. These are build-time tools, not extension runtime dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper, numpy_helper

REVISION = "bc2e3ac9e09f12fc9f96187ba3c90a26292d2b52"
SOURCE_URL = f"https://huggingface.co/abhi099k/image-multi-detect/resolve/{REVISION}/model.onnx"
SOURCE_SHA256 = "fd36b610b1a280763238bb750885e56838965fbdad0c6b634cb1ea064eb060d3"
MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(rgb: np.ndarray) -> np.ndarray:
    return ((rgb.astype(np.float32) - MEAN) / STD)[None, ...]


def calibration_images(count: int = 64) -> list[np.ndarray]:
    """Deterministic natural-ish colors/textures spanning the input range."""
    rng = np.random.default_rng(20261008)
    images: list[np.ndarray] = []
    y = np.linspace(0, 1, 224, dtype=np.float32)[None, :, None]
    x = np.linspace(0, 1, 224, dtype=np.float32)[None, None, :]

    colors = [
        (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), (0.5, 0.5, 0.5),
        (0.85, 0.65, 0.50), (0.60, 0.08, 0.05), (0.05, 0.20, 0.55),
    ]
    for color in colors:
        images.append(normalized(np.broadcast_to(np.asarray(color, dtype=np.float32)[:, None, None], (3, 224, 224))))

    while len(images) < count:
        # Low-resolution random fields, nearest-neighbour enlarged, approximate
        # broad regions and edges better than independent-pixel white noise.
        small = rng.uniform(0, 1, (3, 28, 28)).astype(np.float32)
        field = np.repeat(np.repeat(small, 8, axis=1), 8, axis=2)
        tint = rng.uniform(0.15, 0.85, (3, 1, 1)).astype(np.float32)
        gradient = np.broadcast_to((0.35 * x + 0.25 * y), (3, 224, 224))
        rgb = np.clip(field * 0.45 + tint * 0.30 + gradient, 0, 1)
        images.append(normalized(rgb))
    return images


def quantize_weights_qdq(source: Path, output: Path) -> None:
    """Per-output-channel INT8 weights with float activations and Conv/Gemm."""
    model = onnx.load(source)
    initializers = {item.name: item for item in model.graph.initializer}
    replacements = {}
    dq_nodes = []

    for node in model.graph.node:
        if node.op_type not in {"Conv", "Gemm"} or len(node.input) < 2:
            continue
        name = node.input[1]
        if name in replacements or name not in initializers:
            continue
        values = numpy_helper.to_array(initializers[name])
        if values.dtype != np.float32 or values.ndim < 2:
            continue

        # Conv is [out, in, h, w]. This model's Gemm has transB=1 and weights
        # [out, in], so axis 0 is the output-channel axis for both.
        reduce_axes = tuple(range(1, values.ndim))
        scales = np.max(np.abs(values), axis=reduce_axes).astype(np.float32) / 127.0
        scales[scales == 0] = 1.0
        shape = (values.shape[0],) + (1,) * (values.ndim - 1)
        quantized = np.clip(np.rint(values / scales.reshape(shape)), -127, 127).astype(np.int8)

        q_name = f"{name}.int8"
        scale_name = f"{name}.scale"
        zero_name = f"{name}.zero"
        replacements[name] = [
            numpy_helper.from_array(quantized, q_name),
            numpy_helper.from_array(scales, scale_name),
            numpy_helper.from_array(np.zeros(values.shape[0], dtype=np.int8), zero_name),
        ]
        dq_nodes.append(helper.make_node(
            "DequantizeLinear", [q_name, scale_name, zero_name], [name],
            name=f"{name}.dequantize", axis=0,
        ))

    kept = [item for item in model.graph.initializer if item.name not in replacements]
    for rows in replacements.values():
        kept.extend(rows)
    del model.graph.initializer[:]
    model.graph.initializer.extend(kept)
    nodes = dq_nodes + list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model)
    onnx.save_model(model, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, help="Use an already-downloaded pinned source model")
    parser.add_argument(
        "--output", type=Path,
        default=Path("public/models/image-safety/model-int8.onnx"),
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="safescroll-image-model-") as tmp:
        source = args.source or Path(tmp) / "source.onnx"
        if not source.exists():
            print(f"Downloading pinned source: {SOURCE_URL}")
            urllib.request.urlretrieve(SOURCE_URL, source)
        actual = sha256(source)
        if actual != SOURCE_SHA256:
            raise SystemExit(f"source hash mismatch: {actual}")

        args.output.parent.mkdir(parents=True, exist_ok=True)
        quantize_weights_qdq(source, args.output)

        # Contract + numerical smoke test on deterministic holdout tensors.
        source_session = ort.InferenceSession(str(source), providers=["CPUExecutionProvider"])
        quant_session = ort.InferenceSession(str(args.output), providers=["CPUExecutionProvider"])
        errors = []
        for row in calibration_images(72)[64:]:
            a = source_session.run(None, {"input": row})[0]
            b = quant_session.run(None, {"input": row})[0]
            errors.append(float(np.max(np.abs(a - b))))
        print(f"output={args.output} bytes={args.output.stat().st_size} sha256={sha256(args.output)}")
        print(f"holdout max-logit-error={max(errors):.6f} mean={np.mean(errors):.6f}")


if __name__ == "__main__":
    main()
