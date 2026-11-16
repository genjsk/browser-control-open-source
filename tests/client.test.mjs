import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'browser-control-client-'));
process.env.BROWSER_CONTROL_DATA_DIR = dataDir;
process.env.BROWSER_BRIDGE_PORT = '19550';
const { ensureDaemon } = await import('../bridge/client.mjs');
const { disabledFile } = await import('../bridge/config.mjs');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('本地服务未运行时只返回明确错误，不会启动后台服务', async () => {
  await assert.rejects(ensureDaemon(), error => {
    assert.equal(error.code, 'SERVICE_NOT_RUNNING');
    assert.equal(error.configuredPort, 19550);
    assert.match(error.message, /本地服务未启动/);
    assert.match(error.message, /请打开 Browser Control 控制面板并点击“连接”/);
    assert.match(error.message, /不会自动启动服务/);
    return true;
  });
  await assert.rejects(fetch('http://127.0.0.1:19550/status'), /fetch failed/);
});

test('手动断开后 AI 路径继续拒绝，并提示由控制面板连接', async () => {
  await writeFile(disabledFile, 'manual\n');
  await assert.rejects(ensureDaemon(), /服务已手动断开/);
  await rm(disabledFile, { force: true });
});

test('调用失败不会写出运行时进程或监听记录', async () => {
  const settings = await readFile(path.join(dataDir, 'ai-instances.json'), 'utf8').catch(() => '');
  assert.equal(settings, '');
});
