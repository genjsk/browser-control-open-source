#!/usr/bin/env node
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { prepareDataDirectory } from '../bridge/paths.mjs';

const command = process.argv[2] || 'setup';
const json = process.argv.includes('--json');
try {
  process.env.BROWSER_CONTROL_DATA_DIR = prepareDataDirectory().dataDir;
}
catch (error) { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exit(1); }
const { api, localDir, port, root, writeJson } = await import('../bridge/config.mjs');
const { ensureDaemon, stopDaemon } = await import('../bridge/client.mjs');
const { integrationInfo, installCodex, prepareDsh, registerRuntime } = await import('./integration.mjs');
const { listInstances, setInstancePaused } = await import('../bridge/instances.mjs');

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function openFile(file) {
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:BROWSER_CONTROL_DOCUMENT -WindowStyle Hidden'], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, BROWSER_CONTROL_DOCUMENT: file }
    });
    child.on('error', () => {}); child.unref();
  } else {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
}
try {
  let output;
  if (['start', 'restart', 'setup'].includes(command)) {
    await registerRuntime();
    if (command === 'restart') await stopDaemon();
    const state = await ensureDaemon({ explicit: true });
    output = { running: true, ...state, message: `本地服务已运行，浏览器${state.connected ? '已连接' : '等待配对'}。` };
    if (command === 'setup') {
      const info = await integrationInfo();
      const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Browser Control · 开始使用</title><style>body{font:16px/1.8 system-ui;background:#f1f5f9;color:#1e293b}main{max-width:780px;margin:40px auto;background:white;padding:32px;border-radius:16px}input{width:100%;padding:12px;box-sizing:border-box}code{overflow-wrap:anywhere}</style><main><h1>连接浏览器，只需三步</h1><ol><li>打开 Chrome 的 chrome://extensions 或 Edge 的 edge://extensions，开启开发者模式，选择“加载已解压的扩展程序”，选择：<br><code>${escape(info.extensionDir)}</code></li><li>打开扩展的“连接设置”，粘贴下面整段配对码：<input readonly value="${escape(info.pairingCode)}"></li><li>打开要操作的网页，点击扩展图标 → 允许 AI 操作当前网页。</li></ol><h2>接入 AI</h2><p>在控制面板点击“接入 AI”，复制 MCP JSON 或使用对应客户端安装入口。源码方式可运行 npm run mcp。</p><p>断开服务后不会自动恢复；配对码仅供本机使用。网页文字和截图作为工具结果会进入 AI 会话。</p></main></html>`;
      const guide = path.join(localDir, 'start.html');
      await writeFile(guide, page, { mode: 0o600 });
      output.guide = guide;
      if (!process.argv.includes('--no-open')) openFile(guide);
    }
  } else if (command === 'stop') {
    const stopped = await stopDaemon({ manual: true });
    output = { running: false, message: stopped ? '已断开；需要使用时点击“连接”。' : '服务已断开。' };
  } else if (command === 'status') {
    try { output = { running: true, ...await api('/status', undefined, 1500) }; }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED' || error.code === 'SERVICE_NOT_RUNNING') output = { running: false }; else throw error; }
  } else if (command === 'info') output = await integrationInfo();
  else if (command === 'ai-instances') output = { servicePort: port, instances: await listInstances() };
  else if (command === 'ai-instance-pause' || command === 'ai-instance-resume') {
    const id = process.argv[3];
    const paused = command === 'ai-instance-pause';
    output = { instance: await setInstancePaused(id, paused), message: paused ? '已暂停该 AI 接入实例的调用。' : '已恢复该 AI 接入实例的调用。' };
  }
  else if (command === 'integrate-codex') output = await installCodex();
  else if (command === 'prepare-dsh') output = await prepareDsh();
  else if (command === 'prepare-codex-plugin') output = await (await import('./codex-plugin.mjs')).prepareCodexPlugin();
  else if (command === 'install-codex-plugin') output = await (await import('./codex-plugin.mjs')).installCodexPlugin();
  else if (command === 'migrate-storage') {
    const { migrateStorage } = await import('./storage-migration.mjs');
    output = await migrateStorage({ source: localDir, target: process.argv[3], root, stopServices: async () => {
      await stopDaemon({ manual: true });
      for (const name of await readdir(localDir)) {
        const match = /^credentials-(\d+)\.json$/.exec(name);
        if (!match || Number(match[1]) === port) continue;
        const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'cli.mjs'), 'stop', '--json', '--no-open'], {
          cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, BROWSER_BRIDGE_PORT: match[1] }
        });
        if (result.status !== 0) throw new Error('无法断开旧目录中的其他服务，迁移已取消，原数据保持不变。');
      }
    } });
  }
  else if (command === 'set-port') {
    const nextPort = Number(process.argv[3]);
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) throw new Error('端口应为 1024–65535。');
    await stopDaemon({ manual: true });
    let settings = {};
    try { settings = JSON.parse(await readFile(path.join(localDir, 'settings.json'), 'utf8')); } catch {}
    await writeJson(path.join(localDir, 'settings.json'), { ...settings, port: nextPort });
    output = { port: nextPort, message: '端口已更新，请重新连接、重新配对浏览器，并重启 AI 客户端以加载新设置。' };
  } else throw new Error('Commands: setup, start, stop, restart, status, info, ai-instances, ai-instance-pause <id>, ai-instance-resume <id>, integrate-codex, prepare-dsh, prepare-codex-plugin, install-codex-plugin, set-port <number>, migrate-storage <directory>');
  console.log(json ? JSON.stringify(output) : (output.message || JSON.stringify(output, null, 2)));
} catch (error) {
  console.error(json ? JSON.stringify({ error: error.message }) : error.message);
  process.exitCode = 1;
}
