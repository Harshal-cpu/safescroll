// YouTube verification after adapter fix: reload extension + page, check units/shields.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
const ws0 = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
const p0 = new Map();
ws0.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && p0.get(m.id); if (h) { p0.delete(m.id); h(m.result); } };
const ev0 = expr => new Promise(res => { p0.set(1, res); ws0.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
await ev0(`chrome.runtime.reload(); 'r'`);
await sleep(5000);

list = await (await fetch('http://localhost:9222/json/list')).json();
let yt = list.find(t => t.type === 'page' && t.url.includes('youtube.com'));
const ws1 = new WebSocket(yt.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws1.onopen = res; ws1.onerror = rej; });
const p1 = new Map();
const logs = [];
ws1.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p1.get(m.id);
  if (h) { p1.delete(m.id); h(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map(a => a.value ?? '').join(' ');
    if (t.includes('SafeScroll')) logs.push(t.slice(0, 140));
  }
};
ws1.send(JSON.stringify({ id: 5, method: 'Runtime.enable' }));
ws1.send(JSON.stringify({ id: 6, method: 'Page.reload', params: { ignoreCache: true } }));
await sleep(14000);

const send1 = (method, params = {}) => new Promise(resolve => { p1.set(98, resolve); ws1.send(JSON.stringify({ id: 98, method, params })); });
const r = await send1('Runtime.evaluate', {
  expression: `JSON.stringify({
    comments: document.querySelectorAll('ytd-comment-thread-renderer').length,
    watchMeta: document.querySelectorAll('ytd-watch-metadata').length,
    shields: [...document.querySelectorAll('.safescroll-shield')].map(s => s.dataset.safescrollTarget + ':' + s.dataset.verdictAction + ':' + s.style.display)
  })`,
  returnByValue: true
});
console.log('YT AFTER FIX:', r?.result?.value);
console.log('logs:', logs.slice(0, 8));
process.exit(0);
