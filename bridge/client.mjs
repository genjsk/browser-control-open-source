import { spawn } from 'node:child_process';
import { open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, credentials, root, logFile, disabledFile, assertConnectionEnabled } from './config.mjs';

export async function stopDaemon({ manual = false } = {}) {
  if (manual) {
    await credentials();
    await writeFile(disabledFile, 'Manually disconnected. Use the control panel or startup command to connect again.\n');
  }
  try { await api('/shutdown', {}, 2000); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw error;
  }
  // A shutdown acknowledgement precedes socket closure. Wait for actual exit so
  // an immediate start cannot mistake the departing process for a healthy one.
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { await api('/status', undefined, 1000); }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return true;
      throw error;
    }
  }
  throw new Error('服务尚未完全退出，请稍后重试。未强制结束其他程序。');
}

export async function ensureDaemon({ explicit = false } = {}) {
  if (explicit) await rm(disabledFile, { force: true });
  await assertConnectionEnabled();
  await credentials();
  let current;
  try { current = await api('/status', undefined, 1500); }
  catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  await assertConnectionEnabled();
  if (current) return current;
  const log = await open(logFile, 'a');
  const child = spawn(process.execPath, [path.join(root, 'bridge', 'daemon.mjs')], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: process.env
  });
  let spawnError;
  child.on('error', error => { spawnError = error; }); child.unref(); await log.close();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    await assertConnectionEnabled();
    if (spawnError) throw spawnError;
    try { return await api('/status', undefined, 1000); } catch {}
  }
  throw new Error(`本地服务启动失败，请查看日志：${logFile}`);
}
