import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localDir, port, safeEqual, writeJson } from './config.mjs';

// Stable, local-only identity of this bridge service. It is generated on first
// use inside the private data directory and never shipped with the source or
// any client template.
const identityFile = path.join(localDir, `identity-${port}.json`);
const registryFile = path.join(localDir, 'ai-instances.json');
export const ONLINE_WINDOW_MS = 45_000;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function tokenFile(id) { return path.join(localDir, `ai-token-${id}.json`); }
function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function isHex64(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function now() { return Date.now(); }
function validId(id) { return typeof id === 'string' && idPattern.test(id); }

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

let identityPromise = null;
// Registry updates are read-modify-write. Serialize them in-process so a
// heartbeat can never overwrite a pause that the panel just persisted.
let registryLock = Promise.resolve();
function withRegistry(task) {
  const run = registryLock.then(task, task);
  registryLock = run.then(() => {}, () => {});
  return run;
}
export function ensureIdentity() {
  identityPromise ||= (async () => {
    const existing = await readJson(identityFile);
    if (existing && /^[a-f0-9]{32}$/.test(existing.serviceId) && /^[a-f0-9]{32}$/.test(existing.pairingId)) return existing;
    const value = { serviceId: randomBytes(16).toString('hex'), pairingId: randomBytes(16).toString('hex'), createdAt: now() };
    await writeJson(identityFile, value);
    return value;
  })().catch(error => { identityPromise = null; throw error; });
  return identityPromise;
}

export async function readRegistry() {
  const value = await readJson(registryFile);
  const instances = value && Array.isArray(value.instances) ? value.instances.filter(item => validId(item?.id)) : [];
  return { version: 1, instances };
}

async function writeRegistry(registry) {
  await writeJson(registryFile, { version: 1, instances: registry.instances });
}

export function instanceStatus(entry, at = now()) {
  if (entry.paused) return 'paused';
  if (!entry.lastSeenAt) return 'installed';
  return at - entry.lastSeenAt <= ONLINE_WINDOW_MS ? 'online' : 'offline';
}

export function instanceView(entry, at = now()) {
  return {
    id: entry.id, client: entry.client, name: entry.name, transport: entry.transport,
    port: entry.port, status: instanceStatus(entry, at), paused: Boolean(entry.paused),
    lastSeenAt: entry.lastSeenAt || null, lastCallAt: entry.lastCallAt || null,
    installedAt: entry.installedAt || null
  };
}

async function readToken(id) {
  if (!validId(id)) return null;
  const value = await readJson(tokenFile(id));
  if (!value || !isHex64(value.token) || !isHex64(value.hash)) return null;
  return value;
}

/** Private per-instance token consumed by the stdio MCP adapter only. */
export async function instanceToken(id) {
  const value = await readToken(id);
  return value ? value.token : null;
}

/** Register (or refresh) an installed AI integration and return its private token. */
export async function registerInstance({ id, client, name, transport = 'stdio MCP', servicePort = port } = {}) {
  if (!validId(id)) throw new Error('AI 接入实例身份无效。请重新生成该接入配置。');
  return withRegistry(async () => {
    const identity = await ensureIdentity();
    const registry = await readRegistry();
    const existing = registry.instances.find(item => item.id === id);
    let secret = await readToken(id);
    if (!secret) {
      secret = { instanceId: id, token: randomBytes(32).toString('hex'), createdAt: now() };
      secret.hash = hashToken(secret.token);
      await writeJson(tokenFile(id), secret);
    }
    const entry = {
      id,
      client: String(client || id).slice(0, 60),
      name: String(name || id).slice(0, 80),
      transport: String(transport || 'stdio MCP').slice(0, 60),
      port: servicePort,
      pairingId: identity.pairingId,
      installedAt: existing?.installedAt || now(),
      lastSeenAt: existing?.lastSeenAt || null,
      lastCallAt: existing?.lastCallAt || null,
      paused: existing?.paused === true
    };
    registry.instances = registry.instances.filter(item => item.id !== id);
    registry.instances.push(entry);
    await writeRegistry(registry);
    return { entry, token: secret.token };
  });
}

export async function getInstance(id) {
  if (!validId(id)) return null;
  const registry = await readRegistry();
  return registry.instances.find(item => item.id === id) || null;
}

export async function listInstances() {
  const registry = await readRegistry();
  const at = now();
  return registry.instances
    .map(entry => instanceView(entry, at))
    .sort((left, right) => Number(left.installedAt || 0) - Number(right.installedAt || 0) || left.id.localeCompare(right.id));
}

export async function markSeen(id, { call = false } = {}) {
  await withRegistry(async () => {
    const registry = await readRegistry();
    const entry = registry.instances.find(item => item.id === id);
    if (!entry) return;
    entry.lastSeenAt = now();
    if (call) entry.lastCallAt = entry.lastSeenAt;
    await writeRegistry(registry);
  });
}

export async function setInstancePaused(id, paused) {
  return withRegistry(async () => {
    const registry = await readRegistry();
    const entry = registry.instances.find(item => item.id === id);
    if (!entry) {
      throw Object.assign(new Error('未找到该 AI 接入实例。请重新生成接入配置。'), { code: 'INSTANCE_UNKNOWN' });
    }
    entry.paused = Boolean(paused);
    await writeRegistry(registry);
    return instanceView(entry);
  });
}

export async function verifyInstance({ id, token, headerPort, servicePort }) {
  const identity = await ensureIdentity();
  const entry = await getInstance(id);
  if (!entry) {
    return { error: { code: 'INSTANCE_UNKNOWN', message: '未登记的 AI 接入实例。请在控制面板中重新生成该 AI 接入配置。' } };
  }
  const secret = await readToken(id);
  if (!secret || !safeEqual(hashToken(token), secret.hash)) {
    return { error: { code: 'INSTANCE_TOKEN_INVALID', message: 'AI 接入实例凭证无效。请在控制面板中重新生成该 AI 接入配置。' } };
  }
  if (entry.port !== servicePort) {
    return { error: { code: 'PORT_MISMATCH', configuredPort: entry.port, message: `AI 接入配置端口 ${entry.port} 与当前服务端口 ${servicePort} 不一致。请在控制面板重新生成该 AI 接入配置。` } };
  }
  if (Number.isInteger(headerPort) && headerPort !== entry.port) {
    return { error: { code: 'PORT_MISMATCH', configuredPort: headerPort, message: `AI 插件配置端口 ${headerPort} 与当前服务端口 ${servicePort} 不一致。请更新该 AI 接入配置。` } };
  }
  if (entry.pairingId !== identity.pairingId) {
    return { error: { code: 'PAIRING_MISMATCH', message: '配对凭证与当前服务端口不匹配。请在控制面板重新连接并重新生成该 AI 接入配置。' } };
  }
  return { entry, secret };
}

export function verification(entry, servicePort, browserConnected) {
  return {
    instance: entry.id,
    instanceName: entry.name,
    client: entry.client,
    configuredPort: entry.port,
    servicePort,
    portMatches: entry.port === servicePort,
    pairing: 'verified',
    browserConnected,
    instancePaused: Boolean(entry.paused)
  };
}
