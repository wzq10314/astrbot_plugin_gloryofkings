import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {register} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import schedule from 'node-schedule';
import renderer from './renderer.mjs';

register('./loader.mjs',import.meta.url);
const write=process.stdout.write.bind(process.stdout);
const emit=value=>write(JSON.stringify(value)+'\n');
const silent=()=>{};
for (const key of ['log','info','warn','error','debug','trace']) console[key]=silent;
globalThis.logger=new Proxy({}, {get:()=>silent}); // Never expose upstream auth payloads in host logs.
let serial=0, boot;
const first=new Promise(r=>boot=r), pending=new Map();
function call(op,data={}) {
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('HostTimeout'))},op==='server_dependencies'?240000:90000);
    pending.set(id,{resolve,reject,timer}); emit({type:'call',id,op,data});
  });
}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
  try {
    const x=JSON.parse(line);
    if (x.type==='start') return boot(x);
    if (x.type==='result') {
      const p=pending.get(x.id);if (!p)return;
      pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Error(x.error)):p.resolve(x.result);return;
    }
    if(x.type==='request') handle(x).then(result=>emit({type:'response',id:x.id,result}))
      .catch(e=>emit({type:'response',id:x.id,error:e.code||e.name||'BridgeError'}));
  } catch { emit({type:'diagnostic',code:'ProtocolError'}); }
});
lines.on('close',()=>process.exit(0));
process.on('unhandledRejection',()=>emit({type:'diagnostic',code:'BackgroundTaskFailed'}));
const initial=await first;
process.chdir(initial.root);
globalThis.gok={root:initial.root,call,emit};
const events=new AsyncLocalStorage();
globalThis.plugin=class {
  constructor(options={}) {Object.assign(this,options)}
  get e(){return this._event||events.getStore()}
  set e(value){this._event=value}
  reply(...args){if(!this.e)throw Error('MissingEvent');return this.e.reply(...args)}
};
const media=(type,file)=>({type,data:{file:Buffer.isBuffer(file)?'base64://'+file.toString('base64'):file}});
globalThis.segment={image:file=>media('image',file),video:file=>media('video',file),record:file=>media('record',file),
  text:text=>({type:'text',data:{text}}),at:qq=>({type:'at',data:{qq}}),button:()=>null};
const api=(action,params={})=>call('onebot',{action,params});
function mapOf(rows,key){return new Map(rows.map(row=>[Number(row[key]),row]))}
function party(kind,id){
  id=String(id);
  const p={sendMsg:message=>call('send',{kind,id,message}),
    sendFile:(file,name)=>call('upload',{kind,id,file,name}),
    recallMsg:message_id=>api('delete_msg',{message_id}),getMsg:message_id=>api('get_msg',{message_id}),
    getAvatarUrl:()=>kind==='group'?`https://p.qlogo.cn/gh/${id}/${id}/640/`:`https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`};
  p.fs={upload:p.sendFile};
  if(kind==='group'){
    p.getMemberMap=async()=>{
      const rows=await api('get_group_member_list',{group_id:id});
      const map=mapOf(rows,'user_id');Bot.gml.set(Number(id),map);return map;
    };
    p.pickMember=user_id=>({info:Bot.gml.get(Number(id))?.get(Number(user_id)),
      getInfo:()=>api('get_group_member_info',{group_id:id,user_id:String(user_id),no_cache:true}),
      getAvatarUrl:()=>`https://q1.qlogo.cn/g?b=qq&nk=${user_id}&s=640`});
  }
  return p;
}
globalThis.Bot={uin:Number(initial.self_id),gl:new Map(),gml:new Map(),
  pickGroup:id=>party('group',id),pickFriend:id=>party('private',id),pickUser:id=>party('private',id),
  sendApi:api,recallMsg:message_id=>api('delete_msg',{message_id}),getMsg:message_id=>api('get_msg',{message_id}),
  makeForwardMsg:async rows=>({type:'forward',rows}),
  async sendMasterMsg(message){
    const rows={};for(const id of initial.admins)rows[id]=party('private',id).sendMsg(message);
    return {[Bot.uin]:rows};
  }};
