import { planTyping, keyEventParams } from './typing.js';

let socket;
let heartbeat;
let reconnect;
let connecting = false;
let connected = false;
let connectionError = '';
let lastAction = '尚无操作';
let state = { paused: true, grants: {} };
let settings = {};
const defaultBrowserName = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome / Chromium';
const browserName = () => settings.browserName || defaultBrowserName;
const completed = new Map();
const initialized = (async () => {
  settings = await chrome.storage.local.get(['token', 'port', 'browserId', 'browserName', 'enabled', 'typingConsent', 'evalConsent']);
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
  if (connected && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'state', paused: state.paused, name: browserName(),
    authorizedTabs: Object.entries(state.grants).map(([id, grant]) => ({ tabId: Number(id), origin: grant.origin })) }));
}
async function connect() {
  await initialized;
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING || !settings.enabled || !settings.token) return;
  connecting = true;
  clearTimeout(reconnect);
  const current = new WebSocket(`ws://127.0.0.1:${settings.port || 19487}/extension`);
  socket = current;
  current.onopen = () => current.send(JSON.stringify({ type: 'hello', token: settings.token, browserId: settings.browserId, name: browserName() }));
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
async function pageAction(tabId, frameId, action, args, grant, deadline, { enforce = true } = {}) {
  const target = { tabId, ...(frameId === null ? { allFrames: true } : { frameIds: [frameId] }) };
  await chrome.scripting.executeScript({ target, files: ['page.js'] });
  if (enforce) await assertTarget(args, deadline);
  const values = await chrome.scripting.executeScript({ target, func: async (action, args, origin) => {
    if (location.origin !== origin) return { error: 'FRAME_ORIGIN_NOT_AUTHORIZED' };
    try { return await globalThis.__gptBrowserPage(action, args); }
    catch (error) { return { error: error.message }; }
  }, args: [action, args, grant.origin] });
  return values.map(value => ({ frameId: value.frameId, documentId: value.documentId, ...value.result }));
}
function typingError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function createTypingRun(tabId) {
  const run = { tabId, aborted: false, code: '', message: '' };
  const abort = (code, message) => {
    if (!run.aborted) { run.aborted = true; run.code = code; run.message = message; }
  };
  const onActivated = info => { if (info.tabId !== tabId) abort('TAB_CHANGED', '活动标签页已切换，逐字输入已停止。'); };
  const onRemoved = id => { if (id === tabId) abort('TAB_CLOSED', '目标标签页已关闭，逐字输入已停止。'); };
  const onUpdated = (id, change) => { if (id === tabId && change.url) abort('TAB_CHANGED', '目标标签页已跳转，逐字输入已停止。'); };
  const onDetach = (source, reason) => { if (source.tabId === tabId) abort('DEBUGGER_DETACHED', `Chrome 调试会话已断开（${reason || 'unknown'}）。`); };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.debugger.onDetach.addListener(onDetach);
  return {
    run,
    cleanup() {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.debugger.onDetach.removeListener(onDetach);
    }
  };
}
function abortOf(run) {
  if (run.aborted) return { code: run.code, message: run.message };
  if (state.paused) return { code: 'USER_PAUSED', message: '控制已暂停，逐字输入已停止。' };
  if (!connected) return { code: 'CONTROL_DISCONNECTED', message: '与本地服务的连接已断开，逐字输入已停止。' };
  return null;
}
async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').trim();
    if (/another debugger|devtools/i.test(message)) throw typingError('DEBUGGER_BUSY', '该标签页已被 DevTools 或其他调试工具占用，请关闭 DevTools 后重试。');
    if (/permission|not allowed|access denied/i.test(message)) throw typingError('DEBUGGER_PERMISSION_REQUIRED', 'Chrome 未允许扩展使用调试权限，请在扩展设置中确认并重新加载扩展。');
    throw typingError('DEBUGGER_ATTACH_FAILED', `无法连接 Chrome 调试器：${message}`);
  }
}
async function sendTypingSegment(tabId, segment) {
  if (segment.kind === 'text') {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: segment.text });
    return;
  }
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', keyEventParams(segment, type));
  }
}

