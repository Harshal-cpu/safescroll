"""Compare source and bundled image-safety model scores on labeled images.

Filenames beginning with Violence_ / NonViolence_ are understood, but any JPG
or PNG directory can be supplied. This is an offline maintainer diagnostic.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
OUTPUT_INDEXES = [1, 6, 2]  # violence, sensitive, weapon


def preprocess(path: Path) -> np.ndarray:
    image = Image.open(path).convert("RGB").resize((224, 224), Image.Resampling.BILINEAR)
    pixels = np.asarray(image, dtype=np.float32) / 255.0
    return ((pixels - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)


def probabilities(session: ort.InferenceSession, tensor: np.ndarray) -> np.ndarray:
    logits = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    return 1.0 / (1.0 + np.exp(-logits))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--model", type=Path, default=Path("public/models/image-safety/model-int8.onnx"))
    args = parser.parse_args()

    model = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    source = ort.InferenceSession(str(args.source), providers=["CPUExecutionProvider"]) if args.source else None
    files = sorted(p for p in args.directory.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    print(f"{'file':38} {'bundled violence/sensitive/weapon':34} source")
    for path in files:
        tensor = preprocess(path)
        bundled = probabilities(model, tensor)[OUTPUT_INDEXES]
        baseline = probabilities(source, tensor)[OUTPUT_INDEXES] if source else None
        print(f"{path.name:38} {np.round(bundled, 3)!s:34} {np.round(baseline, 3) if baseline is not None else ''}")


if __name__ == "__main__":
    main()
