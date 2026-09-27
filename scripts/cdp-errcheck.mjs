// Grab the exact error text from the dashboard's error rows + direct probes.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const opts = list.find(t => t.type === 'page' && t.url.includes('options.html'));
const ws = new WebSocket(opts.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let id = 0;
const p = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); }
};
const ev = expr => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});
const stats = await ev(`chrome.runtime.sendMessage({type:'get-session-stats'}).then(r => JSON.stringify(r), e => 'SEND_ERR ' + String(e))`);
console.log('direct stats:', stats?.result?.value);
const mi = await ev(`chrome.runtime.sendMessage({type:'get-model-info'}).then(r => JSON.stringify(r).slice(0, 300), e => 'SEND_ERR ' + String(e))`);
console.log('direct model-info:', mi?.result?.value);
process.exit(0);
