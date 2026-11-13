import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.local'), { recursive: true });
const dataDir = await mkdtemp(path.join(root, '.local', 'test-data-'));
const browser = process.argv.includes('--browser');
const args = browser ? [path.join(root, 'tests', 'browser.mjs')] : ['--test', 'tests/bridge.test.mjs', 'tests/portable.test.mjs', 'tests/paths.test.mjs', 'tests/migration.test.mjs', 'tests/codex-plugin.test.mjs'];
const child = spawn(process.execPath, args, {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, BROWSER_CONTROL_DATA_DIR: dataDir, BROWSER_BRIDGE_PORT: browser ? '19517' : '19543' }
});
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
