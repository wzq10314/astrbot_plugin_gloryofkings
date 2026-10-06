"""Offline transport contract tests; no credentials, Node dependencies or QQ calls."""
import base64
import importlib
import logging
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'gok_official_transport_fixture'


class Component:
    def __init__(self, value=None, **kwargs):
        self.value = value
        self.__dict__.update(kwargs)

    @classmethod
    def fromBase64(cls, value):
        return cls(file='base64://' + value)

    @classmethod
    def fromFileSystem(cls, value):
        return cls(file=str(value))


class Plain(Component):
    def __init__(self, text):
        self.text = text


class Nodes(Component):
    def __init__(self, nodes):
        self.nodes = nodes


components = types.ModuleType('astrbot.api.message_components')
for name in ('Image', 'Video', 'Record', 'File', 'At', 'Node'):
    setattr(components, name, type(name, (Component,), {}))
components.Plain = Plain
components.Nodes = Nodes
api = types.ModuleType('astrbot.api')
api.logger = logging.getLogger('gok-official-test')
api.message_components = components
astrbot = types.ModuleType('astrbot')
astrbot.api = api
events = types.ModuleType('astrbot.api.event')
events.MessageChain = Component
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
runtime = types.ModuleType(PACKAGE + '.services.runtime')
runtime.prepare_runtime = lambda *args: None
http = types.ModuleType(PACKAGE + '.utils.http')
http.PublicHTTP = object
STUBS = {'astrbot': astrbot, 'astrbot.api': api, 'astrbot.api.message_components': components,
         'astrbot.api.event': events, PACKAGE: package,
         PACKAGE + '.services.runtime': runtime, PACKAGE + '.utils.http': http}
with patch.dict(sys.modules, STUBS):
    official = importlib.import_module(PACKAGE + '.services.official')
    onebot = importlib.import_module(PACKAGE + '.services.bridge')


class Context:
    def __init__(self):
        self.sent = []

    async def send_message(self, origin, message):
        self.sent.append((origin, message))
        return True


class Event:
    def __init__(self, group='GROUP_OPEN_ID_A', user='USER_OPEN_ID_A', platform='official-a'):
        self.group, self.user, self.platform = group, user, platform
        self.bot = types.SimpleNamespace(platform=types.SimpleNamespace(appid='100000001'))
        self.unified_msg_origin = platform + ':' + ('GroupMessage:' + group if group else 'FriendMessage:' + user)
        self.sent, self.extra, self.files, self.videos = [], {}, [], []

    def get_platform_id(self): return self.platform
    def get_sender_id(self): return self.user
    def get_group_id(self): return self.group
    def is_private_chat(self): return not self.group
    def set_extra(self, key, value): self.extra[key] = value

    async def send(self, message):
        self.sent.append(message)
        for part in message.chain:
            if isinstance(part, components.File):
                self.files.append((part.name, Path(part.file).read_bytes(), part.file))
            elif isinstance(part, components.Video):
                self.videos.append((Path(part.file).read_bytes(), part.file))


