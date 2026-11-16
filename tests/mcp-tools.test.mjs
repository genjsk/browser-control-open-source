import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const dataDir = await mkdtemp(path.join(tmpdir(), 'browser-control-mcp-'));
process.env.BROWSER_CONTROL_DATA_DIR = dataDir;
process.env.BROWSER_BRIDGE_PORT = '19553';
process.env.BROWSER_CONTROL_AI_INSTANCE = 'dsh-test';
process.env.BROWSER_CONTROL_MCP_TEST = '1';

const { startDaemon } = await import('../bridge/daemon.mjs');
const { registerInstance, setInstancePaused } = await import('../bridge/instances.mjs');
const service = await startDaemon({ listenPort: 19553 });
await registerInstance({ id: 'dsh-test', client: 'DeepSeek Harness', name: 'DSH 测试', servicePort: 19553 });
await setInstancePaused('dsh-test', false);
const { invoke } = await import('../bridge/mcp.mjs');
const { credentials } = await import('../bridge/config.mjs');

test.after(async () => {
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('工具调用逐次核对端口、配对和扩展连接，并区分暂停与断线', async t => {
  const status = await invoke('status');
  assert.equal(status.verification.instance, 'dsh-test');
  assert.equal(status.verification.configuredPort, 19553);
  assert.equal(status.verification.servicePort, 19553);
  assert.equal(status.verification.portMatches, true);
  assert.equal(status.verification.pairing, 'verified');
  assert.equal(status.connected, false);
  assert.ok(!JSON.stringify(status).includes('token'));

  const blocked = await invoke('tabs').then(() => null, error => error);
  assert.equal(blocked.code, 'EXTENSION_DISCONNECTED');
  assert.equal(blocked.configuredPort, 19553);
  assert.equal(blocked.servicePort, 19553);

  const ws = new WebSocket('ws://127.0.0.1:19553/extension', { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', token: (await credentials()).extensionToken, browserId: 'mock-browser' }));
  await once(ws, 'message');
  ws.send(JSON.stringify({ type: 'state', paused: false, authorizedTabs: [{ tabId: 10, origin: 'https://example.com' }] }));
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'command') ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: [{ tabId: 10 }] }));
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  t.after(() => ws.close());

  const tabs = await invoke('tabs');
  assert.deepEqual(tabs.result, [{ tabId: 10 }]);
  assert.equal(tabs.verification.portMatches, true);
  assert.equal(tabs.verification.browserConnected, true);

  await setInstancePaused('dsh-test', true);
  const paused = await invoke('tabs').then(() => null, error => error);
  assert.equal(paused.code, 'INSTANCE_PAUSED');
  const pausedStatus = await invoke('status');
  assert.equal(pausedStatus.verification.instancePaused, true);
  await setInstancePaused('dsh-test', false);
  const resumed = await invoke('tabs');
  assert.equal(resumed.verification.portMatches, true);
  assert.deepEqual(resumed.result, [{ tabId: 10 }]);

  // No cumulative, per-session or per-day cap: 200 consecutive calls still succeed.
  for (let index = 0; index < 200; index++) {
    const repeated = await invoke('status');
    assert.equal(repeated.verification.portMatches, true);
    assert.equal(repeated.verification.pairing, 'verified');
  }
});
