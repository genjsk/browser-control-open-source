"""Per-user Windows installer for the self-contained Browser Control bundle."""
from __future__ import annotations

from collections.abc import Callable
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
from hashlib import sha256
from itertools import count
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import traceback
from uuid import uuid4
import winreg
from zipfile import ZipFile


PRODUCT = 'Browser Control'
REGISTRY_PATH = r'Software\BrowserControl\Installer'
REQUIRED = ('BrowserControl.exe', 'package.json', 'extension/manifest.json',
            'bridge/daemon.mjs', 'runtime/node.exe')
PREFERENCE = Path('.local') / 'storage-location.json'
STAGING_PREFIX = '.browser-control-setup-'


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


def registry_value(key_path: str, name: str):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def registered_directories() -> list[Path]:
    previous = registry_value(REGISTRY_PATH, 'InstallPath')
    saved = registry_value(REGISTRY_PATH, 'InstallPaths')
    return [path for value in [previous, *(saved if isinstance(saved, list) else [])]
            if (path := absolute_path(value))]


@dataclass(frozen=True)
class Installation:
    directory: Path
    version: str


def identify_installation(directory: Path) -> Installation | None:
    try:
        if is_reparse_point(directory):
            return None
        resolved = directory.resolve()
        version = installed_version(resolved)
        return Installation(resolved, version) if version else None
    except (OSError, RuntimeError):
        return None


def known_folders() -> list[Path]:
    folders = r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    names = ('Desktop', '{374DE290-123F-4565-9164-39C4925E467B}', 'Personal')
    result = [Path.home() / name for name in ('Desktop', 'Downloads', 'Documents')]
    for name in names:
        value = registry_value(folders, name)
        if isinstance(value, str) and (folder := absolute_path(os.path.expandvars(value))):
            result.append(folder)
    return result


def fixed_drives() -> list[Path]:
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    drive_type = kernel32.GetDriveTypeW
    drive_type.argtypes = (wintypes.LPCWSTR,)
    drive_type.restype = wintypes.UINT
    mask = kernel32.GetLogicalDrives()
    return [Path(f'{letter}:/') for index, letter in enumerate('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
            if mask & (1 << index) and drive_type(f'{letter}:\\') == 3]


def nearby_candidates(parent: Path):
    try:
        for child in parent.iterdir():
            name = child.name.casefold().replace('_', '-').replace(' ', '-')
            if name.startswith(('browser-control', 'browsercontrol', '浏览器控制')) and not is_reparse_point(child) and child.is_dir():
                yield child
    except OSError:
        pass


def detect_installations(default: Path, installer_dir: Path) -> list[Installation]:
    local_data = local_data_directory()
    saved_runtime = read_record(local_data / 'runtime.json')
    candidates = [*registered_directories(), absolute_path(saved_runtime.get('root')),
                  default, local_data.parent / 'Programs' / 'BrowserControl', installer_dir, installer_dir.parent]
    for parent in dict.fromkeys([installer_dir, installer_dir.parent, *known_folders(), *fixed_drives()]):
        candidates.extend(nearby_candidates(parent))
    found = {}
    for candidate in filter(None, candidates):
        item = identify_installation(candidate)
        if item:
            found.setdefault(item.directory, item)
    return list(found.values())


def record_installation(target: Path) -> None:
    paths = list(dict.fromkeys([target, *registered_directories()]))[:100]
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_PATH) as key:
        winreg.SetValueEx(key, 'InstallPaths', 0, winreg.REG_MULTI_SZ, list(map(str, paths)))
        winreg.SetValueEx(key, 'InstallPath', 0, winreg.REG_SZ, str(target))


