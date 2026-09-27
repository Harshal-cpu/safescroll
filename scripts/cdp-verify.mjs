// Full end-to-end verification against the live Chrome instance (port 9222).
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list;
for (let i = 0; i < 30; i++) {
  list = await (await fetch('http://localhost:9222/json/list')).json();
  if (list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'))) break;
  await sleep(1000);
}
const sw = list.find(t => t.type === 'service_worker' && t.url.includes('service-worker-loader'));
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5000'));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { reject(e); }
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, ws });
    ws.onerror = () => reject(new Error('ws error'));
  });
}
const val = r => r?.result?.result?.value;

// ---- SW: offscreen status + self-test ----
const swc = await connect(sw.webSocketDebuggerUrl);
const statusRaw = await swc.send('Runtime.evaluate', {
  expression: `new Promise(res => {
    const t = setTimeout(() => res('STATUS_TIMEOUT'), 20000);
    chrome.runtime.sendMessage({type: 'status'}).then(r => { clearTimeout(t); res(JSON.stringify(r)); }, e => { clearTimeout(t); res(JSON.stringify({error: String(e)})); });
  })`,
  awaitPromise: true, returnByValue: true
});
let st;
try { st = JSON.parse(val(statusRaw)); } catch { st = { raw: val(statusRaw) }; }
console.log('OFFSCREEN STATUS:', JSON.stringify({ modelsReady: st.modelsReady, loadStarted: st.loadStarted, stageState: st.stageState, modelsError: st.modelsError?.slice(0, 200) }));

const selfRaw = await swc.send('Runtime.evaluate', {
  expression: `new Promise(res => {
    const t = setTimeout(() => res('SELFTEST_TIMEOUT'), 60000);
    chrome.runtime.sendMessage({type: 'self-test'}).then(r => { clearTimeout(t); res(JSON.stringify(r)); }, e => { clearTimeout(t); res(JSON.stringify({error: String(e)})); });
  })`,
  awaitPromise: true, returnByValue: true
});
let st2;
try { st2 = JSON.parse(val(selfRaw)); } catch { st2 = { raw: val(selfRaw) }; }
console.log('SELF-TEST:', JSON.stringify(st2));

// ---- page: shields + verdicts ----
if (page) {
  const pc = await connect(page.webSocketDebuggerUrl);
  await sleep(12000); // observers + classify + verdict round-trips
  const domRaw = await pc.send('Runtime.evaluate', {
    expression: `(() => {
      const shields = [...document.querySelectorAll('.safescroll-shield')];
      return JSON.stringify({
        posts: document.querySelectorAll('article').length,
        shields: shields.map(s => ({ display: s.style.display, verdict: s.dataset.verdictAction }))
      });
    })()`,
    returnByValue: true
  });
  console.log('PAGE DOM:', val(domRaw));
} else {
  console.log('PAGE: no localhost:5000 target');
}
process.exit(0);
