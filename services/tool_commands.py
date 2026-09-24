"""The LLM can invoke business commands, never configuration or service deployment."""
import json
from pathlib import Path
import re

INVENTORY=json.loads((Path(__file__).resolve().parents[1]/'routes.json').read_text(encoding='utf-8'))
PRIVATE_FILES={'campFriend.js','campIm.js','campImDeploy.js'}
PRIVATE_NOTICE='营地好友和消息功能仅限私聊，请私聊机器人操作。'
PRIVATE_RULES=[re.compile(r['reg'],re.I if 'i' in r['flags'] else 0)
               for a in INVENTORY if a['file'] in PRIVATE_FILES
               for r in a['rules'] if r['fnc']!='tryQuote']

def private_only(command):
    return any(pattern.search(command) for pattern in PRIVATE_RULES)

BLOCKED_FILES={'astrbotManagement.js','campImDeploy.js','watchDeploy.js','blackList.js',
               'cacheManager.js','campRenew.js','dataBackup.js','shareDeploy.js','shareNotify.js'}
BLOCKED_METHODS={'tryQuote','clearAll','clearInvalidCampAuth','clearHiddenProfiles',
                 'setUrl','setToken','setAdminSecret','masterEnable','masterDisable','resync',
                 'chat','reply'}
RULES=[(a['file'],r,re.compile(r['reg'],re.I if 'i' in r['flags'] else 0))
       for a in INVENTORY for r in a['rules'] if r['fnc']!='tryQuote']
ALIASES={'战绩':'查询战绩','查战绩':'查询战绩','我的战绩':'查询战绩','最近战绩':'查询战绩',
         '主页':'王者主页','王者账号':'营地ID','我的账号':'营地ID','新皮肤':'皮肤上新',
         '王者扫码登录':'营地QQ全局登录','QQ扫码登录':'营地QQ全局登录','微信扫码登录':'营地wx全局登录'}


def normalize(command):
    if not isinstance(command,str) or len(command)>256 or any(c in command for c in '\r\n\x00'):
        raise ValueError('需要一条不超过 256 字的插件命令。')
    text=command.strip().lstrip('#/').strip()
    text=ALIASES.get(text,text)
    text='#'+text
    for file,rule,pattern in RULES:
        if not pattern.search(text):continue
        if file in BLOCKED_FILES or rule['fnc'] in BLOCKED_METHODS:
            raise ValueError('此操作请用户直接发送原版命令；配置凭据、部署、清理及对外私信不经 LLM 工具处理。')
        return text
    raise ValueError('命令名称未匹配，请按工具说明选择；这不代表相关功能不存在。')
