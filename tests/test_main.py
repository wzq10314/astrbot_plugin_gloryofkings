import asyncio
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from test_bridge import Bot, Plugin, ROOT

api=sys.modules['astrbot.api']
api.AstrBotConfig=dict
event_module=types.ModuleType('astrbot.api.event')
class Filters:
    EventMessageType=types.SimpleNamespace(ALL='all')
    @staticmethod
    def event_message_type(*args,**kwargs):return lambda fn:fn
    @staticmethod
    def llm_tool(*args,**kwargs):return lambda fn:fn
event_module.filter=types.ModuleType('astrbot.api.event.filter')
event_module.filter.EventMessageType=Filters.EventMessageType
event_module.filter.event_message_type=Filters.event_message_type
event_module.filter.llm_tool=Filters.llm_tool
event_module.AstrMessageEvent=object
sys.modules['astrbot.api.event']=event_module
star_module=types.ModuleType('astrbot.api.star')
class Star:
    def __init__(self,context):self.context=context
star_module.Star=Star;star_module.Context=object
star_module.register=lambda *args,**kwargs:lambda cls:cls
star_module.StarTools=types.SimpleNamespace(get_data_dir=lambda name:None)
sys.modules['astrbot.api.star']=star_module
main=importlib.import_module(ROOT.name+'.main')
commands=importlib.import_module(ROOT.name+'.services.tool_commands')

class Event:
    def __init__(self,text='帮我查询一下战绩',group='',user='12345001',role='member'):
        self.text=text;self.group=group;self.user=user;self.sent=[];self.stopped=False;self.bot=Bot()
        self.message_obj=types.SimpleNamespace(self_id='55555001',message_id='100',raw_message={
          'message':[{'type':'text','data':{'text':text}}], 'sender':{'nickname':'测试','role':role}})
    def get_platform_name(self):return 'aiocqhttp'
    def get_platform_id(self):return 'test-platform'
    def get_message_str(self):return self.text
    def get_sender_id(self):return self.user
    def get_sender_name(self):return '测试'
    def get_group_id(self):return self.group
    def is_private_chat(self):return not self.group
    def is_admin(self):return self.user=='12345002'
    def stop_event(self):self.stopped=True
    def plain_result(self,text):return text
    async def send(self,message):self.sent.append(message)

