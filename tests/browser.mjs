import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, localDir } from '../bridge/config.mjs';
import { ensureDaemon, stopDaemon } from '../bridge/client.mjs';

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
  await options.locator('#form button[type=submit]').click();
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
    const args = { ...target, query: label, maxText: 0 };
    const first = await tool('browser_snapshot', { ...args, includeFrames: true });
    const frameIds = [0, ...first.availableFrames];
    for (const frameId of frameIds) {
      let frame = frameId === 0 ? first.frames[0] : (await tool('browser_snapshot', { ...args, frameId })).frames[0];
      while (true) {
        const element = frame.elements.find(element => !tag || element.tag === tag);
        if (element) return { ...target, frameId, snapshotId: frame.snapshotId, elementId: element.elementId };
        if (frame.nextOffset === null) break;
        frame = (await tool('browser_snapshot', { ...args, frameId, snapshotId: frame.snapshotId, offset: frame.nextOffset })).frames[0];
      }
    }
    throw new Error(`Element not found: ${label}`);
  }
  await step('MCP 工具发现和真实页面读取', async () => {
    const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'browser_inspect'));
    const snap = await snapshot();
    assert.match(snap.frames[0].text, /浏览器控制验收页面/);
    assert.ok(!JSON.stringify(snap).includes('do-not-send'));
  });
  await step('大型页面默认精简，控件和正文均可翻页，并可搜索末尾控件', async () => {
    await page.evaluate(() => {
      const section = document.createElement('section');
      section.id = 'large-snapshot-test';
      const paragraph = document.createElement('p');
      paragraph.textContent = '示例文字 '.repeat(1800) + '正文结束标记';
      section.append(paragraph);
      for (let index = 0; index < 220; index++) {
        const field = document.createElement('input');
        field.setAttribute('aria-label', `批量字段 ${index}`);
        field.value = '示例值'.repeat(160);
        section.append(field);
      }
      const last = document.createElement('button');
      last.textContent = '末尾独立按钮';
      last.addEventListener('click', () => { paragraph.textContent = '末尾按钮已点击'; });
      section.append(last);
      document.body.append(section);
    });
    try {
      const first = await snapshot();
      const frame = first.frames[0];
      assert.equal(first.frames.length, 1);
      assert.equal(frame.frameId, 0);
      assert.equal(frame.elements.length, 20);
      assert.equal(frame.text.length, 1500);
      assert.ok(frame.totalElements > 220);
      assert.ok(frame.elements.every(element => !('value' in element) && !('options' in element)));
      assert.ok(Buffer.byteLength(JSON.stringify(first)) < 8000);
      assert.equal(first.verification.portMatches, true);
      assert.equal(first.verification.pairing, 'verified');
      assert.equal(first.verification.configuredPort, Number(testPort));
      assert.equal(first.verification.servicePort, Number(testPort));
      assert.ok(!('instanceName' in first.verification));
      await assert.rejects(tool('browser_snapshot', { ...target, offset: frame.nextOffset }), /SNAPSHOT_ID_REQUIRED/);
      const second = (await tool('browser_snapshot', { ...target, snapshotId: frame.snapshotId, offset: frame.nextOffset })).frames[0];
      assert.equal(second.snapshotId, frame.snapshotId);
      assert.equal(second.elements.length, 20);
      assert.ok(!('text' in second));
      assert.ok(!second.elements.some(element => frame.elements.some(firstElement => firstElement.elementId === element.elementId)));
      const moreText = (await tool('browser_snapshot', { ...target, snapshotId: frame.snapshotId, limit: 0, maxText: 20000, textOffset: frame.nextTextOffset })).frames[0];
      assert.deepEqual(moreText.elements, []);
      assert.equal(moreText.nextTextOffset, null);
      assert.match(moreText.text, /正文结束标记/);
      const [match] = (await tool('browser_snapshot', { ...target, snapshotId: frame.snapshotId, query: '末尾独立按钮', maxText: 0 })).frames[0].elements;
      assert.ok(match);
      await tool('browser_click', { ...target, snapshotId: frame.snapshotId, elementId: match.elementId });
      const signal = await tool('browser_wait', { ...target, text: '末尾按钮已点击', timeoutMs: 3000 });
      assert.equal(signal.matched, true);
      await assert.rejects(tool('browser_snapshot', { ...target, snapshotId: frame.snapshotId, offset: frame.nextOffset }), /STALE_SNAPSHOT/);
    } finally {
      await page.locator('#large-snapshot-test').evaluate(node => node.remove());
    }
  });
  await step('局部控件详情、下拉选项翻页与隐私拒绝', async () => {
    await page.locator('#choice').evaluate(node => {
      for (let index = 0; index < 50; index++) node.add(new Option(`额外选项 ${index}`, `extra-${index}`));
    });
    try {
      const select = await locate('选项', 'select');
      const first = await tool('browser_inspect', select);
      assert.equal(first.value, 'a');
      assert.equal(first.optionCount, 52);
      assert.equal(first.options.length, 25);
      const second = await tool('browser_inspect', { ...select, optionsOffset: first.nextOptionsOffset });
      assert.equal(second.options[0].value, 'extra-23');
      const third = await tool('browser_inspect', { ...select, optionsOffset: second.nextOptionsOffset });
      assert.equal(third.options.length, 2);
      assert.equal(third.nextOptionsOffset, null);
      const editor = await locate('逐字编辑器');
      await page.locator('#typed-editor').evaluate(node => {
        node.innerHTML = '<span data-private>do-not-send-inner</span>';
      });
      try {
        const detail = await tool('browser_inspect', editor);
        assert.equal(detail.valueRedacted, true);
        assert.ok(!JSON.stringify(detail).includes('do-not-send-inner'));
      } finally {
        await page.locator('#typed-editor').evaluate(node => { node.textContent = ''; });
      }
      const field = await locate('搜索关键词', 'input');
      await page.locator('#query').evaluate(node => node.setAttribute('data-private', ''));
      try {
        await assert.rejects(tool('browser_inspect', field), /PRIVATE_FIELD/);
        const current = (await tool('browser_snapshot', { ...target, snapshotId: field.snapshotId, query: '搜索关键词', maxText: 0 })).frames[0];
        assert.deepEqual(current.elements, []);
      } finally {
        await page.locator('#query').evaluate(node => node.removeAttribute('data-private'));
      }
    } finally {
      await page.locator('#choice').evaluate(node => { node.options.length = 2; });
    }
  });
  await step('填写搜索框、点击搜索、读取真实结果', async () => {
    const fill = await tool('browser_fill', { ...await locate('搜索关键词', 'input'), text: 'GPT 插件验收' });
    assert.equal(fill.verified, true);
    assert.ok(!JSON.stringify(fill).includes('GPT 插件验收'));
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
    const framed = await locate('框架按钮');
    assert.notEqual(framed.frameId, 0);
    assert.equal((await tool('browser_wait', { ...target, frameId: framed.frameId, text: '框架按钮' })).matched, true);
    await tool('browser_click', framed);
    assert.equal(await page.locator('#choice').inputValue(), 'b'); assert.equal(await page.locator('#check').isChecked(), true);
  });
  await step('逐字输入：未启用权限时明确拒绝，启用后逐字输入并核验', async () => {
    await page.bringToFront();
    await tool('browser_select_tab', target);
    const input = await locate('逐字文本框', 'input');
    await assert.rejects(tool('browser_type_text', { ...input, text: 'Hello 世界\n!' }), /TYPING_CONSENT_REQUIRED/);
    await options.locator('#typing-consent').check();
    await options.locator('#typing-note').filter({ hasText: '逐字输入已启用' }).waitFor();
    const result = await tool('browser_type_text', { ...input, text: 'Hello 世界\n!' });
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(result.verified, true);
    assert.equal(result.characters, 10);
    assert.equal(result.typedCharacters, 9);
    assert.equal(result.skippedCharacters, 1);
    assert.equal(result.focusHeld, true);
    assert.equal(await page.locator('#typed').inputValue(), 'Hello 世界!');
    const events = await page.evaluate(() => window.__typingEvents.filter(event => event.id === 'typed'));
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.trusted));
    assert.ok(events.every(event => event.inputType));
    assert.ok(!JSON.stringify(result).includes('世界'));
    assert.ok(!JSON.stringify(await send({ type: 'ui_status' })).includes('世界'));
  });
  await step('页面脚本执行需单独同意并返回结果', async () => {
    await page.bringToFront();
    await tool('browser_select_tab', target);
    await assert.rejects(tool('browser_eval', { ...target, expression: 'document.title' }), /EVAL_CONSENT_REQUIRED/);
    await options.locator('#eval-consent').check();
    await options.locator('#eval-note').filter({ hasText: '页面脚本执行已启用' }).waitFor();
    const result = await tool('browser_eval', { ...target, expression: '({title: document.title, value: 6 * 7})' });
    assert.equal(result.evaluated, true);
    assert.match(result.result.title, /浏览器控制验收页面/);
    assert.equal(result.result.value, 42);
    await options.locator('#eval-consent').uncheck();
  });
  await step('逐字输入 textarea：中文、emoji、换行且不提交表单', async () => {
    const area = await locate('逐字文本域', 'textarea');
    const result = await tool('browser_type_text', { ...area, text: '第一行\n第二行 😀', delayMs: 1 });
    assert.equal(result.complete, true);
    assert.equal(result.verified, true);
    assert.equal(result.characters, 9);
    assert.equal(await page.locator('#typed-area').inputValue(), '第一行\n第二行 😀');
    assert.equal(await page.evaluate(() => window.__typedSubmits()), 0);
    const events = await page.evaluate(() => window.__typingEvents.filter(event => event.id === 'typed-area'));
    assert.ok(events.length > 0 && events.every(event => event.trusted));
  });
  await step('逐字输入 contenteditable：中文、emoji 和换行', async () => {
    const editor = await locate('逐字编辑器', 'div');
    const result = await tool('browser_type_text', { ...editor, text: '编辑器：中文 😀\n换行' });
    assert.equal(result.complete, true);
    assert.equal(result.verified, true);
    assert.equal(await page.locator('#typed-editor').innerText(), '编辑器：中文 😀\n换行');
    assert.equal(await page.evaluate(() => window.__typedSubmits()), 0);
  });
  await step('逐字输入保留光标与选区语义', async () => {
    await page.evaluate(() => {
      const input = document.querySelector('#typed');
      input.value = 'prefix-suffix';
      input.focus();
      input.setSelectionRange(7, 13);
    });
    const input = await locate('逐字文本框', 'input');
    const replaced = await tool('browser_type_text', { ...input, text: 'X' });
    assert.equal(replaced.verified, true, JSON.stringify(replaced));
    assert.equal(await page.locator('#typed').inputValue(), 'prefix-X');
    await page.evaluate(() => {
      const input = document.querySelector('#typed');
      input.value = 'append';
      document.querySelector('#query').focus();
    });
    const unfocused = await locate('逐字文本框', 'input');
    const appended = await tool('browser_type_text', { ...unfocused, text: '!' });
    assert.equal(appended.verified, true, JSON.stringify(appended));
    assert.equal(await page.locator('#typed').inputValue(), 'append!');
  });
  await step('密码和文件输入仍被拒绝逐字输入', async () => {
    const input = await locate('逐字文本框', 'input');
    await page.evaluate(() => { document.querySelector('#typed').type = 'password'; });
    await assert.rejects(tool('browser_type_text', { ...input, text: 'secret' }), /PRIVATE_FIELD/);
    await page.evaluate(() => { document.querySelector('#typed').type = 'file'; });
    await assert.rejects(tool('browser_type_text', { ...input, text: 'secret' }), /PRIVATE_FIELD/);
    await page.evaluate(() => { document.querySelector('#typed').type = 'text'; });
  });
  await step('暂停时逐字输入安全停止并报告部分结果，不自动重放', async () => {
    await page.bringToFront();
    await tool('browser_select_tab', target);
    const input = await locate('逐字文本框', 'input');
    await page.evaluate(() => { document.querySelector('#typed').value = ''; });
    const pending = tool('browser_type_text', { ...input, text: 'abcdefghijklmnopqrstuvwxyz', delayMs: 60 });
    await new Promise(resolve => setTimeout(resolve, 250));
    await send({ type: 'pause' });
    const partial = await pending;
    assert.equal(partial.complete, false);
    assert.match(partial.stopReason.code, /USER_PAUSED/);
    assert.ok(partial.typedCharacters > 0 && partial.typedCharacters < partial.characters);
    const length = (await page.locator('#typed').inputValue()).length;
    assert.equal(length, partial.typedCharacters);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await page.locator('#typed').inputValue()).length, length);
    await send({ type: 'resume' });
  });
  await step('焦点离开目标控件时停止并报告部分结果', async () => {
    await page.bringToFront();
    await tool('browser_select_tab', target);
    const input = await locate('逐字文本框', 'input');
    await page.evaluate(() => { document.querySelector('#typed').value = ''; });
    const pending = tool('browser_type_text', { ...input, text: '0123456789abcdefghij', delayMs: 60 });
    await new Promise(resolve => setTimeout(resolve, 200));
    await page.evaluate(() => document.querySelector('#query').focus());
    const partial = await pending;
    assert.equal(partial.complete, false);
    assert.match(partial.stopReason.code, /FOCUS_LOST|FOCUS_CHECK_FAILED/);
    assert.ok(partial.typedCharacters < partial.characters);
  });
  await step('标签页切到后台时安全停止逐字输入', async () => {
    const input = await locate('逐字文本框', 'input');
    await page.evaluate(() => { document.querySelector('#typed').value = ''; });
    await tool('browser_select_tab', target);
    const pending = tool('browser_type_text', { ...input, text: 'abcdefghijklmnopqrstuvwxyz', delayMs: 60 });
    await new Promise(resolve => setTimeout(resolve, 200));
    await options.bringToFront();
    const partial = await pending;
    assert.equal(partial.complete, false);
    assert.match(partial.stopReason.code, /TAB_CHANGED|TAB_NOT_ACTIVE/);
    assert.ok(partial.typedCharacters < partial.characters);
    await page.bringToFront();
    await tool('browser_select_tab', target);
  });
  await step('逐字输入结束后释放 Chrome 调试连接', async () => {
    const stillAttached = await options.evaluate(async tabId => {
      try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); return true; }
      catch { return false; }
    }, tab.id);
    assert.equal(stillAttached, false);
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
  await step('两个独立 Chromium 配置同时配对，按面板分配操作，目标离线时拒绝改走另一台', async () => {
    const context2 = await chromium.launchPersistentContext(path.join(localDir, 'second-browser-profile'), {
      channel: process.env.BROWSER_TEST_CHANNEL || 'chromium', headless: true,
      args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`]
    });
    try {
      const worker2 = context2.serviceWorkers()[0] || await context2.waitForEvent('serviceworker');
      const options2 = await context2.newPage();
      await options2.goto(`chrome-extension://${new URL(worker2.url()).host}/options.html`);
      await options2.locator('#browser-name[data-initialized=true]').fill('验收浏览器 B');
      await options2.locator('#browser-form button').click();
      await options2.locator('#message').filter({ hasText: '浏览器名称已保存。' }).waitFor();
      await options2.locator('#pairing-code').fill(`bc1:${testPort}:${extensionToken}`);
      await options2.locator('#form button[type=submit]').click();
      await options2.locator('#status').filter({ hasText: '已连接本地服务' }).waitFor();
      const page2 = await context2.newPage();
      const url2 = `${url}/?second-browser`;
      await page2.goto(url2);
      await page2.evaluate(() => { document.querySelector('h1').textContent = '这是第二台浏览器'; });
      const tab2 = await worker2.evaluate(async value => (await chrome.tabs.query({})).find(tab => tab.url === value), url2);
      await options2.evaluate(async ({ id, origin }) => {
        const result = await chrome.runtime.sendMessage({ type: 'grant', tabId: id, origin });
        if (result.error) throw new Error(result.error);
      }, { id: tab2.id, origin: url });
      const admin = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${testPort}${route}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: body && JSON.stringify(body)
        });
        assert.ok(response.ok);
        return response.json();
      };
      const panel = await admin('/status');
      const id2 = panel.browsers.find(browser => browser.name === '验收浏览器 B').id;
      assert.equal(panel.browsers.filter(browser => browser.connected).length, 2);
      assert.notEqual(id2, target.browserId);
      const sourceId = (await tool('browser_status')).verification.instance;
      await assert.rejects(tool('browser_tabs'), /BROWSER_NOT_ASSIGNED/);
      await admin('/instances/browser', { id: sourceId, browserId: id2 });
      const list = await tool('browser_tabs');
      assert.equal(list.browserId, id2);
      assert.deepEqual(list.tabs.map(tab => tab.url), [url2]);
      const result = await tool('browser_snapshot', { browserId: id2, tabId: tab2.id });
      assert.match(result.frames[0].text, /这是第二台浏览器/);
      await assert.rejects(snapshot(), /INVALID_TARGET/);
      const saved = JSON.parse(await readFile(path.join(localDir, `browser-routing-${testPort}.json`), 'utf8'));
      assert.equal(saved.assignments[sourceId], id2);
      await options2.locator('#disconnect').click();
      for (let index = 0; index < 25 && (await tool('browser_status')).connected; index++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await assert.rejects(tool('browser_tabs'), /BROWSER_OFFLINE/);
      await stopDaemon();
      await ensureDaemon({ explicit: true });
      await assert.rejects(tool('browser_tabs'), /BROWSER_OFFLINE/);
      await admin('/instances/browser', { id: sourceId, browserId: target.browserId });
      assert.equal((await tool('browser_status')).browserId, target.browserId);
    } finally { await context2.close(); }
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
