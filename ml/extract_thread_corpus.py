# Scan the HASOC-style thread-annotation corpus:
# D:\safescroll\hinglish\{data,test}-*/data/{train,...}/<topic>/<tweet_id>/{data.json,labels.json}
# Emits flat rows: (text, label) where label=1 if HOF, 0 if NONE.
import json
from pathlib import Path

ROOT = Path(r'D:\safescroll\hinglish')
OUT = Path('ml/prepared_v4'); OUT.mkdir(exist_ok=True)

rows = []
seen_ids = set()
for archive in ROOT.iterdir():
    if not archive.is_dir():
        continue
    for data_root in archive.glob('data'):
        for split_dir in data_root.iterdir():  # train/...
            if not split_dir.is_dir():
                continue
            for topic_dir in split_dir.iterdir():
                if not topic_dir.is_dir():
                    continue
                for thread_dir in topic_dir.iterdir():
                    dj = thread_dir / 'data.json'
                    lj = thread_dir / 'labels.json'
                    if not dj.exists() or not lj.exists():
                        continue
                    try:
                        data = json.load(open(dj, encoding='utf-8'))
                        labels = json.load(open(lj, encoding='utf-8'))
                    except Exception as e:
                        print(f'skip corrupt: {thread_dir.name} ({e})')
                        continue
                    # root tweet
                    tid = str(data.get('tweet_id'))
                    if tid in labels and tid not in seen_ids:
                        seen_ids.add(tid)
                        rows.append({'text': data.get('tweet', ''), 'label': 1 if labels[tid] == 'HOF' else 0,
                                     'topic': topic_dir.name, 'split': split_dir.name})
                    # comments
                    for c in data.get('comments', []):
                        cid = str(c.get('tweet_id'))
                        if cid in labels and cid not in seen_ids:
                            seen_ids.add(cid)
                            rows.append({'text': c.get('tweet', ''), 'label': 1 if labels[cid] == 'HOF' else 0,
                                         'topic': topic_dir.name, 'split': split_dir.name})

import pandas as pd
df = pd.DataFrame(rows)
print(f'total labeled rows: {len(df)}')
print('label balance:', df['label'].value_counts().to_dict())
print('by topic:', df.groupby('topic')['label'].agg(['count', 'mean']).round(3).to_dict('index'))
dev = df['text'].str.contains('[\u0900-\u097F]', regex=True)
lat = df['text'].str.contains('[a-zA-Z]', regex=True)
print('script: devanagari', dev.sum(), '| latin', lat.sum(), '| both', (dev & lat).sum())
df['text_norm'] = df['text'].str.lower().str.split().str.join(' ')
df = df.drop_duplicates('text_norm')
print(f'after dedup: {len(df)} | toxic {df.label.mean()*100:.1f}%')
df[['text', 'label', 'topic']].to_csv(OUT / 'hasoc_cm_threads.csv', index=False)
print(df[df.label == 1].sample(6, random_state=1)[['text', 'topic']].to_string())
