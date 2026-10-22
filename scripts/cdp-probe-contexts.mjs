// Diagnostic: enumerate execution contexts on a fixture page and report what
// the content script left in the DOM. Used to debug "content script not
// injected" / "isolated world not found".
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000'));
if (!page) { console.log('no localhost page open'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pend = new Map();
const worlds = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p(m.result); }
  else if (m.method === 'Runtime.executionContextCreated') worlds.push(m.params.context);
  else if (m.method === 'Runtime.executionContextDestroyed') {
    const i = worlds.findIndex(w => w.id === m.params.executionContextId);
    if (i >= 0) worlds.splice(i, 1);
  }
};
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5000/test/fixture-forum.html' });
await sleep(5000);

console.log('=== execution contexts ===');
for (const w of worlds) {
  console.log(JSON.stringify({ id: w.id, origin: w.origin, name: w.name, type: w.auxData?.type, frameId: w.auxData?.frameId }));
}

const ev = async (expr, ctx) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, ...(ctx ? { contextId: ctx } : {})
  });
  if (r?.exceptionDetails) return 'EXC: ' + r.exceptionDetails.text;
  return r?.result?.value;
};

console.log('\n=== main world DOM probe ===');
console.log(await ev(`JSON.stringify({
  tracked: document.querySelectorAll('[data-safescroll-key]').length,
  shields: document.querySelectorAll('.safescroll-shield').length,
  banner: !!document.getElementById('safescroll-loading-banner'),
  bodyLen: document.body.innerText.length
})`));

const extWorld = worlds.find(w => (w.origin || '').startsWith('chrome-extension://'));
if (extWorld) {
  console.log(`\n=== isolated world ${extWorld.id} probe ===`);
  console.log(await ev(`typeof window.__safescroll + ' | ' + JSON.stringify(window.__safescroll?.stats ?? null)`, extWorld.id));
} else {
  console.log('\n=== NO chrome-extension isolated world found ===');
}
process.exit(0);
