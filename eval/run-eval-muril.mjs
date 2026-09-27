// EVAL GATE for the fine-tuned + quantized MuRIL model, run through the SAME
// runtime the extension uses (@xenova/transformers) against the SAME
// hand-picked 20-sentence Hinglish eval set that toxic-bert failed on.
// Appends results to eval/RESULTS.md (history preserved) and exits nonzero
// unless precision >= 0.7 AND recall >= 0.7.
//
// Usage: node eval/run-eval-muril.mjs [--model public/models/muril-toxic]
import { pipeline, env } from '@xenova/transformers';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

env.allowLocalModels = true;
env.allowRemoteModels = false; // eval the LOCAL bundled artifact only â€” no hub fallback
// Node v2 resolves local models under env.localModelPath + <model_id>/

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : join(here, '..', 'public', 'models', 'muril-toxic');
env.localModelPath = dirname(modelPath) + '/';

const thIdx = process.argv.indexOf('--thresholds');
const thresholdsPath = thIdx > -1 ? process.argv[thIdx + 1] : join(here, '..', 'ml', 'prepared', 'thresholds.json');
const cal = existsSync(thresholdsPath) ? JSON.parse(readFileSync(thresholdsPath, 'utf8')) : null;
// Gate operating point: "flagged toxic" = score >= flagThreshold (mild tier),
// mirroring how the extension treats flag+block as detected toxicity.
const FLAG_T = cal?.flagThreshold ?? 0.5;
const BLOCK_T = cal?.blockThreshold ?? 0.8;

const set = JSON.parse(readFileSync(join(here, 'hinglish-test-set.json'), 'utf8'));
const clf = await pipeline('text-classification', basename(modelPath), { quantized: true });

let tp = 0, fp = 0, tn = 0, fn = 0;
const rows = [];
let blockTp = 0, blockFn = 0;
for (const { text, label } of set.sentences) {
  const out = await clf(text, { topk: null });
  const scores = Object.fromEntries(out.map(r => [r.label, r.score]));
  const toxic = scores['toxic'] ?? 0;
  const predicted = toxic >= FLAG_T ? 1 : 0;
  const blocked = toxic >= BLOCK_T ? 1 : 0;
  if (label === 1 && predicted === 1) tp++;
  else if (label === 0 && predicted === 1) fp++;
  else if (label === 0 && predicted === 0) tn++;
  else fn++;
  if (label === 1 && blocked) blockTp++;
  if (label === 1 && !blocked) blockFn++;
  rows.push({ text, label, predicted, toxic: toxic.toFixed(3), blocked });
}

const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = 2 * precision * recall / (precision + recall) || 0;
const blockRecall = blockTp / (blockTp + blockFn) || 0;
const GATE_PASS = precision >= 0.7 && recall >= 0.7;

const report = `
=== SafeScroll Hinglish eval: fine-tuned MuRIL (quantized ONNX, local bundle) ===
Model: ${modelPath} | flag_thr=${FLAG_T} block_thr=${BLOCK_T} (calibrated on val, not on this set)
Set size: ${set.sentences.length} (toxic=${tp + fn}, clean=${fp + tn})
Operating point: score >= ${FLAG_T} => flagged toxic

Precision: ${precision.toFixed(3)}
Recall:    ${recall.toFixed(3)}
F1:        ${f1.toFixed(3)}
Block-tier recall (score >= ${BLOCK_T} on toxic sentences): ${blockRecall.toFixed(3)}

Per-sentence:
${rows.map(r => `label=${r.label} pred=${r.predicted} toxic=${r.toxic} block=${r.blocked} :: ${r.text}`).join('\n')}

GATE (P>=0.7 AND R>=0.7): ${GATE_PASS ? 'PASS' : 'FAIL'}
`;

console.log(report);
appendFileSync(join(here, 'RESULTS.md'), report + '\n');
process.exit(GATE_PASS ? 0 : 2);

