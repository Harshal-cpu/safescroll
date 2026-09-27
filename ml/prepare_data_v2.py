# Data prep v2: merge India Hate Speech Superset (HASOC-derived, Devanagari-
# dominant, 13.2% toxic -> heavy imbalance) with PRISM Hinglish rows (Latin-
# script target domain). Clean 80/10/10 stratified split, THEN train-only
# oversampling (toxic x2 + Hinglish x2). No duplication leaks into val/test.
import pandas as pd
from pathlib import Path

OUT = Path('ml/prepared_v2'); OUT.mkdir(exist_ok=True)

def norm(t: str) -> str:
    return ' '.join(str(t).lower().split())

sup = pd.read_csv('ml/data/india_hf.csv')[['text', 'labels']]
sup['lang'] = 'superset'
prism_all = pd.concat([pd.read_csv(f'ml/data/prism_{s}.csv') for s in ['train', 'val', 'test']])
hing = prism_all[prism_all['lang'] == 'hinglish'][['text', 'label']].rename(columns={'label': 'labels'})
hing['lang'] = 'hinglish-prism'
print('superset rows:', len(sup), '| toxic:', round(sup['labels'].mean(), 3))
print('prism hinglish rows:', len(hing), '| toxic:', round(hing['labels'].mean(), 3))

merged = pd.concat([sup, hing], ignore_index=True)
merged['text_norm'] = merged['text'].map(norm)
merged = merged.drop_duplicates(subset='text_norm').sample(frac=1.0, random_state=42).reset_index(drop=True)
print(f'merged+dedup: {len(merged)} rows | toxic {merged.labels.mean()*100:.1f}%')

# --- clean stratified 80/10/10 on the DEDUPED pool ---
train_f, val_f, test_f = [], [], []
for label, g in merged.groupby('labels'):
    n = len(g)
    val_f.append(g.iloc[: int(n * 0.10)])
    test_f.append(g.iloc[int(n * 0.10): int(n * 0.20)])
    train_f.append(g.iloc[int(n * 0.20):])
train = pd.concat(train_f).sample(frac=1.0, random_state=42)
val = pd.concat(val_f).sample(frac=1.0, random_state=42)
test = pd.concat(test_f).sample(frac=1.0, random_state=42)

# --- oversample TRAIN ONLY: toxic x2 + Hinglish x2 ---
train = pd.concat([
    train,
    train[train.labels == 1],
    train[train.lang == 'hinglish-prism'],
]).sample(frac=1.0, random_state=42)

for name, d in [('train', train), ('val', val), ('test', test)]:
    d[['text', 'labels']].to_csv(OUT / f'{name}.csv', index=False)
    print(f'{name}: {len(d)} rows | toxic {d.labels.mean()*100:.1f}%')
