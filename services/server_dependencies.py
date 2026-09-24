"""Install dependencies inside downloaded services, before PM2 starts them."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil

from .dependencies import EngineDependencies
from ..utils.process import run_process


class ServerDependencies:
    def __init__(self, engine, runtime, settings):
        self.engine, self.runtime, self.settings = Path(engine), Path(runtime), settings
        self.lock = asyncio.Lock()

    def fingerprint(self, directory):
        digest = hashlib.sha256(b'service-deps-v1-ws8')
        for name in ('package.json','package-lock.json'):
            file = directory/name
            digest.update(file.read_bytes() if file.exists() else b'')
        return digest.hexdigest()

    async def ensure(self, directory):
        async with self.lock:
            directory = Path(directory).resolve()
            base = (self.runtime/'plugins/GloryOfKings-Plugin').resolve()
            allowed = {base/'server-im': 'camp-im-server.js', base/'server': 'watch-server.js'}
            if directory not in allowed or not (directory/allowed[directory]).is_file():
                return {'ok': False, 'message': '服务目录或入口文件不正确，未安装依赖。'}
            node = shutil.which(self.settings.get('engine_node') or 'node')
            if not node:
                return {'ok': False, 'message': '未找到 Node.js，请安装 Node.js 22+ 和 npm。'}
            npm = EngineDependencies(self.settings, self.engine).npm_command(node)
            if not npm:
                return {'ok': False, 'message': '未找到 npm，无法自动准备服务依赖。'}
            try:
                manifest = directory/'package.json'
                package = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
                required = list(package.get('dependencies', {}))
                # Some upstream IM releases omit ws from their manifest.
                fallback_ws = directory.name == 'server-im' and 'ws' not in required
                if directory.name == 'server-im' and 'ws' not in required: required.append('ws')
                probe = [node, str(self.engine/'server-probe.mjs'), str(directory), json.dumps(required)]
                fingerprint = self.fingerprint(directory)
                marker = directory/'.astrbot-service-dependencies'
                result = await run_process(probe, 15, 1000)
                if result.code == 0 and marker.exists() and marker.read_text() == fingerprint:
                    return {'ok': True, 'changed': False}
                env = {**os.environ, 'npm_config_update_notifier': 'false',
                       'npm_config_fetch_retries': '1', 'npm_config_fetch_timeout': '30000'}
                env['PATH'] = str(Path(node).parent)+os.pathsep+env.get('PATH','')
                registry = str(self.settings.get('engine_npm_registry','')).strip()
                flags = ['--ignore-scripts', '--no-audit', '--no-fund']
                if registry: flags += ['--registry', registry]
                # A shipped lock is authoritative. An omitted ws is added separately.
                if (directory/'package-lock.json').exists():
                    commands = [npm+['ci', '--omit=dev']+flags]
                    if fallback_ws: commands.append(npm+['install','--no-save','--package-lock=false','ws@^8.18.0']+flags)
                else:
                    commands = [npm+['install','--omit=dev','--no-save','--package-lock=false']+
                                (['ws@^8.18.0'] if fallback_ws else [])+flags]
                for command in commands:
                    result = await run_process(command, 100, 3000, cwd=directory, env=env)
                    if result.code != 0 or result.timed_out:
                        return {'ok': False, 'message': '服务依赖安装失败或超时，请检查 npm 镜像、网络和目录权限，然后重试部署。'}
                result = await run_process(probe, 15, 1000)
                if result.code != 0:
                    return {'ok': False, 'message': '服务依赖检查未通过，未启动服务。请检查服务包的依赖声明。'}
                marker.write_text(self.fingerprint(directory))
                return {'ok': True, 'changed': True}
            except (OSError, ValueError, TypeError):
                return {'ok': False, 'message': '服务依赖清单读取或安装失败，请检查服务包和运行环境。'}
