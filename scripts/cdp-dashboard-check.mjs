// Open the options dashboard in the live Chrome (via runtime.openOptionsPage
// from the SW) and verify it renders + gets data from offscreen.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, sw;
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
  if (sw) break;
  await sleep(1000);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
let id = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  pending.set(i, { resolve });
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.evaluate', { expression: `chrome.runtime.openOptionsPage(); 'opened'`, returnByValue: true });
await sleep(3000);

const list2 = await (await fetch('http://localhost:9222/json/list')).json();
const opts = list2.find(t => t.type === 'page' && t.url.includes('options.html'));
console.log('options tab:', opts ? opts.url : 'NOT OPEN');
if (opts) {
  const ws2 = new WebSocket(opts.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = () => rej(new Error('ws error')); });
  let id2 = 0;
  const p2 = new Map();
  ws2.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && p2.has(m.id)) { p2.get(m.id)(m.result); p2.delete(m.id); }
  };
  await sleep(2500); // let fetches render
  const ev = expr => new Promise(resolve => {
    const i = ++id2;
    p2.set(i, resolve);
    ws2.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  const stats = await ev(`document.getElementById('statTotal')?.textContent`);
  const modelRows = await ev(`document.querySelectorAll('#modelInfo tbody tr').length`);
  const thrRows = await ev(`document.querySelectorAll('#thresholds tbody tr').length`);
  const recent = await ev(`document.querySelectorAll('#recentVerdicts tbody tr').length`);
  const child = await ev(`document.getElementById('childState')?.textContent?.slice(0, 60)`);
  console.log('stats total cell:', stats);
  console.log('model info rows:', modelRows, '| threshold rows:', thrRows, '| recent verdict rows:', recent);
  console.log('child lock state:', child);
}
process.exit(0);