function makeEvent(data){
  const e={...data,bot:Bot,isPrivate:!data.isGroup,friend:party('private',data.user_id),
    runtime:{puppeteer:renderer},getReply:()=>api('get_msg',{message_id:data.reply_id}),bridgeOutput:[]};
  if(e.isGroup)e.group=party('group',e.group_id);
  e.reply=async(message,quote=false)=>{
    const result=await call('send',{kind:e.isGroup?'group':'private',id:e.isGroup?e.group_id:e.user_id,
      message,reply_id:quote?e.message_id:null});
    const describe=value=>{
      if(typeof value==='string')return value.slice(0,3000);
      if(Array.isArray(value))return value.map(describe).filter(Boolean).join('\n');
      if(value?.type==='text')return String(value.data?.text||'').slice(0,3000);
      if(value?.type==='image'&&String(value.data?.file||'').includes('营地ID获取.png'))return '已发送营地ID获取教程。查询个人游戏数据需要绑定营地ID；请在群里发送 #绑定营地 数字营地ID。';
      if(['image','file','forward'].includes(value?.type))return `[已发送${{image:'图片',file:'文件',forward:'合并转发'}[value.type]}]`+(value.bridge_summary?'\n'+value.bridge_summary:'');
      return '';
    };
    e.bridgeOutput.push(describe(message));
    return result;
  };
  return e;
}
let entries=[], jobs=[], black, imStore;
const privateFiles=new Set(['campFriend.js','campIm.js','campImDeploy.js']);
function matches(e){
  return entries.flatMap(([file,app])=>(app.rule||[]).filter(rule=>{
    if(rule.fnc==='tryQuote'&&(e.isGroup||!e.reply_id||!imStore.getRef(e.reply_id)))return false;
    const reg=rule.reg instanceof RegExp?rule.reg:new RegExp(rule.reg);reg.lastIndex=0;return reg.test(e.msg);
  }).map(rule=>({file,app,rule})));
}
async function handle(x){
  if(x.op==='inventory')return inventory();
  if(x.op==='groups'){
    Bot.gl=mapOf(x.data.groups,'group_id');
    for(const [gid,rows] of Object.entries(x.data.members))Bot.gml.set(Number(gid),mapOf(rows,'user_id'));
    for(const gid of Bot.gml.keys())if(!Bot.gl.has(gid))Bot.gml.delete(gid);
    return true;
  }
  if(x.op==='match')return matches(makeEvent(x.data)).length>0;
  if(x.op==='shutdown'){for(const job of jobs)job.cancel();await renderer.shutdown();setTimeout(()=>process.exit(0),50);return true;}
  if(x.op!=='event')throw Error('UnknownOperation');
  const e=makeEvent(x.data);
  if(black.isBlockedEvent(e))return {handled:true};
  return events.run(e,async()=>{
    for(const {file,app,rule} of matches(e)){
      if(e.isGroup&&(privateFiles.has(file)||rule.event==='message.private'||app.event==='message.private')){
        await e.reply('营地好友和消息功能仅限私聊，请私聊机器人操作。');
        return {handled:true,messages:e.bridgeOutput};
      }
      if(!e.isGroup&&(rule.event==='message.group'||app.event==='message.group'))continue;
      if(rule.permission==='master'&&!e.isMaster){await e.reply('此命令仅限 AstrBot 管理员使用。');return {handled:true,messages:e.bridgeOutput};}
      if(['admin','owner'].includes(rule.permission)&&!e.isMaster&&
          !(e.isGroup&&['admin','owner'].includes(e.sender?.role))){await e.reply('此命令仅限群主、群管理员或 AstrBot 管理员使用。');return {handled:true,messages:e.bridgeOutput};}
      const value=await app[rule.fnc](e);
      if(value!==false)return {handled:true,messages:e.bridgeOutput.slice(0,20)};
    }
    return {handled:false};
  });
}
function inventory(){return entries.map(([file,app])=>({file,name:app.name,
  rules:(app.rule||[]).map(r=>({reg:r.reg instanceof RegExp?r.reg.source:r.reg,flags:r.reg.flags||'',fnc:r.fnc,permission:r.permission||''})),
  tasks:(Array.isArray(app.task)?app.task:[app.task]).filter(Boolean).map(t=>({name:t.name,cron:t.cron}))}));}
try {
  const source=path.join(initial.root,'plugins/GloryOfKings-Plugin');
  imStore=await import(pathToFileURL(path.join(source,'utils/campImStore.js')));
  black=await import(pathToFileURL(path.join(source,'utils/blackList.js')));
  const classes={};
  for(const file of fs.readdirSync(path.join(source,'apps')).filter(f=>f.endsWith('.js')).sort()){
    const mod=await import(pathToFileURL(path.join(source,'apps',file)));
    const App=mod.default||Object.values(mod).find(v=>typeof v==='function'&&v.prototype instanceof plugin);
    if(!App)throw Error('InvalidApp:'+file);
    classes[file]=App;
  }
  black.guardApps(classes);
  entries=Object.entries(classes).map(([file,App])=>[file,new App()]).sort((a,b)=>(a[1].priority??500)-(b[1].priority??500));
  // AstrBot-specific management replaces the Guoba page, with the same persistent stores.
  const {default:Management}=await import('./management.mjs');entries.unshift(['astrbotManagement.js',new Management()]);
  if(initial.schedules!==false)for(const [file,app] of entries){
    for(const task of (Array.isArray(app.task)?app.task:[app.task]).filter(t=>t?.cron&&t?.fnc)){
      let running=false;
      const job=schedule.scheduleJob({rule:task.cron,tz:'Asia/Shanghai'},async()=>{
        if(running)return;running=true;
        try{await (typeof task.fnc==='function'?task.fnc():app[task.fnc]())}
        catch{emit({type:'diagnostic',code:'ScheduledTaskFailed',app:file})}
        finally{running=false}
      });
      if(!job)throw Error('InvalidCron:'+file);jobs.push(job);
    }
  }
  emit({type:'ready',inventory:inventory(),jobs:jobs.length});
} catch(error){emit({type:'fatal',code:error.code||error.name,detail:String(error.message).slice(0,400)});process.exit(1);}
