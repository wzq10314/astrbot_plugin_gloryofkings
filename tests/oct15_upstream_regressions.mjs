// Execute real upstream bodies with synthetic accounts and dependency replacements.
// Usage: node tests/oct15_upstream_regressions.mjs [prepared-plugin-root]
// No real configuration, account pool, network, renderer, or delivery is imported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream'));
let checks = 0;
const test = async (name, run) => {
  try {await run(); checks++;} catch (error) {error.message = `${name}: ${error.message}`; throw error;}
};
globalThis.fetch = async () => {throw Error('Network is forbidden in October 15 fixtures');};
globalThis.logger = {debug() {}, info() {}, warn() {}, error() {}, mark() {}};
globalThis.plugin = class {constructor(options) {Object.assign(this, options);}};
const dependencies = [];
globalThis.__oct15Dependencies = dependencies;
async function load(relative, mocks = {}) {
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (_, clause, quote, specifier) => {
      assert.ok(Object.hasOwn(mocks, specifier), 'Unmocked dependency ' + specifier);
      const binding = `globalThis.__oct15Dependencies[${dependencies.push(mocks[specifier]) - 1}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/);
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const forbidden = () => {throw Error('External or persistent action is forbidden in October 15 fixtures');};
const noActions = new Proxy({}, {get: () => forbidden});

// The actual auth class is evaluated without importing API transport or authStore.
const apiSource = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8');
const classStart = apiSource.indexOf('\nclass CampAuthSession {');
const classEnd = apiSource.indexOf('\nclass CampTransport {', classStart);
assert.ok(classStart >= 0 && classEnd > classStart, 'CampAuthSession boundaries changed');
let pool = [];
const roleIdToCampId = new Map();
const authStore = {
  getAuthCandidates: () => pool,
  listAccounts: () => pool.map(candidate => candidate.auth),
  listGlobalAccountsByOwner: owner => pool.map(candidate => candidate.auth)
    .filter(account => account.ownerBotUserId === owner),
  markAuthFailure: forbidden, markAuthSuccess: forbidden,
};
class AuthConfigError extends Error {}
const toText = value => String(value ?? '').trim();
const CampAuthSession = new Function('authStore', 'Config', 'logger', 'AuthConfigError',
  'toText', 'maskValue', 'maskUserId', 'isUsableAuth', 'DEFAULT_PUBLIC_KEY', 'roleIdToCampId',
  apiSource.slice(classStart, classEnd) + '\nreturn CampAuthSession;')(
  authStore, {getDefOrConfig: () => ({})}, logger, AuthConfigError,
  toText, () => '[masked]', () => '[masked]', auth => Boolean(auth?.token && auth?.userId && auth?.userKey),
  'fixture-unused-key', roleIdToCampId);
const candidate = (id, owner) => ({source: 'global', label: 'Fixture ' + id,
  auth: {userId: id, token: 'fixture-token-' + id, userKey: 'fixture-key-' + id,
    ownerBotUserId: owner, isGlobalDefault: true, priority: 10}});
const threeAccounts = () => [candidate('111', 'owner-1'), candidate('222', 'owner-2'), candidate('333', 'owner-3')];
const ids = (target, requester) => new CampAuthSession().candidates(target, requester).map(item => item.auth.userId);
await test('owner receives the self-exempt target first', () => {
  pool = threeAccounts();
  assert.deepEqual(ids('222', 'owner-2'), ['222', '111', '333']);
});
await test('another requester never receives the target login when another account exists', () => {
  pool = threeAccounts();
  assert.deepEqual(ids('222', 'other-owner'), ['111', '333']);
  assert.equal(ids('outside-pool', 'other-owner').length, 3);
});
await test('single-account behavior remains exactly the upstream compatibility policy', () => {
  pool = [candidate('222', 'owner-2')];
  assert.deepEqual(ids('222', 'other-owner'), ['222']);
});
await test('missing and fake-event requesters retain the upstream internal-call policy', () => {
  pool = threeAccounts();
  for (const requester of ['', undefined, 'undefined', 'null']) {
    assert.deepEqual(ids('222', requester), ['222', '111', '333']);
  }
});
await test('learned role mapping applies ownership to role-ID queries', () => {
  pool = threeAccounts(); roleIdToCampId.set('fixture-role', '222');
  assert.deepEqual(ids('fixture-role', 'owner-2'), ['222', '111', '333']);
  assert.deepEqual(ids('fixture-role', 'other-owner'), ['111', '333']);
});

// Full pushStore source is used; all storage/API dependencies fail if invoked.
const rankTrend = await load('utils/rankTrend.js');
const push = await load('utils/pushStore.js', {
  'node:fs': {default: noActions}, 'path': {default: path},
  './yamlUtils.js': {readYamlFile: forbidden, writeYamlFile: forbidden},
  './safeStore.js': {quarantineCorrupt: forbidden}, './api.js': {default: noActions},
  './cache.js': {default: noActions}, './hotState.js': {hotBox: (_key, initial) => initial},
  './battleArchive.js': {archiveBattles: forbidden}, './rankStore.js': {normalizeName: String},
  './watchMode.js': {isWatchableMode: () => false}, './rankTrend.js': rankTrend,
  './groupIndex.js': {detectLeftGroups: forbidden}, '#components': {PluginData: '/fixture-only'},
});
await test('promotion and demotion report full previous and current rank names', () => {
  assert.equal(push.resolvePrevRankName('至尊星耀I', 25, 26), '至尊星耀II');
  const up = push.formatStarChange({jobFrom: '至尊星耀I', jobTo: '至尊星耀I',
    starFrom: 3, starTo: 0, jobNumFrom: 25, jobNumTo: 26});
  assert.equal(up.text, '至尊星耀II 3星 → 至尊星耀I 0星（升段）');
  assert.equal(up.tone, 'up');
  const down = push.formatStarChange({jobFrom: '至尊星耀II', jobTo: '至尊星耀II',
    starFrom: 0, starTo: 1, jobNumFrom: 26, jobNumTo: 25});
  assert.equal(down.text, '至尊星耀I 0星 → 至尊星耀II 1星（掉段）');
  assert.equal(down.tone, 'down');
});
await test('single-battle promotion is fixed while season jumps remain neutral', () => {
  const item = {roleJobName: '至尊星耀I', roleJob: 26, stars: 1, gameresult: 1};
  assert.equal(push.formatScoreChange(item, {roleJobName: '至尊星耀I', roleJob: 25, stars: 5}).text,
    '至尊星耀II 5星 → 至尊星耀I 1星（升段）');
  const jump = push.formatScoreChange(item, {roleJobName: '至尊星耀I', roleJob: 16, stars: 94});
  assert.equal(jump.text, '至尊星耀I 1星'); assert.equal(jump.tone, 'flat');
  assert.equal(push.resolvePrevRankName('至尊星耀V', 15, 22), '');
});

// Privacy writes are intercepted in memory, including their locked account ID.
const privacy = await load('utils/campPrivacy.js');
let owned = [], apiCalls = [], replies = [];
const privacyMenu = [{className: 'Fixture', privacyItem: [{id: 1, privacyId: 9, name: '我的比赛',
  detailInfo: [{friendTypeId: 5, name: '陌生人', status: 0}]}]}];
const {CampPrivacy} = await load('apps/campPrivacy.js', {
  '../../../lib/puppeteer/puppeteer.js': {default: {screenshot: forbidden}},
  '#utils': {shouldQuote: () => false, getImgType: () => 'png', AT_HEAD: '^', AT_TAIL: '$'},
  '../utils/authStore.js': {default: {listGlobalAccountsByOwner: () => owned,
    getCurrentCampUserId: () => '222', listAccounts: () => owned}},
  '../utils/api.js': {default: {
    async campRequest(...args) {apiCalls.push(['camp', ...args]); return {data: privacyMenu};},
    async gameFormRequest(...args) {apiCalls.push(['form', ...args]); return {data: true};},
    getRoleList: forbidden, formatUserFacingError: String,
  }}, '../utils/campPrivacy.js': privacy,
});
const privacyApp = new CampPrivacy();
const event = (msg, extra = {}) => ({msg, user_id: 'owner-2', isGroup: false,
  reply: async text => {replies.push(text);}, ...extra});
await test('every privacy entry rejects groups before any API or render action', async () => {
  owned = [{userId: '222'}]; apiCalls = [];
  for (const [method, msg] of [['showPrivacy', '#隐私帮助'], ['setPrivacy', '#隐私隐藏 1'],
    ['battleShortcut', '#隐藏我的战绩']]) {
    replies = []; await privacyApp[method](event(msg, {isGroup: true, group_id: 'fixture-group'}));
    assert.deepEqual(replies, ['隐私设置只能私聊我发']);
  }
  assert.deepEqual(apiCalls, []);
});
await test('synthetic privacy command locks reads and writes to the selected owned account', async () => {
  owned = [{userId: '111'}, {userId: '222'}]; apiCalls = []; replies = [];
  await privacyApp.setPrivacy(event('#隐私隐藏 1 陌生人'));
  assert.equal(apiCalls.length, 2);
  assert.deepEqual(apiCalls[0], ['camp', '/user/getprivacymenu', {}, '', '222']);
  assert.deepEqual(apiCalls[1], ['form', '/user/setprivacy', {privacyId: 9, friendTypeId: 5, status: 1}, '', '222']);
  assert.ok(replies.some(reply => String(reply).includes('已设成「隐藏」')));
});
console.log(JSON.stringify({ok: true, checks, isolation: 'Synthetic accounts and intercepted APIs only; no network, real data, or messages'}));
