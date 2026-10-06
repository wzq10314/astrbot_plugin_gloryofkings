import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shared_auth_isolated', ROOT/'services/shared_auth.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SharedAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root/'bbbbbbbbbbbbbbbbbbbb/runtime'
        self.api = self.runtime/'plugins/GloryOfKings-Plugin/utils/api.js'
        self.api.parent.mkdir(parents=True)
        self.original = (ROOT/'engine/upstream/utils/api.js').read_text(encoding='utf-8')
        self.api.write_text(self.original, encoding='utf-8')
        self.settings = {'official_query_auth_namespace': 'a'*20, 'official_query_auth_accounts': ['123456789']}

    def apply(self, settings=None):
        return module.adapt_shared_query_auth(ROOT/'engine', self.runtime, settings or self.settings, self.root)

    def test_disabled_leaves_upstream_unmodified(self):
        self.assertFalse(self.apply({'official_query_auth_namespace': ''}))
        self.assertEqual(self.api.read_text(encoding='utf-8'), self.original)

    def test_query_only_fallback_keeps_local_pool_and_both_status_writes_isolated(self):
        self.assertTrue(self.apply())
        source = self.api.read_text(encoding='utf-8')
        self.assertIn('localCandidates.length ? localCandidates : readSharedQueryCandidates(', source)
        self.assertEqual(source.count("if (candidate?.source === 'adapter-shared-global') return"), 2)
        self.assertFalse((self.runtime/'plugins/GloryOfKings-Plugin/data/AuthPool.json').exists())
        self.assertFalse((self.root/('a'*20)).exists())

    def test_unapproved_paths_or_accounts_rejected_before_edit(self):
        for settings in [dict(self.settings, official_query_auth_namespace='../outside'),
                         dict(self.settings, official_query_auth_namespace='b'*20),
                         dict(self.settings, official_query_auth_accounts=[]),
                         dict(self.settings, official_query_auth_accounts='123456789'),
                         dict(self.settings, official_query_auth_accounts=['not-an-id'])]:
            with self.assertRaises(ValueError): self.apply(settings)
            self.assertEqual(self.api.read_text(encoding='utf-8'), self.original)

    def test_unknown_upstream_anchor_is_not_partially_written(self):
        success = next(hooks[1] for hooks in module._STATUS_HOOK_LAYOUTS if hooks[1] in self.original)
        self.api.write_text(self.original.replace(success, '  changed(candidate) {'), encoding='utf-8')
        before = self.api.read_bytes()
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(self.api.read_bytes(), before)

    def test_ambiguous_or_mixed_hook_layouts_are_not_written(self):
        current = next(hooks for hooks in module._STATUS_HOOK_LAYOUTS if hooks[0] in self.original)
        other = next(hooks for hooks in module._STATUS_HOOK_LAYOUTS if hooks != current)
        candidate = '    const candidates = authStore.getAuthCandidates(targetUserId)'
        malformed = [
            self.original + '\n' + current[0],
            self.original + '\n' + other[0],
            self.original + '\n' + '\n'.join(other),
            self.original.replace(current[1], other[1]),
            self.original + '\n' + candidate,
        ]
        for source in malformed:
            with self.subTest(source_variant=malformed.index(source)):
                self.api.write_text(source, encoding='utf-8')
                before = self.api.read_bytes()
                with self.assertRaises(ValueError): self.apply()
                self.assertEqual(self.api.read_bytes(), before)

    def test_legacy_hook_layout_remains_supported(self):
        legacy, current = module._STATUS_HOOK_LAYOUTS
        source = self.original
        for before, after in zip(current, legacy):
            source = source.replace(before, after)
        self.api.write_text(source, encoding='utf-8')
        self.assertTrue(self.apply())
        source = self.api.read_text(encoding='utf-8')
        for hook in legacy:
            self.assertIn(hook + "\n    if (candidate?.source === 'adapter-shared-global') return", source)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for the upstream auth integration check')
    def test_actual_refactored_auth_session_preserves_query_isolation(self):
        self.assertTrue(self.apply())
        source_pool = self.root/('a'*20)/'runtime/plugins/GloryOfKings-Plugin/data/AuthPool.json'
        result = subprocess.run(
            [shutil.which('node'), str(ROOT/'tests/auth_refactor.mjs'), str(self.api), str(source_pool)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('CampAuthSession isolation:', result.stdout)

    def test_symlink_source_is_rejected(self):
        target = self.root/'elsewhere'
        target.mkdir()
        try:
            (self.root/('a'*20)).symlink_to(target, target_is_directory=True)
        except OSError:
            self.skipTest('Symlink creation unavailable')
        with self.assertRaises(ValueError): self.apply()


if __name__ == '__main__': unittest.main()
