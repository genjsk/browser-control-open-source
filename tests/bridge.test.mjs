import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import { startDaemon } from '../bridge/daemon.mjs';

async function fixture(t) {
  const keys = { adminToken: randomBytes(32).toString('hex'), extensionToken: randomBytes(32).toString('hex') };
  const service = await startDaemon({ listenPort: 0, keys });
  t.after(() => service.close());
  const request = (route, body, headers = {}) => fetch(service.address + route, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${keys.adminToken}`, ...headers }, body: body ? JSON.stringify(body) : undefined
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
  return { ...service, keys, request, connect, ready };
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
  let received = 0;
  const arrivals = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    received++; arrivals.push(message.requestId);
    setTimeout(() => ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, result: { order: received } })), 50);
  });
  const body = { action: 'click', args: { browserId: 'test-browser', tabId: 10 } };
  const a = f.request('/command', body);
  const b = f.request('/command', body);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received, 1);
  assert.equal((await (await a).json()).order, 1);
  assert.equal((await (await b).json()).order, 2);
  assert.equal(new Set(arrivals).size, 2);
});
test('暂停时拒绝动作并拒绝错误浏览器目标', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  ws.send(JSON.stringify({ type: 'state', paused: true, authorizedTabs: [] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const response = await f.request('/command', { action: 'click', args: { browserId: 'test-browser', tabId: 10 } });
  assert.match((await response.json()).error, /CONTROL_PAUSED/);
  assert.equal((await f.request('/command', { action: 'snapshot', args: { browserId: 'wrong', tabId: 10 } })).status, 400);
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
  const first = f.request('/command', body);
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = f.request('/command', body);
  await new Promise(resolve => setTimeout(resolve, 20));
  ws.send(JSON.stringify({ type: 'state', paused: true, authorizedTabs: [] }));
  ws.send(JSON.stringify({ type: 'state', paused: false, authorizedTabs: [] }));
  assert.equal((await first).status, 200);
  assert.match((await (await second).json()).error, /CONTROL_CHANGED/);
  assert.equal(received, 1);
});
test('断线时正在执行与排队的动作都失败，重新连接后不重放', async t => {
  const f = await fixture(t);
  const ws = await f.ready();
  ws.on('message', () => ws.close());
  const body = { action: 'fill', args: { browserId: 'test-browser', tabId: 10 } };
  const responses = await Promise.all([f.request('/command', body), f.request('/command', body)]);
  for (const response of responses) assert.equal(response.status, 409);
  const next = await f.ready();
  let replayed = false; next.on('message', () => { replayed = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(replayed, false);
});
