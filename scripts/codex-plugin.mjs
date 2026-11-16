import { cp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { root, localDir, version, writeJson } from '../bridge/config.mjs';
import { aiInstances, registerRuntime } from './integration.mjs';

const execute = promisify(execFile);
export const pluginName = 'browser-control';
export const marketplaceName = 'browser-control-local';
export const pluginSelector = `${pluginName}@${marketplaceName}`;
function quote(value) {
  return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export function findCodex(env = process.env) {
  const explicit = env.BROWSER_CONTROL_CODEX_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit.endsWith('.js') ? { command: process.execPath, args: [explicit] } : { command: explicit, args: [] };
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (env.APPDATA) directories.push(path.join(env.APPDATA, 'npm'));
  for (const directory of [...new Set(directories)]) {
    const executable = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(executable)) return { command: executable, args: [] };
    for (const script of [path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path.join(directory, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) {
      if (existsSync(script)) return { command: process.execPath, args: [script] };
    }
  }
  throw new Error('未找到支持插件的 Codex CLI。插件文件已生成，可在 Codex 添加本地插件市场，或安装 Codex CLI 后重试。');
}
export async function prepareCodexPlugin() {
  const { instance, ...entry } = await registerRuntime(aiInstances.codexNative);
  const marketplaceDir = path.join(localDir, 'codex-plugin-marketplace');
  const directory = path.join(marketplaceDir, 'plugins', pluginName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(path.join(root, 'integrations', 'codex'), directory, { recursive: true });
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await copyFile(path.join(root, 'assets', 'browser-control-128.png'), path.join(directory, 'assets', 'icon.png'));
  for (const manifest of ['plugin.json', path.join('.codex-plugin', 'plugin.json')]) {
    const file = path.join(directory, manifest);
    const data = JSON.parse(await readFile(file, 'utf8'));
    await writeJson(file, { ...data, version });
  }
  await writeJson(path.join(directory, 'local-runtime.json'), { dataDir: localDir, instance: aiInstances.codexNative.id });
  await writeJson(path.join(directory, 'mcp.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { browser_control_native: { type: 'stdio', ...entry } }
  });
  await writeJson(path.join(directory, '.mcp.json'), { mcpServers: { browser_control_native: entry } });
  const catalogDir = path.join(marketplaceDir, '.agents', 'plugins');
  await mkdir(catalogDir, { recursive: true });
  await writeJson(path.join(catalogDir, 'marketplace.json'), {
    name: marketplaceName, interface: { displayName: 'Browser Control 本地插件' },
    plugins: [{ name: pluginName, source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
  });
  return { directory, marketplaceDir, plugin: pluginSelector, instance,
    command: `codex plugin marketplace add ${quote(marketplaceDir)}\ncodex plugin add ${pluginSelector}`,
    message: 'Codex 本地插件已生成，exe、浏览器扩展和本地服务继续保留。' };
}
export async function runCodex(arguments_, { env = process.env } = {}) {
  const executable = findCodex(env);
  try {
    const { stdout } = await execute(executable.command, [...executable.args, ...arguments_], {
      env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Codex 插件操作失败：${error.stderr?.trim() || error.message}`);
  }
}
async function removeOwnedLegacyConfig() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  let original;
  try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const start = '# browser-control: managed configuration begin', end = '# browser-control: managed configuration end';
  const first = original.indexOf(start), last = original.indexOf(end);
  if (first < 0 || last < first) return false;
  // Codex may insert other tables before our trailing comment. Remove only our
  // server table, not everything between the ownership comments.
  const section = /^[ \t]*\[mcp_servers\.browser_control\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(original);
  if (!section || section.index < first || section.index > last) return false;
  const afterHeader = section.index + section[0].length;
  // Also remove our owned sub-tables (for example browser_control.env) before
  // stopping at the next unrelated table.
  const header = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?$/gm;
  header.lastIndex = afterHeader;
  let stop = original.length;
  for (let match = header.exec(original); match; match = header.exec(original)) {
    if (!match[1].trim().startsWith('mcp_servers.browser_control.')) { stop = match.index; break; }
  }
  const withoutServer = original.slice(0, section.index) + original.slice(stop);
  const changed = withoutServer.split('\n').filter(line => ![start, end].includes(line.trim())).join('\n');
  TOML.parse(changed.replace(/^\uFEFF/, ''));
  const backups = path.join(localDir, 'client-config-backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await copyFile(file, path.join(backups, `codex-before-plugin-${Date.now()}.toml`));
  await writeFile(file, changed, { mode: 0o600 });
  return true;
}
export async function installCodexPlugin() {
  const prepared = await prepareCodexPlugin();
  await runCodex(['plugin', 'marketplace', 'add', prepared.marketplaceDir, '--json']);
  const installed = await runCodex(['plugin', 'add', pluginSelector, '--json']);
  const list = await runCodex(['plugin', 'list', '--json']);
  if (!list.installed?.some(item => item.pluginId === pluginSelector && item.installed && item.enabled)) {
    throw new Error('Codex 尚未确认插件已启用，请在插件列表检查浏览器控制插件。');
  }
  const legacyRemoved = await removeOwnedLegacyConfig();
  return { ...prepared, installed: true, result: installed, legacyRemoved,
    message: '已安装 Codex 浏览器控制插件。请重启 Codex 或新建会话；原 exe 和本地服务继续使用。' };
}
