"""QQ Official transport. OpenIDs stay opaque and destinations come from real events.

The saved directory is a routing registry, never a complete member or group list.
No OneBot API is simulated with an incomplete membership snapshot.
"""
import base64
import hashlib
import json
import tempfile
import time
import uuid
from pathlib import Path

from .bridge import Bridge, BridgeError

PLATFORMS = frozenset({'qq_official', 'qq_official_webhook'})
MEMBERSHIP_NOTICE = ('QQ 官方接口未提供完整群成员表，暂不能生成全群排名、群报或全群在线名单。'
                     '个人查询、总排名和用户主动开启的个人推送仍可使用。')


def account_id(event):
    platform = getattr(getattr(event, 'bot', None), 'platform', None)
    return str(getattr(platform, 'appid', '') or event.get_platform_id())


def official_buttons(rows):
    """Let the bare binding entry open its tutorial without an extra send tap."""
    result = []
    for row in rows:
        converted = []
        for button in row:
            if isinstance(button, dict):
                button = dict(button)
                value = button.get('input')
                if isinstance(value, str) and value.strip() == '#绑定营地':
                    button.pop('input')
                    button.update(callback='#绑定营地', enter=True)
            converted.append(button)
        result.append(converted)
    return result


class OfficialBridge(Bridge):
    official = True

    def __init__(self, plugin, bot, platform_id, self_id):
        super().__init__(plugin, bot, platform_id, self_id)
        self.session_file = self.root.parent / 'official-sessions.json'
        self.sessions = {}
        self.events = {}
        if self.session_file.exists():
            try:
                data = json.loads(self.session_file.read_text(encoding='utf-8'))
                if data.get('platform_id') == self.platform_id and data.get('self_id') == self.self_id:
                    self.sessions = {k:v for k,v in data.get('sessions', {}).items()
                                     if isinstance(v, dict) and isinstance(v.get('origin'), str)}
            except (ValueError, OSError, AttributeError):
                raise BridgeError('QQ 官方会话路由文件损坏，请检查备份。') from None

    @staticmethod
    def saved_accounts(data_dir, platform_id):
        accounts = set()
        for file in Path(data_dir).glob('*/official-sessions.json'):
            try:
                data = json.loads(file.read_text(encoding='utf-8'))
                if data.get('platform_id') == str(platform_id) and data.get('self_id'):
                    accounts.add(str(data['self_id']))
            except (ValueError, OSError, AttributeError):
                continue
        return sorted(accounts)

    def observe(self, event):
        if str(event.get_platform_id()) != self.platform_id or account_id(event) != self.self_id:
            raise BridgeError('QQ 官方会话不属于当前机器人。')
        kind = 'private' if event.is_private_chat() else 'group'
        identifier = str(event.get_sender_id() if kind == 'private' else event.get_group_id())
        if not identifier:
            raise BridgeError('QQ 官方消息缺少会话标识。')
        key = kind + ':' + identifier
        record = {'origin': str(event.unified_msg_origin), 'kind': kind, 'id': identifier}
        if self.sessions.get(key) != record:
            self.sessions[key] = record
            self.session_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.session_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'platform_id': self.platform_id,
                'self_id': self.self_id, 'sessions': self.sessions}, ensure_ascii=False), encoding='utf-8')
            temporary.replace(self.session_file)
        now = time.monotonic()
        self.events = {ref: row for ref,row in self.events.items() if now-row[0] < 240}
        while len(self.events) >= 256:
            self.events.pop(next(iter(self.events)))
        ref = uuid.uuid4().hex
        self.events[ref] = (now, key, event)
        return ref

    async def refresh_groups(self, force=False):
        # Discovery is intentionally unavailable; observed sessions are not membership.
        return None

    async def push_membership(self, groups):
        return {'members': {}, 'available': False}

    async def api(self, action, **params):
        if action in {'get_group_list', 'get_group_member_list', 'get_group_member_info',
                      'get_friend_list', 'get_stranger_info'}:
            raise BridgeError(MEMBERSHIP_NOTICE)
        if action == 'get_msg':
            raise BridgeError('QQ 官方接口无法读取任意历史消息，请使用带编号的营地回复命令。')
        if action == 'delete_msg':
            raise BridgeError('当前 QQ 官方会话不支持此撤回接口。')
        raise BridgeError('QQ 官方接口不支持此 OneBot 操作。')

    async def components(self, message, buttons=None, directory=None):
        # Imported lazily so the unchanged OneBot path has no additional dependencies.
        import astrbot.api.message_components as Comp
        if message is None:
            return []
        if isinstance(message, str):
            return [Comp.Plain(message)]
        if isinstance(message, list):
            if len(message) > 100:
                raise BridgeError('消息段过多。')
            result = []
            for item in message:
                result.extend(await self.components(item, buttons, directory))
            return result
        if not isinstance(message, dict):
            return []
        kind = message.get('type')
        data = message.get('data') or {}
        if kind == 'button':
            if buttons is not None:
                buttons.extend(official_buttons(message.get('rows', [])))
            return []
        if kind == 'forward':
            nodes = [Comp.Node(name='王者营地', uin=self.self_id,
                       content=await self.components(row.get('message', row.get('content', '')), buttons, directory))
                     for row in message.get('rows', [])[:50]]
            return [Comp.Nodes(nodes)]
        if kind == 'text':
            return [Comp.Plain(str(data.get('text', '')))]
        if kind == 'reply':
            # The platform uses the incoming event's true msg_id for a passive reply.
            return []
        if kind == 'at':
            return [Comp.At(qq=str(data.get('qq', '')), name=str(data.get('name', '')))]
        if kind in {'image', 'video', 'record', 'file'}:
            encoded = await self.file(data.get('file') or data.get('url', ''))
            if kind in {'file', 'video'}:
                if directory is None:
                    raise BridgeError('文件和视频必须在发送上下文中转换。')
                raw = base64.b64decode(encoded.removeprefix('base64://'), validate=True)
                name = str(data.get('name') or '王者导出文件')
                target = Path(directory) / (hashlib.sha256(raw).hexdigest() + ('.mp4' if kind == 'video' else ''))
                target.write_bytes(raw)
                if kind == 'video':
                    return [Comp.Video.fromFileSystem(target)]
                return [Comp.File(name=name, file=str(target))]
            cls = {'image': Comp.Image, 'record': Comp.Record}[kind]
            return [cls.fromBase64(encoded.removeprefix('base64://'))]
        raise BridgeError('QQ 官方发送不支持的消息类型：' + str(kind))

    async def send(self, data):
        kind, identifier = data.get('kind'), str(data.get('id', ''))
        if kind not in {'group', 'private'} or not identifier:
            raise BridgeError('InvalidTarget')
        key = kind + ':' + identifier
        destination = self.sessions.get(key)
        if not destination:
            raise BridgeError('尚无此 QQ 官方会话。请先在目标群或私聊中与机器人交互；不会改发其他会话。')
        with tempfile.TemporaryDirectory(prefix='gok-official-send-') as directory:
            return await self._deliver(data, destination, key, directory)

    async def _deliver(self, data, destination, key, directory):
        from astrbot.api.event import MessageChain
        buttons = []
        parts = await self.components(data.get('message'), buttons, directory)
        if not parts:
            return {}
        chain = MessageChain(chain=parts)
        if buttons:
            chain.qqofficial_buttons = buttons
        row = self.events.get(data.get('event_ref'))
        if row and row[1] == key and time.monotonic()-row[0] < 240:
            if hasattr(row[2], 'set_extra'):
                row[2].set_extra('qq_official_card', {'title': '王者营地', 'family': '王者',
                    'buttons': [{'label': str(button.get('text', '')), 'command': str(button.get('input') or button.get('callback') or ''),
                                 'enter': bool(button.get('callback')) and not bool(button.get('input'))} for button_row in buttons for button in button_row
                                if isinstance(button, dict) and (button.get('callback') or button.get('input'))]})
            result = await row[2].send(chain)
        else:
            result = await self.plugin.context.send_message(destination['origin'], chain)
        if result is False:
            raise BridgeError('QQ 官方消息未发送成功，请检查主动消息权限及平台限制。')
        # AstrBot send() may return None. Do not invent a receipt or message ID.
        return result if isinstance(result, dict) else {}

    async def upload(self, data):
        return await self.send({**data, 'message': {'type': 'file', 'data': {
            'file': data['file'], 'name': data.get('name') or Path(data['file']).name}}})
