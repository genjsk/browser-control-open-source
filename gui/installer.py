"""Per-user Windows installer for the self-contained Browser Control bundle."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import stat
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import winreg
from zipfile import ZipFile


PRODUCT = 'Browser Control'
REGISTRY_PATH = r'Software\BrowserControl\Installer'
REQUIRED = ('BrowserControl.exe', 'package.json', 'extension/manifest.json',
            'bridge/daemon.mjs', 'runtime/node.exe')
PREFERENCE = Path('.local') / 'storage-location.json'


def roaming_directory() -> Path:
    return Path(os.environ.get('APPDATA') or Path.home() / 'AppData' / 'Roaming')


def local_data_directory() -> Path:
    base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
    return base / 'BrowserControl'


def read_record(file: Path) -> dict:
    try:
        value = json.loads(file.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def absolute_path(value) -> Path | None:
    if isinstance(value, str) and value and Path(value).is_absolute():
        return Path(value)
    return None


def installed_version(directory: Path) -> str | None:
    if not all((directory / name).is_file() for name in REQUIRED):
        return None
    package = read_record(directory / 'package.json')
    version = package.get('version')
    if package.get('name') == 'browser-control' and isinstance(version, str) and version:
        return version
    return None


def registered_directory() -> Path | None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_PATH) as key:
            return absolute_path(winreg.QueryValueEx(key, 'InstallPath')[0])
    except OSError:
        return None


def detect_installation(default: Path, installer_dir: Path) -> Path | None:
    local_data = local_data_directory()
    saved_runtime = read_record(local_data / 'runtime.json')
    candidates = [registered_directory(), absolute_path(saved_runtime.get('root')),
                  default, local_data.parent / 'Programs' / 'BrowserControl', installer_dir]
    candidates.extend(sorted(installer_dir.glob('browser-control-*-win32-x64')))
    for candidate in candidates:
        if candidate and installed_version(candidate):
            return candidate.resolve()
    return None


def is_reparse_point(entry: Path) -> bool:
    try:
        return bool(entry.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except FileNotFoundError:
        return False


def same_or_under(directory: Path, parent: Path) -> bool:
    return directory == parent or directory.is_relative_to(parent)


def validate_destination(value: str, origin: Path | None, installer_file: Path) -> Path:
    requested = absolute_path(value.strip())
    if not requested:
        raise ValueError('请填写完整的安装目录。')
    if is_reparse_point(requested):
        raise ValueError('请选择实际目录，安装器不能直接写入目录链接。')
    target = requested.resolve()
    if target == Path(target.anchor):
        raise ValueError('请选择磁盘中的一个文件夹。')
    if origin and target != origin and (same_or_under(target, origin) or same_or_under(origin, target)):
        raise ValueError('新安装位置不能包含原安装目录，也不能位于原安装目录里面。')
    if same_or_under(installer_file, target) and not installed_version(target):
        raise ValueError('请选择单独的安装文件夹。')
    if target.exists() and (not target.is_dir() or (not installed_version(target) and any(target.iterdir()))):
        raise ValueError('请选择空文件夹，或已有的 Browser Control 程序目录。')
    return target


def storage_locations(directory: Path) -> set[Path]:
    directories = {local_data_directory().resolve(), (directory / '.local' / 'state').resolve()}
    for value in (read_record(directory / PREFERENCE).get('dataDir'), os.environ.get('BROWSER_CONTROL_DATA_DIR')):
        configured = absolute_path(value)
        if configured:
            directories.add(configured.resolve())
    return directories


def require_disconnected(directory: Path) -> None:
    # Only consider ports for which this installation has local pairing state.
    for data in storage_locations(directory):
        settings = read_record(data / 'settings.json')
        port = os.environ.get('BROWSER_BRIDGE_PORT') or settings.get('port') or 19487
        try:
            port = int(port)
        except (ValueError, TypeError):
            continue
        if not 1024 <= port <= 65535 or not (data / f'credentials-{port}.json').is_file():
            continue
        try:
            connection = socket.create_connection(('127.0.0.1', port), timeout=0.4)
        except ConnectionRefusedError:
            continue
        except OSError as error:
            raise RuntimeError(f'无法确认端口 {port} 是否已断开。请先关闭旧控制面板。') from error
        with connection:
            raise RuntimeError(f'旧版使用的本机端口 {port} 仍在监听。请先在旧控制面板点击“断开”，关闭面板和 AI 客户端，再重试。')


def extract_bundle(archive: Path, scratch: Path) -> Path:
    with ZipFile(archive) as bundle:
        names = {name.partition('/')[0] for name in bundle.namelist()}
        if len(names) != 1:
            raise RuntimeError('安装包的目录结构不完整。')
        bundle.extractall(scratch)
    root = scratch / names.pop()
    if not installed_version(root) or (root / '.local').exists():
        raise RuntimeError('无法识别安装包内的程序文件。')
    return root


def replace_program(target: Path, payload: Path, backup: Path, installer_file: Path) -> None:
    """Replace shipped entries only. Roll back in reverse order on a write failure."""
    entries = sorted(payload.iterdir(), key=lambda item: item.name.lower())
    targets = [target / item.name for item in entries]
    protected = storage_locations(target)
    protected.add(installer_file)
    for destination in targets:
        if is_reparse_point(destination) or any(
            same_or_under(item, destination.resolve()) or same_or_under(destination.resolve(), item)
            for item in protected
        ):
            raise ValueError(f'程序文件与数据位置或安装器重叠：{destination}。请先迁移数据或将安装器移到其他位置。')

    backup.mkdir()
    moves = []
    try:
        for source, destination in zip(entries, targets):
            if destination.exists():
                previous = backup / destination.name
                destination.rename(previous)
                moves.append((previous, destination))
            source.rename(destination)
            moves.append((destination, source))
    except OSError as error:
        try:
            for moved, original in reversed(moves):
                moved.rename(original)
        except OSError as rollback_error:
            raise RecoveryRequired(f'无法自动恢复全部旧文件。备份保留在：{backup}') from rollback_error
        raise RuntimeError('无法替换程序文件，旧文件已恢复。请关闭 BrowserControl.exe 和 AI 客户端后重试。') from error


class RecoveryRequired(RuntimeError):
    pass


def install(archive: Path, target: Path, detected: Path | None, installer_file: Path) -> str:
    upgrade = bool(installed_version(target))
    previous = target if upgrade else detected
    if previous:
        require_disconnected(previous)

    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='.browser-control-setup-', dir=target.parent)).resolve()
    keep_scratch = False
    try:
        payload = extract_bundle(archive, scratch)
        if upgrade:
            replace_program(target, payload, scratch / 'previous', installer_file)
        else:
            if previous and is_reparse_point(previous / PREFERENCE):
                raise ValueError('旧数据位置记录是文件链接，请在控制面板检查数据位置后再安装。')
            if previous and (previous / PREFERENCE).is_file():
                (payload / PREFERENCE.parent).mkdir()
                shutil.copy2(previous / PREFERENCE, payload / PREFERENCE)
            if target.exists():
                target.rmdir()  # Only an empty directory can be replaced here.
            payload.rename(target)
    except RecoveryRequired:
        keep_scratch = True
        raise
    finally:
        if not keep_scratch and scratch.parent == target.parent and scratch.name.startswith('.browser-control-setup-'):
            shutil.rmtree(scratch, ignore_errors=True)

    note = ''
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_PATH) as key:
            winreg.SetValueEx(key, 'InstallPath', 0, winreg.REG_SZ, str(target))
    except OSError:
        note = '\nWindows 未能记录此安装位置，下次更新时可以手动选择。'
    if previous and previous != target:
        note += '\n原目录已保留。如果数据在原程序目录中，请在新面板中迁移数据后再清理原目录。'
    return note


class Installer:
    def __init__(self, root: tk.Tk, archive: Path, installer_file: Path):
        self.root = root
        self.archive = archive
        self.installer_file = installer_file
        self.default = roaming_directory() / 'BrowserControl'
        self.detected = detect_installation(self.default, installer_file.parent)
        self.path = tk.StringVar(value=str(self.detected or self.default))
        self.events = queue.SimpleQueue()
        self.busy = False

        root.title(f'{PRODUCT} 安装')
        root.resizable(False, False)
        root.protocol('WM_DELETE_WINDOW', self.close)
        body = ttk.Frame(root, padding=22)
        body.grid()
        body.columnconfigure(0, weight=1)
        ttk.Label(body, text='安装 Browser Control', font=('Microsoft YaHei UI', 16, 'bold')).grid(
            row=0, column=0, columnspan=2, sticky='w')
        old_version = installed_version(self.detected) if self.detected else None
        if old_version:
            heading = f'找到已安装的 {old_version}。默认在原目录升级，也可以选择新目录。'
        else:
            heading = '请选择安装目录。已有便携版也可以直接选择其程序目录进行升级。'
        ttk.Label(body, text=heading, wraplength=550).grid(row=1, column=0, columnspan=2, sticky='w', pady=(12, 6))
        ttk.Label(body, text='升级前请断开本地服务，并关闭旧控制面板和 AI 客户端。',
                  wraplength=550).grid(row=2, column=0, columnspan=2, sticky='w', pady=(0, 14))
        self.entry = ttk.Entry(body, textvariable=self.path, width=63)
        self.entry.grid(row=3, column=0, sticky='ew')
        self.browse = ttk.Button(body, text='浏览…', command=self.choose)
        self.browse.grid(row=3, column=1, padx=(8, 0))
        self.status = ttk.Label(body, text='', wraplength=550)
        self.status.grid(row=4, column=0, columnspan=2, sticky='w', pady=(12, 8))
        buttons = ttk.Frame(body)
        buttons.grid(row=5, column=0, columnspan=2, sticky='e')
        self.action = ttk.Button(buttons, text='确认安装', command=self.start_install)
        self.action.pack(side='left', padx=(0, 8))
        self.cancel = ttk.Button(buttons, text='取消', command=self.close)
        self.cancel.pack(side='left')
        self.entry.focus_set()

    def close(self):
        if not self.busy:
            self.root.destroy()

    def choose(self):
        initial = absolute_path(self.path.get().strip()) or self.default
        while not initial.is_dir() and initial != initial.parent:
            initial = initial.parent
        selected = filedialog.askdirectory(parent=self.root, initialdir=str(initial), mustexist=False,
                                           title='选择 Browser Control 安装目录')
        if selected:
            self.path.set(selected)

    def start_install(self):
        try:
            target = validate_destination(self.path.get(), self.detected, self.installer_file)
        except (OSError, ValueError) as error:
            messagebox.showerror('请选择其他位置', str(error), parent=self.root)
            return
        self.busy = True
        self.path.set(str(target))
        for control in (self.entry, self.browse, self.action, self.cancel):
            control.state(['disabled'])
        self.status.config(text='正在解包并安装，请稍候…')
        threading.Thread(target=self.run_install, args=(target,), daemon=True).start()
        self.root.after(100, self.poll)

    def run_install(self, target: Path):
        try:
            note = install(self.archive, target, self.detected, self.installer_file)
            self.events.put((target, note))
        except Exception as error:
            self.events.put((None, str(error)))

    def poll(self):
        try:
            target, detail = self.events.get_nowait()
        except queue.Empty:
            self.root.after(100, self.poll)
            return
        self.busy = False
        self.cancel.state(['!disabled'])
        if target is None:
            for control in (self.entry, self.browse, self.action):
                control.state(['!disabled'])
            self.status.config(text='安装未完成。')
            messagebox.showerror('安装未完成', detail, parent=self.root)
            return
        hint = '安装完成。打开面板后可连接服务。换目录时请从新目录重新加载未打包扩展。'
        self.status.config(text=hint + detail)
        self.action.config(text='打开控制面板', command=lambda: self.open_app(target))
        self.action.state(['!disabled'])
        self.cancel.config(text='关闭')

    def open_app(self, target: Path):
        try:
            os.startfile(str(target / 'BrowserControl.exe'))
        except OSError as error:
            messagebox.showerror('无法打开控制面板', str(error), parent=self.root)


def main():
    root = tk.Tk()
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    create_mutex.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    mutex = create_mutex(None, False, 'Local\\BrowserControlSetup')
    if not mutex or ctypes.get_last_error() == 183:
        if mutex:
            close_handle(mutex)
        messagebox.showerror('无法打开安装器', '请关闭其他 Browser Control 安装窗口后再试。', parent=root)
        root.destroy()
        return
    try:
        show_installer(root)
    finally:
        close_handle(mutex)


def show_installer(root: tk.Tk):
    bundle_dir = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
    icon = bundle_dir / 'browser-control.ico'
    if icon.is_file():
        root.iconbitmap(str(icon))
    archive = bundle_dir / 'portable.zip'
    if not archive.is_file():
        messagebox.showerror('安装包不完整', '缺少程序文件，请重新下载完整安装包。', parent=root)
        root.destroy()
        return
    running_file = Path(sys.executable if getattr(sys, 'frozen', False) else __file__).resolve()
    Installer(root, archive, running_file)
    root.mainloop()


if __name__ == '__main__':
    main()
