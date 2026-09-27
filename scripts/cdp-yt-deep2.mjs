// YouTube deep check with robust error surfacing.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
const yt = list.find(t => t.type === 'page' && t.url.includes('youtube.com'));
if (!yt) { console.log('no yt tab — creating'); process.exit(1); }
const ws = new WebSocket(yt.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error')); });
let id = 0;
const p = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p.get(m.id);
  if (h) { p.delete(m.id); h(m.result); }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({url: location.href.slice(0, 70), title: document.title.slice(0, 50), ytdRich: document.querySelectorAll('ytd-rich-item-renderer').length, shields: document.querySelectorAll('.safescroll-shield').length})`,
  returnByValue: true
});
console.log('YT:', JSON.stringify(r));
console.log('full:', JSON.stringify(r).slice(0, 400));
process.exit(0);
