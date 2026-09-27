# Data prep v3 — AUDITED (option 1: half-day manual data audit).
# Audit protocol (documented in eval/RESULTS.md Entry 5):
#   1. Drop the superset 'hostility detection' subset entirely (8.2k rows with a
#      conflicting political-hostility label convention) — keep only 'hasoc'.
#   2. Manual spot-check of both label classes (done: hate labels genuine
#      HOF-convention; clean labels contained PROVABLE errors — explicit vulgar
#      content labeled 0).
#   3. Mechanical contradiction removal: drop clean-labeled rows containing
#      high-confidence vulgar tokens (Devanagari list below + Hinglish
#      profanity list entries with severity >= 4).
#   4. Merge with PRISM Hinglish (Latin-script domain), dedup, stratified
#      80/10/10, train-only oversampling (toxic x2, Hinglish x2).
import pandas as pd
from pathlib import Path

OUT = Path('ml/prepared_v3'); OUT.mkdir(exist_ok=True)

def norm(t: str) -> str:
    return ' '.join(str(t).lower().split())

# High-confidence Devanagari vulgar/slur tokens (unambiguous in any convention)
DEVA_VULGAR = ['चुदाई', 'चुदाई', 'चूतिया', 'चुतिया', 'मदरचोद', 'मादरचोद', 'बहनचोद',
               'भड़वा', 'भड़वे', 'रंडी', 'गांड', 'गाँड', 'लौंडा', 'लोडा', 'भोसड़', 'चूची']

# Hinglish profanity list: keep only severity >= 4 (hard slurs)
prof = pd.read_csv('ml/data/hinglish_profanity_list.csv', header=None,
                   names=['term', 'gloss', 'severity'], encoding='cp1252')
prof['term'] = prof['term'].str.lower().str.strip()
hard_slurs = set(prof[prof['severity'] >= 4]['term'])
print(f'profanity list: {len(prof)} terms, {len(hard_slurs)} severity>=4 (audit filter)')

def contradicts_clean(text_norm: str) -> bool:
    if any(w in text_norm for w in DEVA_VULGAR):
        return True
    return any(t in text_norm for t in hard_slurs)

sup = pd.read_csv('ml/data/india_hf.csv')
h = sup[sup.dataset == 'hasoc'][['text', 'labels']].copy()
h['lang'] = 'hasoc-hindi'
print(f'hasoc subset: {len(h)} rows | toxic {h.labels.mean()*100:.1f}%')

prism = pd.concat([pd.read_csv(f'ml/data/prism_{s}.csv') for s in ['train', 'val', 'test']])
hing = prism[prism['lang'] == 'hinglish'][['text', 'label']].rename(columns={'label': 'labels'})
hing['lang'] = 'hinglish-prism'

merged = pd.concat([h, hing], ignore_index=True)
merged['text_norm'] = merged['text'].map(norm)
merged = merged[merged['text_norm'].str.len() >= 3]
n0 = len(merged)
merged = merged.drop_duplicates(subset='text_norm')
print(f'dedup: {n0} -> {len(merged)}')

# --- audit filter: remove PROVABLE label errors on the clean side ---
clean_mask = (merged.labels == 0) & merged['text_norm'].map(contradicts_clean)
print(f'audit: removing {clean_mask.sum()} clean-labeled rows containing unambiguous vulgar/slur tokens')
dropped = merged[clean_mask].sample(min(5, int(clean_mask.sum())), random_state=1)[['text', 'labels']]
for _, r in dropped.iterrows():
    print(f'  dropped: {r.text[:90]}')
merged = merged[~clean_mask]
print(f'after audit: {len(merged)} rows | toxic {merged.labels.mean()*100:.1f}%')

# --- stratified 80/10/10 on the clean pool ---
merged = merged.sample(frac=1.0, random_state=42).reset_index(drop=True)
train_f, val_f, test_f = [], [], []
for label, g in merged.groupby('labels'):
    n = len(g)
    val_f.append(g.iloc[: int(n * 0.10)])
    test_f.append(g.iloc[int(n * 0.10): int(n * 0.20)])
    train_f.append(g.iloc[int(n * 0.20):])
train = pd.concat(train_f).sample(frac=1.0, random_state=42)
val = pd.concat(val_f).sample(frac=1.0, random_state=42)
test = pd.concat(test_f).sample(frac=1.0, random_state=42)

# --- train-only oversampling: toxic x2 + Hinglish x2 ---
train = pd.concat([
    train,
    train[train.labels == 1],
    train[train.lang == 'hinglish-prism'],
]).sample(frac=1.0, random_state=42)

for name, d in [('train', train), ('val', val), ('test', test)]:
    d[['text', 'labels']].to_csv(OUT / f'{name}.csv', index=False)
    print(f'{name}: {len(d)} rows | toxic {d.labels.mean()*100:.1f}%')