class Tool(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration=2
        self.temp=tempfile.TemporaryDirectory(prefix='gok-main-test-')
        star_module.StarTools.get_data_dir=lambda name:self.temp.name
        cfg=Plugin(self.temp.name).settings
        ctx=types.SimpleNamespace(get_config=lambda:{'admins_id':['12345002']})
        self.plugin=main.GloryOfKingsPlugin(ctx,cfg)
        self.plugin.dependencies.ready=True
    async def asyncTearDown(self):
        await self.plugin.terminate();self.temp.cleanup()
    async def test_query_returns_actual_failure_and_deduplicates(self):
        e=Event()
        answer=await self.plugin.kings_tool(e,'我的战绩')
        self.assertIn('绑定',answer)
        count=len(e.bot.calls)
        again=await self.plugin.kings_tool(e,'查询战绩')
        self.assertIn('未重复',again);self.assertEqual(count,len(e.bot.calls))
    async def test_dependency_status_before_worker_ready(self):
        self.plugin.dependencies.ready=False
        self.plugin.dependencies.message='依赖正在准备'
        self.plugin.dependencies.browser_message=''
        e=Event('#王者依赖状态',user='12345002')
        await self.plugin.on_message(e)
        self.assertTrue(e.stopped)
        self.assertEqual(e.sent,['依赖正在准备'])
        self.assertFalse(self.plugin.bridges)
    async def test_dependency_status_includes_browser_and_worker(self):
        self.plugin.dependencies.message='核心依赖就绪'
        self.plugin.dependencies.browser_message='浏览器已实际启动并截图'
        bridge=types.SimpleNamespace(self_id='55555001',status='ready',inventory=[{'rules':[{},{}]}],jobs=3)
        self.plugin.bridges['status-test']=bridge
        try:
            e=Event('#王者依赖状态',user='12345002')
            await self.plugin.on_message(e)
            self.assertEqual(e.sent,['核心依赖就绪\n浏览器已实际启动并截图\nQQ 55555001：ready，1 个模块 / 2 条路由 / 3 项定时任务'])
        finally:
            self.plugin.bridges.clear()
    async def test_dependency_status_requires_admin(self):
        e=Event('#王者依赖状态')
        await self.plugin.on_message(e)
        self.assertTrue(e.stopped)
        self.assertEqual(e.sent,['此命令仅限 AstrBot 管理员使用。'])
    async def test_llm_cannot_deploy_or_pass_credentials(self):
        for command in ['营地观战接入 https://example.com secret','王者账号管理 导入 {}',
                        '王者配置 distToken "secret"','营地回复 12345 你好']:
            answer=await self.plugin.kings_tool(Event(user='12345002'),command)
            self.assertTrue(answer.startswith('未执行：'),answer)
        self.assertFalse(self.plugin.bridges)
    async def test_llm_group_login_blocked_before_browser(self):
        answer=await self.plugin.kings_tool(Event(group='987654321'),'QQ扫码登录')
        self.assertIn('必须私聊',answer);self.assertFalse(self.plugin.bridges)
    async def test_im_group_commands_blocked_even_for_admin_before_core(self):
        self.plugin.dependencies.ready=False
        for text in ['#营地好友','#营地私聊 1 测试内容','#营地回复 777 测试内容',
                     '#营地消息','#营地消息开','#营地消息关','#营地消息服务',
                     '#营地消息部署','#营地消息接入 https://example.test test-secret']:
            e=Event(text,group='987654321',user='12345002')
            await self.plugin.on_message(e)
            self.assertTrue(e.stopped)
            self.assertEqual(e.sent,[main.PRIVATE_NOTICE])
            self.assertFalse(self.plugin.bridges)
    async def test_im_llm_group_requests_never_query_core(self):
        for text in ['营地好友','营地消息','营地消息开','营地消息关']:
            answer=await self.plugin.kings_tool(Event(group='987654321',user='12345002'),text)
            self.assertEqual(answer,'未执行：'+main.PRIVATE_NOTICE)
            self.assertFalse(self.plugin.bridges)
    async def test_im_private_llm_still_uses_core(self):
        e=Event()
        answer=await self.plugin.kings_tool(e,'营地好友')
        self.assertIn('绑定',answer)
        self.assertTrue(any(a=='send_private_msg' for a,p in e.bot.calls))
        self.assertFalse(any(a=='send_group_msg' for a,p in e.bot.calls))
    async def test_llm_subscription_uses_current_group_permissions(self):
        e=Event('开启群日报推送',group='987654321')
        answer=await self.plugin.kings_tool(e,'开启群日报推送')
        self.assertIn('仅限群主',answer)
        self.assertTrue(all(p.get('group_id')=='987654321' for a,p in e.bot.calls if a=='send_group_msg'))
    async def test_normal_chat_passes_and_sensitive_commands_dont_reach_llm(self):
        e=Event('今天吃什么');await self.plugin.on_message(e)
        self.assertFalse(e.stopped);self.assertFalse(self.plugin.bridges)
        e=Event('#营地QQ全局登录',group='987654321');await self.plugin.on_message(e)
        self.assertTrue(e.stopped);self.assertIn('私聊',e.sent[0])
    async def test_context_privilege_cannot_be_overridden_by_command(self):
        answer=await self.plugin.kings_tool(Event(),'王者更新日志')
        self.assertIn('仅限 AstrBot 管理员',answer)

class Validation(unittest.TestCase):
    def test_query_and_mutation_examples_are_routable(self):
        for text in ['查询战绩','英雄攻略 妲己','绑定营地 77777001','开启战绩推送',
                     '皮肤上新','营地QQ全局登录','王者帮助','营地ID共享状态','巅峰趋势 14']:
            self.assertEqual(commands.normalize(text),'#'+text)
    def test_multiline_and_unknown_rejected(self):
        for text in ['王者帮助\n王者配置 distToken "x"','随便聊聊','A'*300]:
            with self.assertRaises(ValueError):commands.normalize(text)

if __name__=='__main__':unittest.main()
