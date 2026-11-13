import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
function failure(code, message) { return Object.assign(new Error(message), { code }); }
export function machineIdentity(env = process.env) {
  return createHash('sha256').update([env.COMPUTERNAME || os.hostname(), env.USERDOMAIN || '', env.USERNAME || os.userInfo().username].join('\0')).digest('hex');
}
export function validateStoragePath(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('INVALID_STORAGE_PATH', '请选择有效的数据目录。');
  return path.resolve(directory);
}
export function defaultDataDirectory({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'BrowserControl');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BrowserControl');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'browser-control');
}
function preference({ root, env, io }) {
  try {
    const value = JSON.parse(io.readFileSync(path.join(root, '.local', 'storage-location.json'), 'utf8'));
    if (value?.dataDir && value.machine === machineIdentity(env)) return value;
  } catch {}
}
export function readDataDirectory({ root = appRoot, env = process.env, platform = process.platform, io = fs } = {}) {
  return validateStoragePath(env.BROWSER_CONTROL_DATA_DIR || preference({ root, env, io })?.dataDir || defaultDataDirectory({ env, platform }));
}
function probeDirectory(directory, io) {
  let probe;
  try {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    probe = path.join(directory, `.write-probe-${process.pid}-${randomBytes(5).toString('hex')}`);
    io.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    io.unlinkSync(probe);
    probe = undefined;
  } catch {
    throw failure('STORAGE_NOT_WRITABLE', '数据目录无法写入。请在设置中更换可写文件夹，或将完整程序移到可写位置。');
  } finally { if (probe) { try { io.unlinkSync(probe); } catch {} } }
}
export function saveDataDirectory(directory, { root = appRoot, env = process.env, io = fs, mode = 'selected' } = {}) {
  const local = path.join(root, '.local');
  const temporary = path.join(local, `storage-location-${process.pid}-${randomBytes(5).toString('hex')}.tmp`);
  try {
    io.mkdirSync(local, { recursive: true, mode: 0o700 });
    io.writeFileSync(temporary, JSON.stringify({ dataDir: validateStoragePath(directory), machine: machineIdentity(env), mode }), { flag: 'wx', mode: 0o600 });
    io.renameSync(temporary, path.join(local, 'storage-location.json'));
  } catch {
    throw failure('LOCATION_NOT_WRITABLE', '程序位置无法保存目录选择。请把完整程序移到可写文件夹后再试。');
  } finally { try { io.unlinkSync(temporary); } catch {} }
}
export function prepareDataDirectory({ root = appRoot, env = process.env, platform = process.platform, io = fs, selected } = {}) {
  const saved = preference({ root, env, io });
  let mode = selected ? 'selected' : env.BROWSER_CONTROL_DATA_DIR ? 'custom' : saved?.mode || (saved ? 'selected' : 'default');
  let directory = selected ? validateStoragePath(selected) : readDataDirectory({ root, env, platform, io });
  try { probeDirectory(directory, io); }
  catch (error) {
    if (selected || env.BROWSER_CONTROL_DATA_DIR || saved) throw error;
    directory = path.join(root, '.local', 'state');
    probeDirectory(directory, io);
    mode = 'fallback';
  }
  if (selected || mode === 'fallback') saveDataDirectory(directory, { root, env, io, mode });
  return { dataDir: directory, mode,
    message: mode === 'fallback' ? '默认目录无法写入，当前使用程序内的数据目录，可在设置中更改。' : '可在“设置 → 更改存储位置”中选择其他文件夹。' };
}
