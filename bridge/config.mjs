import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
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
export const explicitPort = Boolean(process.env.BROWSER_BRIDGE_PORT);
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
  // Windows antivirus and indexers can briefly lock a just-written file, making
  // the replacing rename fail with EPERM/EBUSY. Retry transient codes only.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
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

async function currentSettingsPort() {
  try {
    const current = JSON.parse(await readFile(path.join(localDir, 'settings.json'), 'utf8'));
    const value = Number(current.port);
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null;
  } catch { return null; }
}

function connectionFailure(message, { code, configuredPort = port, servicePort = null, cause } = {}) {
  const error = new Error(message);
  error.code = code;
  error.configuredPort = configuredPort;
  error.servicePort = servicePort;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Call the local service. No path in this module ever starts it: the control
 * panel is the only start/stop entry point and the AI-facing launcher only
 * talks to an already running service.
 */
export async function api(route, body, timeout = 35000, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!headers.Authorization && !headers['x-browser-control-instance-token']) {
    const { adminToken } = await credentials();
    headers.Authorization = `Bearer ${adminToken}`;
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (cause) {
    const configured = await currentSettingsPort();
    if (configured && configured !== port) {
      throw connectionFailure(`AI 接入配置端口 ${port} 与控制面板当前端口 ${configured} 不一致。请在控制面板重新生成该 AI 接入配置。`, { code: 'PORT_MISMATCH', servicePort: configured, cause });
    }
    const name = cause?.name || cause?.cause?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw connectionFailure(`本地服务在 ${timeout}ms 内没有响应（插件配置端口 ${port}）。请检查服务状态；不要盲目重试可能已发出的写入操作。`, { code: 'REQUEST_TIMEOUT', cause });
    }
    if (cause?.cause?.code === 'ECONNRESET' || cause?.code === 'ECONNRESET') {
      throw connectionFailure(`端口 ${port} 上的程序不是当前的 Browser Control 服务（连接被重置）。该端口可能被其他程序或其他版本占用。`, { code: 'PORT_OCCUPIED', cause });
    }
    throw connectionFailure(`本地服务未启动（插件配置端口 ${port}）。请打开 Browser Control 控制面板并点击“连接”，本插件不会自动启动服务。`, { code: 'SERVICE_NOT_RUNNING', cause });
  }
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (response.status === 403) {
    if (data && data.code) {
      throw connectionFailure(data.message || data.error || '身份校验失败。', {
        code: data.code, configuredPort: data.configuredPort ?? port, servicePort: data.servicePort ?? null
      });
    }
    throw connectionFailure(`端口 ${port} 上的响应未通过身份校验：可能属于另一个 Browser Control 实例，或配对凭证已失效。请在控制面板重新连接并重新生成该 AI 接入配置。`, { code: 'PORT_OCCUPIED' });
  }
  if (!data) {
    if (response.status === 404) throw connectionFailure(`端口 ${port} 上存在其他程序，而不是当前的 Browser Control 服务。请在控制面板设置中修改端口。`, { code: 'PORT_OCCUPIED' });
    throw connectionFailure(`端口 ${port} 返回了无法识别的响应（HTTP ${response.status}），无法确认它是当前的 Browser Control 服务。`, { code: 'PORT_OCCUPIED' });
  }
  if (!response.ok) {
    throw connectionFailure(data.message || data.error || `HTTP ${response.status}`, {
      code: data.code || undefined, configuredPort: data.configuredPort, servicePort: data.servicePort
    });
  }
  return data;
}
