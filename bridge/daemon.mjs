import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { credentials, safeEqual, localDir, port, version, assertConnectionEnabled } from './config.mjs';
import { openRouting, validBrowserId } from './routing.mjs';
import {
  ensureIdentity, verifyInstance, listInstances, markSeen, setInstancePaused, getInstance, verification
} from './instances.mjs';

export async function startDaemon({ listenPort = port, keys = null,
  routingFile = listenPort ? path.join(localDir, `browser-routing-${listenPort}.json`) : null } = {}) {
  keys ||= await credentials();
  await ensureIdentity();
  const routing = await openRouting(routingFile);
  const connections = new Map();
  const browserStatus = id => {
    const browser = connections.get(id);
    return { connected: !!browser, paused: browser?.paused ?? true, browserId: id ?? null, authorizedTabs: browser?.authorizedTabs ?? [] };
  };
  const assignedView = item => ({ ...item, assignedBrowserId: routing.assigned(item.id), effectiveBrowserId: routing.effective(item.id) });
  const routeError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
  const pending = new Map();
  const queues = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); };
    const servicePort = server.address().port;
    // No browser-page origins or CORS. Requests must target this exact loopback
    // host; the panel uses the admin token, AI instances use their own token.
    if (request.headers.host !== `127.0.0.1:${servicePort}` || request.headers.origin) return send(403, { error: 'FORBIDDEN' });
    const isAdmin = safeEqual(request.headers.authorization, `Bearer ${keys.adminToken}`);
    const instanceId = String(request.headers['x-browser-control-instance'] || '');
    const instanceToken = String(request.headers['x-browser-control-instance-token'] || '');
    const rawHeaderPort = request.headers['x-browser-control-port'];
    const headerPort = rawHeaderPort === undefined ? null : Number(rawHeaderPort);
    const sendAuthError = ({ code, message, configuredPort }) => send(403, {
      error: message, code, message,
      configuredPort: configuredPort ?? null,
      servicePort,
      verification: { configuredPort: configuredPort ?? null, servicePort, portMatches: false, pairing: 'failed' }
    });
    const authenticate = async () => {
      const auth = await verifyInstance({
        id: instanceId, token: instanceToken,
        headerPort: Number.isInteger(headerPort) && headerPort > 0 ? headerPort : null,
        servicePort
      });
      if (auth.error) { sendAuthError(auth.error); return null; }
      return auth.entry;
    };
    async function readBody(limit = 128 * 1024) {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
      }
      return body;
    }
    try {
      if (request.url === '/status' && request.method === 'GET') {
        if (isAdmin) {
          const instances = (await listInstances()).map(assignedView);
          const browsers = routing.list().map(item => ({ ...item, ...browserStatus(item.id) }));
          const active = browsers.filter(browser => browser.connected);
          return send(200, {
            connected: active.length > 0, paused: active.every(browser => browser.paused),
            browserId: active.length === 1 ? active[0].id : null,
            authorizedTabs: active.flatMap(browser => browser.authorizedTabs.map(tab => ({ ...tab, browserId: browser.id }))),
            version, servicePort, instances, browsers
          });
        }
        const entry = await authenticate(); if (!entry) return;
        await markSeen(entry.id, { call: true }).catch(() => {});
        const id = routing.effective(entry.id);
        const status = browserStatus(id);
        const routingState = id ? (status.connected ? 'connected' : 'offline') : routing.list().length ? 'unassigned' : 'waiting';
        return send(200, { ...status, routing: routingState, version, servicePort, verification: verification(entry, servicePort, status.connected) });
      }
      if (request.url === '/instance/heartbeat' && request.method === 'POST') {
        const entry = await authenticate(); if (!entry) return;
        await markSeen(entry.id).catch(() => {});
        return send(200, { ok: true, servicePort, verification: verification(entry, servicePort, !!connections.get(routing.effective(entry.id))) });
      }
      if (isAdmin && request.url === '/shutdown' && request.method === 'POST') {
        send(200, { stopped: true }); setTimeout(() => close(), 50); return;
      }
      if (isAdmin && request.url === '/instances' && request.method === 'GET') {
        return send(200, { version, servicePort, instances: (await listInstances()).map(assignedView) });
      }
      if (isAdmin && request.url === '/instances/browser' && request.method === 'POST') {
        const { id, browserId } = JSON.parse(await readBody(16 * 1024));
        if (typeof id !== 'string' || (browserId !== null && !validBrowserId(browserId))) throw routeError('INVALID_REQUEST', '无效的浏览器分配请求。', 400);
        if (!await getInstance(id)) throw routeError('INSTANCE_UNKNOWN', '未找到该 AI 接入实例。', 404);
        await routing.assign(id, browserId);
        return send(200, { id, assignedBrowserId: routing.assigned(id), effectiveBrowserId: routing.effective(id) });
      }
      if (isAdmin && request.url === '/instances/pause' && request.method === 'POST') {
        const body = JSON.parse(await readBody(16 * 1024) || '{}');
        if (typeof body.id !== 'string' || typeof body.paused !== 'boolean') return send(400, { error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' });
        try {
          const instance = await setInstancePaused(body.id, body.paused);
          return send(200, { instance, servicePort, version });
        } catch (error) {
          if (error.code === 'INSTANCE_UNKNOWN') return send(404, { error: error.message, code: error.code });
          throw error;
        }
      }
      if (isAdmin && request.url === '/command') {
        return send(403, { error: 'AI 工具调用必须使用对应 AI 接入实例的身份。', code: 'INSTANCE_REQUIRED', configuredPort: null, servicePort });
      }
      if (request.url !== '/command' || request.method !== 'POST') {
        return send(404, { error: 'NOT_FOUND', code: 'NOT_FOUND' });
      }
      const entry = await authenticate(); if (!entry) return;
      if (entry.paused) return send(403, {
        error: `AI 接入实例“${entry.name}”已暂停调用，请在控制面板恢复后再试。`,
        code: 'INSTANCE_PAUSED', message: `AI 接入实例“${entry.name}”已暂停调用，请在控制面板恢复后再试。`,
        configuredPort: entry.port, servicePort
      });
      const body = await readBody();
      const command = JSON.parse(body);
      if (typeof command.action !== 'string' || !command.args || typeof command.args !== 'object') return send(400, { error: 'INVALID_COMMAND', code: 'INVALID_COMMAND' });
      const allowed = ['tabs', 'snapshot', 'inspect', 'click', 'fill', 'press_key', 'type_text', 'eval', 'scroll', 'navigate', 'select_tab', 'screenshot', 'wait'];
      if (!allowed.includes(command.action)) return send(400, { error: 'UNKNOWN_ACTION', code: 'UNKNOWN_ACTION' });
      const browserId = routing.effective(entry.id);
      if (!browserId && routing.list().length > 1) throw routeError('BROWSER_NOT_ASSIGNED', '已配对多个浏览器。请在控制面板为该 AI 选择浏览器。');
      const browser = connections.get(browserId);
      if (!browser) {
        if (routing.assigned(entry.id)) throw routeError('BROWSER_OFFLINE', '此 AI 绑定的浏览器已离线。请重连该浏览器，或在面板更改分配。');
        return send(409, { error: '浏览器扩展未连接或连接已断开。', code: 'EXTENSION_DISCONNECTED', configuredPort: entry.port, servicePort });
      }
      if (command.args.browserId !== undefined && command.args.browserId !== browserId) throw routeError('INVALID_TARGET', 'INVALID_TARGET: 此 AI 只能操作分配给它的浏览器。', 400);
      if (command.action !== 'tabs' && (!Number.isInteger(command.args.tabId) || command.args.browserId === undefined)) throw routeError('INVALID_TARGET', 'INVALID_TARGET: 缺少浏览器或标签页 ID。', 400);
      const key = `${browserId}:${command.args.tabId ?? 'tabs'}`;
      const expectedEpoch = browser.epoch;
      const revision = routing.revision(entry.id);
      await markSeen(entry.id, { call: true }).catch(() => {});
      const prior = queues.get(key) || Promise.resolve();
      const work = prior.catch(() => {}).then(async () => {
        const current = await getInstance(entry.id);
        if (!current) throw Object.assign(new Error('未登记的 AI 接入实例。请在控制面板中重新生成该 AI 接入配置。'), { status: 403, code: 'INSTANCE_UNKNOWN' });
        if (current.paused) throw Object.assign(new Error(`AI 接入实例“${current.name}”已暂停调用，请在控制面板恢复后再试。`), { status: 403, code: 'INSTANCE_PAUSED' });
        if (connections.get(browserId) !== browser) throw routeError('CONNECTION_CHANGED', 'CONNECTION_CHANGED: 浏览器已重新连接。');
        if (routing.effective(entry.id) !== browserId || routing.revision(entry.id) !== revision) throw routeError('BROWSER_ASSIGNMENT_CHANGED', '浏览器分配已变更，请重新查询页面。');
        if (command.action !== 'tabs' && browser.epoch !== expectedEpoch) throw routeError('CONTROL_CHANGED', 'CONTROL_CHANGED: queued action cancelled; inspect current state before continuing.');
        return dispatch(command, browser);
      });
      queues.set(key, work);
      try {
        const result = await work;
        send(200, { result, verification: verification(entry, servicePort, connections.get(browserId) === browser) });
      } finally { if (queues.get(key) === work) queues.delete(key); }
    } catch (error) {
      const statusCode = error.status || (error instanceof SyntaxError ? 400 : 409);
      send(statusCode, {
        error: error.message, ...(error.code ? { code: error.code } : {}),
        ...(error.configuredPort !== undefined ? { configuredPort: error.configuredPort } : {}),
        ...(error.servicePort !== undefined ? { servicePort: error.servicePort } : {})
      });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/extension' || request.headers.host !== `127.0.0.1:${server.address().port}` ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin || '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  function failPending(message, socket) {
    for (const [id, item] of pending) if (!socket || item.socket === socket) {
      clearTimeout(item.timer); pending.delete(id); item.reject(new Error(message));
    }
  }
  function dispatch(command, { socket, paused }) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('BROWSER_DISCONNECTED');
    if (paused && command.action !== 'tabs') throw new Error('CONTROL_PAUSED');
    const requestId = randomUUID();
    const timeout = Math.min(30000, Math.max(1000, command.args.timeoutMs || 12000));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('ACTION_TIMEOUT: outcome unknown; take a new snapshot before deciding what to do. The action was not retried.'));
      }, timeout + 500);
      pending.set(requestId, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ type: 'command', requestId, deadline: Date.now() + timeout, ...command }));
    });
  }
  wss.on('connection', socket => {
    let browser = null;
    let authenticating = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000);
    socket.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!browser) {
          if (authenticating || message.type !== 'hello' || !safeEqual(message.token, keys.extensionToken) ||
              !validBrowserId(message.browserId)) return socket.close(1008, 'Authentication failed');
          authenticating = true;
          await routing.remember(message.browserId, message.name);
          if (socket.readyState !== WebSocket.OPEN) return;
          const previous = connections.get(message.browserId);
          if (previous) { failPending('CONNECTION_REPLACED', previous.socket); previous.socket.close(1000, 'Reconnected'); }
          clearTimeout(authTimer);
          browser = { id: message.browserId, socket, epoch: 0, paused: true, authorizedTabs: [] };
          connections.set(browser.id, browser);
          socket.send(JSON.stringify({ type: 'ready' })); return;
        }
        if (connections.get(browser.id) !== browser) return;
        if (message.type === 'state') {
          const previous = JSON.stringify([browser.paused, browser.authorizedTabs]);
          browser.paused = message.paused !== false;
          browser.authorizedTabs = Array.isArray(message.authorizedTabs) ? message.authorizedTabs.slice(0, 100).map(tab => ({ tabId: tab.tabId, origin: String(tab.origin).slice(0, 2048) })) : [];
          if (previous !== JSON.stringify([browser.paused, browser.authorizedTabs])) browser.epoch++;
          if (message.name) await routing.remember(browser.id, message.name);
          return;
        }
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        if (message.type === 'result') {
          const item = pending.get(message.requestId);
          if (!item || item.socket !== socket) return;
          clearTimeout(item.timer); pending.delete(message.requestId);
          if (message.error) item.reject(new Error(String(message.error).slice(0, 1000)));
          else item.resolve(message.result);
        }
      } catch { socket.close(1008, 'Invalid message'); }
    });
    socket.on('close', () => {
      clearTimeout(authTimer); failPending('BROWSER_DISCONNECTED: action outcome may be unknown; do not replay writes.', socket);
      if (browser && connections.get(browser.id) === browser) connections.delete(browser.id);
    });
    socket.on('error', () => {});
  });
  async function close() {
    failPending('BRIDGE_STOPPED');
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  return { server, close, address: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith('/daemon.mjs') && process.argv[1].replaceAll('\\', '/').endsWith('/daemon.mjs')) {
  assertConnectionEnabled().then(() => startDaemon()).catch(error => { console.error(`Browser bridge: ${error.message}`); process.exit(1); });
}
