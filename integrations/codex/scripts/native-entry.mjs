import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  const { dataDir } = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'local-runtime.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
  process.env.BROWSER_CONTROL_DATA_DIR = dataDir;
  await import(pathToFileURL(path.join(runtime.root, 'bridge', 'entry.mjs')).href);
} catch {
  console.error('请先在本地 Browser Control 面板中点击“接入 AI → 安装到 Codex”，然后重启 Codex 会话。');
  process.exitCode = 1;
}
