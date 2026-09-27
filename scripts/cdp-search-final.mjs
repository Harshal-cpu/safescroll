// Clean final pass: fresh reload, inject, single read, screenshot.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000/search.html'));
const ws0 = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
ws0.send(JSON.stringify({ id: 3, method: 'Page.reload', params: { ignoreCache: true } }));
await sleep(9000); // fresh content script + base scan
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
// inject one toxic + one clean result AFTER the initial scan (MutationObserver path)
await send('Runtime.evaluate', {
  expression: `(() => {
    const mk = (idv, title, text) => {
      document.getElementById(idv)?.remove();
      const g = document.createElement('div');
      g.className = 'g'; g.id = idv;
      g.innerHTML = '<h3>' + title + '</h3><p>' + text + '</p>';
      document.getElementById('results').appendChild(g);
    };
    mk('fin-toxic', 'Final toxic test', 'You are a worthless piece of garbage, nobody would even miss you');
    mk('fin-clean', 'Final clean test', 'Lovely sunny day, perfect for the beach this weekend');
    return 'ok';
  })()`,
  returnByValue: true
});
await sleep(15000);
await send('Runtime.evaluate', { expression: `document.getElementById('fin-toxic')?.scrollIntoView({block:'center'}); 1`, returnByValue: true });
await sleep(1500);
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const dump = idv => {
      const el = document.getElementById(idv);
      return [...(el?.querySelectorAll('.safescroll-shield') ?? [])].map(s => ({
        target: s.dataset.safescrollTarget,
        verdict: s.dataset.verdictAction,
        display: s.style.display,
        overridden: s.dataset.userOverrode ?? 'no'
      }));
    };
    return JSON.stringify({ toxic: dump('fin-toxic'), clean: dump('fin-clean') });
  })()`,
  returnByValue: true
});
console.log('FINAL:', r?.result?.value);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('test/search-blur-proof.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: test/search-blur-proof.png');
process.exit(0);