class OfficialTransport(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stub_patch = patch.dict(sys.modules, STUBS)
        self.stub_patch.start()
        self.temp = tempfile.TemporaryDirectory()
        self.context = Context()
        self.plugin = types.SimpleNamespace(data=Path(self.temp.name), context=self.context)
        self.bridge = official.OfficialBridge(self.plugin, None, 'official-a', '100000001')

    def tearDown(self):
        self.temp.cleanup()
        self.stub_patch.stop()

    async def test_opaque_openids_use_original_event_and_preserve_buttons(self):
        first, second = Event(), Event()
        ref = self.bridge.observe(first)
        self.bridge.observe(second)
        result = await self.bridge.send({'kind': 'group', 'id': first.group, 'event_ref': ref,
            'message': ['真实结果', {'type': 'button', 'rows': [[{'text': '查战力', 'input': '#查战力 '}]]}]})
        self.assertEqual(result, {})  # no invented platform message ID
        self.assertEqual(first.sent[0].chain[0].text, '真实结果')
        self.assertFalse(second.sent)
        self.assertFalse(self.context.sent)
        self.assertEqual(first.sent[0].qqofficial_buttons[0][0]['input'], '#查战力 ')
        self.assertFalse(first.extra['qq_official_card']['buttons'][0]['enter'])

    async def test_bare_binding_opens_tutorial_on_passive_and_proactive_cards(self):
        event = Event()
        ref = self.bridge.observe(event)
        original = [[{'text': '绑定营地', 'input': '#绑定营地 '}],
                    [{'text': '绑定具体账号', 'input': '#绑定营地 12345'},
                     {'text': '删除营地', 'input': '#删除营地'}]]
        message = ['绑定帮助', {'type': 'button', 'rows': original}]
        await self.bridge.send({'kind': 'group', 'id': event.group, 'event_ref': ref,
                                'message': message})
        await self.bridge.send({'kind': 'group', 'id': event.group, 'message': message})
        for chain in (event.sent[0], self.context.sent[0][1]):
            first = chain.qqofficial_buttons[0][0]
            self.assertEqual(first['callback'], '#绑定营地')
            self.assertTrue(first['enter'])
            self.assertNotIn('input', first)
            self.assertEqual(chain.qqofficial_buttons[1], original[1])
        hint = event.extra['qq_official_card']['buttons']
        self.assertEqual([button['enter'] for button in hint], [True, False, False])
        self.assertEqual(original[0][0], {'text': '绑定营地', 'input': '#绑定营地 '})

    async def test_group_event_cannot_create_private_destination(self):
        event = Event()
        ref = self.bridge.observe(event)
        with self.assertRaisesRegex(official.BridgeError, '尚无此'):
            await self.bridge.send({'kind': 'private', 'id': event.user, 'event_ref': ref, 'message': 'private'})
        self.assertFalse(event.sent)
        self.assertFalse(self.context.sent)

    async def test_saved_session_restores_push_and_isolates_adapters(self):
        event = Event()
        self.bridge.observe(event)
        restored = official.OfficialBridge(self.plugin, None, 'official-a', '100000001')
        await restored.send({'kind': 'group', 'id': event.group, 'message': '订阅推送'})
        self.assertEqual(self.context.sent[0][0], event.unified_msg_origin)
        other = official.OfficialBridge(self.plugin, None, 'official-b', '100000001')
        with self.assertRaises(official.BridgeError):
            await other.send({'kind': 'group', 'id': event.group, 'message': 'wrong adapter'})
        with self.assertRaises(official.BridgeError):
            other.observe(event)
        self.assertEqual(official.OfficialBridge.saved_accounts(self.plugin.data, 'official-a'), ['100000001'])
        self.assertEqual(official.OfficialBridge.saved_accounts(self.plugin.data, 'official-b'), [])

    async def test_private_session_is_distinct_and_never_falls_back_to_group(self):
        group, private = Event(), Event(group='')
        ref = self.bridge.observe(group)
        self.bridge.observe(private)
        await self.bridge.send({'kind': 'private', 'id': private.user, 'event_ref': ref, 'message': 'private'})
        self.assertFalse(group.sent)
        self.assertEqual(self.context.sent[0][0], private.unified_msg_origin)

    async def test_forward_media_and_export_use_astrbot_components(self):
        event = Event(group='')
        ref = self.bridge.observe(event)
        await self.bridge.send({'kind': 'private', 'id': event.user, 'event_ref': ref,
            'message': {'type': 'forward', 'rows': [{'message': ['page 1',
                {'type': 'image', 'data': {'file': 'base64://' + base64.b64encode(b'image').decode()}}]}]}})
        node = event.sent[0].chain[0].nodes[0]
        self.assertEqual(node.content[0].text, 'page 1')
        self.assertEqual(node.content[1].file, 'base64://aW1hZ2U=')
        file = self.bridge.root / 'export.csv'
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('name,value\nA,1', encoding='utf-8')
        await self.bridge.upload({'kind': 'private', 'id': event.user, 'event_ref': ref,
                                  'file': str(file), 'name': '战绩.csv'})
        delivered = event.sent[1].chain[0]
        self.assertEqual(delivered.name, '战绩.csv')
        self.assertEqual(event.files[0][1], file.read_bytes())
        self.assertFalse(Path(delivered.file).exists())
        with self.assertRaises(official.BridgeError):
            await self.bridge.components({'type': 'file', 'data': {'file': str(ROOT / 'main.py')}})

    async def test_membership_unavailable_is_not_a_fabricated_roster(self):
        self.bridge.observe(Event())
        self.assertIsNone(await self.bridge.refresh_groups())
        self.assertEqual(await self.bridge.push_membership(['GROUP_OPEN_ID_A']), {'members': {}, 'available': False})
        for action in ('get_group_list', 'get_group_member_list', 'get_group_member_info'):
            with self.assertRaisesRegex(official.BridgeError, '完整群成员表'):
                await self.bridge.api(action, group_id='GROUP_OPEN_ID_A')

    async def test_video_uses_existing_local_mp4_until_send_finishes(self):
        event = Event(group='')
        ref = self.bridge.observe(event)
        await self.bridge.send({'kind':'private', 'id':event.user, 'event_ref':ref,
            'message':{'type':'video', 'data':{'file':'base64://dmlkZW8='}}})
        content, path = event.videos[0]
        self.assertEqual(content, b'video')
        self.assertTrue(path.endswith('.mp4'))
        self.assertFalse(path.startswith('base64://'))
        self.assertFalse(Path(path).exists())

    async def test_onebot_transport_still_uses_onebot_numeric_target(self):
        class Bot:
            def __init__(self): self.calls = []
            async def call_action(self, action, **params):
                self.calls.append((action, params))
                return {'status': 'ok', 'data': {'message_id': 123}}
        bot = Bot()
        bridge = onebot.Bridge(self.plugin, bot, 'napcat', '123456789')
        result = await bridge.send({'kind': 'group', 'id': '987654321', 'message': 'NapCat'})
        self.assertEqual(result, {'message_id': 123})
        self.assertEqual(bot.calls[0][0], 'send_group_msg')
        self.assertEqual(bot.calls[0][1]['self_id'], '123456789')
        with self.assertRaises(onebot.BridgeError):
            await bridge.send({'kind': 'group', 'id': 'GROUP_OPEN_ID_A', 'message': 'wrong transport'})


if __name__ == '__main__':
    unittest.main()
