let socket;
let heartbeat;
let reconnect;
let connecting = false;
let connected = false;
let connectionError = '';
let lastAction = '尚无操作';
let state = { paused: true, grants: {} };
let settings = {};
const completed = new Map();
const initialized = (async () => {
  settings = await chrome.storage.local.get(['token', 'port', 'browserId', 'enabled']);
  if (!settings.browserId) { settings.browserId = crypto.randomUUID(); await chrome.storage.local.set({ browserId: settings.browserId }); }
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = await chrome.storage.session.get('control');
  if (stored.control) state = stored.control;
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  updateBadge();
})();
async function persist() { await chrome.storage.session.set({ control: state }); updateBadge(); publish(); }
function updateBadge() {
  chrome.action.setBadgeText({ text: state.paused ? '停' : 'AI' });
  chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#64748b' : '#0f766e' });
}
function publish() {
  if (connected && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'state', paused: state.paused,
    authorizedTabs: Object.entries(state.grants).map(([id, grant]) => ({ tabId: Number(id), origin: grant.origin })) }));
}
async function connect() {
  await initialized;
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING || !settings.enabled || !settings.token) return;
  connecting = true;
  clearTimeout(reconnect);
  const current = new WebSocket(`ws://127.0.0.1:${settings.port || 19487}/extension`);
  socket = current;
  current.onopen = () => current.send(JSON.stringify({ type: 'hello', token: settings.token, browserId: settings.browserId }));
  current.onmessage = async event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (socket !== current) return;
    if (message.type === 'ready') {
      connected = true; connectionError = ''; connecting = false; publish();
      clearInterval(heartbeat);
      heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' })); }, 20000);
    }
    if (message.type !== 'command') return;
    if (typeof message.requestId !== 'string' || !Number.isFinite(message.deadline)) return;
    if (completed.has(message.requestId)) { current.send(completed.get(message.requestId)); return; }
    // Mark in-flight requests too, so duplicate IDs cannot repeat an action.
    completed.set(message.requestId, JSON.stringify({ type: 'result', requestId: message.requestId, error: 'REQUEST_ALREADY_RECEIVED' }));
    let result;
    try {
      result = { type: 'result', requestId: message.requestId, result: await execute(message) };
      lastAction = `${message.action} · ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      result = { type: 'result', requestId: message.requestId, error: error.message };
      lastAction = `${message.action} · ${error.message}`;
    }
    const serialized = JSON.stringify(result);
    completed.set(message.requestId, serialized);
    while (completed.size > 128) completed.delete(completed.keys().next().value);
    if (current.readyState === WebSocket.OPEN) current.send(serialized);
  };
  current.onclose = event => {
    if (socket !== current) return;
    socket = null; connected = false; connecting = false; clearInterval(heartbeat);
    connectionError = event.reason || '本地服务未连接';
    // Pause on loss of control channel. Reconnection alone never resumes control.
    state.paused = true;
    void persist();
    if (settings.enabled) reconnect = setTimeout(connect, 3000);
  };
  current.onerror = () => { connectionError = '无法连接本地服务，请在控制面板点击连接'; };
}
function originOf(url) {
  const value = new URL(url);
  if (!['http:', 'https:'].includes(value.protocol)) throw new Error('只支持普通 HTTP/HTTPS 网页');
  return value.origin;
}
async function assertTarget(args, deadline) {
  if (Date.now() >= deadline) throw new Error('DEADLINE_EXCEEDED');
  if (state.paused || !connected) throw new Error('CONTROL_PAUSED');
  if (args.browserId !== settings.browserId) throw new Error('WRONG_BROWSER');
  const grant = state.grants[args.tabId];
  if (!grant) throw new Error('TAB_NOT_AUTHORIZED');
  const tab = await chrome.tabs.get(args.tabId);
  if (originOf(tab.url) !== grant.origin || (tab.pendingUrl && originOf(tab.pendingUrl) !== grant.origin)) throw new Error('ORIGIN_CHANGED: 请在新页面重新授权');
  return { tab, grant };
}
async function pageAction(tabId, frameId, action, args, grant, deadline) {
  const target = { tabId, ...(frameId === null ? { allFrames: true } : { frameIds: [frameId] }) };
  await chrome.scripting.executeScript({ target, files: ['page.js'] });
  await assertTarget(args, deadline);
  const values = await chrome.scripting.executeScript({ target, func: async (action, args, origin) => {
    if (location.origin !== origin) return { error: 'FRAME_ORIGIN_NOT_AUTHORIZED' };
    try { return await globalThis.__gptBrowserPage(action, args); }
    catch (error) { return { error: error.message }; }
  }, args: [action, args, grant.origin] });
  return values.map(value => ({ frameId: value.frameId, documentId: value.documentId, ...value.result }));
}
async function execute(message) {
  const { action, args, deadline } = message;
  await initialized;
  if (action === 'tabs') {
    const tabs = [];
    for (const [id, grant] of Object.entries(state.grants)) {
      try {
        const tab = await chrome.tabs.get(Number(id));
        if (originOf(tab.url) === grant.origin) tabs.push({ tabId: tab.id, title: tab.title, url: tab.url, active: tab.active });
      } catch {}
    }
    return { browserId: settings.browserId, paused: state.paused, tabs };
  }
  const { tab, grant } = await assertTarget(args, deadline);
  if (action === 'select_tab') {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { selected: true, tabId: tab.id };
  }
  if (action === 'snapshot') {
    const frames = await pageAction(tab.id, null, 'snapshot', args, grant, deadline);
    await assertTarget(args, deadline);
    return { browserId: settings.browserId, tabId: tab.id, frames };
  }
  if (['click', 'fill', 'press_key', 'scroll'].includes(action)) {
    const values = await pageAction(tab.id, action === 'scroll' ? 0 : (args.frameId || 0), action, args, grant, deadline);
    if (values[0]?.error) throw new Error(values[0].error);
    return values[0];
  }
  if (action === 'navigate') {
    if (args.mode === 'url') {
      const url = new URL(args.url);
      if (originOf(url.href) !== grant.origin || url.username || url.password) throw new Error('NEW_ORIGIN_REQUIRES_AUTHORIZATION');
      await chrome.tabs.update(tab.id, { url: url.href });
    } else if (args.mode === 'reload') await chrome.tabs.reload(tab.id);
    else if (args.mode === 'back' || args.mode === 'forward') {
      // History destinations are unavailable to extensions without broader history access.
      throw new Error('HISTORY_NAVIGATION_UNSUPPORTED: 请提供已授权来源的明确 URL');
    } else throw new Error('INVALID_NAVIGATION_MODE');
    return { initiated: true, verified: false, next: 'Wait for the page, then take a new snapshot.' };
  }
  if (action === 'screenshot') {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id) throw new Error('TAB_NOT_ACTIVE: 请先切换到授权标签页');
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    const [after] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    await assertTarget(args, deadline);
    if (after?.id !== tab.id) throw new Error('ACTIVE_TAB_CHANGED: 截图已丢弃');
    return { data: image.split(',')[1], url: tab.url, tabId: tab.id, contentTrust: 'untrusted-page-image' };
  }
  if (action === 'wait') {
    while (Date.now() < deadline) {
      await assertTarget(args, deadline);
      try {
        const [probe] = await pageAction(tab.id, 0, 'probe', args, grant, deadline);
        if (probe && !probe.error && probe.ready && probe.found) return { matched: true, url: probe.url };
      } catch (error) { if (/PAUSED|AUTHORIZED|ORIGIN_CHANGED/.test(error.message)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('WAIT_TIMEOUT');
  }
  throw new Error('UNKNOWN_ACTION');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('options.html')].includes(sender.url)) return;
  (async () => {
    await initialized;
    if (message.type === 'ui_status') return { connected, paused: state.paused, grants: state.grants, lastAction, connectionError, browserId: settings.browserId };
    if (message.type === 'configure') {
      if (!/^[a-f0-9]{64}$/.test(message.token) || !Number.isInteger(message.port) || message.port < 1024 || message.port > 65535) throw new Error('配对信息格式不正确');
      settings = { ...settings, token: message.token, port: message.port, enabled: true };
      await chrome.storage.local.set(settings);
      clearTimeout(reconnect); clearInterval(heartbeat);
      const old = socket; socket = null; old?.close(); connecting = false; connected = false;
      state = { paused: true, grants: {} }; await persist();
      void connect(); return { saved: true };
    }
    if (message.type === 'grant') {
      const tab = await chrome.tabs.get(message.tabId);
      const origin = originOf(tab.url);
      if (origin !== message.origin) throw new Error('页面已变化，请重新授权');
      const parsed = new URL(origin);
      if (!await chrome.permissions.contains({ origins: [`${parsed.protocol}//${parsed.hostname}/*`] })) throw new Error('未获得网页权限');
      if (!connected) throw new Error('请先完成配对并连接本地服务');
      state.grants[tab.id] = { origin };
      state.paused = false; await persist(); return { authorized: true };
    }
    if (message.type === 'pause') { state.paused = true; await persist(); return { paused: true }; }
    if (message.type === 'resume') {
      if (!connected || !Object.keys(state.grants).length) throw new Error('请先连接并授权页面');
      state.paused = false; await persist(); return { paused: false };
    }
    if (message.type === 'revoke') { delete state.grants[message.tabId]; if (!Object.keys(state.grants).length) state.paused = true; await persist(); return { revoked: true }; }
    if (message.type === 'disconnect') {
      settings.enabled = false; await chrome.storage.local.set({ enabled: false });
      state = { paused: true, grants: {} }; await persist();
      socket?.close(); clearTimeout(reconnect); return { disconnected: true };
    }
    throw new Error('UNKNOWN_UI_ACTION');
  })().then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => { await initialized; delete state.grants[tabId]; await persist(); });
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  await initialized;
  const grant = state.grants[tabId];
  if (!grant) return;
  try { if (originOf(change.url) === grant.origin) return; } catch {}
  delete state.grants[tabId]; if (!Object.keys(state.grants).length) state.paused = true; await persist();
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
void connect();
