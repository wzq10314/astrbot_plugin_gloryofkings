// Evaluate actual upstream bodies with synthetic dependencies; no real network or accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const template=createRequire(new URL('../engine/package.json',import.meta.url))('art-template');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream');
let checks=0;
const test=async(name,run)=>{try{await run();checks++;}catch(error){error.message=name+': '+error.message;throw error}};
globalThis.fetch=async()=>{throw Error('Real network forbidden')};
globalThis.logger={debug(){},warn(){},error(){}};
globalThis.plugin=class{constructor(options){Object.assign(this,options)}};
const dependencies=[];globalThis.__oct18Dependencies=dependencies;
async function load(relative,mocks){
  let source=fs.readFileSync(path.join(root,relative),'utf8');
  source=source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,(_,clause,quote,specifier)=>{
    assert.ok(Object.hasOwn(mocks,specifier),'Unmocked '+specifier);
    const binding=`globalThis.__oct18Dependencies[${dependencies.push(mocks[specifier])-1}]`;
    clause=clause.trim();
    if(clause.startsWith('{'))return `const ${clause.replace(/\s+as\s+/g,': ')} = ${binding};\n`;
    assert.match(clause,/^[A-Za-z_$][\w$]*$/);return `const ${clause} = ${binding}.default;\n`;
  });
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
let share={enabled:false,apiUrl:'https://fixture.invalid',token:'synthetic-only'};
const requests=[];let response={ok:true,status:200,json:async()=>({list:[],total:0})};
const fakeFetch=async(url,options)=>{requests.push({url,options});return response};
const powers=await load('utils/heroPowerShare.js',{'node-fetch':{default:fakeFetch},'./shareStore.js':{readShareConfig:()=>share}});
await test('disabled ranking sharing emits no requests',async()=>{
  assert.equal(powers.isHeroPowerReady(),false);
  assert.deepEqual(await powers.reportHeroPowers('fixture-user',[{heroId:109,power:100}]),{sent:0,skipped:0});
  assert.equal((await powers.queryHeroPowerRank('妲己')).ok,false);assert.equal(requests.length,0);
});
await test('explicit sharing reports once and obeys TTL',async()=>{
  share.enabled=true;const items=[{heroId:109,power:321,campId:'fixture-camp',nick:'fixture'}];
  assert.deepEqual(await powers.reportHeroPowers('fixture-user',items),{sent:1,skipped:0});
  assert.deepEqual(await powers.reportHeroPowers('fixture-user',items),{sent:0,skipped:1});
  assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0].options.body).power,321);
});
await test('older ranking service reports unsupported not success',async()=>{
  response={ok:false,status:404,json:async()=>({})};const result=await powers.queryHeroPowerRank('妲己');
  assert.equal(result.ok,false);assert.match(result.message,/还没更新/);
});
let config={teamUpEnabled:false,distUrl:'https://admin.invalid',distToken:'synthetic-team-only'};
delete globalThis.__gokTeamClientState;
const team=await load('utils/teamClient.js',{'node-fetch':{default:fakeFetch},'#components':{Config:{getDefOrConfig:()=>config}},'./deploy.js':{normalizeBase:value=>String(value).replace(/\/$/,'')}});
await test('disabled team writes and polling never contact service',async()=>{
  const before=requests.length;assert.equal(team.isTeamReady(),false);
  assert.equal((await team.teamList()).error,'disabled');assert.equal((await team.teamCreate({})).error,'disabled');assert.equal(requests.length,before);
});
await test('explicit service keeps business refusal separate from network',async()=>{
  config.teamUpEnabled=true;response={status:404,json:async()=>({ok:false,error:'no_such_room',message:'fixture missing'})};
  assert.equal(team.isTeamReady(),true);assert.equal((await team.teamJoin({code:'12'})).error,'no_such_room');
  response={status:404,json:async()=>({error:'not_found'})};assert.equal((await team.teamList()).error,'not_supported');
  response={status:401,json:async()=>({})};assert.equal((await team.teamList()).error,'bad_token');
});
const captured=[];
const rank=await load('apps/heroPowerRank.js',{
 '../../../lib/puppeteer/puppeteer.js':{default:{screenshot:async(name,data)=>{captured.push(data);return 'fixture-image'}}},
 '#utils':{getImgType:()=> 'jpeg',shouldQuote:()=>false,stripAtText:text=>text},
 '../utils/api.js':{default:{getProfile:async()=>({data:{targetRoleId:'role',roleList:[{roleId:'role',roleName:'Synthetic',roleIcon:'https://avatar.invalid/example'}]}}),getGameHeroList:async()=>({data:{heroList:[{name:'妲己',heroId:109,heroFightPower:555}]}})}},
 '../utils/rankStore.js':{dedupeTargets:()=>new Map([['fixture-camp','fixture-user']])},
 '../utils/heroPowerShare.js':{isHeroPowerReady:()=>false,queryHeroPowerRank:async()=>{throw Error('Disabled sharing queried')}}
});
await test('real hero ranking uses complete hero list and avatar',async()=>{
 const plugin=new rank.HeroPowerRank();const replies=[];await plugin.rank({msg:'#妲己总排名',reply:async value=>replies.push(value)});
 assert.deepEqual(replies,['fixture-image']);assert.equal(captured[0].list[0].power,555);assert.equal(captured[0].list[0].rank,1);assert.equal(captured[0].list[0].roleIcon,'https://avatar.invalid/example');
 const rule=new RegExp(plugin.rule[0].reg);assert.equal(rule.test('#排位总排名'),false);assert.equal(rule.test('#巅峰总排名'),false);assert.equal(rule.test('#妲己总排名'),true);
});
await test('new podium template renders escaped synthetic names',async()=>{
 const source=fs.readFileSync(path.join(root,'resources/html/HeroPowerRank.html'),'utf8');
 const html=template.compile(source)({...captured[0],heroName:'<unsafe-name>',total:4,list:[1,2,3,4].map(rank=>({rank,nick:'Fixture '+rank,area:'fixture',power:500-rank,roleIcon:''}))});
 assert.match(html,/(?:&lt;|&#60;)unsafe-name(?:&gt;|&#62;)/);assert.ok(!html.includes('<unsafe-name>'));assert.ok(html.includes('Fixture 4'));
});
await test('team templates compile for account-free empty room list',async()=>{
 for(const name of ['TeamList','TeamBroadcast']){
  const source=fs.readFileSync(path.join(root,'resources/html/'+name+'.html'),'utf8');
  assert.equal(typeof template.compile(source),'function');
 }
});
console.log('October 18 offline body checks: '+checks);
