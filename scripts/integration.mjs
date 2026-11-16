import { access, copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import TOML from '@iarna/toml';
import { credentials, root, localDir, port, version, writeJson } from '../bridge/config.mjs';
import { registerInstance, instanceView } from '../bridge/instances.mjs';
// Stable identities for every AI integration this project can install. The id
// is written into the generated launcher environment and persisted with the
// installed record; it is not a credential.
export const aiInstances = {
  generic: { id: 'generic-mcp', client: '通用 MCP 客户端', name: '通用 MCP 配置', transport: 'MCP stdio' },
  codexMcp: { id: 'codex-mcp', client: 'Codex', name: 'Codex MCP 配置', transport: 'MCP stdio' },
  codexNative: { id: 'codex-native', client: 'Codex', name: 'Codex 原生插件', transport: 'MCP stdio（原生）' },
  dsh: { id: 'dsh', client: 'DeepSeek Harness', name: 'DSH 插件', transport: 'MCP stdio（Cordis）' }
};

const launcherSource = `// Generated locally by Browser Control. No credentials are stored here.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime.json'), 'utf8'));
process.env.BROWSER_CONTROL_DATA_DIR = __dirname;
const entry = path.join(runtime.root, 'bridge', 'mcp.mjs');
if (!fs.existsSync(entry)) throw new Error('Browser Control moved. Open it in the new folder and click Connect.');
import(pathToFileURL(entry).href).catch(error => { console.error(error.message); process.exit(1); });
`;

export async function registerRuntime(instance = aiInstances.generic) {
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const node = path.join(localDir, process.platform === 'win32' ? 'node.exe' : 'node');
  let previous;
  try { previous = JSON.parse(await readFile(path.join(localDir, 'runtime.json'), 'utf8')); } catch {}
  if (!existsSync(node) || previous?.nodeVersion !== process.version) await copyFile(process.execPath, node);
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await chmod(node, 0o700);
  }
  await writeJson(path.join(localDir, 'runtime.json'), { root, nodeVersion: process.version });
  const launcher = path.join(localDir, 'mcp-launcher.cjs');
  await writeFile(launcher, launcherSource, { mode: 0o600 });
  const { entry } = await registerInstance({ ...instance, servicePort: port });
  // The port and the instance identity are explicit so the local service can
  // verify every call against its own configuration.
  const launch = { command: node, args: [launcher], env: { BROWSER_BRIDGE_PORT: String(port), BROWSER_CONTROL_AI_INSTANCE: instance.id } };
  return { ...launch, instance: instanceView(entry) };
}

export async function integrationInfo() {
  const { instance, ...entry } = await registerRuntime(aiInstances.generic);
  const { extensionToken } = await credentials();
  return { port, dataDir: localDir, extensionDir: path.join(root, 'extension'),
    pairingCode: `bc1:${port}:${extensionToken}`, instance, mcp: { mcpServers: { browser_control: entry } } };
}

export async function installCodex() {
  const { instance, ...entry } = await registerRuntime(aiInstances.codexMcp);
  const directory = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(directory, 'config.toml');
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  TOML.parse(existing.replace(/^\uFEFF/, ''));
  const start = '# browser-control: managed configuration begin';
  const end = '# browser-control: managed configuration end';
  const startAt = existing.indexOf(start), endAt = existing.indexOf(end);
  if ((startAt < 0) !== (endAt < 0) || (startAt >= 0 && endAt < startAt)) throw new Error('已有配置标记不完整，请手动检查，原文件未修改。');
  const owned = startAt >= 0;
  const rest = owned ? existing.slice(0, startAt) + existing.slice(endAt + end.length) : existing;
  const parsed = TOML.parse(rest.replace(/^\uFEFF/, ''));
  if (parsed.mcp_servers?.browser_control) throw new Error('已有另一个 browser_control 配置，请先在 AI 客户端移除旧版，或手动导入新的 JSON。原设置未修改。');
  const env = Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
  const section = `${start}\n[mcp_servers.browser_control]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 40\n\n[mcp_servers.browser_control.env]\n${env}\n${end}\n`;
  const updated = `${rest.trimEnd()}\n\n${section}`.trimStart();
  TOML.parse(updated.replace(/^\uFEFF/, ''));
  await mkdir(directory, { recursive: true });
  if (existing && existing !== updated) {
    const backups = path.join(localDir, 'client-config-backups');
    await mkdir(backups, { recursive: true, mode: 0o700 });
    await copyFile(file, path.join(backups, `codex-config-${Date.now()}.toml`));
  }
  await writeFile(file, updated, { mode: 0o600 });
  return { installed: true, instance, message: '已添加本地 MCP 配置。重启支持该配置的桌面客户端，再新建本地会话。' };
}
export async function prepareDsh() {
  const { instance, ...entry } = await registerRuntime(aiInstances.dsh);
  const directory = path.join(localDir, 'dsh-plugin');
  await mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, 'package.json'), {
    name: 'dsh-browser-control', version, private: true, license: 'MIT',
    description: 'Browser Control local MCP tools', dsh: { bundle: { patch: './cordis.patch.yml' } }
  });
  await writeFile(path.join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'mcp-browser-control', name: '@deepseek-ai/dsh-mcp-client',
    config: { ...entry, serverName: 'browser_control', transport: 'stdio', toolCallTimeoutMs: 40000, failOnStartupError: false }
  }] }], null, 2));
  return { directory, instance, command: `dsh plugin --profile web add ${JSON.stringify(directory)}` };
}
