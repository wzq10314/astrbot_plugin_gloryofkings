import {pathToFileURL} from 'node:url';
import path from 'node:path';
const load=name=>import(pathToFileURL(path.join(gok.root,'plugins/GloryOfKings-Plugin',name)));
const {Config}=await load('components/index.js');
const {default:auth}=await load('utils/authStore.js');
const im=await load('utils/campImStore.js');
export default class Management extends plugin {
  constructor(){super({name:'AstrBot 管理适配',priority:-10,rule:[
    {reg:'^#王者账号管理(?:\\s|$)',fnc:'accounts',permission:'master'},
    {reg:'^#王者配置(?:\\s|$)',fnc:'configure',permission:'master'}]})}
  async accounts(e){
    if(e.isGroup)return e.reply('账号管理请私聊机器人使用。');
    const args=e.msg.split(/\s+/).slice(1), [action,id,value]=args;
    if(!action||action==='列表')return e.reply(auth.listAccounts().map(a=>
      `${a.userId} ${a.nickname||''}｜归属QQ：${a.ownerBotUserId||'无'}｜全局查询：${a.isGlobalDefault?'开':'关'}｜营地消息：${im.isAccountEnabled(a.userId)?'开':'关'}`
    ).join('\n')||'还没有登录账号。请发送 #营地QQ全局登录 或 #营地wx全局登录。');
    if(action==='导入'){
      try{
        const a=JSON.parse(e.msg.replace(/^#王者账号管理\s+导入\s+/,''));
        if(!/^\d+$/.test(String(a.userId||''))||!a.token||!(a.userKey||a.encodeRes))throw Error();
        auth.upsertGlobalAccount(a);return e.reply('账号已导入，未回显凭据。');
      }catch{return e.reply('导入格式错误：需提供原版账号 JSON（userId、token、userKey 或 encodeRes）。建议优先扫码登录。');}
    }
    const a=auth.getAccount(id);
    if(!a)return e.reply('未找到该营地账号。');
    if(action==='归属'&&(/^\d+$/.test(value)||value==='清空'))auth.upsertAccount({...a,ownerBotUserId:value==='清空'?'':value});
    else if(action==='全局'&&['开','关'].includes(value))auth.upsertAccount({...a,isGlobalDefault:value==='开'});
    else if(action==='消息'&&['开','关'].includes(value))im.setAccountEnabled(id,value==='开');
    else if(action==='删除'){im.setAccountEnabled(id,false);auth.removeAccount(id);}
    else return e.reply('用法：#王者账号管理 列表 / 归属 营地ID QQ号 / 消息 营地ID 开或关 / 全局 营地ID 开或关 / 删除 营地ID');
    return e.reply('账号设置已保存。营地消息连接会在下一次轮询同步。');
  }
  async configure(e){
    if(e.isGroup)return e.reply('配置管理请私聊机器人使用。');
    const match=e.msg.match(/^#王者配置\s+(\w+)(?:\s+([\s\S]+))?$/);
    const defaults=Config.getDefOrConfig('config');
    if(!match)return e.reply('普通设置可在 AstrBot 插件配置中修改；命令用法：#王者配置 字段 JSON值。字段：\n'+Object.keys(defaults).join('、'));
    const [,key,raw]=match;
    if(!Object.hasOwn(defaults,key))return e.reply('配置字段不存在。');
    if(raw===undefined)return e.reply(/token|secret/i.test(key)?`${key}：${defaults[key]?'已配置':'未配置'}`:`${key}：${JSON.stringify(defaults[key])}`);
    let value;try{value=JSON.parse(raw)}catch{return e.reply('值须为 JSON，例如 true、["12345"] 或 "0 47 23 * * *"。');}
    if(typeof value!==typeof defaults[key]||Array.isArray(value)!==Array.isArray(defaults[key]))return e.reply('配置值类型不正确。');
    Config.modify('config',key,value);
    return e.reply('已保存。定时表达式变更后请重载插件。');
  }
}
