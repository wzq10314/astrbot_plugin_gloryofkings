"""Full-roster upload stays separate from existing individual sharing consent."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml
import test_bridge as core

ROOT = core.ROOT


class October19RosterPolicy(unittest.TestCase):
    def test_public_schema_defaults_are_opt_in_and_describe_identity_fields(self):
        cfg = yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
        schema = json.loads((ROOT/'_conf_schema.json').read_text(encoding='utf-8'))
        self.assertIs(cfg['shareRosterUploadEnabled'], False)
        self.assertIs(schema['shareRosterUploadEnabled']['default'], False)
        self.assertIn('QQ', schema['shareRosterUploadEnabled']['description'])
        self.assertIn('营地ID', schema['shareRosterUploadEnabled']['description'])

    def test_runtime_hook_is_narrow_and_rejects_drift(self):
        source = (ROOT/'engine/upstream/utils/shareStore.js').read_text(encoding='utf-8')
        modified = core.runtime_module.adapt_roster_upload_consent(source)
        self.assertIn("shareRosterUploadEnabled !== true", modified)
        before = "export async function uploadLocalBindings (force = false) {"
        self.assertEqual(source[:source.index(before)], modified[:modified.index(before)])
        self.assertEqual(source[source.index('export async function revokeBind'):],
                         modified[modified.index('export async function revokeBind'):])
        with self.assertRaises(ValueError):
            core.runtime_module.adapt_roster_upload_consent(source.replace(before, before+' changed'))

    def test_runtime_default_false_and_private_state_survives_reload(self):
        settings = yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory(prefix='gok-oct19-runtime-') as temp:
            destination = Path(temp)
            target = core.runtime_module.prepare_runtime(ROOT/'engine', destination, settings)
            config_file = target/'config/config/config.yaml'
            current = yaml.safe_load(config_file.read_text(encoding='utf-8'))
            self.assertIs(current['shareRosterUploadEnabled'], False)
            source = (target/'utils/shareStore.js').read_text(encoding='utf-8')
            self.assertIn("shareRosterUploadEnabled !== true", source)
            current['privateFixture'] = 'retained'
            current['shareEnabled'] = True
            current['shareRosterUploadEnabled'] = True
            config_file.write_text(yaml.safe_dump(current), encoding='utf-8')
            core.runtime_module.prepare_runtime(ROOT/'engine', destination, settings)
            after = yaml.safe_load(config_file.read_text(encoding='utf-8'))
            self.assertEqual(after['privateFixture'], 'retained')
            self.assertIs(after['shareEnabled'], True)
            self.assertIs(after['shareRosterUploadEnabled'], True)

    def test_explicit_ui_choice_propagates_to_worker_config(self):
        settings = yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
        settings['shareRosterUploadEnabled'] = True
        with tempfile.TemporaryDirectory(prefix='gok-oct19-ui-') as temp:
            target = core.runtime_module.prepare_runtime(ROOT/'engine', Path(temp), settings)
            config_file = target/'config/config/config.yaml'
            self.assertIs(yaml.safe_load(config_file.read_text(encoding='utf-8'))['shareRosterUploadEnabled'], True)
            settings['shareRosterUploadEnabled'] = False
            core.runtime_module.prepare_runtime(ROOT/'engine', Path(temp), settings)
            self.assertIs(yaml.safe_load(config_file.read_text(encoding='utf-8'))['shareRosterUploadEnabled'], False)

    def test_vendor_files_match_pinned_manifest(self):
        up = json.loads((ROOT/'UPSTREAM.json').read_text(encoding='utf-8'))
        self.assertEqual(up['commit'], 'c203c73bd9386564a3de16886771b3c3caa3c763')
        for name, expected in up['files'].items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((ROOT/'engine/upstream'/name).read_bytes()).hexdigest(), expected)

    def test_actual_adapted_runtime_body_and_upstream_regressions(self):
        source = (ROOT/'engine/upstream/utils/shareStore.js').read_text(encoding='utf-8')
        modified = core.runtime_module.adapt_roster_upload_consent(source)
        with tempfile.TemporaryDirectory(prefix='gok-oct19-body-') as temp:
            path = Path(temp)/'adapted-share-store.mjs'
            path.write_text(modified, encoding='utf-8')
            env = dict(os.environ, GOK_TEST_ADAPTED_SHARE_FILE=str(path))
            result = subprocess.run([os.environ.get('GOK_NODE', 'node'), 'tests/oct19_upstream_regressions.mjs'],
                                    cwd=ROOT, env=env, capture_output=True, encoding='utf-8', timeout=35)
            self.assertEqual(result.returncode, 0, result.stderr[-1500:])
            report = json.loads(result.stdout.splitlines()[-1])
            self.assertTrue(report['passed'])
            self.assertEqual(report['checks'], 28)
            self.assertEqual(report['realExternalRequests'], 0)


if __name__ == '__main__':
    unittest.main()
