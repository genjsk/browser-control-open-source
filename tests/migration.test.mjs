import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localDir } from '../bridge/config.mjs';
import { readDataDirectory } from '../bridge/paths.mjs';
import { migrateStorage } from '../scripts/storage-migration.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(localDir, 'migration-'));
  const source = path.join(directory, 'old'), target = path.join(directory, 'new'), root = path.join(directory, 'app');
  fs.mkdirSync(source); fs.mkdirSync(root);
  fs.mkdirSync(path.join(source, 'cache'));
  fs.writeFileSync(path.join(source, 'cache', 'keep.bin'), Buffer.from([0, 255, 16, 32]));
  fs.writeFileSync(path.join(source, 'settings.json'), '{"port":19546}');
  return { directory, source, target, root };
}
test('migration preserves data, keys, settings and DSH paths, then removes the old directory', async () => {
  const at = fixture();
  fs.writeFileSync(path.join(at.source, 'credentials-19546.json'), 'private-fixture-data');
  fs.mkdirSync(path.join(at.source, 'dsh-plugin'));
  fs.writeFileSync(path.join(at.source, 'dsh-plugin', 'cordis.patch.yml'), JSON.stringify([{ insert: [{ config: { command: path.join(at.source, 'node.exe'), args: [path.join(at.source, 'mcp-launcher.cjs')] } }] }]));
  const nativeDir = path.join(at.source, 'codex-plugin-marketplace', 'plugins', 'browser-control');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, 'local-runtime.json'), JSON.stringify({ dataDir: at.source }));
  fs.writeFileSync(path.join(nativeDir, 'mcp.json'), JSON.stringify({ mcpServers: { browser_control_native: { command: path.join(at.source, 'node.exe'), args: [path.join(at.source, 'mcp-launcher.cjs')] } } }));
  let stopped = false;
  const result = await migrateStorage({ ...at, stopServices: async () => { stopped = true; assert.ok(fs.existsSync(path.join(at.source, '.migration.lock'))); } });
  assert.ok(stopped && result.migrated && !result.cleanupIncomplete);
  assert.equal(fs.existsSync(at.source), false);
  assert.equal(fs.readFileSync(path.join(at.target, 'credentials-19546.json'), 'utf8'), 'private-fixture-data');
  assert.deepEqual(fs.readFileSync(path.join(at.target, 'cache', 'keep.bin')), Buffer.from([0, 255, 16, 32]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(at.target, 'settings.json'))).port, 19546);
  assert.equal(readDataDirectory({ root: at.root, env: { ...process.env, BROWSER_CONTROL_DATA_DIR: '' } }), at.target);
  const patch = JSON.parse(fs.readFileSync(path.join(at.target, 'dsh-plugin', 'cordis.patch.yml')));
  assert.equal(patch[0].insert[0].config.command, path.join(at.target, 'node.exe'));
  const movedNative = path.join(at.target, 'codex-plugin-marketplace', 'plugins', 'browser-control');
  assert.equal(JSON.parse(fs.readFileSync(path.join(movedNative, 'local-runtime.json'))).dataDir, at.target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(movedNative, 'mcp.json'))).mcpServers.browser_control_native.command, path.join(at.target, 'node.exe'));
});
test('a nonempty destination and overlapping directories are rejected without stopping services or deleting data', async () => {
  const at = fixture();
  fs.mkdirSync(at.target); fs.writeFileSync(path.join(at.target, 'user.txt'), 'keep destination');
  const stopServices = async () => assert.fail('Should validate before disconnecting');
  await assert.rejects(migrateStorage({ ...at, stopServices }), /空文件夹/);
  for (const target of [path.join(at.source, 'nested'), at.directory, at.root]) {
    await assert.rejects(migrateStorage({ ...at, target, stopServices }), /独立的数据文件夹/);
  }
  assert.equal(fs.readFileSync(path.join(at.target, 'user.txt'), 'utf8'), 'keep destination');
  assert.ok(fs.existsSync(path.join(at.source, 'settings.json')));
});
test('failure to save the new location rolls back copied files and preserves all originals', async () => {
  const at = fixture();
  await assert.rejects(migrateStorage({ ...at, save: () => { throw new Error('simulated read-only application'); } }), /read-only/);
  assert.ok(fs.existsSync(path.join(at.source, 'settings.json')));
  assert.ok(!fs.existsSync(at.target));
  assert.ok(!fs.existsSync(path.join(at.source, '.migration.lock')));
  assert.ok(!fs.existsSync(path.join(at.root, '.local', 'storage-location.json')));
});
test('corrupted copies fail verification before committing or deleting originals', async () => {
  const at = fixture();
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (from, to, flags) => { originalCopy(from, to, flags); fs.appendFileSync(to, 'corruption'); };
  try { await assert.rejects(migrateStorage(at), /校验失败/); }
  finally { fs.copyFileSync = originalCopy; }
  assert.equal(fs.readFileSync(path.join(at.source, 'settings.json'), 'utf8'), '{"port":19546}');
  assert.ok(!fs.existsSync(at.target));
});
test('directory links are never followed or deleted during migration', async () => {
  const at = fixture();
  const external = path.join(at.directory, 'unrelated');
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep.txt'), 'untouched');
  fs.symlinkSync(external, path.join(at.source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(migrateStorage(at), /目录链接/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'untouched');
});
test('choosing the existing location is a no-op', async () => {
  const at = fixture();
  const result = await migrateStorage({ ...at, target: at.source, stopServices: async () => assert.fail('No disconnect needed') });
  assert.ok(result.unchanged && fs.existsSync(path.join(at.source, 'settings.json')));
});
