import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { appRoot as root } from '../bridge/paths.mjs';
let failed = false;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.local', 'release', 'dist', '.git', 'test-results', '__pycache__'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status) { failed = true; console.error(result.stderr); }
    } else if (entry.name.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
    else if (entry.name.endsWith('.cmd') && /(?<!\r)\n/.test(await readFile(file, 'utf8'))) {
      failed = true; console.error(`Use CRLF in ${file}`);
    }
  }
}
await scan(root);
if (failed) process.exitCode = 1;
else console.log('JavaScript, JSON and Windows launcher checks passed.');
