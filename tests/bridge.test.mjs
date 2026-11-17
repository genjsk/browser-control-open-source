import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import { startDaemon } from '../bridge/daemon.mjs';
import { registerInstance, setInstancePaused } from '../bridge/instances.mjs';

async function fixture(t) {
  const keys = { adminToken: randomBytes(32).toString('hex'), extensionToken: randomBytes(32).toString('hex') };
  const service = await startDaemon({ listenPort: 0, keys });
  t.after(() => service.close());
  const servicePort = Number(new URL(service.address).port);
  const ai = await registerInstance({ id: 'test-ai', client: 'Test', name: '测试实例', servicePort });
  const other = await registerInstance({ id: 'other-ai', client: 'Test', name: '其他实例', servicePort });
  await setInstancePaused('test-ai', false);
  await setInstancePaused('other-ai', false);
  const request = (route, body, headers = {}) => fetch(service.address + route, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${keys.adminToken}`, ...headers }, body: body ? JSON.stringify(body) : undefined
  });
  const instance = (identity, extra = {}) => ({
    'x-browser-control-instance': identity.entry.id,
    'x-browser-control-instance-token': identity.token,
    'x-browser-control-port': String(servicePort),
    ...extra
  });
  const command = (action, args, identity = ai, extraHeaders = {}) => fetch(service.address + '/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...instance(identity, extraHeaders) },
    body: JSON.stringify({ action, args })
  });
  async function connect(token = keys.extensionToken, origin = `chrome-extension://${'a'.repeat(32)}`) {
    const ws = new WebSocket(service.address.replace('http:', 'ws:') + '/extension', { origin });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token, browserId: 'test-browser' }));
    return ws;
  }
  async function ready() {
    const ws = await connect();
    await once(ws, 'message');
    ws.send(JSON.stringify({ type: 'state', paused: false, authorizedTabs: [{ tabId: 10, origin: 'https://example.com' }] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    return ws;
  }
  return { ...service, keys, servicePort, ai, other, request, instance, command, connect, ready };
}

test('拒绝未认证请求、网页来源和伪造 Host', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/status', null, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await f.request('/status', null, { Origin: 'https://evil.example' })).status, 403);
  const spoofed = await new Promise((resolve, reject) => {
    const request = http.get(f.address + '/status', { headers: { Host: 'evil.example', Authorization: `Bearer ${f.keys.adminToken}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(spoofed, 403);
  assert.equal((await f.request('/status')).status, 200);
});

test('管理凭证不能调用浏览器工具，必须使用 AI 实例身份', async t => {
  const f = await fixture(t);
  const response = await f.request('/command', { action: 'tabs', args: {} });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'INSTANCE_REQUIRED');
  const unknown = await f.command('tabs', {}, { get entry() { return { id: 'missing-ai' }; }, token: 'f'.repeat(64) });
  assert.equal(unknown.status, 403);
  assert.equal((await unknown.json()).code, 'INSTANCE_UNKNOWN');
  const invalid = await f.command('tabs', {}, { entry: f.ai.entry, token: 'f'.repeat(64) });
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).code, 'INSTANCE_TOKEN_INVALID');
});

test('端口不一致时阻止调用并给出两端端口', async t => {
  const f = await fixture(t);
  const response = await f.command('tabs', {}, f.ai, { 'x-browser-control-port': String(f.servicePort + 1) });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, 'PORT_MISMATCH');
  assert.equal(body.configuredPort, f.servicePort + 1);
  assert.equal(body.servicePort, f.servicePort);
});

test('错误配对密钥无法获得浏览器连接', async t => {
  const f = await fixture(t);
  const ws = await f.connect('wrong');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
  assert.equal((await (await f.request('/status')).json()).connected, false);
});

test('普通网页不能建立扩展 WebSocket', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.address.replace('http:', 'ws:') + '/extension', { origin: 'https://evil.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('指令按标签页串行执行且不会自动重发', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  let received = 0, inFlight = 0;
  const arrivals = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    received++; arrivals.push(message.requestId);
    assert.equal(inFlight, 0, '下一条指令到达时上一条仍在执行');
    inFlight++;
    setTimeout(() => {
      inFlight--;
      ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: { order: received } }));
    }, 50);
  });
  const body = { action: 'click', args: { browserId: 'test-browser', tabId: 10 } };
  const first = f.command(body.action, body.args);
  const second = f.command(body.action, body.args);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received, 1);
  const responses = await Promise.all([first, second]);
  for (const response of responses) assert.equal(response.status, 200);
  const orders = [];
  for (const response of responses) {
    const payload = await response.json();
    orders.push(payload.result.order);
    assert.equal(payload.verification.portMatches, true);
    assert.equal(payload.verification.pairing, 'verified');
    assert.equal(payload.verification.instance, 'test-ai');
  }
  assert.deepEqual(orders.sort(), [1, 2]);
  assert.equal(new Set(arrivals).size, 2);
});

test('type_text 在允许列表内，完整参数与结果经桥接返回', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  let received = null;
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    received = message;
    ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: { complete: true, typedCharacters: 2 } }));
  });
  const response = await f.command('type_text', { browserId: 'test-browser', tabId: 10, frameId: 0, snapshotId: 's1', elementId: 'e1', text: '你好', delayMs: 5 });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.action, 'type_text');
  assert.equal(received.args.text, '你好');
  assert.equal(received.args.delayMs, 5);
  assert.equal(body.result.complete, true);
  assert.equal(body.verification.portMatches, true);
});

test('eval 在允许列表内，expression 与结果经桥接返回', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  let received = null;
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    received = message;
    ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: { evaluated: true, result: 42 } }));
  });
  const response = await f.command('eval', { browserId: 'test-browser', tabId: 10, frameId: 0, expression: '6*7' });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.action, 'eval');
  assert.equal(received.args.expression, '6*7');
  assert.equal(body.result.evaluated, true);
  assert.equal(body.result.result, 42);
  assert.equal(body.verification.portMatches, true);
});

test('暂停时拒绝动作并拒绝错误浏览器目标', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  ws.send(JSON.stringify({ type: 'state', paused: true, authorizedTabs: [] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const response = await f.command('click', { browserId: 'test-browser', tabId: 10 });
  assert.match((await response.json()).error, /CONTROL_PAUSED/);
  assert.equal((await f.command('snapshot', { browserId: 'wrong', tabId: 10 })).status, 400);
});

test('暂停单个 AI 实例只影响该实例，恢复后继续可用', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'command') ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: [] }));
  });
  const pause = await f.request('/instances/pause', { id: 'test-ai', paused: true });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).instance.status, 'paused');
  const blocked = await f.command('tabs', {});
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'INSTANCE_PAUSED');
  const unaffected = await f.command('tabs', {}, f.other);
  assert.equal(unaffected.status, 200);
  const listed = await f.request('/instances');
  const states = Object.fromEntries((await listed.json()).instances.map(item => [item.id, item.status]));
  assert.equal(states['test-ai'], 'paused');
  assert.equal(states['other-ai'], 'online');
  await f.request('/instances/pause', { id: 'test-ai', paused: false });
  assert.equal((await f.command('tabs', {})).status, 200);
  await setInstancePaused('test-ai', false);
});

test('暂停后即使立即恢复，也不执行旧队列中的动作', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  let received = 0;
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    received++;
    setTimeout(() => ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: { done: true } })), 120);
  });
  const body = { action: 'click', args: { browserId: 'test-browser', tabId: 10 } };
  const first = f.command(body.action, body.args);
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = f.command(body.action, body.args);
  await new Promise(resolve => setTimeout(resolve, 20));
  ws.send(JSON.stringify({ type: 'state', paused: true, authorizedTabs: [] }));
  ws.send(JSON.stringify({ type: 'state', paused: false, authorizedTabs: [] }));
  assert.equal((await first).status, 200);
  assert.match((await (await second).json()).error, /CONTROL_CHANGED/);
  assert.equal(received, 1);
});

test('单次调用超时返回明确结果且不重发写入', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  let received = 0;
  ws.on('message', raw => { if (JSON.parse(raw).type === 'command') received++; });
  const response = await f.command('fill', { browserId: 'test-browser', tabId: 10, elementId: 'e1', snapshotId: 's1', text: 'hello', timeoutMs: 1000 });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /ACTION_TIMEOUT: outcome unknown/);
  assert.match(body.error, /not retried/);
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(received, 1, '超时后不应重发已发出的写入');
});

test('断线时正在执行与排队的动作都失败，重新连接后不重放', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  ws.on('message', () => ws.close());
  const body = { action: 'fill', args: { browserId: 'test-browser', tabId: 10 } };
  const responses = await Promise.all([f.command(body.action, body.args), f.command(body.action, body.args)]);
  for (const response of responses) assert.equal(response.status, 409);
  const next = await f.ready();
  let replayed = false; next.on('message', () => { replayed = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(replayed, false);
});
