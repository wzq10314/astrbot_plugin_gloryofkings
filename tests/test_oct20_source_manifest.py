"""Ensure bundled source paths survive UTF-8 publishing, including CJK filenames."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class October20SourceManifest(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / 'UPSTREAM.json').read_text(encoding='utf-8'))

    def test_all_manifest_paths_exist_and_match_hashes(self):
        source = (ROOT / 'engine' / 'upstream').resolve()
        self.assertTrue(self.manifest['files'])
        for relative, digest in self.manifest['files'].items():
            with self.subTest(path=relative):
                path = source / relative
                self.assertTrue(path.resolve().is_relative_to(source))
                self.assertTrue(path.is_file(), relative)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def test_cjk_tutorial_filename_roundtrips(self):
        relative = 'resources/img/\u8425\u5730ID\u83b7\u53d6.png'
        self.assertIn(relative, self.manifest['files'])
        self.assertTrue((ROOT / 'engine' / 'upstream' / relative).is_file())
        encoded = json.dumps(self.manifest, ensure_ascii=True).encode('utf-8')
        self.assertEqual(json.loads(encoded.decode('utf-8')), self.manifest)

    def test_public_roster_patch_hash_is_pinned(self):
        self.assertEqual(self.manifest['commit'], '344c2c6b76c8cfa9e8b4c0575f65950b916cccde')
        self.assertEqual(self.manifest.get('patches', []), [])
        adopted = self.manifest.get('adopted_patches', [])
        self.assertTrue(any(p.get('name') == 'shared-roster-public-token' for p in adopted))
        relative = 'utils/shareStore.js'
        source = (ROOT / 'engine' / 'upstream' / relative).read_text(encoding='utf-8')
        self.assertIn('/api/v1/roster', source)
        self.assertIn('headers: shareHeaders(cfg.token)', source)


if __name__ == '__main__':
    unittest.main()
