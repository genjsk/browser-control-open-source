import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';

const dataDir = await mkdtemp(path.join(tmpdir(), 'browser-control-integration-'));
process.env.BROWSER_CONTROL_DATA_DIR = dataDir;
process.env.BROWSER_BRIDGE_PORT = '19551';
process.env.CODEX_HOME = path.join(dataDir, 'codex-home');
const { integrationInfo, installCodex, prepareDsh, aiInstances } = await import('../scripts/integration.mjs');
const { prepareCodexPlugin } = await import('../scripts/codex-plugin.mjs');
const { listInstances, setInstancePaused } = await import('../bridge/instances.mjs');
const { credentials } = await import('../bridge/config.mjs');

test.after(async () => { await rm(dataDir, { recursive: true, force: true }); });

test('每次生成的 AI 接入配置只携带实例身份，不携带配对凭证', async () => {
  const info = await integrationInfo();
  assert.equal(info.instance.id, aiInstances.generic.id);
  const dsh = await prepareDsh();
  const patch = JSON.parse(await readFile(path.join(dsh.directory, 'cordis.patch.yml'), 'utf8'));
  const config = patch[0].insert[0].config;
  assert.equal(config.env.BROWSER_CONTROL_AI_INSTANCE, aiInstances.dsh.id);
  assert.equal(config.env.BROWSER_BRIDGE_PORT, '19551');
  assert.deepEqual(config.args, info.mcp.mcpServers.browser_control.args);
  const native = await prepareCodexPlugin();
  const nativeMcp = JSON.parse(await readFile(path.join(native.directory, 'mcp.json'), 'utf8'));
  const nativeEntry = nativeMcp.mcpServers.browser_control_native;
  assert.equal(nativeEntry.env.BROWSER_CONTROL_AI_INSTANCE, aiInstances.codexNative.id);
  const runtime = JSON.parse(await readFile(path.join(native.directory, 'local-runtime.json'), 'utf8'));
  assert.equal(runtime.instance, aiInstances.codexNative.id);
  await installCodex();
  const toml = TOML.parse(await readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));
  const codexEntry = toml.mcp_servers.browser_control;
  assert.equal(codexEntry.env.BROWSER_CONTROL_AI_INSTANCE, aiInstances.codexMcp.id);
  const keys = await credentials();
  for (const text of [JSON.stringify(patch), JSON.stringify(nativeMcp), JSON.stringify(toml)]) {
    assert.ok(!text.includes(keys.adminToken));
    assert.ok(!text.includes(keys.extensionToken));
    assert.ok(!text.includes('bc1:'));
  }
  const ids = (await listInstances()).map(entry => entry.id);
  for (const entry of Object.values(aiInstances)) assert.ok(ids.includes(entry.id), `${entry.id} 未注册`);
});

test('暂停状态由脚本生成的配置继承，重装配置不会清除暂停', async () => {
  await setInstancePaused(aiInstances.dsh.id, true);
  const dsh = await prepareDsh();
  assert.equal(dsh.instance.status, 'paused');
  const patch = JSON.parse(await readFile(path.join(dsh.directory, 'cordis.patch.yml'), 'utf8'));
  assert.equal(patch[0].insert[0].config.env.BROWSER_CONTROL_AI_INSTANCE, aiInstances.dsh.id);
  assert.equal((await listInstances()).find(entry => entry.id === aiInstances.dsh.id).paused, true);
  await setInstancePaused(aiInstances.dsh.id, false);
});
