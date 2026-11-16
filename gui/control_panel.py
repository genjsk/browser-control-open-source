"""Local browser-control panel. Python/Tk frontend; existing Node bridge backend."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk, simpledialog, filedialog
import urllib.error
import urllib.request


def open_path(path: Path):
    if sys.platform == 'win32':
        os.startfile(str(path))
    else:
        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def find_node(project: Path) -> str:
    bundled = project / 'runtime' / ('node.exe' if sys.platform == 'win32' else 'node')
    if bundled.is_file():
        return str(bundled)
    found = shutil.which('node')
    if found:
        return found
    raise RuntimeError('运行环境不完整。请解压完整的便携包；源码运行需要 Node.js 22 或以上版本。')


def choose_storage(project: Path, parent, initial: Path | None = None) -> Path | None:
    """Optional directory change from Settings; cancel keeps the current choice."""
    selected = filedialog.askdirectory(parent=parent, title='选择新存储位置（旧数据会迁移到 BrowserControlData）',
                                       initialdir=str(initial or project))
    if not selected:
        return None
    destination = Path(selected)
    if destination.name not in ('BrowserControlData', 'BrowserControl'):
        destination /= 'BrowserControlData'
    return destination


def format_time(value):
    if not value:
        return '—'
    try:
        return time.strftime('%m-%d %H:%M', time.localtime(value / 1000))
    except (OverflowError, OSError, ValueError):
        return '—'


class BridgeController:
    def __init__(self, project: Path, port: int | None = None):
        self.project = project.resolve()
        locator = self.project / 'scripts' / 'paths.mjs'
        result = subprocess.run([self.node(), str(locator)], cwd=self.project,
                                env=os.environ, capture_output=True, encoding='utf-8', errors='replace',
                                timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            try:
                detail = json.loads(result.stderr)
                error = detail['error']
            except (ValueError, KeyError):
                error = '无法准备数据目录，请将完整程序解压到可写文件夹。'
            raise RuntimeError(error)
        location = json.loads(result.stdout)
        self.local = Path(location['dataDir'])
        self.storage_mode = location['mode']
        self.storage_note = location.get('message', '')
        prefs = self.local / 'settings.json'
        saved = json.loads(prefs.read_text(encoding='utf-8')) if prefs.is_file() else {}
        self.port = int(port or os.environ.get('BROWSER_BRIDGE_PORT') or saved.get('port', 19487))
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @property
    def disabled(self):
        return self.local / f'disabled-{self.port}'

    def node(self) -> str:
        return find_node(self.project)

    def run(self, mode: str, *arguments) -> dict:
        if mode not in ('start', 'stop', 'restart', 'setup', 'info', 'integrate-codex', 'prepare-dsh', 'prepare-codex-plugin', 'install-codex-plugin', 'set-port', 'migrate-storage', 'ai-instance-pause', 'ai-instance-resume'):
            raise ValueError('Unsupported operation')
        script = self.project / 'scripts' / 'cli.mjs'
        if not script.is_file():
            raise RuntimeError('服务文件不完整，请解压完整便携包并保留所有文件。')
        env = {**os.environ, 'BROWSER_BRIDGE_PORT': str(self.port), 'BROWSER_CONTROL_DATA_DIR': str(self.local)}
        result = subprocess.run(
            [self.node(), str(script), mode, *map(str, arguments), '--no-open', '--json'], cwd=self.project,
            env=env, capture_output=True, encoding='utf-8', errors='replace',
            timeout=None if mode in ('migrate-storage', 'install-codex-plugin') else 25, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        if result.returncode:
            error = (result.stderr or result.stdout).strip()
            try:
                error = json.loads(error)['error']
            except (ValueError, KeyError):
                pass
            raise RuntimeError(error or '操作失败，请查看服务日志。')
        return json.loads(result.stdout)

    def local_instances(self) -> list:
        """Installed AI records with a locally computed status, used offline."""
        file = self.local / 'ai-instances.json'
        try:
            entries = json.loads(file.read_text(encoding='utf-8')).get('instances', [])
        except (OSError, ValueError):
            return []
        now = time.time() * 1000
        result = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict) or not entry.get('id'):
                continue
            seen = entry.get('lastSeenAt') or 0
            if entry.get('paused'):
                status = 'paused'
            elif seen and now - seen <= 45000:
                status = 'online'
            elif seen:
                status = 'offline'
            else:
                status = 'installed'
            result.append({
                'id': entry['id'], 'client': entry.get('client', ''), 'name': entry.get('name', ''),
                'transport': entry.get('transport', ''), 'port': entry.get('port'),
                'status': status, 'paused': bool(entry.get('paused')),
                'lastSeenAt': entry.get('lastSeenAt'), 'lastCallAt': entry.get('lastCallAt'),
                'installedAt': entry.get('installedAt'),
            })
        result.sort(key=lambda item: item.get('installedAt') or 0)
        return result

    @staticmethod
    def settle_instances(state: dict) -> dict:
        # A stopped service cannot hold an MCP session, so nothing is online.
        if not state.get('running'):
            for item in state.get('instances', []):
                if item.get('status') == 'online':
                    item['status'] = 'offline'
        return state

    def status(self) -> dict:
        state = dict(running=False, connected=False, paused=True, tabs=0,
                     instances=self.local_instances(), enabled=not self.disabled.exists(), error='')
        credentials = self.local / f'credentials-{self.port}.json'
        if not credentials.is_file():
            return self.settle_instances(state)
        try:
            token = json.loads(credentials.read_text(encoding='utf-8'))['adminToken']
            request = urllib.request.Request(
                f'http://127.0.0.1:{self.port}/status',
                headers={'Authorization': f'Bearer {token}'},
            )
            with self.opener.open(request, timeout=1.2) as response:
                payload = json.load(response)
            state.update(running=True, connected=payload.get('connected', False),
                         paused=payload.get('paused', True), tabs=len(payload.get('authorizedTabs', [])))
            if isinstance(payload.get('instances'), list):
                state['instances'] = payload['instances']
        except urllib.error.HTTPError as error:
            state['error'] = ('端口上的服务身份校验失败：可能属于其他 Browser Control 实例，或配对信息已变化。请重新连接。'
                              if error.code == 403 else f'无法读取状态（HTTP {error.code}）。')
        except urllib.error.URLError as error:
            if isinstance(error.reason, OSError) and getattr(error.reason, 'winerror', None) == 10061:
                pass
            elif isinstance(error.reason, ConnectionRefusedError):
                pass
            else:
                state['error'] = '暂时无法读取服务状态。'
        except (OSError, ValueError, KeyError):
            state['error'] = '无法读取本机连接信息，请重新启动服务。'
        return self.settle_instances(state)


class ControlPanel(tk.Tk):
    def __init__(self, controller: BridgeController):
        super().__init__()
        self.controller = controller
        self.title('Browser Control')
        asset_root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1])) / 'assets'
        if sys.platform == 'win32':
            self.iconbitmap(default=str(asset_root / 'browser-control.ico'))
        self._window_icon = tk.PhotoImage(file=str(asset_root / 'browser-control-128.png'))
        self.iconphoto(True, self._window_icon)
        self.geometry('900x900' if controller.storage_note else '900x860')
        self.minsize(860, 840 if controller.storage_note else 800)
        self.configure(bg='#f3f6fb')
        self.busy = False
        self.polling = False
        self.events: queue.Queue = queue.Queue()
        self.last_error = ''
        self.last_output = None
        self.smoke_mode = False
        self.protocol('WM_DELETE_WINDOW', self.close)
        self.option_add('*Font', '{Microsoft YaHei UI} 10')
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('TButton', font=('Microsoft YaHei UI', 10), padding=(15, 10), background='#e8edf4', borderwidth=0)
        style.map('TButton', background=[('active', '#dce4ee')])
        style.configure('Connect.TButton', background='#0f766e', foreground='white')
        style.map('Connect.TButton', background=[('active', '#115e59'), ('disabled', '#a8b9b8')])
        wrap = tk.Frame(self, bg='#f3f6fb', padx=28, pady=22)
        wrap.pack(fill='both', expand=True)
        tk.Label(wrap, text='浏览器控制', font=('Microsoft YaHei UI', 22, 'bold'), bg='#f3f6fb', fg='#0f172a').pack(anchor='w')
        tk.Label(wrap, text='1 连接服务  →  2 配对浏览器  →  3 接入 AI', bg='#f3f6fb', fg='#64748b').pack(anchor='w', pady=(4, 18))
        card = tk.Frame(wrap, bg='white', padx=22, pady=16, highlightbackground='#e2e8f0', highlightthickness=1)
        card.pack(fill='x')
        self.heading = tk.Label(card, text='正在检查…', bg='white', fg='#64748b', font=('Microsoft YaHei UI', 14, 'bold'))
        self.heading.pack(anchor='w', pady=(0, 10))
        self.values = {}
        for key, label in [('service', '本地服务'), ('browser', '浏览器扩展'), ('control', '网页控制'), ('tabs', '授权标签页')]:
            row = tk.Frame(card, bg='white')
            row.pack(fill='x', pady=3)
            tk.Label(row, text=label, bg='white', fg='#64748b').pack(side='left')
            value = tk.Label(row, text='—', bg='white', fg='#334155')
            value.pack(side='right')
            self.values[key] = value
        actions = tk.Frame(wrap, bg='#f3f6fb')
        actions.pack(fill='x', pady=(18, 10))
        actions.columnconfigure((0, 1), weight=1)
        self.connect_button = ttk.Button(actions, text='连接', style='Connect.TButton', command=lambda: self.perform('start'))
        self.disconnect_button = ttk.Button(actions, text='断开', command=lambda: self.perform('stop'))
        self.connect_button.grid(row=0, column=0, sticky='ew', padx=(0, 5))
        self.disconnect_button.grid(row=0, column=1, sticky='ew', padx=(5, 0))
        extras = tk.Frame(wrap, bg='#f3f6fb')
        extras.pack(fill='x')
        self.restart_button = ttk.Button(extras, text='重启连接', command=lambda: self.perform('restart'))
        self.restart_button.pack(side='left')
        self.pair_button = ttk.Button(extras, text='配对浏览器', command=self.show_pairing)
        self.pair_button.pack(side='left', padx=8)
        self.ai_button = ttk.Button(extras, text='接入 AI', command=lambda: self.perform('info', purpose='ai'))
        self.ai_button.pack(side='left')
        ttk.Button(extras, text='设置', command=self.settings_dialog).pack(side='right')
        ai_card = tk.Frame(wrap, bg='white', padx=14, pady=10, highlightbackground='#e2e8f0', highlightthickness=1)
        ai_card.pack(fill='both', expand=True, pady=(14, 0))
        ai_header = tk.Frame(ai_card, bg='white')
        ai_header.pack(fill='x')
        tk.Label(ai_header, text='AI 接入情况', bg='white', fg='#0f172a', font=('Microsoft YaHei UI', 11, 'bold')).pack(side='left')
        tk.Label(ai_header, text='安装记录与 MCP 会话状态分开显示', bg='white', fg='#94a3b8', font=('Microsoft YaHei UI', 9)).pack(side='right')
        table = tk.Frame(ai_card, bg='white')
        table.pack(fill='both', expand=True, pady=(8, 0))
        self.ai_table = ttk.Treeview(table, columns=('client', 'transport', 'port', 'status', 'last'), show='headings', height=5, selectmode='browse')
        for key, title, width, anchor in (
            ('client', 'AI 客户端 / 实例', 290, 'w'),
            ('transport', '接入方式', 190, 'w'),
            ('port', '端口', 64, 'center'),
            ('status', '状态', 74, 'center'),
            ('last', '最近调用', 120, 'center'),
        ):
            self.ai_table.heading(key, text=title)
            self.ai_table.column(key, width=width, anchor=anchor, stretch=key in ('client', 'transport'))
        table_scroll = ttk.Scrollbar(table, orient='vertical', command=self.ai_table.yview)
        self.ai_table.configure(yscrollcommand=table_scroll.set)
        self.ai_table.pack(side='left', fill='both', expand=True)
        table_scroll.pack(side='right', fill='y')
        self.ai_table.bind('<<TreeviewSelect>>', lambda event: self.update_instance_buttons())
        ai_actions = tk.Frame(ai_card, bg='white')
        ai_actions.pack(fill='x', pady=(8, 0))
        self.pause_instance_button = ttk.Button(ai_actions, text='暂停调用', command=lambda: self.pause_selected(True))
        self.pause_instance_button.pack(side='left')
        self.resume_instance_button = ttk.Button(ai_actions, text='恢复调用', command=lambda: self.pause_selected(False))
        self.resume_instance_button.pack(side='left', padx=8)
        self.ai_hint = tk.Label(ai_actions, text='暂停由本地服务强制执行，其他 AI 实例不受影响。', bg='white', fg='#94a3b8',
                                font=('Microsoft YaHei UI', 9), wraplength=360, justify='right')
        self.ai_hint.pack(side='right')
        self.message = tk.Label(wrap, text=controller.storage_note if controller.storage_mode == 'fallback' else '连接后，请在浏览器扩展中授权要操作的网页。', bg='#f3f6fb', fg='#64748b', wraplength=770, justify='left', anchor='w')
        self.message.pack(fill='x', pady=(16, 0))
        footer = tk.Frame(wrap, bg='#f3f6fb')
        footer.pack(side='bottom', fill='x', pady=(12, 0))
        self.address_label = tk.Label(footer, text=f'本机地址 127.0.0.1:{controller.port}', bg='#f3f6fb', fg='#94a3b8', font=('Microsoft YaHei UI', 9))
        self.address_label.pack(anchor='w')
        tk.Label(footer, text='关闭此窗口不改变连接状态；“断开”后不会被 AI 自动重启。', bg='#f3f6fb', fg='#94a3b8', font=('Microsoft YaHei UI', 9)).pack(anchor='w', pady=(3, 0))
        if controller.storage_note:
            self.storage_label = tk.Label(footer, text=f'数据目录：{controller.local}', bg='#f3f6fb', fg='#64748b', wraplength=780, justify='left', font=('Microsoft YaHei UI', 9))
            self.storage_label.pack(anchor='w', pady=(3, 0))
        self.after(60, self.consume)
        self.after(100, self.poll)
        self._native_icon_handles = None
        self.after_idle(self.apply_windows_icons)
        self.after(350, self.apply_windows_icons)

    def apply_windows_icons(self):
        if sys.platform != 'win32':
            return
        # Tk's native wrapper owns the title bar/taskbar, not winfo_id()'s child.
        # Assign both native icons after mapping; Tk's PNG iconphoto is insufficient
        # on some Tcl/Tk builds and can otherwise leave Python's default icon.
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.SendMessageW.restype = ctypes.c_ssize_t
        user32.SetClassLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        user32.SetClassLongPtrW.restype = ctypes.c_ssize_t
        hwnd = user32.GetAncestor(self.winfo_id(), 2)
        if not hwnd:
            raise ctypes.WinError(ctypes.get_last_error())
        if self._native_icon_handles is None:
            icon = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1])) / 'assets' / 'browser-control.ico'
            small = user32.LoadImageW(None, str(icon), 1, 32, 32, 0x10)
            big = user32.LoadImageW(None, str(icon), 1, 256, 256, 0x10)
            if not small or not big:
                raise ctypes.WinError(ctypes.get_last_error())
            # These handles must remain alive for the entire native window lifetime.
            self._native_icon_handles = (small, big)
        small, big = self._native_icon_handles
        user32.SendMessageW(hwnd, 0x0080, 0, small)
        user32.SendMessageW(hwnd, 0x0080, 1, big)
        user32.SetClassLongPtrW(hwnd, -34, small)
        user32.SetClassLongPtrW(hwnd, -14, big)

    def perform(self, mode: str, *arguments, purpose=None):
        if self.busy:
            return
        self.busy = True
        self.last_error = ''
        for button in (self.connect_button, self.disconnect_button, self.restart_button, self.pair_button,
                       getattr(self, 'pause_instance_button', None), getattr(self, 'resume_instance_button', None)):
            if button is not None:
                button.configure(state='disabled')
        self.message.configure(text={'start': '正在连接…', 'stop': '正在断开，等待服务退出…', 'restart': '正在重新连接…', 'migrate-storage': '正在断开服务、迁移并校验旧数据，请等待完成…', 'install-codex-plugin': '正在安装 Codex 本地插件…'}.get(mode, '正在准备…'), fg='#64748b')

        def work():
            try:
                output = self.controller.run(mode, *arguments)
                if mode == 'set-port':
                    self.controller.port = output['port']
                output['_purpose'] = purpose
                self.events.put(('operation', (mode, output, self.controller.status())))
            except Exception as error:
                self.events.put(('error', str(error)))
        threading.Thread(target=work, daemon=True).start()

    def poll(self):
        if not self.busy and not self.polling:
            self.polling = True
            def work():
                try:
                    self.events.put(('status', self.controller.status()))
                except Exception as error:
                    self.events.put(('poll_error', str(error)))
            threading.Thread(target=work, daemon=True).start()
        self.after(1500, self.poll)

    def render(self, state):
        self.address_label.configure(text=f'本机地址 127.0.0.1:{self.controller.port}')
        running, connected = state['running'], state['connected']
        self.heading.configure(text='已连接浏览器' if connected else ('等待浏览器连接' if running else '已断开'), fg='#0f766e' if connected else '#64748b')
        for key, value in {
            'service': '运行中' if running else '未运行',
            'browser': '已连接' if connected else '未连接',
            'control': ('已暂停' if state['paused'] else '已启用') if connected else '不可用',
            'tabs': str(state['tabs']),
        }.items():
            self.values[key].configure(text=value)
        self.render_instances(state.get('instances', []))
        if state['error'] and not self.busy:
            self.message.configure(text=state['error'], fg='#b91c1c')

    def render_instances(self, instances):
        selected = self.ai_table.selection()
        self.ai_table.delete(*self.ai_table.get_children())
        for entry in instances:
            if not entry.get('id'):
                continue
            status = {'online': '在线', 'offline': '离线', 'paused': '已暂停', 'installed': '已安装'}.get(entry.get('status'), entry.get('status', ''))
            self.ai_table.insert('', 'end', iid=entry['id'], values=(
                f"{entry.get('client', '')} · {entry.get('name', '')}".strip(' ·'),
                entry.get('transport', ''), entry.get('port', ''),
                status, format_time(entry.get('lastCallAt')),
            ))
        if selected and self.ai_table.exists(selected[0]):
            self.ai_table.selection_set(selected[0])
        self.update_instance_buttons()

    def update_instance_buttons(self):
        selection = self.ai_table.selection()
        status = self.ai_table.item(selection[0], 'values')[3] if selection else ''
        available = not self.busy
        self.pause_instance_button.configure(state='normal' if available and status in ('在线', '离线', '已安装') else 'disabled')
        self.resume_instance_button.configure(state='normal' if available and status == '已暂停' else 'disabled')

    def pause_selected(self, paused):
        selection = self.ai_table.selection()
        if selection:
            self.perform('ai-instance-pause' if paused else 'ai-instance-resume', selection[0])

    def consume(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == 'status':
                    self.polling = False
                    if not self.busy:
                        self.render(data)
                elif kind == 'poll_error':
                    self.polling = False
                else:
                    self.busy = False
                    for button in (self.connect_button, self.disconnect_button, self.restart_button, self.pair_button):
                        button.configure(state='normal')
                    self.update_instance_buttons()
                    if kind == 'error':
                        self.last_error = data
                        self.message.configure(text=data, fg='#b91c1c')
                    else:
                        mode, output, state = data
                        self.last_output = output
                        self.render(state)
                        note = output.get('message') or ('已断开。需要使用时点击“连接”。' if mode == 'stop' else '准备就绪。')
                        self.message.configure(text=note, fg='#0f766e')
                        if mode == 'info' and not self.smoke_mode:
                            self.connection_dialog(output, output.get('_purpose') == 'ai')
                        elif mode == 'migrate-storage' and not output.get('unchanged'):
                            self.apply_storage(output)
                        elif mode == 'prepare-dsh' and not self.smoke_mode:
                            self.dsh_dialog(output)
                        elif mode in ('prepare-codex-plugin', 'install-codex-plugin') and not self.smoke_mode:
                            self.codex_plugin_dialog(output)
        except queue.Empty:
            pass
        self.after(60, self.consume)

    def show_pairing(self):
        self.perform('info')

    def copy_text(self, value):
        self.clipboard_clear()
        self.clipboard_append(value)
        self.update_idletasks()

    def connection_dialog(self, info, ai=False):
        window = tk.Toplevel(self)
        window.title('接入 AI' if ai else '配对浏览器')
        window.geometry('640x500' if ai else '620x400')
        window.transient(self)
        body = ttk.Frame(window, padding=22)
        body.pack(fill='both', expand=True)
        if not ai:
            ttk.Label(body, text='① 加载浏览器扩展', font=('Microsoft YaHei UI', 13, 'bold')).pack(anchor='w')
            ttk.Label(body, text='打开 chrome://extensions 或 edge://extensions，\n开启开发者模式，选择“加载已解压的扩展程序”。').pack(anchor='w', pady=8)
            ttk.Button(body, text='打开扩展文件夹', command=lambda: open_path(Path(info['extensionDir']))).pack(anchor='w')
            ttk.Label(body, text='② 复制配对码，粘贴到扩展的“连接设置”').pack(anchor='w', pady=(20, 8))
            ttk.Button(body, text='复制配对码', command=lambda: self.copy_text(info['pairingCode'])).pack(anchor='w')
            ttk.Label(body, text='③ 打开目标网页，点击扩展 → 允许 AI 操作当前网页。\n配对码仅供本机使用；每台新电脑首次使用时重新配对。', wraplength=550).pack(anchor='w', pady=18)
        else:
            ttk.Label(body, text='选择你的 AI 客户端', font=('Microsoft YaHei UI', 13, 'bold')).pack(anchor='w')
            ttk.Label(body, text='通用 MCP：复制 JSON 到客户端的本地 MCP 设置。', wraplength=550).pack(anchor='w', pady=(15, 5))
            ttk.Button(body, text='复制 MCP JSON', command=lambda: self.copy_text(json.dumps(info['mcp'], ensure_ascii=False, indent=2))).pack(anchor='w')
            ttk.Label(body, text='Codex 原生插件：安装后可在 Codex 插件列表中使用。', wraplength=550).pack(anchor='w', pady=(15, 5))
            codex_actions = ttk.Frame(body)
            codex_actions.pack(anchor='w')
            ttk.Button(codex_actions, text='安装到 Codex', command=lambda: (window.destroy(), self.perform('install-codex-plugin'))).pack(side='left')
            ttk.Button(codex_actions, text='生成 Codex 插件', command=lambda: (window.destroy(), self.perform('prepare-codex-plugin'))).pack(side='left', padx=8)
            ttk.Button(body, text='旧版 MCP 配置接入', command=lambda: (window.destroy(), self.perform('integrate-codex'))).pack(anchor='w', pady=(8, 0))
            ttk.Label(body, text='DeepSeek Harness：生成本机 DSH 插件。', wraplength=550).pack(anchor='w', pady=(15, 5))
            ttk.Button(body, text='生成 DSH 插件', command=lambda: (window.destroy(), self.perform('prepare-dsh'))).pack(anchor='w')

    def dsh_dialog(self, info):
        window = tk.Toplevel(self)
        window.title('接入 DeepSeek Harness')
        body = ttk.Frame(window, padding=22)
        body.pack(fill='both', expand=True)
        ttk.Label(body, text='本机插件已生成。在 DSH 添加本地插件时，\n可直接粘贴插件目录，也可复制命令安装。').pack(pady=10)
        ttk.Button(body, text='复制安装命令', command=lambda: self.copy_text(info['command'])).pack(pady=6)
        ttk.Button(body, text='复制插件地址', command=lambda: self.copy_text(info['directory'])).pack(pady=6)
        ttk.Button(body, text='打开插件目录', command=lambda: open_path(Path(info['directory']))).pack(pady=6)

    def codex_plugin_dialog(self, info):
        window = tk.Toplevel(self)
        window.title('Codex 浏览器控制插件')
        window.transient(self)
        body = ttk.Frame(window, padding=22)
        body.pack(fill='both', expand=True)
        ttk.Label(body, text='已安装到 Codex' if info.get('installed') else 'Codex 插件已生成', font=('Microsoft YaHei UI', 13, 'bold')).pack(anchor='w')
        ttk.Label(body, text=info['message'], wraplength=540).pack(anchor='w', pady=12)
        ttk.Label(body, text='插件与 exe 共用本地服务；连接、断开、配对和存储管理仍在本面板。', wraplength=540).pack(anchor='w', pady=(0, 10))
        ttk.Button(body, text='复制插件地址', command=lambda: self.copy_text(info['directory'])).pack(anchor='w', pady=5)
        ttk.Button(body, text='复制安装命令', command=lambda: self.copy_text(info['command'])).pack(anchor='w', pady=5)
        ttk.Button(body, text='打开插件目录', command=lambda: open_path(Path(info['directory']))).pack(anchor='w', pady=5)

    def settings_dialog(self):
        if self.busy:
            return
        window = tk.Toplevel(self)
        window.title('设置')
        window.transient(self)
        body = ttk.Frame(window, padding=22)
        body.pack(fill='both', expand=True)
        ttk.Label(body, text='缓存、日志、配对信息都保存在：').pack(anchor='w')
        ttk.Label(body, text=str(self.controller.local), wraplength=510).pack(anchor='w', pady=8)
        ttk.Button(body, text='打开数据目录', command=lambda: open_path(self.controller.local)).pack(anchor='w', pady=5)
        ttk.Button(body, text='更改存储位置', command=lambda: (window.destroy(), self.change_storage())).pack(anchor='w', pady=5)
        ttk.Label(body, text='选定后会断开服务，把缓存、日志、配对和设置一起迁移。\n校验成功后清理旧数据；AI 接入配置需更新并重启客户端。\n迁移前请关闭使用浏览器工具的 AI 客户端。', wraplength=510).pack(anchor='w', pady=10)
        ttk.Button(body, text='修改连接端口', command=lambda: (window.destroy(), self.port_dialog())).pack(anchor='w', pady=5)

    def port_dialog(self):
        port = simpledialog.askinteger('连接设置', '本地端口（修改后需重新配对浏览器）', initialvalue=self.controller.port, minvalue=1024, maxvalue=65535, parent=self)
        if port and port != self.controller.port:
            self.perform('set-port', port)

    def change_storage(self):
        if self.busy:
            return
        previous = self.controller.local
        try:
            destination = choose_storage(self.controller.project, self, previous.parent)
            if destination:
                self.perform('migrate-storage', destination)
        except (OSError, ValueError, RuntimeError) as error:
            messagebox.showerror('无法更改存储位置', str(error), parent=self)

    def apply_storage(self, output):
        try:
            os.environ.pop('BROWSER_CONTROL_DATA_DIR', None)
            self.controller = BridgeController(self.controller.project)
            self.storage_label.configure(text=f'数据目录：{self.controller.local}')
            self.render(self.controller.status())
            self.message.configure(text=output['message'], fg='#b45309' if output.get('cleanupIncomplete') else '#0f766e')
        except (OSError, ValueError, RuntimeError) as error:
            messagebox.showerror('无法读取新存储位置', str(error), parent=self)

    def close(self):
        if self.busy:
            self.message.configure(text='正在处理连接，请完成后再关闭窗口。', fg='#64748b')
            return
        self.destroy()


def smoke_test(app: ControlPanel, report: Path, migrate_to: Path | None = None):
    """Exercise real GUI callbacks and service transitions on an isolated port."""
    app.withdraw()
    app.smoke_mode = True
    operations = ['info', 'prepare-codex-plugin', 'start', 'stop', 'start', 'restart', 'stop']
    if migrate_to:
        operations += ['migrate-storage', 'start', 'stop']
    old_data = app.controller.local
    original_credentials = None
    passed = []
    deadline = time.monotonic() + 60
    index = 0
    waiting = False

    def tick():
        nonlocal index, waiting, original_credentials
        try:
            if time.monotonic() > deadline:
                raise RuntimeError('GUI smoke test timed out')
            if index == len(operations):
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps({'passed': passed, 'frozen': bool(getattr(sys, 'frozen', False))}, ensure_ascii=False, indent=2), encoding='utf-8')
                app.destroy()
                return
            mode = operations[index]
            if not waiting:
                if mode == 'migrate-storage':
                    original_credentials = (old_data / f'credentials-{app.controller.port}.json').read_bytes()
                    app.perform(mode, migrate_to)
                elif mode == 'prepare-codex-plugin':
                    app.perform(mode)
                else:
                    {'info': app.ai_button, 'start': app.connect_button, 'stop': app.disconnect_button, 'restart': app.restart_button}[mode].invoke()
                waiting = True
            elif not app.busy:
                if app.last_error:
                    raise RuntimeError(app.last_error)
                state = app.controller.status()
                if mode not in ('info', 'prepare-codex-plugin', 'migrate-storage') and state['running'] != (mode != 'stop'):
                    raise RuntimeError(f'Unexpected service state after {mode}: {state}')
                if mode == 'info':
                    if not app.last_output.get('mcp', {}).get('mcpServers', {}).get('browser_control'):
                        raise RuntimeError('AI integration configuration missing')
                    if not any(item.get('id') == 'generic-mcp' for item in state.get('instances', [])):
                        raise RuntimeError('AI instance registry missing the generic entry')
                if mode == 'prepare-codex-plugin':
                    plugin = Path(app.last_output['directory'])
                    if not (plugin / 'plugin.json').is_file() or not (plugin / '.mcp.json').is_file():
                        raise RuntimeError('Native Codex plugin files missing')
                    if not any(item.get('id') == 'codex-native' for item in state.get('instances', [])):
                        raise RuntimeError('AI instance registry missing the Codex entry')
                    app.controller.run('ai-instance-pause', 'codex-native')
                    if not any(item['id'] == 'codex-native' and item['status'] == 'paused' for item in app.controller.status()['instances']):
                        raise RuntimeError('AI instance pause was not persisted')
                    app.controller.run('ai-instance-resume', 'codex-native')
                    if any(item['id'] == 'codex-native' and item['status'] == 'paused' for item in app.controller.status()['instances']):
                        raise RuntimeError('AI instance resume was not persisted')
                if mode == 'migrate-storage':
                    if old_data.exists() or app.controller.local != migrate_to:
                        raise RuntimeError('Migration did not switch and clean the old directory')
                    if (app.controller.local / f'credentials-{app.controller.port}.json').read_bytes() != original_credentials:
                        raise RuntimeError('Migration changed pairing credentials')
                if mode == 'stop':
                    if state['enabled']:
                        raise RuntimeError('Manual disconnect did not persist')
                    if any(item.get('status') == 'online' for item in state.get('instances', [])):
                        raise RuntimeError('AI instance still shown online after disconnect')
                    result = subprocess.run([app.controller.node(), '--input-type=module', '-e', "import {ensureDaemon} from './bridge/client.mjs'; await ensureDaemon();"], cwd=app.controller.project, env={**os.environ, 'BROWSER_BRIDGE_PORT': str(app.controller.port), 'BROWSER_CONTROL_DATA_DIR': str(app.controller.local)}, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    if result.returncode == 0:
                        raise RuntimeError('AI auto-start ignored manual disconnect')
                passed.append(mode)
                index += 1
                waiting = False
            app.after(100, tick)
        except Exception as error:
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps({'error': str(error), 'passed': passed}, ensure_ascii=False), encoding='utf-8')
            app.destroy()
    app.after(100, tick)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-dir', type=Path)
    parser.add_argument('--smoke-test', type=Path)
    parser.add_argument('--smoke-migrate-to', type=Path)
    args = parser.parse_args()
    if sys.platform == 'win32':
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(ctypes.c_wchar_p('org.browsercontrol.desktop'))
        except (AttributeError, OSError):
            pass
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    project = args.project_dir or (Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1])
    try:
        controller = BridgeController(project)
    except (OSError, ValueError, RuntimeError) as error:
        dialog = tk.Tk()
        dialog.withdraw()
        messagebox.showerror('无法准备连接数据', str(error), parent=dialog)
        dialog.destroy()
        return 1
    port = controller.port
    if not 1024 <= port <= 65535:
        raise ValueError('Invalid local port')
    app = ControlPanel(controller)
    if args.smoke_test:
        if port == 19487:
            messagebox.showerror('测试端口错误', '测试必须使用独立端口。')
            app.destroy()
            return 1
        smoke_test(app, args.smoke_test, args.smoke_migrate_to)
    app.mainloop()
    if args.smoke_test:
        result = json.loads(args.smoke_test.read_text(encoding='utf-8'))
        return 1 if result.get('error') else 0
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
