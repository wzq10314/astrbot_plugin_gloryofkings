"""Upstream October 18 adapter boundaries, using account-free fixtures only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import yaml
import test_bridge as core
import test_main as host

ROOT = core.ROOT


class October18Policy(unittest.TestCase):
    def test_new_routes_and_llm_read_queries(self):
        inventory = json.loads((ROOT/'routes.json').read_text(encoding='utf-8'))
        self.assertEqual(len(inventory), 48)
        self.assertEqual(sum(len(app['rules']) for app in inventory), 126)
        for command in ('妲己总排名', '元法总排名', '排位总排名', '巅峰总排名',
                        '排位bot排名', '巅峰bot排名', '开黑列表'):
            self.assertEqual(host.commands.normalize(command), '#'+command)

    def test_llm_cannot_publish_contacts_or_manage_team_broadcasts(self):
        for command in ('发起开黑 打野 缺辅助 3排', '加入开黑 12 辅助',
                        '退出开黑 12', '取消开黑 12', '开启开黑广播', '关闭开黑广播'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                host.commands.normalize(command)

    def test_schema_defaults_are_opt_in(self):
        config = yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
        schema = json.loads((ROOT/'_conf_schema.json').read_text(encoding='utf-8'))
        self.assertIs(config['teamUpEnabled'], False)
        self.assertEqual(config['teamBroadcastGroups'], [])
        self.assertIs(schema['teamUpEnabled']['default'], False)
        self.assertEqual(schema['teamBroadcastGroups']['default'], [])

    def test_runtime_preserves_explicit_settings_and_does_not_fill_author_endpoint(self):
        with tempfile.TemporaryDirectory(prefix='gok-oct18-config-') as folder:
            destination = Path(folder)
            settings = yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
            target = core.runtime_module.prepare_runtime(ROOT/'engine', destination, settings)
            template_path = target/'config/default_config/config.yaml'
            self.assertEqual(yaml.safe_load(template_path.read_text(encoding='utf-8'))['distUrl'], '')
            config_path = target/'config/config/config.yaml'
            config = yaml.safe_load(config_path.read_text(encoding='utf-8'))
            config.update(teamUpEnabled=True, teamBroadcastGroups=['fixture-group'],
                          distUrl='https://administrator.invalid', privateFixture='kept')
            config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
            sentinel = target/'data'/'oct18-private-fixture.txt'
            sentinel.write_text('must-survive', encoding='utf-8')
            core.runtime_module.prepare_runtime(ROOT/'engine', destination, settings)
            after = yaml.safe_load(config_path.read_text(encoding='utf-8'))
            self.assertIs(after['teamUpEnabled'], True)
            self.assertEqual(after['teamBroadcastGroups'], ['fixture-group'])
            self.assertEqual(after['distUrl'], 'https://administrator.invalid')
            self.assertEqual(after['privateFixture'], 'kept')
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'must-survive')

    def test_real_upstream_client_ranking_and_template_bodies(self):
        result = subprocess.run([os.environ.get('GOK_NODE', 'node'),
                                 'tests/oct18_upstream_regressions.mjs'], cwd=ROOT,
                                capture_output=True, encoding='utf-8', timeout=35)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('October 18 offline body checks: 8', result.stdout)


class October18Worker(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = core.Integration.asyncSetUp
    asyncTearDown = core.Integration.asyncTearDown
    command = core.Integration.command

    async def test_update_status_reports_current_metadata_even_without_network(self):
        metadata = yaml.safe_load((ROOT/'metadata.yaml').read_text(encoding='utf-8'))
        version = metadata['version'].lstrip('v')
        plugin = object.__new__(host.main.GloryOfKingsPlugin)
        plugin.upstream_cache = (0, '')
        with mock.patch.object(host.main.aiohttp, 'ClientSession', side_effect=RuntimeError('offline fixture')):
            answer = await plugin.upstream_status()
        self.assertIn('AstrBot 适配版 '+version+'\n', answer)
        self.assertNotIn('AstrBot 适配版 1.0.19', answer)

    async def test_new_team_command_is_routed_but_disabled_by_default(self):
        result, calls = await self.command('#开黑列表')
        self.assertTrue(result['handled'])
        self.assertTrue(result['messages'])
        self.assertTrue(all(action == 'send_private_msg' for action, _ in calls))
        config = yaml.safe_load((self.bridge.root/'plugins/GloryOfKings-Plugin/config/config/config.yaml').read_text(encoding='utf-8'))
        self.assertIs(config['teamUpEnabled'], False)
        self.assertEqual(config['teamBroadcastGroups'], [])

    async def test_team_broadcast_requires_current_group_admin(self):
        _, calls = await self.command('#开启开黑广播', group='987654321')
        self.assertIn('管理员', json.dumps(calls, ensure_ascii=False))
        config = yaml.safe_load((self.bridge.root/'plugins/GloryOfKings-Plugin/config/config/config.yaml').read_text(encoding='utf-8'))
        self.assertEqual(config['teamBroadcastGroups'], [])


if __name__ == '__main__':
    unittest.main()
