# Export the fine-tuned MuRIL checkpoint to ONNX (via optimum) and apply
# INT8 dynamic quantization. Produces the transformers.js-compatible layout:
#   public/models/muril-toxic/{config.json, tokenizer.json, ...}
#   public/models/muril-toxic/onnx/{model.onnx, model_quantized.onnx}
# Files are served from INSIDE the extension — no new remote host, no new CDN
# reference (same compliance pattern as the ORT wasm fix).
import json
import shutil
import sys
from pathlib import Path

from optimum.onnxruntime import ORTModelForSequenceClassification
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoTokenizer

SRC = sys.argv[1] if len(sys.argv) > 1 else 'ml/model/best'
NAME = sys.argv[2] if len(sys.argv) > 2 else 'muril-toxic'
TMP = Path('ml/onnx') / NAME
DEST = Path('public/models') / NAME

print('Exporting to ONNX via optimum...')
ort = ORTModelForSequenceClassification.from_pretrained(SRC, export=True)
if TMP.exists():
    shutil.rmtree(TMP)
ort.save_pretrained(str(TMP))
tok = AutoTokenizer.from_pretrained(SRC)
tok.save_pretrained(str(TMP))

print('Applying INT8 dynamic quantization...')
quantize_dynamic(
    str(TMP / 'model.onnx'),
    str(TMP / 'model_quantized.onnx'),
    weight_type=QuantType.QInt8,
)

# Restructure for transformers.js: move model.onnx* under onnx/
onnx_dir = TMP / 'onnx'
onnx_dir.mkdir(exist_ok=True)
for name in ['model.onnx', 'model_quantized.onnx']:
    if (TMP / name).exists():
        shutil.move(str(TMP / name), str(onnx_dir / name))

if DEST.exists():
    shutil.rmtree(DEST)
DEST.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(TMP, DEST)

sizes = {}
for p in sorted(DEST.rglob('*')):
    if p.is_file():
        sizes[str(p.relative_to(DEST))] = p.stat().st_size
print(json.dumps(sizes, indent=1))
total_onnx = sum(v for k, v in sizes.items() if k.endswith('.onnx'))
print(f'TOTAL onnx: uncompressed(model.onnx)={sizes.get("onnx/model.onnx", 0)/1e6:.1f}MB, '
      f'quantized={sizes.get("onnx/model_quantized.onnx", 0)/1e6:.1f}MB')
