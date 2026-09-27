# Data prep v4: thread corpus (real Latin-script Hinglish, 1,925 rows) +
# audited v3 data (superset-hasoc Devanagari + PRISM Hinglish) +
# TRANSLITERATION AUGMENTATION: Devanagari hate rows → Latin script
# (ISO-15919 → ASCII-strip). Split first, oversample train-only.
import re
import unicodedata
from pathlib import Path

import pandas as pd
from indic_transliteration import sanscript

OUT = Path('ml/prepared_v4'); OUT.mkdir(exist_ok=True)

def norm(t):
    return ' '.join(str(t).lower().split())

def to_ascii_roman(text):
    """Devanagari → phonetic Latin. Only transliterates Devanagari runs,
    leaves Latin words untouched (mixed code-mixed text stays coherent)."""
    def repl(m):
        try:
            rom = sanscript.transliterate(m.group(0), sanscript.DEVANAGARI, sanscript.ISO)
        except Exception:
            return m.group(0)
        rom = unicodedata.normalize('NFD', rom)
        rom = ''.join(c for c in rom if not unicodedata.combining(c))
        return rom.lower()
    return re.sub(r'[\u0900-\u097F]+', repl, text)

# ---- 1. real Latin-script Hinglish: thread corpus ----
threads = pd.read_csv('ml/prepared_v4/hasoc_cm_threads.csv')[['text', 'label']].rename(columns={'label': 'labels'})
threads['lang'] = 'hasoc-cm'
print('thread corpus:', len(threads), '| toxic', round(threads.labels.mean(), 3))

# ---- 2. audited v3 (hasoc-hindi Devanagari + PRISM hinglish) ----
v3 = pd.read_csv('ml/prepared_v3/hasoc_audit_full.csv') if Path('ml/prepared_v3/hasoc_audit_full.csv').exists() else None
if v3 is None:
    # rebuild the audited pool exactly as prepare_data_v3 did (pre-split)
    import json as _json
    sup = pd.read_csv('ml/data/india_hf.csv')
    h = sup[sup.dataset == 'hasoc'][['text', 'labels']].copy()
    h['lang'] = 'hasoc-hindi'
    prof = pd.read_csv('ml/data/hinglish_profanity_list.csv', header=None,
                       names=['term', 'gloss', 'severity'], encoding='cp1252')
    hard = set(prof[prof['severity'] >= 4]['term'].str.lower().str.strip())
    DEVA_VULGAR = ['चुदाई', 'चूतिया', 'चुतिया', 'मदरचोद', 'मादरचोद', 'बहनचोद',
                   'भड़वा', 'भड़वे', 'रंडी', 'गांड', 'गाँड', 'लौंडा', 'लोडा', 'भोसड़', 'चूची']
    def bad(t):
        t = norm(t)
        return any(w in t for w in DEVA_VULGAR) or any(s in t for s in hard)
    prism = pd.concat([pd.read_csv(f'ml/data/prism_{s}.csv') for s in ['train', 'val', 'test']])
    hing = prism[prism['lang'] == 'hinglish'][['text', 'label']].rename(columns={'label': 'labels'})
    hing['lang'] = 'hinglish-prism'
    v3 = pd.concat([h, hing], ignore_index=True)
    v3 = v3[v3['text'].map(norm).str.len() >= 3]
    v3['text_norm'] = v3['text'].map(norm)
    v3 = v3.drop_duplicates('text_norm')
    v3 = v3[~((v3.labels == 0) & v3['text_norm'].map(bad))]
    v3 = v3[['text', 'labels', 'lang']]
    print('v3 audited pool:', len(v3), '| toxic', round(v3.labels.mean(), 3))

# ---- 3. transliteration augmentation on Devanagari rows ----
deva = v3[v3['text'].str.contains('[\u0900-\u097F]', regex=True)].copy()
deva['text'] = deva['text'].map(to_ascii_roman)
deva['lang'] = 'translit-hinglish'
print('translit rows:', len(deva))

merged = pd.concat([threads, v3, deva], ignore_index=True)
merged['text_norm'] = merged['text'].map(norm)
merged = merged[merged['text_norm'].str.len() >= 3].drop_duplicates('text_norm')
print(f'merged+dedup: {len(merged)} | toxic {merged.labels.mean()*100:.1f}%')

# ---- 4. stratified 80/10/10, then train-only oversampling ----
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

# oversample: thread-corpus x3 (precious real Hinglish), toxic x2, translit x1
for _ in range(2):  # hasoc-cm x3 total
    train = pd.concat([train, train[train.lang == 'hasoc-cm']], ignore_index=True)
train = pd.concat([train, train[train.labels == 1]], ignore_index=True)  # toxic x2 total
train = train.sample(frac=1.0, random_state=42).reset_index(drop=True)

for name, d in [('train', train), ('val', val), ('test', test)]:
    d[['text', 'labels']].to_csv(OUT / f'{name}.csv', index=False)
    print(f'{name}: {len(d)} rows | toxic {d.labels.mean()*100:.1f}% | langs {d.lang.value_counts().to_dict()}')
