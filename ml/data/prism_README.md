---
license: mit
language:
  - en
  - hi
tags:
  - hate-speech-detection
  - code-mixed
  - hinglish
  - text-classification
task_categories:
  - text-classification
size_categories:
  - 10K<n<100K
---

# PRISM - Code-Mixed Hinglish Hate-Speech Dataset

Binary hate-speech dataset of code-mixed Hindi-English (Hinglish) text, used in the project
*Developing a Sentiment Analysis Model for Code-Mixed Hindi-English (Hinglish) Text*
(RSET, The Assam Royal Global University). Source: `combined_hate_speech_dataset` on Kaggle.

**Companion model repository:** [Hinglish Hate-Speech Classification - BiLSTM / LSTM track](https://huggingface.co/pankajbiswas6/hinglish-hate-speech-bilstm)

## Summary

| Attribute | Value |
|-----------|-------|
| Total samples (raw) | 29,550 |
| Total samples (cleaned, used for splits) | 29,506 |
| Task | Binary classification |
| Labels | 0 = non-hate, 1 = hate |
| Languages | English, Hindi (Devanagari), Hinglish |
| Composition | English 15,000 / Hindi 9,767 / Hinglish 4,783 |
| Label balance | non-hate 53.5% / hate 46.5% |

## Files

- `data/prism_cleaned.csv` - full-feature export
  (`text, hate_label, source, profanity_score, language, dataset_version, combined_date, text_length, word_count`).
- `data/train.csv`, `data/val.csv`, `data/test.csv` - the modelling splits
  (`text, label, lang`), stratified 70/30 holdout with the train pool split 60/10 train/val.

| Split | Rows |
|-------|------|
| train | 17,704 |
| val | 2,950 |
| test | 8,852 |
| total | 29,506 |

> Note: `prism_cleaned.csv` contains 29,550 rows (the pre-dedup export). The splits reflect
> the final cleaned set of 29,506 rows (after removing 11 duplicate texts, 458 URL rows, and
> normalizing 2,176 elongated-word rows). Use the splits as the canonical cleaned data.

## Preprocessing

Lowercasing; removal of URLs, mentions, and hashtags; elongated-word and whitespace
normalization; duplicate removal. Retained features: `clean_text`, `hate_label`, `language`,
`text_length`, `word_count`.

## EDA

![Class distribution](figures/class_distribution.png)
![Language distribution](figures/language_distribution.png)
![Word count distribution](figures/word_count_distribution.png)

## Citation

Pulakala Prithvi Raj, Pankaj Biswas, Pritisha Goswami. *Developing a Sentiment Analysis Model
for Code-Mixed Hindi-English (Hinglish) Text.* B.Tech project, RSET, The Assam Royal Global
University, 2026. Guide: Dr. Dillip Rout.
