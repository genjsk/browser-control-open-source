"""Exercise normal startup and optional Settings directory changes."""
from pathlib import Path
import importlib.util
import json
import os
import shutil
import tempfile
import time
import tkinter as tk

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('control_panel', root / 'gui' / 'control_panel.py')
panel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel)
metadata = json.loads((root / '.local' / 'portable-latest.json').read_text(encoding='utf-8'))
source = Path(metadata['directory'])
work = Path(tempfile.mkdtemp(prefix='gui-storage-', dir=root / '.local'))
app = work / 'app'
for directory in ('bridge', 'scripts'):
    shutil.copytree(root / directory, app / directory)
for directory in ('runtime', 'node_modules'):
    shutil.copytree(source / directory, app / directory)
shutil.copy2(root / 'package.json', app / 'package.json')
os.environ.pop('BROWSER_CONTROL_DATA_DIR', None)
os.environ['LOCALAPPDATA'] = str(work / 'default-profile')
os.environ['BROWSER_BRIDGE_PORT'] = '19545'
controller = panel.BridgeController(app)
assert controller.local == work / 'default-profile' / 'BrowserControl'
dialog = panel.ControlPanel(controller)
dialog.withdraw()
errors = []
panel.messagebox.showerror = lambda title, text, **kwargs: errors.append(text)
try:
    before = controller.run('info')
    controller.local.joinpath('settings.json').write_text(json.dumps({'port': 19545}), encoding='utf-8')
    controller.local.joinpath('cache').mkdir()
    controller.local.joinpath('cache', 'preserved.txt').write_text('old cache', encoding='utf-8')
    controller.run('start')
    panel.filedialog.askdirectory = lambda **kwargs: ''
    dialog.change_storage()
    assert not dialog.busy and controller.status()['running']
    assert not (app / '.local').exists()
    dialog.settings_dialog()
    buttons = []
    def visit(widget):
        for child in widget.winfo_children():
            if isinstance(child, panel.ttk.Button):
                buttons.append(child)
            visit(child)
    visit(dialog)
    change = next(button for button in buttons if button.cget('text') == '更改存储位置')
    selected_parent = work / '用户指定位置'
    selected_parent.mkdir()
    panel.filedialog.askdirectory = lambda **kwargs: str(selected_parent)
    change.invoke()
    deadline = time.monotonic() + 25
    while dialog.busy and time.monotonic() < deadline:
        dialog.update()
        time.sleep(0.05)
    assert not dialog.busy and not errors and not dialog.last_error, (errors, dialog.last_error)
    assert dialog.controller.local == work / '用户指定位置' / 'BrowserControlData'
    assert not controller.local.exists()
    assert not dialog.controller.status()['running']
    assert panel.BridgeController(app).local == dialog.controller.local
    after = dialog.controller.run('info')
    assert after['pairingCode'] == before['pairingCode']
    assert dialog.controller.port == 19545
    assert dialog.controller.local.joinpath('cache', 'preserved.txt').read_text(encoding='utf-8') == 'old cache'
    dialog.controller.run('start')
    assert dialog.controller.status()['running']
    print('GUI passed: cancel preserves connection; migration retains pairing, settings and cache, cleans the old directory and reconnects.')
finally:
    dialog.controller.run('stop')
    dialog.destroy()
