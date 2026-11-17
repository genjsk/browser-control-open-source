import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import TOML from '@iarna/toml';
import { root, localDir, port, version, credentials, api } from '../bridge/config.mjs';
import { readDataDirectory } from '../bridge/paths.mjs';
import { ensureDaemon, stopDaemon } from '../bridge/client.mjs';
import { integrationInfo, installCodex, prepareDsh } from '../scripts/integration.mjs';

const exec = promisify(execFile);
test('user data paths do not depend on the application folder', () => {
  assert.equal(readDataDirectory({ root: path.join(localDir, 'moved'), env: { BROWSER_CONTROL_DATA_DIR: localDir } }), localDir);
});
test('new computers/data directories generate independent pairing keys', async () => {
  const first = await credentials();
  const secondDir = path.join(localDir, 'second-computer');
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', "import {credentials} from './bridge/config.mjs'; console.log(JSON.stringify(await credentials()));"], { cwd: root, env: { ...process.env, BROWSER_CONTROL_DATA_DIR: secondDir }, windowsHide: true });
  const second = JSON.parse(stdout);
  assert.notEqual(first.adminToken, second.adminToken);
  assert.notEqual(first.extensionToken, second.extensionToken);
});
test('manual disconnect stays off until explicit connection', async () => {
  await ensureDaemon({ explicit: true });
  assert.equal((await api('/status')).version, version);
  await stopDaemon({ manual: true });
  await assert.rejects(ensureDaemon(), /手动断开/);
  await ensureDaemon({ explicit: true });
  assert.equal((await api('/status')).version, version);
  await stopDaemon({ manual: true });
});
test('generated MCP/DSH integration preserves other client settings', async () => {
  const fakeHome = path.join(localDir, 'fake-client');
  await mkdir(fakeHome, { recursive: true });
  process.env.CODEX_HOME = fakeHome;
  const file = path.join(fakeHome, 'config.toml');
  await writeFile(file, '# keep this comment\nmodel = "example-model"\n[mcp_servers.other]\ncommand = "example"\n');
  const info = await integrationInfo();
  assert.match(info.pairingCode, /^bc1:\d+:[a-f0-9]{64}$/);
  await installCodex();
  await installCodex();
  const content = await readFile(file, 'utf8');
  const parsed = TOML.parse(content);
  assert.ok(content.includes('# keep this comment'));
  assert.equal(parsed.mcp_servers.other.command, 'example');
  assert.equal((content.match(/\[mcp_servers.browser_control\]/g) || []).length, 1);
  const dsh = await prepareDsh();
  const patch = JSON.parse(await readFile(path.join(dsh.directory, 'cordis.patch.yml'), 'utf8'));
  assert.deepEqual(patch[0].insert[0].config.args, info.mcp.mcpServers.browser_control.args);
  assert.ok(!JSON.stringify(patch).includes(info.pairingCode));
  await writeFile(file, '[mcp_servers.browser_control]\ncommand="existing-client"\n');
  await assert.rejects(installCodex(), /另一个/);
  assert.equal(TOML.parse(await readFile(file, 'utf8')).mcp_servers.browser_control.command, 'existing-client');
});
test('stable MCP entry survives moving the application to a Unicode/space path', async () => {
  const info = await integrationInfo();
  const moved = path.join(localDir, 'moved app 中文');
  await mkdir(moved, { recursive: true });
  for (const directory of ['bridge', 'scripts']) await cp(path.join(root, directory), path.join(moved, directory), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(moved, 'package.json'));
  // The standalone portable ZIP test below covers real copied production deps.
  // This source test uses an explicit module junction for speed.
  const { symlink } = await import('node:fs/promises');
  await symlink(path.join(root, 'node_modules'), path.join(moved, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const response = await exec(process.execPath, [path.join(moved, 'scripts', 'cli.mjs'), 'info', '--json'], { env: process.env, windowsHide: true });
  const after = JSON.parse(response.stdout);
  assert.deepEqual(after.mcp, info.mcp);
  assert.equal(JSON.parse(await readFile(path.join(localDir, 'runtime.json'), 'utf8')).root.replace(/[\\/]$/, ''), moved);
  // The panel owns the service lifecycle; start it explicitly for this client.
  assert.equal((await ensureDaemon({ explicit: true })).version, version);
  const transport = new StdioClientTransport({ ...after.mcp.mcpServers.browser_control, env: { ...process.env } });
  const client = new Client({ name: 'relocation-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 13);
  } finally { await client.close(); }
  await stopDaemon({ manual: true });
});
