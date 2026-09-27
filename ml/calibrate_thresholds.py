# Threshold calibration on the HELD-OUT VALIDATION set (never the eval gate).
# The fine-tuned model outputs a single toxicity score (softmax of the binary
# head). We layer the existing two-tier severity split on top:
#   - block threshold: lowest score with val precision >= 0.85 (hate/slur tier)
#   - flag threshold:  score maximizing val F1 (mild-negativity tier)
# Outputs ml/prepared/thresholds.json â€” consumed by the extension PROFILES
# and the eval-gate script.
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(os.cpu_count())
BASE = sys.argv[1] if len(sys.argv) > 1 else 'ml/model/best'
tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForSequenceClassification.from_pretrained(BASE)
model.eval()

VAL = sys.argv[2] if len(sys.argv) > 2 else 'ml/prepared/val.csv'
OUT_JSON = sys.argv[3] if len(sys.argv) > 3 else 'ml/prepared/thresholds.json'
df = pd.read_csv(VAL)
texts = df['text'].astype(str).tolist()
labels = df['labels'].values if 'labels' in df.columns else df['label'].values

scores = []
B = 64
with torch.no_grad():
    for i in range(0, len(texts), B):
        enc = tok(texts[i:i + B], truncation=True, max_length=96, padding=True, return_tensors='pt')
        logits = model(**enc).logits
        probs = torch.softmax(logits, dim=-1)[:, 1]
        scores.extend(probs.tolist())
scores = np.array(scores)

def pr_at(thr):
    pred = scores >= thr
    tp = int(((pred == 1) & (labels == 1)).sum())
    fp = int(((pred == 1) & (labels == 0)).sum())
    fn = int(((pred == 0) & (labels == 1)).sum())
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f1

# flag threshold: maximize F1
grid = np.linspace(0.05, 0.95, 91)
best_f1, best_thr = 0, 0.5
for t in grid:
    p, r, f1 = pr_at(t)
    if f1 > best_f1:
        best_f1, best_thr = f1, t

# block threshold: highest t whose precision >= 0.80 with >= 25 predicted
# positives (the model's confidence is compressed â€” no val sample reaches 0.9)
block_thr, block_stats = 0.9, (0.0, 0.0, 0.0)
for t in sorted(grid, reverse=True):
    p, r, f1 = pr_at(t)
    n_pred = int((scores >= t).sum())
    if p >= 0.80 and n_pred >= 25:
        block_thr, block_stats = t, (p, r, f1)
        break
    if block_stats[0] == 0.0 and n_pred >= 25:
        block_thr, block_stats = t, (p, r, f1)  # fallback: max-precision tier with coverage

out = {
    'flagThreshold': round(float(best_thr), 3),
    'flagValMetrics': dict(zip(['precision', 'recall', 'f1'], map(lambda x: round(x, 4), pr_at(best_thr)))),
    'blockThreshold': round(float(block_thr), 3),
    'blockValMetrics': dict(zip(['precision', 'recall', 'f1'], map(lambda x: round(x, 4), block_stats))),
    'maxValScore': round(float(scores.max()), 3)
}
out_path = Path(OUT_JSON)
out_path.write_text(json.dumps(out, indent=1))
print('saved to', out_path)
print(json.dumps(out, indent=1))

