import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
from test_bridge import ROOT

module=importlib.import_module(ROOT.name+'.services.server_dependencies')
ProcessResult=importlib.import_module(ROOT.name+'.utils.process').ProcessResult

class ServerDependencies(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.server=self.root/'plugins/GloryOfKings-Plugin/server-im'
        self.server.mkdir(parents=True)
        (self.server/'camp-im-server.js').write_text('import "ws";')
        (self.server/'package.json').write_text(json.dumps({'dependencies':{'node-fetch':'^3.3.2'}}))
        self.installer=module.ServerDependencies(ROOT/'engine',self.root,{'engine_npm_registry':'https://registry.npmmirror.com'})
        self.which=patch.object(module.shutil,'which',return_value='/node');self.which.start()
        self.npm=patch.object(module.EngineDependencies,'npm_command',return_value=['/node','/npm-cli.js']);self.npm.start()
    async def asyncTearDown(self):
        self.which.stop();self.npm.stop();self.temp.cleanup()
    async def test_missing_ws_installed_in_service_directory(self):
        with patch.object(module,'run_process',new_callable=AsyncMock) as run:
            run.side_effect=[ProcessResult(1,''),ProcessResult(0,''),ProcessResult(0,'')]
            result=await self.installer.ensure(self.server)
            self.assertTrue(result['ok']);self.assertTrue(result['changed'])
            install=run.call_args_list[1]
            self.assertIn('ws@^8.18.0',install.args[0]);self.assertIn('--ignore-scripts',install.args[0])
            self.assertEqual(install.kwargs['cwd'],self.server.resolve())
    async def test_ready_service_does_not_reinstall(self):
        (self.server/'.astrbot-service-dependencies').write_text(self.installer.fingerprint(self.server))
        with patch.object(module,'run_process',new_callable=AsyncMock,return_value=ProcessResult(0,'')) as run:
            self.assertEqual(await self.installer.ensure(self.server),{'ok':True,'changed':False})
            self.assertEqual(run.await_count,1)
    async def test_install_failure_is_not_success_and_redacts_output(self):
        with patch.object(module,'run_process',new_callable=AsyncMock) as run:
            run.side_effect=[ProcessResult(1,''),ProcessResult(1,'private-secret')]
            result=await self.installer.ensure(self.server)
            self.assertFalse(result['ok']);self.assertNotIn('private-secret',result['message'])
    async def test_lockfile_uses_ci_then_missing_ws(self):
        (self.server/'package-lock.json').write_text('{}')
        with patch.object(module,'run_process',new_callable=AsyncMock) as run:
            run.side_effect=[ProcessResult(1,''),ProcessResult(0,''),ProcessResult(0,''),ProcessResult(0,'')]
            self.assertTrue((await self.installer.ensure(self.server))['ok'])
            self.assertIn('ci',run.call_args_list[1].args[0])
            self.assertIn('ws@^8.18.0',run.call_args_list[2].args[0])
    async def test_other_directory_rejected(self):
        with patch.object(module,'run_process',new_callable=AsyncMock) as run:
            self.assertFalse((await self.installer.ensure(self.root))['ok']);run.assert_not_awaited()
