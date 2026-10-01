"""PM2 compatibility checks never invoke a real PM2 command or service."""
import importlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_bridge import ROOT, runtime_module


pm2_compat = importlib.import_module(ROOT.name + '.services.pm2_compat')


class Pm2Compatibility(unittest.TestCase):
    def test_changed_upstream_hooks_fail_closed(self):
        source = (ROOT / 'engine/upstream/utils/pm2.js').read_text(encoding='utf-8')
        for anchor in (
            "if (probe('pm2'))",
            'function resolvePm2Js ()',
            '    pre: [],',
            "env: process.env })",
            'export function pm2Proc (name)',
            'function sysPm2HasProcesses ()',
        ):
            with self.subTest(anchor=anchor):
                self.assertIn(anchor, source)
                changed = source.replace(anchor, '/* removed upstream hook */', 1)
                with self.assertRaisesRegex(ValueError, 'Upstream PM2 compatibility hook changed:'):
                    pm2_compat.adapt_pm2(changed)

    def test_runtime_refresh_preserves_services_and_pm2_state(self):
        with tempfile.TemporaryDirectory(prefix='gok-pm2-runtime-') as directory:
            runtime = Path(directory) / 'runtime'
            target = runtime_module.prepare_runtime(ROOT / 'engine', runtime, {})
            sentinels = [target / 'server/watch-server.js', target / 'server-im/camp-im-server.js',
                         runtime.parent / 'pm2/dump.pm2', target / 'data/pm2/dump.pm2']
            for file in sentinels:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('existing service or daemon state', encoding='utf-8')
            runtime_module.prepare_runtime(ROOT / 'engine', runtime, {})
            for file in sentinels:
                self.assertEqual(file.read_text(encoding='utf-8'), 'existing service or daemon state')
            node = os.environ.get('GOK_NODE', 'node')
            result = subprocess.run([node, str(ROOT / 'tests/pm2_runtime.mjs'), str(target)],
                                    capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('PM2 runtime compatibility:', result.stdout)


if __name__ == '__main__':
    unittest.main()
