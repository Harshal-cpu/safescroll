# Test published ungated Hinglish hate models against the 20-sentence gate.
import json

import numpy as np
import torch
from sklearn.metrics import f1_score, precision_score, recall_score
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(12)
setd = json.load(open('eval/hinglish-test-set.json', encoding='utf-8'))

for name in ['Keshav0av/HinTox-hinglish-hate-speech-abuse-detection',
             'niksss/Hinglish-HATEBERT']:
    try:
        tok = AutoTokenizer.from_pretrained(name)
        model = AutoModelForSequenceClassification.from_pretrained(name)
        model.eval()
        print('===', name, '| id2label:', model.config.id2label)
        scores = []
        with torch.no_grad():
            for s in setd['sentences']:
                enc = tok(s['text'], truncation=True, max_length=128, return_tensors='pt')
                probs = torch.softmax(model(**enc).logits, -1)[0]
                labels_l = [model.config.id2label[i].lower() for i in range(len(probs))]
                tox_idx = [i for i, l in enumerate(labels_l)
                           if any(k in l for k in ['hate', 'toxic', 'offensive', 'abuse', 'ogt', 'cag'])] or [1]
                scores.append(float(max(probs[i] for i in tox_idx)))
        scores = np.array(scores)
        labels = np.array([s['label'] for s in setd['sentences']])
        best_f1, best_t = 0, 0.5
        for t in np.linspace(0.05, 0.95, 19):
            f = f1_score(labels, (scores >= t).astype(int))
            if f > best_f1:
                best_f1, best_t = f, t
        pred = (scores >= best_t).astype(int)
        print(f'best thr={best_t:.2f} P={precision_score(labels, pred):.3f} '
              f'R={recall_score(labels, pred):.3f} F1={f1_score(labels, pred):.3f}')
        for s, sc, lb in zip(setd['sentences'], scores, labels):
            print(f"  label={lb} score={sc:.3f} :: {s['text'][:60]}")
    except Exception as e:
        print('===', name, 'FAILED:', str(e)[:200])
