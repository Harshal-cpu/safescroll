# Fallback fine-tune: microsoft/Multilingual-MiniLM-L12-H384 (ALBERT, ~33M params).
# Switch reason (explicit, per task instructions): MuRIL FAILED the Hinglish
# eval gate (P=0.500/R=1.000 — no discrimination) AND its INT8 quantized
# export is 238MB (3-4x over the 50-80MB target). indic-bert is the task-
# sanctioned fallback and is small enough for a FULL fine-tune on this CPU box
# (~33M params), removing the partial-FT compromise.
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
BASE = 'microsoft/Multilingual-MiniLM-L12-H384'
OUT = Path('ml/model-v3'); OUT.mkdir(exist_ok=True, parents=True)
LOG = Path('eval/training_log.md'); LOG.parent.mkdir(exist_ok=True)

tok = AutoTokenizer.from_pretrained('xlm-roberta-base')
# NOTE: MiniLM-L12-H384 ships only sentencepiece.bpe.model and transformers
# 4.57's slow->fast conversion crashes (mistral-regex bug). The model was
# initialized from XLM-R and uses the identical 250k vocab/sentencepiece
# model, so the official XLM-R fast tokenizer is a drop-in.

df = pd.read_csv('ml/prepared_v3/train.csv')
# subsample to 14k for CPU wall-time (oversampled dupes included)
df = df.sample(n=min(14000, len(df)), random_state=42).reset_index(drop=True)
print(f'train rows: {len(df)}')

def to_ds(d):
    ds = Dataset.from_pandas(d[['text', 'labels']], preserve_index=False)
    return ds.map(lambda b: tok(b['text'], truncation=True, max_length=96), batched=True)

train_ds = to_ds(df)
val_ds = to_ds(pd.read_csv('ml/prepared_v3/val.csv'))

model = AutoModelForSequenceClassification.from_pretrained(
    BASE, num_labels=2,
    id2label={0: 'non-toxic', 1: 'toxic'}, label2id={'non-toxic': 0, 'toxic': 1}
)
# FULL fine-tune this time (small enough for CPU)
print(f'trainable params: {sum(p.numel() for p in model.parameters() if p.requires_grad)/1e6:.1f}M (FULL FT)')

def compute_metrics(p):
    preds = p.predictions.argmax(-1)
    pr, rc, f1, _ = precision_recall_fscore_support(
        p.label_ids, preds, average='binary', pos_label=1, zero_division=0)
    return {'precision': pr, 'recall': rc, 'f1': f1}

def log_line(s):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(s + '\n')

log_line(f'\n## Run {time.strftime("%Y-%m-%d %H:%M:%S")} — base={BASE} (FALLBACK after MuRIL gate FAIL), '
         f'FULL-FT on AUDITED v3: hasoc-only + PRISM-Hinglish, contradiction filter, train={len(train_ds)}, val={len(val_ds)}, max_len=96, epochs=2, train subsampled 14k')
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
    per_device_train_batch_size=16,
    per_device_eval_batch_size=32,
    learning_rate=2e-5,
    warmup_ratio=0.1,
    weight_decay=0.01,
    eval_strategy='epoch',
    save_strategy='epoch',
    load_best_model_at_end=True,
    metric_for_best_model='f1',
    greater_is_better=True,
    save_total_limit=2,
    group_by_length=True,
    dataloader_num_workers=0,
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
import traceback
try:
    ckpt = next(OUT.glob('checkpoint-*'), None)
    trainer.train(resume_from_checkpoint=str(ckpt) if ckpt else False)
except BaseException:
    with open('ml/train_minilm_crash.log', 'w', encoding='utf-8') as f:
        f.write(traceback.format_exc())
    raise
log_line(f'\nTraining wall time: {(time.time() - t0) / 60:.1f} min; best checkpoint = {trainer.state.best_model_checkpoint}')

final = trainer.evaluate()
log_line(f"\nBEST checkpoint val metrics: {json.dumps(final, indent=1)}")
trainer.save_model(str(OUT / 'best'))
tok.save_pretrained(str(OUT / 'best'))
print('DONE. Best model saved to ml/model-v3/best')







