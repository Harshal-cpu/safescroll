// Reload the options TAB (fresh JS context against the live extension), then verify.
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
await sleep(6000); // fresh module + data fetches with retries
const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });
const ctx = await ev(`typeof chrome.runtime?.id === 'string' ? 'ALIVE' : 'DEAD'`);
const total = await ev(`document.getElementById('statTotal')?.textContent`);
const blocked = await ev(`document.getElementById('statBlocked')?.textContent`);
const flagged = await ev(`document.getElementById('statFlagged')?.textContent`);
const modelRows = await ev(`document.querySelectorAll('#modelInfo tbody tr').length + ' | ' + document.querySelector('#modelInfo tbody tr td:nth-child(2)')?.textContent?.slice(0, 45)`);
const recent = await ev(`document.querySelectorAll('#recentVerdicts tbody tr').length + ' | ' + document.querySelector('#recentVerdicts tbody tr')?.innerText?.slice(0, 70)`);
const child = await ev(`document.getElementById('childState')?.innerText?.slice(0, 60)`);
console.log('context:', ctx?.result?.value, '| stats: total =', total?.result?.value, 'blocked =', blocked?.result?.value, 'flagged =', flagged?.result?.value);
console.log('model info:', modelRows?.result?.value);
console.log('recent:', recent?.result?.value);
console.log('child lock:', child?.result?.value);
process.exit(0);
