// SW-side probe: does the offscreen respond to the new message types?
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, sw;
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
  if (sw) break;
  await sleep(1000);
}
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
const expr = `
  chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']}).then(async cs => {
    if (!cs.length) return 'NO_OFFSCREEN';
    const ping = await chrome.runtime.sendMessage({type:'offscreen-ping'}).then(r => JSON.stringify(r), e => 'PING_ERR: ' + String(e).slice(0,120));
    const stats = await chrome.runtime.sendMessage({type:'get-session-stats'}).then(r => JSON.stringify(r), e => 'STATS_ERR: ' + String(e).slice(0,120));
    return JSON.stringify({count: cs.length, ping, stats});
  })
`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('SW probe:', r?.result?.value ?? JSON.stringify(r).slice(0, 400));
process.exit(0);
