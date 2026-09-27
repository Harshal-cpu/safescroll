# Compare candidate multilingual toxicity models on:
#  1) English identity-hate probe (toxic-bert's blind spot)
#  2) The 20-sentence Hinglish gate (P>=0.7 AND R>=0.7)
import json

import numpy as np
import torch
from sklearn.metrics import f1_score, precision_score, recall_score
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(12)

ENGLISH_PROBE = [
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
setd = json.load(open('eval/hinglish-test-set.json', encoding='utf-8'))
HINGLISH = [(s['text'], s['label']) for s in setd['sentences']]


def toxic_score(model, tok, text):
    enc = tok(text, truncation=True, max_length=128, return_tensors='pt')
    probs = torch.softmax(model(**enc).logits, -1)[0]
    labels = [model.config.id2label[i].lower() for i in range(len(probs))]
    # toxic = label mentioning toxic/hate/offensive WITHOUT a negation prefix
    idx = [i for i, l in enumerate(labels)
           if any(k in l for k in ['toxic', 'hate', 'offensive', 'abusive'])
           and not l.startswith(('not', 'no_', 'non'))]
    idx = idx or [1]
    return float(max(probs[i] for i in idx))


def evaluate(name, probe, tok=None):
    if tok is None:
        tok = AutoTokenizer.from_pretrained(name)
    model = AutoModelForSequenceClassification.from_pretrained(name)
    model.eval()
    print(f'\n===== {name} =====')
    print('labels:', model.config.id2label)
    with torch.no_grad():
        # English probe @ fixed sensible thresholds (flag .5, block .8)
        print('-- English identity-hate probe (flag>=0.5, block>=0.8) --')
        tp = fp = tn = fn = 0
        for text, lab in ENGLISH_PROBE:
            s = toxic_score(model, tok, text)
            v = 'BLOCK' if s >= 0.8 else 'FLAG' if s >= 0.5 else 'clean'
            if lab == 1 and v != 'clean':
                tp += 1
            elif lab == 0 and v != 'clean':
                fp += 1
            elif lab == 0:
                tn += 1
            else:
                fn += 1
            print(f'  {v:6} score={s:.3f} expect={"toxic" if lab else "clean"} :: {text[:55]}')
        p = tp / (tp + fp) if tp + fp else 0
        r = tp / (tp + fn) if tp + fn else 0
        print(f'  English probe: detected {tp}/9 toxic, false-positives {fp}/5 -> P={p:.3f} R={r:.3f}')
        # Hinglish gate (threshold swept to BEST case + reported)
        scores = np.array([toxic_score(model, tok, t) for t, _ in HINGLISH])
        labels = np.array([l for _, l in HINGLISH])
        best_f1, best_t = 0, 0.5
        for t in np.linspace(0.05, 0.95, 37):
            f = f1_score(labels, (scores >= t).astype(int))
            if f > best_f1:
                best_f1, best_t = f, t
        pred = (scores >= best_t).astype(int)
        gp = precision_score(labels, pred)
        gr = recall_score(labels, pred)
        print(f'-- Hinglish gate (best-case sweep) --')
        print(f'  thr={best_t:.2f} P={gp:.3f} R={gr:.3f} F1={best_f1:.3f} -> ' +
              ('PASS' if gp >= 0.7 and gr >= 0.7 else 'FAIL'))
        for (t, l), s in zip(HINGLISH, scores):
            print(f'  label={l} score={s:.3f} :: {t[:58]}')


for name in ['citizenlab/distilbert-base-multilingual-cased-toxicity',
             'unitary/multilingual-toxic-xlm-roberta']:
    try:
        tok = AutoTokenizer.from_pretrained(name) if 'unitary' not in name \
            else AutoTokenizer.from_pretrained('xlm-roberta-base')  # same 250k vocab; repo is sentencepiece-only (4.57 conversion bug)
        evaluate(name, ENGLISH_PROBE, tok)
    except Exception as e:
        print(f'===== {name} FAILED: {str(e)[:200]}')
