# Export unitary/multilingual-toxic-xlm-roberta (num_labels=1, BCE head) to
# ONNX + INT8, bundled locally for transformers.js. Tokenizer from
# xlm-roberta-base (identical 250k vocab; unitary repo is sentencepiece-only
# and transformers 4.57's slow->fast conversion crashes on it).
import json
import shutil
from pathlib import Path

from optimum.onnxruntime import ORTModelForSequenceClassification
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoTokenizer

NAME = 'toxic-xlmr'
TMP = Path('ml/onnx') / NAME
DEST = Path('public/models') / NAME

print('Exporting to ONNX via optimum...')
ort = ORTModelForSequenceClassification.from_pretrained(
    'unitary/multilingual-toxic-xlm-roberta', export=True)
if TMP.exists():
    shutil.rmtree(TMP)
ort.save_pretrained(str(TMP))

# tokenizer: XLM-R fast tokenizer (same vocab) — with fix_mistral_regex=True:
# without it, the saved tokenizer.json tokenizes DIFFERENTLY in JS (verified
# bug: 'Jews' -> wrong token IDs -> wildly wrong toxicity scores)
tok = AutoTokenizer.from_pretrained('xlm-roberta-base', fix_mistral_regex=True)
tok.save_pretrained(str(TMP))

# CRITICAL for transformers.js v2: its Metaspace implementation reads the LEGACY
# 'add_prefix_space' field; new tokenizers only write 'prepend_scheme' -> without
# this patch, words are tokenized WITHOUT the ▁ marker and scores go wildly wrong.
tj = TMP / 'tokenizer.json'
cfg = json.load(open(tj, encoding='utf-8'))
for pt in cfg['pre_tokenizer']['pretokenizers']:
    if pt.get('type') == 'Metaspace':
        pt['add_prefix_space'] = True
        pt['prepend_scheme'] = 'always'
json.dump(cfg, open(tj, 'w', encoding='utf-8'), ensure_ascii=False)
print('tokenizer.json patched: Metaspace add_prefix_space=true')

print('Applying INT8 dynamic quantization...')
quantize_dynamic(
    str(TMP / 'model.onnx'),
    str(TMP / 'model_quantized.onnx'),
    weight_type=QuantType.QInt8,
)

# transformers.js layout: onnx/ subfolder
onnx_dir = TMP / 'onnx'
onnx_dir.mkdir(exist_ok=True)
for name in ['model.onnx', 'model_quantized.onnx']:
    if (TMP / name).exists():
        shutil.move(str(TMP / name), str(onnx_dir / name))

if DEST.exists():
    shutil.rmtree(DEST)
DEST.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(TMP, DEST)

sizes = {str(p.relative_to(DEST)): p.stat().st_size for p in sorted(DEST.rglob('*')) if p.is_file()}
print(json.dumps(sizes, indent=1))
print(f"fp32={sizes.get('onnx/model.onnx', 0)/1e6:.1f}MB  INT8={sizes.get('onnx/model_quantized.onnx', 0)/1e6:.1f}MB")
