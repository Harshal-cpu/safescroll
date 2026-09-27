// Check the x.com tab: content script running? shields? Also capture console.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const xcom = list.find(t => t.type === 'page' && t.url.includes('x.com'));
if (!xcom) { console.log('no x.com tab'); process.exit(1); }
console.log('x.com tab:', xcom.url);
const ws = new WebSocket(xcom.webSocketDebuggerUrl);
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
await send('Page.enable');
const r1 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({url: location.href, articles: document.querySelectorAll('article').length, shields: document.querySelectorAll('.safescroll-shield').length, banner: !!document.getElementById('safescroll-loading-banner')})`,
  returnByValue: true
});
console.log('x.com state:', r1?.result?.value);
// content-script world check: main world has no chrome.runtime — check via a marker the script sets on <html>
const r2 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ htmlMarker: document.documentElement.dataset.safescrollMarker || null })`,
  returnByValue: true
});
console.log('marker (set by content script if running):', r2?.result?.value);
console.log('--- console (SafeScroll) ---');
consoleLogs.slice(0, 20).forEach(l => console.log(l));
process.exit(0);
