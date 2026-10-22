// Verifies the OCR tier end-to-end against a REAL rendered image with REAL text
// — the case that was failing. Uses the media pass (which now runs off the
// critical path) and asserts that Tesseract actually reads the caption and that
// the caption's toxicity reaches the verdict.
//
//   node scripts/cdp-ocr-test.mjs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXT_ID = 'codfiojndhkoggdjbcjhdapgfcgieemp';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(EXT_ID));
if (!sw) {
  console.error('SafeScroll service worker not found.');
  list.forEach(t => console.log('  ', t.type, t.url));
  process.exit(1);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r?.result?.value;
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('\n=== 0. OCR tier enabled? ===');
const cfg = JSON.parse(await evaluate(`new Promise(res => {
  chrome.storage.sync.get({ ocrEnabled: null, imageEnabled: null }).then(v =>
    chrome.runtime.sendMessage({type:'status'}).then(s => res(JSON.stringify({...v, stages:s?.stageState}))));
})`));
check('ocr enabled in settings', cfg.ocrEnabled === true, `ocrEnabled=${cfg.ocrEnabled} imageEnabled=${cfg.imageEnabled}`);
check('text model ready', cfg.stages?.text === 'ready', JSON.stringify(cfg.stages));

// Render a meme-like image: white caption on black, the hardest common case.
const MEME = 'YOU ARE VERMIN AND EVERYONE WOULD BE BETTER OFF WITHOUT YOU';
async function runMeme(label, { w, h, font, white }) {
  const expr = `new Promise(res => {
    const c = document.createElement('canvas');
    c.width = ${w}; c.height = ${h};
    const x = c.getContext('2d');
    x.fillStyle = ${JSON.stringify(white ? '#000' : '#fff')}; x.fillRect(0,0,c.width,c.height);
    x.fillStyle = ${JSON.stringify(white ? '#fff' : '#000')};
    x.font = ${JSON.stringify(font)};
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const words = ${JSON.stringify(MEME)}.split(' ');
    const lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (x.measureText(test).width > c.width * 0.86 && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    const lh = c.height * 0.82 / lines.length;
    lines.forEach((l, i) => x.fillText(l, c.width/2, c.height*0.09 + lh*(i+0.5)));
    const dataUrl = c.toDataURL('image/jpeg', 0.92);
    const key = 'ocr-probe-' + Math.random().toString(36).slice(2);
    const t0 = performance.now();
    chrome.runtime.sendMessage({
      type: 'classify-media', key, images: [{ url: null, dataUrl }],
      siteId: 'probe', referer: location.href, host: 'localhost'
    }).then(r => res(JSON.stringify({ms: performance.now()-t0, r, kb: Math.round(dataUrl.length/1024), lines: lines.length})))
      .catch(e => res(JSON.stringify({err:String(e)})));
  })`;
  const out = JSON.parse(await evaluate(expr));
  return { ...out, label };
}

console.log('\n=== 1. OCR reads a meme caption and the verdict reflects it ===');
// Big, high-contrast caption: the case that must work.
const big = await runMeme('large white-on-black', { w: 900, h: 600, font: 'bold 54px sans-serif', white: true });
check('media pass completed', !big.err && big.r, big.err || `skipped=${big.r?.skipped} upgraded=${big.r?.upgraded} action=${big.r?.action}`);
check('caption toxicity detected via OCR', big.r?.action === 'block' || big.r?.upgraded,
  `action=${big.r?.action} in ${Math.round(big.ms)}ms, image ${big.kb}KB`);

console.log('\n=== 2. small/low-contrast captions (the regression case) ===');
// Deliberately small text: this is what the old 448px capture destroyed.
const small = await runMeme('small text', { w: 900, h: 500, font: '30px sans-serif', white: true });
console.log(`  small: action=${small.r?.action} upgraded=${small.r?.upgraded} skipped=${small.r?.skipped} in ${Math.round(small.ms)}ms`);
check('small caption still produces a verdict path', !!small.r, small.err || '');

console.log('\n=== 3. text tier unaffected by OCR changes ===');
const txt = JSON.parse(await evaluate(`new Promise(res => {
  const t = performance.now();
  chrome.runtime.sendMessage({type:'test-text', text:'You are a worthless piece of garbage, nobody would even miss you'}).then(r =>
    res(JSON.stringify({ms: performance.now()-t, action: r?.verdict?.action, score: r?.verdict?.detail?.score, windows: r?.verdict?.detail?.windows})));
})`));
check('toxic text still blocks', txt.action === 'block', `score=${txt.score?.toFixed(3)} in ${Math.round(txt.ms)}ms`);

const clean = JSON.parse(await evaluate(`new Promise(res => {
  const t = performance.now();
  chrome.runtime.sendMessage({type:'test-text', text:'The weather is lovely today, perfect for a walk in the park with friends.'}).then(r =>
    res(JSON.stringify({ms: performance.now()-t, action: r?.verdict?.action, score: r?.verdict?.detail?.score})));
})`));
check('clean text stays clean', clean.action === 'clean', `score=${clean.score?.toFixed(3)} in ${Math.round(clean.ms)}ms`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OCR CHECKS PASSED');
process.exit(failures ? 1 : 0);
