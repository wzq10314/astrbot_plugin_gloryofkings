// Run by test_shared_auth.py against its patched, temporary api.js.
// Execute the actual upstream auth class with an in-memory local store and a
// synthetic shared pool. No upstream imports, network, or real data are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readSharedQueryCandidates, SHARED_QUERY_SOURCE} from '../engine/shared-query-auth.mjs';

const [apiFile, poolFile] = process.argv.slice(2);
assert.ok(apiFile && poolFile, 'Requires the patched API and a temporary synthetic pool path');
const source = fs.readFileSync(apiFile, 'utf8');
const start = source.indexOf('\nclass CampAuthSession {');
const end = source.indexOf('\nclass CampTransport {', start);
assert.ok(start >= 0 && end > start, 'Upstream CampAuthSession class boundaries changed');
const classSource = source.slice(start, end);
assert.equal((classSource.match(/adapter-shared-global/g) || []).length, 2);

let local = [];
let reads = 0;
const writes = [];
const authStore = {
  getAuthCandidates: () => local,
  listAccounts: () => local.map(candidate => candidate.auth),
  markAuthFailure: (userId, message) => { writes.push(['failure', userId, message]); return {newlyInvalid: false}; },
  markAuthSuccess: userId => { writes.push(['success', userId]); },
};
class AuthConfigError extends Error {}
const toText = value => value == null ? '' : String(value);
const isUsableAuth = auth => Boolean(auth?.token && auth?.userId && (auth?.userKey || auth?.encodeRes));
const CampAuthSession = new Function(
  'authStore', 'Config', 'readSharedQueryCandidates', 'logger', 'AuthConfigError',
  'toText', 'maskValue', 'maskUserId', 'isUsableAuth', 'DEFAULT_PUBLIC_KEY',
  `${classSource}\nreturn CampAuthSession;`,
)(authStore, {getDefOrConfig: () => ({gameAreaId: '2', userAgent: 'fixture-agent'})},
  (...args) => { reads += 1; return readSharedQueryCandidates(...args); },
  {debug() {}, warn() {}}, AuthConfigError, toText, () => '[masked]', () => '[masked]',
  isUsableAuth, 'fixture-unused-public-key');
const session = new CampAuthSession();

const privateFields = ['ownerBotUserId', 'userSig', 'accessToken', 'refreshToken', 'appOpenid',
  'uin', 'nickname', 'avatar', 'loginPlatform', 'remark', 'extraHeaders', 'password'];
const account = (extra = {}) => ({userId: '123456789', token: 'fixture-token',
  userKey: 'fixture-key', isGlobalDefault: true, authInvalid: false, priority: 5,
  ...Object.fromEntries(privateFields.map(key => [key, 'fixture-private-' + key])), ...extra});
fs.mkdirSync(path.dirname(poolFile), {recursive: true});
const save = accounts => fs.writeFileSync(poolFile, JSON.stringify({accounts}));
const reset = extra => save({'123456789': account(extra),
  '987654321': account({userId: '987654321', priority: 1})});
let checks = 0;
const test = (name, run) => {
  try {run(); checks += 1;} catch (error) {error.message = `${name}: ${error.message}`; throw error;}
};

