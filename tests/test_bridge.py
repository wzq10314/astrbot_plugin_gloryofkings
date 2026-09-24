"""Integration tests run the complete Node core with a mocked OneBot transport.

No real camp account or login credentials are used. Set GOK_NODE to choose Node.
"""
import asyncio
import base64
import importlib
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent))
astrbot=types.ModuleType('astrbot');api=types.ModuleType('astrbot.api')
api.logger=logging.getLogger('gok-test')
sys.modules.setdefault('astrbot',astrbot);sys.modules.setdefault('astrbot.api',api)
bridge_module=importlib.import_module(ROOT.name+'.services.bridge')
runtime_module=importlib.import_module(ROOT.name+'.services.runtime')


class Bot:
    def __init__(self):self.calls=[]
    async def call_action(self,action,**params):
        self.calls.append((action,params))
        if action=='get_group_list':return [{'group_id':987654321,'group_name':'测试群'}]
        if action=='get_group_member_list':return [{'user_id':12345001,'nickname':'测试甲','role':'member'},{'user_id':12345002,'nickname':'测试乙','role':'admin'}]
        if action=='get_group_member_info':return {'user_id':params['user_id'],'nickname':'测试甲','role':'member'}
        return {'message_id':len(self.calls)}


class Plugin:
    def __init__(self,folder):
        self.data=Path(folder)
        self.settings=yaml.safe_load((ROOT/'config.yaml').read_text(encoding='utf-8'))
        self.settings.update({'engine_node':os.environ.get('GOK_NODE','node'),'campImEnabled':False,'shareEnabled':False})
    def admins(self):return ['12345002']
    def host_blacklist(self):return []
    async def upstream_status(self):return '测试基准：86ac5b675163'


def event(text,user='12345001',group='',master=False,role='member',reply=None):
    return {'msg':text,'user_id':user,'group_id':group,'isGroup':bool(group),'isMaster':master,
      'sender':{'nickname':'测试玩家','role':role},'group_name':'测试群','message_id':'100',
      'message':[],'at':'','atme':False,'reply_id':reply,'source':{'message_id':reply} if reply else None}


