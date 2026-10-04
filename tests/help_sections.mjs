// Run unchanged upstream Help methods with in-memory fixtures: no accounts or real messages.
// Usage: node tests/help_sections.mjs [upstream-root] [runtime-root] [optional-image-directory]
// Supplying runtime-root also verifies the real help.html with engine/renderer.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/upstream'));
const dependencies = [];
globalThis.__helpSectionDependencies = dependencies;
globalThis.plugin = class {constructor(options) {Object.assign(this, options)}};
globalThis.fetch = async () => {throw Error('Network is forbidden in help fixtures')};
let loggedErrors = [];
globalThis.logger = {error: message => loggedErrors.push(message)};

// Replace only imports; the real routing, filtering, rendering and fallback bodies run intact.
async function loadHelp(mocks) {
  let source = fs.readFileSync(path.join(root, 'apps/help.js'), 'utf8');
  source = source.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (_, clause, quote, specifier) => {
      assert.ok(Object.hasOwn(mocks, specifier), `Unexpected help dependency: ${specifier}`);
      const index = dependencies.push(mocks[specifier]) - 1;
      const binding = `globalThis.__helpSectionDependencies[${index}]`;
      clause = clause.trim();
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`;
      assert.match(clause, /^[A-Za-z_$][\w$]*$/, 'Support changed upstream imports explicitly');
      return `const ${clause} = ${binding}.default;\n`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

let imageMode = 'image', screenshots = [], checks = 0;
const image = {type: 'fixture-image', file: 'in-memory-help'};
const button = {type: 'fixture-button', command: '#王者帮助'};
const {Help} = await loadHelp({
  '../../../lib/puppeteer/puppeteer.js': {default: {async screenshot(name, data) {
    screenshots.push({name, data: structuredClone(data)});
    if (imageMode === 'error') throw Error('Fixture screenshot unavailable');
    return imageMode === 'empty' ? null : image;
  }}},
  '../utils/masterPanel.js': {renderMasterPanel: async () => {throw Error('Unexpected settings panel request')}},
  '#utils': {getImgType: () => 'png', Button: {help: () => button}, shouldQuote: () => true}
});
const help = new Help();
const matches = (rule, message) => new RegExp(rule.reg).test(message);
const allCommands = sections => sections.flatMap(section => section.list.flatMap(item => [item.cmd, ...(item.alias || [])]));
const titles = sections => sections.map(section => section.title);
const renderFixtures = new Map();

async function test(name, callback) {
  try {await callback(); checks++}
  catch (error) {error.message = `${name}: ${error.message}`; throw error}
}
async function invoke(message, context = {}, mode = 'image', directMethod) {
  imageMode = mode; screenshots = []; loggedErrors = [];
  const e = {msg: message, isMaster: false, isGroup: true, ...context, replies: [],
    async reply(content, quote) {this.replies.push({content, quote}); return {message_id: 'fixture-only'}}};
  let method = directMethod;
  if (!method) {
    const matching = help.rule.filter(rule => matches(rule, message));
    assert.equal(matching.length, 1, `Exactly one help rule must accept ${message}`);
    method = matching[0].fnc;
  }
  const result = await help[method](e);
  return {e, result, captures: screenshots, errors: loggedErrors};
}
function rendered(outcome, mode) {
  assert.equal(outcome.captures.length, 1, 'Use one shared help template render');
  const {name, data} = outcome.captures[0];
  assert.equal(name, 'help');
  assert.equal(data.tplFile, 'plugins/GloryOfKings-Plugin/resources/html/help.html');
  assert.equal(data.imgType, 'png');
  assert.ok(data.generatedAt);
  assert.equal(outcome.e.replies.length, 1);
  assert.equal(outcome.e.replies[0].quote, true);
  if (mode === 'image') {
    assert.deepEqual(outcome.e.replies[0].content, [image, button]);
    assert.deepEqual(outcome.errors, []);
  } else {
    const text = outcome.e.replies[0].content;
    assert.equal(typeof text, 'string');
    assert.match(text, /出图失败/);
    assert.equal(outcome.errors.length, 1);
    assert.deepEqual([...text.matchAll(/^【(.+)】$/gm)].map(match => match[1]), titles(data.sections));
    const expected = data.sections.flatMap(section => section.list.map(item =>
      `${item.cmd}${item.args ? ` ${item.args}` : ''} —— ${item.desc}`));
    assert.deepEqual(text.split('\n').filter(line => line.includes(' —— ')), expected,
      'Text fallback must include every visible command, its arguments and explanation');
  }
  return data.sections;
}

const publicTitles = ['账号管理', '数据查询', '排行榜', '王者公告', '营地相关', '战绩推送'];
const subhelps = [
  {entry: '#查询战绩帮助', title: '查询战绩', first: '#查询战绩', last: '#段位趋势', count: 12},
  {entry: '#英雄相关帮助', aliases: ['#英雄帮助'], title: '英雄相关', first: '#英雄详情', last: '#称号墙', count: 7},
  {entry: '#皮肤帮助', title: '皮肤', first: '#查皮肤', last: '#缺皮肤', count: 5},
  {entry: '#营地ID共享帮助', aliases: ['#营地共享帮助', '#营地id共享帮助'], title: '营地ID共享', first: '#开启营地ID共享', last: '#同步营地ID共享', count: 4},
  {entry: '#营地观战帮助', aliases: ['#观战帮助'], title: '营地观战', first: '#营地观战', last: '#营地开播', count: 12,
    privateCommands: ['#营地观战连接', '#营地观战接入', '#营地观战部署', '#营地观战服务']},
  {entry: '#营地消息帮助', title: '营地消息', first: '引用那条推送回一句', last: '#营地消息关', count: 7,
    privateCommands: ['#营地消息连接', '#营地消息接入', '#营地消息部署', '#营地消息服务', '#营地消息同步']},
  {entry: '#战绩推送帮助', title: '战绩推送', first: '#开启战绩推送', last: '#开启王者公告推送', count: 18},
  {entry: '#群战绩报告帮助', title: '群战绩报告', first: '#群日报', last: '#群报状态', count: 8}
];
const contexts = [
  {name: 'ordinary group', isMaster: false, isGroup: true},
  {name: 'ordinary private', isMaster: false, isGroup: false},
  {name: 'owner group', isMaster: true, isGroup: true},
  {name: 'owner private', isMaster: true, isGroup: false}
];
const modes = ['image', 'error', 'empty'];
let ownerSections;
await test('owner private help exposes both maintenance sections', async () => {
  const outcome = await invoke('#王者帮助', contexts[3]);
  ownerSections = rendered(outcome, 'image');
  assert.deepEqual(titles(ownerSections), [...publicTitles, '主人指令', '系统指令']);
  assert.ok(ownerSections.find(section => section.title === '主人指令').list.some(item => item.cmd === '#王者数据备份'));
  assert.ok(ownerSections.find(section => section.title === '系统指令').list.some(item => item.cmd === '#王者更新'));
  renderFixtures.set('main-owner-private', outcome.captures[0].data);
});
const privateMain = ownerSections.filter(section => section.ownerOnly);
const privateMainCommands = allCommands(privateMain);
const expectedPublic = ownerSections.filter(section => !section.ownerOnly);

for (const context of contexts) for (const mode of modes) {
  await test(`main help ${context.name}, ${mode}`, async () => {
    const outcome = await invoke('#王者帮助', context, mode);
    const sections = rendered(outcome, mode);
    const ownerPrivate = context.isMaster && !context.isGroup;
    assert.deepEqual(sections, ownerPrivate ? ownerSections : expectedPublic);
    assert.deepEqual(titles(sections), ownerPrivate ? [...publicTitles, '主人指令', '系统指令'] : publicTitles);
    if (!ownerPrivate) {
      assert.ok(privateMainCommands.every(command => !allCommands(sections).includes(command)));
      if (mode !== 'image') for (const command of privateMainCommands) {
        assert.ok(!outcome.e.replies[0].content.includes(command), `Hidden command leaked in text: ${command}`);
      }
    }
    if (context.name === 'ordinary group' && mode === 'image') renderFixtures.set('main-public', outcome.captures[0].data);
  });
}

await test('main help offers eight entry points without expanding their detailed commands', async () => {
  assert.deepEqual(expectedPublic.map(section => section.list.length), [6, 6, 2, 2, 3, 2]);
  const entries = expectedPublic.flatMap(section => section.list.map(item => item.cmd)).filter(command => command.endsWith('帮助'));
  assert.deepEqual(entries, subhelps.map(section => section.entry));
  const commands = allCommands(expectedPublic);
  for (const detailed of ['#查询战绩', '#英雄详情', '#查皮肤', '#营地观战', '#营地消息', '#开启战绩推送', '#群日报']) {
    assert.ok(!commands.includes(detailed), `${detailed} belongs in its subhelp`);
  }
  assert.ok(commands.includes('#王者对比'));
  assert.ok(!allCommands(ownerSections).includes('#对比'), 'Removed short comparison alias must not be advertised');
  const bind = expectedPublic[0].list.find(item => item.cmd === '#绑定营地');
  assert.match(bind.desc, /不带营地ID.*教程图/);
  assert.ok(!commands.includes('#获取营地ID'), 'Binding itself is the tutorial entry point');
  assert.deepEqual(expectedPublic[2].list.map(item => item.alias), [['#巅峰排名'], ['#巅峰总排名']]);
});

await test('subhelp routing precedes broad watch commands', async () => {
  assert.ok(help.priority < 0, 'Help must precede watchBattle priority 0');
  assert.equal(help.rule.filter(rule => rule.fnc === 'showSubHelp').length, 1);
  for (const fixture of subhelps) {
    for (const entry of [fixture.entry, ...(fixture.aliases || [])]) {
      for (const message of [entry, entry.slice(1)]) {
        const outcome = await invoke(message);
        const sections = rendered(outcome, 'image');
        assert.deepEqual(titles(sections), [fixture.title], `${message} must select its own section`);
      }
    }
  }
});

for (const fixture of subhelps) for (const context of contexts) for (const mode of modes) {
  await test(`${fixture.entry}, ${context.name}, ${mode}`, async () => {
    const outcome = await invoke(fixture.entry, context, mode);
    const sections = rendered(outcome, mode);
    assert.deepEqual(titles(sections), [fixture.title]);
    const ownerPrivate = context.isMaster && !context.isGroup;
    const privateCommands = fixture.privateCommands || [];
    const list = sections[0].list;
    assert.equal(list.length, fixture.count + (ownerPrivate ? privateCommands.length : 0));
    assert.equal(list[0].cmd, fixture.first);
    assert.equal(list[fixture.count - 1].cmd, fixture.last);
    assert.deepEqual(list.filter(item => item.ownerOnly).map(item => item.cmd), ownerPrivate ? privateCommands : []);
    for (const command of privateCommands) {
      assert.equal(allCommands(sections).includes(command), ownerPrivate);
      if (mode !== 'image') assert.equal(outcome.e.replies[0].content.includes(command), ownerPrivate);
    }
    if (!ownerPrivate) assert.ok(!allCommands(sections).includes('#营地消息重连'), 'Owner-only aliases are stripped with their command');
    assert.ok(!allCommands(sections).includes('#对比'));
    if (context.name === 'ordinary group' && mode === 'image') renderFixtures.set(`sub-${fixture.title}-public`, outcome.captures[0].data);
    if (ownerPrivate && privateCommands.length && mode === 'image') renderFixtures.set(`sub-${fixture.title}-owner-private`, outcome.captures[0].data);
  });
}

for (const context of contexts.slice(0, 3)) for (const keyword of ['主人指令', '系统指令', '数据备份', '王者更新', '共享库令牌']) {
  await test(`keyword search cannot reveal ${keyword} in ${context.name}`, async () => {
    const outcome = await invoke(`#王者帮助 ${keyword}`, context);
    assert.deepEqual(outcome.captures, []);
    assert.deepEqual(outcome.errors, []);
    assert.deepEqual(outcome.e.replies, [{content: `没有找到和「${keyword}」相关的指令，发送 #王者帮助 看全部功能`, quote: true}]);
  });
}
for (const mode of modes) {
  await test(`owner private keyword search retains the requested owner command, ${mode}`, async () => {
    const outcome = await invoke('#王者帮助 共享库令牌', contexts[3], mode);
    const sections = rendered(outcome, mode);
    assert.deepEqual(titles(sections), ['主人指令']);
    assert.deepEqual(sections[0].list.map(item => item.cmd), ['#营地共享库令牌']);
    assert.equal(outcome.captures[0].data.keyword, '共享库令牌');
    if (mode !== 'image') assert.match(outcome.e.replies[0].content, /关键词：共享库令牌/);
  });
}
for (const [message, sectionTitles, commands] of [
  ['#王者帮助 排行榜', ['排行榜', '战绩推送'], [['#排位排名', '#排位总排名'], ['#战绩推送帮助', '#群战绩报告帮助']]],
  ['王者荣耀pluginHELP qq全局登录', ['账号管理'], [['#营地QQ全局登录']]],
  ['#王者帮助 王者资讯', ['王者公告'], [['#王者公告', '#王者公告列表']]]
]) {
  await test(`main keyword filtering handles titles, aliases and case: ${message}`, async () => {
    const sections = rendered(await invoke(message), 'image');
    assert.deepEqual(titles(sections), sectionTitles);
    assert.deepEqual(sections.map(section => section.list.map(item => item.cmd)), commands);
  });
}
await test('unknown subhelp inputs neither claim a route nor send a reply', async () => {
  const rule = help.rule.find(item => item.fnc === 'showSubHelp');
  for (const message of ['#未知帮助', '#英雄相关帮助 多余', '#营地观战帮助1', '#查询战绩', '#对比']) {
    assert.equal(matches(rule, message), false);
    const outcome = await invoke(message, {}, 'image', 'showSubHelp');
    assert.equal(outcome.result, false);
    assert.deepEqual(outcome.e.replies, []);
    assert.deepEqual(outcome.captures, []);
  }
});
await test('repeated public requests never mutate shared owner help data', async () => {
  assert.deepEqual(rendered(await invoke('#王者帮助', contexts[3]), 'image'), ownerSections);
  for (const fixture of subhelps.filter(item => item.privateCommands)) {
    const sections = rendered(await invoke(fixture.entry, contexts[3]), 'image');
    assert.deepEqual(sections[0].list.filter(item => item.ownerOnly).map(item => item.cmd), fixture.privateCommands);
  }
});

