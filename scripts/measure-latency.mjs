// Latency probe. Measures the real cost of each stage in the LIVE extension
// (real Chrome, real account profile, real models) so optimisation decisions
// are based on numbers rather than intuition.
//
//   node scripts/measure-latency.mjs
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const sw = list.find(t => t.type === 'service_worker' && t.url.includes('codfiojndhkoggdjbcjhdapgfcgieemp'));
  if (!sw) { console.error('SafeScroll service worker target not found. Is the extension loaded?'); process.exit(1); }
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send };
}

const sw = await cdp();
const evalSw = async (expression) => {
  const r = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r?.result?.value;
};

const row = (name, ms, extra = '') =>
  console.log(`  ${name.padEnd(42)} ${ms == null ? 'n/a' : (ms.toFixed(0) + ' ms').padStart(9)}  ${extra}`);

console.log('\n=== 1. model load state ===');
const st = await evalSw(`new Promise(res => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    chrome.runtime.sendMessage({type:'status'}).then(r => {
      if (r?.modelsReady || r?.modelsError) { clearInterval(iv); res(JSON.stringify({...r, waitedMs: Date.now()-t0})); }
    }, () => {});
  }, 250);
  setTimeout(() => { clearInterval(iv); res(JSON.stringify({timeout:true, waitedMs: Date.now()-t0})); }, 240000);
})`);
const status = JSON.parse(st);
console.log(`  ready: ${status.modelsReady}  error: ${status.modelsError ?? 'none'}`);
console.log(`  stages: ${JSON.stringify(status.stageState)}`);
console.log(`  (waited ${status.waitedMs} ms for ready state)`);

console.log('\n=== 2. per-stage latency (warm) ===');
// text: short vs long (windowing cost)
for (const [label, text] of [
  ['text 1 sentence (~40 chars)', 'You are a worthless piece of garbage, nobody would even miss you.'],
  ['text ~500 chars (1 window)', Array.from({length:12},(_,i)=>`Neutral sentence ${i} about the weather today.`).join(' ')],
  ['text ~3500 chars (12 windows)', Array.from({length:110},(_,i)=>`Neutral sentence ${i} about the weather and the traffic.`).join(' ') + ' Muslims are vermin and should be exterminated from this land forever.'],
  ['text ~3500 chars, all clean', Array.from({length:110},(_,i)=>`Neutral sentence ${i} about the weather and the traffic.`).join(' ')]
]) {
  const out = await evalSw(`new Promise(res => {
    const t = performance.now();
    chrome.runtime.sendMessage({type:'test-text', text: ${JSON.stringify(text)}}).then(r => {
      res(JSON.stringify({ms: performance.now()-t, action:r?.verdict?.action, score:r?.verdict?.detail?.score, windows:r?.verdict?.detail?.windows}));
    }, e => res(JSON.stringify({ms: performance.now()-t, err:String(e)})));
  })`);
  const o = JSON.parse(out);
  row(label, o.ms, `windows=${o.windows ?? '-'} action=${o.action ?? o.err ?? '?'} score=${o.score != null ? o.score.toFixed(3) : '?'}`);
}

console.log('\n=== 3. end-to-end message overhead ===');
// A classify round trip with no content: isolates relay + handshake cost.
const e2e = await evalSw(`new Promise(res => {
  const t = performance.now();
  chrome.runtime.sendMessage({type:'classify', key:'probe-empty', text:'', images:[], siteId:'probe'}).then(r => {
    res(JSON.stringify({ms: performance.now()-t, action:r?.verdict?.action}));
  }, e => res(JSON.stringify({ms: performance.now()-t, err:String(e)})));
})`);
const e = JSON.parse(e2e);
row('classify round trip (empty payload)', e.ms, `action=${e.action ?? e.err}`);

console.log('\n=== 4. end-to-end on a live page ===');
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000'));
if (!page) { console.log('  no fixture page open — skipping'); process.exit(0); }
const pw = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { pw.onopen = res; pw.onerror = rej; });
let pid = 0; const ppend = new Map();
pw.onmessage = e => { const m = JSON.parse(e.data); if (m.id && ppend.has(m.id)) { const p = ppend.get(m.id); ppend.delete(m.id); p(m.result); } };
const sendP = (method, params = {}) => new Promise(res => { const i = ++pid; ppend.set(i, res); pw.send(JSON.stringify({ id: i, method, params })); });
await sendP('Page.enable');
await sendP('Page.navigate', { url: 'http://localhost:5000/test/fixture-forum.html' });
await sleep(500);
const t0 = Date.now();
await sendP('Page.navigate', { url: 'http://localhost:5000/test/fixture-forum.html' });
// poll the DOM from the MAIN world: data-safescroll-key and shields are visible there
let firstKey = null, firstBlock = null, lastDone = null;
for (let i = 0; i < 120; i++) {
  const r = await sendP('Runtime.evaluate', {
    expression: `JSON.stringify({
      keys: document.querySelectorAll('[data-safescroll-key]').length,
      blocked: document.querySelectorAll('.safescroll-shield[data-verdict-action="block"]').length,
      anyVerdict: document.querySelectorAll('.safescroll-shield[data-verdict-action]').length
    })`, returnByValue: true
  });
  const s = JSON.parse(r?.result?.value || '{}');
  if (firstKey == null && s.keys > 0) firstKey = Date.now() - t0;
  if (firstBlock == null && s.blocked > 0) firstBlock = Date.now() - t0;
  if (firstBlock != null && s.keys > 0 && Date.now() - t0 > 6000) { lastDone = Date.now() - t0; break; }
  await sleep(250);
}
row('page load -> first unit detected', firstKey);
row('page load -> first BLOCK applied', firstBlock);
row('page load -> settled', lastDone);
console.log('\n(note: the block threshold is ~1.0 for hate speech, so a block appearing')
console.log(' at all is the worst case; ordinary text settles at the flag tier.)');
process.exit(0);