class Integration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration=2
        self.temp=tempfile.TemporaryDirectory(prefix='gok-test-')
        self.plugin=Plugin(self.temp.name);self.bot=Bot()
        self.bridge=bridge_module.Bridge(self.plugin,self.bot,'test-platform','55555001')
        await self.bridge.start()

    async def asyncTearDown(self):
        await self.bridge.close()
        self.temp.cleanup()

    async def command(self,text,**kwargs):
        start=len(self.bot.calls)
        result=await self.bridge.request('event',event(text,**kwargs),timeout=100)
        return result,self.bot.calls[start:]

    async def test_inventory_loads_all_upstream_apps_and_schedules(self):
        self.assertEqual(len(self.bridge.inventory),41)
        self.assertEqual(sum(len(a['rules']) for a in self.bridge.inventory),103)
        self.assertGreaterEqual(self.bridge.jobs,9)
        for app in self.bridge.inventory:
            self.assertTrue(app['rules'])

    async def test_normal_chat_and_unknown_quotes_not_claimed(self):
        self.assertFalse(await self.bridge.request('match',event('你好')))
        self.assertFalse(await self.bridge.request('match',event('你好',reply='unknown')))
        self.assertTrue(await self.bridge.request('match',event('#王者帮助')))

    async def test_admin_and_group_admin_permissions(self):
        _,calls=await self.command('#清空王者战绩推送')
        self.assertIn('管理员',json.dumps(calls,ensure_ascii=False))
        _,calls=await self.command('#开启群日报推送',group='987654321')
        self.assertIn('群管理员',json.dumps(calls,ensure_ascii=False))
        _,calls=await self.command('#开启群日报推送',group='987654321',role='admin')
        self.assertNotIn('仅限',json.dumps(calls,ensure_ascii=False))

    async def test_binding_switch_delete_persists_and_isolates_users(self):
        for text in ['#绑定营地 77777001','#绑定营地 77777002','#切换营地 1']:
            result,_=await self.command(text,group='987654321');self.assertTrue(result['handled'])
        file=self.bridge.root/'plugins/GloryOfKings-Plugin/data/UserData.yaml'
        store=yaml.safe_load(file.read_text(encoding='utf-8'))
        binding=store.get('12345001',store.get(12345001))
        self.assertEqual([str(v) for v in binding['ids']],['77777001','77777002'])
        self.assertNotIn('12345002',store)
        await self.bridge.close()
        self.bridge=bridge_module.Bridge(self.plugin,self.bot,'test-platform','55555001')
        await self.bridge.start()
        self.assertEqual(yaml.safe_load(file.read_text(encoding='utf-8')),store)
        await self.command('#删除营地 2')
        store=yaml.safe_load(file.read_text(encoding='utf-8'))
        self.assertEqual(len(store.get('12345001',store.get(12345001))['ids']),1)

    async def test_help_renders_real_png_and_cross_container_send(self):
        _,calls=await self.command('#王者帮助 账号')
        images=[s for action,p in calls if action.startswith('send_') for s in p.get('message',[]) if s['type']=='image']
        self.assertTrue(images,'help must render, not silently use text fallback')
        data=base64.b64decode(images[0]['data']['file'].removeprefix('base64://'))
        self.assertTrue(data.startswith(b'\x89PNG\r\n'))
        self.assertGreater(len(data),20000)
        out=os.environ.get('GOK_PREVIEW')
        if out:Path(out).write_bytes(data)

    async def test_onebot_account_routing_and_local_file_boundary(self):
        await self.bridge.refresh_groups(force=True)
        self.assertTrue(all(p['self_id']=='55555001' for _,p in self.bot.calls))
        with self.assertRaises(bridge_module.BridgeError):await self.bridge.file(str(ROOT/'config.yaml'))
        file=self.bridge.root/'fixture.csv';file.write_text('测试,1',encoding='utf-8')
        await self.bridge.upload({'kind':'private','id':'12345001','file':str(file),'name':'导出.csv'})
        action,p=self.bot.calls[-1]
        self.assertEqual(action,'upload_private_file');self.assertTrue(p['file'].startswith('base64://'))

    async def test_management_is_private_and_preserves_owner(self):
        _,calls=await self.command('#王者账号管理 列表',user='12345002',master=True,group='987654321')
        self.assertIn('私聊',json.dumps(calls,ensure_ascii=False))
        # A fake account is stored without ever contacting Tencent.
        account={'userId':'77777003','token':'test-only','userKey':'test-only','ownerBotUserId':'12345001'}
        _,calls=await self.command('#王者账号管理 导入 '+json.dumps(account),user='12345002',master=True)
        self.assertNotIn('test-only',json.dumps(calls))
        _,calls=await self.command('#王者账号管理 列表',user='12345002',master=True)
        self.assertIn('12345001',json.dumps(calls,ensure_ascii=False))
        _,calls=await self.command('#王者账号管理 归属 77777003 12345002',user='12345002',master=True)
        self.assertIn('已保存',json.dumps(calls,ensure_ascii=False))

    async def test_original_update_route_uses_astrbot_adapter(self):
        _,calls=await self.command('#王者更新',user='12345002',master=True)
        self.assertIn('测试基准',json.dumps(calls,ensure_ascii=False))
    async def test_im_core_blocks_all_group_routes(self):
        # Bypass Python entry protection and call the real Node dispatcher directly.
        commands=['#营地好友','#营地私聊 1 private-fixture','#营地回复 777 private-fixture',
                  '#营地消息','#营地消息开','#营地消息关','#营地消息同步',
                  '#营地消息部署','#营地消息服务',
                  '#营地消息接入 https://example.test private-fixture']
        for command in commands:
            result,calls=await self.command(command,group='987654321',user='12345002',master=True)
            self.assertTrue(result['handled'],command)
            self.assertEqual(result['messages'],['营地好友和消息功能仅限私聊，请私聊机器人操作。'])
            sends=[(a,p) for a,p in calls if a.startswith('send_')]
            self.assertEqual(len(sends),1)
            self.assertNotIn('private-fixture',json.dumps(calls))
    async def test_im_private_friends_requires_own_login(self):
        await self.command('#绑定营地 77777003',group='987654321')
        account={'userId':'77777003','token':'test-only','userKey':'test-only',
                 'userSig':'test-only','isGlobalDefault':True,'ownerBotUserId':'12345002'}
        await self.command('#王者账号管理 导入 '+json.dumps(account),user='12345002',master=True)
        result,calls=await self.command('#营地好友')
        self.assertIn('还没登录',str(result['messages']))
        self.assertFalse(any(a=='send_group_msg' for a,p in calls))


class Runtime(unittest.TestCase):
    def test_reload_preserves_command_settings_and_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)
            target=runtime_module.prepare_runtime(ROOT/'engine',dest,{'quoteReply':True})
            file=target/'config/config/config.yaml';config=yaml.safe_load(file.read_text(encoding='utf-8'))
            config['quoteReply']=False;file.write_text(yaml.safe_dump(config),encoding='utf-8')
            marker=target/'data/keep.json';marker.write_text('keep',encoding='utf-8')
            runtime_module.prepare_runtime(ROOT/'engine',dest,{'quoteReply':True})
            self.assertFalse(yaml.safe_load(file.read_text(encoding='utf-8'))['quoteReply'])
            self.assertEqual(marker.read_text(),'keep')
            runtime_module.prepare_runtime(ROOT/'engine',dest,{'quoteReply':False,'dailyReportCron':''})
            self.assertEqual(yaml.safe_load(file.read_text(encoding='utf-8'))['dailyReportCron'],'')


if __name__=='__main__':unittest.main()
