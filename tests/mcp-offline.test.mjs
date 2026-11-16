import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'browser-control-mcp-offline-'));
process.env.BROWSER_CONTROL_DATA_DIR = dataDir;
process.env.BROWSER_BRIDGE_PORT = '19554';
process.env.BROWSER_CONTROL_AI_INSTANCE = '';
process.env.BROWSER_CONTROL_MCP_TEST = '1';
const { invoke } = await import('../bridge/mcp.mjs');
const { listInstances } = await import('../bridge/instances.mjs');

test.after(async () => { await rm(dataDir, { recursive: true, force: true }); });

test('本地服务未运行时工具调用直接报错，不启动任何监听服务', async () => {
  const error = await invoke('status').then(() => null, value => value);
  assert.ok(error, 'expected the tool call to fail');
  assert.equal(error.code, 'SERVICE_NOT_RUNNING');
  assert.equal(error.configuredPort, 19554);
  assert.match(error.message, /本地服务未启动/);
  assert.match(error.message, /控制面板/);
  assert.match(error.message, /不会自动启动服务/);
  await assert.rejects(fetch('http://127.0.0.1:19554/status'), /fetch failed/);
  const ids = (await listInstances()).map(entry => entry.id);
  assert.ok(ids.includes('source-manual'));
});
