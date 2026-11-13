import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appRoot, saveDataDirectory, validateStoragePath } from '../bridge/paths.mjs';

function fail(message) { throw new Error(message); }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function actualPath(value) {
  const absolute = validateStoragePath(value);
  let ancestor = absolute;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  return path.join(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function inventory(directory) {
  const files = [], directories = [];
  function visit(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!relative && entry.name === '.migration.lock') continue;
      const name = path.join(relative, entry.name);
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('数据目录含有目录链接，迁移已取消，原数据保持不变。');
      if (stat.isDirectory()) { directories.push(name); visit(file, name); }
      else if (stat.isFile()) files.push(name);
      else fail('数据目录包含不支持的文件类型，迁移已取消。');
    }
  }
  visit(directory);
  return { files: files.sort(), directories: directories.sort() };
}

/** Copy and verify before publishing the new location; never overwrite a destination. */
export async function migrateStorage({ source, target, root = appRoot, env = process.env,
  stopServices = async () => {}, save = directory => saveDataDirectory(directory, { root, env }) }) {
  const original = validateStoragePath(source), destination = validateStoragePath(target);
  const from = actualPath(original), to = actualPath(destination), application = actualPath(root);
  if (path.relative(from, to) === '') return { dataDir: original, unchanged: true, message: '当前已经使用这个目录，无需迁移。' };
  if (inside(from, to) || inside(to, from) || inside(from, application) || inside(to, application) || from === path.parse(from).root || to === path.parse(to).root) {
    fail('请选择独立的数据文件夹，不能使用旧目录的上级、子目录或程序目录。');
  }
  if (fs.lstatSync(original).isSymbolicLink() || (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink())) fail('迁移目录不能是目录链接，请选择普通文件夹。');
  inventory(original); // Validate every entry before stopping or copying anything.
  if (!fs.existsSync(path.dirname(destination))) fail('请先选择一个已经存在的存储位置。');
  if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)) fail('目标目录不是空文件夹，请选择其他位置。不会覆盖已有数据。');
  const lock = path.join(original, '.migration.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); }
  catch { fail('这个数据目录正在迁移，请等待完成后再试。'); }
  const copied = [], madeDirectories = [];
  const targetExisted = fs.existsSync(destination);
  let committed = false, cleanupIncomplete = false;
  try {
    await stopServices();
    const executable = path.join(original, 'node.exe');
    if (process.platform === 'win32' && fs.existsSync(executable)) {
      try { const check = fs.openSync(executable, 'r+'); fs.closeSync(check); }
      catch { fail('请先关闭使用浏览器工具的 AI 客户端后重试，或检查旧目录的文件权限。原数据未迁移。'); }
    }
    const snapshot = inventory(original);
    if (!targetExisted) { fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); madeDirectories.push(destination); }
    for (const directory of snapshot.directories) {
      const created = path.join(destination, directory);
      fs.mkdirSync(created, { mode: 0o700 }); madeDirectories.push(created);
    }
    const checksums = new Map();
    for (const name of snapshot.files) {
      const oldFile = path.join(original, name), newFile = path.join(destination, name);
      const checksum = await hash(oldFile);
      fs.copyFileSync(oldFile, newFile, fs.constants.COPYFILE_EXCL); copied.push(newFile);
      if (await hash(newFile) !== checksum) fail('迁移校验失败，原数据保持不变。');
      checksums.set(name, checksum);
    }
    if (JSON.stringify(inventory(original)) !== JSON.stringify(snapshot)) fail('迁移时旧目录发生变化，请关闭其他控制面板和 AI 客户端后重试。');
    for (const name of snapshot.files) {
      if (await hash(path.join(original, name)) !== checksums.get(name)) fail('迁移时文件发生变化，原目录已保留，请关闭其他客户端后重试。');
    }
    // The generated DSH bundle embeds absolute executable/launcher paths.
    const patch = path.join(destination, 'dsh-plugin', 'cordis.patch.yml');
    if (fs.existsSync(patch)) {
      const relocate = value => {
        if (typeof value === 'string' && path.isAbsolute(value) && inside(original, value)) return path.join(destination, path.relative(original, value));
        if (Array.isArray(value)) return value.map(relocate);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
        return value;
      };
      fs.writeFileSync(patch, JSON.stringify(relocate(JSON.parse(fs.readFileSync(patch, 'utf8'))), null, 2));
    }
    const codexPlugin = path.join(destination, 'codex-plugin-marketplace', 'plugins', 'browser-control');
    for (const name of ['mcp.json', '.mcp.json', 'local-runtime.json']) {
      const file = path.join(codexPlugin, name);
      if (!fs.existsSync(file)) continue;
      const relocate = value => {
        if (typeof value === 'string' && path.isAbsolute(value) && inside(original, value)) return path.join(destination, path.relative(original, value));
        if (Array.isArray(value)) return value.map(relocate);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
        return value;
      };
      fs.writeFileSync(file, JSON.stringify(relocate(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
    }
    await save(destination);
    committed = true;
    // Delete only files in the verified snapshot. New/unrelated entries are retained.
    for (const name of snapshot.files) {
      try {
        const file = path.join(original, name);
        if (!fs.lstatSync(file).isFile() || await hash(file) !== checksums.get(name)) throw new Error('File changed');
        fs.unlinkSync(file);
      } catch { cleanupIncomplete = true; }
    }
    for (const name of [...snapshot.directories].sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(path.join(original, name)); } catch { cleanupIncomplete = true; }
    }
  } catch (error) {
    if (!committed) {
      // Roll back only entries created by this operation, never other user files.
      for (const file of copied.reverse()) { try { fs.unlinkSync(file); } catch {} }
      for (const directory of madeDirectories.sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(directory); } catch {} }
    }
    throw error;
  } finally {
    fs.closeSync(handle);
    try { fs.unlinkSync(lock); } catch { cleanupIncomplete = true; }
  }
  if (committed) { try { fs.rmdirSync(original); } catch { cleanupIncomplete = true; } }
  return { dataDir: destination, migrated: true, cleanupIncomplete,
    message: cleanupIncomplete
      ? `数据已迁移，配对和端口设置已保留。旧目录有被占用或变化的文件未清理：${original}。请关闭 AI 客户端后处理。`
      : '数据已迁移并清理旧目录，配对和端口设置已保留。请重新连接，并在“接入 AI”更新客户端配置后重启 AI 客户端。' };
}
