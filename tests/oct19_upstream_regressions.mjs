// Actual upstream bodies with synthetic imports only. No accounts, external traffic, or source writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../engine/upstream');
let checks=0;const names=[];
globalThis.fetch=async()=>{throw Error('real network forbidden')};
globalThis.logger={debug(){},warn(){},error(){}};
globalThis.plugin=class{constructor(options){Object.assign(this,options)}};
const dependencies=[];globalThis.__oct19Mocks=dependencies;
async function load(relative,mocks){
 let source=fs.readFileSync(relative==='utils/shareStore.js'&&process.env.GOK_TEST_ADAPTED_SHARE_FILE?process.env.GOK_TEST_ADAPTED_SHARE_FILE:path.join(root,relative),'utf8');
 source=source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,(_,clause,quote,specifier)=>{
  assert.ok(Object.hasOwn(mocks,specifier),'unmocked '+specifier);
  const ref=`globalThis.__oct19Mocks[${dependencies.push(mocks[specifier])-1}]`;
  clause=clause.trim();
  if(clause.startsWith('{'))return `const ${clause.replace(/\s+as\s+/g,': ')}=${ref};\n`;
  const combined=clause.match(/^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/);
  if(combined)return `const ${combined[1]}=${ref}.default;const ${combined[2].replace(/\s+as\s+/g,': ')}=${ref};\n`;
  assert.match(clause,/^[A-Za-z_$][\w$]*$/);return `const ${clause}=${ref}.default;\n`;
 });
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
async function test(name,run){try{await run();checks++;names.push(name)}catch(e){e.message=name+': '+e.message;throw e}}
const nativeTimers={setTimeout,clearTimeout,setInterval,clearInterval};
async function frozenTimers(run){
 const scheduled=[];globalThis.setTimeout=(fn,delay)=>{const t={fn,delay,kind:'timeout',unref(){}};scheduled.push(t);return t};
 globalThis.setInterval=(fn,delay)=>{const t={fn,delay,kind:'interval',unref(){}};scheduled.push(t);return t};
 try{return await run(scheduled)}finally{Object.assign(globalThis,nativeTimers)}
}
let config,userData,requests,response;
async function shareFixture(){
 config={shareEnabled:false,shareRosterUploadEnabled:true,shareApiUrl:'https://fixture.invalid',distToken:'synthetic-token',shareAdminSecret:'synthetic-admin'};
 userData={};requests=[];response=async()=>({ok:true,status:200,json:async()=>({})});
 for(const key of ['__gokRosterUploadState','__gokRosterReportStarted','__gokShareStoreState'])delete globalThis[key];
 return frozenTimers(async scheduled=>{
  const module=await load('utils/shareStore.js',{
   'node:path':{default:path},'node-fetch':{default:async(url,options)=>{assert.ok(url.startsWith('https://fixture.invalid/'));requests.push({url,options});return response(url,options)}},
   '#components':{PluginData:'/synthetic-fixture',Config:{getDefOrConfig:()=>config}},
   './yamlUtils.js':{readYamlFile:()=>({}),writeYamlFile:()=>{throw Error('unexpected file write')}},
   './safeStore.js':{quarantineCorrupt(){}},'./localBind.js':{getCurrentId:()=>'',getBoundIds:()=>[],readUserData:()=>userData},
   './authStore.js':{default:{listAccounts:()=>[]},isUsableAuth:()=>false}
  });return {module,scheduled};
 });
}
const image=await load('utils/fileUtils.js',{'fs':{default:fs},'path':{default:path},'node:crypto':{default:crypto},
 'node-fetch':{default:globalThis.fetch},'#components':{PluginData:'/synthetic-fixture',Config:{getDefOrConfig:()=>({})}},'./safeStore.js':{writeFileAtomic(){throw Error('unexpected write')}}});
