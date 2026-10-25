// Verify that a fresh page can load the production content bundle from its
// chrome-extension:// URL. Uses a disposable Chrome profile.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const fixtureName = process.argv.includes('--fixture-instagram') ? 'instagram'
  : process.argv.includes('--fixture-social') ? 'social' : 'youtube';
const fixtureMode = ['--fixture-youtube', '--fixture-instagram', '--fixture-social']
  .some(flag => process.argv.includes(flag));
const fixtureFile = fixtureName === 'social' ? 'fixture-social-adapters.html'
  : `fixture-${fixtureName}-${fixtureName === 'youtube' ? 'shield' : 'moderation'}.html`;
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const loader = manifest.content_scripts[0].js[0];
const loaderSource = readFileSync(join(dist, loader), 'utf8');
const bundle = loaderSource.match(/chrome\.runtime\.getURL\("([^"]+)"\)/)?.[1];
assert.ok(bundle, 'Content loader must name its production bundle');
assert.ok(existsSync(join(dist, bundle)), `Missing content bundle: ${bundle}`);
assert.ok(manifest.web_accessible_resources.some(entry =>
  entry.resources.includes(bundle) && entry.matches.includes('http://*/*') && entry.matches.includes('https://*/*')
), `Content bundle is not web accessible: ${bundle}`);
assert.ok(manifest.web_accessible_resources.some(entry =>
  entry.resources.includes('assets/content.js-*.js') &&
  entry.matches.includes('https://*/*')
), 'Content bundles must remain accessible when build hashes change');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
assert.ok(existsSync(chrome), 'Chrome is required for this check');
const profile = mkdtempSync(join(tmpdir(), 'safescroll-resource-'));
const fixtureFiles = new Set([
  '/test/fixture-youtube-shield.html', '/test/fixture-instagram-moderation.html',
  '/test/fixture-social-adapters.html',
  '/test/meme-toxic.jpg', '/test/meme-clean.jpg',
  '/src/content/adapters.js', '/src/content/extract.js',
  '/src/content/detect.js', '/src/content/shield.js'
]);
const server = createServer((request, response) => {
  if (fixtureMode) {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!fixtureFiles.has(path)) { response.writeHead(404); response.end(); return; }
    const mime = path.endsWith('.html') ? 'text/html' : path.endsWith('.jpg') ? 'image/jpeg' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': mime });
    response.end(readFileSync(join(root, path.slice(1))));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html><body><article>Test page</article></body></html>');
});
let child;
let socket;
let closeBrowser;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    ...(process.argv.includes('--mobile') ? [
      '--user-agent=Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    ] : []),
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let chromeError = '';
  child.stderr.on('data', chunk => { chromeError += chunk.toString(); });

  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 60 && !existsSync(portFile); i++) await sleep(250);
  assert.ok(existsSync(portFile), `Chrome did not start its debugging endpoint (exit=${child.exitCode}, stderr=${chromeError.slice(-500)})`);
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  closeBrowser = () => send('Browser.close');

  const loaded = fixtureMode ? { id: null } : await send('Extensions.loadUnpacked', { path: dist });
  if (!fixtureMode) assert.ok(loaded.id, 'Chrome did not load SafeScroll');
  const suppliedUrl = process.argv.indexOf('--url');
  const url = fixtureMode ? `http://127.0.0.1:${server.address().port}/test/${fixtureFile}`
    : suppliedUrl >= 0 ? process.argv[suppliedUrl + 1]
    : process.argv.includes('--youtube') ? 'https://www.youtube.com/?app=desktop'
      : `http://127.0.0.1:${server.address().port}/`;
  const page = await send('Target.createTarget', { url });
  assert.ok(page.targetId, 'Chrome did not open the test page');
  let target;
  for (let i = 0; i < 40; i++) {
    const targets = await (await fetch(`${endpoint}/json/list`)).json();
    target = targets.find(item => item.id === page.targetId);
    if (target?.webSocketDebuggerUrl) break;
    await sleep(250);
  }
  assert.ok(target?.webSocketDebuggerUrl, 'Test page is not debuggable');
  const pageSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { pageSocket.onopen = resolve; pageSocket.onerror = reject; });
  let pageId = 0;
  const pagePending = new Map();
  const contentContexts = new Set();
  let contentLoaded = false;
  let loadError;
  const pageErrors = [];
  pageSocket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') {
      const { id: contextId, origin } = message.params.context;
      if (loaded.id && origin === `chrome-extension://${loaded.id}`) contentContexts.add(contextId);
    }
    if (message.method === 'Runtime.executionContextDestroyed') contentContexts.delete(message.params.executionContextId);
    if (message.method === 'Runtime.executionContextsCleared') contentContexts.clear();
    if (message.method === 'Runtime.consoleAPICalled') {
      const line = message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
      if (/Unsafe attempt to load URL|Failed to fetch dynamically imported module/.test(line)) loadError = line;
      if (message.params.type === 'error') pageErrors.push(line);
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    if (!message.id || !pagePending.has(message.id)) return;
    const { resolve, reject } = pagePending.get(message.id);
    pagePending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  const pageSend = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++pageId;
    pagePending.set(requestId, { resolve, reject });
    pageSocket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await pageSend('Runtime.enable');
  await pageSend('Page.enable');
  await pageSend('Page.reload');
  let fixtureResult;
  for (let i = 0; i < 80 && !contentLoaded && !loadError && !fixtureResult; i++) {
    if (fixtureMode) {
      const result = await pageSend('Runtime.evaluate', {
        expression: `document.documentElement.dataset.testStatus === 'pass' || document.documentElement.dataset.testStatus === 'fail' ? document.getElementById('result')?.textContent : null`,
        returnByValue: true
      });
      fixtureResult = result.result?.value;
    }
    for (const contextId of contentContexts) {
      try {
        const result = await pageSend('Runtime.evaluate', {
          expression: 'typeof window.__safescroll', contextId, returnByValue: true
        });
        if (result.result?.value === 'object') contentLoaded = true;
      } catch { /* The context may have been destroyed during navigation. */ }
    }
    if (!contentLoaded && !fixtureResult) await sleep(250);
  }
  if (fixtureMode) {
    assert.ok(fixtureResult, `${fixtureName} fixture did not finish: ${pageErrors.join(' | ')}`);
    const result = JSON.parse(fixtureResult);
    assert.ok(result.pass, fixtureResult);
    if (process.argv.includes('--verbose')) console.log(fixtureResult);
    if (process.argv.includes('--screenshot')) {
      const shot = await pageSend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const path = join(root, 'tmp', `${fixtureName}-shield-visual.png`);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      console.log(`Fixture screenshot: ${path}`);
    }
    console.log(`PASS ${fixtureName} adapter and shield fixture (${Object.keys(result.checks).length} checks)`);
  } else {
  if (process.argv.includes('--inspect-dom')) {
    await sleep(5000);
    const dom = await pageSend('Runtime.evaluate', {
      expression: `JSON.stringify({url: location.href, ready: document.readyState, tags: [...document.querySelectorAll('*')].reduce((counts, el) => {
        const tag = el.localName;
        if (tag?.startsWith('ytd-') || tag?.startsWith('ytm-')) counts[tag] = (counts[tag] || 0) + 1;
        return counts;
      }, {})})`, returnByValue: true
    });
    console.log(dom.result?.value);
  }
  assert.ifError(loadError);
  assert.ok(contentLoaded, `SafeScroll content script did not load on a fresh page (contexts=${contentContexts.size})`);
  }
  pageSocket.close();
  if (!fixtureMode) console.log(`PASS ${bundle} loads in a fresh ${url} page`);
} finally {
  if (closeBrowser) {
    try { await Promise.race([closeBrowser(), sleep(1000)]); } catch { /* Chrome may already be closed. */ }
  }
  socket?.close();
  if (child && child.exitCode === null) child.kill();
  server.closeAllConnections();
  server.close();
  const safeRoot = resolve(tmpdir());
  const safeProfile = resolve(profile);
  if (safeProfile.startsWith(safeRoot + sep) && basename(safeProfile).startsWith('safescroll-resource-')) {
    for (let i = 0; i < 20; i++) {
      try { rmSync(safeProfile, { recursive: true, force: true }); break; }
      catch (error) {
        if (error.code !== 'EBUSY' || i === 19) {
          console.warn(`Temporary Chrome profile could not be removed: ${safeProfile} (${error.code})`);
          break;
        }
        await sleep(500);
      }
    }
  }
}
