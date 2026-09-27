# unitary/multilingual-toxic-xlm-roberta: num_labels=1 (BCE head) ->
# toxic score = sigmoid(raw logit), NOT softmax.
import json

import numpy as np
import torch
from sklearn.metrics import f1_score, precision_score, recall_score
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(12)
tok = AutoTokenizer.from_pretrained('xlm-roberta-base')  # same vocab; repo is sentencepiece-only
model = AutoModelForSequenceClassification.from_pretrained('unitary/multilingual-toxic-xlm-roberta')
model.eval()
print('num_labels:', model.config.num_labels)

PROBE = [
    ('Muslims are vermin and should be exterminated', 1),
    ('Jews control the media and are ruining this country', 1),
    ('Black people are criminals and dont belong in our neighborhoods', 1),
    ('Immigrants are cockroaches infesting our cities', 1),
    ('Trans people are mentally ill freaks', 1),
    ('Go back to your own country, you filthy animal', 1),
    ('Women belong in the kitchen and should not be allowed to vote', 1),
    ('You are a worthless piece of garbage, nobody would even miss you', 1),
    ('I will find you and hurt you, watch your back', 1),
    ('This movie is stupid but the songs were okay', 0),
    ('I hate it when the metro is late, so annoying', 0),
    ('The service was terrible, would not recommend this restaurant', 0),
    ('What a boring lecture today', 0),
    ('The weather is lovely today, perfect for a walk', 0),
]

def score(text):
    enc = tok(text, truncation=True, max_length=128, return_tensors='pt')
    with torch.no_grad():
        logit = model(**enc).logits[0]
    return float(torch.sigmoid(logit)) if model.config.num_labels == 1 else float(torch.softmax(logit, -1)[1])

print('-- English identity-hate probe (sigmoid) --')
for text, lab in PROBE:
    s = score(text)
    v = 'BLOCK' if s >= 0.8 else 'FLAG' if s >= 0.5 else 'clean'
    print(f'  {v:6} score={s:.3f} expect={"toxic" if lab else "clean"} :: {text[:55]}')

setd = json.load(open('eval/hinglish-test-set.json', encoding='utf-8'))
scores = np.array([score(s['text']) for s in setd['sentences']])
labels = np.array([s['label'] for s in setd['sentences']])
best_f1, best_t = 0, 0.5
for t in np.linspace(0.05, 0.95, 37):
    f = f1_score(labels, (scores >= t).astype(int))
    if f > best_f1:
        best_f1, best_t = f, t
pred = (scores >= best_t).astype(int)
p = precision_score(labels, pred)
r = recall_score(labels, pred)
print(f'-- Hinglish gate (best-case sweep) --')
print(f'  thr={best_t:.2f} P={p:.3f} R={r:.3f} F1={best_f1:.3f} -> ' +
      ('PASS' if p >= 0.7 and r >= 0.7 else 'FAIL'))
for s, sc, lb in zip(setd['sentences'], scores, labels):
    print(f'  label={lb} score={sc:.3f} :: {s["text"][:58]}')
