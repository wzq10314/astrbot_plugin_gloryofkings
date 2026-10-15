"""Privacy adapter boundaries use synthetic inventory and account-free bridge fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import test_bridge as core
import test_main as host

ROOT = core.ROOT
PRIVATE_READS = ('隐私帮助', '隐私设置', '隐私状态', '隐私列表')
PRIVATE_WRITES = ('隐藏我的战绩', '公开我的战绩', '隐私隐藏 1',
                  '隐私公开 1 陌生人', '隐私隐藏')


def isolated_commands():
    """Remain runnable while the maintainer regenerates routes from real inventory."""
    inventory = json.loads((ROOT/'routes.json').read_text(encoding='utf-8'))
    if not any(app['file'] == 'campPrivacy.js' for app in inventory):
        inventory.append({'file': 'campPrivacy.js', 'rules': [
            {'reg': r'^#?隐私(?:帮助|设置|状态|列表)$', 'flags': '', 'fnc': 'showPrivacy'},
            {'reg': r'^#?(隐藏|公开)我的战绩$', 'flags': '', 'fnc': 'battleShortcut'},
            {'reg': r'^#?隐私(公开|隐藏)\s*(\d*)\s*(\S*)$', 'flags': '', 'fnc': 'setPrivacy'},
        ]})
    spec = importlib.util.spec_from_file_location('oct15_private_tool_commands', ROOT/'services/tool_commands.py')
    module = importlib.util.module_from_spec(spec)
    read_text = Path.read_text

    def route_fixture(path, *args, **kwargs):
        if path == ROOT/'routes.json':
            return json.dumps(inventory, ensure_ascii=False)
        return read_text(path, *args, **kwargs)

    with mock.patch.object(Path, 'read_text', route_fixture):
        spec.loader.exec_module(module)
    return module


COMMANDS = isolated_commands()


def main_policy():
    return mock.patch.multiple(host.main, normalize_tool_command=COMMANDS.normalize,
                               private_only=COMMANDS.private_only,
                               PRIVATE_NOTICE=COMMANDS.PRIVATE_NOTICE)


class PrivacyToolPolicy(unittest.TestCase):
    def test_read_aliases_are_allowed_but_all_privacy_routes_are_private(self):
        self.assertIn('campPrivacy.js', COMMANDS.PRIVATE_FILES)
        for command in (*PRIVATE_READS, *PRIVATE_WRITES):
            with self.subTest(command=command):
                self.assertTrue(COMMANDS.private_only('#'+command))
        for command in PRIVATE_READS:
            self.assertEqual(COMMANDS.normalize(command), '#'+command)

    def test_both_write_methods_are_explicitly_blocked_from_llm(self):
        self.assertTrue({'battleShortcut', 'setPrivacy'} <= COMMANDS.BLOCKED_METHODS)
        for command in PRIVATE_WRITES:
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, '直接发送.*隐私修改'):
                COMMANDS.normalize(command)

    def test_existing_im_and_query_policy_stays_unchanged(self):
        self.assertTrue(COMMANDS.private_only('#营地好友'))
        self.assertEqual(COMMANDS.normalize('查询战绩'), '#查询战绩')
        for command in ('营地私聊 1 fixture', '王者配置 token fixture'):
            with self.assertRaises(ValueError):
                COMMANDS.normalize(command)


class PrivacyMainBoundary(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = host.Tool.asyncSetUp
    asyncTearDown = host.Tool.asyncTearDown

    async def test_group_direct_commands_stop_before_dependencies_or_bridge(self):
        self.plugin.dependencies.ready = False
        with main_policy():
            for user in ('12345001', '12345002'):
                for command in (*PRIVATE_READS, *PRIVATE_WRITES):
                    with self.subTest(user=user, command=command):
                        event = host.Event('#'+command, group='987654321', user=user)
                        await self.plugin.on_message(event)
                        self.assertTrue(event.stopped)
                        self.assertEqual(event.sent, [COMMANDS.PRIVATE_NOTICE])
                        self.assertFalse(event.bot.calls)
        self.assertFalse(self.plugin.bridges)

    async def test_llm_group_read_queries_never_start_core(self):
        with main_policy():
            for command in PRIVATE_READS:
                event = host.Event(group='987654321', user='12345002')
                answer = await self.plugin.kings_tool(event, command)
                self.assertEqual(answer, '未执行：'+COMMANDS.PRIVATE_NOTICE)
                self.assertFalse(event.bot.calls)
        self.assertFalse(self.plugin.bridges)

    async def test_llm_writes_are_blocked_for_private_and_admin_contexts(self):
        with main_policy():
            for user in ('12345001', '12345002'):
                for group in ('', '987654321'):
                    for command in PRIVATE_WRITES:
                        with self.subTest(user=user, group=group, command=command):
                            event = host.Event(group=group, user=user)
                            answer = await self.plugin.kings_tool(event, command)
                            self.assertTrue(answer.startswith('未执行：'), answer)
                            self.assertIn('隐私修改', answer)
                            self.assertFalse(event.bot.calls)
        self.assertFalse(self.plugin.bridges)

    async def test_private_llm_reads_keep_current_actor_and_read_command(self):
        request = mock.AsyncMock(return_value={'handled': True, 'messages': ['只读隐私 fixture']})
        bridge = type('ReadOnlyBridge', (), {'request': request})()
        self.plugin.event_bridge = mock.AsyncMock(return_value=bridge)
        with main_policy():
            for command in PRIVATE_READS:
                event = host.Event(user='12345001')
                answer = await self.plugin.kings_tool(event, command)
                self.assertIn('只读隐私 fixture', answer)
                operation, data = request.call_args.args
                self.assertEqual(operation, 'event')
                self.assertEqual(data['msg'], '#'+command)
                self.assertEqual(data['user_id'], '12345001')
                self.assertEqual(data['group_id'], '')
                self.assertFalse(data['isGroup'])
                self.assertFalse(data['isMaster'])
                self.assertFalse(event.bot.calls)


class PrivacyWorkerBoundary(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = core.Integration.asyncSetUp
    asyncTearDown = core.Integration.asyncTearDown
    command = core.Integration.command

    async def test_direct_worker_group_privacy_is_blocked_even_for_admin(self):
        for command in (*PRIVATE_READS, *PRIVATE_WRITES):
            with self.subTest(command=command):
                result, calls = await self.command('#'+command, group='987654321',
                                                   user='12345002', master=True)
                self.assertTrue(result['handled'])
                self.assertEqual(result['messages'], [COMMANDS.PRIVATE_NOTICE])
                self.assertEqual([action for action, _ in calls], ['send_group_msg'])
                self.assertIn(COMMANDS.PRIVATE_NOTICE, json.dumps(calls, ensure_ascii=False))

    async def test_private_help_is_routable_without_a_real_account(self):
        result, calls = await self.command('#隐私帮助')
        self.assertTrue(result['handled'])
        self.assertNotIn(COMMANDS.PRIVATE_NOTICE, result['messages'])
        self.assertTrue(calls)
        self.assertTrue(all(action == 'send_private_msg' for action, _ in calls))


class PrivacyHelpButtons(unittest.TestCase):
    def test_existing_help_builder_exposes_read_only_privacy_entry(self):
        script = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {helpButtonRows} from './engine/help-buttons.mjs';
globalThis.fetch = async () => {throw Error('No network in privacy help fixture')};
const source = fs.readFileSync('./engine/upstream/apps/help.js', 'utf8');
assert.ok(source.includes("cmd: '#隐私帮助', alias: ['#隐私设置', '#隐私状态']"));
const rows = helpButtonRows({msg:'#王者帮助', isGroup:true, isMaster:false}, [{list:[
  {cmd:'#隐私帮助',alias:['#隐私设置','#隐私状态'],desc:'仅私聊'}
]}]);
const callbacks = rows.flat().map(button => button.callback);
assert.deepEqual(callbacks, ['#隐私帮助','#隐私设置','#隐私状态']);
assert.ok(callbacks.every(command => !/隐私(?:隐藏|公开)|(?:隐藏|公开)我的战绩/.test(command)));
console.log('privacy help read-only callbacks: 3');
"""
        result = subprocess.run([os.environ.get('GOK_NODE', 'node'), '--input-type=module', '-e', script],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('read-only callbacks: 3', result.stdout)


if __name__ == '__main__':
    unittest.main()
