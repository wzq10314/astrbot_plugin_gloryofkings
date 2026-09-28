import assert from 'node:assert/strict';
import {refreshPushMembers, runPushTask} from '../engine/push-membership.mjs';

const bot={gml:new Map([[1,new Map([[10,{}],[20,{}]])],[2,new Map([[30,{}]])]])};
let calls=0,ran=0;
const fresh=async ids=>{calls++;assert.deepEqual(ids,['1']);return {members:{1:[{user_id:10}]}}};
assert.equal(await runPushTask(bot,['1','1'],fresh,()=>{ran++;assert.equal(bot.gml.get(1).has(20),false)}),true);
assert.equal(ran,1);assert.equal(calls,1);
// Partial responses must not run a push or retain stale member maps.
assert.equal(await runPushTask(bot,['1','2'],async()=>({members:{1:[{user_id:10}]}}),()=>ran++),false);
assert.equal(ran,1);assert.equal(bot.gml.has(2),false);
for(const rows of [[],null,{},[{nickname:'missing id'}],[{user_id:0}]]){
  bot.gml.set(1,new Map([[20,{}]]));
  assert.equal(await refreshPushMembers(bot,['1'],async()=>({members:{1:rows}})),false);
  assert.equal(bot.gml.has(1),false);
}
assert.equal(await refreshPushMembers(bot,['1'],async()=>{throw Error('offline')}),false);
assert.equal(await runPushTask(bot,[],()=>{throw Error('no API needed')},()=>ran++),true);
assert.equal(ran,2);
assert.equal(await runPushTask(bot,['1'],fresh,()=>ran++),true);
assert.equal(ran,3);
assert.equal(await runPushTask(bot,['1'],fresh,()=>ran++,()=>false),false);
assert.equal(ran,3,'a subscription added during refresh must not be cleared using an earlier snapshot');
console.log('Fresh membership, stale cache invalidation, failed-round skip and recovery passed');
