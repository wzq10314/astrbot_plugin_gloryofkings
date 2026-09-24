"""A persistent worker for each OneBot account; requests and pushes share the same stores."""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import time
from urllib.parse import unquote, urlsplit

from astrbot.api import logger
from .runtime import prepare_runtime
from ..utils.http import PublicHTTP

ENGINE = Path(__file__).resolve().parent.parent / 'engine'
MAX_FILE = 32 * 1024 * 1024


class BridgeError(Exception):
    pass


class Bridge:
    def __init__(self, plugin, bot, platform_id, self_id):
        self.plugin, self.bot = plugin, bot
        self.platform_id, self.self_id = str(platform_id), str(self_id)
        namespace = hashlib.sha256(f'{self.platform_id}:{self.self_id}'.encode()).hexdigest()[:20]
        self.root = plugin.data / namespace / 'runtime'
        self.proc = None
        self.pending = {}
        self.tasks = set()
        self.serial = 0
        self.write_lock = asyncio.Lock()
        self.start_lock = asyncio.Lock()
        self.refresh_lock = asyncio.Lock()
        self.inventory = []
        self.jobs = 0
        self.last_groups = 0
        self.status = '尚未启动'
        self.closing = False

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None

    def track(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def start(self):
        async with self.start_lock:
            if self.closing:
                raise BridgeError('插件正在关闭。')
            if self.alive:
                return
            overrides=json.loads(self.plugin.settings.get('bot_overrides','{}')).get(self.self_id,{})
            settings={**self.plugin.settings, **overrides}
            prepare_runtime(ENGINE, self.root, settings, self.plugin.host_blacklist())
            self.ready = asyncio.get_running_loop().create_future()
            node = shutil.which(self.plugin.settings.get('engine_node') or 'node')
            if not node:
                raise BridgeError('未找到 Node.js，请先安装 Node.js 22+ 和 npm。')
            env = {**os.environ, 'TZ': 'Asia/Shanghai', 'GOK_BROWSER': self.plugin.settings.get('browser_path', '')}
            env['PATH'] = str(ENGINE/'node_modules/.bin') + os.pathsep + str(Path(node).parent) + os.pathsep + env.get('PATH', '')
            # pm2 instances for external services are isolated from other bots/plugins.
            env['PM2_HOME'] = str(self.root.parent / 'pm2')
            self.proc = await asyncio.create_subprocess_exec(node, str(ENGINE/'worker.mjs'),
                cwd=self.root, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=128*1024*1024,
                **({'creationflags':0x08000000} if os.name=='nt' else {'start_new_session':True}))
            self.track(self.read_loop())
            self.track(self.drain_errors())
            await self.write({'type':'start','root':str(self.root),'self_id':self.self_id,
                              'admins':self.plugin.admins()})
            try:
                async with asyncio.timeout(50):
                    await self.ready
            except BaseException:
                await self.kill()
                raise
            self.status = '运行中'
            self.last_groups = 0

    async def write(self, value):
        async with self.write_lock:
            if not self.alive:
                raise BridgeError('王者核心未运行。')
            self.proc.stdin.write((json.dumps(value, ensure_ascii=False)+'\n').encode())
            await self.proc.stdin.drain()

    async def request(self, op, data=None, timeout=360):
        if not self.alive:
            raise BridgeError('王者核心已停止，请发送 #王者依赖状态 或重载插件。')
        self.serial += 1
        ident = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.write({'type':'request','id':ident,'op':op,'data':data or {}})
            async with asyncio.timeout(timeout):
                return await future
        finally:
            self.pending.pop(ident, None)

    async def read_loop(self):
        proc = self.proc
        try:
            while line := await proc.stdout.readline():
                item = json.loads(line)
                kind = item.get('type')
                if kind == 'ready':
                    self.inventory = item['inventory']; self.jobs = item['jobs']
                    if not self.ready.done(): self.ready.set_result(True)
                elif kind == 'response':
                    future = self.pending.get(item['id'])
                    if future and not future.done():
                        if item.get('error'): future.set_exception(BridgeError('王者核心处理失败，请查看依赖状态；错误类型：'+str(item['error'])))
                        else: future.set_result(item.get('result'))
                elif kind == 'call':
                    self.track(self.respond(item))
                elif kind in {'diagnostic','fatal'}:
                    code = item.get('code','UnknownError')
                    self.status = code
                    logger.warning('GloryOfKings: %s', code)
                    if kind == 'fatal' and not self.ready.done(): self.ready.set_exception(BridgeError('核心加载失败：'+code))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning('GloryOfKings bridge: %s', type(error).__name__)
        finally:
            if not self.ready.done(): self.ready.set_exception(BridgeError('核心启动失败。'))
            for future in list(self.pending.values()):
                if not future.done(): future.set_exception(BridgeError('核心进程已退出，请重试或重载插件。'))
            self.status = '已停止'

    async def drain_errors(self):
        # Raw upstream stderr may include credentials. Only report worker failure codes.
        while await self.proc.stderr.read(4096):
            pass

    async def respond(self, item):
        try:
            result = await self.handle(item['op'], item.get('data') or {})
            output = {'type':'result','id':item['id'],'result':result}
        except asyncio.CancelledError:
            return
        except Exception as error:
            logger.warning('GloryOfKings %s: %s', item['op'], type(error).__name__)
            output = {'type':'result','id':item['id'],'error':type(error).__name__}
        try: await self.write(output)
        except (BridgeError, ConnectionError): pass

    async def api(self, action, **params):
        async with asyncio.timeout(60):
            result = await self.bot.call_action(action, **params, self_id=self.self_id)
        if isinstance(result, dict):
            if result.get('status') == 'failed' or result.get('retcode', 0):
                raise BridgeError('NapCat 操作失败。')
            if 'data' in result and ('status' in result or 'retcode' in result): return result['data']
        return result

    async def handle(self, op, data):
        if op == 'server_dependencies':
            from .server_dependencies import ServerDependencies
            if not hasattr(self, 'server_dependencies'):
                self.server_dependencies = ServerDependencies(ENGINE, self.root, self.plugin.settings)
            return await self.server_dependencies.ensure(data['directory'])
        if op == 'asset':
            return await self.asset(data['url'])
        if op == 'upstream':
            return await self.plugin.upstream_status()
        if op == 'send':
            return await self.send(data)
        if op == 'upload':
            return await self.upload(data)
        if op == 'onebot':
            action, params = data['action'], data.get('params', {})
            if action == 'send_msg':
                private = params.get('message_type') == 'private' or not params.get('group_id')
                return await self.send({'kind':'private' if private else 'group',
                    'id':params['user_id'] if private else params['group_id'],'message':params['message']})
            if action not in {'get_msg','delete_msg','get_group_list','get_group_member_list','get_group_member_info','get_stranger_info','get_friend_list'}:
                raise BridgeError('UnsupportedOneBotAction')
            return await self.api(action, **params)
        raise BridgeError('UnsupportedHostOperation')

    async def asset(self, url):
        async with asyncio.timeout(8), PublicHTTP(7) as http:
            async with http.open(url) as response:
                mime = response.headers.get('Content-Type','').split(';')[0]
                if not mime.startswith('image/'):
                    raise BridgeError('UnsupportedAssetType')
                chunks, size = [], 0
                async for chunk in response.content.iter_chunked(65536):
                    size += len(chunk)
                    if size > 5*1024*1024: raise BridgeError('AssetTooLarge')
                    chunks.append(chunk)
                return {'mime':mime,'base64':base64.b64encode(b''.join(chunks)).decode()}

    async def file(self, value):
        value = str(value)
        if value.startswith('base64://'):
            if len(value) > MAX_FILE*4//3+32: raise BridgeError('文件过大。')
            return value
        if value.startswith(('https://','http://')):
            asset = await self.asset(value)
            return 'base64://'+asset['base64']
        if value.startswith('file:'):
            value = unquote(urlsplit(value).path)
            if os.name == 'nt' and value.startswith('/') and len(value)>2 and value[2]==':': value=value[1:]
        file = Path(value).resolve()
        if not file.is_relative_to(self.root.resolve()) or not file.is_file() or file.stat().st_size > MAX_FILE:
            raise BridgeError('文件路径无效或文件过大。')
        return 'base64://'+base64.b64encode(await asyncio.to_thread(file.read_bytes)).decode()

    async def segments(self, message):
        if message is None: return []
        if isinstance(message, str): return [{'type':'text','data':{'text':message}}]
        if isinstance(message, list):
            if len(message)>100: raise BridgeError('消息段过多。')
            result=[]
            for entry in message: result.extend(await self.segments(entry))
            return result
        if not isinstance(message, dict): return []
        kind=message.get('type')
        data=dict(message.get('data') or {})
        if kind in {'image','video','record','file'}: data['file']=await self.file(data.get('file',''))
        if kind not in {'image','video','record','file','text','at','reply'}: return []
        return [{'type':kind,'data':data}]

    async def send(self, data):
        kind = data['kind']
        if kind not in {'group','private'} or not str(data['id']).isdigit(): raise BridgeError('InvalidTarget')
        target = {'group_id' if kind=='group' else 'user_id':str(data['id'])}
        message = data['message']
        if isinstance(message,dict) and message.get('type')=='forward':
            nodes=[]
            for row in message['rows'][:50]:
                nodes.append({'type':'node','data':{'uin':self.self_id,'name':'王者营地',
                    'content':await self.segments(row.get('message',row.get('content','')))}})
            return await self.api(f'send_{kind}_forward_msg',**target,messages=nodes)
        segments = await self.segments(message)
        if len(segments)==1 and segments[0]['type']=='file':
            return await self.api(f'upload_{kind}_file',**target,**segments[0]['data'])
        if not segments: return {}
        if data.get('reply_id'): segments.insert(0,{'type':'reply','data':{'id':str(data['reply_id'])}})
        return await self.api(f'send_{kind}_msg',**target,message=segments)

    async def upload(self, data):
        kind = data['kind']
        target = {'group_id' if kind=='group' else 'user_id':str(data['id'])}
        return await self.api(f'upload_{kind}_file', **target, file=await self.file(data['file']),
                              name=data.get('name') or Path(data['file']).name)

    async def refresh_groups(self, force=False):
        if self.refresh_lock.locked() or (not force and time.monotonic()-self.last_groups<300): return
        async with self.refresh_lock:
            groups = await self.api('get_group_list')
            members = {}
            for group in groups:
                try: members[str(group['group_id'])] = await self.api('get_group_member_list',group_id=str(group['group_id']))
                except Exception: pass  # Keep prior cached members on transient failures.
            await self.request('groups',{'groups':groups,'members':members},timeout=20)
            self.last_groups = time.monotonic()

    async def kill(self):
        if not self.alive: return
        if os.name == 'nt':
            killer = await asyncio.create_subprocess_exec('taskkill','/PID',str(self.proc.pid),'/T','/F',
                stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,creationflags=0x08000000)
            await killer.wait()
        else:
            try: os.killpg(self.proc.pid,signal.SIGTERM)
            except ProcessLookupError: pass
        try: await asyncio.wait_for(self.proc.wait(),5)
        except asyncio.TimeoutError:
            if os.name!='nt':
                try: os.killpg(self.proc.pid,signal.SIGKILL)
                except ProcessLookupError: pass
            else: self.proc.kill()
            await self.proc.wait()

    async def close(self):
        self.closing=True
        if self.alive:
            try: await self.request('shutdown',timeout=5)
            except Exception: pass
            await self.kill()
        tasks=list(self.tasks)
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
