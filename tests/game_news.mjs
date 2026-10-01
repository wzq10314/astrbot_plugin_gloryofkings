// Exercise real announcement modules with in-memory API, cache, stores and delivery.
// No account, browser, network request or real message is used by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream');
const dependencies = [];
globalThis.__gameNewsTestDependencies = dependencies;
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};
globalThis.fetch = () => {throw Error('Network access is forbidden in this test')};

// Keep upstream function bodies intact. Unexpected imports fail rather than
// silently accessing a live API or the persistent subscription store.
async function load(relative, mocks) {
  const fallback = new Proxy({}, {get: (_, key) => () => {throw Error(`Unexpected dependency: ${relative}:${String(key)}`)}});
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (statement, clause, quote, specifier) => {
      if ((specifier.startsWith('node:') || specifier === 'path') && !(specifier in mocks)) return statement;
      const index = dependencies.push(mocks[specifier] || fallback) - 1;
      const binding = `globalThis.__gameNewsTestDependencies[${index}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/, 'Add support explicitly if upstream imports change');
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

let checks = 0;
async function test(name, callback) {
  try {await callback()} catch (error) {error.message = `${name}: ${error.message}`; throw error}
  checks++;
}

const cacheValues = new Map();
let cacheWrites, document, writes, rawItems, listCalls, detailCalls, body, detailError;
let renders, forwards, replies, sends, groupTargets, renderImpl;
const raw = (id, time, extra = {}) => ({
  iId: id, sTitle: `正式服公告 ${id}`, sIdxTime: time,
  sTagInfo: '100|官方公告', sIMG: '//example.invalid/cover.jpg', ...extra
});
const oldTime = '2026-09-28 16:44:00';
const newTime = '2026-09-29 17:00:00';
const timestamp = time => Date.parse(time.replace(' ', 'T'));
const imageBody = count => Array.from({length: count}, (_, i) => `<img src="//example.invalid/${i}.jpg">`).join('');
function reset({subscribed = false, watermark = 0, images = 1} = {}) {
  cacheValues.clear();
  cacheWrites = [];
  document = {pushList: subscribed ? {'10001': {enabled: true}} : {}, pushed: [], watermark};
  writes = 0;
  rawItems = [raw('new', newTime)];
  listCalls = [];
  detailCalls = [];
  body = imageBody(images);
  detailError = null;
  renders = [];
  forwards = [];
  replies = [];
  sends = [];
  groupTargets = new Map([['10001', {sendMsg: async message => {sends.push(message); return {message_id: 'fixture'}}}]]);
  renderImpl = (_, data) => ({type: 'image', file: Buffer.from(`page-${data.pageNo}`)});
}

const news = await load('utils/gameNews.js', {
  '#utils': {
    ApiService: {
      getPvpNewsList: async options => {listCalls.push(options); return {items: structuredClone(rawItems)}},
      getPvpNewsDetail: async id => {
        detailCalls.push(id);
        if (detailError) throw detailError;
        return {title: '正式服更新公告正文', time: newTime, content: body};
      }
    },
    cache: {
      get: key => cacheValues.get(key),
      set: (key, value, ttl) => {cacheValues.set(key, value); cacheWrites.push({key, ttl})}
    },
    readYamlFile: () => structuredClone(document),
    writeYamlFile: (filename, value) => {document = structuredClone(value); writes++}
  },
  './safeStore.js': {quarantineCorrupt: () => {throw Error('Unexpected corrupt-store fixture')}},
  '#components': {PluginData: '/in-memory-game-news-test'}
});

const {GameNews} = await load('apps/gameNews.js', {
  '../../../lib/puppeteer/puppeteer.js': {default: {
    screenshot: async (template, data) => {renders.push({template, data}); return renderImpl(template, data)}
  }},
  '../../../lib/common/common.js': {default: {
    makeForwardMsg: async (event, images, title) => {
      const message = {type: 'forward', rows: images.map(message => ({message}))};
      forwards.push({event, message, title});
      return message;
    }
  }},
  '#utils': {
    getImgType: () => 'png', shouldQuote: () => false,
    Button: {gameNews: subscribed => ({type: 'button', subscribed})},
    pickGroupSafe: id => groupTargets.get(String(id))
  },
  '#components': {Config: {getDefOrConfig: () => ({gameNewsCron: '0 */10 * * * *'})}},
  '../utils/gameNews.js': news
});
const app = new GameNews();
const event = () => ({group_id: 10001, reply: async (message, quote) => {replies.push({message, quote})}});

await test('official announcements exclude trial-server titles and tags; pinned items lead', async () => {
  reset();
  rawItems = [
    raw('later', newTime),
    raw('trial-title', newTime, {sTitle: '体验服不停机更新公告'}),
    raw('trial-tag', newTime, {sTagInfo: '100|官方公告,101|体验服专区'}),
    raw('ordinary-news', newTime, {sTitle: '比赛精彩回顾', sTagInfo: '102|赛事'}),
    raw('pinned', oldTime, {iTopPos: 1, sTitle: '正式服版本更新公告'}),
    raw('fallback', oldTime, {sTagInfo: '', sTitle: '停机更新公告'})
  ];
  const list = await news.getNewsList();
  assert.deepEqual(list.map(item => item.id), ['pinned', 'later', 'fallback']);
  assert.equal(list[0].category, '版本更新');
  assert.equal(list[0].cover, 'https://example.invalid/cover.jpg');
  assert.equal(list[0].timeText, '09-28 16:44');
  assert.deepEqual(listCalls, [{chanid: 1762, limit: 40}]);
});

await test('list cache separates request limits and records a ten-minute TTL', async () => {
  reset();
  const first = await news.getNewsList();
  assert.deepEqual(await news.getNewsList(), first);
  assert.equal(listCalls.length, 1);
  await news.getNewsList(12);
  assert.deepEqual(listCalls, [{chanid: 1762, limit: 40}, {chanid: 1762, limit: 12}]);
  assert.deepEqual(cacheWrites, [{key: 'gok:gameNews:1762:40', ttl: 600}, {key: 'gok:gameNews:1762:12', ttl: 600}]);
});

await test('first subscription establishes newest timestamp without rendering or sending history', async () => {
  reset();
  rawItems = [raw('pinned-old', oldTime, {iTopPos: 1}), raw('latest', newTime)];
  assert.deepEqual(news.setGameNewsSub(10001, true, {operator: '20001'}), {changed: true});
  await app.pushAll();
  assert.equal(document.watermark, timestamp(newTime), 'the older pinned item must not set the watermark');
  assert.deepEqual(document.pushed, []);
  assert.deepEqual(detailCalls, []);
  assert.deepEqual(renders, []);
  assert.deepEqual(sends, []);
  const saved = writes;
  await app.pushAll();
  assert.equal(writes, saved);
  assert.deepEqual(sends, []);
});

await test('collection does not commit; successful commit excludes duplicates and older items', async () => {
  reset({subscribed: true, watermark: timestamp(oldTime)});
  rawItems = [raw('old', oldTime), raw('already-pushed', newTime), raw('new', newTime)];
  document.pushed = ['already-pushed'];
  const result = await news.collectGameNews();
  assert.equal(result.firstRun, false);
  assert.deepEqual(result.items.map(item => item.id), ['new']);
  assert.equal(document.watermark, timestamp(oldTime));
  assert.equal(writes, 0);
  news.markGameNewsPushed(result.store, result.items);
  assert.equal(document.watermark, timestamp(newTime));
  assert.deepEqual(document.pushed, ['already-pushed', 'new']);
  assert.deepEqual((await news.collectGameNews()).items, []);
});

await test('repeated subscription changes are idempotent and disabling removes the group', () => {
  reset();
  assert.equal(news.setGameNewsSub(10001, true).changed, true);
  assert.equal(news.setGameNewsSub('10001', true).changed, false);
  assert.equal(news.setGameNewsSub(10001, false).changed, true);
  assert.equal(news.setGameNewsSub(10001, false).changed, false);
  assert.deepEqual(document.pushList, {});
  assert.equal(writes, 2);
});

await test('content cleanup retains image sources and text while removing scripts and inline styling', () => {
  const result = news.sanitizeNewsContent('<script>bad()</script><style>bad{}</style><p style="color:black"><span>伤害 &rarr; 增加</span><img src="//example.invalid/a.jpg" onerror="bad()"></p>');
  assert.equal(result.html, '<p>伤害 → 增加<img src="https://example.invalid/a.jpg"></p>');
  assert.equal(result.imageCount, 1);
  assert.equal(result.textLength, '伤害 → 增加'.length);
});

await test('seventeen images paginate as 8/8/1 without losing or reordering content', () => {
  const clean = news.sanitizeNewsContent(imageBody(17));
  const result = news.paginateNewsContent(clean.html);
  assert.deepEqual(result.pages.map(page => (page.match(/<img\b/g) || []).length), [8, 8, 1]);
  assert.equal(result.pages.join(''), clean.html);
  assert.equal(result.totalPages, 3);
  assert.equal(result.truncated, false);
});

await test('text pagination preserves whole independent paragraphs', () => {
  const paragraphs = ['甲', '乙', '丙'].map(char => `<p>${char.repeat(2000)}</p>`);
  const result = news.paginateNewsContent(paragraphs.join(''));
  assert.deepEqual(result.pages, [paragraphs[0] + paragraphs[1], paragraphs[2]]);
  assert.equal(result.truncated, false);
  assert.deepEqual(news.paginateNewsContent(''), {pages: [], truncated: false, totalPages: 0});
});

await test('page cap exposes the full page count so omitted content can be signposted', () => {
  const result = news.paginateNewsContent(news.sanitizeNewsContent(imageBody(97)).html);
  assert.equal(result.pages.length, 12);
  assert.equal(result.totalPages, 13);
  assert.equal(result.truncated, true);
});

await test('detail metadata preserves page totals and only uses the cover for image-free content', async () => {
  reset({images: 17});
  const [item] = await news.getNewsList();
  const detail = await news.getNewsDetail(item);
  assert.equal(detail.pageCount, 3);
  assert.equal(detail.totalPages, 3);
  assert.equal(detail.imageCount, 17);
  assert.equal(detail.headCover, '');
  body = '<p>纯文字公告</p>';
  assert.equal((await news.getNewsDetail(item)).headCover, item.cover);
});

for (const [images, expectedPages] of [[1, 1], [17, 3]]) {
  await test(`${expectedPages} page query sends images inline with caption below them`, async () => {
    reset({images});
    await app.latest(event());
    assert.equal(forwards.length, 0);
    assert.equal(replies.length, 2, 'one progress message and one image message');
    const delivered = replies[1].message;
    assert.deepEqual(delivered.slice(0, expectedPages).map(segment => segment.type), Array(expectedPages).fill('image'));
    assert.match(delivered[expectedPages], /原文：https:\/\/pvp\.qq\.com\//);
    assert.deepEqual(delivered[expectedPages + 1], {type: 'button', subscribed: false});
    assert.deepEqual(renders.map(({data}) => data.pageNo), Array.from({length: expectedPages}, (_, i) => i + 1));
    assert.ok(renders.every(({data}) => data.imgType === 'jpeg' && data.quality === 82));
  });
}

await test('four page query uses one forward followed by caption and button', async () => {
  reset({images: 25});
  const request = event();
  await app.latest(request);
  assert.equal(forwards.length, 1);
  assert.equal(forwards[0].event, request);
  assert.equal(forwards[0].message.rows.length, 4);
  assert.ok(forwards[0].message.rows.every(row => row.message.type === 'image'));
  assert.equal(replies.length, 3);
  assert.equal(replies[1].message.type, 'forward');
  assert.match(replies[2].message[0], /原文：/);
  assert.equal(replies[2].message[1].type, 'button');
});

await test('scheduled four page delivery forwards each image and sends a separate caption', async () => {
  reset({subscribed: true, watermark: timestamp(oldTime), images: 25});
  await app.pushAll();
  assert.equal(forwards.length, 1);
  assert.equal(forwards[0].event, null);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].type, 'forward');
  assert.equal(sends[0].rows.length, 4);
  assert.ok(sends[0].rows.every(row => row.message.type === 'image'));
  assert.equal(sends[1].length, 1, 'scheduled caption does not add a query button');
  assert.match(sends[1][0], /原文：/);
  assert.equal(document.watermark, timestamp(newTime));
});

await test('forward caption failure does not mark an incomplete group delivery as successful', async () => {
  reset({subscribed: true, watermark: timestamp(oldTime), images: 25});
  groupTargets = new Map([['10001', {sendMsg: async message => {
    sends.push(message);
    if (sends.length === 2) throw Error('Fixture caption failure');
    return {message_id: 'forward-only'};
  }}]]);
  await app.pushAll();
  assert.equal(sends.length, 2);
  assert.equal(document.watermark, timestamp(oldTime));
  assert.deepEqual(document.pushed, []);
  assert.equal(writes, 0);
});

await test('oversized screenshot retries a lower quality before delivery', async () => {
  reset();
  const oversized = Buffer.alloc(3 * 1024 * 1024 + 1);
  renderImpl = (_, data) => ({type: 'image', file: data.quality === 82 ? oversized : Buffer.from('small')});
  await app.latest(event());
  assert.deepEqual(renders.map(({data}) => data.quality), [82, 68]);
  assert.equal(replies[1].message[0].file.toString(), 'small');
});

for (const failure of ['detail', 'render', 'missing-target', 'all-sends']) {
  await test(`${failure} failure preserves push watermark and can retry`, async () => {
    reset({subscribed: true, watermark: timestamp(oldTime)});
    document.pushList['10002'] = {enabled: true};
    if (failure === 'detail') detailError = Error('Fixture API failure');
    if (failure === 'render') renderImpl = () => false;
    if (failure === 'missing-target') groupTargets.clear();
    if (failure === 'all-sends') {
      const failingTarget = {sendMsg: async () => {throw Error('Fixture send failure')}};
      groupTargets = new Map([['10001', failingTarget], ['10002', failingTarget]]);
    }
    await app.pushAll();
    assert.equal(document.watermark, timestamp(oldTime));
    assert.deepEqual(document.pushed, []);
    assert.equal(writes, 0);

    detailError = null;
    renderImpl = (_, data) => ({type: 'image', file: Buffer.from(`page-${data.pageNo}`)});
    groupTargets = new Map([['10001', {sendMsg: async message => {sends.push(message); return {message_id: 'recovered'}}}]]);
    await app.pushAll();
    assert.equal(sends.length, 1);
    assert.equal(document.watermark, timestamp(newTime));
    assert.deepEqual(document.pushed, ['new']);
    assert.equal(writes, 1);
    await app.pushAll();
    assert.equal(sends.length, 1, 'a completed push must not be repeated');
  });
}

await test('without subscribers the scheduled task does no API work', async () => {
  reset();
  await app.pushAll();
  assert.deepEqual(listCalls, []);
  assert.deepEqual(detailCalls, []);
  assert.deepEqual(sends, []);
});

console.log(`Upstream game announcements: ${checks} cases passed (no network, browser or messages)`);
