import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = join(projectRoot, 'dist');
const manifestPath = join(distRoot, 'manifest.json');
const popupPath = join(distRoot, 'src', 'popup', 'popup.html');
const stableContentResources = [
  'assets/content.js-*.js',
  'assets/messages-*.js',
  'assets/mediaFingerprint-*.js',
  'assets/profiles-*.js'
];
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs']);
const devSignatures = [
  ['CRXJS development readiness endpoint', /@crx\/dev-ready/],
  ['localhost Vite server', /(?:https?:\/\/)?localhost:5000/],
  ['Vite client bootstrap', /\/@vite\/client/],
  ['CRXJS development loading page', /Vite Dev Server is not available|loading-page-[\w-]+\.js/]
];

function fail(message) {
  console.error(`[verify:dist] ${message}`);
  process.exitCode = 1;
}

function collectTextFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTextFiles(path));
    else if (textExtensions.has(extname(entry.name).toLowerCase()) && statSync(path).size <= 8 * 1024 * 1024) files.push(path);
  }
  return files;
}

if (!existsSync(distRoot)) {
  fail('dist is missing. Run `npm run build` before loading the extension.');
} else if (!existsSync(manifestPath)) {
  fail('dist/manifest.json is missing. The production extension is incomplete.');
} else if (!existsSync(popupPath)) {
  fail('dist/src/popup/popup.html is missing. The production extension is incomplete.');
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const stableAccess = (manifest.web_accessible_resources ?? []).some(entry =>
    stableContentResources.every(resource => entry.resources?.includes(resource)) &&
    ['http://*/*', 'https://*/*'].every(match => entry.matches?.includes(match))
  );
  if (!stableAccess) fail('Content bundles need stable web-accessible patterns across rebuilds.');
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const loaderPath of contentScript.js ?? []) {
      if (!existsSync(join(distRoot, loaderPath))) {
        fail(`Content script ${loaderPath} is missing from dist.`);
        continue;
      }
      const loader = readFileSync(join(distRoot, loaderPath), 'utf8');
      const bundlePath = loader.match(/chrome\.runtime\.getURL\("([^"]+)"\)/)?.[1];
      if (!bundlePath) continue; // A direct content script needs no web-accessible bundle.
      const accessible = (manifest.web_accessible_resources ?? []).some(entry =>
        entry.resources?.includes(bundlePath) &&
        contentScript.matches?.every(match => entry.matches?.includes(match))
      );
      if (!existsSync(join(distRoot, bundlePath)) || !accessible) {
        fail(`Content bundle ${bundlePath} must exist and be web accessible to every content-script match.`);
      }
    }
  }
  const files = collectTextFiles(distRoot);
  let matches = 0;

  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const [label, pattern] of devSignatures) {
      if (!pattern.test(source)) continue;
      matches += 1;
      fail(`${relative(projectRoot, path)} contains ${label}. Rebuild production dist and do not load a Vite development bundle.`);
    }
  }

  if (matches === 0) {
    console.log(`[verify:dist] Production extension verified (${files.length} text files; no development-server references).`);
  }
}
