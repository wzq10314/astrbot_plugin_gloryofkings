// Actual local help cards and methods, with a stub renderer and no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {buildHelpButtons, helpButtonRows} from '../engine/help-buttons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamFile = path.join(root, 'engine/upstream/apps/help.js');
const original = fs.readFileSync(upstreamFile);
let screenshots = [], sent = [], checks = 0;
const source = original.toString('utf8').replace(/^import .*$/gm, '')
  .replace('export class Help', 'class Help')
  + '\nglobalThis.fixture={Help,helpSections,subHelpSections};';
const context = vm.createContext({
  plugin: class {constructor(options) {Object.assign(this, options);}},
  puppeteer: {screenshot: async (name, data) => {screenshots.push({name, data}); return {type: 'image'};}},
  renderMasterPanel: () => {throw Error('Unexpected settings call');},
  getImgType: () => 'png', shouldQuote: () => false,
  Button: {help: () => ({type: 'old-keyboard'})}, logger: {error() {}},
  fetch: () => {throw Error('Network forbidden');},
});
vm.runInContext(source, context, {filename: upstreamFile});
const {Help, helpSections, subHelpSections} = context.fixture;
const app = new Help();
const test = async (name, callback) => {
  try {await callback(); checks++;}
  catch (error) {error.message = `${name}: ${error.message}`; throw error;}
};
const flat = (event, sections) => helpButtonRows(event, sections).flat();
const value = button => button.callback || button.input;
const has = (rows, command) => rows.some(button => value(button) === command);
const privateOwner = {isMaster: true, isGroup: false, msg: '#王者帮助'};
const publicGroup = {isMaster: false, isGroup: true, msg: '#王者帮助'};

