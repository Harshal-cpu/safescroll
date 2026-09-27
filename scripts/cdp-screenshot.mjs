const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9222/json/list')).json();
const xcom = list.find(t => t.type === 'page' && t.url.includes('x.com'));
const ws = new WebSocket(xcom.webSocketDebuggerUrl);
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
// scroll the test post into view + shot
await send('Runtime.evaluate', {
  expression: `document.getElementById('safescroll-e2e-test')?.scrollIntoView({block:'center'}); 'ok'`,
  returnByValue: true
});
await sleep(1000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('test/e2e-proof.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot saved: test/e2e-proof.png');
process.exit(0);
