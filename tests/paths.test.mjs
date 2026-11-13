import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localDir } from '../bridge/config.mjs';
import { prepareDataDirectory, readDataDirectory, validateStoragePath, defaultDataDirectory } from '../bridge/paths.mjs';

test('first launch uses the default directory without requiring a selection', () => {
  const root = path.join(localDir, 'unconfigured-app');
  const profile = path.join(localDir, 'default-profile');
  const result = prepareDataDirectory({ root, env: { LOCALAPPDATA: profile }, platform: 'win32' });
  assert.equal(result.mode, 'default');
  assert.equal(result.dataDir, path.join(profile, 'BrowserControl'));
  assert.ok(!fs.existsSync(root));
  assert.ok(fs.existsSync(result.dataDir));
});
test('a user selection is writable, saved and reused on the same computer', () => {
  const root = path.join(localDir, 'selected-app');
  const selected = path.join(localDir, 'chosen-data');
  const env = { COMPUTERNAME: 'test-computer' };
  const outcome = prepareDataDirectory({ root, env, selected });
  assert.equal(outcome.mode, 'selected');
  fs.writeFileSync(path.join(selected, 'keep.txt'), 'existing data');
  assert.equal(prepareDataDirectory({ root, env }).dataDir, selected);
  assert.equal(fs.readFileSync(path.join(selected, 'keep.txt'), 'utf8'), 'existing data');
  assert.deepEqual(fs.readdirSync(root), ['.local']);
  const next = { COMPUTERNAME: 'new-computer', LOCALAPPDATA: path.join(localDir, 'new-profile') };
  assert.equal(readDataDirectory({ root, env: next, platform: 'win32' }), path.join(next.LOCALAPPDATA, 'BrowserControl'));
});
test('C drive paths are permitted for defaults and user selections', () => {
  for (const directory of ['C:\\cache', 'c:/cache', 'C:relative', '\\\\?\\C:\\cache']) {
    assert.equal(validateStoragePath(directory), path.resolve(directory));
  }
  assert.equal(defaultDataDirectory({ env: { LOCALAPPDATA: 'C:/profile/AppData/Local' }, platform: 'win32' }), path.join('C:/profile/AppData/Local', 'BrowserControl'));
  const io = { readFileSync() { throw new Error('No saved choice'); }, mkdirSync() {}, writeFileSync() {}, unlinkSync() {}, renameSync() {} };
  assert.equal(prepareDataDirectory({ root: 'C:/app', selected: 'C:/cache', platform: 'win32', io }).dataDir, path.resolve('C:/cache'));
});
test('an inaccessible default falls back to local storage and remembers it', () => {
  const root = path.join(localDir, 'fallback-app');
  const blocked = path.join(localDir, 'blocked-profile');
  fs.writeFileSync(blocked, 'not a directory');
  const env = { LOCALAPPDATA: blocked };
  const result = prepareDataDirectory({ root, env, platform: 'win32' });
  assert.equal(result.mode, 'fallback');
  assert.equal(result.dataDir, path.join(root, '.local', 'state'));
  assert.equal(readDataDirectory({ root, env, platform: 'win32' }), result.dataDir);
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'not a directory');
});
test('explicit directory overrides never silently fall back to another location', () => {
  const io = { ...fs, mkdirSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.throws(() => prepareDataDirectory({ env: { BROWSER_CONTROL_DATA_DIR: localDir }, io }), { code: 'STORAGE_NOT_WRITABLE' });
});
test('platform defaults use their usual user data locations', () => {
  const home = path.join(localDir, 'example-home');
  assert.equal(defaultDataDirectory({ env: {}, home, platform: 'darwin' }), path.join(home, 'Library', 'Application Support', 'BrowserControl'));
  assert.equal(defaultDataDirectory({ env: {}, home, platform: 'linux' }), path.join(home, '.local', 'state', 'browser-control'));
});
