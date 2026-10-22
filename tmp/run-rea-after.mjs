import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const node = 'C:\\Users\\Harsh\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe';
const rea = 'C:\\Users\\Harsh\\AppData\\Local\\npm-cache\\_npx\\dea9475797100b20\\node_modules\\rea-agents\\scripts\\rea.mjs';
const child = spawn(node, [rea, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buffer = '';
let errors = '';
child.stderr.on('data', chunk => { errors += chunk.toString(); });
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line.startsWith('{')) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
function call(id, method, params) {
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const timeout = setTimeout(() => { console.error('REA timed out', errors.slice(-2000)); child.kill(); process.exit(1); }, 300000);
try {
  const init = await call(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'safescroll-audit', version: '1.0' }
  });
  if (init.error) throw new Error(JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await call(2, 'tools/call', {
    name: 'analyze_javascript_application',
    arguments: {
      input_path: 'D:\\safescroll - Copy\\dist',
      format: 'directory', detail: 'summary', analysis_timeout_ms: 240000
    }
  });
  if (result.error || result.result?.isError) throw new Error(JSON.stringify(result.error ?? result.result));
  writeFileSync('tmp/rea-analysis-after.json', JSON.stringify(result));
  const view = JSON.parse(result.result.content.find(item => item.type === 'text').text);
  console.log(JSON.stringify(view.normalized_result?.summary?.statistics ?? view.normalized_result?.summary ?? view, null, 2));
} catch (error) {
  console.error(error);
  console.error(errors.slice(-2000));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
}
