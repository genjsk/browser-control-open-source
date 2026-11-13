import { cp, mkdir, readFile, copyFile, writeFile, stat, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appRoot as root } from '../bridge/paths.mjs';

const mode = process.argv[2] || 'source';
if (!['source', 'portable'].includes(mode)) throw new Error('Use source or portable');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const releaseDir = path.join(root, 'release');
await mkdir(releaseDir, { recursive: true });
await mkdir(path.join(root, '.local'), { recursive: true });
const staging = await mkdtemp(path.join(root, '.local', 'release-stage-'));
const name = mode === 'source' ? `browser-control-${version}-source` : `browser-control-${version}-${process.platform}-${process.arch}`;
const directory = path.join(staging, name);
await mkdir(directory);
const allow = mode === 'source'
  ? ['bridge', 'extension', 'gui', 'assets', 'scripts', 'tests', 'integrations', 'docs', 'third_party', '.github', '.gitignore', '.gitattributes', '.node-version', 'package.json', 'package-lock.json', 'requirements-build.txt', 'README.md', 'README.en.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'Start.cmd', 'start.sh']
  : ['bridge', 'extension', 'scripts', 'assets', 'integrations', 'docs', 'third_party', 'package.json', 'package-lock.json', 'README.md', 'README.en.md', 'LICENSE', 'SECURITY.md', 'Start.cmd', 'start.sh'];
for (const file of allow) await cp(path.join(root, file), path.join(directory, file), {
  recursive: true, filter: source => path.basename(source) !== '__pycache__' && !source.endsWith('.pyc')
});
if (mode === 'portable') {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable build currently targets Windows x64; use source CLI on other platforms.');
  const gui = path.join(root, '.local', 'gui-dist', 'BrowserControl');
  if (!existsSync(path.join(gui, 'BrowserControl.exe'))) throw new Error('Build the GUI first: python scripts/build-gui.py');
  await cp(gui, directory, { recursive: true });
  await mkdir(path.join(directory, 'runtime'));
  await copyFile(process.execPath, path.join(directory, 'runtime', 'node.exe'));
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('npm-cli.js not found beside Node.js. Build using a standard Node.js installation.');
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(root, '.local', 'npm-cache')], { cwd: directory, stdio: 'inherit', windowsHide: true });
  if (install.status) throw new Error('Production dependency installation failed');
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const license = await fetch(licenseUrl);
  if (!license.ok) throw new Error(`Could not retrieve Node.js license: ${license.status}`);
  await writeFile(path.join(directory, 'third_party', 'NODE_LICENSE.txt'), await license.text());
}
const audit = spawnSync(process.execPath, [path.join(root, 'scripts', 'audit-release.mjs'), directory], { stdio: 'inherit', windowsHide: true });
if (audit.status) throw new Error('Release audit failed');
const zip = path.join(releaseDir, `${name}.zip`);
if (process.platform === 'win32') {
  const packed = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:BROWSER_RELEASE_DIRECTORY -DestinationPath $env:BROWSER_RELEASE_ZIP -Force'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, BROWSER_RELEASE_DIRECTORY: directory, BROWSER_RELEASE_ZIP: zip }
  });
  if (packed.status) throw new Error('ZIP creation failed');
} else {
  const packed = spawnSync('zip', ['-qr', zip, name], { cwd: staging, stdio: 'inherit' });
  if (packed.status) throw new Error('ZIP creation failed (install zip)');
}
const digest = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${digest}  ${path.basename(zip)}\n`);
await writeFile(path.join(root, '.local', `${mode}-latest.json`), JSON.stringify({ archive: path.basename(zip), directory, size: (await stat(zip)).size }, null, 2));
console.log(`Created ${zip}`);
