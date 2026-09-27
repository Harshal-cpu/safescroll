// Builds dist-test/: a copy of dist/ with manifest patched to allow
// http://localhost:5000/* (host permission + content script match) for
// automated end-to-end verification via CDP.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

if (!existsSync('dist/manifest.json')) {
  console.error('dist/ not built — run npm run build first');
  process.exit(1);
}
rmSync('dist-test', { recursive: true, force: true });
cpSync('dist', 'dist-test', { recursive: true });

const m = JSON.parse(readFileSync('dist-test/manifest.json', 'utf8'));
m.host_permissions.push('http://localhost:5000/*');
m.content_scripts[0].matches.push('http://localhost:5000/*');
writeFileSync('dist-test/manifest.json', JSON.stringify(m, null, 2));
console.log('dist-test ready: localhost:5000 permissions + content script added');