let renderedImages = 0;
if (process.argv[3]) {
  const runtimeRoot = path.resolve(process.argv[3]);
  const imageDirectory = process.argv[4] && path.resolve(process.argv[4]);
  const runtimePlugin = path.join(runtimeRoot, 'plugins/GloryOfKings-Plugin');
  for (const relative of ['apps/help.js', 'resources/html/help.html']) {
    assert.equal(fs.readFileSync(path.join(runtimePlugin, relative), 'utf8'), fs.readFileSync(path.join(root, relative), 'utf8'),
      `Runtime ${relative} must match the source under test`);
  }
  globalThis.gok = {root: runtimeRoot, call: async () => {throw Error('Remote assets are forbidden in help fixtures')}, emit: () => {}};
  const {default: renderer, render} = await import('../engine/renderer.mjs');
  if (imageDirectory) fs.mkdirSync(imageDirectory, {recursive: true});
  try {
    for (const [name, captured] of renderFixtures) {
      await test(`real help.html layout: ${name}`, async () => {
        const data = {...captured, generatedAt: '2026-10-04 12:00:00', imgType: 'png'};
        const buffer = await render('help', data, async page => {
          const dom = await page.evaluate(() => {
            const container = document.querySelector('#container').getBoundingClientRect();
            return {
              width: container.width, height: container.height,
              sections: [...document.querySelectorAll('.panel')].map(panel => ({
                title: panel.querySelector('h2').textContent.trim(),
                columns: getComputedStyle(panel.querySelector('.cards')).gridTemplateColumns.split(' ').length,
                cards: [...panel.querySelectorAll('.card')].map(card => {
                  const bounds = card.getBoundingClientRect();
                  return {
                    cmd: card.querySelector('.cmd').textContent.trim(),
                    args: card.querySelector('.args')?.textContent.trim() || '',
                    desc: card.querySelector('.card-desc').textContent.trim(),
                    alias: [...card.querySelectorAll('.alias-chip')].map(item => item.textContent.trim()),
                    inside: bounds.left >= container.left && bounds.right <= container.right && bounds.bottom <= container.bottom,
                    commandFont: parseFloat(getComputedStyle(card.querySelector('.cmd')).fontSize)
                  };
                })
              }))
            };
          });
          assert.equal(dom.width, 2880, 'Render the full rem-scaled panel width');
          assert.ok(dom.height > 400 && dom.height < 10000);
          assert.deepEqual(dom.sections.map(section => section.title), titles(data.sections));
          for (const [index, section] of dom.sections.entries()) {
            assert.equal(section.columns, 3);
            assert.equal(section.cards.length, data.sections[index].list.length);
            for (const [itemIndex, card] of section.cards.entries()) {
              const expected = data.sections[index].list[itemIndex];
              assert.deepEqual({cmd: card.cmd, args: card.args, desc: card.desc, alias: card.alias},
                {cmd: expected.cmd, args: expected.args || '', desc: expected.desc, alias: (expected.alias || []).slice(0, 2)});
              assert.ok(card.inside, `Card outside screenshot: ${card.cmd}`);
              assert.equal(card.commandFont, 32);
            }
          }
        });
        assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.ok(buffer.length > 10000, 'Help screenshot must contain rendered content');
        if (imageDirectory) fs.writeFileSync(path.join(imageDirectory, `${name}.png`), buffer);
        renderedImages++;
      });
    }
  } finally {await renderer.shutdown()}
}

console.log(JSON.stringify({ok: true, checks, subhelpSections: subhelps.length, renderedImages,
  isolation: 'No accounts, network requests, or real messages'}));
