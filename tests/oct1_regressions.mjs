// Exercise upstream function bodies with in-memory dependencies; never contact services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream'));
const hotState = await import(pathToFileURL(path.join(root, 'utils/hotState.js')).href);
const dependencies = [];
globalThis.__oct1Dependencies = dependencies;
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};
globalThis.fetch = () => {throw Error('Network access is forbidden in this test')};

async function load(relative, mocks) {
  const fallback = new Proxy({}, {get: (_, key) => () => {throw Error(`Unexpected dependency: ${relative}:${String(key)}`)}});
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (statement, clause, quote, specifier) => {
      if ((specifier.startsWith('node:') || specifier === 'path') && !(specifier in mocks)) return statement;
      const index = dependencies.push(mocks[specifier] || (specifier.endsWith('/hotState.js') ? hotState : fallback)) - 1;
      const binding = `globalThis.__oct1Dependencies[${index}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/, 'Add support explicitly if upstream imports change');
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

let checks = 0;
async function test(name, callback) {
  try {await callback(); checks++} catch (error) {error.message = `${name}: ${error.message}`; throw error}
}
const parallel = {mapConcurrent: async (items, fn) => Promise.all(items.map(fn))};
const components = {PluginData: '/fixture/data'};
const ranks = await load('utils/rankStore.js', {'#components': components});
let calls = [], cache = new Map(), cacheWrites = [];
let profile = {data: {targetRoleId: 'selected', roleList: [
  {roleId: 'first', roleName: '其他角色', roleIcon: 'first.png'},
  {roleId: 'selected', roleName: '\uE000\u200B 测试玩家 \u2060', roleIcon: 'camp-avatar.png'}
]}};
let profileError = null;
const identities = await load('utils/roleName.js', {
  '#utils': {
    ApiService: {getProfile: async (...args) => {calls.push(args); if (profileError) throw profileError; return profile}},
    cache: {get: key => cache.get(key), set: (key, value, ttl) => {cache.set(key, value); cacheWrites.push({key, value, ttl})}}
  },
  './rankStore.js': ranks, './parallel.js': parallel
});
await test('identity uses selected game role, strips invisible badges, and returns camp avatar', async () => {
  assert.deepEqual(await identities.fetchRoleIdentities(['777'], 'owner'), {'777': {name: '测试玩家', icon: 'camp-avatar.png'}});
  assert.deepEqual(calls, [['777', 'owner']]);
  assert.equal(cacheWrites[0].ttl, 600);
  assert.equal(ranks.cleanName('\uE000\u200B\u3000'), '');
  assert.equal(ranks.normalizeName('\uE000\u200B'), '无名召唤师');
});
await test('old string caches and old fetchRoleNames callers retain compatibility', async () => {
  cache.set('gok:roleName:888', '旧昵称');
  assert.deepEqual(await identities.fetchRoleIdentities(['888']), {'888': {name: '旧昵称', icon: ''}});
  assert.deepEqual(await identities.fetchRoleNames(['777', '888']), {'777': '测试玩家', '888': '旧昵称'});
  assert.equal(calls.length, 1);
});
await test('empty or failed profiles get short TTL without breaking the batch', async () => {
  profileError = Error('fixture profile failure');
  assert.deepEqual(await identities.fetchRoleIdentities(['999', ''], 123), {'999': {name: '', icon: ''}});
  assert.equal(cacheWrites.at(-1).ttl, 60);
  assert.deepEqual(calls.at(-1), ['999', '123']);
  profileError = null;
});

const allBindings = ['complete', 'new', 'icon', 'empty', 'inactive', 'failed'].map((campId, i) => ({campId, botUserId: String(100 + i), isCurrent: true}));
let identityCalls = [];
const groupStore = await load('utils/groupReportStore.js', {
  '#components': components,
  './parallel.js': parallel,
  './rankStore.js': {getAllBindings: () => allBindings, readSnapshot: () => ({entries: {
    complete: {roleName: '快照名', roleIcon: 'complete.png'}, icon: {roleName: '保留旧昵称'}
  }})},
  './pushStore.js': {loadPushList: () => ({'100': {roleName: '更新的订阅昵称'}})},
  './battleArchive.js': {
    getArchiveRange: () => ({latest: 1}),
    collectBattles: async (campId, owner) => {
      assert.equal(owner, allBindings.find(item => item.campId === campId).botUserId);
      if (campId === 'failed') throw Error('fixture battle failure');
      return {battles: campId === 'inactive' ? [] : [{fixture: campId}], coveredFrom: 1};
    }
  },
  './reportStore.js': {getHeroNameMap: async () => ({}), summarizeReport: battles => ({count: battles.length}), summarizeGroup: members => members},
  './roleName.js': {fetchRoleIdentities: async (ids, owner) => {
    const campId = ids[0]; identityCalls.push({campId, owner});
    if (campId === 'empty') throw Error('fixture private profile');
    return {[campId]: {name: '补查昵称', icon: 'fetched.png'}};
  }}
});
await test('group report fetches identities only for incomplete active members using each owner', async () => {
  const result = await groupStore.collectGroupReport({memberIds: allBindings.map(item => item.botUserId), fromSec: 1});
  assert.deepEqual(identityCalls, [
    {campId: 'new', owner: '101'}, {campId: 'icon', owner: '102'}, {campId: 'empty', owner: '103'}
  ]);
  const members = Object.fromEntries(result.group.map(item => [item.campId, item]));
  assert.equal(members.complete.name, '更新的订阅昵称');
  assert.equal(members.complete.icon, 'complete.png');
  assert.equal(members.new.name, '补查昵称');
  assert.equal(members.new.icon, 'fetched.png');
  assert.equal(members.icon.name, '保留旧昵称');
  assert.equal(members.icon.icon, 'fetched.png');
  assert.equal(members.empty.name, '103');
  assert.equal(result.scanned, 6);
  assert.equal(result.group.length, 4);
});

let ownAccountReads = 0, poolCalls = [], poolError = null;
const {WatchBattle} = await load('apps/watchBattle.js', {
  '#utils': {getImgType: () => 'jpeg', shouldQuote: () => false},
  '#components': {Config: {getDefOrConfig: () => ({})}},
  '../utils/atTarget.js': {AT_HEAD: '', stripAtText: value => value},
  '../utils/authStore.js': {default: {listGlobalAccountsByOwner: () => {ownAccountReads++; return []}}},
  '../utils/api.js': {default: {getTvChoiceItems: async (...args) => {poolCalls.push(args); if (poolError) throw poolError; return {data: {tvChoiceItems: []}}}}},
  '../utils/masterPool.js': {LANES: ['打野'], MODE_NAME: {}, matchLane: value => value === '打野' ? value : '', pickBattles: () => ({picked: [], laneMissed: false})}
});
const battle = new WatchBattle();
const event = () => ({user_id: 'not-logged-in', isMaster: false, messages: [], async reply(message) {this.messages.push(message)}});
await test('master spectating uses public auth pool without requester login', async () => {
  const e = event();
  await battle.master(e, '');
  assert.deepEqual(poolCalls, [[]]);
  assert.equal(ownAccountReads, 0);
  assert.match(e.messages.join('\n'), /现在没有可观战/);
});
await test('missing shared auth and generic pool failure report distinct messages', async () => {
  poolError = Object.assign(Error('missing'), {name: 'AuthConfigError'});
  const noAuth = event(); await battle.master(noAuth, '');
  assert.match(noAuth.messages.join('\n'), /这台机器还没有可用的营地登录态/);
  poolError = Error('fixture failure');
  const unavailable = event(); await battle.master(unavailable, '');
  assert.match(unavailable.messages.join('\n'), /拉不到对局池/);
  assert.doesNotMatch(unavailable.messages.join('\n'), /fixture failure/);
});
await test('unknown lane rejects before consulting public pool', async () => {
  const before = poolCalls.length, e = event();
  await battle.master(e, '未知分路');
  assert.equal(poolCalls.length, before);
  assert.match(e.messages.join('\n'), /分路认不出/);
});

for (const [filename, className, service, directory] of [
  ['watchDeploy.js', 'WatchDeploy', 'gok-watch', 'server'],
  ['campImDeploy.js', 'CampImDeploy', 'gok-im', 'server-im']
]) {
  const pluginPath = '/fixture/plugins/GloryOfKings-Plugin';
  const serverDir = path.join(pluginPath, directory);
  const own = {name: service, pm2_env: {pm_cwd: serverDir, status: 'online', pm_uptime: 1}};
  let running = own, outside = null, mutations = [], installs = 0;
  const deploy = await load(`apps/${filename}`, {
    'node:fs': {default: {existsSync: value => !String(value).endsWith('.git')}},
    '#components': {PluginPath: pluginPath, PluginName: 'fixture', Config: {getDefOrConfig: () => ({distUrl: 'https://fixture.invalid', distToken: 'fixture-token'})}},
    '#utils': {shouldQuote: () => false},
    '../utils/pm2.js': {
      pm2Proc: name => {assert.equal(name, service); return running},
      pm2ForeignProc: name => {assert.equal(name, service); return outside},
      launcherInfo: () => ({kind: 'pm2', isolated: true, pm2Home: '/fixture/pm2'}),
      isOurProcess: (proc, dir) => proc?.pm2_env?.pm_cwd === dir,
      resetPm2Cache: () => {},
      pm2: (args, opts) => {mutations.push({args, opts}); return {ok: true}}
    },
    '../utils/dependency.js': {ensureDependencies: async () => ({ok: true, ffmpeg: '/fixture/ffmpeg'})},
    '../utils/deploy.js': {
      normalizeBase: value => value, STATE_FILE: '.fixture-state',
      installPackage: async () => {installs++; return {ok: true, sha: 'fixture', updated: true}},
      fmtUptime: () => '1分钟', probeStatus: async () => ({ffmpeg: true, clients: []}), waitStatus: async () => ({ffmpeg: true, clients: []}),
      probeControlPort: async () => ({ffmpeg: true, clients: []}), waitControlPort: async () => ({ffmpeg: true, clients: []})
    }
  });
  globalThis.gok = {call: async (method, args) => {assert.equal(method, 'server_dependencies'); assert.equal(args.directory, serverDir); return {ok: true}}};
  const app = new deploy[className]();
  await test(`${service}: status preserves the running process`, async () => {
    await app.status(event());
    assert.equal(mutations.length, 0);
    assert.equal(installs, 0);
  });
  await test(`${service}: updating existing service restarts in place and never deletes`, async () => {
    await app.deploy(event());
    assert.equal(installs, 1);
    assert.deepEqual(mutations.map(item => item.args), [['restart', service, '--update-env'], ['save']]);
    mutations = [];
  });
  await test(`${service}: foreign old service is reported without stopping or installing`, async () => {
    running = null; outside = own;
    const e = event(); await app.status(e); await app.deploy(e);
    assert.equal(mutations.length, 0);
    assert.equal(installs, 1);
    assert.match(e.messages.join('\n'), /旧.*进程/);
  });
  await test(`${service}: unrelated same-name service is never modified`, async () => {
    running = {name: service, pm2_env: {pm_cwd: '/someone-else'}}; outside = null;
    const e = event(); await app.deploy(e);
    assert.equal(mutations.length, 0);
    assert.equal(installs, 1);
    assert.match(e.messages.join('\n'), /没有动它/);
  });
}
console.log(`October upstream regressions: ${checks} checks passed`);
