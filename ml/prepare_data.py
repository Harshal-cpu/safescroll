# Data prep for MuRIL Hinglish toxicity fine-tuning.
# Source: pankajbiswas6/prism-hinglish-hate-speech (MIT) — SUBSTITUTION for
# HASOC/TRAC originals (require manual registration agreements; mirrors were
# unlabeled or corrupted — see eval/RESULTS.md).
# - uses provided stratified splits (60/10/30), re-verifies no cross-split dupes
# - binary label mapping: 0=non-toxic, 1=toxic (dataset is already binary)
# - oversamples Hinglish rows 2x in TRAIN only (target domain)
# - our 20-sentence eval set is NOT touched — separate acceptance gate
import pandas as pd
from pathlib import Path

DATA = Path('ml/data')
OUT = Path('ml/prepared')
OUT.mkdir(exist_ok=True)

def norm(t: str) -> str:
    return ' '.join(str(t).lower().split())

splits = {}
for name in ['train', 'val', 'test']:
    df = pd.read_csv(DATA / f'prism_{name}.csv')
    df = df.dropna(subset=['text', 'label'])
    df['text_norm'] = df['text'].map(norm)
    df = df[df['text_norm'].str.len() >= 3]
    splits[name] = df
    print(f'{name}: {len(df)} rows | label balance: '
          f'{(df.label == 1).mean() * 100:.1f}% toxic')

# Cross-split duplicate check on normalized text
train_texts = set(splits['train']['text_norm'])
leaks = 0
for name in ['val', 'test']:
    overlap = set(splits[name]['text_norm']) & train_texts
    leaks += len(overlap)
    print(f'cross-split overlap train~{name}: {len(overlap)} (removing from {name})')
    splits[name] = splits[name][~splits[name]['text_norm'].isin(train_texts)]

# Dedup within each split
for name in splits:
    before = len(splits[name])
    splits[name] = splits[name].drop_duplicates(subset='text_norm')
    print(f'{name}: dedup removed {before - len(splits[name])}')

# Oversample Hinglish in train 2x
tr = splits['train']
hing = tr[tr['lang'] == 'hinglish']
splits['train'] = pd.concat([tr, hing], ignore_index=True)
print(f'train after 2x Hinglish oversample: {len(splits["train"])} rows')

for name, df in splits.items():
    out = df[['text', 'label', 'lang']].reset_index(drop=True)
    out.to_csv(OUT / f'{name}.csv', index=False)
    print(f'wrote {name}.csv: {len(out)} rows | '
          f'{(out.label == 1).mean() * 100:.1f}% toxic | '
          f'lang mix: {out.lang.value_counts().to_dict()}')
