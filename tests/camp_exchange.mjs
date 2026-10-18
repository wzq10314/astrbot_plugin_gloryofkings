import assert from 'node:assert/strict';
import {parseExchange, normalizeGift, numberGifts, groupByCycle, canExchange, exchangeBody}
  from '../engine/upstream/utils/campExchange.js';
import {parseCoinBalance,balanceLineOf} from '../engine/upstream/utils/campMall.js';
const raw=(pos,period,priority)=>({exchangePos:pos,userLimitType:period,priority,
  gameId:'20001',sPackageName:'fixture reward',currency:100,itemLeft:-1,userLeft:1,sPackageId:'pkg-'+pos});
const parsed=parseExchange({userCurrencyCnt:150,exchangeInfo:{giftList:[raw(19,3,1),raw(2,1,2),raw(7,0,3)]}});
const numbered=numberGifts(groupByCycle(parsed.gifts));
const shown=numbered.flatMap(row=>row.gifts);
assert.deepEqual(shown.map(item=>item.no),[1,2,3]);
assert.equal(new Set(shown.map(item=>item.pos)).size,3,'Unique package positions');
assert.equal(parseExchange({}).coin,null);assert.equal(parseCoinBalance({}).coin,null);
assert.equal(balanceLineOf('fixture',{coin:0}),null);
assert.match(balanceLineOf('fixture',{coin:null}),/读取失败/);
assert.equal(canExchange(normalizeGift(raw(19,3,1)),150).ok,true);
assert.equal(canExchange(normalizeGift({...raw(19,3,1),itemLeft:0}),150).ok,false);
assert.equal(canExchange(normalizeGift({...raw(19,3,1),userLeft:0}),150).ok,false);
assert.equal(canExchange(normalizeGift(raw(19,3,1)),20).ok,false);
assert.equal(canExchange(normalizeGift({...raw(19,3,1),gameId:'50001'}),150).ok,false);
const body=exchangeBody(normalizeGift(raw(19,3,1)),{openId:'fixture',areaId:'fixture',serverId:'fixture',roleId:'fixture'});
assert.equal(body.exchangePos,'19');assert.equal(body.gameId,'20001');assert.equal(body.giftType,'exchange');
console.log('Camp exchange parsing: numbering, original positions, quota, stock, balance and request shape passed; no request sent');
