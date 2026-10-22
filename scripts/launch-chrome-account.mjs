// Relaunches the user's REAL Chrome profile with a CDP debugging port, so the
// built extension (installed unpacked at its normal path) can be verified
// end-to-end.
//
// Why a copy instead of the live profile:
//   * Chrome 136+ refuses --remote-debugging-port on the default user-data-dir.
//   * Attaching CDP to the live profile while it is running is impossible, and
//     Chrome rewrites Preferences/Secure Preferences on exit, which would
//     invalidate the extension entry we need.
// So: close Chrome, copy the profile prefs (not the 3GB of cache/History), and
// relaunch from a temp dir. The extension is unpacked, so it loads from its
//   recorded path on disk and needs no --load-extension (which Chrome 137+ ignores).
//
//   node scripts/launch-chrome-account.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
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

const srcRoot = join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const srcProfile = join(srcRoot, 'Default');
if (!existsSync(srcProfile)) { console.error(`No Default profile at ${srcProfile}`); process.exit(1); }

const base = join(tmpdir(), 'opencode', 'safescroll-account');
const dstRoot = join(base, 'User Data');
const dstProfile = join(dstRoot, 'Default');

// ------------------------------------------------------- 1. close Chrome
console.log('closing Chrome…');
try {
  execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
} catch { /* not running */ }
await new Promise(r => setTimeout(r, 4000));
// clear any singleton lock left behind
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  const p = join(srcRoot, f);
  if (existsSync(p)) { try { rmSync(p, { force: true }); } catch { /* ok */ } }
}

// -------------------------------------------- 2. copy just what's needed
// The extension is UNPACKED: its code lives at the path recorded in Secure
// Preferences, so only the preference files that mark it enabled must be copied.
// Cookies/history/cache are irrelevant to the verification and would add GBs.
rmSync(base, { recursive: true, force: true });
mkdirSync(dstProfile, { recursive: true });

const WANTED_FILES = ['Preferences', 'Secure Preferences', 'Bookmarks', 'Login Data'];
const WANTED_DIRS = ['Local Extension Settings', 'Sync Extension Settings', 'Extension Rules'];

for (const f of WANTED_FILES) {
  const s = join(srcProfile, f);
  if (existsSync(s)) { cpSync(s, join(dstProfile, f)); console.log('  copied', f); }
}
for (const d of WANTED_DIRS) {
  const s = join(srcProfile, d);
  if (existsSync(s)) { cpSync(s, join(dstProfile, d), { recursive: true }); console.log('  copied dir', d); }
}
// Local State carries the profile metadata + the encryption keys the Secure
// Preferences MAC is validated against. Without it Chrome discards the entry.
const ls = join(srcRoot, 'Local State');
if (existsSync(ls)) { cpSync(ls, join(dstRoot, 'Local State')); console.log('  copied Local State'); }

// Confirm the extension entry survived the copy before launching.
//
// DO NOT REWRITE Secure Preferences. Chrome protects `extensions.settings.<id>`
// with a MAC; editing that value here (adding `state`, `disable_reasons`, or
// reformatting the JSON) makes the MAC fail validation and Chrome then DELETES
// the whole entry on startup — symptom: `prefs.tracked_preferences_reset:
// ["extensions.settings.<id>"]` and no chrome-extension:// target at all, i.e.
// a silent "the extension never loaded". We only REPORT what we find.
const SP_ID = 'codfiojndhkoggdjbcjhdapgfcgieemp';
const spPath = join(dstProfile, 'Secure Preferences');
if (existsSync(spPath)) {
  const sp = JSON.parse(readFileSync(spPath, 'utf8'));
  const settings = sp?.extensions?.settings ?? {};
  const ids = Object.keys(settings);
  console.log(`  extensions in copied profile: ${ids.length}`);
  const mine = settings[SP_ID];
  if (mine) {
    const hadReasons = Array.isArray(mine.disable_reasons) && mine.disable_reasons.length;
    console.log(`  SafeScroll entry: path=${mine.path} location=${mine.location} ` +
      `disable_reasons=${JSON.stringify(mine.disable_reasons ?? null)} state=${mine.state ?? '(unset)'}`);
    if (hadReasons) {
      console.warn(`  WARNING: disable_reasons=${JSON.stringify(mine.disable_reasons)} — ` +
        'left untouched (editing Secure Preferences would delete the entry). ' +
        'If the content script does not run, open chrome://extensions and reload SafeScroll once.');
    }
  } else {
    console.warn(`  WARNING: SafeScroll (${SP_ID}) not in copied profile`);
  }
} else {
  console.warn('  WARNING: Secure Preferences missing from copy');
}

// ------------------------------------------------------- 3. relaunch
const urlArg = process.argv.indexOf('--url');
const startUrl = urlArg > -1 ? process.argv[urlArg + 1] : 'http://localhost:5000/test/fixture-forum.html';

console.log('launching Chrome with debugging port…');
const child = spawn(chrome, [
  '--remote-debugging-port=9222',
  `--user-data-dir=${dstRoot}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--restore-last-session=false',
  startUrl
], { detached: true, stdio: 'ignore' });
child.unref();
console.log('  profile :', dstRoot);
console.log('  cdp     : http://127.0.0.1:9222');

const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    const r = await fetch('http://127.0.0.1:9222/json/list');
    if (r.ok) {
      const t = await r.json();
      const ext = t.filter(x => (x.url || '').startsWith('chrome-extension://'));
      console.log(`READY — ${t.length} targets, ${ext.length} extension targets`);
      for (const e of ext) console.log('  ext:', e.type, e.url);
      process.exit(0);
    }
  } catch { /* retry */ }
  await new Promise(r => setTimeout(r, 500));
}
console.error('Chrome did not expose CDP on 9222 within 30s');
process.exit(1);
