// IG deep: what feed containers exist? role=feed? articles elsewhere?
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const ig = list.find(t => t.type === 'page' && t.url.includes('instagram.com'));
const ws = new WebSocket(ig.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  const h = m.id && p.get(m.id);
  if (h) { p.delete(m.id); h(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map(a => a.value ?? '').join(' ');
    if (t.includes('SafeScroll')) logs.push(t.slice(0, 140));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    roleFeed: document.querySelectorAll('[role="feed"]').length,
    svg_posts: document.querySelectorAll('svg[aria-label*="like" i]').length,
    imgs: document.querySelectorAll('img').length,
    postLinks: document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length,
    bodySnippet: document.body.innerText.slice(0, 150).replace(/\\n/g, ' | ')
  })`,
  returnByValue: true
});
console.log('IG DOM:', r?.result?.value);
console.log('logs:', logs.slice(0, 6));
process.exit(0);
