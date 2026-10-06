// Execute real upstream methods with in-memory fixtures only: no accounts, network, or messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream'));
const hotState = await import(pathToFileURL(path.join(root, 'utils/hotState.js')).href);
const dependencies = [];
globalThis.__oct4Dependencies = dependencies;
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};

// Replace imports, preserving upstream function bodies and their HTTP serialization.
async function load(relative, mocks) {
  const fallback = new Proxy({}, {get: (_, key) => () => {throw Error(`Unexpected dependency: ${relative}:${String(key)}`)}});
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (statement, clause, quote, specifier) => {
      if ((specifier.startsWith('node:') || specifier === 'path') && !(specifier in mocks)) return statement;
      const index = dependencies.push(mocks[specifier] || (specifier.endsWith('/hotState.js') ? hotState : fallback)) - 1;
      const binding = `globalThis.__oct4Dependencies[${index}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/, 'Add support explicitly if upstream imports change');
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

const base = 'http://fixture.invalid';
let expectedRequests = [], requests = [], unexpectedRequests = [], remoteReports = [];
globalThis.fetch = async (url, options) => {
  const request = {url, method: options.method, body: options.body ? JSON.parse(options.body) : null};
  requests.push(request);
  const expected = expectedRequests.shift();
  try {
    assert.ok(expected, `Unexpected request: ${url}`);
    assert.equal(url, base + expected.path);
    assert.equal(options.method, expected.method || 'GET');
    assert.ok(options.signal instanceof AbortSignal);
    if (expected.body) assert.deepEqual(request.body, expected.body);
  } catch (error) {
    unexpectedRequests.push(error.message);
    throw error;
  }
  if (expected.error) throw expected.error;
  return {status: 200, text: async () => expected.text ?? JSON.stringify(expected.response)};
};
// An upstream timer must never start unattended background work in this harness.
globalThis.setInterval = () => {throw Error('Background polling is forbidden in this test')};

let checks = 0, list = {}, patches = [], delivered = [], sendOk = true, latest = null, latestCalls = [];
async function test(name, callback) {
  expectedRequests = []; requests = []; unexpectedRequests = []; remoteReports = [];
  list = {}; patches = []; delivered = []; sendOk = true; latest = null; latestCalls = [];
  try {
    await callback();
    assert.deepEqual(unexpectedRequests, [], 'Caught HTTP fixture errors must not be silently swallowed');
    assert.equal(expectedRequests.length, 0, 'All expected requests must have been made');
    checks++;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
const components = {Config: {getDefOrConfig: () => ({watchApiUrl: base, watchHintAfterMin: 3})}};
const {GameRecordPush} = await load('apps/gameRecordPush.js', {
  '#components': components,
  '#utils': {isBlackUser: () => false},
  '../utils/pushStore.js': {
    loadPushList: () => list,
    subGroups: sub => sub.groups || [],
    isFlagOn: (sub, key) => sub[key] === true,
    mergeSubState: (qq, patch) => {patches.push({qq, patch: structuredClone(patch)}); Object.assign(list[qq] || {}, patch)},
    fetchLatest: async (...args) => {latestCalls.push(args); return latest},
    decideHint: (data, afterMin) => {
      assert.equal(afterMin, 3);
      assert.equal(data, latest);
      return {action: 'hint', minutes: 4};
    }
  }
});
const game = new GameRecordPush();
game.send = async (qq, sub, text) => {delivered.push({qq, groups: [...sub.groups], text}); return sendOk};
game.resolveDisplayName = async () => '群名片';
const {WatchBattle} = await load('apps/watchBattle.js', {
  '#components': components,
  '#utils': {shouldQuote: () => false},
  '../utils/atTarget.js': {AT_HEAD: ''},
  '../utils/quoted.js': {readQuoted: async () => null},
  '../utils/remoteAccounts.js': {reportRemoteAccounts: async url => {assert.equal(url, base); remoteReports.push(url)}}
});
const watch = new WatchBattle();
const record = () => ({campId: 777, battleId: 'battle-777', watcher: 'owner-a', owners: ['owner-a', 'owner-b'], userId: 1234, roleId: 'role-777', nick: '游戏昵称'});
const subscription = () => ({campId: '777', roleName: '订阅昵称', groups: ['group-a', 'group-b'], online: true, lastGaming: '1', lastGamingStart: 'start-777'});
const gaming = () => ({battleId: 'battle-777', dtEventTime: 'start-777'});
const friendResponse = item => ({ok: true, friendCampIds: ['777'], playing: item ? [item] : []});
const remember = (groupId, extra = {}) => ({groupId, battleID: 'battle-777', campId: '777', nick: '订阅昵称', watcher: 'owner-a', owners: ['owner-a', 'owner-b'], userID: 1234, roleId: 'role-777', ...extra});
function expectRemember(body) {expectedRequests.push({path: '/api/hint/remember', method: 'POST', body, response: {ok: true}})}
function expectFriends(response) {expectedRequests.push({path: '/api/friends', response})}

await test('findFriend captures the complete matching record with numeric campId', async () => {
  const item = record();
  expectFriends({...friendResponse(item), playing: [{...item, campId: 'other'}, item]});
  assert.deepEqual(await game.findFriend(777), {record: item});
  assert.equal(requests.length, 1, 'Coordinates must reuse the existing friends request');
});
await test('known friend not currently playing returns a null record, not false', async () => {
  expectFriends(friendResponse(null));
  assert.deepEqual(await game.findFriend('777'), {record: null});
});
await test('empty campId returns false without a request', async () => {
  assert.equal(await game.findFriend(''), false);
  assert.equal(requests.length, 0);
});
await test('definite nonfriend returns false', async () => {
  expectFriends({ok: true, friendCampIds: ['888'], playing: []});
  assert.equal(await game.findFriend('777'), false);
});
await test('service failure is unknown, not a nonfriend', async () => {
  expectFriends({ok: false});
  assert.equal(await game.findFriend('777'), null);
});
await test('transport failure is unknown, not a nonfriend', async () => {
  expectedRequests.push({path: '/api/friends', error: Error('fixture unavailable')});
  assert.equal(await game.findFriend('777'), null);
});
await test('malformed service response is unknown, not a nonfriend', async () => {
  expectedRequests.push({path: '/api/friends', text: 'not json'});
  assert.equal(await game.findFriend('777'), null);
});
await test('sendHint stores all coordinates for every subscribed group and prefers live battle ID', async () => {
  for (const gid of subscription().groups) expectRemember(remember(gid));
  // This existing assertion covers the stored-name fallback. Live-name priority
  // is checked below using the upstream's October 5 behavior.
  assert.equal(await game.sendHint('user-1', subscription(), gaming(), 4, {...record(), nick: '', battleId: 'stale-battle'}), true);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /订阅昵称 已经开局 4 分钟/);
});
await test('sendHint falls back to record battle ID and normalizes coordinate types', async () => {
  expectRemember(remember('group-a', {watcher: '91', owners: ['91', '92'], roleId: '900'}));
  assert.equal(await game.sendHint('user-1', {...subscription(), groups: ['group-a']}, {}, 4,
    {...record(), nick: '', watcher: 91, owners: [91, 92], userId: '1234', roleId: 900}), true);
});
for (const [field, name] of [['nick', '游戏昵称'], ['campNick', '营地昵称']]) {
  await test(`sendHint prefers current ${field}, persists it, and uses it for remembered coordinates`, async () => {
    const coord = {...record(), nick: '', [field]: name};
    for (const gid of subscription().groups) expectRemember(remember(gid, {nick: name}));
    assert.equal(await game.sendHint('user-1', subscription(), gaming(), 4, coord), true);
    assert.match(delivered[0].text, new RegExp(`${name} 已经开局 4 分钟`));
    assert.deepEqual(patches, [{qq: 'user-1', patch: {roleName: name}}]);
  });
}
await test('missing coordinates remain compatible and use the resolved display name', async () => {
  const sub = {...subscription(), roleName: '', groups: ['group-a']};
  expectRemember(remember('group-a', {nick: '群名片', watcher: '', owners: [], userID: 0, roleId: ''}));
  assert.equal(await game.sendHint('user-1', sub, gaming(), 4), true);
});
await test('failed hint delivery does not store a hint', async () => {
  sendOk = false;
  assert.equal(await game.sendHint('user-1', subscription(), gaming(), 4, record()), false);
  assert.equal(requests.length, 0);
});

// Both the active shared-data path and retained short-poll path must pass coordinates.
for (const method of ['checkHint', 'hintTick']) {
  async function run() {
    if (method === 'checkHint') await game.checkHint('user-1', list['user-1'], latest);
    else await game.hintTick();
  }
  function seed() {
    list = {'user-1': subscription()};
    latest = {isGaming: true, gaming: gaming()};
  }
  await test(`${method} carries friend coordinates through to persisted hints`, async () => {
    seed(); expectFriends(friendResponse({...record(), nick: ''}));
    for (const gid of subscription().groups) expectRemember(remember(gid));
    await run();
    assert.equal(delivered.length, 1);
    assert.equal(list['user-1'].hintGamingStart, 'start-777');
    assert.equal(requests.length, 3);
    assert.deepEqual(latestCalls, method === 'hintTick' ? [['777', 'user-1']] : []);
    if (method === 'hintTick') assert.equal(list['user-1'].hintWatching, '');
  });
  await test(`${method} suppresses definite nonfriends and finishes that battle`, async () => {
    seed(); expectFriends({ok: true, friendCampIds: [], playing: []});
    await run();
    assert.equal(delivered.length, 0);
    assert.equal(list['user-1'].hintGamingStart, 'start-777');
    if (method === 'hintTick') assert.equal(list['user-1'].hintWatching, '');
  });
  await test(`${method} still sends when friend lookup is unknown`, async () => {
    seed(); expectFriends({ok: false});
    for (const gid of subscription().groups) expectRemember(remember(gid, {watcher: '', owners: [], userID: 0, roleId: ''}));
    await run();
    assert.equal(delivered.length, 1);
    assert.equal(list['user-1'].hintGamingStart, 'start-777');
  });
  await test(`${method} preserves retry eligibility after failed delivery`, async () => {
    seed(); sendOk = false; expectFriends(friendResponse(record()));
    await run();
    assert.equal(delivered.length, 1);
    assert.equal(list['user-1'].hintGamingStart, undefined);
    if (method === 'hintTick') assert.equal(list['user-1'].hintWatching, '1');
  });
}

const event = () => ({isGroup: true, group_id: 'group / a', user_id: 55, messages: [], async reply(text) {this.messages.push(text)}});
function expectHint(hint) {expectedRequests.push({path: '/api/hint/latest?group=group%20%2F%20a', response: {ok: true, hint}})}
function expectRecheck(scope, playing) {expectedRequests.push({path: '/api/friends' + (scope ? `?watchers=${encodeURIComponent(scope)}` : ''), response: {ok: true, playing}})}
function expectStart(body) {expectedRequests.push({path: '/api/start', method: 'POST', body, response: {ok: true, url: '/r/fixture/'}})}
const hint = () => ({battleID: 'battle-777', watcher: 'hint-watcher', owners: ['owner-a', 'owner-b'], nick: '提示昵称'});
const startBody = (extra = {}) => ({watcher: 'owner-a', owners: ['owner-a', 'owner-b'], battleID: 'battle-777', userID: 1234, roleId: 'role-777', owner: '55', nick: '游戏昵称', ...extra});

await test('startHinted scopes recheck to hint owners and starts with fresh coordinates', async () => {
  expectHint(hint()); expectRecheck('owner-a,owner-b', [record()]); expectStart(startBody());
  const e = event(); await watch.startHinted(e);
  assert.match(e.messages[0], /游戏昵称/);
  assert.equal(remoteReports.length, 3);
  assert.ok(requests.every(request => !request.url.includes('refresh=')), 'Recheck must preserve the server cache');
});
await test('startHinted uses watcher when owners are empty and encodes the scope', async () => {
  const old = {...hint(), owners: [], watcher: 'owner / special'};
  expectHint(old); expectRecheck('owner / special', [record()]); expectStart(startBody());
  await watch.startHinted(event());
});
await test('legacy hint without scope rechecks once to recover required user and role IDs', async () => {
  expectHint({battleID: 'battle-777', campId: '777', userID: 0, roleId: '', watcher: '', owners: []});
  expectRecheck('', [record()]); expectStart(startBody());
  await watch.startHinted(event());
  assert.equal(requests.filter(request => request.url === base + '/api/friends').length, 1);
});
await test('startHinted refuses a changed battle instead of starting the next match', async () => {
  expectHint(hint()); expectRecheck('owner-a,owner-b', [{...record(), battleId: 'next-battle'}]);
  const e = event(); await watch.startHinted(e);
  assert.match(e.messages.join('\n'), /这一局已经打完了/);
  assert.equal(requests.length, 2);
});
await test('startHinted falls back to camp nickname before saved hint nickname', async () => {
  expectHint(hint()); expectRecheck('owner-a,owner-b', [{...record(), nick: '', campNick: '营地昵称'}]);
  expectStart(startBody({nick: '营地昵称'}));
  await watch.startHinted(event());
});
await test('startHinted retains saved nickname and account coordinates if recheck omits them', async () => {
  const fresh = record(); delete fresh.watcher; delete fresh.owners; delete fresh.nick;
  expectHint(hint()); expectRecheck('owner-a,owner-b', [fresh]);
  expectStart(startBody({watcher: 'hint-watcher', nick: '提示昵称'}));
  const e = event(); await watch.startHinted(e);
  assert.match(e.messages[0], /提示昵称/);
});

console.log(`October 4 upstream coordinate and hint regressions: ${checks} checks passed (no network, accounts, or real messages)`);
