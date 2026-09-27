const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const yt = list.find(t => t.type === 'page' && t.url.includes('youtube.com'));
const ws = new WebSocket(yt.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
// enumerate what feed-ish elements exist + scroll to trigger lazy load
const r1 = await send('Runtime.evaluate', {
  expression: `(() => {
    const counts = {};
    for (const el of document.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (tag.startsWith('ytd-') || tag === 'article') counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return JSON.stringify(counts);
  })()`,
  returnByValue: true
});
console.log('element census:', r1?.result?.value);
await send('Runtime.evaluate', { expression: `window.scrollTo(0, 800); 'scrolled'`, returnByValue: true });
await sleep(5000);
const r2 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ytdRich: document.querySelectorAll('ytd-rich-item-renderer').length, videos: document.querySelectorAll('ytd-video-renderer, ytd-compact-video-renderer').length, shields: document.querySelectorAll('.safescroll-shield').length})`,
  returnByValue: true
});
console.log('after scroll:', r2?.result?.value);
process.exit(0);