async function typeText(tab, grant, args, deadline) {
  if (!settings.typingConsent) throw typingError('TYPING_CONSENT_REQUIRED', '逐字输入需要先在扩展设置中明确启用 Chrome 调试权限。');
  if (!await chrome.permissions.contains({ permissions: ['debugger'] })) {
    throw typingError('DEBUGGER_PERMISSION_REQUIRED', '扩展尚未获得 debugger 权限，请重新加载扩展并在提示中接受新权限。');
  }
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) throw typingError('TAB_NOT_ACTIVE', '逐字输入要求目标标签页在前台；请先调用 browser_select_tab。');
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) throw typingError('TEXT_REQUIRED', '逐字输入需要非空 text。');
  const delayMs = Math.min(100, Math.max(0, Math.round(Number(args.delayMs) || 0)));
  const frameId = args.frameId || 0;
  const typingArgs = { browserId: args.browserId, tabId: tab.id, snapshotId: args.snapshotId, elementId: args.elementId };
  const { run, cleanup } = createTypingRun(tab.id);
  let attached = false;
  let prepared = null;
  let plan = null;
  let stopReason = null;
  let typedCharacters = 0;
  let finishResult = null;
  let index = 0;
  try {
    await attachDebugger(tab.id);
    attached = true;
    const [prepare] = await pageAction(tab.id, frameId, 'type_prepare', args, grant, deadline);
    if (!prepare || prepare.error) throw typingError('TYPE_PREPARE_FAILED', prepare?.error || '无法准备输入目标。');
    prepared = prepare;
    plan = planTyping(text, { multiline: !!prepared.multiline });
    for (const segment of plan.segments) {
      const aborted = abortOf(run);
      if (aborted) { stopReason = aborted; break; }
      if (Date.now() > deadline - 800) {
        stopReason = { code: 'DEADLINE_EXCEEDED', message: '已接近本次调用时限，逐字输入提前停止。' };
        break;
      }
      if (index % 4 === 0) {
        try {
          if (index % 8 === 0) {
            const activeTab = await chrome.tabs.get(tab.id);
            if (!activeTab.active) { stopReason = { code: 'TAB_NOT_ACTIVE', message: '目标标签页已不在前台，逐字输入已停止。' }; break; }
          }
          const [focus] = await pageAction(tab.id, frameId, 'type_focus', typingArgs, grant, deadline);
          if (!focus || focus.error) { stopReason = { code: 'TYPE_SESSION_LOST', message: focus?.error || '输入会话已失效。' }; break; }
          if (!focus.focused) { stopReason = { code: 'FOCUS_LOST', message: '焦点已离开目标控件，逐字输入已停止。' }; break; }
        } catch (error) {
          const abortedNow = abortOf(run);
          stopReason = abortedNow || { code: 'FOCUS_CHECK_FAILED', message: `无法确认输入焦点：${String(error?.message || error)}` };
          break;
        }
      }
      try {
        await sendTypingSegment(tab.id, segment);
        typedCharacters++;
      } catch (error) {
        stopReason = { code: 'CDP_ERROR', message: `Chrome 输入失败：${String(error?.message || error)}` };
        break;
      }
      index++;
      if (delayMs && index < plan.segments.length) await sleep(delayMs);
    }
  } catch (error) {
    if (!plan) throw error;
    stopReason = stopReason || { code: error.code || 'TYPING_FAILED', message: String(error.message || error) };
  } finally {
    cleanup();
    if (!plan && attached) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }
  }
  try {
    const [finish] = await pageAction(tab.id, frameId, 'type_finish', { browserId: args.browserId, tabId: tab.id, snapshotId: args.snapshotId, elementId: args.elementId, expectedText: plan?.insertedText || '' }, grant, 0, { enforce: false });
    finishResult = finish;
  } catch (error) {
    finishResult = { verified: false, focusHeld: false, gone: true, error: String(error?.message || error) };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }
  }
  const complete = !stopReason;
  return {
    complete,
    characters: plan?.characters ?? 0,
    typedCharacters,
    skippedCharacters: plan?.skippedCharacters ?? 0,
    delayMs,
    verified: !!finishResult?.verified,
    focusHeld: !!finishResult?.focusHeld,
    valueLength: finishResult?.valueLength,
    selectionStart: finishResult?.selectionStart,
    selectionEnd: finishResult?.selectionEnd,
    ...(stopReason ? { stopReason } : {}),
    next: complete
      ? '逐字输入已结束；请读取新快照确认页面结果。'
      : `逐字输入未完成（已输入 ${typedCharacters} 个字符）；请读取页面确认，不要自动重放整段文本。`
  };
}

