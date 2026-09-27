// Verify the bundled toxic-xlmr ONNX via transformers.js (same runtime as the
// extension): AutoModel + manual sigmoid (num_labels=1 BCE head — the standard
// text-classification pipeline's softmax would always return 1.0).
// Run: node eval/verify-toxic-xlmr.mjs
import { AutoModel, AutoTokenizer, env } from '@xenova/transformers';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models') + '/';

const tok = await AutoTokenizer.from_pretrained('toxic-xlmr');
const model = await AutoModel.from_pretrained('toxic-xlmr', { quantized: true });

const sigmoid = x => 1 / (1 + Math.exp(-x));

async function score(text) {
  const inputs = tok(text, { truncation: true, max_length: 128, return_tensors: 'pt' });
  const out = await model(inputs);
  const logit = out.logits.data[0];
  return sigmoid(logit);
}

const PROBE = [
  ['Muslims are vermin and should be exterminated', 'toxic'],
  ['Jews control the media and are ruining this country', 'toxic'],
  ['Black people are criminals and dont belong in our neighborhoods', 'toxic'],
  ['Immigrants are cockroaches infesting our cities', 'toxic'],
  ['Trans people are mentally ill freaks', 'toxic'],
  ['Go back to your own country, you filthy animal', 'toxic'],
  ['Women belong in the kitchen and should not be allowed to vote', 'toxic'],
  ['You are a worthless piece of garbage, nobody would even miss you', 'toxic'],
  ['I will find you and hurt you, watch your back', 'toxic'],
  ['This movie is stupid but the songs were okay', 'mild-FP-risk'],
  ['I hate it when the metro is late, so annoying', 'clean'],
  ['The service was terrible, would not recommend this restaurant', 'clean'],
  ['The weather is lovely today, perfect for a walk', 'clean'],
];

console.log('=== transformers.js verification: toxic-xlmr (local INT8 bundle) ===');
let ok = 0;
for (const [text, expect] of PROBE) {
  const s = await score(text);
  const v = s >= 0.9 ? 'BLOCK' : s >= 0.5 ? 'FLAG' : 'clean';
  const matches = (expect === 'toxic' && v !== 'clean') || (expect === 'clean' && v === 'clean') || (expect === 'mild-FP-risk' && v !== 'BLOCK');
  if (matches) ok++;
  console.log(v.padEnd(6), 'score=' + s.toFixed(3), '| expect=' + expect.padEnd(12), matches ? 'OK' : '<< MISMATCH', '|', text.slice(0, 48));
}
console.log(`\n${ok}/${PROBE.length} expectations met (block=0.9 flag=0.5)`);

// Hinglish spot-check (informational; lexicon tier owns Hinglish blocking)
const HING = [
  'Randi kahin ke, baat karne layak nahi tu',
  'Saala chor hai, sale karke bhaag gaya',
  'Teri community ke log to harami hote hain',
  'This movie is stupid but the songs were okay'
];
for (const t of HING) {
  console.log('hinglish score=' + (await score(t)).toFixed(3), '::', t.slice(0, 50));
}
