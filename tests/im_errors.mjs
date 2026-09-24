import assert from 'node:assert/strict';
import {imSendFailure} from '../engine/im-errors.mjs';
assert.match(imSendFailure({raw:{retCode:-123}}),/错误码：-123/);
assert.match(imSendFailure({raw:{returnCode:'-456'}}),/错误码：-456/);
assert.match(imSendFailure({code:'no-account'}),/凭据不完整/);
assert.match(imSendFailure({error:'fetch failed https://secret.test/?token=PRIVATE'}),/网络异常/);
for(const result of [null,{}, {code:'PRIVATE',error:'PRIVATE',raw:{retCode:'PRIVATE'}},
  {raw:{retCode:0,token:'PRIVATE'},error:'PRIVATE'}, {error:'fetch failed PRIVATE'}]) {
  assert.ok(!imSendFailure(result).includes('PRIVATE'));
  assert.match(imSendFailure(result),/未确认发送成功/);
}
console.log('IM error classification and redaction passed');
