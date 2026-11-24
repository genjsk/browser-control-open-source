"""Build the Windows installer from this version's audited portable ZIP."""
from hashlib import file_digest
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
from zipfile import ZipFile


def main():
    if sys.platform != 'win32':
        raise SystemExit('The installer build requires Windows x64.')
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    bundle_name = f'browser-control-{version}-win32-x64'
    release = root / 'release'
    archive = release / f'{bundle_name}.zip'
    if not archive.is_file():
        raise SystemExit(f'Build the portable ZIP first: {archive.name}')
    with ZipFile(archive) as bundle:
        for member in bundle.namelist():
            parts = PurePosixPath(member).parts
            if not parts or parts[0] != bundle_name or '..' in parts or '.local' in parts:
                raise SystemExit(f'Unexpected path in portable ZIP: {member}')
        package = json.loads(bundle.read(f'{bundle_name}/package.json'))
        manifest = json.loads(bundle.read(f'{bundle_name}/extension/manifest.json'))
        if package['version'] != version or manifest['version'] != version:
            raise SystemExit('Project, portable package and extension versions must agree.')
        bundle.getinfo(f'{bundle_name}/BrowserControl.exe')
        bundle.getinfo(f'{bundle_name}/runtime/node.exe')
    build = root / '.local' / 'installer-build'
    build.mkdir(parents=True, exist_ok=True)
    payload = build / 'portable.zip'
    # PyInstaller preserves each --add-data source filename in the bundle.
    shutil.copyfile(archive, payload)
    icon = root / 'assets' / 'browser-control.ico'
    name = f'{bundle_name}-setup'
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--windowed',
        '--noupx', '--name', name, '--distpath', str(release), '--workpath', str(build / 'work'),
        '--specpath', str(build), '--icon', str(icon),
        '--add-data', f'{payload}{os.pathsep}.', '--add-data', f'{icon}{os.pathsep}.',
        str(root / 'gui' / 'installer.py'),
    ], cwd=root, env={**os.environ, 'PYINSTALLER_CONFIG_DIR': str(build / 'cache')}, check=True)
    installer = release / f'{name}.exe'
    with installer.open('rb') as file:
        digest = file_digest(file, 'sha256').hexdigest()
    installer.with_suffix('.exe.sha256').write_text(f'{digest}  {installer.name}\n', encoding='ascii')
    print(f'Created {installer}')


if __name__ == '__main__':
    main()
