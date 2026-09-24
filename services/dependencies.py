"""Install the bundled, locked Node dependencies asynchronously on first load."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil

from ..utils.process import run_process


class EngineDependencies:
    def __init__(self, settings, root):
        self.settings = settings
        self.root = Path(root)
        self.lock = asyncio.Lock()
        self.started = False
        self.ready = False
        self.message = '尚未检查'
        self.browser_message = ''

    @property
    def marker(self):
        return self.root / 'node_modules/.astrbot-dependencies.json'

    def fingerprint(self, version):
        digest = hashlib.sha256()
        for name in ('package.json', 'package-lock.json'):
            digest.update((self.root / name).read_bytes())
        digest.update(f'{version.split(".")[0]}:{platform.system()}:{platform.machine()}'.encode())
        return digest.hexdigest()

    def npm_command(self, node):
        # Run npm's JS entry with the selected Node, avoiding Windows .cmd shells.
        executable = shutil.which('npm')
        candidates = []
        if executable:
            path = Path(executable).resolve()
            if path.suffix == '.js': candidates.append(path)
            candidates += [path.parent/'node_modules/npm/bin/npm-cli.js',
                           path.parent.parent/'lib/node_modules/npm/bin/npm-cli.js']
        parent = Path(node).resolve().parent
        candidates += [parent/'node_modules/npm/bin/npm-cli.js',
                       parent.parent/'lib/node_modules/npm/bin/npm-cli.js',
                       Path('/usr/share/nodejs/npm/bin/npm-cli.js')]
        for candidate in candidates:
            if candidate.is_file(): return [node, str(candidate)]
        if executable and os.name != 'nt': return [executable]
        return None

    async def probe(self, node, env):
        result = await run_process([node, str(self.root/'probe.mjs')], 45, 2000, cwd=self.root, env=env)
        return result.code == 0 and not result.timed_out

    async def browser_probe(self, node, env):
        result = await run_process([node, str(self.root/'browser-check.mjs')], 50, 2000, cwd=self.root, env=env)
        try:
            data = json.loads(result.output)
            if result.code == 0 and data.get('ok') is True: return 'ready'
            return data.get('code', 'browser_launch')
        except (ValueError, AttributeError):
            return 'render_timeout' if result.timed_out else 'browser_launch'

    def system_install_allowed(self):
        return (self.settings.get('engine_auto_browser_system', True)
                and platform.system() == 'Linux' and getattr(os,'geteuid',lambda: -1)() == 0
                and bool(shutil.which('apt-get')))

    def is_debian(self):
        try: return re.search(r'^ID=["\']?debian["\']?$', Path('/etc/os-release').read_text(), re.M) is not None
        except OSError: return False

    async def prepare_browser(self, node, env):
        code = await self.browser_probe(node, env)
        if code == 'ready':
            self.browser_message = '图片渲染已就绪（已实际启动浏览器并截图）。'
            return
        self.browser_message = '正在下载 Chromium，文字命令仍可使用。'
        cli = [node, str(self.root/'node_modules/playwright/cli.js')]
        result = await run_process(cli + ['install','chromium'], 600, 4000, cwd=self.root, env=env)
        code = await self.browser_probe(node, env)
        if code != 'ready' and self.system_install_allowed():
            if code == 'system_libraries':
                self.browser_message = '正在补装 Chromium 所需的 Linux 系统库…'
                await run_process(cli + ['install-deps','chromium'], 600, 4000, cwd=self.root, env=env)
            elif self.is_debian() and (result.code or result.timed_out or code == 'browser_missing'):
                self.browser_message = '浏览器下载失败，正在通过 Debian 系统软件源安装 Chromium 和中文字体…'
                apt_env = {**env, 'DEBIAN_FRONTEND':'noninteractive'}
                updated = await run_process(['apt-get','update'], 180, 4000, env=apt_env)
                if updated.code == 0 and not updated.timed_out:
                    await run_process(['apt-get','install','-y','--no-install-recommends','chromium','fonts-noto-cjk'],600,4000,env=apt_env)
            code = await self.browser_probe(node, env)
        self.browser_message = browser_hint(code)

    async def ensure(self, *, force=False, browser=False):
        async with self.lock:
            self.started = True
            self.ready = False
            self.browser_message = ''
            self.message = '正在检查 Node.js 和依赖…'
            try:
                node = shutil.which(self.settings.get('engine_node') or 'node')
                if not node:
                    self.message = '未找到 Node.js。请先在 AstrBot 容器安装 Node.js 22+（含 npm），然后重载；插件会自动安装其余 Node 依赖。'
                    return
                version = await run_process([node, '--version'], 15, 200)
                match = re.match(r'v?(\d+)\.\d+\.\d+', version.output.strip())
                if version.code or not match or int(match[1]) < 22:
                    self.message = 'Node.js 版本不符合要求，请安装 Node.js 22+（含 npm），再重载插件。'
                    return
                fingerprint = self.fingerprint(version.output.strip())
                env = dict(os.environ)
                env['GOK_BROWSER'] = self.settings.get('browser_path', '')
                env['PATH'] = str(Path(node).parent) + os.pathsep + env.get('PATH', '')
                env['npm_config_update_notifier'] = 'false'
                env['npm_config_fetch_retries'] = '2'
                env['npm_config_fetch_timeout'] = '60000'
                try: saved = json.loads(self.marker.read_text(encoding='utf-8'))
                except (OSError, ValueError): saved = {}
                current = not force and saved.get('fingerprint') == fingerprint
                if not current or not await self.probe(node, env):
                    npm = self.npm_command(node)
                    if not npm:
                        self.message = '已找到 Node.js，但未找到 npm。请在容器补装 npm 后，管理员发送 #王者依赖安装 重试。'
                        return
                    self.marker.unlink(missing_ok=True)
                    self.message = '正在自动安装原版核心依赖，首次下载可能需要几分钟。完成后直接重发命令，无需重载。'
                    args = npm + ['ci', '--no-audit', '--no-fund', '--prefer-offline']
                    registry = self.settings.get('engine_npm_registry', '').strip()
                    if registry: args += ['--registry', registry]
                    result = await run_process(args, 600, 16000, cwd=self.root, env=env)
                    if result.code or result.timed_out:
                        self.message = self.failure_hint(result.output, result.timed_out)
                        return
                    if not await self.probe(node, env):
                        self.message = '依赖下载结束，但完整性检查未通过。管理员可发送 #王者依赖安装 重试，或在 engine 目录执行 npm ci 排查。'
                        return
                    self.marker.write_text(json.dumps({'fingerprint': fingerprint}), encoding='utf-8')
                self.ready = True
                self.message = '原版核心依赖已就绪，可以直接使用王者命令。'
                if browser or self.settings.get('engine_auto_browser', True):
                    await self.prepare_browser(node, env)
            except asyncio.CancelledError:
                if not self.ready: self.message = '依赖安装已随插件卸载停止，下次加载会重新检查。'
                raise
            except PermissionError:
                self.message = '插件目录不可写，无法自动安装依赖。请给 AstrBot 运行用户该插件目录的写入权限后重试。'
            except (OSError, ValueError):
                self.message = '依赖准备失败，请检查 Node/npm、磁盘空间和完整插件文件，再发送 #王者依赖安装。'

    @staticmethod
    def failure_hint(output, timed_out):
        if timed_out: reason = '下载超过 10 分钟，已停止'
        elif any(x in output for x in ('EACCES', 'EPERM')): reason = '插件目录或 npm 缓存没有写入权限'
        elif 'ENOSPC' in output: reason = '容器磁盘空间不足'
        elif any(x in output for x in ('ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNRESET','ECONNREFUSED','CERT_')): reason = '无法正常连接依赖下载服务，请检查容器网络或 npm 镜像设置'
        else: reason = 'npm 安装未成功，请检查容器网络及 Node/npm 环境'
        # Never echo npm output: private registry URLs may contain credentials.
        return '自动安装失败：' + reason + '。管理员发送 #王者依赖安装 可重试。'


def browser_hint(code):
    messages = {
        'ready':'图片渲染已就绪（已实际启动浏览器并截图）。',
        'browser_missing':'未找到可用 Chromium，自动下载未成功。管理员发送 #王者浏览器安装 重试；Debian/root 容器支持系统软件源回退。',
        'system_libraries':'Chromium 缺少 Linux 系统库。在插件 engine 目录执行 npx playwright install-deps chromium，或启用系统依赖自动修复后发送 #王者浏览器安装。',
        'template_error':'图片模板编译失败，请更新完整插件包，不能只覆盖 main.py。',
        'render_timeout':'图片渲染超时，请检查容器资源与图片网络后重试。',
        'browser_launch':'Chromium 启动失败，请检查容器权限、内存和系统库，管理员可发送 #王者浏览器安装 重试。',
        'render_error':'图片生成失败，请更新完整插件并检查 #王者依赖状态。',
    }
    return messages.get(code, messages['render_error'])
