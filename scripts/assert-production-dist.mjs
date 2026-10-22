import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = join(projectRoot, 'dist');
const popupPath = join(distRoot, 'src', 'popup', 'popup.html');
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
} else if (!existsSync(popupPath)) {
  fail('dist/src/popup/popup.html is missing. The production extension is incomplete.');
} else {
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
