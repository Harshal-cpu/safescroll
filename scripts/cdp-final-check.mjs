// Final render verification of the freshly rebuilt dashboard.
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
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(5000);
const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });
const total = await ev(`document.getElementById('statTotal')?.textContent`);
const blocked = await ev(`document.getElementById('statBlocked')?.textContent`);
const modelRows = await ev(`document.querySelectorAll('#modelInfo tbody tr').length`);
const modelFirst = await ev(`document.querySelector('#modelInfo tbody tr td:nth-child(2)')?.textContent?.slice(0, 50)`);
const thr = await ev(`document.querySelectorAll('#thresholds tbody tr').length`);
const recent = await ev(`document.querySelectorAll('#recentVerdicts tbody tr').length + ' | ' + document.querySelector('#recentVerdicts tbody tr')?.innerText?.slice(0, 70)`);
console.log('stats: total =', total?.result?.value, '| blocked =', blocked?.result?.value);
console.log('model info rows:', modelRows?.result?.value, '| first model:', modelFirst?.result?.value);
console.log('threshold rows:', thr?.result?.value);
console.log('recent verdicts:', recent?.result?.value);
process.exit(0);
