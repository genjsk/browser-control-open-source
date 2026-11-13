import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readDataDirectory } from './paths.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const localDir = readDataDirectory();
let settings = {};
try { settings = JSON.parse(readFileSync(path.join(localDir, 'settings.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取连接设置，请检查用户数据目录中的 settings.json。'); }
export const port = Number(process.env.BROWSER_BRIDGE_PORT || settings.port || 19487);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port');
export const baseUrl = `http://127.0.0.1:${port}`;
export const disabledFile = path.join(localDir, `disabled-${port}`);
export const logFile = path.join(localDir, `bridge-${port}.log`);
const locationFile = path.join(root, '.local', 'storage-location.json');
function locationRecord() { try { return readFileSync(locationFile, 'utf8'); } catch { return ''; } }
const initialLocation = locationRecord();
export async function assertConnectionEnabled() {
  if (existsSync(path.join(localDir, '.migration.lock'))) throw new Error('正在迁移数据，请等待完成后再连接。');
  const currentLocation = locationRecord();
  if (currentLocation !== initialLocation) {
    try {
      const changed = JSON.parse(currentLocation);
      if (path.relative(localDir, changed.dataDir) !== '') throw new Error('存储位置已更改，请更新 AI 接入配置并重启客户端。');
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  try { await access(disabledFile); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('服务已手动断开，请在 Browser Control 面板点击“连接”。');
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export async function credentials() {
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const file = path.join(localDir, `credentials-${port}.json`);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(value.adminToken) || !/^[a-f0-9]{64}$/.test(value.extensionToken)) throw new Error('Invalid credentials file');
      return value;
    } catch (error) {
      if (error instanceof SyntaxError && attempt < 29) { await new Promise(resolve => setTimeout(resolve, 30)); continue; }
      if (error.code !== 'ENOENT') throw error;
    }
    const value = { adminToken: randomBytes(32).toString('hex'), extensionToken: randomBytes(32).toString('hex') };
    try { await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return value; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('配对信息正在创建，请重试。');
}
export function safeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export async function api(route, body, timeout = 35000) {
  const { adminToken } = await credentials();
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  if (response.status === 403) throw new Error('端口已被其他版本或程序使用，请先断开旧版，或在设置中修改端口。');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
