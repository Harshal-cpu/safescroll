// Launches a disposable Chrome with the built extension loaded, for CDP
// verification. Uses a path WITHOUT SPACES: Chrome's --load-extension is parsed
// as a space-separated list, so an extension path containing a space silently
// loads nothing (this bit us on "D:\safescroll - Copy").
//
//   node scripts/launch-chrome.mjs [--url <url>]
//
// Prints the CDP endpoint and the staged extension path. Add --keep to leave it
// running; otherwise it stays up until killed.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
];
const chrome = CHROME_CANDIDATES.find(p => p && existsSync(p));
if (!chrome) { console.error('Chrome not found'); process.exit(1); }

const dist = process.argv.includes('--dist') ? 'dist' : 'dist-test';
// fileURLToPath, not URL#pathname: a project path containing a space is
// percent-encoded in pathname ("%20") and would not resolve on disk.
const src = fileURLToPath(new URL(`../${dist}/`, import.meta.url));
if (!existsSync(src)) { console.error(`${src} not found - run: npm run build && node scripts/make-test-dist.mjs`); process.exit(1); }

const base = join(tmpdir(), 'opencode', 'safescroll-verify');
const extPath = join(base, 'ext');
const profile = join(base, 'profile');

rmSync(extPath, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
cpSync(src, extPath, { recursive: true });
if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

if (/\s/.test(extPath) || /\s/.test(profile)) {
  console.error('Staged paths must not contain spaces:', extPath);
  process.exit(1);
}

const urlArg = process.argv.indexOf('--url');
const startUrl = urlArg > -1 ? process.argv[urlArg + 1] : 'http://localhost:5000/test/fixture-forum.html';

console.log('chrome   :', chrome);
console.log('extension:', extPath);
console.log('profile  :', profile);
console.log('cdp      : http://127.0.0.1:9222');

const child = spawn(chrome, [
  '--remote-debugging-port=9222',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,OptimizationHints',
  // Chrome 137+ silently IGNORES --load-extension unless this flag is also set.
  // Symptom: the extension appears installed but no content script is injected
  // and no chrome-extension:// service worker target exists.
  '--enable-unsafe-extension-debugging',
  '--remote-allow-origins=*',
  `--load-extension=${extPath}`,
  `--disable-extensions-except=${extPath}`,
  startUrl
], { detached: true, stdio: 'ignore' });
child.unref();

// wait for the CDP endpoint
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  try {
    const r = await fetch('http://127.0.0.1:9222/json/list');
    if (r.ok) { console.log('READY'); process.exit(0); }
  } catch { /* retry */ }
  await new Promise(r => setTimeout(r, 500));
}
console.error('Chrome did not expose CDP on 9222 within 20s');
process.exit(1);
