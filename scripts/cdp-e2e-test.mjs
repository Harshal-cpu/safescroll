// End-to-end test in the LIVE x.com tab: inject a synthetic tweet containing
// text that the model verifiably blocks (self-test score 0.996). The content
// script's MutationObserver should detect it, classify it, and blur it.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const xcom = list.find(t => t.type === 'page' && t.url.includes('x.com'));
if (!xcom) { console.log('no x.com tab'); process.exit(1); }
const ws = new WebSocket(xcom.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
let id = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('SafeScroll')) consoleLogs.push(text.slice(0, 160));
  }
};
await ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id;
  pending.set(i, { resolve });
  ws.send(JSON.stringify({ id: i, method, params }));
});

// inject a toxic synthetic post (mirrors real tweet DOM)
await send('Runtime.evaluate', {
  expression: `(() => {
    document.getElementById('safescroll-e2e-test')?.remove();
    const art = document.createElement('article');
    art.id = 'safescroll-e2e-test';
    art.dataset.testid = 'tweet';
    art.style.cssText = 'position:fixed;top:10px;left:10px;z-index:999999;background:#fff;padding:12px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:420px;';
    art.innerHTML = '<div data-testid="tweetText"><p>You are a worthless piece of garbage, nobody would even miss you</p></div>';
    document.body.appendChild(art);
    return 'injected';
  })()`,
  returnByValue: true
});
console.log('toxic post injected into x.com DOM; waiting for observer + classify…');
await sleep(15000);

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const test = document.getElementById('safescroll-e2e-test');
    const shield = test?.querySelector('.safescroll-shield');
    return JSON.stringify({
      testPostPresent: !!test,
      shieldPresent: !!shield,
      shieldDisplay: shield?.style.display,
      verdict: shield?.dataset.verdictAction,
      statusText: shield?.querySelector('div div:nth-child(2)')?.textContent
    });
  })()`,
  returnByValue: true
});
console.log('E2E RESULT:', r?.result?.value);
console.log('--- SafeScroll console lines during test ---');
consoleLogs.slice(-10).forEach(l => console.log(l));
// cleanup: leave the post visible for the user to see the blur; they can reload
process.exit(0);