for(const [label,hex,url,want]of[
 ['PNG header','89504e470d0a1a0a00000000','https://fixture.invalid/a.jpg','image/png'],
 ['JPEG header','ffd8ffe00000000000000000','','image/jpeg'],
 ['GIF header','474946383961000000000000','','image/gif'],
 ['WebP header','524946460000000057454250','','image/webp'],
 ['SVG header',Buffer.from('<svg xmlns="fixture"></svg>').toString('hex'),'','image/svg+xml'],
 ['extension fallback','0000','https://fixture.invalid/a.webp?x=1','image/webp'],
 ['invalid URL fallback','0000','not a URL','image/jpeg']]){
 await test('MIME '+label,()=>assert.equal(image.sniffImageMime(Buffer.from(hex,'hex'),url),want));
}
await test('disabled sharing sends neither bulk upload nor roster request',async()=>{
 const {module:m,scheduled}=await shareFixture();assert.equal((await m.uploadLocalBindings()).ok,false);assert.equal((await m.fetchSharedRoster()).ok,false);assert.equal(requests.length,0);
 assert.deepEqual(scheduled.map(t=>[t.kind,t.delay]),[['timeout',15000],['interval',3600000]]);
});
await test('ordinary token queries public roster without admin secret',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;config.shareAdminSecret='';
 response=async()=>({ok:true,status:200,json:async()=>({campIds:['222222','333333'],total:2})});
 const result=await m.fetchSharedRoster();assert.equal(result.ok,true);assert.deepEqual(result.campIds,['222222','333333']);
 assert.equal(requests.length,1);assert.equal(requests[0].url,'https://fixture.invalid/api/v1/roster');
 assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(requests[0].options.headers['X-Admin-Secret'],undefined);
});
await test('legacy admin roster is used only after public endpoint404',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;
 response=async(url)=>url.endsWith('/api/v1/roster')?{ok:false,status:404}:{ok:true,status:200,json:async()=>({campIds:['444444']})};
 const result=await m.fetchSharedRoster();assert.equal(result.ok,true);assert.deepEqual(result.campIds,['444444']);assert.equal(requests.length,2);
 assert.equal(requests[1].url,'https://fixture.invalid/api/v1/admin/roster');assert.equal(requests[1].options.headers['X-Admin-Secret'],'synthetic-admin');
});
await test('public roster404 without admin secret does not send admin request',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;config.shareAdminSecret='';response=async()=>({ok:false,status:404});
 assert.equal((await m.fetchSharedRoster()).ok,false);assert.equal(requests.length,1);
});
if(process.env.GOK_TEST_ADAPTED_SHARE_FILE)await test('runtime bulk-sharing gate blocks even force while explicit per-user API remains available',async()=>{
 const{module:m}=await shareFixture();config.shareEnabled=true;config.shareRosterUploadEnabled=false;userData={'123456':{ids:['222222']}};
 assert.equal((await m.uploadLocalBindings(true)).ok,false);assert.equal(requests.length,0);assert.equal(typeof m.pushBind,'function');
 config.shareRosterUploadEnabled='true';assert.equal((await m.uploadLocalBindings(true)).ok,false);assert.equal(requests.length,0);
});
await test('205 local owners upload in100/100/5 chunks excluding adopted and nonnumeric identities',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;
 for(let n=0;n<205;n++)userData[String(100000+n)]={ids:[String(200000+n)],current:0};
 userData['999999']={ids:['333333'],fromShare:true};userData['openid-fixture']={ids:['444444']};userData['888888']={ids:['invalid']};
 const result=await m.uploadLocalBindings();assert.equal(result.ok,true);assert.equal(result.entries,205);
 const body=requests.map(r=>JSON.parse(r.options.body));assert.deepEqual(body.map(x=>x.binds.length),[100,100,5]);assert.deepEqual(body.map(x=>x.replace),[true,false,false]);
 assert.ok(body.flatMap(x=>x.binds).every(x=>x.qq!=='999999'&&x.qq!=='openid-fixture'));assert.ok(requests.every(r=>r.options.method==='PUT'));
 const before=requests.length;assert.equal((await m.uploadLocalBindings()).skipped,true);assert.equal(requests.length,before);
});
await test('owner maximum20 camp IDs and removed current ID safely falls back',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;userData={'123456':{ids:Array.from({length:21},(_,i)=>String(200000+i)),current:20}};
 assert.equal((await m.uploadLocalBindings()).ok,true);const b=JSON.parse(requests[0].options.body).binds[0];assert.equal(b.campIds.length,20);assert.equal(b.current,'200000');
});
await test('concurrent bulk requests coalesce',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;userData={'123456':{ids:['222222']}};
 const results=await Promise.all([m.uploadLocalBindings(),m.uploadLocalBindings()]);assert.ok(results.every(x=>x.ok));assert.equal(requests.length,1);
});
await test('bulk authorization refusal does not become success',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;userData={'123456':{ids:['222222']}};response=async()=>({status:401,ok:false});
 assert.equal((await m.uploadLocalBindings()).ok,false);assert.equal(globalThis.__gokRosterUploadState.at,0);
});
await test('bulk network failure remains isolated',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;userData={'123456':{ids:['222222']}};response=async()=>{throw Error('synthetic offline')};
 assert.equal((await m.uploadLocalBindings()).ok,false);assert.equal(globalThis.__gokRosterUploadState.running,null);
});
for(const status of[404,401,403,500])await test('roster HTTP'+status+' reports failure not empty success',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;response=async()=>({ok:false,status});const r=await m.fetchSharedRoster();assert.equal(r.ok,false);assert.deepEqual(r.campIds,[]);
});
await test('roster60second cache avoids duplicate request',async()=>{
 const {module:m}=await shareFixture();config.shareEnabled=true;response=async()=>({ok:true,status:200,json:async()=>({campIds:['222222','333333'],total:2})});
 const a=await m.fetchSharedRoster(),b=await m.fetchSharedRoster();assert.deepEqual(a.campIds,b.campIds);assert.equal(requests.length,1);assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(requests[0].options.headers['X-Admin-Secret'],undefined);
});
const mapConcurrent=async(items,fn)=>Promise.all([...items].map(fn));
async function rankFixture(roster,signature='222222,333333'){
 const calls={upload:0,legacy:0};
 const m=await load('apps/rankList.js',{'path':{default:path},'../../../lib/puppeteer/puppeteer.js':{default:{}},
 '#utils':{getImgType:()=> 'webp',readYamlFile:()=>({}),Button:{bind:()=>''},getUserAvatar:()=>'',shouldQuote:()=>false,isShareReady:()=>true,
 querySharedBind:async()=>{calls.legacy++;return {campIds:['444444']}},fetchSharedRoster:async()=>roster,uploadLocalBindings:async()=>{calls.upload++;return {ok:true}}},
 '../utils/rankStore.js':{getAllBindings:()=>[{campId:'222222',botUserId:'123456'}],readSnapshot:()=>({updatedAt:Date.now(),entries:{'222222':{}},signature}),collectRankData:async()=>({}),buildRankList:()=>[],SNAPSHOT_TTL:43200000},
 '../utils/parallel.js':{mapConcurrent},'#components':{PluginData:'/synthetic-fixture'}});
 const plugin=new m.RankList();plugin.render=async(e,options)=>{calls.render=options};return{plugin,calls};
}
await test('global rank preserves stable roster cache despite hidden missing entries',async()=>{
 const{plugin,calls}=await rankFixture({ok:true,campIds:['333333','222222']});await frozenTimers(()=>plugin.globalRank({msg:'#排位总排名',reply:async()=>{}}));
 assert.equal(calls.upload,1);assert.equal(calls.legacy,0);assert.equal(calls.render.force,false);assert.equal(calls.render.signature,'222222,333333');assert.equal(calls.render.extraTargets.size,2);
});
await test('changed roster invalidates global rank cache',async()=>{
 const{plugin,calls}=await rankFixture({ok:true,campIds:['222222','555555']});await frozenTimers(()=>plugin.globalRank({msg:'#排位总排名',reply:async()=>{}}));assert.equal(calls.render.force,true);
});
await test('older roster service falls back to known-owner lookup',async()=>{
 const{plugin,calls}=await rankFixture({ok:false,campIds:[]});await frozenTimers(()=>plugin.globalRank({msg:'#排位总排名',reply:async()=>{}}));assert.equal(calls.legacy,1);assert.equal(calls.render.extraTargets.get('444444'),'123456');assert.equal(calls.render.signature,null);
});
await test('actual hero ranking adds roster IDs, deduplicates locally and limits20 rows',async()=>{
 const images=[],queried=[];let uploads=0;
 const m=await load('apps/heroPowerRank.js',{'../../../lib/puppeteer/puppeteer.js':{default:{screenshot:async(name,data)=>{images.push(data);return 'image'}}},
 '#utils':{getImgType:()=> 'webp',shouldQuote:()=>false,stripAtText:text=>text,uploadLocalBindings:async()=>{uploads++;return {ok:true}},fetchSharedRoster:async()=>({ok:true,campIds:Array.from({length:25},(_,n)=>String(200000+n))})},
 '../utils/api.js':{default:{getProfile:async(campId)=>{queried.push(campId);return {data:{targetRoleId:'r',roleList:[{roleId:'r',roleName:'Owner'+campId}]}}},getGameHeroList:async(campId)=>({data:{heroList:[{name:'妲己',heroId:109,heroFightPower:Number(campId)}]}})}},
 '../utils/rankStore.js':{dedupeTargets:()=>new Map([['200000','123456']])},'../utils/heroPowerShare.js':{isHeroPowerReady:()=>false,queryHeroPowerRank:async()=>{throw Error('unexpected shared power query')}}});
 await frozenTimers(()=>new m.HeroPowerRank().rank({msg:'#妲己总排名',reply:async()=>{}}));
 assert.equal(uploads,1);assert.equal(queried.length,25);assert.equal(new Set(queried).size,25);assert.equal(images[0].list.length,20);assert.equal(images[0].list[0].power,200024);
});
await test('actual rank snapshot signature controls reuse',async()=>{
 let saved={updatedAt:Date.now(),entries:{'222222':{}},signature:'old'},writes=0;
 const m=await load('utils/rankStore.js',{'path':{default:path},'./fileUtils.js':{readJsonFile:()=>saved,writeJsonFile:(name,value)=>{saved=value;writes++}},
 './safeStore.js':{quarantineCorrupt(){}},'./yamlUtils.js':{readYamlFile:()=>({})},'./blackList.js':{isBlackUser:()=>false},'./api.js':{default:{}},
 './parallel.js':{mapConcurrent},'./hiddenProfiles.js':{isProfileHidden:()=>false},'#components':{PluginData:'/synthetic-fixture'}});
 assert.equal((await m.collectRankData({signature:'old'})).fromCache,true);assert.equal(writes,0);
 const r=await m.collectRankData({signature:'new'});assert.equal(r.fromCache,false);assert.equal(saved.signature,'new');assert.equal(writes,1);
});
await test('skin-label fallback remains official and MIME handling is used for all localized images',()=>{
 const source=fs.readFileSync(path.join(root,'apps/skinWall.js'),'utf8');
 assert.match(source,/'珍品传说': 'https:\/\/game-1255653016\.file\.myqcloud\.com\/manage\/custom_wzry_skin_label\//);
 assert.ok(source.indexOf('labelSources.push(skin.labelUrl)')<source.indexOf('labelSources.push(fallback)'));
 assert.equal((source.match(/sniffImageMime\(/g)||[]).length,3);assert.ok(!source.includes('`data:image/jpeg;base64,'));
});
console.log(JSON.stringify({passed:true,checks,names,realExternalRequests:0,realAccountsUsed:false,productionChanged:false}));
