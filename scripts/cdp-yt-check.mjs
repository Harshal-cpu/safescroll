// Open instagram + youtube tabs, verify content script runs and clean content isn't blurred.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = await (await fetch('http://localhost:9222/json/list')).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
const ws0 = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
const p0 = new Map();
ws0.onmessage = e => { const m = JSON.parse(e.data); const h = m.id && p0.get(m.id); if (h) { p0.delete(m.id); h(m.result); } };
await new Promise(res => { p0.set(1, res); ws0.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://www.youtube.com/feed/trending' } })); });
await sleep(12000);
list = await (await fetch('http://localhost:9222/json/list')).json();
const yt = list.find(t => t.type === 'page' && t.url.includes('youtube.com'));
console.log('yt tab:', yt?.url?.slice(0, 60));
if (yt) {
  const ws = new WebSocket(yt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const p = new Map(); const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const h = m.id && p.get(m.id);
    if (h) { p.delete(m.id); h(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (text.includes('SafeScroll')) logs.push(text.slice(0, 130));
    }
  };
  const send = (method, params = {}) => new Promise(resolve => { const i = ++id; p.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await sleep(6000);
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      units: document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer').length,
      shields: [...document.querySelectorAll('.safescroll-shield')].map(s => s.dataset.safescrollTarget + ':' + s.dataset.verdictAction + ':' + s.style.display)
    })`,
    returnByValue: true
  });
  console.log('YT STATE:', r?.result?.value);
  console.log('YT logs:', logs.slice(0, 5));
}
process.exit(0);
