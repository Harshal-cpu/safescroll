
## Run 2026-09-24 13:02:54 — base=google/muril-base-cased, train=20582, val=2950, max_len=128
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|

## Run 2026-09-24 13:24:23 — base=google/muril-base-cased, PARTIAL-FT (frozen emb+layers0-7), train=9999 (subsampled 10k stratified), val=2950, max_len=96, epochs=2
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|

## Run 2026-09-24 13:24:47 — base=google/muril-base-cased, PARTIAL-FT (frozen emb+layers0-7), train=9999 (subsampled 10k stratified), val=2950, max_len=96, epochs=2
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|

## Run 2026-09-24 13:42:15 — base=google/muril-base-cased, PARTIAL-FT (frozen emb+layers0-7), train=9999 (subsampled 10k stratified), val=2950, max_len=96, epochs=2
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.6125 | 0.6494 | 0.6964 | 0.6721 |
| 2.0 | 0.5837 | 0.6906 | 0.6401 | 0.6644 |

Training wall time: 37.6 min; best checkpoint = ml\model\checkpoint-313
| 2.0 | 0.6125 | 0.6494 | 0.6964 | 0.6721 |

BEST checkpoint val metrics: {
 "eval_loss": 0.6124677062034607,
 "eval_precision": 0.6494213750850919,
 "eval_recall": 0.6963503649635037,
 "eval_f1": 0.6720676294469884,
 "eval_runtime": 116.8374,
 "eval_samples_per_second": 25.249,
 "eval_steps_per_second": 0.402,
 "epoch": 2.0
}

## Run 2026-09-24 15:02:09 — base=microsoft/Multilingual-MiniLM-L12-H384 (FALLBACK after MuRIL gate FAIL), FULL-FT (small-base fallback after MuRIL gate FAIL + gated indic-bert), train=9999, val=2950, max_len=96, epochs=3
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5980 | 0.6603 | 0.6839 | 0.6719 |

## Run 2026-09-24 15:46:50 — base=microsoft/Multilingual-MiniLM-L12-H384 (FALLBACK after MuRIL gate FAIL), FULL-FT (small-base fallback after MuRIL gate FAIL + gated indic-bert), train=9999, val=2950, max_len=96, epochs=3
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 2.0 | 0.5589 | 0.7328 | 0.5985 | 0.6589 |
| 3.0 | 0.5565 | 0.7063 | 0.6460 | 0.6748 |

Training wall time: 26.6 min; best checkpoint = ml\model-minilm\checkpoint-939
| 3.0 | 0.5565 | 0.7063 | 0.6460 | 0.6748 |

BEST checkpoint val metrics: {
 "eval_loss": 0.556484580039978,
 "eval_precision": 0.7063048683160414,
 "eval_recall": 0.6459854014598541,
 "eval_f1": 0.6747998475028594,
 "eval_runtime": 37.8882,
 "eval_samples_per_second": 77.861,
 "eval_steps_per_second": 2.455,
 "epoch": 3.0
}

## Run 2026-09-24 20:11:41 — base=microsoft/Multilingual-MiniLM-L12-H384 (FALLBACK after MuRIL gate FAIL), FULL-FT on superset+PRISM-Hinglish v2 merge, train=14000, val=1886, max_len=96, epochs=2, train subsampled 14k
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.4244 | 0.6331 | 0.2869 | 0.3948 |
| 2.0 | 0.4091 | 0.5109 | 0.4397 | 0.4726 |

Training wall time: 61.8 min; best checkpoint = ml\model-v2\checkpoint-1750
| 2.0 | 0.4091 | 0.5109 | 0.4397 | 0.4726 |

BEST checkpoint val metrics: {
 "eval_loss": 0.40910103917121887,
 "eval_precision": 0.5109034267912772,
 "eval_recall": 0.43967828418230565,
 "eval_f1": 0.47262247838616717,
 "eval_runtime": 44.5995,
 "eval_samples_per_second": 42.287,
 "eval_steps_per_second": 1.323,
 "epoch": 2.0
}

## Run 2026-09-24 21:36:06 — base=microsoft/Multilingual-MiniLM-L12-H384 (FALLBACK after MuRIL gate FAIL), FULL-FT on AUDITED v3: hasoc-only + PRISM-Hinglish, contradiction filter, train=13268, val=947, max_len=96, epochs=2, train subsampled 14k
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5079 | 0.6208 | 0.5731 | 0.5960 |
| 2.0 | 0.4746 | 0.6449 | 0.5308 | 0.5823 |

Training wall time: 56.0 min; best checkpoint = ml\model-v3\checkpoint-830
| 2.0 | 0.5079 | 0.6208 | 0.5731 | 0.5960 |

BEST checkpoint val metrics: {
 "eval_loss": 0.5079424381256104,
 "eval_precision": 0.6208333333333333,
 "eval_recall": 0.573076923076923,
 "eval_f1": 0.596,
 "eval_runtime": 22.3793,
 "eval_samples_per_second": 42.316,
 "eval_steps_per_second": 1.341,
 "epoch": 2.0
}

## Run 2026-09-25 16:00:53 â€” base=microsoft/Multilingual-MiniLM-L12-H384 (FALLBACK after MuRIL gate FAIL), FULL-FT on v4: thread-corpus (real Latin Hinglish) + translit-augmented + audited v3, train=15000, val=1606, max_len=96, epochs=2, train subsampled 14k
| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5208 | 0.5174 | 0.6067 | 0.5585 |
| 2.0 | 0.4863 | 0.5435 | 0.6139 | 0.5766 |

Training wall time: 58.8 min; best checkpoint = ml\model-v4\checkpoint-1876
| 2.0 | 0.4863 | 0.5435 | 0.6139 | 0.5766 |

BEST checkpoint val metrics: {
 "eval_loss": 0.48625561594963074,
 "eval_precision": 0.5435244161358811,
 "eval_recall": 0.6139088729016786,
 "eval_f1": 0.5765765765765766,
 "eval_runtime": 34.4193,
 "eval_samples_per_second": 46.66,
 "eval_steps_per_second": 1.482,
 "epoch": 2.0
}
