const $ = id => document.getElementById(id);
async function send(message) { const response = await chrome.runtime.sendMessage(message); if (response.error) throw new Error(response.error); return response.result; }
const saved = await chrome.storage.local.get('port');
$('port').value = saved.port || 19487;
$('form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const code = $('pairing-code').value.trim();
    const match = /^bc1:(\d{4,5}):([a-f0-9]{64})$/.exec(code);
    if (code && !match) throw new Error('配对码格式不正确，请完整复制控制面板中的配对码。');
    await send({ type: 'configure', token: match ? match[2] : $('token').value.trim(), port: match ? Number(match[1]) : Number($('port').value) });
    $('token').value = ''; $('pairing-code').value = ''; $('message').className = 'success'; $('message').textContent = '已保存，正在连接。连接后请到目标网页授权。';
  } catch (error) { $('message').className = ''; $('message').textContent = error.message; }
});
$('disconnect').addEventListener('click', async () => {
  await send({ type: 'disconnect' }); $('message').textContent = '已断开并撤销授权。';
});
$('typing-consent').addEventListener('change', async () => {
  const enabled = $('typing-consent').checked;
  try {
    await send({ type: 'typing_consent', enabled });
    $('typing-note').textContent = enabled ? '逐字输入已启用；Chrome 调试期间会显示提示条。' : '未启用逐字输入；browser_type_text 会被拒绝。';
  } catch (error) {
    $('typing-consent').checked = !enabled;
    $('typing-note').textContent = error.message;
  }
});
async function refresh() {
  const state = await send({ type: 'ui_status' });
  $('status').textContent = state.connected ? '已连接本地服务' : `尚未连接：${state.connectionError || '请填写配对信息'}`;
  $('status').classList.toggle('connected', state.connected);
  $('typing-consent').checked = !!state.typingConsent;
  $('typing-note').textContent = !state.debuggerPermission
    ? '扩展缺少 debugger 权限，请重新加载扩展。'
    : state.typingConsent ? '逐字输入已启用。' : '未启用逐字输入；browser_type_text 会被拒绝。';
}
void refresh(); setInterval(() => { void refresh(); }, 2000);
