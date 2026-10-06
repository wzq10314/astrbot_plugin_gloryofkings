import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {approvedRemote} from '../engine/remote-policy.mjs';
assert.equal(approvedRemote('https://example.test', []),false);
assert.equal(approvedRemote('https://example.test/', ['https://example.test']),true);
for(const url of ['https://example.test.evil','https://example.test:8443','http://example.test','https://example.test/path','https://user:password@example.test','https://example.test?x=1'])
  assert.equal(approvedRemote(url, ['https://example.test']),false);

// Exercise the actual materialized upstream function without live credentials/network.
let source=fs.readFileSync(path.join(process.argv[2],'plugins/GloryOfKings-Plugin/utils/remoteAccounts.js'),'utf8');
source=source.replace("import AdapterConfig from '../components/Config.js';", 'const AdapterConfig = {getConfig:()=>globalThis.testSettings};');
source=source.replace("import authStore, { isUsableAuth } from './authStore.js'", 'const authStore={listAccounts:()=>[{userId:"fixture",isGlobalDefault:true,updatedAt:1,token:"mock-token"}]}; const isUsableAuth=()=>true;');
globalThis.logger={warn:()=>{}};
let calls=0;
globalThis.fetch=async(url,options)=>{
  calls++; assert.equal(url,'https://example.test/api/accounts');
  assert.equal(options.redirect,'error');
  assert.equal(JSON.parse(options.body).accounts.fixture.token,'mock-token');
  return {status:200,json:async()=>({ok:true})};
};
const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
globalThis.testSettings={remoteAccountAllowedUrls:[]};
assert.equal((await module.reportRemoteAccounts('https://example.test')).skipped,'not-approved');
assert.equal(calls,0);
globalThis.testSettings.remoteAccountAllowedUrls=['https://example.test'];
assert.equal((await module.reportRemoteAccounts('https://example.test')).ok,true);
assert.equal(calls,1);
assert.equal((await module.reportRemoteAccounts('https://example.test')).skipped,'throttled');
globalThis.testSettings.remoteAccountAllowedUrls=[];
assert.equal((await module.reportRemoteAccounts('https://example.test',{force:true})).skipped,'not-approved');
assert.equal(calls,1);
console.log('Remote approval, revocation, endpoint matching and redirect policy passed');
