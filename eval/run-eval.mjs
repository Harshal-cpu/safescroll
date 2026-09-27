// Evaluate the candidate checkpoint (Xenova/toxic-bert) against the hand-picked
// Hinglish test set. Reports precision/recall explicitly.
// Run: npm run eval:toxicity  (downloads model weights = data, on first run)
import { pipeline, env } from '@xenova/transformers';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

env.allowLocalModels = false;

const here = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(readFileSync(join(here, 'hinglish-test-set.json'), 'utf8'));
const HATE_LABELS = new Set(['identity_attack', 'severe_toxicity', 'threat']);
const MILD_LABELS = new Set(['insult', 'obscene', 'sexual_explicit']);
const HATE_BLOCK = 0.70;
const MILD_FLAG = 0.55;

const clf = await pipeline('text-classification', 'Xenova/toxic-bert', { quantized: true });

let tp = 0, fp = 0, tn = 0, fn = 0;
const rows = [];
for (const { text, label } of set.sentences) {
  const out = await clf(text, { topk: null });
  const scores = Object.fromEntries(out.map(r => [r.label, r.score]));
  const hate = Math.max(0, ...[...HATE_LABELS].map(l => scores[l] ?? 0));
  const mild = Math.max(0, ...[...MILD_LABELS].map(l => scores[l] ?? 0));
  const predicted = hate >= HATE_BLOCK ? 1 : mild >= MILD_FLAG ? 1 : 0; // block or flag => "flagged toxic"
  if (label === 1 && predicted === 1) tp++;
  else if (label === 0 && predicted === 1) fp++;
  else if (label === 0 && predicted === 0) tn++;
  else fn++;
  rows.push({ text, label, predicted, hate: hate.toFixed(3), mild: mild.toFixed(3) });
}

const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = 2 * precision * recall / (precision + recall) || 0;

const report = `
=== SafeScroll Hinglish eval: ${clf.model?.name ?? 'Xenova/toxic-bert'} ===
Set size: ${set.sentences.length} (hate=${tp + fn}, clean=${fp + tn})
Precision: ${precision.toFixed(3)}
Recall:    ${recall.toFixed(3)}
F1:        ${f1.toFixed(3)}

Per-sentence:
${rows.map(r => `label=${r.label} pred=${r.predicted} hate=${r.hate} mild=${r.mild} :: ${r.text}`).join('\n')}
`;
console.log(report);
writeFileSync(join(here, 'RESULTS.md'), `# Hinglish eval results (auto-generated)\n\n\`\`\`\n${report}\`\`\`\n`);
