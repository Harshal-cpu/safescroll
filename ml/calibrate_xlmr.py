# Calibrate two-tier thresholds for the BCE-head (num_labels=1) toxic-xlmr
# model on the v4 validation set (multilingual mix — NOT the eval gate set).
# flag = max-F1 operating point; block = max-precision with >=25 predicted.
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(os.cpu_count())
tok = AutoTokenizer.from_pretrained('xlm-roberta-base')
model = AutoModelForSequenceClassification.from_pretrained('unitary/multilingual-toxic-xlm-roberta')
model.eval()

df = pd.read_csv('ml/prepared_v4/val.csv')
texts = df['text'].astype(str).tolist()
labels = df['labels'].values

scores = []
with torch.no_grad():
    for i in range(0, len(texts), 64):
        enc = tok(texts[i:i + 64], truncation=True, max_length=96, padding=True, return_tensors='pt')
        scores.extend(torch.sigmoid(model(**enc).logits[:, 0]).tolist())
scores = np.array(scores)

def pr_at(t):
    pred = scores >= t
    tp = int(((pred == 1) & (labels == 1)).sum())
    fp = int(((pred == 1) & (labels == 0)).sum())
    fn = int(((pred == 0) & (labels == 1)).sum())
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f1

grid = np.linspace(0.05, 0.95, 91)
best_f1, best_thr = 0, 0.5
for t in grid:
    p, r, f1 = pr_at(t)
    if f1 > best_f1:
        best_f1, best_thr = f1, t

block_thr, block_stats = 0.95, (0.0, 0.0, 0.0)
for t in sorted(grid, reverse=True):
    p, r, f1 = pr_at(t)
    n_pred = int((scores >= t).sum())
    if p >= 0.85 and n_pred >= 25:
        block_thr, block_stats = t, (p, r, f1)
        break
    if block_stats[0] == 0.0 and n_pred >= 25:
        block_thr, block_stats = t, (p, r, f1)

out = {
    'flagThreshold': round(float(best_thr), 3),
    'flagValMetrics': dict(zip(['precision', 'recall', 'f1'], map(lambda x: round(x, 4), pr_at(best_thr)))),
    'blockThreshold': round(float(block_thr), 3),
    'blockValMetrics': dict(zip(['precision', 'recall', 'f1'], map(lambda x: round(x, 4), block_stats))),
    'maxValScore': round(float(scores.max()), 3)
}
Path('ml/prepared/thresholds-xlmr.json').write_text(json.dumps(out, indent=1))
print(json.dumps(out, indent=1))
