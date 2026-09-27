// Granular blur verification on live x.com:
//  A) toxic text + real image  -> ONLY text blurred (image untouched)
//  B) clean text + real image  -> NOTHING blurred
//  C) neutral image self-test  -> imageClassifier says clean (no false blur)
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));

// wake + reload the extension to pick up the new build
if (sw) {
  const ws0 = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
  const p0 = new Map();
  ws0.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && p0.get(m.id); if (h) { p0.delete(m.id); h(m.result); } };
  await new Promise(res => { const i = 1; p0.set(i, res); ws0.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: `chrome.runtime.reload(); 'r'` } })); });
  await sleep(4000);
}
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
  if (sw) break;
  await sleep(1000);
}
console.log('SW reloaded:', sw?.url?.slice(0, 75));

const xcom = list.find(t => t.type === 'page' && t.url.includes('x.com'));
if (!xcom) { console.log('no x.com tab'); process.exit(1); }
// RELOAD the page so a FRESH content script injects (old one is dead after extension reload)
const ws0 = new WebSocket(xcom.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
const p0 = new Map();
ws0.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && p0.get(m.id); if (h) { p0.delete(m.id); h(m.result); } };
ws0.send(JSON.stringify({ id: 999, method: 'Page.reload', params: { ignoreCache: true } }));
await sleep(8000); // x.com needs time to render the feed
ws0.close();
const ws = new WebSocket(xcom.webSocketDebuggerUrl);
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
    if (text.includes('SafeScroll')) logs.push(text.slice(0, 150));
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  p.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');

// grab a real image URL from the feed to use in synthetic posts
const imgSrc = await send('Runtime.evaluate', {
  expression: `document.querySelector('article img[src*="pbs.twimg.com/media"]')?.src ?? document.querySelector('img[alt="Image"]')?.src ?? ''`,
  returnByValue: true
});
console.log('real image url found:', imgSrc?.result?.value ? 'yes' : 'NO (posts will be text-only)');

// inject A (toxic text + image) and B (clean text + image)
await send('Runtime.evaluate', {
  expression: `(() => {
    const imgSrc = ${JSON.stringify(imgSrc?.result?.value ?? '')};
    const mk = (idv, text, withImg) => {
      document.getElementById(idv)?.remove();
      const art = document.createElement('article');
      art.id = idv;
      art.dataset.testid = 'tweet';
      art.style.cssText = 'position:relative;z-index:999998;background:#fff;color:#000;padding:10px;margin:8px;border-radius:12px;max-width:420px;';
      let html = '<div data-testid="tweetText"><p>' + text + '</p></div>';
      if (withImg && imgSrc) html += '<div><img alt="Image" src="' + imgSrc + '" style="width:100%;border-radius:8px"></div>';
      art.innerHTML = html;
      document.body.appendChild(art);
    };
    mk('ss-test-A', 'You are a worthless piece of garbage, nobody would even miss you', true);
    mk('ss-test-B', 'The weather is lovely today, perfect for a walk', true);
    return 'injected A+B';
  })()`,
  returnByValue: true
});
console.log('synthetic posts injected; waiting for classification…');
await sleep(20000);

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const dump = idv => {
      const el = document.getElementById(idv);
      if (!el) return { missing: true };
      const shields = [...el.querySelectorAll('.safescroll-shield')].map(s => ({
        target: s.dataset.safescrollTarget,
        display: s.style.display,
        verdict: s.dataset.verdictAction
      }));
      return { shields };
    };
    return JSON.stringify({ A_toxicText: dump('ss-test-A'), B_clean: dump('ss-test-B') });
  })()`,
  returnByValue: true
});
console.log('GRANULAR RESULT:', r?.result?.value);
console.log('--- SafeScroll console (last 8) ---');
logs.slice(-8).forEach(l => console.log(' ', l));
process.exit(0);
