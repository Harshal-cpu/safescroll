const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const opts = list.find(t => t.type === 'page' && t.url.includes('options.html'));
const ws = new WebSocket(opts.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p.get(m.id);
  if (h) { p.delete(m.id); h(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('stats run')) logs.push(text.slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(9000);
const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });
const state = await ev(`JSON.stringify({runs: window.__statsRuns, total: document.getElementById('statTotal')?.textContent, blocked: document.getElementById('statBlocked')?.textContent})`);
console.log('STATE @9s:', state?.result?.value);
console.log('CONSOLE calls:');
logs.forEach(l => console.log(' ', l));
process.exit(0);
