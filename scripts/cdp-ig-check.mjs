// Instagram check: open tab, verify content script + classification state.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
const ws0 = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
const p0 = new Map();
ws0.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && p0.get(m.id); if (h) { p0.delete(m.id); h(m.result); } };
await new Promise(res => { p0.set(1, res); ws0.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://www.instagram.com/' } })); });
await sleep(15000);
list = await (await fetch('http://localhost:9222/json/list')).json();
const ig = list.find(t => t.type === 'page' && t.url.includes('instagram.com'));
if (!ig) { console.log('no ig tab'); process.exit(1); }
const ws = new WebSocket(ig.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p.get(m.id);
  if (h) { p.delete(m.id); h(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map(a => a.value ?? '').join(' ');
    if (t.includes('SafeScroll')) logs.push(t.slice(0, 140));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
await sleep(4000);
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href.slice(0, 60),
    loggedIn: !document.querySelector('form#login-form, input[name="username"]'),
    articles: document.querySelectorAll('article').length,
    shields: [...document.querySelectorAll('.safescroll-shield')].map(s => s.dataset.safescrollTarget + ':' + s.dataset.verdictAction + ':' + s.style.display)
  })`,
  returnByValue: true
});
console.log('IG:', r?.result?.value);
console.log('logs:', logs.slice(0, 6));
process.exit(0);
