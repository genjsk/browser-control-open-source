import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { credentials, safeEqual, port, version, assertConnectionEnabled } from './config.mjs';

export async function startDaemon({ listenPort = port, keys = null } = {}) {
  keys ||= await credentials();
  let peer = null;
  let controlEpoch = 0;
  let status = { connected: false, paused: true, browserId: null, authorizedTabs: [] };
  const pending = new Map();
  const queues = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); };
    // No browser-page origins or CORS. Native MCP requests send a bearer token.
    if (request.headers.host !== `127.0.0.1:${server.address().port}` || request.headers.origin ||
        !safeEqual(request.headers.authorization, `Bearer ${keys.adminToken}`)) return send(403, { error: 'FORBIDDEN' });
    try {
      if (request.url === '/status' && request.method === 'GET') return send(200, { ...status, version });
      if (request.url === '/shutdown' && request.method === 'POST') {
        send(200, { stopped: true }); setTimeout(() => close(), 50); return;
      }
      if (request.url !== '/command' || request.method !== 'POST') return send(404, { error: 'NOT_FOUND' });
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 128 * 1024) return send(413, { error: 'REQUEST_TOO_LARGE' });
      }
      const command = JSON.parse(body);
      if (typeof command.action !== 'string' || !command.args || typeof command.args !== 'object') return send(400, { error: 'INVALID_COMMAND' });
      const allowed = ['tabs', 'snapshot', 'click', 'fill', 'press_key', 'scroll', 'navigate', 'select_tab', 'screenshot', 'wait'];
      if (!allowed.includes(command.action)) return send(400, { error: 'UNKNOWN_ACTION' });
      if (command.action !== 'tabs' && (!Number.isInteger(command.args.tabId) || command.args.browserId !== status.browserId)) return send(400, { error: 'INVALID_TARGET' });
      const key = `${command.args.browserId}:${command.args.tabId ?? 'tabs'}`;
      const expectedPeer = peer;
      const expectedBrowser = status.browserId;
      const expectedEpoch = controlEpoch;
      if (!expectedPeer) return send(409, { error: 'BROWSER_DISCONNECTED' });
      const prior = queues.get(key) || Promise.resolve();
      const work = prior.catch(() => {}).then(() => {
        if (peer !== expectedPeer || status.browserId !== expectedBrowser) throw new Error('CONNECTION_CHANGED');
        if (command.action !== 'tabs' && controlEpoch !== expectedEpoch) throw new Error('CONTROL_CHANGED: queued action cancelled; inspect current state before continuing.');
        return dispatch(command, expectedPeer);
      });
      queues.set(key, work);
      try { send(200, await work); }
      finally { if (queues.get(key) === work) queues.delete(key); }
    } catch (error) { send(error instanceof SyntaxError ? 400 : 409, { error: error.message }); }
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
  function dispatch(command, socket) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('BROWSER_DISCONNECTED');
    if (status.paused && command.action !== 'tabs') throw new Error('CONTROL_PAUSED');
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
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000);
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'hello' || !safeEqual(message.token, keys.extensionToken) ||
              typeof message.browserId !== 'string' || message.browserId.length > 100) return socket.close(1008, 'Authentication failed');
          if (peer && status.browserId !== message.browserId) return socket.close(1008, 'Another browser is connected');
          if (peer) { failPending('CONNECTION_REPLACED', peer); peer.close(1000, 'Reconnected'); }
          authenticated = true; clearTimeout(authTimer); peer = socket;
          controlEpoch++;
          status = { connected: true, paused: true, browserId: message.browserId, authorizedTabs: [] };
          socket.send(JSON.stringify({ type: 'ready' })); return;
        }
        if (socket !== peer) return;
        if (message.type === 'state') {
          const previous = JSON.stringify([status.paused, status.authorizedTabs]);
          status.paused = message.paused !== false;
          status.authorizedTabs = Array.isArray(message.authorizedTabs) ? message.authorizedTabs.slice(0, 100).map(tab => ({ tabId: tab.tabId, origin: String(tab.origin).slice(0, 2048) })) : [];
          if (previous !== JSON.stringify([status.paused, status.authorizedTabs])) controlEpoch++;
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
      if (peer === socket) { peer = null; status = { connected: false, paused: true, browserId: null, authorizedTabs: [] }; }
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
