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
const evalSW = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r?.result?.value ?? ('NO_VALUE ' + JSON.stringify(r?.exceptionDetails?.exception?.description ?? r).slice(0, 300));
};

console.log('contexts:', await evalSW(`chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT','SERVICE_WORKER']}).then(cs => JSON.stringify(cs.map(c => ({type: c.contextType, url: c.url.slice(0,70)}))))`));
console.log('ping:', await evalSW(`new Promise(res => { const t = setTimeout(() => res('PING_TIMEOUT'), 8000); chrome.runtime.sendMessage({type:'offscreen-ping'}).then(r => { clearTimeout(t); res(JSON.stringify(r)); }, e => { clearTimeout(t); res('PING_ERR ' + String(e).slice(0,150)); }); })`));
console.log('status:', await evalSW(`new Promise(res => { const t = setTimeout(() => res('STATUS_TIMEOUT'), 8000); chrome.runtime.sendMessage({type:'status'}).then(r => { clearTimeout(t); res(JSON.stringify(r).slice(0,400)); }, e => { clearTimeout(t); res('STATUS_ERR ' + String(e).slice(0,150)); }); })`));
console.log('selftest:', await evalSW(`new Promise(res => { const t = setTimeout(() => res('SELFTEST_TIMEOUT'), 60000); chrome.runtime.sendMessage({type:'self-test'}).then(r => { clearTimeout(t); res(JSON.stringify(r)); }, e => { clearTimeout(t); res('SELFTEST_ERR ' + String(e).slice(0,150)); }); })`));
process.exit(0);
