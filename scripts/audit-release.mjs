import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const source = !process.argv[2];
const ignored = new Set(['.git', '.local', '.npm-cache', 'node_modules', 'release', 'dist', 'test-results', '__pycache__']);
const problems = [];
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (source && ignored.has(item.name)) continue;
    const file = path.join(directory, item.name);
    const rel = path.relative(root, file);
    if (item.isDirectory()) {
      if (!source && ['.local', '.git', 'test-results', '__pycache__'].includes(item.name)) problems.push(`${rel}: private/build directory`);
      // Production dependency licenses stay in the portable package; their upstream
      // source/binary internals are outside this project's source-content scan.
      if (item.name !== 'node_modules' && item.name !== '_internal') await scan(file);
      continue;
    }
    if (/^credentials.*\.json$|^disabled-\d+$|^ai-token-.*\.json$|^ai-instances\.json$|^browser-routing-\d+\.json$|^identity-\d+\.json$|^storage-location\.json$|\.lnk$|^runtime\.json$|^settings\.json$/.test(item.name)) problems.push(`${rel}: local state file`);
    if (/\.(mjs|cjs|js|json|py|md|ya?ml|toml|cmd|sh|txt)$/.test(item.name)) {
      const text = await readFile(file, 'utf8');
      // Match actual secret VALUES, not variable/schema names.
      if (/"(?:adminToken|extensionToken)"\s*:\s*"[a-f0-9]{64}"/.test(text)) problems.push(`${rel}: private pairing credentials`);
      const user = os.userInfo().username;
      if (/[A-Z]:[\\/](?:Users|系统文件夹)[\\/]/i.test(text) || (user.length >= 5 && text.includes(user))) problems.push(`${rel}: private machine/account reference`);
      if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) problems.push(`${rel}: private key`);
    }
  }
}
await scan(root);
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log('Release audit passed: no local credentials, profiles or private machine references.');
