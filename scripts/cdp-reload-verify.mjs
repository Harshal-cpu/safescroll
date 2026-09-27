// Force-reload the extension via chrome.runtime.reload() from its SW,
// then re-verify the dashboard render end-to-end.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
if (!sw) { console.log('SW not alive; cannot reload'); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
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
await send('Runtime.evaluate', { expression: `chrome.runtime.reload(); 'reloading'`, returnByValue: true });

// SW dies; poll for it to come back + options tab to re-render
await sleep(4000);
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
  if (sw) break;
  await sleep(1000);
}
console.log('SW back:', sw?.url?.slice(0, 80));

// re-open the options page (reload killed it? it survives as a tab but re-runs)
const ws2 = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = () => rej(new Error('ws2')); });
let id2 = 0;
const p2 = new Map();
ws2.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p2.get(m.id);
  if (h) { p2.delete(m.id); h(m.result); }
};
const send2 = (method, params = {}) => new Promise(resolve => {
  const i = ++id2;
  p2.set(i, resolve);
  ws2.send(JSON.stringify({ id: i, method, params }));
});
await send2('Runtime.evaluate', { expression: `chrome.runtime.openOptionsPage(); 'ok'`, returnByValue: true });
await sleep(6000); // options fetches + offscreen warm-up

list = await (await fetch('http://localhost:9222/json/list')).json();
const opts = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opts) { console.log('options tab did not open'); process.exit(1); }
const ws3 = new WebSocket(opts.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws3.onopen = res; ws3.onerror = () => rej(new Error('ws3')); });
let id3 = 0;
const p3 = new Map();
ws3.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p3.get(m.id);
  if (h) { p3.delete(m.id); h(m.result); }
};
const send3 = (method, params = {}) => new Promise(resolve => {
  const i = ++id3;
  p3.set(i, resolve);
  ws3.send(JSON.stringify({ id: i, method, params }));
});
await sleep(4000); // let its data fetches (with retries) settle
const ev3 = expr => send3('Runtime.evaluate', { expression: expr, returnByValue: true });
const total = await ev3(`document.getElementById('statTotal')?.textContent`);
const blocked = await ev3(`document.getElementById('statBlocked')?.textContent`);
const modelRows = await ev3(`document.querySelectorAll('#modelInfo tbody tr').length + ' | ' + document.querySelector('#modelInfo tbody tr td:nth-child(2)')?.textContent`);
const thr = await ev3(`document.querySelectorAll('#thresholds tbody tr').length`);
const recent = await ev3(`document.querySelectorAll('#recentVerdicts tbody tr').length + ' | ' + document.querySelector('#recentVerdicts tbody tr')?.innerText?.slice(0, 90)`);
console.log('STATS: total =', total?.result?.value, '| blocked =', blocked?.result?.value);
console.log('MODEL INFO rows:', modelRows?.result?.value);
console.log('THRESHOLD rows:', thr?.result?.value);
console.log('RECENT:', recent?.result?.value);
process.exit(0);
