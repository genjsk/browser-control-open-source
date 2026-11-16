import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, localDir } from '../bridge/config.mjs';
import { ensureDaemon } from '../bridge/client.mjs';

// Use Playwright's standard browser cache or PLAYWRIGHT_BROWSERS_PATH override.
const { chromium } = await import('playwright');
const testPort = '19517';
const fixture = await readFile(path.join(root, 'tests', 'fixture.html'));
const web = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/frame') res.end('<!doctype html><button>框架按钮</button>');
  else res.end(fixture);
});
web.listen(0, '127.0.0.1'); await once(web, 'listening');
const url = `http://127.0.0.1:${web.address().port}`;
const results = [];
let context, transport, client;
async function step(name, action) { await action(); results.push(name); console.log(`PASS ${name}`); }
try {
  // 相当于用户在控制面板点击“连接”：测试先显式启动服务，MCP 客户端自己绝不启动。
  await ensureDaemon({ explicit: true });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bridge', 'mcp.mjs')], env: { ...process.env, BROWSER_BRIDGE_PORT: testPort }, stderr: 'pipe' });
  client = new Client({ name: 'browser-integration-test', version: '1.0.0' });
  await client.connect(transport);
  async function tool(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(response.content[0].text);
    if (name === 'browser_screenshot') return response;
    return JSON.parse(response.content[0].text);
  }
  await tool('browser_status');
  const { extensionToken, adminToken } = JSON.parse(await readFile(path.join(localDir, `credentials-${testPort}.json`), 'utf8'));
  context = await chromium.launchPersistentContext(path.join(localDir, `test-profile-${Date.now()}`), {
    channel: process.env.BROWSER_TEST_CHANNEL || 'chromium', headless: true,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`],
    viewport: { width: 1200, height: 900 }
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#pairing-code').fill(`bc1:${testPort}:${extensionToken}`);
  await options.locator('button[type=submit]').click();
  await options.locator('#status').filter({ hasText: '已连接本地服务' }).waitFor();
  const page = await context.newPage(); await page.goto(url);
  const send = message => options.evaluate(async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (response.error) throw new Error(response.error);
    return response.result;
  }, message);
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === `${url}/`), url);
  let target;
  await step('真实扩展完成配对和标签页授权', async () => {
    await send({ type: 'grant', tabId: tab.id, origin: url });
    const list = await tool('browser_tabs');
    assert.equal(list.tabs.length, 1);
    target = { browserId: list.browserId, tabId: tab.id };
  });
  async function snapshot() { return tool('browser_snapshot', target); }
  async function locate(label, tag) {
    const snapshot = await tool('browser_snapshot', target);
    for (const frame of snapshot.frames) {
      const element = frame.elements?.find(element => element.label.includes(label) && (!tag || element.tag === tag));
      if (element) return { ...target, frameId: frame.frameId, snapshotId: frame.snapshotId, elementId: element.elementId };
    }
    throw new Error(`Element not found: ${label}`);
  }
  await step('MCP 工具发现和真实页面读取', async () => {
    const tools = await client.listTools(); assert.ok(tools.tools.length >= 10);
    const snap = await snapshot();
    assert.match(snap.frames[0].text, /浏览器控制验收页面/);
    assert.ok(!JSON.stringify(snap).includes('do-not-send'));
  });
  await step('填写搜索框、点击搜索、读取真实结果', async () => {
    await tool('browser_fill', { ...await locate('搜索关键词', 'input'), text: 'GPT 插件验收' });
    await tool('browser_click', await locate('搜索', 'button'));
    await tool('browser_wait', { ...target, text: '搜索结果：GPT 插件验收', timeoutMs: 3000 });
    assert.match((await snapshot()).frames[0].text, /搜索结果：GPT 插件验收/);
  });
  await step('DOM 变化后旧快照被拒绝', async () => {
    const stale = await locate('计数');
    await page.evaluate(() => document.querySelector('#counter').textContent = '新的计数按钮');
    await assert.rejects(tool('browser_click', stale), /STALE_SNAPSHOT/);
    assert.equal(await page.locator('#count').innerText(), '0');
  });
  await step('切换活动标签页后仍操作指定页面', async () => {
    await options.bringToFront();
    await tool('browser_click', await locate('新的计数按钮'));
    assert.equal(await page.locator('#count').innerText(), '1');
  });
  await step('页面其他位置变化不再让当前快照失效', async () => {
    const button = await locate('新的计数按钮');
    await page.evaluate(() => { document.querySelector('#result').textContent = '无关的页面变化'; });
    await tool('browser_click', button);
    assert.equal(await page.locator('#count').innerText(), '2');
  });
  await step('下拉框、复选框、开放 Shadow DOM 和同源 iframe', async () => {
    await tool('browser_fill', { ...await locate('选项', 'select'), text: '选项 A' });
    assert.equal(await page.locator('#choice').inputValue(), 'a');
    await tool('browser_fill', { ...await locate('选项', 'select'), text: 'b' });
    await tool('browser_fill', { ...await locate('同意测试', 'input'), checked: true });
    await tool('browser_click', await locate('Shadow 按钮'));
    await tool('browser_click', await locate('框架按钮'));
    assert.equal(await page.locator('#choice').inputValue(), 'b'); assert.equal(await page.locator('#check').isChecked(), true);
  });
  await step('合成 Enter 可提交普通表单', async () => {
    await tool('browser_fill', { ...await locate('搜索关键词', 'input'), text: 'Enter 验收' });
    await tool('browser_press_key', { ...await locate('搜索关键词', 'input'), key: 'Enter' });
    await tool('browser_wait', { ...target, text: '搜索结果：Enter 验收', timeoutMs: 3000 });
  });
  await step('页面滚动与等待截止时间', async () => {
    const value = await tool('browser_scroll', { ...target, y: 600 }); assert.ok(value.y > 0);
    await assert.rejects(tool('browser_wait', { ...target, text: '绝不存在的文字', timeoutMs: 500 }), /TIMEOUT/);
  });
  await step('暂停和撤销授权后拒绝操作', async () => {
    await send({ type: 'pause' });
    await assert.rejects(snapshot(), /PAUSED/);
    await send({ type: 'resume' });
    await send({ type: 'revoke', tabId: tab.id });
    await assert.rejects(snapshot(), /PAUSED|AUTHORIZED/);
    await send({ type: 'grant', tabId: tab.id, origin: url });
  });
  await step('刷新后拒绝旧元素标识', async () => {
    const stale = await locate('新的计数按钮');
    await tool('browser_navigate', { ...target, mode: 'reload' });
    await page.waitForLoadState('load');
    await tool('browser_wait', { ...target, text: '浏览器控制验收页面' });
    await assert.rejects(tool('browser_click', stale), /STALE_SNAPSHOT/);
  });
  await step('禁止未授权的跨来源导航', async () => {
    await assert.rejects(tool('browser_navigate', { ...target, mode: 'url', url: 'https://example.com' }), /NEW_ORIGIN/);
  });
  await step('截图不会偷偷切换或读取其他活动标签页', async () => {
    await options.bringToFront();
    await assert.rejects(tool('browser_screenshot', target), /TAB_NOT_ACTIVE/);
  });
  await step('显式切换授权标签页并通过扩展弹窗获得截图权限', async () => {
    await tool('browser_select_tab', target);
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    const browserCdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tabTarget = targetInfos.find(info => info.url === page.url());
    assert.ok(tabTarget, `Tab target missing for ${targetInfo.targetId}`);
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    await browserCdp.detach();
    await cdp.detach();
    await page.bringToFront();
    await tool('browser_scroll', { ...target, x: 0, y: -10000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const image = await tool('browser_screenshot', target);
    assert.equal(image.content[0].mimeType, 'image/jpeg');
    assert.ok(Buffer.from(image.content[0].data, 'base64').length > 1000);
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results', '工具截图.jpg'), Buffer.from(image.content[0].data, 'base64'));
  });
  await step('断线后暂停，MCP 不会自动启动服务，重连后仍需手动恢复', async () => {
    await fetch(`http://127.0.0.1:${testPort}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    await new Promise(resolve => setTimeout(resolve, 800));
    const ui = await send({ type: 'ui_status' }); assert.equal(ui.paused, true);
    const refused = await client.callTool({ name: 'browser_status', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /本地服务未启动|控制面板/);
    assert.doesNotMatch(refused.content[0].text, /端口已被其他版本或程序使用/);
    await assert.rejects(fetch(`http://127.0.0.1:${testPort}/status`), /fetch failed/);
    // 相当于用户在控制面板再次点击“连接”，服务由面板管理，而不是 MCP 插件。
    await ensureDaemon({ explicit: true });
    for (let i = 0; i < 40; i++) { if ((await tool('browser_status')).connected) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    const status = await tool('browser_status'); assert.equal(status.connected, true); assert.equal(status.paused, true);
  });
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results', '验收页面.png') });
  await writeFile(path.join(root, 'test-results', 'browser-results.json'), JSON.stringify({ date: new Date().toISOString(), channel: process.env.BROWSER_TEST_CHANNEL || 'chromium', browser: context.browser()?.version(), passed: results }, null, 2));
  console.log(`全部 ${results.length} 项浏览器验收通过。`);
} finally {
  await context?.close();
  await client?.close();
  try {
    const { adminToken } = JSON.parse(await readFile(path.join(localDir, `credentials-${testPort}.json`), 'utf8'));
    await fetch(`http://127.0.0.1:${testPort}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  } catch {}
  web.close();
}