test('local candidates win without reading the shared pool', () => {
  reset();
  local = [{source: 'global', label: 'fixture-local', auth: account({userId: '111111111'})}];
  const candidates = session.candidates('222222222', 'fixture-openid');
  assert.equal(candidates[0].auth.userId, '111111111');
  assert.equal(reads, 0);
  local = [];
});
test('shared fallback remains allowlisted and supplies the real new config builder', () => {
  const candidates = session.candidates('222222222', 'fixture-openid');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, SHARED_QUERY_SOURCE);
  assert.equal(candidates[0].auth.userId, '123456789');
  assert.equal(candidates[0].auth.gameAreaId, '2');
  assert.equal(candidates[0].auth.userAgent, 'fixture-agent');
  session.assertReady(candidates[0].auth);
  for (const field of privateFields.filter(field => field !== 'extraHeaders')) {
    assert.ok(!Object.hasOwn(candidates[0].auth, field), field);
  }
  assert.deepEqual(candidates[0].auth.extraHeaders, {});
  assert.doesNotMatch(JSON.stringify(candidates), /fixture-private-/);
});
test('credentials are reread for each query and returned objects are isolated', () => {
  const first = session.candidates('222222222')[0];
  reset({token: 'fixture-refreshed-token'});
  const second = session.candidates('222222222')[0];
  assert.equal(second.auth.token, 'fixture-refreshed-token');
  assert.equal(first.auth.token, 'fixture-token');
  second.auth.token = 'changed-only-in-memory';
  assert.equal(session.candidates('222222222')[0].auth.token, 'fixture-refreshed-token');
});
test('shared success and failure never write local or source status', () => {
  const candidate = session.candidates('222222222')[0];
  const before = fs.readFileSync(poolFile);
  session.markFailure(candidate, 'fixture auth failure');
  session.markSuccess(candidate);
  assert.deepEqual(writes, []);
  assert.deepEqual(fs.readFileSync(poolFile), before);
  assert.deepEqual(session.usableAccounts(), []);
  assert.equal(session.usableCount(), 0);
});
test('shared IDs cannot update a same-ID local account', () => {
  const candidate = session.candidates('222222222')[0];
  local = [{source: 'global', label: 'fixture-collision', auth: account()}];
  session.markFailure(candidate, 'fixture auth failure');
  session.markSuccess(candidate);
  assert.deepEqual(writes, []);
  local = [];
});
test('local status updates are preserved', () => {
  const candidate = {source: 'global', label: 'fixture-local', auth: account()};
  session.markFailure(candidate, 'fixture-local-failure');
  session.markSuccess(candidate);
  assert.deepEqual(writes, [['failure', '123456789', 'fixture-local-failure'], ['success', '123456789']]);
});
test('shared revocation, loss of global scope, and deletion apply on the next query', () => {
  for (const extra of [{authInvalid: true}, {isGlobalDefault: false}, {token: ''}]) {
    reset(extra);
    assert.deepEqual(session.candidates('222222222'), []);
  }
  save({});
  assert.deepEqual(session.candidates('222222222'), []);
});
test('non-owner errors remain generic', () => {
  const text = session.formatUserFacingError(new AuthConfigError('fixture-token secret'), {isMaster: false});
  assert.doesNotMatch(text, /fixture-token|secret/);
});
console.log(`CampAuthSession isolation: ${checks} checks passed`);

