// Grep dist/ for remote-code violations before packaging.
// Remote CODE (script tags, workers, dynamic imports of remote modules, eval) = violation.
// Remote DATA (model weights, .traineddata) = allowed by design.
//
// Each URL match is scanned WITH surrounding context; allowlisted patterns are
// documented dead paths or license comments. Anything NEW fails the build.
import { readFileSync } from 'node:fs';
import { walk } from './walk.mjs';

const DATA_HOSTS = ['huggingface.co', 'tessdata.projectnaptha.com'];
// Hosts that only ever appear in license comments of bundled deps — not fetchable code.
const COMMENT_HOSTS = ['github.com', 'apache.org', 'opensource.org', 'arxiv.org', 'feross.org', 'shadertoy.com', 'emscripten.org', 'developer.mozilla.org'];
// Sites the extension itself moderates — appear as permission patterns in manifest.
const SELF_HOSTS = ['x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'cdninstagram.com', 'fbcdn.net', 'twimg.com', 'ytimg.com'];

// Contextual allowlist: [regex against ±100 chars of context, justification]
const ALLOWLIST = [
  [/eval\("quire"\.replace/, 'protobufjs CommonJS require shim — dead in browser bundle'],
  [/new Function\("return this"\)/, 'globalThis fallback polyfill — dead on Chrome 109+'],
  [/workerPath:`https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js/, 'tesseract.js defaults record — overridden by local getURL workerPath (verified in bundle)'],
  [/wasmPaths=RUNNING_LOCALLY\?[^]{0,80}cdn\.jsdelivr\.net\/npm\/@xenova\/transformers/, 'transformers.js wasmPaths default — overridden by env.backends.onnx.wasm.wasmPaths = getURL(ort/) (verified in bundle)'],
  [/tesseract\.js-core@v/, 'tesseract.js core fallback default — corePath passed as local getURL (verified in bundle)'],
  [/@tesseract\.js-data\//, 'tesseract.js lang data fallback default — langPath passed explicitly; .traineddata is DATA']
];

const violations = [];

for (const file of walk('dist')) {
  if (!/\.(js|html|json|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');

  const patterns = [
    { re: /<script[^>]+src=["']https?:\/\//gi, what: 'remote <script src>', ctx: 0 },
    { re: /\beval\s*\(/g, what: 'eval()', ctx: 100 },
    { re: /new\s+Function\s*\(/g, what: 'new Function()', ctx: 100 },
    { re: /import\s*\(\s*['"`]https?:\/\//gi, what: 'dynamic import() of remote URL', ctx: 100 },
    { re: /importScripts\s*\(\s*['"`]https?:\/\//gi, what: 'importScripts of remote URL', ctx: 100 },
    { re: /workerPath\s*[:=]\s*['"`]https?:\/\//gi, what: 'remote worker script', ctx: 100 },
    { re: /corePath\s*[:=]\s*['"`]https?:\/\//gi, what: 'remote wasm core script', ctx: 100 },
    { re: /https?:\/\/[a-z0-9.-]+/gi, what: 'absolute URL (reviewed)', ctx: 100 }
  ];

  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      const start = Math.max(0, m.index - p.ctx);
      const ctx = text.slice(start, m.index + m[0].length + p.ctx);
      if (p.what.startsWith('absolute URL')) {
        const url = m[0];
        if (DATA_HOSTS.some(h => url.includes(h))) continue;               // weights / traineddata = data
        if (COMMENT_HOSTS.some(h => url.includes(h))) continue;            // license comments
        if (SELF_HOSTS.some(h => url.includes(h))) continue;               // our own scoped permissions
        if (/cdn\.jsdelivr\.net/.test(url) && !ALLOWLIST.some(([re]) => { re.lastIndex = 0; return re.test(ctx); })) {
          // jsDelivr outside a documented dead-path context = violation
        } else if (/cdn\.jsdelivr\.net/.test(url)) continue;
      }
      const allowed = ALLOWLIST.some(([re]) => { re.lastIndex = 0; return re.test(ctx); });
      if (allowed) continue;
      violations.push({ file, what: p.what, match: m[0].slice(0, 120) });
    }
  }
}

if (violations.length) {
  console.log('=== REMOTE-CODE AUDIT: VIOLATIONS FOUND ===');
  for (const v of violations) console.log(`${v.file} :: ${v.what} :: ${v.match}`);
  process.exitCode = 1;
} else {
  console.log('=== REMOTE-CODE AUDIT: CLEAN ===');
  console.log('Allowlisted dead paths (documented): protobufjs require-shim eval; globalThis new-Function polyfills; tesseract.js default worker/core/lang fallbacks (all overridden with local getURL paths); transformers.js wasmPaths default (overridden with local ort/ bundle).');
}
