// Execute real source bodies with synthetic dependencies only. No login or delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractImages, photoMark} from '../engine/upstream/utils/campImImage.js';

const plugin = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream'));
assert.ok(process.argv[2], 'Pass the prepared runtime plugins/GloryOfKings-Plugin directory');
const patched = Boolean(process.argv[2]);
const dependencies = [];
globalThis.__oct14Dependencies = dependencies;
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};
globalThis.segment = {image: data => ({type: 'image', data}), at: id => ({type:'at', id})};
let checks = 0;
const check = async (name, run) => {try {await run(); checks++;} catch (e) {e.message = name+': '+e.message; throw e;}};
async function load(relative, mocks, expose = []) {
  let source = fs.readFileSync(path.join(plugin, relative), 'utf8');
  for (const method of expose) source = source.replaceAll('#'+method, method);
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm, (all, clause, quote, specifier) => {
    if (specifier.startsWith('node:')) return all;
    assert.ok(Object.hasOwn(mocks, specifier), 'Unmocked dependency '+specifier);
    const binding = `globalThis.__oct14Dependencies[${dependencies.push(mocks[specifier])-1}]`;
    clause=clause.trim();
    if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
    if (clause.startsWith('* as ')) return `const ${clause.slice(5)} = ${binding};\n`;
    assert.match(clause, /^[A-Za-z_$][\w$]*$/);
    return `const ${clause} = ${binding}.default;\n`;
  });
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}

let imageMode='card', withCard=true, sends=[], screenshots=[], downloads=[], owners={camp:'owner-1'}, refs=[], privateDelegate;
const photo=Buffer.from('fixture-original-photo');
const push=await load('utils/campImPush.js', {
  '#components': {Config:{getDefOrConfig:()=>({campImPushImage:withCard})}, PluginPath:'/fixture'},
  './authStore.js': {default:{getAccount:id=>({ownerBotUserId:owners[id]})}},
  './privateMsg.js': {sendPrivate:async(owner,content,{bot}={})=>{sends.push({owner,content,bot});return privateDelegate?privateDelegate(owner,content,{bot}):{ok:true, messageId:'fixture-only'}}},
  './campImStore.js': {addRef(...args){refs.push(args)},setLastPush(){},getLastPush:()=>null},
  './masterMsg.js': {sendMaster:async()=>false},
  './avatar.js': {qlogoUrl:()=>''},
  './campImImage.js': {extractImages,photoMark},
  './fileUtils.js': {getLocalImage:async url=>{downloads.push(url);return photo}},
  '../../../lib/puppeteer/puppeteer.js': {default:{screenshot:async(name,data)=>{screenshots.push({name,data});if(imageMode==='failure')throw Error('fixture rendering failure');return {type:'rendered-card'}}}},
  './imageType.js': {getImgType:()=> 'png'}
});
const photoMsg={selfUserId:'camp',fromUserId:'friend',fromRoleName:'Fixture Friend',fromRoleIcon:'https://example.invalid/avatar.png',text:'',time:123,
  raw:{links:[[7,0,0,JSON.stringify({origin:'https://example.invalid/photo.png',width:10,height:10})]]}};
