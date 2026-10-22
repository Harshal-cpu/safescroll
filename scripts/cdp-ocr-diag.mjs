// Prints EVERY intermediate value in the image path, so a failure is located
// rather than guessed at. Renders a sign-like meme (white glyphs on black, in a
// busy background) to match the reported case, then reports for each tier:
//   - was the image reachable (dataUrl or fetch)?
//   - what did nsfwjs say?
//   - what text did OCR produce, and did it survive the plausibility gate?
//   - what score did the toxicity model give it, and which tier is that?
//
//   node scripts/cdp-ocr-diag.mjs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXT_ID = 'codfiojndhkoggdjbcjhdapgfcgieemp';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(EXT_ID));
if (!sw) { console.error('SafeScroll service worker not found:'); list.forEach(t => console.log('  ', t.type, t.url)); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r?.result?.value;
};

console.log('\n=== settings / stage state ===');
const cfg = JSON.parse(await ev(`new Promise(res => {
  chrome.storage.sync.get({ ocrEnabled: null, imageEnabled: null }).then(v =>
    chrome.runtime.sendMessage({type:'status'}).then(s => res(JSON.stringify({...v, stages:s?.stageState, ready:s?.modelsReady}))))
})`));
console.log('  storage:', JSON.stringify(cfg));
console.log('  >>> OCR ENABLED?', cfg.ocrEnabled === true ? 'yes' : 'NO  <-- meme text cannot be detected at all');

console.log('\n=== what does the text model score the caption on its own? ===');
for (const text of ['GO FUCK YOURSELF', 'go fuck yourself', 'YOU ARE VERMIN AND EVERYONE WOULD BE BETTER OFF WITHOUT YOU']) {
  const r = JSON.parse(await ev(`new Promise(res => {
    const t = performance.now();
    chrome.runtime.sendMessage({type:'test-text', text: ${JSON.stringify(text)}}).then(x =>
      res(JSON.stringify({ms:performance.now()-t, action:x?.verdict?.action, score:x?.verdict?.detail?.score, tier:x?.verdict?.detail?.tier})))
  })`));
  console.log(`  ${JSON.stringify(text).padEnd(56)} score=${r.score?.toFixed(3)} tier=${r.tier} action=${r.action} (${Math.round(r.ms)}ms)`);
}
console.log('  thresholds: block >= 0.90, flag >= 0.50');

console.log('\n=== full media pass on a rendered sign (white on black, busy bg) ===');
const diag = JSON.parse(await ev(`new Promise(res => {
  const c = document.createElement('canvas'); c.width = 960; c.height = 1280;
  const x = c.getContext('2d');
  // busy photographic-ish background
  for (let i=0;i<40000;i++){ x.fillStyle='hsl('+((i*13)%360)+',45%,'+(25+((i*7)%45))+'%)'; x.fillRect((i*97)%960,(i*53)%1280,6,6); }
  // the sign
  x.fillStyle='#0b0b0b'; x.fillRect(100,380,760,520);
  x.strokeStyle='#ddd'; x.lineWidth=14; x.strokeRect(100,380,760,520);
  x.fillStyle='#f2f2f2'; x.textAlign='center'; x.textBaseline='middle';
  x.font='bold 130px Arial, sans-serif';
  x.fillText('GO FUCK', 480, 545);
  x.fillText('YOURSELF', 480, 700);
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  const key = 'diag-' + Math.random().toString(36).slice(2);
  const t0 = performance.now();
  // First: text-only classify, exactly as the content script does.
  chrome.runtime.sendMessage({ type:'classify', key, text:'', siteId:'probe', referer:location.href, host:'localhost' })
    .then(txt => chrome.runtime.sendMessage({ type:'classify-media', key, images:[{url:null,dataUrl}], siteId:'probe', referer:location.href, host:'localhost' }))
    .then(m => res(JSON.stringify({ms: performance.now()-t0, txt, m, kb: Math.round(dataUrl.length/1024)})))
    .catch(e => res(JSON.stringify({err:String(e)})));
})`));
if (diag.err) { console.log('  ERROR:', diag.err); }
else {
  console.log(`  image: ${diag.kb}KB (rendered 960x1280, white-on-black on busy background)`);
  console.log(`  text pass  : ${JSON.stringify(diag.txt)}`);
  console.log(`  media pass : ${JSON.stringify(diag.m)}`);
  console.log(`  total      : ${Math.round(diag.ms)}ms`);
  if (diag.m?.skipped) console.log(`  >>> SKIPPED: ${diag.m.skipped}  <-- this is why nothing blurred`);
}

console.log('\n=== OCR budget state after that run ===');
const budget = JSON.parse(await ev(`new Promise(res => {
  chrome.runtime.sendMessage({type:'get-session-stats'}).then(s => res(JSON.stringify({total:s?.total, bySource:s?.bySource})))
})`));
console.log(' ', JSON.stringify(budget));

console.log(failures => process.exit(0));
