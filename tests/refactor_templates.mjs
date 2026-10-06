// Real changed templates and adapter renderer; all account/image values are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {render, default as renderer} from '../engine/renderer.mjs';

assert.ok(process.argv[2], 'Pass an isolated prepared runtime root');
const runtime = path.resolve(process.argv[2]);
const source = path.join(runtime, 'plugins/GloryOfKings-Plugin');
const output = process.argv[3] && path.resolve(process.argv[3]);
if (output) fs.mkdirSync(output, {recursive: true});
const blank = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
globalThis.logger = new Proxy({}, {get: () => () => {}});
globalThis.fetch = async () => {throw Error('NetworkForbiddenInTemplateFixtures')};
globalThis.gok = {root: runtime, emit() {}, call: async () => {throw Error('RemoteAssetsDisabledInTest')}};
const common = {imgType: 'png', _res_path: '../../../plugins/GloryOfKings-Plugin/resources/'};

function upstreamFunction(file, name, bindings) {
  const code = fs.readFileSync(path.join(source, file), 'utf8')
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"\n]+['"];?\s*$/gm, '')
    .replace(/^export /gm, '');
  return vm.runInNewContext(code + `\n${name}`, {plugin: class {}, ...bindings});
}

const buildHome = upstreamFunction('apps/myKingHomepage.js', 'buildHomepageData', {
  getImgType: () => 'png', moment: () => ({locale: () => ({calendar: () => '示例时间'})}),
  AT_HEAD: '', AT_TAIL: '',
});
const home = buildHome({}, {roleName: '示例召唤师', roleIcon: blank, gameLevel: 30,
  gameOnline: 0, areaName: '示例区', roleText: '测试角色', onlineTime: 1, offlineTime: 2},
  {mods: [
    {modId: 708, name: '最强王者', param1: JSON.stringify({rankingStar: 12}), icon: blank},
    {modId: 701, name: '最强王者', param1: JSON.stringify({rankingStar: 25, starImg: blank}), icon: blank},
    {modId: 702, name: '巅峰赛', param1: JSON.stringify({flagPag: '3.pag', roleIcon: blank, desc: '1800'}), icon: blank, content: '1800'},
    {stype: 0, showStyle: 1, name: '总场次', content: '1234', icon: ''},
    {stype: 0, showStyle: 102, name: '胜率', content: '56.7%', icon: ''},
    {stype: 1, name: '综合评分', content: '88.8', icon: blank},
  ]});
assert.equal(home.flagImg, '3');
assert.equal(home.isOffline, true);
assert.equal(home.rankingStar, 25);
assert.equal(home.modePeakRace.param1.flagPag, '3');

const buildPanel = upstreamFunction('utils/masterPanel.js', 'buildMasterPanelData', {
  Config: {getDefOrConfig: () => ({})}, authStore: {listAccounts: () => []},
});
const fixtures = [
  ['MyKingHomepage', home],
  ['HeroFightingCapacit', {photo: blank, name: '元法', alias: '示例英雄',
    minStats: {guobiao: 10000, provincePower: 8000, cityPower: 4000, areaPower: 2000},
    data: [{platform: '测试区服', province: '示例省', city: '示例市', area: '示例区',
      guobiao: 10000, provincePower: 8000, cityPower: 4000, areaPower: 2000}]}],
  ['HeroSkin', {heroName: '示例英雄', skinCount: 2,
    skinData: [{name: '示例皮肤', url: blank}, {name: '无图皮肤', url: ''}]}],
  ['accountManage', {type: '绑定', timestamp: '2026-10-05 00:00:00', wzryId: '123456789',
    wzryName: '示例召唤师', idList: '1. 示例账号（当前）',
    parsedFuncs: [{cmd: '#王者主页', example: '查询当前账号'}]}],
  ['authPoolOverview', {timestamp: '2026-10-05 00:00:00', omittedOwnerCount: 0,
    overviewCards: [{label: '账号数', value: '1', tone: 'blue'}], unownedAccounts: [],
    ownerSections: [{maskedQqId: '123***789', currentMaskedCampId: '987***321',
      tokenCount: 1, validTokenCount: 1, invalidTokenCount: 0,
      uidEntries: [{maskedCampUserId: '987***321', isCurrent: true, badgeClass: 'valid', badgeText: '可用'}]}]}],
  ['helpConfig', buildPanel()],
];
let rendered = 0;
try {
  for (const [name, data] of fixtures) {
    const bytes = await render('refactor-' + name, {...common, ...data,
      tplFile: `plugins/GloryOfKings-Plugin/resources/html/${name}.html`});
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name);
    assert.ok(bytes.readUInt32BE(16) > 100, name + ' width');
    assert.ok(bytes.readUInt32BE(20) > 100, name + ' height');
    assert.ok(bytes.length > 2000, name + ' real artwork');
    if (output) fs.writeFileSync(path.join(output, name + '.png'), bytes);
    rendered++;
  }
  console.log(JSON.stringify({ok: true, rendered, homepageMappings: 4, network: 'none', accounts: 'synthetic only'}));
} finally {
  await renderer.shutdown();
}
