const $ = id => document.getElementById(id);
let active;
async function send(message) { const response = await chrome.runtime.sendMessage(message); if (response.error) throw new Error(response.error); return response.result; }
async function refresh() {
  const state = await send({ type: 'ui_status' });
  $('status').textContent = state.connected ? (state.paused ? '已连接 · 已暂停' : '已连接 · AI 可操作授权网页') : `未连接 · ${state.connectionError || '请打开连接设置完成配对'}`;
  $('status').classList.toggle('connected', state.connected);
  [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('grant').disabled = !state.connected || !/^https?:\/\//.test(active?.url || '');
  $('tabs').replaceChildren();
  for (const [id, grant] of Object.entries(state.grants)) {
    const row = document.createElement('div'); row.className = 'tab';
    row.textContent = `标签页 ${id} · ${grant.origin}`;
    const button = document.createElement('button'); button.textContent = '撤销'; button.className = 'secondary';
    button.addEventListener('click', () => run(() => send({ type: 'revoke', tabId: Number(id) })));
    row.append(button); $('tabs').append(row);
  }
  $('last').textContent = `最近操作：${state.lastAction}`;
}
async function run(action) { try { $('message').textContent = ''; await action(); await refresh(); } catch (error) { $('message').textContent = error.message; } }
$('grant').addEventListener('click', () => run(async () => {
  const origin = new URL(active.url).origin;
  const parsed = new URL(origin);
  if (!await chrome.permissions.request({ origins: [`${parsed.protocol}//${parsed.hostname}/*`] })) throw new Error('未授予网页权限');
  await send({ type: 'grant', tabId: active.id, origin });
}));
$('pause').addEventListener('click', () => run(() => send({ type: 'pause' })));
$('resume').addEventListener('click', () => run(() => send({ type: 'resume' })));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
void run(refresh);
setInterval(() => { void refresh().catch(() => {}); }, 2000);
