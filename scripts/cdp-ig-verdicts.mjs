// IG: wait for verdicts, verify no false blur on normal photos.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const ig = list.find(t => t.type === 'page' && t.url.includes('instagram.com'));
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
    if (t.includes('SafeScroll')) logs.push(t.slice(0, 160));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
await sleep(12000); // let image classifications finish (fetch + nsfwjs)
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    shields: [...document.querySelectorAll('.safescroll-shield')].map(s => s.dataset.safescrollTarget + ':' + s.dataset.verdictAction + ':' + s.style.display),
    visibleBlur: [...document.querySelectorAll('.safescroll-shield')].filter(s => s.style.display !== 'none').length
  })`,
  returnByValue: true
});
console.log('IG VERDICTS:', r?.result?.value);
console.log('logs:', logs.slice(-8));
process.exit(0);
