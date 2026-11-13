"""Run a copied portable build with no system Node/Python search path."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import time

root = Path(__file__).resolve().parents[1]
metadata = json.loads((root / '.local' / 'portable-latest.json').read_text(encoding='utf-8'))
source = Path(metadata['directory'])
test = root / '.local' / f'portable-test-{time.time_ns()}'
moved = test / '移动后的程序 with spaces'
shutil.copytree(source, moved, ignore=shutil.ignore_patterns('.local', '__pycache__'))
data = test / 'fresh-user'
report = root / 'test-results' / 'portable-gui.json'
report.parent.mkdir(exist_ok=True)
env = {**os.environ, 'BROWSER_CONTROL_DATA_DIR': str(data), 'BROWSER_BRIDGE_PORT': '19541'}
env['PATH'] = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32')
for name in ('NODE_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME'):
    env.pop(name, None)
exe = moved / 'BrowserControl.exe'
result = subprocess.run([str(exe), '--smoke-test', str(report)], cwd=test, env=env, timeout=90)
if result.returncode:
    raise SystemExit(f'Portable GUI failed ({result.returncode})')
outcome = json.loads(report.read_text(encoding='utf-8'))
assert outcome.get('frozen') is True and not outcome.get('error'), outcome
assert outcome['passed'] == ['info', 'prepare-codex-plugin', 'start', 'stop', 'start', 'restart', 'stop']
assert (moved / 'runtime' / 'node.exe').is_file()
assert (data / 'credentials-19541.json').is_file()
assert not (moved / '.local').exists()
print('Portable test passed: relocated Unicode/space path, fresh user state, no system Node.js PATH.')

# First launch enters the frozen GUI directly using a fresh default profile.
env.pop('BROWSER_CONTROL_DATA_DIR', None)
env['LOCALAPPDATA'] = str(test / 'default-profile')
env['BROWSER_BRIDGE_PORT'] = '19542'
default_report = root / 'test-results' / 'portable-default-path.json'
result = subprocess.run([str(exe), '--smoke-test', str(default_report)], cwd=test, env=env, timeout=90)
assert result.returncode == 0
assert json.loads(default_report.read_text(encoding='utf-8'))['passed'] == outcome['passed']
assert (test / 'default-profile' / 'BrowserControl' / 'credentials-19542.json').is_file()
assert not (moved / '.local').exists()

# An inaccessible profile still enters the GUI with writable local storage.
blocked = test / 'unusable-local-appdata'
blocked.write_text('not a directory', encoding='utf-8')
env.pop('BROWSER_CONTROL_DATA_DIR', None)
env['LOCALAPPDATA'] = str(blocked)
env['BROWSER_BRIDGE_PORT'] = '19544'
node = moved / 'runtime' / 'node.exe'
selector = moved / 'scripts' / 'paths.mjs'
result = subprocess.run([str(node), str(selector)], cwd=test, env=env, capture_output=True, encoding='utf-8', timeout=10)
assert result.returncode == 0 and json.loads(result.stdout)['mode'] == 'fallback'
fallback_report = root / 'test-results' / 'portable-fallback-path.json'
result = subprocess.run([str(exe), '--smoke-test', str(fallback_report)], cwd=test, env=env, timeout=90)
assert result.returncode == 0
assert json.loads(fallback_report.read_text(encoding='utf-8'))['passed'] == outcome['passed']
assert (moved / '.local' / 'state' / 'credentials-19544.json').is_file()
selected_data = test / '用户选择的存储目录' / 'BrowserControlData'
result = subprocess.run([str(node), str(selector), '--select', str(selected_data)], cwd=test, env=env, capture_output=True, encoding='utf-8', timeout=10)
assert result.returncode == 0, result.stderr
assert json.loads(result.stdout)['dataDir'] == str(selected_data)
selected_report = root / 'test-results' / 'portable-selected-path.json'
migrated_data = test / '迁移后的数据'
result = subprocess.run([str(exe), '--smoke-test', str(selected_report), '--smoke-migrate-to', str(migrated_data)], cwd=test, env=env, timeout=90)
assert result.returncode == 0
selected = json.loads(selected_report.read_text(encoding='utf-8'))
assert selected.get('frozen') and not selected.get('error'), selected
assert selected['passed'] == ['info', 'prepare-codex-plugin', 'start', 'stop', 'start', 'restart', 'stop', 'migrate-storage', 'start', 'stop']
assert not selected_data.exists()
assert (migrated_data / 'credentials-19544.json').is_file()
assert blocked.read_text(encoding='utf-8') == 'not a directory'
print('Default, fallback, custom-directory and verified migration/reconnection GUI tests passed.')
