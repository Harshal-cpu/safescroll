// Disposable Chrome regression for the console failures. Loads production dist
// and closes only the browser/profile created by this script.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'ss-log-test-'));
const extension = join(temporary, 'ext');
const profile = join(temporary, 'profile');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const requests = new Map();
let imageBytes;
const server = createServer((request, response) => {
  requests.set(request.url, (requests.get(request.url) ?? 0) + 1);
  if (request.url === '/timeout.png' && requests.get(request.url) <= 2) return;
  response.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
  response.end(imageBytes);
});
const connections = [];
let child;
let browser;
function connect(url) {
  const ws = new WebSocket(url);
  const waiting = new Map();
  const events = [];
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled') events.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
    if (!message.id || !waiting.has(message.id)) return;
    const { resolve, reject, timer } = waiting.get(message.id);
    waiting.delete(message.id);
    clearTimeout(timer);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = async (method, params = {}, timeoutMs = 90_000) => {
    await ready;
    return new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { waiting.delete(current); reject(new Error(`${method} timed out`)); }, timeoutMs);
      waiting.set(current, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
  };
  connections.push(ws);
  return { send, events, evaluate: async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  } };
}

try {
  assert.ok(existsSync(chromePath), 'Chrome is installed');
  cpSync(join(root, 'dist'), extension, { recursive: true });
  child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging',
    '--enable-unsafe-swiftshader', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const activePort = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 60 && !existsSync(activePort); i++) await sleep(500);
  assert.ok(existsSync(activePort), 'Chrome exposes CDP');
  const port = readFileSync(activePort, 'utf8').split('\n')[0].trim();
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  browser = connect(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extension });
  assert.ok(loaded.id, `Extension loader returned ${JSON.stringify(loaded)}`);
  console.log('PASS SafeScroll loaded through the DevTools extension API');
  await browser.send('Target.createTarget', { url: `chrome-extension://${loaded.id}/src/options/options.html` });
  const targets = () => fetch(`${endpoint}/json/list`).then(response => response.json());
  let worker;
  for (let i = 0; i < 40 && !worker; i++) {
    worker = (await targets()).find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${loaded.id}/`));
    if (!worker) await sleep(500);
  }
  if (!worker) console.log('Extension targets:', JSON.stringify((await targets()).filter(target => target.url.startsWith('chrome-extension://')).map(({type,url}) => ({type,url}))));
  assert.ok(worker, 'SafeScroll service worker loaded');
  const pageTarget = (await targets()).find(target => target.type === 'page' && target.url === `chrome-extension://${loaded.id}/src/options/options.html`);
  assert.ok(pageTarget, 'Extension options page loaded');
  const client = connect(pageTarget.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  let binding;
  for (let i = 0; i < 20 && !binding; i++) {
    binding = await client.evaluate(`typeof chrome==='object' && chrome.runtime?.id`);
    if (!binding) await sleep(250);
  }
  assert.equal(binding, loaded.id, 'Options page has extension API bindings');
  console.log('PASS disposable Chrome and extension service worker connected');
  const message = payload => client.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
  await client.evaluate(`chrome.storage.sync.set({ocrEnabled:true,imageEnabled:true,lexiconEnabled:true})`);
  console.log('PASS test settings applied');
  await client.evaluate(`(() => {
    globalThis.__probeEvents = [];
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type === 'verdict-refined') __probeEvents.push({key:msg.key,action:msg.verdict?.action,completed:msg.mediaCompleted});
    });
  })()`);
  let status;
  for (let i = 0; i < 90; i++) {
    status = await message({ type: 'status' });
    if (status?.modelsReady) break;
    if (status?.modelsError) throw new Error(status.modelsError);
    await sleep(1000);
  }
  assert.ok(status?.modelsReady, 'Local models ready');
  console.log('PASS production extension and local models loaded');
  const offscreenTarget = (await targets()).find(target => target.url.endsWith('/src/offscreen/offscreen.html'));
  assert.ok(offscreenTarget, 'Offscreen document is available');
  const offscreen = connect(offscreenTarget.webSocketDebuggerUrl);
  await offscreen.send('Runtime.enable');
  assert.equal(await offscreen.evaluate('typeof chrome.storage'), 'undefined');
  async function updateSettings(values) {
    await client.evaluate(`chrome.storage.sync.set(${JSON.stringify(values)})`);
    for (let i = 0; i < 30; i++) {
      const diag = await message({ type: 'media-diag' });
      if (Object.entries(values).every(([key, value]) => diag.runtime[key] === value)) return;
      await sleep(100);
    }
    throw new Error('Stored settings did not reach the offscreen document');
  }
  await updateSettings({ ocrEnabled: false, imageEnabled: false });
  const disabled = await message({ type: 'classify-media', key: 'disabled-probe', images: [{ url: 'https://example.test/unreachable.png' }] });
  assert.equal(disabled.skipped, true);
  const disabledDiag = await message({ type: 'media-diag' });
  assert.equal(disabledDiag.ocrQueue.active, 0);
  assert.equal(disabledDiag.ocrQueue.queued, 0);
  await updateSettings({ ocrEnabled: true, imageEnabled: true });
  console.log('PASS stored settings reach offscreen without storage API; disabling and re-enabling media works');
  if (!process.argv.includes('--settings-only')) {
  const dataUrl = await offscreen.evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width=900; canvas.height=250;
    const context=canvas.getContext('2d'); context.fillStyle='#fff'; context.fillRect(0,0,900,250);
    context.fillStyle='#000'; context.font='bold 64px Arial'; context.textAlign='center';
    context.fillText('GO FUCK YOURSELF',450,145); return canvas.toDataURL('image/png');
  })()`);
  imageBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${server.address().port}`;

  // Warm OCR first; a cold traineddata download can outlive the caller wait.
  await message({ type: 'classify', key: 'warm', text: 'The weather is lovely today.', siteId: 'probe' });
  const warmResponse = await message({ type: 'classify-media', key: 'warm', images: [{ dataUrl }], siteId: 'probe' });
  for (let i = 0; i < 60; i++) {
    const verdict = await message({ type: 'classify', key: 'warm', text: 'The weather is lovely today.', siteId: 'probe' });
    if (verdict?.verdict?.action === 'block') break;
    const warmDiag = await message({ type: 'media-diag' });
    if (warmDiag.mediaLog.findLast(entry => entry.key === 'warm')?.ocrStatus === 'error') break;
    await sleep(1000);
  }
  const warmVerdict = await message({ type: 'classify', key: 'warm', text: 'The weather is lovely today.', siteId: 'probe' });
  if (warmVerdict?.verdict?.action !== 'block') {
    const warmDiag = await message({ type: 'media-diag' });
    console.log('OCR warm-up diagnostic:', JSON.stringify({response:warmResponse,media:warmDiag.mediaLog.filter(entry=>entry.key==='warm'),logs:offscreen.events.filter(line=>/OCR|failed|error/i.test(line)).slice(-10)}));
  }
  assert.equal(warmVerdict?.verdict?.action, 'block');
  console.log('PASS real Tesseract reads the synthetic harmful caption');

  await message({ type: 'classify', key: 'image-retry', text: 'The weather is lovely today.', siteId: 'probe' });
  // Image classification starts its decode first; OCR must still publish its
  // finding while the failed image decode waits for the five-second retry.
  await offscreen.evaluate(`(() => {
    const original = globalThis.createImageBitmap; let once=true;
    globalThis.createImageBitmap=async (...args) => {
      if (once) {once=false; throw new DOMException('Simulated image decode failure','InvalidStateError');}
      return original(...args);
    };
    globalThis.__restoreBitmap=()=>{globalThis.createImageBitmap=original;};
  })()`);
  const deferred = await message({ type: 'classify-media', key: 'image-retry', images: [{ url: `${source}/retry.png` }], referer: `${source}/feed`, siteId: 'probe' });
  assert.equal(deferred?.deferred, 'image-fetch');
  const persisted = await message({ type: 'classify', key: 'image-retry', text: 'The weather is lovely today.', siteId: 'probe' });
  assert.equal(persisted?.verdict?.action, 'block');
  assert.ok(persisted.verdict.reasons.some(reason => reason.source === 'lexicon-ocr' || reason.source === 'ocr-text'));
  assert.ok(await client.evaluate(`__probeEvents.some(event=>event.key==='image-retry'&&event.action==='block')`));
  assert.equal(requests.get('/retry.png'), 1);
  console.log('PASS one shared download; OCR block persisted and notified before image retry');
  await offscreen.evaluate('__restoreBitmap()');

  await message({ type: 'classify', key: 'timeout-retry', text: 'The weather is lovely today.', siteId: 'probe' });
  const timeout = await message({ type: 'classify-media', key: 'timeout-retry', images: [{ url: `${source}/timeout.png` }], referer: `${source}/feed`, siteId: 'probe' });
  assert.equal(timeout?.deferred, 'ocr-error');
  const diag = await message({ type: 'media-diag' });
  const failure = diag.mediaLog.findLast(entry => entry.key === 'timeout-retry');
  assert.equal(failure.ocrStatus, 'error');
  assert.equal(failure.ocrResult.reason, 'fetch-timeout');
  assert.equal(failure.imageStatus, 'error');
  for (let i = 0; i < 20; i++) {
    const current = await message({ type: 'classify', key: 'timeout-retry', text: 'The weather is lovely today.', siteId: 'probe' });
    if (current?.verdict?.action === 'block') break;
    await sleep(1000);
  }
  assert.equal((await message({ type: 'classify', key: 'timeout-retry', text: 'The weather is lovely today.', siteId: 'probe' }))?.verdict?.action, 'block');
  assert.equal(requests.get('/timeout.png'), 3);
  console.log('PASS explicit timeout state and one bounded retry recover to a persisted OCR block');
  }
  await browser.send('Browser.close', {}, 5000);
  console.log(process.argv.includes('--settings-only') ? 'ALL SETTINGS BROWSER CHECKS PASSED' : 'ALL BROWSER CHECKS PASSED');
} catch (error) {
  console.error('BROWSER CHECK FAILED:', error.message);
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.send('Browser.close', {}, 3000); } catch { /* already closed */ } }
  connections.forEach(ws => ws.close());
  server.closeAllConnections();
  server.close();
  if (child && child.exitCode === null) child.kill();
  const target = resolve(temporary), parent = resolve(tmpdir());
  if (target.startsWith(parent + '\\') && basename(target).startsWith('ss-log-test-')) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* Chrome may still be closing */ }
  }
}
