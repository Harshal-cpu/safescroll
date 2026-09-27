// Bulletproof options-page probe: stage results through document.title.
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
const ev = expr => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });

await ev(`window.__probe = 'start'; 1`);
const r1 = await ev(`chrome.runtime.sendMessage({type:'get-session-stats'}, r => { window.__probe = 'CB:' + JSON.stringify({r, err: chrome.runtime.lastError?.message ?? null}); }); 'sent'`);
await sleep(2500);
const read1 = await ev(`window.__probe`);
console.log('stats probe:', read1?.result?.value ?? JSON.stringify(read1).slice(0, 300));
process.exit(0);
