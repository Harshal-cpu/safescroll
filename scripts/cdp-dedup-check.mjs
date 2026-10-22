// Duplicate-processing proof harness.
//
// chrome.runtime.sendMessage() broadcasts to every extension context except the
// sender, so a single content-script `classify` used to be handled TWICE (once
// direct, once via the background relay). This script drives the exact same
// path from a NON-background context (the options page) and proves the count.
//
//   node scripts/cdp-dedup-check.mjs
//
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP = 'http://127.0.0.1:9222';

const listTargets = async () => (await (await fetch(`${CDP}/json/list`)).json());
const openTarget = async url => {
  try {
    const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (r.ok) return await r.json();
  } catch { /* fall through */ }
  return null;
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const p = new Map();
  const listeners = [];
  let id = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) {
      const { res, rej } = p.get(m.id); p.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws ' + wsUrl)); });
  const send = async (method, params = {}) => {
    await opened;
    const i = ++id;
    return new Promise((res, rej) => { p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  };
  return {
    send, on: fn => listeners.push(fn),
    close: () => { try { ws.close(); } catch { /* already closed */ } }
  };
}

const fmtArg = a => {
  if (a?.type === 'string') return a.value;
  if (a?.type === 'undefined') return 'undefined';
  if (a?.type === 'object') return a.description ?? JSON.stringify(a.value ?? null);
  if ('value' in (a ?? {})) return String(a.value);
  return a?.description ?? JSON.stringify(a);
};

let targets = await listTargets();
if (!targets.length) { console.error('CDP NOT REACHABLE'); process.exit(2); }

// 1. extension id (from any live extension target), then a non-background
//    extension context to send from â€” the sender must NOT be the service
//    worker, otherwise the broadcast never has a second recipient.
let EXT_ID = (targets
  .map(t => (t.url || '').match(/^chrome-extension:\/\/([^/]+)/)?.[1])
  .find(Boolean)) || null;
if (!EXT_ID) {
  const sw = targets.find(t => t.type === 'service_worker');
  if (sw) EXT_ID = (sw.url.match(/^chrome-extension:\/\/([^/]+)/) ?? [])[1];
}
if (!EXT_ID) { console.error('SafeScroll extension target not found'); process.exit(2); }

let options = targets.find(t => t.type === 'page' && t.url.includes('/src/options/options.html'));
if (!options) options = await openTarget(`chrome-extension://${EXT_ID}/src/options/options.html`);
if (!options) { console.error('could not open options page'); process.exit(2); }
console.log('extension :', EXT_ID);

const optsConn = connect(options.webSocketDebuggerUrl);
await optsConn.send('Runtime.enable');
const optsErrors = [];
optsConn.on(m => {
  if (m.method === 'Runtime.exceptionThrown') optsErrors.push(m.params.exceptionDetails);
});
const ev = async expression => {
  const r = await optsConn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r?.result?.value;
};

// 2. wake the service worker + create the offscreen document
console.log('warming up extension contexts...');
const st = JSON.parse(await ev(`chrome.runtime.sendMessage({type:'status'}).then(r => JSON.stringify(r), e => 'ERR ' + String(e))`));
console.log('  status:', typeof st === 'string' ? st : `modelsReady=${st.modelsReady}`);
await sleep(1500);

// 3. locate the offscreen document
targets = await listTargets();
let offscreen = targets.find(t => (t.url || '').includes('/src/offscreen/offscreen.html'));
if (!offscreen) {
  // force creation through the background relay
  await ev(`chrome.runtime.sendMessage({type:'status'}).catch(() => {})`);
  for (let i = 0; i < 20 && !offscreen; i++) {
    await sleep(500);
    offscreen = (await listTargets()).find(t => (t.url || '').includes('/src/offscreen/offscreen.html'));
  }
}
if (!offscreen) { console.error('offscreen document not found'); process.exit(2); }
console.log('offscreen :', offscreen.url);

// 4. capture EVERY offscreen console line
const osConn = connect(offscreen.webSocketDebuggerUrl);
await osConn.send('Runtime.enable');
const lines = [];
const exceptions = [];
osConn.on(m => {
  if (m.method === 'Runtime.consoleAPICalled') {
    lines.push({ ts: Date.now(), level: m.params.type, text: m.params.args.map(fmtArg).join(' ') });
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails);
  }
});

// 5. wait for models so the first classify is representative
console.log('waiting for models...');
for (let i = 0; i < 90; i++) {
  const s = JSON.parse(await ev(`chrome.runtime.sendMessage({type:'status'}).then(r => JSON.stringify(r), e => 'ERR')`));
  if (s?.modelsReady) { console.log('  models ready'); break; }
  await sleep(2000);
}

const clear = () => { lines.length = 0; exceptions.length = 0; };

// ---------------------------------------------------------------- text probe
console.log('\n=== PROBE 1: ONE classify -> how many executions? ===');
clear();
const KEY = 'DEDUPPROBE' + Math.random().toString(36).slice(2, 8).toUpperCase();
const t0 = Date.now();
const resp = JSON.parse(await ev(`chrome.runtime.sendMessage({
  type: 'classify', key: ${JSON.stringify(KEY)}, text: 'dedup probe post â€” the quick brown fox jumps over the lazy dog',
  siteId: 'probe', referer: 'https://x.com/', host: 'x.com'
}).then(r => JSON.stringify(r), e => JSON.stringify({err:String(e)}))`));
console.log('  response   :', JSON.stringify(resp).slice(0, 200));
await sleep(8000);
const verdictText = lines.filter(l => l.text.startsWith('[SS][VERDICT] text'));
console.log(`  elapsed    : ${Date.now() - t0}ms`);
console.log(`  [SS][VERDICT] text lines : ${verdictText.length}  ${verdictText.length === 1 ? 'OK (exactly once)' : verdictText.length === 0 ? 'FAIL (never ran)' : 'FAIL (ran more than once)'}`);
verdictText.forEach(l => console.log('    ', l.text));
console.log(`  exceptions : ${exceptions.length}`);

// ---------------------------------------------------------------- media probe
console.log('\n=== PROBE 2: THREE classify-media on the same image ===');
const dataUrl = await ev(`(() => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 400;
  const x = c.getContext('2d');
  x.fillStyle = '#111'; x.fillRect(0,0,640,400);
  x.fillStyle = '#eee'; x.font = 'bold 64px Arial'; x.textAlign = 'center';
  x.fillText('DEDUP MEME', 320, 210);
  return c.toDataURL('image/jpeg', 0.9);
})()`);

clear();
const MKEY = 'DEDUPMEDIA' + Math.random().toString(36).slice(2, 8).toUpperCase();
const mediaSend = k => `chrome.runtime.sendMessage({ type: 'classify-media', key: ${JSON.stringify(k)},
  images: [{ url: null, dataUrl: ${JSON.stringify(dataUrl)} }],
  siteId: 'probe', referer: 'https://x.com/', host: 'x.com' }).then(r => JSON.stringify(r), e => JSON.stringify({err:String(e)}))`;
const [m1, m2] = await Promise.all([ev(mediaSend(MKEY)), ev(mediaSend(MKEY))]);
const m3 = await ev(mediaSend(MKEY));
console.log('  send #1    :', String(m1).slice(0, 160));
console.log('  send #2    :', String(m2).slice(0, 160));
console.log('  send #3    :', String(m3).slice(0, 160));
await sleep(12000);
const verdictMedia = lines.filter(l => l.text.startsWith('[SS][VERDICT] media'));
const dedup = lines.filter(l => l.text.includes('[SS][DEDUP]'));
console.log(`  [SS][VERDICT] media lines: ${verdictMedia.length}  ${verdictMedia.length === 1 ? 'OK (exactly once)' : 'CHECK'}`);
verdictMedia.forEach(l => console.log('    ', l.text));
console.log(`  [SS][DEDUP] lines       : ${dedup.length}`);
dedup.forEach(l => console.log('    ', l.text));

console.log('\n=== all [SS] lines captured in the last window ===');
lines.forEach(l => console.log(`  ${l.level.padEnd(7)} ${l.text}`));
if (exceptions.length) {
  console.log('\n=== exceptions ===');
  exceptions.forEach(e => console.log('  ', e.text, e.exception?.description ?? ''));
}
console.log('\n=== options-page exceptions ===');
console.log(optsErrors.length ? optsErrors.map(e => e.text).join('\n') : '  none');

process.exit(0);
