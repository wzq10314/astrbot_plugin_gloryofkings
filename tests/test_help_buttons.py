"""Runtime help adaptation uses synthetic copies, never account data."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('help_buttons_isolated', ROOT / 'services/help_buttons.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HelpButtonAdaptationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gok-help-copy-')
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / 'runtime'
        self.file = self.runtime / 'plugins/GloryOfKings-Plugin/apps/help.js'
        self.file.parent.mkdir(parents=True)
        self.vendor = ROOT / 'engine/upstream/apps/help.js'
        self.original = self.vendor.read_bytes()
        self.file.write_bytes(self.original)

    def apply(self):
        return module.adapt_help_buttons(ROOT / 'engine', self.runtime)

    def test_actual_help_replies_keep_image_and_matching_card_keyboard(self):
        self.assertTrue(self.apply())
        source = self.file.read_text(encoding='utf-8')
        self.assertEqual(source.count('import {buildHelpButtons}'), 1)
        self.assertEqual(source.count('buildHelpButtons(e, sections,'), 1)
        self.assertIn('await e.reply([inventoryImage, buildHelpButtons(', source)
        self.assertIn('(...rows) => segment.button(...rows))], shouldQuote())', source)
        self.assertEqual(self.vendor.read_bytes(), self.original)

    def test_missing_or_duplicate_upstream_hook_fails_without_partial_edit(self):
        anchor = '      await e.reply([inventoryImage, Button.help()], shouldQuote())'
        original = self.original.decode('utf-8')
        for source in (original.replace(anchor, '      await e.reply(inventoryImage)'),
                       original + '\n' + anchor):
            with self.subTest(duplicate=source.endswith(anchor)):
                self.file.write_text(source, encoding='utf-8')
                before = self.file.read_bytes()
                with self.assertRaisesRegex(ValueError, 'Upstream official help button hook changed'):
                    self.apply()
                self.assertEqual(self.file.read_bytes(), before)

    def test_adapted_copy_must_be_refreshed_before_reapplying(self):
        self.assertTrue(self.apply())
        before = self.file.read_bytes()
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual(self.file.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