await test('main cards supply all visible main commands and aliases', () => {
  const rows = flat(publicGroup, helpSections);
  for (const section of helpSections.filter(row => !row.ownerOnly)) {
    for (const item of section.list) for (const command of [item.cmd, ...(item.alias || [])]) {
      assert.ok(rows.some(button => value(button) === command || value(button).startsWith(command + ' ')), command);
    }
  }
  assert.ok(has(rows, '#查询战绩帮助'));
  assert.ok(has(rows, '#英雄相关帮助'));
  assert.ok(has(rows, '#营地观战帮助'));
  assert.ok(has(rows, '#群战绩报告帮助'));
});
for (const [key, section] of Object.entries(subHelpSections)) {
  await test(`section ${key} retains every command-bearing card`, () => {
    const rows = flat({...privateOwner, msg: '#子帮助'}, [section]);
    for (const item of section.list) {
      if (!item.cmd.startsWith('#')) continue;
      for (const command of [item.cmd, ...(item.alias || [])]) {
        if (command === '#查询N战绩') {
          assert.ok(has(rows, '#查询[账号序号]战绩 [对局序号]')); continue;
        }
        const fixed = (item.args || '').split(/[\[<@]/u, 1)[0].trim();
        const prefix = command + (fixed ? ' ' + fixed : '');
        assert.ok(rows.some(button => value(button) === prefix || value(button).startsWith(prefix + ' ')), `${key}: ${prefix}`);
      }
    }
    assert.ok(has(rows, '#王者帮助'));
  });
}
await test('distinct actions stored as aliases remain separate buttons', () => {
  const sections = [subHelpSections.push, subHelpSections.groupReport];
  const rows = flat(publicGroup, sections);
  for (const command of ['#关闭日报推送', '#关闭周报推送', '#关闭月报推送',
    '#关闭群日报推送', '#关闭群周报推送', '#关闭群月报推送',
    '#关闭皮肤上新推送', '#关闭王者公告推送']) assert.ok(has(rows, command), command);
});
await test('watch fixed actions are executable and parameters remain editable', () => {
  const rows = flat(publicGroup, [subHelpSections.watch]);
  for (const command of ['#营地观战 列表', '#营地观战 在播', '#营地观战 停',
    '#营地观战 停 全部', '#观战大神 在播', '#观战大神 停', '#营地开播']) {
    assert.ok(rows.some(button => button.callback === command), command);
  }
  assert.ok(rows.some(button => button.input === '#营地观战 <编号>'));
  assert.ok(rows.some(button => button.input === '#营地观战 停 <编号>'));
  assert.ok(rows.some(button => button.input === '#观战大神 <分路>'));
});
await test('owner commands hidden from group owners and private ordinary users', () => {
  const sections = [...helpSections, ...Object.values(subHelpSections)];
  for (const event of [{isMaster: false, isGroup: false}, {isMaster: true, isGroup: true}, publicGroup]) {
    const rows = flat(event, sections);
    assert.ok(!has(rows, '#王者设置'));
    assert.ok(!has(rows, '#王者数据备份'));
    assert.ok(!has(rows, '#营地消息部署'));
    assert.ok(!rows.some(button => value(button).startsWith('#营地观战接入')));
    assert.ok(!rows.some(button => value(button).startsWith('#营地共享库令牌')));
  }
  const rows = flat(privateOwner, sections);
  assert.ok(has(rows, '#王者设置'));
  assert.ok(has(rows, '#营地消息部署'));
});
await test('placeholders and quote instructions never execute', () => {
  const rows = flat(privateOwner, [...helpSections, ...Object.values(subHelpSections)]);
  for (const button of rows) {
    if (button.callback) assert.doesNotMatch(button.callback, /[\[\]<>@]|查询N战绩|引用那条/);
    assert.ok(value(button).startsWith('#'));
  }
  assert.ok(rows.some(button => button.input === '#切换营地 [序号]'));
  assert.ok(rows.some(button => button.input === '#删除营地 [序号]'));
  assert.ok(rows.some(button => button.input === '#英雄详情 <英雄名>'));
});
await test('binding has both tutorial and editable ID controls', () => {
  const rows = flat(publicGroup, helpSections);
  assert.ok(rows.some(button => button.callback === '#绑定营地'));
  assert.ok(rows.some(button => button.input === '#绑定营地 [营地ID]'));
});
await test('rank refresh and peak variants are retained', () => {
  const rows = flat(publicGroup, helpSections);
  for (const command of ['#排位排名', '#巅峰排名', '#排位总排名', '#巅峰总排名']) {
    assert.ok(has(rows, command)); assert.ok(has(rows, command + ' 刷新'));
  }
});
await test('no route regex text becomes a button', () => {
  const rows = flat(publicGroup, [{list: [
    {cmd: '^#(查询|王者)(\\d+)战绩$'}, {cmd: '#王者(主页|卡片)'},
    {cmd: '#查询战绩', alias: ['#王者战绩']}, {cmd: '引用那条推送回一句'},
  ]}]);
  assert.deepEqual(rows.map(value), ['#查询战绩', '#王者战绩']);
});
await test('button factory receives only two-column rows', () => {
  const result = buildHelpButtons(publicGroup, helpSections, (...rows) => ({type: 'button', rows}));
  assert.equal(result.type, 'button');
  assert.ok(result.rows.every(row => row.length > 0 && row.length <= 2));
  assert.equal(buildHelpButtons(publicGroup, [], null), null);
});
await test('deduplication preserves fixed variants and input variants', () => {
  const rows = flat(publicGroup, [subHelpSections.watch, subHelpSections.watch]);
  assert.equal(rows.filter(button => button.callback === '#营地观战').length, 1);
  assert.equal(rows.filter(button => button.callback === '#营地观战 在播').length, 1);
  assert.equal(rows.filter(button => button.input === '#营地观战 <编号>').length, 1);
});
await test('actual upstream filtering feeds matching section keyboards', async () => {
  for (const msg of ['#王者帮助', '#王者帮助 账号', '#营地观战帮助', '#营地消息帮助', '#皮肤帮助']) {
    screenshots = []; sent = [];
    const event = {...publicGroup, msg, reply: async reply => sent.push(reply)};
    const rule = app.rule.find(row => new RegExp(row.reg).test(msg));
    assert.ok(rule); await app[rule.fnc](event);
    assert.equal(screenshots.length, 1);
    assert.equal(sent[0][0].type, 'image');
    const rows = flat(event, screenshots[0].data.sections);
    assert.ok(rows.length > 0);
    if (msg === '#皮肤帮助') {
      assert.ok(has(rows, '#全部皮肤'));
      assert.ok(!has(rows, '#王者主页'));
    }
  }
});
await test('runtime reply replacement retains the image and supplies its keyboard', async () => {
  const anchor = '      await e.reply([inventoryImage, Button.help()], shouldQuote())';
  assert.equal(source.split(anchor).length - 1, 1);
  const adapted = source.replace(anchor,
    '      await e.reply([inventoryImage, buildHelpButtons(e, sections, (...rows) => segment.button(...rows))], shouldQuote())');
  const runtimeContext = vm.createContext({...context, buildHelpButtons,
    segment: {button: (...rows) => ({type: 'button', rows})}});
  vm.runInContext(adapted, runtimeContext);
  const runtimeApp = new runtimeContext.fixture.Help();
  let reply;
  await runtimeApp.showSubHelp({...publicGroup, msg: '#皮肤帮助', reply: async value => {reply = value;}});
  assert.equal(reply[0].type, 'image');
  assert.equal(reply[1].type, 'button');
  assert.ok(reply[1].rows.flat().some(button => button.callback === '#全部皮肤'));
  assert.ok(!reply[1].rows.flat().some(button => button.callback === '#王者主页'));
});
await test('helper does not mutate image metadata or vendored source', () => {
  const before = JSON.stringify([helpSections, subHelpSections]);
  flat(privateOwner, [...helpSections, ...Object.values(subHelpSections)]);
  assert.equal(JSON.stringify([helpSections, subHelpSections]), before);
  assert.deepEqual(fs.readFileSync(upstreamFile), original);
});

const allSections = [...helpSections, ...Object.values(subHelpSections)];
const callbacks = [...new Set(flat(privateOwner, allSections).flatMap(button => button.callback ? [button.callback] : []))].sort();
const coverage = Object.fromEntries(Object.entries(subHelpSections).map(([key, section]) =>
  [key, {public: flat({...publicGroup, msg: '#子帮助'}, [section]).length,
    owner: flat({...privateOwner, msg: '#子帮助'}, [section]).length}]));
console.log(`Dynamic help buttons: ${checks} checks passed`);
console.log(JSON.stringify({mainPublic: flat(publicGroup, helpSections).length,
  mainOwner: flat(privateOwner, helpSections).length, coverage, callbacks}, null, 2));
