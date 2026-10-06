// Run real upstream membership/subscription code with in-memory stores and no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream');
const hotState = await import(pathToFileURL(path.join(root, 'utils/hotState.js')).href);
const dependencies = [];
globalThis.__leftGroupTestDependencies = dependencies;
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};
globalThis.fetch = () => {throw Error('Network access is forbidden in this test')};

// Replace imports only, leaving every upstream function body intact. Unused imports
// throw if accidentally exercised, so the fixtures cannot silently reach an API.
async function load(relative, mocks) {
  const fallback = new Proxy({}, {get: (_, key) => () => {throw Error(`Unexpected dependency: ${relative}:${String(key)}`)}});
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (statement, clause, quote, specifier) => {
      if ((specifier.startsWith('node:') || specifier === 'path') && !(specifier in mocks)) return statement;
      const index = dependencies.push(mocks[specifier] || (specifier.endsWith('/hotState.js') ? hotState : fallback)) - 1;
      const binding = `globalThis.__leftGroupTestDependencies[${index}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/, 'Add support explicitly if upstream imports change');
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

let checks = 0;
function test(name, callback) {
  callback();
  checks++;
}
let document = {pushList: {}}, stamp = 0n, writes = 0;
const yaml = {
  readYamlFile: () => structuredClone(document),
  writeYamlFile: (filename, value) => {document = structuredClone(value); stamp++; writes++}
};
const components = {PluginData: '/in-memory-gok-test', Config: {getDefOrConfig: () => ({onlineReminder: true, battleResultCron: ''})}};
const groups = await load('utils/groupIndex.js', {'./yamlUtils.js': yaml, '#components': components});
const store = await load('utils/pushStore.js', {
  'node:fs': {default: {statSync: () => ({mtimeNs: stamp, size: BigInt(JSON.stringify(document).length)})}},
  './yamlUtils.js': yaml,
  './groupIndex.js': groups,
  '#components': components
});
const setMembers = entries => {globalThis.Bot = {gml: new Map(entries)}};
const member = id => [id, {user_id: id}];
const entry = (qq = '12345001', targets = ['98765001']) => [{qq, groups: targets}];
const sub = extra => ({campId: '77777001', groups: ['98765001'], group: '98765001', battle: true, ...extra});
function seed(list) {store.savePushList(list); writes = 0}

test('missing bot never marks anyone as departed', () => {
  delete globalThis.Bot;
  assert.deepEqual(groups.detectLeftGroups(entry()), {ok: false, gone: {}, reason: 'no-bot'});
});
test('throwing cache getter is unknown', () => {
  globalThis.Bot = {get gml() {throw Error('Not connected')}};
  assert.equal(groups.detectLeftGroups(entry()).ok, false);
});
test('empty outer cache is unknown', () => {
  setMembers([]);
  assert.equal(groups.detectLeftGroups(entry()).ok, false);
});
test('empty group cache cannot clear a whole group', () => {
  setMembers([[98765001, new Map()]]);
  assert.deepEqual(groups.detectLeftGroups(entry()), {ok: false, gone: {}, reason: 'no-member-cache'});
});
test('unrelated cached group does not prove membership', () => {
  setMembers([[98765002, new Map([member(12345002)])]]);
  assert.equal(groups.detectLeftGroups(entry()).ok, false);
});
test('numeric and string IDs both match', () => {
  setMembers([[98765001, new Map([member('12345001')])], ['98765002', new Map([member(12345001)])]]);
  assert.deepEqual(groups.detectLeftGroups(entry(12345001, [98765001, '98765002'])), {ok: true, gone: {}});
});
test('only known nonempty missing membership counts as departed', () => {
  setMembers([[98765001, new Map([member(12345002)])], [98765002, new Map([member(12345001)])], [98765003, new Map()]]);
  assert.deepEqual(groups.detectLeftGroups(entry('12345001', ['98765001', '98765002', '98765003', '98765004'])),
    {ok: true, gone: {'12345001': ['98765001']}});
});
test('cache getter is read once for a batch', () => {
  let reads = 0;
  globalThis.Bot = {get gml() {reads++; return new Map([[98765001, new Map([member(12345001)])]])}};
  groups.detectLeftGroups([...entry(), ...entry('12345002')]);
  assert.equal(reads, 1);
});
test('remove one group and preserve flags and state for the other group', () => {
  const table = {'12345001': sub({groups: ['98765001', '98765002'], daily: true, lastGameSeq: 'fixture-seq'})};
  seed(table);
  assert.deepEqual(store.dropLeftGroups({'12345001': ['98765001']}, table), {cleared: 1, stopped: 0});
  assert.deepEqual(table['12345001'], sub({group: '98765002', groups: ['98765002'], daily: true, lastGameSeq: 'fixture-seq'}));
  assert.deepEqual(store.loadPushList(), table);
  assert.equal(writes, 1);
  assert.deepEqual(store.dropLeftGroups({'12345001': ['98765001']}, table), {cleared: 0, stopped: 0});
  assert.equal(writes, 1, 'idempotent calls must not write again');
});
test('all groups departed removes subscription, including all five push flags', () => {
  const table = {'12345001': sub({online: true, daily: true, weekly: true, monthly: true})};
  seed(table);
  assert.deepEqual(store.dropLeftGroups({'12345001': ['98765001']}, table), {cleared: 1, stopped: 1});
  assert.deepEqual(table, {});
  assert.deepEqual(store.loadPushList(), {});
});
test('optedOut privacy marker survives departure from all groups', () => {
  const table = {'12345001': sub({optedOut: true, daily: true})};
  seed(table);
  assert.deepEqual(store.dropLeftGroups({'12345001': ['98765001']}, table), {cleared: 1, stopped: 0});
  assert.deepEqual(table, {'12345001': {optedOut: true}});
  assert.deepEqual(store.loadPushList(), table);
});
test('legacy singular group remains compatible', () => {
  const table = {'12345001': {group: '98765001', daily: true}};
  seed(table);
  assert.deepEqual(store.dropLeftGroups({'12345001': ['98765001']}), {cleared: 1, stopped: 1});
  assert.deepEqual(store.loadPushList(), {});
});
test('unknown subscriptions and unrelated departures do not write', () => {
  const table = {'12345001': sub()};
  seed(table);
  assert.deepEqual(store.dropLeftGroups({'12345002': ['98765001'], '12345001': ['98765002']}, table), {cleared: 0, stopped: 0});
  assert.equal(writes, 0);
});
test('batch sweep changes and writes once, keeping present subscriptions', () => {
  setMembers([[98765001, new Map([member(12345003)])], [98765002, new Map([member(12345001)])]]);
  const table = {'12345001': sub({groups: ['98765001', '98765002']}), '12345002': sub(), '12345003': sub()};
  seed(table);
  assert.deepEqual(store.sweepLeftGroups(table), {cleared: 2, stopped: 1, ok: true});
  assert.equal(writes, 1);
  assert.deepEqual(table['12345001'].groups, ['98765002']);
  assert.equal(table['12345002'], undefined);
  assert.deepEqual(table['12345003'], sub());
  assert.deepEqual(store.loadPushList(), table);
});
test('unknown cache sweep preserves stored subscriptions', () => {
  setMembers([[98765001, new Map()]]);
  const table = {'12345001': sub()};
  seed(table);
  assert.deepEqual(store.sweepLeftGroups(table), {cleared: 0, stopped: 0, ok: false});
  assert.deepEqual(store.loadPushList(), table);
  assert.equal(writes, 0);
});

let trace = [];
const wrappedStore = {
  ...store,
  loadPushList: () => {trace.push('load'); return store.loadPushList()},
  sweepLeftGroups: list => {trace.push('sweep'); return store.sweepLeftGroups(list)},
  sleep: async () => {},
  getHeroNameMap: async () => ({})
};
const common = {
  '../utils/pushStore.js': wrappedStore,
  '#components': components,
  '#utils': {AT_HEAD: '', isBlackUser: () => false, ApiService: {hasNoAvailableAccount: () => false, lastRateLimitAt: () => 0}},
  '../utils/reportStore.js': {isMonthlyPushDay: () => true}
};
const {BattleReport} = await load('apps/battleReport.js', common);
const {GameRecordPush} = await load('apps/gameRecordPush.js', common);
const reports = new BattleReport();
const game = new GameRecordPush();
assert.equal(game.task.cron, '', 'report cleanup must not depend on battle polling being enabled');

for (const kind of ['daily', 'weekly', 'monthly']) {
  seed({'12345001': sub({[kind]: true})});
  setMembers([[98765001, new Map([member(12345002)])]]);
  trace = [];
  reports.pushOne = async () => {throw Error('Departed user must not be selected')};
  await reports.task[['daily', 'weekly', 'monthly'].indexOf(kind)].fnc();
  assert.deepEqual(trace, ['load', 'sweep']);
  assert.deepEqual(store.loadPushList(), {});
  checks++;
}

seed({'12345001': sub({daily: true, groups: ['98765001', '98765002']})});
setMembers([[98765001, new Map([member(12345002)])], [98765002, new Map([member(12345001)])]]);
trace = [];
let delivered = [];
reports.pushOne = async (qq, subscription, kind) => delivered.push({qq, groups: store.subGroups(subscription), kind});
await reports.pushAll('daily');
assert.deepEqual(trace, ['load', 'sweep']);
assert.deepEqual(delivered, [{qq: '12345001', groups: ['98765002'], kind: 'daily'}]);
checks++;

seed({'12345001': sub()});
setMembers([[98765001, new Map([member(12345002)])]]);
trace = [];
game.checkOne = async () => {throw Error('Departed user must not be queried')};
await game.checkAll();
assert.deepEqual(trace, ['load', 'sweep']);
assert.deepEqual(store.loadPushList(), {});
checks++;

seed({'12345001': sub({groups: ['98765001', '98765002']})});
setMembers([[98765001, new Map([member(12345002)])], [98765002, new Map([member(12345001)])]]);
trace = [];
delivered = [];
game.checkOne = async (qq, subscription) => delivered.push({qq, groups: store.subGroups(subscription)});
await game.checkAll();
assert.deepEqual(trace, ['load', 'sweep']);
assert.deepEqual(delivered, [{qq: '12345001', groups: ['98765002']}]);
checks++;

console.log(`Upstream membership and five push-path cleanup: ${checks} cases passed (no network or accounts)`);
