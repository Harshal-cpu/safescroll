// One-shot: list the extensions Chrome actually loaded, with their IDs, and
// report any load errors. Used to debug "content script not injected".
const PORT = 9222;
const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.startsWith('chrome://extensions'));
if (!page) { console.error('open chrome://extensions in the debug Chrome first'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await new Promise(r => setTimeout(r, 1200));
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const mgr = document.querySelector('extensions-manager');
    const items = mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') || [];
    return JSON.stringify([...items].map(it => {
      const sr = it.shadowRoot;
      const id = sr.querySelector('#enableToggle')?.id;
      const name = sr.querySelector('#name')?.textContent?.trim();
      const desc = sr.querySelector('#description')?.textContent?.trim();
      const toggle = sr.querySelector('#enableToggle');
      return { name, desc, enabled: toggle?.checked, hasError: !!sr.querySelector('#errors-button') };
    }));
  })()`,
  returnByValue: true
});
console.log(JSON.stringify(JSON.parse(r?.result?.value || '[]'), null, 2));
process.exit(0);
