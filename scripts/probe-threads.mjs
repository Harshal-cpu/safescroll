// Is multi-threaded WASM actually available? This decides whether the 278M text
// model can use more than one core.
//
// The extension is pinned to numThreads=1 because ORT spawns its pthread pool
// from a blob: URL, which MV3's `script-src 'self'` blocks. But real ORT threads
// need SharedArrayBuffer, which needs cross-origin isolation — and Chrome grants
// that to chrome-extension:// origins by default. If both hold, we can turn
// threads on and the ~300ms/window drops toward ~100ms.
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes('codfiojndhkoggdjbcjhdapgfcgieemp'));
if (!sw) {
  console.log('SafeScroll service worker not among targets:');
  list.forEach(t => console.log('  ', t.type, t.url));
  process.exit(1);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const p = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    crossOriginIsolated: self.crossOriginIsolated === true,
    hasSAB: typeof SharedArrayBuffer !== 'undefined',
    canAllocateSAB: (() => { try { new SharedArrayBuffer(1024); return true; } catch (e) { return String(e.name || e); } })(),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    ua: navigator.userAgent.slice(0, 60)
  })`,
  returnByValue: true
});
const o = JSON.parse(r.result.value);
console.log('\n=== WASM threading capability (extension origin) ===');
for (const [k, v] of Object.entries(o)) console.log(`  ${k.padEnd(20)} ${v}`);

const threadsOk = o.crossOriginIsolated && o.canAllocateSAB === true;
console.log(`\n  => multi-threaded WASM: ${threadsOk ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
if (threadsOk) {
  console.log(`  => suggested numThreads: ${Math.max(1, Math.min(8, (o.hardwareConcurrency || 4) - 1))}`);
} else {
  console.log('  => single-threaded is a hard platform limit here; per-window cost cannot');
  console.log('     be reduced by threading. The only remaining levers are fewer/cheaper');
  console.log('     inferences and not blocking the thread on them.');
}
process.exit(0);
