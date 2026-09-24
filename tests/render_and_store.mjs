import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {register} from 'node:module';
import renderer,{render} from '../engine/renderer.mjs';
register('../engine/loader.mjs',import.meta.url);
const root=path.resolve(process.argv[2]);
const source=path.join(root,'plugins/GloryOfKings-Plugin');
const load=rel=>import(pathToFileURL(path.join(source,rel)));
globalThis.logger=new Proxy({},{get:()=>()=>{}});
globalThis.gok={root,call:async()=>{throw Error('RemoteAssetsDisabledInTest')},emit:()=>{}};
let checks=0;
try {
  const {buildTrendView,pickPeakBattles}=await load('utils/scoreTrend.js');
  const scores=[1500,1530,1510,1550,1570];
  const battles=scores.map((score,i)=>({mapName:'巅峰赛',dtEventTime:1790180000+i*3600,
    oldMasterMatchScore:i?scores[i-1]:1480,newMasterMatchScore:score,gameresult:i===2?2:1,
    heroId:109,killcnt:6,deadcnt:2,assistcnt:7}));
  const picked=pickPeakBattles([...battles,{...battles[0],mapName:'排位赛'}]);
  assert.equal(picked.length,5);checks++;
  const view=buildTrendView(picked,{heroMap:{109:'妲己'}});
  assert.equal(view.deltaText,'+90');assert.equal(view.winRate,80);checks++;
  const image=await render('ScoreTrend',{...view,title:'巅峰趋势 · 测试数据',subText:'模拟战绩',username:'测试玩家',avatar:'',
    trendJson:JSON.stringify(view.trend),footText:'仅用于适配验证，不是真实账号数据',
    tplFile:'plugins/GloryOfKings-Plugin/resources/html/ScoreTrend.html'},async page=>{
      const painted=await page.evaluate(()=>{
        const c=document.querySelector('canvas');const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let count=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])count++;return count;
      });
      assert.ok(painted>10000,'canvas chart must be drawn by upstream JavaScript');checks++;
    });
  assert.ok(image.length>20000);checks++;
  if(process.argv[3])fs.writeFileSync(process.argv[3],image);
  const host=await renderer.browserInit();
  const first=await host.newPage(),second=await host.newPage();
  await first.setCookie({name:'account',value:'test-only',domain:'example.test',path:'/'});
  assert.equal((await second.cookies('https://example.test')).length,0);checks++;
  await first.close();await second.close();

  const {default:auth}=await load('utils/authStore.js');
  auth.upsertGlobalAccount({userId:'77777011',ownerBotUserId:'12345011',token:'test-only',userKey:'test-only'});
  auth.upsertGlobalAccount({userId:'77777012',ownerBotUserId:'12345012',token:'test-only',userKey:'test-only'});
  assert.deepEqual(auth.listGlobalAccountsByOwner('12345011').map(a=>a.userId),['77777011']);checks++;
  const a=auth.getAccount('77777011');
  auth.replaceAccountsFromGuoba([{userId:a.userId,nickname:'changed'},{userId:'77777012'}]);
  assert.equal(auth.getAccount('77777011').isGlobalDefault,true);checks++;
  auth.replaceAccountsFromGuoba([{userId:a.userId,isGlobalDefault:false},{userId:'77777012'}]);
  assert.equal(auth.getAccount('77777011').isGlobalDefault,false);checks++;
  const store=await load('utils/campImStore.js');
  const message={selfUserId:'77777011',fromUserId:'77777012',fromRoleName:'测试',text:'测试消息',time:1790180000,messageId:'111'};
  const keys=store.messageKeys(message);
  assert.deepEqual(keys,store.messageKeys({...message,id:2222}));checks++;
  for(const key of keys)store.markSeenMessage(key);
  store.invalidate();assert.ok(store.hasSeenMessage(keys[0]));checks++;
  store.addRef('555',{selfUserId:'77777011',toUserId:'77777012'});
  store.invalidate();assert.equal(store.getRef('555').selfUserId,'77777011');checks++;
  const {Config}=await load('components/index.js');
  Config.modify('config','campImPushImage',false);
  const push=await load('utils/campImPush.js');
  const deliveries=[];
  const bot={pickFriend:id=>({sendMsg:async content=>{
    deliveries.push({id:String(id),content});return {message_id:'im-private-test'};
  }}),pickGroup:()=>{throw Error('IM must never send to a group')}};
  assert.equal((await push.pushToOwner(message,{bot})).ok,true);
  assert.deepEqual(deliveries.map(d=>d.id),['12345011']);checks++;
  assert.equal(store.getRef('im-private-test').selfUserId,'77777011');checks++;
  const unknown=await push.pushToOwner({...message,selfUserId:'99999000'},{bot});
  assert.equal(unknown.reason,'no_owner');assert.equal(deliveries.length,1);checks++;
  console.log(JSON.stringify({ok:true,checks}));
} finally {await renderer.shutdown();}
process.exit(0);