async function evaluatePage(tab, args, deadline) {
  if (!settings.evalConsent) throw typingError('EVAL_CONSENT_REQUIRED', '页面脚本执行需要在扩展设置中明确启用高级调试能力。');
  if (!await chrome.permissions.contains({ permissions: ['debugger'] })) {
    throw typingError('DEBUGGER_PERMISSION_REQUIRED', '扩展尚未获得 debugger 权限，请重新加载扩展并在提示中接受新权限。');
  }
  const expression = typeof args.expression === 'string' ? args.expression : '';
  if (!expression.trim()) throw typingError('EXPRESSION_REQUIRED', '页面脚本执行需要非空 expression。');
  const frameId = args.frameId || 0;
  const timeoutMs = Math.min(10000, Math.max(1000, Math.round(Number(args.timeoutMs) || 5000)));
  let attached = false;
  const contexts = [];
  const onEvent = (source, method, params) => {
    if (source.tabId === tab.id && method === 'Runtime.executionContextCreated') contexts.push(params.context);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await attachDebugger(tab.id);
    attached = true;
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable');
    await sleep(50);
    const context = contexts.find(item => String(item.auxData?.frameId) === String(frameId) && item.auxData?.isDefault);
    const evaluation = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
      expression,
      ...(context ? { contextId: context.id } : {}),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: timeoutMs
    });
    if (evaluation.exceptionDetails) {
      const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || '页面脚本执行失败';
      throw typingError('EVAL_EXCEPTION', String(detail).split('\n')[0].slice(0, 300));
    }
    let value = evaluation.result?.value;
    if (value === undefined && evaluation.result?.unserializableValue) value = evaluation.result.unserializableValue;
    if (value === undefined && evaluation.result?.description) value = evaluation.result.description;
    let serialized = null;
    try { serialized = JSON.stringify(value); } catch {}
    const truncated = typeof serialized === 'string' && serialized.length > 120000;
    if (truncated) value = serialized.slice(0, 120000);
    const current = await chrome.tabs.get(tab.id);
    return {
      evaluated: true,
      frameId,
      result: value,
      truncated,
      url: current.url,
      next: '脚本已在页面主环境执行；请读取新快照确认页面结果。'
    };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (attached) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }
  }
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
  if (action === 'type_text') return typeText(tab, grant, args, deadline);
  if (action === 'eval') return evaluatePage(tab, args, deadline);
  if (action === 'select_tab') {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { selected: true, tabId: tab.id };
  }
  if (action === 'snapshot') {
    const frames = await pageAction(tab.id, args.frameId ?? 0, 'snapshot', args, grant, deadline);
    if (!frames.length || frames[0].error) throw new Error(frames[0]?.error || 'FRAME_UNAVAILABLE');
    const availableFrames = args.includeFrames
      ? (await pageAction(tab.id, null, 'frame_info', args, grant, deadline))
          .filter(frame => !frame.error && frame.frameId !== 0).map(frame => frame.frameId)
      : undefined;
    await assertTarget(args, deadline);
    return { browserId: settings.browserId, tabId: tab.id, frames, availableFrames };
  }
  if (['click', 'fill', 'press_key', 'scroll', 'inspect'].includes(action)) {
    const values = await pageAction(tab.id, action === 'scroll' ? 0 : (args.frameId || 0), action, args, grant, deadline);
    if (!values.length || values[0].error) throw new Error(values[0]?.error || 'FRAME_UNAVAILABLE');
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
    return { initiated: true, verified: false };
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
        const [probe] = await pageAction(tab.id, args.frameId ?? 0, 'probe', args, grant, deadline);
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
    if (message.type === 'ui_status') return { connected, paused: state.paused, grants: state.grants, lastAction, connectionError, browserId: settings.browserId, browserName: browserName(), typingConsent: !!settings.typingConsent, evalConsent: !!settings.evalConsent, debuggerPermission: await chrome.permissions.contains({ permissions: ['debugger'] }) };
    if (message.type === 'browser_name') {
      if (typeof message.name !== 'string' || message.name.length > 60 || /[\x00-\x1f\x7f]/.test(message.name)) throw new Error('浏览器名称最多 60 个字符。');
      settings.browserName = message.name.trim();
      await chrome.storage.local.set({ browserName: settings.browserName });
      publish();
      return { name: browserName() };
    }
    if (message.type === 'typing_consent') {
      const enabled = !!message.enabled;
      if (enabled && !await chrome.permissions.contains({ permissions: ['debugger'] })) throw new Error('扩展尚未获得 debugger 权限，请重新加载扩展后再启用逐字输入。');
      settings.typingConsent = enabled;
      await chrome.storage.local.set({ typingConsent: enabled });
      return { typingConsent: enabled };
    }
    if (message.type === 'eval_consent') {
      const enabled = !!message.enabled;
      if (enabled && !await chrome.permissions.contains({ permissions: ['debugger'] })) throw new Error('扩展尚未获得 debugger 权限，请重新加载扩展后再启用页面脚本执行。');
      settings.evalConsent = enabled;
      await chrome.storage.local.set({ evalConsent: enabled });
      return { evalConsent: enabled };
    }
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
