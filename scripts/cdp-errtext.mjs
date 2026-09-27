const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const opts = list.find(t => t.type === 'page' && t.url.includes('options.html'));
const ws = new WebSocket(opts.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
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
const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });
const modelErr = await ev(`document.querySelector('#modelInfo tbody tr td')?.innerText?.slice(0, 200)`);
const recentErr = await ev(`document.querySelector('#recentVerdicts tbody tr td')?.innerText?.slice(0, 200)`);
console.log('model info row text:', modelErr?.result?.value);
console.log('recent row text:', recentErr?.result?.value);
process.exit(0);