def is_reparse_point(entry: Path) -> bool:
    try:
        return bool(entry.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except FileNotFoundError:
        return False


def same_or_under(directory: Path, parent: Path) -> bool:
    return directory == parent or directory.is_relative_to(parent)


def validate_destination(value: str, selected: Installation | None, installer_file: Path,
                         *, choose_unused: bool = False) -> Path:
    requested = absolute_path(value.strip())
    if not requested:
        raise ValueError('请填写完整的安装目录。')
    if is_reparse_point(requested):
        raise ValueError('请选择实际目录，安装器不能直接写入目录链接。')
    target = requested.resolve()
    origin = selected.directory if selected else None
    if target == Path(target.anchor):
        raise ValueError('请选择磁盘中的一个文件夹。')
    if origin and target != origin and (same_or_under(target, origin) or same_or_under(origin, target)):
        raise ValueError('新安装位置不能包含原安装目录，也不能位于原安装目录里面。')
    if selected and identify_installation(origin) != selected:
        raise ValueError('选中的旧版目录或版本已变化，请重新选择安装记录。')
    if choose_unused and target != origin and target.is_dir() and next(target.iterdir(), None) is not None:
        for index in count(2):
            candidate = target.with_name(f'{target.name}-{index}')
            if not candidate.exists(follow_symlinks=False):
                target = candidate
                break
    if same_or_under(installer_file, target) and target != origin:
        raise ValueError('请选择单独的安装文件夹。')
    if target != origin and target.exists():
        if identify_installation(target):
            raise ValueError('该目录已有另一个版本。请在「升级已有版本」中选中它，再确认替换。')
        if not target.is_dir() or any(target.iterdir()):
            raise ValueError('新安装位置需要是空文件夹，或填写尚未创建的目录。')
    return target


def storage_locations(directory: Path) -> set[Path]:
    directories = {local_data_directory().resolve(), (directory / '.local' / 'state').resolve()}
    for value in (read_record(directory / PREFERENCE).get('dataDir'), os.environ.get('BROWSER_CONTROL_DATA_DIR')):
        configured = absolute_path(value)
        if configured:
            directories.add(configured.resolve())
    return directories


def effective_data_directory(directory: Path) -> Path:
    override = absolute_path(os.environ.get('BROWSER_CONTROL_DATA_DIR'))
    if override:
        return override
    saved = read_record(directory / PREFERENCE)
    components = (os.environ.get('COMPUTERNAME') or socket.gethostname(),
                  os.environ.get('USERDOMAIN', ''), os.environ.get('USERNAME') or Path.home().name)
    machine = sha256('\0'.join(components).encode('utf-8')).hexdigest()
    configured = absolute_path(saved.get('dataDir')) if saved.get('machine') == machine else None
    return configured or local_data_directory()


class TcpListener(ctypes.Structure):
    _fields_ = [(name, wintypes.DWORD) for name in
                ('state', 'local_address', 'local_port', 'remote_address', 'remote_port', 'pid')]


def local_listener_pids(port: int) -> set[int]:
    """Read the Windows IPv4 listener table. No connection or handshake is needed."""
    api = ctypes.WinDLL('iphlpapi').GetExtendedTcpTable
    api.argtypes = (wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL,
                    wintypes.ULONG, ctypes.c_int, wintypes.ULONG)
    api.restype = wintypes.DWORD
    size = wintypes.DWORD()
    buffer = None
    for _ in range(4):
        # TCP_TABLE_OWNER_PID_LISTENER excludes closed and TIME_WAIT sockets.
        result = api(buffer, ctypes.byref(size), False, socket.AF_INET, 3, 0)
        if result == 122:  # ERROR_INSUFFICIENT_BUFFER
            buffer = ctypes.create_string_buffer(size.value)
            continue
        if result:
            raise ctypes.WinError(result)
        if buffer is None:
            return set()
        header_size = ctypes.sizeof(wintypes.DWORD)
        count = wintypes.DWORD.from_buffer(buffer).value
        rows = (TcpListener * count).from_buffer(buffer, header_size)
        addresses = {0, int.from_bytes(socket.inet_aton('127.0.0.1'), 'little')}
        return {row.pid for row in rows if row.local_address in addresses
                and socket.ntohs(row.local_port & 0xFFFF) == port}
    raise OSError('Windows 正在更新 TCP 监听列表，请稍后重试。')


def require_disconnected(directory: Path) -> None:
    data = effective_data_directory(directory)
    settings = read_record(data / 'settings.json')
    try:
        port = int(os.environ.get('BROWSER_BRIDGE_PORT') or settings.get('port') or 19487)
    except (ValueError, TypeError):
        return
    if not 1024 <= port <= 65535 or not (data / f'credentials-{port}.json').is_file():
        return
    try:
        pids = local_listener_pids(port)
    except OSError:
        # Restricted accounts may be denied the listener table. A successful
        # exclusive bind confirms the port is available without starting a service.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind(('127.0.0.1', port))
        except OSError as error:
            raise RuntimeError(f'Windows 未允许读取监听列表，也无法确认端口 {port} 可用。\n{error}') from error
        return
    if pids:
        owners = '、'.join(map(str, sorted(pids)))
        raise RuntimeError(f'端口 {port} 仍有进程监听（PID {owners}）。请关闭占用端口的程序后重试。\n\n{data}')


def hide_staging(directory: Path) -> None:
    set_attributes = ctypes.WinDLL('kernel32', use_last_error=True).SetFileAttributesW
    set_attributes.argtypes = (wintypes.LPCWSTR, wintypes.DWORD)
    set_attributes.restype = wintypes.BOOL
    attributes = directory.lstat().st_file_attributes | stat.FILE_ATTRIBUTE_HIDDEN
    if not set_attributes(str(directory), attributes):
        raise ctypes.WinError(ctypes.get_last_error())


def clean_staging(directory: Path, parent: Path) -> str:
    for attempt in range(3):
        try:
            if (not directory.name.startswith(STAGING_PREFIX) or is_reparse_point(directory)
                    or directory.resolve().parent != parent):
                raise OSError('暂存目录的位置已变化。')
            shutil.rmtree(directory)
            return ''
        except OSError as error:
            if isinstance(error, FileNotFoundError) and not directory.exists():
                return ''
            if attempt == 2:
                return f'Windows 未能清理暂存目录：{directory}\n{error}'
            time.sleep(0.2)


def extract_bundle(archive: Path, scratch: Path, report: Callable[[str], None]) -> Path:
    with ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = {entry.filename.partition('/')[0] for entry in entries}
        if len(names) != 1:
            raise RuntimeError('安装包的目录结构不完整。')
        total = len(entries)
        for index, entry in enumerate(entries, start=1):
            if index == 1 or (index - 1) % 100 == 0:
                report(f'正在解压程序文件（已完成 {index - 1}/{total}）…')
            bundle.extract(entry, scratch)
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


class StagingPermissionError(RuntimeError):
    pass


def install(archive: Path, target: Path, selected: Installation | None, installer_file: Path,
            report: Callable[[str], None]) -> str:
    report('正在检查目标目录…')
    target = validate_destination(str(target), selected, installer_file)
    previous = selected.directory if selected else None
    upgrade = target == previous
    if previous:
        report('正在检查旧版服务是否已断开…')
        require_disconnected(previous)

    # Keep renames on one volume without requiring write access to the parent of an existing install.
    staging_parent = target if upgrade else target.parent
    scratch = staging_parent / f'{STAGING_PREFIX}{uuid4().hex}'
    report('正在创建安装暂存目录…')
    try:
        if not upgrade:
            staging_parent.mkdir(parents=True, exist_ok=True)
        # Use one attempt and inherit the destination ACL. Files moved from a
        # private staging directory can keep its administrator-only access.
        scratch.mkdir()
    except PermissionError as error:
        raise StagingPermissionError(f'Windows 拒绝创建安装暂存目录。请检查以下位置的写入权限。\n\n{staging_parent}\n\n{error}') from error
    note = ''
    keep_scratch = False
    try:
        report('正在隐藏并确认安装暂存目录…')
        if scratch.resolve(strict=True).parent != staging_parent or is_reparse_point(scratch):
            raise RuntimeError('安装暂存目录的位置已变化，请重新检查目标目录。')
        hide_staging(scratch)
        report('正在读取程序压缩包…')
        payload = extract_bundle(archive, scratch, report)
        report('正在复查目标目录…')
        validate_destination(str(target), selected, installer_file)
        if upgrade:
            report('正在复查旧版服务是否已断开…')
            require_disconnected(previous)
            report('正在备份并替换旧版程序文件…')
            replace_program(target, payload, scratch / 'previous', installer_file)
        else:
            report('正在写入新安装目录…')
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
        if not keep_scratch:
            report('正在清理安装暂存文件…')
            cleanup_issue = clean_staging(scratch, staging_parent)
            if cleanup_issue:
                report(cleanup_issue)
                note += f'\n{cleanup_issue}'

    report('正在记录安装位置…')
    try:
        record_installation(target)
    except OSError:
        note += '\nWindows 未能记录此安装位置，下次更新时可以手动选择。'
    if previous and previous != target:
        note += '\n原目录已保留。如果数据在原程序目录中，请在新面板中迁移数据后再清理原目录。'
    return note


class Installer:
    def __init__(self, root: tk.Tk, archive: Path, installer_file: Path):
        self.root = root
        self.archive = archive
        self.installer_file = installer_file
        self.default = roaming_directory() / 'BrowserControl'
        with ZipFile(archive) as bundle:
            prefix = bundle.namelist()[0].partition('/')[0]
            self.version = json.loads(bundle.read(f'{prefix}/package.json'))['version']
        self.path = tk.StringVar()
        self.mode = tk.StringVar()
        self.records = {}
        self.events = queue.SimpleQueue()
        self.busy = False
        self.finished = False
        self.plugin_busy = False

        root.title(f'{PRODUCT} 安装')
        root.configure(bg='#edf2f7')
        root.minsize(690, 510)
        root.protocol('WM_DELETE_WINDOW', self.close)
        root.option_add('*Font', '{Microsoft YaHei UI} 10')
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('Setup.TButton', padding=(15, 8), borderwidth=0,
                        background='#e7edf4', foreground='#1e293b')
        style.map('Setup.TButton', background=[('active', '#d7e3ef')])
        style.configure('Primary.TButton', padding=(17, 8), borderwidth=0,
                        background='#0f766e', foreground='white')
        style.map('Primary.TButton', background=[('disabled', '#cbd5e1'), ('active', '#115e59')],
                  foreground=[('disabled', '#526579')])
        style.configure('Setup.Treeview', background='white', fieldbackground='white',
                        foreground='#233448', rowheight=30)
        style.map('Setup.Treeview', background=[('selected', '#dff4ef')],
                  foreground=[('selected', '#0f5148')])
        style.configure('Setup.Treeview.Heading', background='#edf3f8', foreground='#30445b',
                        padding=(8, 6))
        style.configure('Setup.TRadiobutton', background='white', foreground='#25394d', padding=(0, 3))

        hero = tk.Frame(root, bg='#162942', padx=26, pady=19)
        hero.pack(fill='x')
        icon = archive.with_name('browser-control-128.png')
        if icon.is_file():
            self.logo = tk.PhotoImage(file=str(icon)).subsample(2)
            tk.Label(hero, image=self.logo, bg='#162942', bd=0).pack(side='left', padx=(0, 18))
        title = tk.Frame(hero, bg='#162942')
        title.pack(side='left')
        tk.Label(title, text=PRODUCT, bg='#162942', fg='white',
                 font=('Segoe UI', 23, 'bold')).pack(anchor='w')
        tk.Label(title, text=f'{self.version}  ·  Windows x64 安装',
                 bg='#162942', fg='#b9d5e3').pack(anchor='w', pady=(1, 0))

        body = tk.Frame(root, bg='white', padx=22, pady=16,
                        highlightbackground='#dbe5ef', highlightthickness=1)
        body.pack(fill='both', expand=True, padx=18, pady=(15, 8))
        self.setup_body = body
        modes = tk.Frame(body, bg='white')
        modes.pack(fill='x')
        self.mode_buttons = []
        for text, value in (('升级已有版本', 'upgrade'), ('全新安装', 'fresh')):
            button = ttk.Radiobutton(modes, text=text, variable=self.mode, value=value,
                                     style='Setup.TRadiobutton', command=self.change_mode)
            button.pack(side='left', padx=(0, 22))
            self.mode_buttons.append(button)
        self.add_button = ttk.Button(modes, text='添加旧版目录…', style='Setup.TButton', command=self.add_existing)
        self.add_button.pack(side='right')

        table = ttk.Frame(body)
        table.pack(fill='both', expand=True, pady=(10, 12))
        self.table = ttk.Treeview(table, columns=('version', 'path'), show='headings',
                                  height=4, selectmode='browse', style='Setup.Treeview')
        self.table.heading('version', text='已安装版本')
        self.table.heading('path', text='程序目录')
        self.table.column('version', width=130, minwidth=100, stretch=False, anchor='w')
        self.table.column('path', width=565, minwidth=390, anchor='w')
        vertical = ttk.Scrollbar(table, orient='vertical', command=self.table.yview)
        horizontal = ttk.Scrollbar(table, orient='horizontal', command=self.table.xview)
        self.table.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        self.table.grid(row=0, column=0, sticky='nsew')
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        table.rowconfigure(0, weight=1)
        table.columnconfigure(0, weight=1)
        self.table.bind('<<TreeviewSelect>>', self.select_existing)

        ttk.Label(body, text='目标目录', background='white', foreground='#1f3650',
                  font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w')
        row = tk.Frame(body, bg='white')
        row.pack(fill='x', pady=(5, 0))
        self.entry = ttk.Entry(row, textvariable=self.path)
        self.entry.pack(side='left', fill='x', expand=True)
        self.browse = ttk.Button(row, text='浏览…', style='Setup.TButton', command=self.choose)
        self.browse.pack(side='right', padx=(9, 0))
        self.hint = tk.Label(body, bg='white', fg='#53677f', justify='left',
                             anchor='w', wraplength=630)
        self.hint.pack(fill='x', pady=(10, 0))

        footer = tk.Frame(root, bg='#edf2f7', padx=18, pady=10)
        footer.pack(fill='x')
        self.footer = footer
        self.status = tk.Label(footer, bg='#edf2f7', fg='#314b64', justify='left',
                               anchor='w', wraplength=430)
        self.status.pack(side='left', fill='x', expand=True, padx=(0, 12))
        self.cancel = ttk.Button(footer, text='取消', style='Setup.TButton', command=self.close)
        self.cancel.pack(side='right')
        self.action = ttk.Button(footer, text='确认安装', style='Primary.TButton', command=self.start_install)
        self.action.pack(side='right', padx=(0, 9))
        self.progress = ttk.Progressbar(body, mode='indeterminate')
        self.path.trace_add('write', self.update_summary)

        for item in detect_installations(self.default, installer_file.parent):
            self.add_record(item)
        if len(self.records) == 1:
            self.table.selection_set(next(iter(self.records)))
        self.mode.set('upgrade' if self.records else 'fresh')
        self.change_mode()

    def add_record(self, item: Installation) -> str:
        for row, existing in self.records.items():
            if existing.directory == item.directory:
                self.records[row] = item
                self.table.item(row, values=(item.version, str(item.directory)))
                return row
        row = self.table.insert('', 'end', values=(item.version, str(item.directory)))
        self.records[row] = item
        # A long directory can be read in full with the horizontal scrollbar.
        width = min(1350, 28 + len(str(item.directory)) * 10)
        if width > self.table.column('path', 'width'):
            self.table.column('path', width=width, stretch=False)
        return row

    def selected(self) -> Installation | None:
        current = self.table.selection()
        return self.records.get(current[0]) if current else None

    def update_summary(self, *_):
        if self.busy or self.finished:
            return
        selected = self.selected() if self.mode.get() == 'upgrade' else None
        if self.mode.get() == 'upgrade' and not selected:
            label, hint = '确认升级', '请选择要升级的版本。找不到时，可以添加旧版程序目录。'
        elif selected:
            different = absolute_path(self.path.get().strip()) != selected.directory
            label = '安装到新位置' if different else '替换所选版本'
            hint = f'已选 {selected.version}  ·  {selected.directory}'
            if different:
                hint += '\n目标目录非空时会在旁边新建目录。升级后的程序会沿用所选版本的数据位置。'
        else:
            label, hint = '确认安装', '目标目录非空时会在旁边新建目录。要原地替换，请切到「升级已有版本」。'
        self.hint.config(text=hint)
        self.action.config(text=label)
        self.action.state(['!disabled'] if self.path.get().strip() and
                          (self.mode.get() != 'upgrade' or selected) else ['disabled'])

    def change_mode(self):
        if self.mode.get() == 'upgrade':
            chosen = self.selected()
            self.path.set(str(chosen.directory) if chosen else '')
        else:
            selected = self.table.selection()
            if selected:
                self.table.selection_remove(*selected)
            default = self.default
            try:
                occupied = default.exists() and (not default.is_dir() or any(default.iterdir()))
            except OSError:
                occupied = True
            if occupied:
                default = default.with_name(f'{default.name}-{self.version}')
            self.path.set(str(default))
        self.update_summary()

    def select_existing(self, _event=None):
        if not self.busy and not self.finished and self.selected():
            self.mode.set('upgrade')
            self.change_mode()

    def close(self):
        if not self.busy and not self.plugin_busy:
            self.root.destroy()

    def choose(self):
        initial = absolute_path(self.path.get().strip()) or self.default
        while not initial.is_dir() and initial != initial.parent:
            initial = initial.parent
        selected = filedialog.askdirectory(parent=self.root, initialdir=str(initial), mustexist=False,
                                           title='选择安装目标目录')
        if selected:
            self.path.set(selected)

    def add_existing(self):
        directory = filedialog.askdirectory(parent=self.root, initialdir=str(self.installer_file.parent),
                                            mustexist=True, title='选择含 BrowserControl.exe 的旧版目录')
        if not directory:
            return
        item = identify_installation(Path(directory))
        if not item:
            messagebox.showerror('未找到完整程序', '请选择直接包含 BrowserControl.exe、extension 和 runtime 的目录。',
                                 parent=self.root)
            return
        row = self.add_record(item)
        self.table.selection_set(row)
        self.table.see(row)
        self.select_existing()

    def set_editable(self, enabled: bool):
        for control in (self.entry, self.browse, self.add_button, self.action, self.cancel, *self.mode_buttons):
            control.state(['!disabled'] if enabled else ['disabled'])
        self.table.state(['!disabled'] if enabled else ['disabled'])

    def restore_retry(self, request: str):
        try:
            fields = json.loads(request)
            if not isinstance(fields, list) or len(fields) != 3 or not all(isinstance(value, str) for value in fields):
                raise ValueError('无法读取上次的安装位置，请重新选择。')
            target, source, version = fields
            selected = None
            if source:
                origin = absolute_path(source)
                selected = identify_installation(origin) if origin else None
                if not selected or selected.version != version:
                    raise ValueError('原安装记录已变化，请重新选择。')
            target = validate_destination(target, selected, self.installer_file)
        except (OSError, ValueError) as error:
            messagebox.showerror('请重新选择安装位置', str(error), parent=self.root)
            return
        if selected:
            self.mode.set('upgrade')
            self.table.selection_set(self.add_record(selected))
        else:
            self.mode.set('fresh')
        self.change_mode()
        self.root.after_idle(self.path.set, str(target))
        self.status.config(text='已恢复上次的安装位置，请确认后继续。')

    def offer_elevated_retry(self, target: Path, selected: Installation | None, detail: str):
        if not messagebox.askyesno('需要管理员权限',
                                    detail + '\n\n是否以管理员身份重新打开安装器？会保留当前选择，等待你确认。',
                                    parent=self.root):
            return
        request = json.dumps([str(target), str(selected.directory) if selected else '',
                              selected.version if selected else ''], ensure_ascii=False)
        arguments = subprocess.list2cmdline(['--resume-install', request])
        try:
            os.startfile(str(self.installer_file), 'runas', arguments, str(self.installer_file.parent))
        except OSError as error:
            if getattr(error, 'winerror', None) == 1223:
                self.status.config(text='已取消管理员授权，可以重试或选择其他目录。')
            else:
                messagebox.showerror('无法以管理员身份启动', str(error), parent=self.root)
        else:
            self.root.destroy()

    def start_install(self):
        selected = self.selected() if self.mode.get() == 'upgrade' else None
        if self.busy or (self.mode.get() == 'upgrade' and not selected):
            return
        try:
            target = validate_destination(self.path.get(), selected, self.installer_file, choose_unused=True)
        except (OSError, ValueError) as error:
            messagebox.showerror('请检查安装位置', str(error), parent=self.root)
            return
        if selected:
            if target == selected.directory:
                operation = f'将 {selected.version} 替换为 {self.version}。\n\n要替换的程序目录\n{target}'
            else:
                operation = f'将 {selected.version} 升级到新位置并沿用其数据设置。\n\n原目录\n{selected.directory}\n\n新目录\n{target}'
            if not messagebox.askokcancel('确认升级位置', operation, parent=self.root):
                return
        self.busy = True
        self.path.set(str(target))
        self.set_editable(False)
        self.status.config(text='正在准备安装…', fg='#314b64')
        self.progress.pack(fill='x', pady=(9, 0))
        self.progress.start(12)
        threading.Thread(target=self.run_install, args=(target, selected), daemon=True).start()
        self.root.after(100, self.poll)

    def run_install(self, target: Path, selected: Installation | None):
        steps = []

        def report(step):
            steps.append(time.strftime('%H:%M:%S ') + step)
            self.events.put(step)

        try:
            note = install(self.archive, target, selected, self.installer_file, report)
            self.events.put((target, note, None))
        except Exception as error:
            detail = str(error)
            log = self.installer_file.with_suffix('.log')
            try:
                log.write_text('\n'.join(steps) + '\n\n' + traceback.format_exc(), encoding='utf-8')
                detail += f'\n\n安装日志\n{log}'
            except OSError:
                pass
            retry = (target, selected) if isinstance(error, StagingPermissionError) else None
            self.events.put((None, detail, retry))

    def poll(self):
        try:
            event = self.events.get_nowait()
            while isinstance(event, str):
                self.status.config(text=event)
                event = self.events.get_nowait()
        except queue.Empty:
            self.root.after(100, self.poll)
            return
        target, detail, retry = event
        self.busy = False
        self.progress.stop()
        self.progress.pack_forget()
        self.cancel.state(['!disabled'])
        if target is None:
            self.set_editable(True)
            self.update_summary()
            self.status.config(text='操作未完成，请检查安装位置或程序状态。', fg='#991b1b')
            if retry and os.environ.get('BROWSER_CONTROL_SETUP_PATH') and not ctypes.windll.shell32.IsUserAnAdmin():
                self.offer_elevated_retry(*retry, detail)
            else:
                messagebox.showerror('安装未完成', detail, parent=self.root)
            return
        self.status.config(text=f'安装完成  ·  {self.version}' + detail, fg='#0f766e')
        self.finished = True
        self.action.config(text='打开控制面板', command=lambda: self.open_app(target))
        self.action.state(['!disabled'])
        self.cancel.config(text='关闭')
        self.show_plugins(target)

    def show_plugins(self, target: Path):
        self.target = target
        self.plugin_events = queue.SimpleQueue()
        self.setup_body.pack_forget()
        card = tk.Frame(self.root, bg='white', padx=22, pady=16,
                        highlightbackground='#dbe5ef', highlightthickness=1)
        card.pack(fill='both', expand=True, padx=18, pady=(15, 8), before=self.footer)
        tk.Label(card, text='AI 插件版本检查', bg='white', fg='#1f3650',
                 font=('Microsoft YaHei UI', 13, 'bold')).pack(anchor='w')
        tk.Label(card, text=str(target), bg='white', fg='#53677f', wraplength=630,
                 justify='left').pack(anchor='w', pady=(3, 10))
        self.plugin_table = ttk.Treeview(card, columns=('client', 'version', 'status'),
                                         show='headings', height=4, selectmode='browse',
                                         style='Setup.Treeview')
        for col, title in (('client', '客户端'), ('version', '已安装版本'), ('status', '更新状态')):
            self.plugin_table.heading(col, text=title)
            self.plugin_table.column(col, width=140, anchor='w')
        self.plugin_table.tag_configure('required', foreground='#991b1b')
        self.plugin_table.pack(fill='x')
        self.plugin_table.bind('<<TreeviewSelect>>', self.show_plugin_details)
        self.plugin_details = {}
        self.plugin_note = tk.Label(card, bg='white', fg='#53677f', justify='left',
                                    anchor='w', wraplength=640)
        self.plugin_note.pack(fill='x', pady=(9, 8))
        checks = tk.Frame(card, bg='white')
        checks.pack(fill='x')
        self.recheck = ttk.Button(checks, text='重新检查', style='Setup.TButton',
                                  command=lambda: self.plugin_action('check'))
        self.recheck.pack(side='left')
        self.update_codex = ttk.Button(checks, text='更新 Codex 插件', style='Setup.TButton',
                                        command=lambda: self.plugin_action('codex'))
        self.update_codex.pack(side='left', padx=8)
        self.update_dsh = ttk.Button(checks, text='生成新版 DSH 插件', style='Setup.TButton',
                                      command=lambda: self.plugin_action('dsh'))
        self.update_dsh.pack(side='left')
        self.dsh_folder = tk.StringVar()
        path_row = tk.Frame(card, bg='white')
        path_row.pack(fill='x', pady=(10, 0))
        self.dsh_row = path_row
        ttk.Entry(path_row, textvariable=self.dsh_folder, state='readonly').pack(side='left', fill='x', expand=True)
        ttk.Button(path_row, text='复制插件路径', style='Setup.TButton', command=self.copy_dsh).pack(side='left', padx=(8, 0))
        path_row.pack_forget()
        self.plugin_action('check')

    def copy_dsh(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.dsh_folder.get())
        self.plugin_note.config(text='插件目录已复制，请在对应的 DSH 配置中更新本地插件。')

    def show_plugin_details(self, _event=None):
        selected = self.plugin_table.selection()
        if selected and not self.plugin_busy:
            self.plugin_note.config(text=self.plugin_details.get(selected[0], '') or '此版本可与当前安装配合使用。')

    def plugin_action(self, action: str):
        if self.plugin_busy:
            return
        self.plugin_busy = True
        for button in (self.recheck, self.update_codex, self.update_dsh, self.action, self.cancel):
            button.state(['disabled'])
        self.plugin_note.config(text={'check': '正在读取已安装的 AI 插件版本…',
                                      'codex': '正在更新 Codex 插件…',
                                      'dsh': '正在生成 DSH 插件…'}[action])

        def work():
            script, arguments = {
                'check': ('plugin-versions.mjs', []),
                'codex': ('cli.mjs', ['install-codex-plugin', '--json']),
                'dsh': ('cli.mjs', ['prepare-dsh', '--json']),
            }[action]
            try:
                result = subprocess.run([str(self.target / 'runtime' / 'node.exe'),
                                         str(self.target / 'scripts' / script), *arguments],
                                        cwd=self.target, capture_output=True, encoding='utf-8',
                                        errors='replace', timeout=75 if action == 'codex' else 22,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
                if result.returncode:
                    raise RuntimeError(result.stderr.strip() or '未能完成插件操作。')
                self.plugin_events.put((action, json.loads(result.stdout), None))
            except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
                self.plugin_events.put((action, {}, str(error)))

        threading.Thread(target=work, daemon=True).start()
        self.root.after(100, self.poll_plugins)

    def poll_plugins(self):
        try:
            action, result, error = self.plugin_events.get_nowait()
        except queue.Empty:
            self.root.after(100, self.poll_plugins)
            return
        self.plugin_busy = False
        for button in (self.recheck, self.update_codex, self.update_dsh, self.action, self.cancel):
            button.state(['!disabled'])
        if error:
            self.plugin_note.config(text='未能完成插件操作。可重试，或在控制面板的「接入 AI」中操作。')
            if action != 'check':
                messagebox.showerror('插件操作未完成', error, parent=self.root)
            return
        if action == 'codex':
            self.plugin_note.config(text='Codex 插件已更新，请重启 Codex。可以重新检查版本。')
            return
        if action == 'dsh':
            self.dsh_folder.set(result['directory'])
            self.dsh_row.pack(fill='x', pady=(10, 0))
            self.plugin_note.config(text='已生成新版。复制路径后，在对应 DSH 配置中更新本地插件，再重启 DSH。')
            return
        states = {'required': '请升级', 'available': '可升级', 'current': '版本一致',
                  'missing': '未安装', 'unknown': '未能核对', 'newer': '版本较新',
                  'newer-mismatch': '需重新配置新版'}
        self.plugin_table.delete(*self.plugin_table.get_children())
        self.plugin_details.clear()
        eligible = set()
        required = []
        for plugin in result.get('plugins', []):
            state = plugin['state']
            if state in ('required', 'available', 'missing', 'unknown'):
                eligible.add(plugin['client'])
            if state == 'required':
                required.append(plugin['label'])
            row = self.plugin_table.insert('', 'end', values=(
                plugin['label'], plugin.get('version') or '—', states[state]), tags=(state,))
            self.plugin_details[row] = plugin.get('reason', '')
        for client, button in (('codex', self.update_codex), ('dsh', self.update_dsh)):
            button.state(['!disabled'] if client in eligible else ['disabled'])
        self.plugin_note.config(text=(
            f"请升级 {'、'.join(required)} 的插件后再使用浏览器控制。"
            if required else '版本不同但仍兼容时，可以选择升级。点击列表查看详情。'))

    def open_app(self, target: Path):
        try:
            os.startfile(str(target / 'BrowserControl.exe'), cwd=str(target))
        except OSError as error:
            messagebox.showerror('无法打开控制面板', str(error), parent=self.root)
        else:
            self.root.destroy()


def main():
    root = tk.Tk()
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    create_mutex.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    # On a UAC retry the first installer may still be closing its window.
    deadline = time.monotonic() + (5 if os.environ.get('BROWSER_CONTROL_SETUP_RESUME') else 0)
    while True:
        mutex = create_mutex(None, False, 'Local\\BrowserControlSetup')
        if mutex and ctypes.get_last_error() != 183:
            break
        if mutex:
            close_handle(mutex)
        if time.monotonic() >= deadline:
            messagebox.showerror('无法打开安装器', '请关闭其他 Browser Control 安装窗口后再试。', parent=root)
            root.destroy()
            return
        time.sleep(0.1)
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
    running_file = Path(os.environ.get('BROWSER_CONTROL_SETUP_PATH') or
                        (sys.executable if getattr(sys, 'frozen', False) else __file__)).resolve()
    ui = Installer(root, archive, running_file)
    if request := os.environ.get('BROWSER_CONTROL_SETUP_RESUME'):
        ui.restore_retry(request)
    root.mainloop()


if __name__ == '__main__':
    main()
