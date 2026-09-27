# Diagnose the torch-vs-ONNX score mismatch: compare raw logits from
# 1) torch model, 2) fp32 ONNX, 3) INT8 quantized ONNX — same inputs.
import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(12)
tok = AutoTokenizer.from_pretrained('xlm-roberta-base')
model = AutoModelForSequenceClassification.from_pretrained('unitary/multilingual-toxic-xlm-roberta')
model.eval()

import onnxruntime as ort

fp32 = ort.InferenceSession('ml/onnx/toxic-xlmr/onnx/model.onnx', providers=['CPUExecutionProvider'])
int8 = ort.InferenceSession('public/models/toxic-xlmr/onnx/model_quantized.onnx', providers=['CPUExecutionProvider'])
print('fp32 inputs:', [(i.name, i.shape) for i in fp32.get_inputs()])
print('int8 inputs:', [(i.name, i.shape) for i in int8.get_inputs()])

TEXTS = [
    'Muslims are vermin and should be exterminated',
    'Jews control the media and are ruining this country',
    'Black people are criminals and dont belong in our neighborhoods',
    'Trans people are mentally ill freaks',
    'This movie is stupid but the songs were okay',
    'The weather is lovely today, perfect for a walk',
]

for text in TEXTS:
    enc = tok(text, truncation=True, max_length=128, return_tensors='pt')
    with torch.no_grad():
        t_logit = model(**enc).logits[0].item()
    feeds = {k: v.numpy() for k, v in enc.items() if k in [i.name for i in fp32.get_inputs()]}
    f_logit = fp32.run(None, feeds)[0][0][0]
    feeds8 = {k: v.numpy() for k, v in enc.items() if k in [i.name for i in int8.get_inputs()]}
    q_logit = int8.run(None, feeds8)[0][0][0]
    print(f'torch={t_logit:+.3f} fp32onnx={f_logit:+.3f} int8onnx={q_logit:+.3f} :: {text[:50]}')
