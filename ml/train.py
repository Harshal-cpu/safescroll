# Fine-tune google/muril-base-cased for binary Hinglish/code-mixed toxicity.
#
# EXPLICIT SCOPE ADJUSTMENTS for CPU-only training box (12 cores, no GPU) —
# stated, not silent:
#   1. Partial fine-tune: embeddings + encoder layers 0-7 frozen; layers 8-11,
#      pooler and classifier trained (28.9M/237.6M params). Full FT benchmarked
#      at ~8-10h wall time here — infeasible; partial FT is standard transfer
#      learning practice.
#   2. Train subsampled to 10,000 rows, stratified by (label, lang) to preserve
#      class balance AND Hinglish representation.
#   3. 2 epochs (early stopping patience 1), max_len 96 (covers p95=90 tokens).
# Per-epoch metrics logged to eval/training_log.md. Best checkpoint saved by
# validation F1.
import json
import os
import time
from pathlib import Path

os.environ['TOKENIZERS_PARALLELISM'] = 'false'
import pandas as pd
import torch
from datasets import Dataset
from sklearn.metrics import precision_recall_fscore_support
from transformers import (AutoModelForSequenceClassification, AutoTokenizer,
                          DataCollatorWithPadding, EarlyStoppingCallback,
                          Trainer, TrainerCallback, TrainingArguments)

torch.set_num_threads(os.cpu_count())
BASE = 'google/muril-base-cased'
OUT = Path('ml/model'); OUT.mkdir(exist_ok=True, parents=True)
LOG = Path('eval/training_log.md'); LOG.parent.mkdir(exist_ok=True)

tok = AutoTokenizer.from_pretrained(BASE)

# ---- stratified subsample: 10k by (label, lang) ----
df = pd.read_csv('ml/prepared/train.csv')
N_TRAIN = 10000
parts = []
for (label, lang), g in df.groupby(['label', 'lang']):
    n = max(1, int(round(N_TRAIN * len(g) / len(df))))
    parts.append(g.sample(n=min(n, len(g)), random_state=42))
sub = pd.concat(parts).sample(frac=1.0, random_state=42).reset_index(drop=True)
print(f'train subsample: {len(sub)} rows | toxic {sub.label.mean()*100:.1f}% | langs {sub.lang.value_counts().to_dict()}')
sub[['text', 'label']].to_csv('ml/prepared/train_sub.csv', index=False)

def to_ds(csv):
    d = pd.read_csv(csv)
    ds = Dataset.from_pandas(d[['text', 'label']].rename(columns={'label': 'labels'}), preserve_index=False)
    return ds.map(lambda b: tok(b['text'], truncation=True, max_length=96), batched=True)

train_ds = to_ds('ml/prepared/train_sub.csv')
val_ds = to_ds('ml/prepared/val.csv')

model = AutoModelForSequenceClassification.from_pretrained(
    BASE, num_labels=2,
    id2label={0: 'non-toxic', 1: 'toxic'}, label2id={'non-toxic': 0, 'toxic': 1}
)

# ---- partial fine-tune: freeze embeddings + encoder layers 0-7 ----
for p in model.bert.embeddings.parameters():
    p.requires_grad = False
for layer in model.bert.encoder.layer[:8]:
    for p in layer.parameters():
        p.requires_grad = False
n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f'trainable params: {n_trainable/1e6:.1f}M / {sum(p.numel() for p in model.parameters())/1e6:.1f}M')

def compute_metrics(p):
    preds = p.predictions.argmax(-1)
    pr, rc, f1, _ = precision_recall_fscore_support(
        p.label_ids, preds, average='binary', pos_label=1, zero_division=0)
    return {'precision': pr, 'recall': rc, 'f1': f1}

def log_line(s):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(s + '\n')

log_line(f'\n## Run {time.strftime("%Y-%m-%d %H:%M:%S")} — base={BASE}, PARTIAL-FT (frozen emb+layers0-7), '
         f'train={len(train_ds)} (subsampled 10k stratified), val={len(val_ds)}, max_len=96, epochs=2')
log_line('| epoch | val_loss | precision | recall | f1 |')
log_line('|---|---|---|---|---|')

class LogCallback(TrainerCallback):
    def on_evaluate(self, args, state, control, metrics=None, **kw):
        log_line(f"| {metrics.get('epoch')} | {metrics.get('eval_loss', 0):.4f} | "
                 f"{metrics.get('eval_precision', 0):.4f} | {metrics.get('eval_recall', 0):.4f} | "
                 f"{metrics.get('eval_f1', 0):.4f} |")

args = TrainingArguments(
    output_dir=str(OUT),
    num_train_epochs=2,
    per_device_train_batch_size=32,
    per_device_eval_batch_size=64,
    learning_rate=3e-5,
    warmup_ratio=0.1,
    weight_decay=0.01,
    eval_strategy='epoch',
    save_strategy='epoch',
    load_best_model_at_end=True,
    metric_for_best_model='f1',
    greater_is_better=True,
    save_total_limit=2,
    group_by_length=True,
    dataloader_num_workers=0,  # Windows + redirected stdout: worker processes hang
    logging_steps=25,
    report_to=[],
    seed=42,
)

trainer = Trainer(
    model=model,
    args=args,
    train_dataset=train_ds,
    eval_dataset=val_ds,
    data_collator=DataCollatorWithPadding(tok),
    compute_metrics=compute_metrics,
    callbacks=[EarlyStoppingCallback(early_stopping_patience=1), LogCallback()],
)

t0 = time.time()
trainer.train()
log_line(f'\nTraining wall time: {(time.time() - t0) / 60:.1f} min; best checkpoint = {trainer.state.best_model_checkpoint}')

final = trainer.evaluate()
log_line(f"\nBEST checkpoint val metrics: {json.dumps(final, indent=1)}")
trainer.save_model(str(OUT / 'best'))
tok.save_pretrained(str(OUT / 'best'))
print('DONE. Best model saved to ml/model/best')
