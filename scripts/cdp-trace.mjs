// Trigger a stats call from the options page and capture the SW console.
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
const r = await send('Runtime.evaluate', {
  expression: `new Promise(res => {
    chrome.runtime.sendMessage({type:'get-session-stats'}, resp => {
      res('RESP:' + JSON.stringify({resp, err: chrome.runtime.lastError?.message ?? null}));
    });
  })`,
  awaitPromise: true, returnByValue: true
});
console.log('options got:', r?.result?.value);
process.exit(0);
