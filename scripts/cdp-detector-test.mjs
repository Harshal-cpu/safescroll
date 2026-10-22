// Universal-detector verification. Loads the built extension into a real Chrome
// via CDP, opens each fixture over http://localhost (so the content script's
// host_permissions match), and asserts that the detector finds units, finds
// the right TEXT, and excludes site chrome.
//
//   node scripts/cdp-detector-test.mjs
//
// Requires a Chrome already listening on 9222 (see scripts/cdp-verify.mjs).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9222;

// ---------------------------------------------------------------- CDP client
async function targets() {
  return (await fetch(`http://localhost:${PORT}/json/list`)).json();
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const logs = [];
  /** Isolated worlds seen on this page, keyed by executionContextId. */
  const worlds = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    try { ws.send(JSON.stringify({ id: i, method, params })); }
    catch (e) { reject(e); }
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    // Content scripts run in an ISOLATED world, so window.__safescroll is NOT
    // reachable from the default (main world) evaluation context. Track the
    // extension's isolated world and evaluate inside it.
    if (m.method === 'Runtime.executionContextCreated') {
      const { id: ctxId, origin, name, auxData } = m.params.context;
      worlds.set(ctxId, { id: ctxId, origin, name, auxData });
    } else if (m.method === 'Runtime.executionContextDestroyed') {
      worlds.delete(m.params.executionContextId);
    } else if (m.method === 'Runtime.executionContextsCleared') {
      worlds.clear();
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push({ type: m.params.type, text });
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push({ type: 'exception', text: (m.params.exceptionDetails?.text || '') + ' ' + (m.params.exceptionDetails?.exception?.description || '') });
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, logs, worlds, close: () => ws.close() });
    ws.onerror = () => reject(new Error('ws error'));
  });
}

/**
 * Evaluate in the content script's isolated world when one is present,
 * otherwise in the main world. Content-script globals are only visible in the
 * isolated context, but DOM state (data-safescroll-key) is visible in both.
 */
async function evaluate(client, expression) {
  const extWorld = [...client.worlds.values()].find(w =>
    (w.origin || '').startsWith('chrome-extension://') ||
    (w.auxData?.type === 'isolated' && (w.origin || '').startsWith('chrome-extension://'))
  );
  const attempts = extWorld
    ? [{ contextId: extWorld.id, label: 'isolated' }, { label: 'main' }]
    : [{ label: 'main' }];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = await client.send('Runtime.evaluate', {
        expression,
        ...(a.contextId ? { contextId: a.contextId } : {}),
        awaitPromise: true, returnByValue: true
      });
      if (r?.exceptionDetails) {
        lastErr = new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
        continue;
      }
      return r?.result?.value;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('evaluate failed');
}

// ------------------------------------------------------------------ fixtures
const FIXTURES = [
  {
    file: 'test/fixture-x.html',
    name: 'x.com timeline (real DOM: handle/timestamp/action bar must NOT leak)',
    expect: {
      minUnits: 8,
      mustContain: [
        'transit pass sorted',                                   // plain tweet
        'Muslims are vermin',                                    // toxic tweet text
        'worthless piece of garbage',                            // quoted tweet body
        'Long thread about the new transit',                      // long tweet
        'kill yourself',                                         // short tweet (<24 chars)
        'You are vermin and nobody wants you here',              // profile bio (not a tweet)
        'You are a worthless piece of garbage'                   // direct message (not a tweet)
      ],
      // These are the sibling nodes that a naive extractor swallows. If any of
      // them appears in classifier input, the blur target and the score are
      // both wrong — this is the "mismatch" bug.
      mustNotContain: [
        '@alice', '@bob', '@carol', '@erin', '@frank', '@dave', '@short', '@spammer',
        'Repost', 'Bookmark', 'Share',
        '38 replies', '900 views', 'Follows you'
      ],
      // mustExclude: elements that must never become units at all
      mustExclude: ['@spammer', 'Suggested']
    }
  },
  {
    file: 'test/fixture-forum.html',
    name: 'forum thread (no <article>, no .g, no [role=article])',
    expect: {
      minUnits: 6,
      // Strings that MUST appear in some unit's extracted text.
      mustContain: [
        'worthless piece of garbage',        // toxic thread post
        'cockroaches infesting',            // toxic comment
        'Muslims are vermin',               // toxic thread post
        'thoughtful and balanced point'      // clean comment
      ],
      // Text that must never be captured as a unit's content.
      mustNotContain: [
        'Community rules',                  // sidebar furniture
        'Be civil. No harassment.',         // sidebar furniture
        'All rights reserved',              // footer
        'No harassment'                     // rules text
      ]
    }
  },
  {
    file: 'test/fixture-article.html',
    name: 'article + comment section (oversized unit, must split)',
    expect: {
      minUnits: 3,
      mustContain: [
        'vermin and everyone would be better off',  // toxic comment
        'Really useful summary',                    // clean comment
        'procurement issues last year'              // clean comment
      ],
      mustNotContain: []
    }
  },
  {
    file: 'test/fixture-anonymous.html',
    name: 'anonymous hashed classes (pure structural detection)',
    expect: {
      minUnits: 3,
      mustContain: [
        'Muslims are vermin',
        'weather is lovely',
        'detailed writeup'
      ],
      mustNotContain: []
    }
  },
  {
    file: 'test/search.html',
    name: 'search results (regression: the case that already worked)',
    expect: {
      minUnits: 3,
      mustContain: ['worthless piece of garbage', 'Muslims are vermin', 'weather is lovely'],
      mustNotContain: []
    }
  },
  {
    file: 'test/page.html',
    name: 'article feed (regression)',
    expect: {
      minUnits: 2,
      mustContain: ['worthless piece of garbage', 'weather is lovely'],
      mustNotContain: []
    }
  }
];

