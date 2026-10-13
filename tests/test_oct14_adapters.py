import tempfile
import unittest
import os
import subprocess
from pathlib import Path
from test_bridge import ROOT, runtime_module


class October14Adapters(unittest.TestCase):
    def test_image_fallback_hook_is_precise_and_drift_fails_closed(self):
        source = (ROOT/'engine/upstream/utils/campImPush.js').read_text(encoding='utf-8')
        adapted = runtime_module.adapt_camp_im_photos(source)
        self.assertEqual(adapted.count('if (!pic && image && !photos.length)'), 1)
        self.assertEqual(source.count('if (!pic && image) pic = segment.image(image)'), 1)
        for broken in ('', source+source):
            with self.assertRaises(ValueError):
                runtime_module.adapt_camp_im_photos(broken)

    def test_hook_is_runtime_only_and_survives_reload(self):
        source = ROOT/'engine/upstream/utils/campImPush.js'
        before = source.read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for _ in range(2):
                target = runtime_module.prepare_runtime(ROOT/'engine',root,{})
                adapted = (target/'utils/campImPush.js').read_text(encoding='utf-8')
                self.assertEqual(adapted.count('if (!pic && image && !photos.length)'),1)
                self.assertEqual(source.read_bytes(),before)

    def test_real_changed_bodies_with_synthetic_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            target = runtime_module.prepare_runtime(ROOT/'engine',Path(temp),{})
            result = subprocess.run(
                [os.environ.get('GOK_NODE','node'),str(ROOT/'tests/oct14_regressions.mjs'),str(target)],
                capture_output=True,text=True,encoding='utf-8',timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('"checks":15',result.stdout)

    def test_private_receipt_hook_is_official_only_and_preserves_vendored_source(self):
        file = ROOT/'engine/upstream/utils/privateMsg.js'
        before = file.read_bytes()
        adapted = runtime_module.adapt_private_receipts(before.decode('utf-8'))
        self.assertIn("api?.adapter?.name === 'QQOfficial'",adapted)
        self.assertIn('result._astrbot_send_completed === true',adapted)
        self.assertEqual(adapted.count('confirmed(result, api)'),2)
        self.assertEqual(file.read_bytes(),before)
        for broken in ('',before.decode('utf-8')*2):
            with self.assertRaises(ValueError):
                runtime_module.adapt_private_receipts(broken)


if __name__ == '__main__':
    unittest.main()
