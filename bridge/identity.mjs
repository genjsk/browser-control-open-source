import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { localDir, port } from './config.mjs';

// The identity is generated once per data directory and port and is never
// committed or copied into client templates. It proves that an AI instance was
// registered for this service and this port, without ever exposing the pairing
// key or the instance token to the AI or to logs.
const identityFile = path.join(localDir, `identity-${port}.json`);
let cached = null;

function valid(value) {
  return value && /^[a-f0-9]{32}$/.test(value.serviceId) && /^[a-f0-9]{32}$/.test(value.pairingId);
}

async function readIdentity() {
  const value = JSON.parse(await readFile(identityFile, 'utf8'));
  if (!valid(value)) throw new Error('本机服务身份文件已损坏，请删除数据目录中的 identity 文件后重新连接。');
  return value;
}

export async function serviceIdentity() {
  if (cached) return cached;
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  try {
    cached = await readIdentity();
    return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const value = {
    serviceId: randomBytes(16).toString('hex'),
    pairingId: randomBytes(16).toString('hex'),
    createdAt: Date.now()
  };
  try { await writeFile(identityFile, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); cached = value; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { cached = await readIdentity(); return cached; }
      catch (retry) {
        if (retry.code !== 'ENOENT') throw retry;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    throw new Error('本机服务身份正在创建，请重试。');
  }
  return cached;
}