// ---------------------------------------------------------------------- run
let failures = 0;
const results = [];
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

let list = await targets();
let page = list.find(t => t.type === 'page');
if (!page) {
  console.error('No page target on 9222 — start Chrome with --remote-debugging-port=9222');
  process.exit(1);
}
const client = await connect(page.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await client.send('Page.enable');

for (const fx of FIXTURES) {
  console.log(`\n=== ${fx.name} ===`);
  const url = `http://localhost:5000/${fx.file.split('/').pop()}`;
  await client.send('Page.navigate', { url });
  await sleep(4000); // load + observers + a beat for the late-injected node

  let probe;
  try {
    probe = await evaluate(client, `(() => {
      const s = window.__safescroll;
      const tracked = document.querySelectorAll('[data-safescroll-key]');
      if (!s) return JSON.stringify({ error: 'content script not injected', tracked: tracked.length });
      return JSON.stringify({
        stats: s.stats,
        shields: s.shields(),
        tracked: tracked.length,
        // classifier input only — NOT textContent, which still has chrome
        texts: s.texts ? s.texts() : [],
        allText: (s.texts ? s.texts() : []).map(u => u.text).join(' \\n ')
      });
    })()`);
  } catch (e) {
    check('probe', false, String(e));
    continue;
  }

  const data = JSON.parse(probe);
  if (data.error) { check('content script injected', false, data.error); continue; }
  check('content script injected', true);

  const e = fx.expect;
  check(`detected units (>=${e.minUnits})`, data.tracked >= e.minUnits,
    `tracked=${data.tracked} units=${data.stats.units} site=${data.stats.siteId}`);

  for (const needle of e.mustContain) {
    check(`captures text: "${needle.slice(0, 42)}"`, data.allText.includes(needle));
  }
  for (const needle of e.mustNotContain) {
    check(`excludes chrome: "${needle.slice(0, 32)}"`, !data.allText.includes(needle),
      data.allText.includes(needle) ? 'LEAKED into classifier input' : '');
  }
  for (const needle of e.mustExclude ?? []) {
    const hit = (data.texts || []).some(u => (u.text || '').includes(needle));
    check(`not treated as a unit: "${needle}"`, !hit, hit ? 'became a unit' : '');
  }

  const errors = client.logs.filter(l => l.type === 'exception' || l.type === 'error');
  check('no page exceptions', errors.length === 0, errors.slice(0, 3).map(x => x.text.slice(0, 120)).join(' | '));

  results.push({ fixture: fx.name, tracked: data.tracked, stats: data.stats });
  client.logs.length = 0;
}

client.close();
console.log('\n================ SUMMARY ================');
for (const r of results) {
  console.log(`${String(r.tracked).padStart(3)} units  ${r.fixture}`);
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL DETECTOR CHECKS PASSED');
process.exit(failures ? 1 : 0);
