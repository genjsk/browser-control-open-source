import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

try {
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  const { dataDir } = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'local-runtime.json'), 'utf8'));
  const { root } = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
  const command = process.argv[2] || 'info';
  const node = path.join(dataDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const executable = path.join(root, 'BrowserControl.exe');
  if (command === 'info') {
    console.log(JSON.stringify({ applicationDir: root, dataDir, node, executable, extensionDir: path.join(root, 'extension') }));
  } else if (command === 'open-panel') {
    if (process.platform !== 'win32' || !fs.existsSync(executable)) throw new Error('当前安装没有 Windows 控制面板，请从完整便携包运行 exe，或使用本地 CLI。');
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    console.log(JSON.stringify({ opened: true }));
  } else {
    throw new Error('Commands: info, open-panel。服务和浏览器配对只能由用户在 Browser Control 控制面板中连接、断开或重启。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