// AuthStore keeps the old JSON/YAML formats. Exercise its actual new code with
// YAML's real parser and an entirely in-memory filesystem; no live files exist.
const YAML = createRequire(new URL('../engine/package.json', import.meta.url))('yaml');
const storeSource = fs.readFileSync(new URL('../engine/upstream/utils/authStore.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export function isUsableAuth', 'function isUsableAuth')
  .replace('export const authStore = new AuthStore()', 'const authStore = new AuthStore()')
  .replace('export default authStore', 'return authStore');
const dataRoot = path.join(path.dirname(poolFile), 'fixture-in-memory-only');
const jsonFile = path.join(dataRoot, 'AuthPool.json');
const yamlFile = path.join(dataRoot, 'AuthPool.yaml');
const userDataFile = path.join(dataRoot, 'UserData.yaml');
const files = new Map();
const memoryFs = {
  existsSync: file => files.has(file),
  readFileSync: file => { assert.ok(files.has(file)); return files.get(file); },
};
const store = new Function('fs', 'path', 'PluginData', 'readYamlFile', 'writeYamlFile',
  'writeFileAtomic', 'quarantineCorrupt', 'logger', storeSource)(
  memoryFs, path, dataRoot,
  file => YAML.parse(memoryFs.readFileSync(file)),
  (file, value) => files.set(file, YAML.stringify(value)),
  (file, value) => files.set(file, value),
  () => { throw new Error('Valid synthetic legacy data must not be quarantined'); },
  {debug() {}, info() {}, warn() {}},
);
const legacyAccounts = {
  '123456789': account({ownerBotUserId: 'fixture-official-openid', priority: 10,
    userSig: 'fixture-retained-im-key', legacyExtension: {retained: true}}),
  '234567890': account({userId: '234567890', ownerBotUserId: '', priority: 20}),
  '345678901': account({userId: '345678901', isGlobalDefault: false, priority: 1}),
  '456789012': account({userId: '456789012', authInvalid: true, priority: 0}),
};
let storageChecks = 0;
const storageTest = (name, run) => {
  try {run(); storageChecks += 1;} catch (error) {error.message = `${name}: ${error.message}`; throw error;}
};
storageTest('legacy YAML migrates to JSON without losing query, ownership, IM or unknown fields', () => {
  const yaml = YAML.stringify({accounts: legacyAccounts});
  files.set(yamlFile, yaml);
  const pool = store.getPool();
  assert.ok(files.has(jsonFile));
  assert.equal(files.get(yamlFile), yaml);
  assert.equal(pool.accounts['123456789'].token, 'fixture-token');
  assert.equal(pool.accounts['123456789'].ownerBotUserId, 'fixture-official-openid');
  assert.equal(pool.accounts['123456789'].userSig, 'fixture-retained-im-key');
  assert.deepEqual(pool.accounts['123456789'].legacyExtension, {retained: true});
  assert.equal(files.has(userDataFile), false);
});
storageTest('JSON takes precedence over legacy YAML and is freshly read', () => {
  const pool = JSON.parse(files.get(jsonFile));
  pool.accounts['123456789'].token = 'fixture-new-local-token';
  files.set(jsonFile, JSON.stringify(pool));
  assert.equal(store.getAccount('123456789').token, 'fixture-new-local-token');
  assert.equal(YAML.parse(files.get(yamlFile)).accounts['123456789'].token, 'fixture-token');
});
storageTest('global candidate shape and scope are unchanged', () => {
  const candidates = store.getAuthCandidates('777777777');
  assert.deepEqual(candidates.map(candidate => candidate.auth.userId), ['123456789', '234567890']);
  assert.ok(candidates.every(candidate => candidate.source === 'global'));
  assert.deepEqual(store.getAuthCandidates('777777777', {includeGlobal: false}), []);
});
storageTest('opaque official ownership IDs stay exact and orphan visibility is opt-in', () => {
  const ids = accounts => accounts.map(item => item.userId);
  assert.deepEqual(ids(store.listGlobalAccountsByOwner('fixture-official-openid')), ['123456789']);
  assert.deepEqual(ids(store.listGlobalAccountsByOwner('fixture-other-openid')), []);
  assert.deepEqual(ids(store.listGlobalAccountsByOwner('fixture-other-openid', {includeOrphan: true})), ['234567890']);
});
storageTest('old YAML bindings retain opaque owner keys and selection indices', () => {
  files.set(userDataFile, YAML.stringify({'fixture-official-openid': {ids: ['123456789'], current: 0}}));
  store.bindCampUserId('fixture-official-openid', '234567890');
  const binding = YAML.parse(files.get(userDataFile))['fixture-official-openid'];
  assert.deepEqual(binding, {ids: ['123456789', '234567890'], current: 1});
});
storageTest('local success and failure preserve owner and private login fields', () => {
  store.markAuthFailure('123456789', 'fixture local failure');
  assert.equal(store.getAccount('123456789').authInvalid, true);
  assert.equal(store.getAccount('123456789').authErrorCount, 1);
  store.markAuthSuccess('123456789');
  const saved = store.getAccount('123456789');
  assert.equal(saved.authInvalid, false);
  assert.equal(saved.authErrorCount, 0);
  assert.equal(saved.ownerBotUserId, 'fixture-official-openid');
  assert.equal(saved.userSig, 'fixture-retained-im-key');
});
storageTest('Guoba omission preserves global flags and explicit false revokes them', () => {
  store.replaceAccountsFromGuoba(store.getGuobaAccounts().map(({isGlobalDefault, ...item}) => item));
  assert.equal(store.getAccount('123456789').isGlobalDefault, true);
  assert.equal(store.getAccount('345678901').isGlobalDefault, false);
  store.replaceAccountsFromGuoba(store.getGuobaAccounts().map(item =>
    item.userId === '123456789' ? {...item, isGlobalDefault: false} : item));
  assert.equal(store.getAccount('123456789').isGlobalDefault, false);
  assert.equal(store.getAccount('123456789').ownerBotUserId, 'fixture-official-openid');
});
console.log(`AuthStore legacy compatibility: ${storageChecks} checks passed`);
