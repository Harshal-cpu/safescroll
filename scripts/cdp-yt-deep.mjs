// YouTube deep check: what page is actually rendered? consent wall?
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const yt = list.find(t => t.type === 'page' && t.url.includes('youtube.com'));
if (!yt) { console.log('no yt tab'); process.exit(1); }
const ws = new WebSocket(yt.webSocketDebuggerUrl);
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
    if (text.includes('SafeScroll')) logs.push(text.slice(0, 130));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href.slice(0, 80),
    title: document.title.slice(0, 60),
    ytdRich: document.querySelectorAll('ytd-rich-item-renderer').length,
    ytdAny: document.querySelectorAll('ytd-*').length,
    articles: document.querySelectorAll('article').length,
    shields: document.querySelectorAll('.safescroll-shield').length,
    banner: !!document.getElementById('safescroll-loading-banner'),
    hasPlayer: !!document.querySelector('ytd-app')
  })`,
  returnByValue: true
});
console.log('YT DOM:', r?.result?.value);
console.log('logs:', logs.slice(0, 6));
process.exit(0);
