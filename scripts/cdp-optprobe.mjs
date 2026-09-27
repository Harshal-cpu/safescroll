// Deep probe INSIDE the options page: raw responses incl. lastError.
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
const ev = expr => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});

const r = await ev(`
  new Promise(async res => {
    const out = {};
    // 1. callback form w/ lastError
    out.callbackForm = await new Promise(res2 => {
      try {
        chrome.runtime.sendMessage({ type: 'get-session-stats' }, r => {
          res2(JSON.stringify({ resp: r, lastError: chrome.runtime.lastError?.message ?? null }));
        });
      } catch (e) { res2('THROW ' + String(e)); }
    });
    // 2. ping for comparison
    out.ping = await new Promise(res2 => {
      chrome.runtime.sendMessage({ type: 'offscreen-ping' }, r => {
        res2(JSON.stringify({ resp: r, lastError: chrome.runtime.lastError?.message ?? null }));
      });
    });
    // 3. does THIS page see any other senders? contexts
    out.contextId = chrome.runtime.id;
    res(JSON.stringify(out));
  })
`);
console.log('options deep probe:', r?.result?.value);
process.exit(0);
