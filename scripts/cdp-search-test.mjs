// Verify all-sites moderation on a Google-style search page (localhost:5000).
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));

// reload extension to pick up the all-sites build
if (sw) {
  const w = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  const pm = new Map();
  w.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && pm.get(m.id); if (h) { pm.delete(m.id); h(m.result); } };
  await new Promise(res => { pm.set(1, res); w.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `chrome.runtime.reload(); 'r'` } })); });
  await sleep(4000);
}
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
  if (sw) break;
  await sleep(1000);
}
console.log('SW back online');

// open/reuse the search test page
let page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000/search.html'));
if (!page) {
  const wb = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wb.onopen = res; wb.onerror = rej; });
  const pb = new Map();
  wb.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && pb.get(m.id); if (h) { pb.delete(m.id); h(m.result); } };
  await new Promise(res => { pb.set(2, res); wb.send(JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'http://localhost:5000/search.html' } })); });
  page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000/search.html'));
  await sleep(3000);
  list = await (await fetch('http://localhost:9222/json/list')).json();
  page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000/search.html'));
}
console.log('test page:', page ? page.url.slice(0, 60) : 'FAILED TO OPEN');
if (!page) process.exit(1);

// RELOAD the page so the fresh content script (new build) injects
const ws0 = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
ws0.send(JSON.stringify({ id: 7, method: 'Page.reload', params: { ignoreCache: true } }));
await sleep(15000); // generic adapter scan + classify round-trips

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p.get(m.id);
  if (h) { p.delete(m.id); h(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('SafeScroll')) logs.push(text.slice(0, 150));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const out = {};
    for (const idv of ['r1', 'r2', 'r3', 'r4']) {
      const el = document.getElementById(idv);
      const shields = [...(el?.querySelectorAll('.safescroll-shield') ?? [])];
      out[idv] = shields.map(s => s.dataset.safescrollTarget + ':' + s.dataset.verdictAction + ':' + s.style.display);
    }
    return JSON.stringify(out);
  })()`,
  returnByValue: true
});
console.log('SEARCH PAGE VERDICTS:', r?.result?.value);
console.log('--- SafeScroll logs ---');
logs.slice(-10).forEach(l => console.log(' ', l));
process.exit(0);
