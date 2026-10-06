// Synthetic local pools only. No network, real credentials or account writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readSharedQueryCandidates, SHARED_QUERY_SOURCE, MAX_SHARED_POOL_BYTES}
  from '../engine/shared-query-auth.mjs';

const tempParent = path.resolve(os.tmpdir());
const directory = fs.mkdtempSync(path.join(tempParent, 'gok-shared-query-'));
const file = path.join(directory, 'AuthPool.json');
let checks = 0, skipped = 0;
const test = (name, callback) => {
  try {callback(); checks++;}
  catch (error) {error.message = `${name}: ${error.message}`; throw error;}
};
const account = (userId = '70000001', extra = {}) => ({
  userId, token: 'fixture-token', userKey: 'fixture-key', isGlobalDefault: true,
  authInvalid: false, priority: 100, ...extra,
});
const save = accounts => fs.writeFileSync(file, JSON.stringify({accounts}));
const read = (allowed = ['70000001']) => readSharedQueryCandidates(file, allowed);

try {
  test('missing source fails closed', () => assert.deepEqual(read(), []));
  test('absolute source path required', () => assert.deepEqual(readSharedQueryCandidates('AuthPool.json', ['70000001']), []));
  test('complete global account is projected for queries', () => {
    save({'70000001': account('70000001', {openId: 'fixture-openid', gameRoleId: '42'})});
    const [candidate] = read();
    assert.equal(candidate.source, SHARED_QUERY_SOURCE);
    assert.equal(candidate.auth.userId, '70000001');
    assert.equal(candidate.auth.token, 'fixture-token');
    assert.equal(candidate.auth.userKey, 'fixture-key');
    assert.equal(candidate.auth.openId, 'fixture-openid');
    assert.equal(candidate.auth.gameRoleId, '42');
    assert.equal(candidate.auth.enabled, true);
  });
  test('allowlist is mandatory', () => {
    for (const allowed of [undefined, null, [], '70000001', ['not-an-id'], ['70000002']]) {
      assert.deepEqual(read(allowed === undefined ? null : allowed), []);
    }
  });
  test('membership is exact', () => assert.deepEqual(read(['700000010']), []));
  test('numeric safe identifiers are supported', () => assert.equal(read([70000001]).length, 1));
  test('unsafe numeric identifier cannot grant access', () => assert.deepEqual(read([Number.MAX_SAFE_INTEGER + 1]), []));
  test('private credentials and ownership fields are excluded', () => {
    const denied = ['ownerBotUserId', 'userSig', 'accessToken', 'refreshToken', 'appOpenid',
      'uin', 'nickname', 'avatar', 'loginPlatform', 'remark', 'extraHeaders', 'password'];
    const extra = Object.fromEntries(denied.map(key => [key, 'fixture-private-' + key]));
    save({'70000001': account('70000001', extra)});
    const candidate = read()[0];
    for (const key of denied) assert.ok(!Object.hasOwn(candidate.auth, key), key);
    assert.doesNotMatch(JSON.stringify(candidate), /fixture-private-/);
  });
  test('non-global accounts never become candidates', () => {
    save({'70000001': account('70000001', {isGlobalDefault: false})});
    assert.deepEqual(read(), []);
  });
  test('truthy string global flag is not sufficient', () => {
    save({'70000001': account('70000001', {isGlobalDefault: 'true'})});
    assert.deepEqual(read(), []);
  });
  test('invalidated account is excluded', () => {
    save({'70000001': account('70000001', {authInvalid: true})});
    assert.deepEqual(read(), []);
  });
  test('incomplete and malformed credentials are excluded', () => {
    for (const extra of [{token: ''}, {token: ' '}, {token: {}}, {userKey: '', encodeRes: ''},
      {userKey: null}, {userKey: []}, {userId: ''}, {userId: '70000002'}]) {
      save({'70000001': account('70000001', extra)});
      assert.deepEqual(read(), []);
    }
  });
  test('encodeRes can replace userKey', () => {
    save({'70000001': account('70000001', {userKey: '', encodeRes: 'fixture-encoded'})});
    assert.equal(read()[0].auth.encodeRes, 'fixture-encoded');
  });
  test('numeric account ID is normalized consistently', () => {
    save({'70000001': account(70000001)});
    assert.equal(read()[0].auth.userId, '70000001');
  });
  test('multiple allowed accounts retain deterministic priority', () => {
    save({'70000001': account(), '70000002': account('70000002', {priority: 5}),
      '70000003': account('70000003', {priority: 5})});
    assert.deepEqual(read(['70000003', '70000001', '70000002']).map(row => row.auth.userId),
      ['70000002', '70000003', '70000001']);
    assert.equal(read(['70000001', '70000001']).length, 1);
  });
  test('source token replacement is visible on the next call', () => {
    save({'70000001': account()});
    const before = read();
    save({'70000001': account('70000001', {token: 'fixture-new-token'})});
    assert.equal(read()[0].auth.token, 'fixture-new-token');
    assert.equal(before[0].auth.token, 'fixture-token');
  });
  test('source revocation and removal take effect immediately', () => {
    save({'70000001': account()});
    assert.equal(read().length, 1);
    save({'70000001': account('70000001', {authInvalid: true})});
    assert.deepEqual(read(), []);
    save({});
    assert.deepEqual(read(), []);
  });
  test('returned candidates cannot mutate the source or later reads', () => {
    save({'70000001': account()});
    const bytes = fs.readFileSync(file);
    const [candidate] = read();
    candidate.auth.token = 'modified-only-in-memory';
    candidate.auth.authInvalid = true;
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(read()[0].auth.token, 'fixture-token');
    assert.equal(read()[0].auth.authInvalid, false);
  });
  test('query context values are primitive and known fields only', () => {
    save({'70000001': account('70000001', {serverTimeOffsetMs: 20, cIsArm64: true,
      userAgent: {credential: 'fixture-private'}, __unexpected: 'fixture-private'})});
    const auth = read()[0].auth;
    assert.equal(auth.serverTimeOffsetMs, 20);
    assert.equal(auth.cIsArm64, true);
    assert.ok(!Object.hasOwn(auth, 'userAgent'));
    assert.ok(!Object.hasOwn(auth, '__unexpected'));
  });
  test('corrupt and unexpected JSON shapes fail closed', () => {
    for (const content of ['{broken', 'null', '[]', '{}', '{"accounts":[]}',
      '{"accounts":"invalid"}', '{"accounts":{"70000001":null}}']) {
      fs.writeFileSync(file, content);
      assert.deepEqual(read(), []);
    }
  });
  test('oversized source is rejected before parsing', () => {
    fs.writeFileSync(file, Buffer.alloc(MAX_SHARED_POOL_BYTES + 1, 32));
    assert.deepEqual(read(), []);
  });
  test('empty source and directory source fail closed', () => {
    fs.writeFileSync(file, '');
    assert.deepEqual(read(), []);
    assert.deepEqual(readSharedQueryCandidates(directory, ['70000001']), []);
  });
  test('symlink source is rejected', () => {
    save({'70000001': account()});
    const linked = path.join(directory, 'linked-pool.json');
    try {fs.symlinkSync(file, linked, 'file');}
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {skipped++; return;}
      throw error;
    }
    assert.deepEqual(readSharedQueryCandidates(linked, ['70000001']), []);
  });
  test('ancestor directory symlink or junction is rejected', () => {
    const realDirectory = path.join(directory, 'real');
    const linkDirectory = path.join(directory, 'linked-directory');
    fs.mkdirSync(realDirectory);
    const realPool = path.join(realDirectory, 'AuthPool.json');
    fs.writeFileSync(realPool, JSON.stringify({accounts: {'70000001': account()}}));
    fs.symlinkSync(realDirectory, linkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(readSharedQueryCandidates(path.join(linkDirectory, 'AuthPool.json'), ['70000001']), []);
  });
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), tempParent);
  assert.ok(path.basename(resolved).startsWith('gok-shared-query-'));
  fs.rmSync(resolved, {recursive: true, force: true});
}
console.log(`Shared query authentication: ${checks - skipped} checks passed${skipped ? `; ${skipped} file-symlink case unavailable on this host` : ''}`);
