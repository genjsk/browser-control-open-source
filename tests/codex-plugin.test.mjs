import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import TOML from '@iarna/toml';

const execute = promisify(execFile);
process.env.BROWSER_CONTROL_DATA_DIR = path.join(process.env.BROWSER_CONTROL_DATA_DIR, 'codex-native');
process.env.BROWSER_BRIDGE_PORT = '19548';
const { root, localDir, version, disabledFile } = await import('../bridge/config.mjs');
const { prepareCodexPlugin, installCodexPlugin, runCodex, findCodex, pluginSelector } = await import('../scripts/codex-plugin.mjs');
const { installCodex } = await import('../scripts/integration.mjs');
const { stopDaemon } = await import('../bridge/client.mjs');
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('native plugin declares desktop execution and shares the local runtime without bundling secrets or another exe', async () => {
  const prepared = await prepareCodexPlugin();
  const manifest = await json(path.join(prepared.directory, 'plugin.json'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.extensions['com.openai'].requires_local_executor, true);
  const modern = await json(path.join(prepared.directory, 'mcp.json'));
  const legacy = await json(path.join(prepared.directory, '.mcp.json'));
  const entry = modern.mcpServers.browser_control_native;
  assert.equal(entry.command, path.join(localDir, process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.deepEqual(entry.args, legacy.mcpServers.browser_control_native.args);
  assert.equal(entry.type, 'stdio');
  assert.equal((await stat(path.join(prepared.directory, 'assets', 'icon.png'))).isFile(), true);
  assert.equal(existsSync(path.join(prepared.directory, 'BrowserControl.exe')), false);
  assert.equal(existsSync(path.join(prepared.directory, 'credentials-19548.json')), false);
  const result = await execute(entry.command, [path.join(prepared.directory, 'scripts', 'control.mjs'), 'info'], { windowsHide: true });
  const info = JSON.parse(result.stdout);
  assert.equal(info.dataDir, localDir);
  assert.equal(path.resolve(info.applicationDir), path.resolve(root));
});

test('native MCP exposes all browser tools and honors manual disconnection', async () => {
  await stopDaemon({ manual: true });
  const prepared = await prepareCodexPlugin();
  const config = await json(path.join(prepared.directory, 'mcp.json'));
  const client = new Client({ name: 'native-plugin-test', version: '1' });
  const transport = new StdioClientTransport({ ...config.mcpServers.browser_control_native, env: { ...process.env } });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 13);
    const result = await client.callTool({ name: 'browser_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /手动断开/);
    assert.ok(existsSync(disabledFile));
  } finally { await client.close(); }
});

let codexAvailable = true;
try { findCodex(); } catch { codexAvailable = false; }
test('Codex installs and enables the plugin, preserves other settings and safely replaces only the owned legacy MCP block', { skip: !codexAvailable }, async () => {
  const home = path.join(path.dirname(localDir), 'isolated-native-codex');
  await mkdir(home, { recursive: true });
  process.env.CODEX_HOME = home;
  const config = path.join(home, 'config.toml');
  await writeFile(config, '# preserved settings\n[mcp_servers.other]\ncommand="unrelated-server"\n');
  await installCodex();
  const installed = await installCodexPlugin();
  assert.equal(installed.installed, true);
  assert.equal(installed.legacyRemoved, true);
  const list = await runCodex(['plugin', 'list', '--json']);
  assert.ok(list.installed.some(item => item.pluginId === pluginSelector && item.enabled));
  const parsed = TOML.parse(await readFile(config, 'utf8'));
  assert.equal(parsed.mcp_servers.other.command, 'unrelated-server');
  assert.equal(parsed.mcp_servers.browser_control, undefined);
  const cached = await json(path.join(installed.result.installedPath, '.mcp.json'));
  assert.equal(cached.mcpServers.browser_control_native.command, path.join(localDir, process.platform === 'win32' ? 'node.exe' : 'node'));
  const again = await installCodexPlugin();
  assert.equal(again.installed, true);
  assert.equal(again.legacyRemoved, false);
  assert.equal(TOML.parse(await readFile(config, 'utf8')).mcp_servers.other.command, 'unrelated-server');
});

test('reinstalling after storage migration refreshes the registered marketplace and cached runtime paths', { skip: !codexAvailable }, async () => {
  const { migrateStorage } = await import('../scripts/storage-migration.mjs');
  const moved = path.join(path.dirname(localDir), 'codex-native-moved');
  await migrateStorage({ source: localDir, target: moved, root: path.join(path.dirname(localDir), 'native-migration-app') });
  const { stdout } = await execute(process.execPath, [path.join(root, 'scripts', 'cli.mjs'), 'install-codex-plugin', '--json'], {
    windowsHide: true, env: { ...process.env, BROWSER_CONTROL_DATA_DIR: moved }
  });
  const installed = JSON.parse(stdout);
  assert.equal(installed.installed, true);
  assert.equal(existsSync(localDir), false);
  const cached = await json(path.join(installed.result.installedPath, '.mcp.json'));
  assert.equal(cached.mcpServers.browser_control_native.command, path.join(moved, process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.ok((await runCodex(['plugin', 'list', '--json'])).installed.some(item => item.pluginId === pluginSelector && item.enabled));
});