const reset=()=>{sends=[];screenshots=[];downloads=[];imageMode='card';withCard=true;owners={camp:'owner-1'}};
await check('photo card embeds original bytes and preserves owner/caption', async()=>{
  reset();const r=await push.pushToOwner(photoMsg,{bot:'fixture-bot'});
  assert.equal(r.ok,true);assert.equal(sends.length,1);assert.equal(sends[0].owner,'owner-1');
  assert.equal(sends[0].bot,'fixture-bot');assert.equal(screenshots[0].data.message,'');
  assert.match(screenshots[0].data.photos[0],/^data:image\/png;base64,/);
  assert.equal(Buffer.from(screenshots[0].data.photos[0].split(',')[1],'base64').toString(),photo.toString());
  assert.match(sends[0].content[1],/#营地回复 camp/);
});
await check('disabling decoration still delivers message photo',async()=>{
  reset();withCard=false;await push.pushToOwner(photoMsg);
  assert.equal(screenshots.length,0);assert.deepEqual(sends[0].content[0],segment.image(photo));
});
await check('render failure with avatar does not swallow original photo',async()=>{
  reset();imageMode='failure';await push.pushToOwner(photoMsg);
  assert.deepEqual(sends[0].content[0],segment.image(photo),
    'Avatar fallback reported success before delivering actual message photo');
});
await check('no owner yields no download or send',async()=>{
  reset();owners={};const result=await push.pushToOwner(photoMsg);
  assert.equal(result.reason,'no_owner');assert.equal(downloads.length,0);assert.equal(sends.length,0);
});
await check('photo limit stays at nine',async()=>{
  reset();const raw={links:Array.from({length:12},(_,i)=>[7,0,0,JSON.stringify({origin:`https://example.invalid/${i}.png`})])};
  await push.pushToOwner({...photoMsg,raw});assert.equal(downloads.length,9);assert.equal(screenshots[0].data.photos.length,9);
});

// Public method exposure changes visibility only; private method bodies remain untouched.
let signMode='image', failImageSend=false, signSends=[], signScreens=[];
const alternateBot={pickFriend:id=>({getInfo:async()=>({nickname:'Friend '+id})})};
globalThis.Bot={pickFriend:id=>({getInfo:async()=>({nickname:'Default '+id})}),alternate:alternateBot};
const sign=await load('apps/signIn.js', {
  '../../../lib/puppeteer/puppeteer.js':{default:{screenshot:async(name,data)=>{signScreens.push(data);return signMode==='image'?{type:'fixture-sign-image'}:false}}},
  '#utils':{shouldQuote:()=>false,getImgType:()=> 'png',AT_HEAD:'',AT_TAIL:''},
  '#components':{Config:{getDefOrConfig:()=>({campSignCron:''})},PluginName:'Fixture'},
  '../utils/authStore.js':{default:{}},
  '../utils/campSignTask.js':{signOneAccount:async()=>{throw Error('Real actions forbidden')},probeAccount:async()=>{throw Error('Real actions forbidden')},
    summarizeViews:()=>({okCount:1}),groupByOwner:()=>new Map()},
  '../utils/campSign.js':{buildSignView:info=>({...info,textFallback:'fixture text fallback'})},
  '../utils/privateMsg.js':{sendPrivate:async(owner,content,{bot})=>{signSends.push({owner,content,bot});return privateDelegate?privateDelegate(owner,content,{bot}):{ok:!(failImageSend&&Array.isArray(content)),reason:'fixture-send'}}},
  '../utils/masterMsg.js':{sendMaster:async()=>false},
  '../utils/hotState.js':{hotBox:()=>({current:null})},
  '../utils/taskCtl.js':{rescheduleOwnTask(){},isCronOn:()=>false},
  '../utils/signReportTarget.js':{rememberTarget(){},getTarget:()=>null,forgetTarget(){}}
},['sendToPrivateChat']);
const signer=new sign.CampSignIn();
const signReset=()=>{signMode='image';failImageSend=false;signSends=[];signScreens=[]};
await check('private sign image uses recorded bot and nickname',async()=>{
  signReset();const result=await signer.sendToPrivateChat({botId:'alternate'},'owner-2',[{signed:true}]);
  assert.equal(result.ok,true);assert.equal(signSends.length,1);assert.equal(signSends[0].bot,alternateBot);
  assert.equal(signSends[0].owner,'owner-2');assert.equal(signSends[0].content[0].type,'fixture-sign-image');
  assert.equal(signScreens[0].username,'Friend owner-2');
});
await check('legacy private target with no record still gets image',async()=>{
  signReset();await signer.sendToPrivateChat(null,'owner-3',[{signed:true}]);
  assert.equal(signSends[0].bot,Bot);assert.equal(signSends[0].content[0].type,'fixture-sign-image');
});
await check('failed render and failed image send fall back to text',async()=>{
  for(const mode of ['empty','image']){
    signReset();signMode=mode;failImageSend=true;const result=await signer.sendToPrivateChat(null,'owner-3',[{signed:true}]);
    assert.equal(result.ok,true);assert.equal(signSends.at(-1).content,'fixture text fallback');
  }
});

const realPrivate=await load('utils/privateMsg.js', {'./adapter.js':{normalizeId:value=>String(value || '').trim()}});
let receipt={_astrbot_send_completed:true}, receiptCalls=[];
const receiptBot={adapter:{name:'QQOfficial'},pickFriend:id=>({sendMsg:async message=>{receiptCalls.push({id,message});if(receipt instanceof Error)throw receipt;return receipt}})};
Bot.official=receiptBot;
privateDelegate=realPrivate.sendPrivate;
await check('official completed-send marker is successful without fabricated message ID',async()=>{
  receipt={_astrbot_send_completed:true};receiptCalls=[];
  const result=await realPrivate.sendPrivate('opaque-owner','fixture',{bot:receiptBot});
  assert.equal(result.ok,true);assert.equal(result.messageId || '', '');assert.equal(receiptCalls.length,1);
});
await check('official private sign image does not fall back after completed no-ID send',async()=>{
  signReset();receipt={_astrbot_send_completed:true};receiptCalls=[];
  const result=await signer.sendToPrivateChat({botId:'official'},'opaque-owner',[{signed:true}]);
  assert.equal(result.ok,true);assert.equal(receiptCalls.length,1);assert.equal(receiptCalls[0].message[0].type,'fixture-sign-image');
});
await check('failures and empty receipts are never promoted by the marker',async()=>{
  for(const value of [{},{status:'failed',_astrbot_send_completed:true},{retcode:1,_astrbot_send_completed:true},
    {error:'fixture failure',_astrbot_send_completed:true},new Error('fixture exception')]){
    receipt=value;const result=await realPrivate.sendPrivate('opaque-owner','fixture',{bot:receiptBot});
    assert.equal(result.ok,false);
  }
  receipt={_astrbot_send_completed:true};receiptBot.adapter.name='OneBotv11';
  assert.equal((await realPrivate.sendPrivate('12345','fixture',{bot:receiptBot})).ok,false);
  receiptBot.adapter.name='QQOfficial';
});
await check('real receipt ID is preserved',async()=>{
  receipt={message_id:'actual-fixture-id'};
  const result=await realPrivate.sendPrivate('opaque-owner','fixture',{bot:receiptBot});
  assert.equal(result.ok,true);assert.equal(result.messageId,'actual-fixture-id');
});
await check('successful no-ID image push cannot create a quote reference',async()=>{
  reset();refs=[];receipt={_astrbot_send_completed:true};receiptCalls=[];
  assert.equal((await push.pushToOwner(photoMsg,{bot:receiptBot})).ok,true);
  assert.equal(receiptCalls.length,1);assert.equal(refs.length,0);
});
privateDelegate=undefined;

// Actual upstream candidate selection class, isolated from API/network dependencies.
const apiSource=fs.readFileSync(path.join(plugin,'utils/api.js'),'utf8');
const start=apiSource.indexOf('\nclass CampAuthSession {'),end=apiSource.indexOf('\nclass CampTransport {',start);
assert.ok(start>=0&&end>start);
const local=['111','222','333'].map(userId=>({source:'global',label:'fixture '+userId,auth:{userId,token:'fixture-token',userKey:'fixture-key',ownerBotUserId:'owner-'+userId}}));
const Session=new Function('authStore','Config','logger','AuthConfigError','toText','maskValue','maskUserId','isUsableAuth','DEFAULT_PUBLIC_KEY','roleIdToCampId',
  apiSource.slice(start,end)+'\nreturn CampAuthSession;')(
    {getAuthCandidates:()=>local,listAccounts:()=>local.map(x=>x.auth),
      listGlobalAccountsByOwner:owner=>local.map(x=>x.auth).filter(account=>account.ownerBotUserId===owner)},
    {getDefOrConfig:()=>({gameAreaId:'2',userAgent:'fixture'})},logger,class extends Error{},v=>v==null?'':String(v),()=> '[masked]',()=> '[masked]',()=>true,'unused fixture',new Map());
const session=new Session();
await check('self first preserves other candidates and input store',()=>{
  const before=JSON.stringify(local);assert.equal(session.candidates('222','owner-222')[0].auth.userId,'222');
  assert.equal(session.candidates('333','owner-333')[0].auth.userId,'333');assert.equal(session.candidates('222','owner-222').length,3);
  assert.equal(JSON.stringify(local),before);
});
await check('non-pool target keeps rotation',()=>{
  const firsts=Array.from({length:4},()=>session.candidates('999','owner-111')[0].auth.userId);
  assert.ok(new Set(firsts).size>=2);
});
console.log(JSON.stringify({ok:true,checks,patched,network:'synthetic dependencies only; no business API or real message'}));
