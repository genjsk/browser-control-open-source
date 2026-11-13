"""Build a relocatable desktop folder; no hardcoded extraction directory."""
from pathlib import Path
import os
import subprocess
import sys
import shutil
import importlib.metadata

root = Path(__file__).resolve().parents[1]
build = root / '.local' / 'gui-build'
build.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'PYINSTALLER_CONFIG_DIR': str(build / 'cache')}
subprocess.run([
    sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--windowed',
    '--noupx', '--name', 'BrowserControl', '--distpath', str(root / '.local' / 'gui-dist'),
    '--workpath', str(build / 'work'), '--specpath', str(build),
    '--icon', str(root / 'assets' / 'browser-control.ico'),
    '--add-data', str(root / 'assets') + os.pathsep + 'assets', str(root / 'gui' / 'control_panel.py')
], cwd=root, env=env, check=True)
notices = root / '.local' / 'gui-dist' / 'BrowserControl' / 'third_party'
notices.mkdir(exist_ok=True)
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.is_file():
    shutil.copy2(python_license, notices / 'PYTHON_LICENSE.txt')
for package in ('pyinstaller', 'pyinstaller-hooks-contrib'):
    distribution = importlib.metadata.distribution(package)
    for item in distribution.files or []:
        if '.dist-info/licenses/' in str(item).replace('\\', '/') and Path(item).name.lower().startswith(('copying', 'license')):
            shutil.copy2(distribution.locate_file(item), notices / (package + '-' + Path(item).name))
try:
    import tkinter
    tcl = tkinter.Tcl()
    library = Path(tcl.eval('info library'))
    for directory in (library, *library.parent.glob('tk*')):
        notice = directory / 'license.terms'
        if notice.is_file():
            shutil.copy2(notice, notices / (directory.name + '-license.terms'))
except (OSError, tkinter.TclError):
    pass
print('GUI ready. Next: npm run package:portable')
