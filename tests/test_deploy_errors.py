"""Deployment network tests use fake fetch replies and never deploy a service."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_bridge import ROOT, runtime_module


class DeploymentErrors(unittest.TestCase):
    def test_changed_upstream_hooks_fail_closed(self):
        source = (ROOT / 'engine/upstream/utils/deploy.js').read_text(encoding='utf-8')
        helper = ROOT / 'engine/deploy-errors.mjs'
        anchors = (
            'function describeNetError (error, base) {',
            '    logger?.warn?.(`[deploy] 请求 ${base} 失败：',
            '    return { ok: false, message: describeNetError(error, base) }',
            '    logger?.warn?.(`[deploy] 下载 ${name} 失败：',
            "    const msg = error?.name === 'TimeoutError'",
            ' * 下载代码包到内存。',
        )
        for anchor in anchors:
            with self.subTest(anchor=anchor):
                self.assertIn(anchor, source)
                changed = source.replace(anchor, '/* changed upstream hook */', 1)
                with self.assertRaisesRegex(ValueError, 'Upstream deployment error hook changed:'):
                    runtime_module.adapt_deploy_errors(changed, helper)
        with self.assertRaisesRegex(ValueError, 'Upstream deployment error hook changed:'):
            runtime_module.adapt_deploy_errors(source + '\n' + source, helper)

    def test_prepared_runtime_redacts_network_errors_and_reloads_idempotently(self):
        source = ROOT / 'engine/upstream/utils/deploy.js'
        original = source.read_bytes()
        with tempfile.TemporaryDirectory(prefix='gok-deploy-errors-') as directory:
            runtime = Path(directory) / 'runtime'
            target = runtime_module.prepare_runtime(ROOT / 'engine', runtime, {})
            deploy = target / 'utils/deploy.js'
            adapted = deploy.read_bytes()
            self.assertNotEqual(adapted, original)
            self.assertEqual(adapted.count(b'import {describeDeployNetworkError as describeNetError}'), 1)
            runtime_module.prepare_runtime(ROOT / 'engine', runtime, {})
            self.assertEqual(deploy.read_bytes(), adapted)
            self.assertEqual(source.read_bytes(), original)
            result = subprocess.run(
                [os.environ.get('GOK_NODE', 'node'), str(ROOT / 'tests/deploy_errors.mjs'), str(target)],
                capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Deployment network diagnostics:', result.stdout)


if __name__ == '__main__':
    unittest.main()
