// Page-half verification: content script presence, units found, shields, verdicts.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, page;
for (let i = 0; i < 20; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000'));
  if (page) break;
  await sleep(1000);
}
if (!page) { console.log('NO test page open'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
let id = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('SafeScroll')) consoleLogs.push(`[${m.params.type}] ${text.slice(0, 160)}`);
  }
};
await ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  pending.set(i, { resolve });
  ws.send(JSON.stringify({ id: i, method, params }));
});

// reload so the content script re-runs fresh with logging captured from the start
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(15000);

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const shields = [...document.querySelectorAll('.safescroll-shield')];
    return JSON.stringify({
      articles: document.querySelectorAll('article').length,
      shields: shields.map(s => ({ display: s.style.display, verdict: s.dataset.verdictAction || 'none' }))
    });
  })()`,
  returnByValue: true
});
console.log('PAGE DOM:', r?.result?.value);
console.log('--- content script console (SafeScroll lines) ---');
consoleLogs.slice(0, 30).forEach(l => console.log(l));
process.exit(0);
