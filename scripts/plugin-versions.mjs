import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localDir, port, version } from '../bridge/config.mjs';
import { pluginSelector, runCodex } from './codex-plugin.mjs';

const minimum = '1.2.0'; // First release with a separate AI instance identity and port check.

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

function semver(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
  return match ? { number: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] } : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.number[index] !== right.number[index]) return left.number[index] - right.number[index];
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let index = 0; index < Math.min(left.pre.length, right.pre.length); index++) {
    const a = left.pre[index], b = right.pre[index];
    if (a === b) continue;
    const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
    if (numericA && numericB) return Number(a) - Number(b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}

function launchMismatch(launch) {
  const launcher = launch?.args?.find?.(arg => typeof arg === 'string' && path.basename(arg) === 'mcp-launcher.cjs');
  const configuredPort = Number(launch?.env?.BROWSER_BRIDGE_PORT);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort !== port) {
    return '插件使用的端口与本次安装不同。';
  }
  if (launcher && path.isAbsolute(launcher) && path.relative(localDir, path.dirname(launcher))) {
    return '插件指向另一个数据目录。';
  }
  return '';
}

export function classify(installed, mismatch = '') {
  const current = semver(installed);
  if (!current) return { state: 'unknown', reason: '无法确认已安装插件的版本。' };
  const order = compare(current, semver(version));
  // A newer install should not be silently downgraded, even when it needs reconfiguration.
  if (order > 0) return { state: mismatch ? 'newer-mismatch' : 'newer', reason: mismatch };
  if (compare(current, semver(minimum)) < 0) return { state: 'required', reason: '旧插件缺少当前服务要求的 AI 接入身份。' };
  if (mismatch) return { state: 'required', reason: mismatch };
  return { state: order === 0 ? 'current' : 'available', reason: '' };
}

async function codexVersion() {
  const result = { client: 'codex', label: 'Codex' };
  try {
    const list = await runCodex(['plugin', 'list', '--json']);
    const installed = list.installed?.find(item => item.pluginId === pluginSelector && item.installed);
    if (!installed) return { ...result, state: 'missing', reason: '未安装 Browser Control 原生插件。' };
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const cached = typeof installed.version === 'string' && /^[\w.+-]+$/.test(installed.version)
      ? path.join(home, 'plugins', 'cache', 'browser-control-local', 'browser-control', installed.version)
      : null;
    const mcp = cached ? await readJson(path.join(cached, '.mcp.json')) : null;
    const status = classify(installed.version, launchMismatch(mcp?.mcpServers?.browser_control_native));
    return { ...result, version: installed.version, ...status,
      reason: status.reason || (installed.enabled === false ? '插件已停用，可在 Codex 中重新启用。' : '') };
  } catch {
    return { ...result, state: 'unknown', reason: '未能通过 Codex CLI 核对已安装插件。' };
  }
}

async function dshVersions() {
  const homes = process.env.DSH_HOME ? [process.env.DSH_HOME] :
    [path.join(os.homedir(), '.dsh'), ...['DSH', 'DeepSeek Harness'].map(name => path.join(process.env.APPDATA || os.homedir(), name))];
  const rows = [];
  for (const home of new Set(homes.flatMap(home => [home, path.join(home, '.dsh')]))) {
    for (const profile of ['desktop', 'web']) {
      const directory = path.join(home, 'profiles', profile);
      const config = await readJson(path.join(directory, 'package.json'));
      if (!config) continue;
      const result = { client: 'dsh', label: `DSH ${profile === 'desktop' ? 'Desktop' : 'Web'}` };
      const dependency = config.dependencies?.['dsh-browser-control'];
      if (!dependency) {
        rows.push({ ...result, state: 'missing', reason: '此配置未登记 Browser Control 插件。' });
        continue;
      }
      const linked = /^(?:link|file):(.+)$/.exec(dependency || '')?.[1];
      const candidates = [path.join(directory, 'node_modules', 'dsh-browser-control')];
      if (linked) candidates.push(path.resolve(directory, linked));
      let plugin, root;
      for (const candidate of candidates) {
        const manifest = await readJson(path.join(candidate, 'package.json'));
        if (manifest?.name === 'dsh-browser-control') { plugin = manifest; root = candidate; break; }
      }
      if (plugin) {
        const patch = await readJson(path.join(root, 'cordis.patch.yml'));
        const launch = Array.isArray(patch) ? patch.flatMap(item => item.insert || []).find(item => item.id === 'mcp-browser-control')?.config : null;
        rows.push({ ...result, version: plugin.version, ...classify(plugin.version, launchMismatch(launch)) });
      } else if (dependency && linked && !existsSync(candidates.at(-1))) {
        rows.push({ ...result, state: 'required', reason: 'DSH 登记的本地插件目录已不存在。' });
      } else {
        rows.push({ ...result, state: 'unknown', reason: '已登记插件，但无法读取已安装版本。' });
      }
    }
  }
  return rows.length ? rows : [{ client: 'dsh', label: 'DSH', state: 'unknown', reason: '未找到可核对的 DSH 客户端配置。' }];
}

if (process.argv[1] && path.basename(process.argv[1]) === 'plugin-versions.mjs') {
  const [codex, dsh] = await Promise.all([codexVersion(), dshVersions()]);
  console.log(JSON.stringify({ version, plugins: [codex, ...dsh] }));
}
