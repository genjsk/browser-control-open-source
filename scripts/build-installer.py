"""Build the Windows installer from this version's audited portable ZIP."""
from argparse import ArgumentParser
from hashlib import file_digest
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Alternate path for the generated setup executable.')
    parser.add_argument('--archive', type=Path, help='Override the portable ZIP used as the installer payload.')
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise SystemExit('The installer build requires Windows x64.')
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    bundle_name = f'browser-control-{version}-win32-x64'
    release = root / 'release'
    archive = args.archive.resolve() if args.archive else release / f'{bundle_name}.zip'
    if not archive.is_file():
        raise SystemExit(f'Build the portable ZIP first: {archive.name}')
    with ZipFile(archive) as bundle:
        for member in bundle.namelist():
            parts = PurePosixPath(member).parts
            if not parts or parts[0] != bundle_name or '..' in parts or '.local' in parts:
                raise SystemExit(f'Unexpected path in portable ZIP: {member}')
        package = json.loads(bundle.read(f'{bundle_name}/package.json'))
        manifest = json.loads(bundle.read(f'{bundle_name}/extension/manifest.json'))
        if (package['version'] != version or manifest['version'] != version.split('-', 1)[0] or
                manifest.get('version_name', manifest['version']) != version):
            raise SystemExit('Project, portable package and extension versions must agree.')
        bundle.getinfo(f'{bundle_name}/BrowserControl.exe')
        bundle.getinfo(f'{bundle_name}/runtime/node.exe')
    build = root / '.local' / 'installer-build'
    build.mkdir(parents=True, exist_ok=True)
    compiler = Path(os.environ['SystemRoot']) / 'Microsoft.NET' / 'Framework64' / 'v4.0.30319' / 'csc.exe'
    if not compiler.is_file():
        raise SystemExit('The .NET Framework C# compiler is required to build the Windows installer.')
    payload = build / 'portable.zip'
    shutil.copyfile(archive, payload)
    icon = root / 'assets' / 'browser-control.ico'
    logo = root / 'assets' / 'browser-control-128.png'
    name = f'{bundle_name}-setup'
    inner_name = 'BrowserControlInstaller'
    dist = build / 'dist'
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--windowed',
        '--noupx', '--name', inner_name, '--distpath', str(dist), '--workpath', str(build / 'work'),
        '--specpath', str(build), '--icon', str(icon),
        '--add-data', f'{payload}{os.pathsep}.', '--add-data', f'{icon}{os.pathsep}.',
        '--add-data', f'{logo}{os.pathsep}.',
        str(root / 'gui' / 'installer.py'),
    ], cwd=root, env={**os.environ, 'PYINSTALLER_CONFIG_DIR': str(build / 'cache')}, check=True)
    embedded = build / 'setup-resources.zip'
    inner = dist / inner_name
    with ZipFile(embedded, 'w', compression=ZIP_DEFLATED) as bundle:
        for file in sorted(inner.rglob('*')):
            if file.is_file():
                bundle.write(file, file.relative_to(inner).as_posix(),
                             compress_type=ZIP_STORED if file.suffix == '.zip' else ZIP_DEFLATED)
    staged = build / f'{name}.exe'
    subprocess.run([
        str(compiler), '/nologo', '/target:winexe', '/platform:x64', '/codepage:65001',
        '/reference:System.IO.Compression.dll', '/reference:System.Windows.Forms.dll',
        f'/win32icon:{icon}', f'/resource:{embedded},setup.zip', f'/out:{staged}',
        str(root / 'gui' / 'setup_bootstrap.cs'),
    ], cwd=root, check=True)
    installer = args.output.resolve() if args.output else release / f'{name}.exe'
    installer.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staged, installer)
    with installer.open('rb') as file:
        digest = file_digest(file, 'sha256').hexdigest()
    installer.with_suffix('.exe.sha256').write_text(f'{digest}  {installer.name}\n', encoding='ascii')
    print(f'Created {installer}')


if __name__ == '__main__':
    main()
