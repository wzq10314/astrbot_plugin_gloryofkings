// Run against a prepared runtime's plugin directory, never a live PM2 daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

assert.ok(process.argv[2], 'Pass the prepared runtime plugins/GloryOfKings-Plugin directory');
const source = fs.readFileSync(path.join(process.argv[2], 'utils/pm2.js'), 'utf8');
const dependencies = [];
globalThis.__pm2TestDependencies = dependencies;

async function fixture({platform = 'linux', lpm2 = false, installed = true, explicit = true} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'win32' ? 'C:\\fixture' : '/fixture';
  const plugin = p.join(base, 'plugins', 'GloryOfKings-Plugin');
  const home = p.join(base, 'bridge state', 'pm2');
  const ownHome = p.join(plugin, 'data', 'pm2');
  const js = p.join(base, 'engine with spaces', 'node_modules', 'pm2', 'bin', 'pm2');
  const lpm2Js = p.join(base, 'engine with spaces', 'node_modules', '@lyln', 'lpm2', 'bin', 'lpm2.js');
  const files = new Map(), dirs = new Set(), calls = [], mkdirs = [], kills = [], alive = new Set();
  const missing = () => Object.assign(Error('fixture: missing'), {code: 'ENOENT'});
  if (installed) files.set(js, '// fixture');
  const packages = new Map();
  const packageFile = (pkg, bin, entry) => {
    const filename = p.join(base, 'engine with spaces', 'node_modules', ...pkg.split('/'), 'package.json');
    files.set(filename, JSON.stringify({bin: {[bin]: p.relative(p.dirname(filename), entry)}}));
    files.set(entry, '// fixture');
    packages.set(`${pkg}/package.json`, filename);
  };
  if (installed && !explicit) packageFile('pm2', 'pm2', js);
  if (lpm2) packageFile('@lyln/lpm2', 'lpm2', lpm2Js);
  const environment = {PM2_HOME: home, HOME: p.join(base, 'user'), APPDATA: p.join(base, 'appdata')};
  if (installed && explicit) environment.GOK_PM2_JS = js;
  const testProcess = {
    platform, execPath: p.join(base, 'node with spaces', platform === 'win32' ? 'node.exe' : 'node'), env: environment,
    kill(pid, signal) {kills.push({pid, signal}); assert.equal(signal, 0); if (!alive.has(pid)) throw Object.assign(Error('not running'), {code: 'ESRCH'})}
  };
  const records = [
    {name: 'gok-watch', pm2_env: {pm_cwd: p.join(plugin, 'server'), status: 'online', note: 'literal [text] and "quote"'}},
    {name: 'gok-im', pm2_env: {pm_cwd: p.join(plugin, 'server-im'), status: 'online'}}
  ];
  const mocks = {
    'node:fs': {default: {
      existsSync: filename => files.has(String(filename)) || dirs.has(String(filename)),
      readFileSync: filename => {if (!files.has(String(filename))) throw missing(); return files.get(String(filename))},
      readdirSync: filename => dirs.has(String(filename)) ? ['fixture.pid'] : [],
      mkdirSync: filename => {mkdirs.push(String(filename)); dirs.add(String(filename))}
    }},
    'node:os': {default: {homedir: () => p.join(base, 'user')}},
    'node:path': {default: p},
    'node:url': {fileURLToPath: () => p.join(plugin, 'utils', 'pm2.js')},
    'node:module': {createRequire: () => ({resolve: specifier => {if (!packages.has(specifier)) throw missing(); return packages.get(specifier)}})},
    'node:child_process': {spawnSync: (cmd, args, options) => {
      assert.ok(Array.isArray(args), 'All commands must run node + JS + argument array');
      assert.equal(options.shell, undefined, 'No command interpreter is allowed');
      calls.push({cmd, args, options});
      return {status: 0, stdout: '[PM2] harmless banner\n' + JSON.stringify(records) + '\ntrailing text', stderr: ''};
    }}
  };
  const processIndex = dependencies.push(testProcess) - 1;
  let text = `const process = globalThis.__pm2TestDependencies[${processIndex}];\n` + source;
  text = text.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/gm,
    (statement, clause, quote, specifier) => {
      assert.ok(mocks[specifier], `Unexpected PM2 import: ${specifier}`);
      const index = dependencies.push(mocks[specifier]) - 1;
      const binding = `globalThis.__pm2TestDependencies[${index}]`;
      clause = clause.trim();
      return clause.startsWith('{')
        ? `const ${clause.replace(/\s+as\s+/g, ': ')} = ${binding};\n`
        : `const ${clause} = ${binding}.default;\n`;
    });
  const module = await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
  const live = (dir = home, pid = 54321) => {files.set(p.join(dir, 'pm2.pid'), String(pid)); alive.add(pid)};
  return {module, p, home, ownHome, files, dirs, calls, mkdirs, kills, alive, live, js, lpm2Js, testProcess, records};
}

let checks = 0;
async function test(name, callback) {
  try {await callback(); checks++} catch (error) {error.message = `${name}: ${error.message}`; throw error}
}
for (const platform of ['linux', 'win32']) {
  await test(`${platform}: discovery and no-daemon status are pure reads`, async () => {
    const f = await fixture({platform});
    assert.equal(f.module.pm2Bin(), f.js);
    assert.equal(f.module.launcherInfo().kind, 'pm2');
    assert.equal(f.module.launcherInfo().pm2Home, f.home);
    assert.equal(f.module.pm2Proc('gok-watch'), null);
    assert.equal(f.module.pm2ForeignProc('gok-im'), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.mkdirs.length, 0);
  });
  await test(`${platform}: stale dump and PID files never revive a stopped daemon`, async () => {
    const f = await fixture({platform});
    f.files.set(f.p.join(f.home, 'dump.pm2'), '[]');
    f.files.set(f.p.join(f.home, 'pm2.pid'), '54321');
    f.dirs.add(f.p.join(f.home, 'pids'));
    assert.equal(f.module.pm2Proc('gok-watch'), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.mkdirs.length, 0);
  });
  await test(`${platform}: running services stay visible in existing bridge home`, async () => {
    const f = await fixture({platform}); f.live();
    assert.deepEqual(f.module.pm2Proc('gok-watch'), f.records[0]);
    assert.deepEqual(f.module.pm2Proc('gok-im'), f.records[1]);
    assert.deepEqual(f.calls.map(call => call.args), [[f.js, 'jlist'], [f.js, 'jlist']]);
    assert.ok(f.calls.every(call => call.cmd === f.testProcess.execPath && call.options.env.PM2_HOME === f.home));
    assert.equal(f.mkdirs.length, 0);
  });
  await test(`${platform}: restarting with spaces preserves exact args and isolation`, async () => {
    const f = await fixture({platform});
    assert.equal(f.module.pm2(['restart', 'gok-watch', '--update-env'], {env: {GOK_FFMPEG: '/fixture/ffmpeg'}}).ok, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args, [f.js, 'restart', 'gok-watch', '--update-env']);
    assert.equal(f.calls[0].options.env.PM2_HOME, f.home);
    assert.equal(f.calls[0].options.env.GOK_FFMPEG, '/fixture/ffmpeg');
  });
  await test(`${platform}: invalid daemon PID is rejected without spawning`, async () => {
    const f = await fixture({platform});
    for (const bad of ['0', '-1', '123junk', 'NaN', '9007199254740992']) {
      f.files.set(f.p.join(f.home, 'pm2.pid'), bad);
      assert.equal(f.module.pm2Proc('gok-im'), null);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.kills.length, 0);
  });
}
await test('missing PM2 cannot spawn anything during status or deployment', async () => {
  const f = await fixture({installed: false});
  assert.equal(f.module.launcherInfo().kind, 'none');
  assert.equal(f.module.pm2Proc('gok-watch'), null);
  assert.equal(f.module.pm2(['start', 'fixture.js']).missing, true);
  assert.equal(f.calls.length, 0);
});
await test('package resolution is a pure-read fallback to explicit bridge entry', async () => {
  const f = await fixture({explicit: false});
  assert.equal(f.module.pm2Bin(), f.js);
  assert.equal(f.calls.length, 0);
});
await test('Windows lpm2 empty status uses separate home without creating it', async () => {
  const f = await fixture({platform: 'win32', lpm2: true});
  assert.equal(f.module.lpm2Ready(), true);
  assert.equal(f.module.launcherInfo().kind, 'lpm2');
  assert.equal(f.module.launcherInfo().pm2Home, f.ownHome);
  assert.equal(f.module.pm2Proc('gok-watch'), null);
  assert.equal(f.module.pm2ForeignProc('gok-im'), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mkdirs.length, 0);
});
await test('Windows lpm2 status ignores stale own/legacy history', async () => {
  const f = await fixture({platform: 'win32', lpm2: true});
  for (const home of [f.home, f.ownHome]) {
    f.files.set(f.p.join(home, 'dump.pm2'), '[]');
    f.files.set(f.p.join(home, 'pm2.pid'), '54321');
    f.dirs.add(f.p.join(home, 'pids'));
  }
  assert.equal(f.module.pm2Proc('gok-watch'), null);
  assert.equal(f.module.pm2ForeignProc('gok-im'), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mkdirs.length, 0);
});
await test('Windows old daemon is detected read-only while lpm2 home remains unused', async () => {
  const f = await fixture({platform: 'win32', lpm2: true}); f.live();
  assert.equal(f.module.pm2Proc('gok-watch'), null);
  assert.deepEqual(f.module.pm2ForeignProc('gok-watch'), f.records[0]);
  assert.deepEqual(f.module.pm2ForeignProc('gok-im'), f.records[1]);
  assert.deepEqual(f.calls.map(call => call.args), [[f.js, 'jlist'], [f.js, 'jlist']]);
  assert.ok(f.calls.every(call => call.options.env.PM2_HOME === f.home));
  assert.equal(f.mkdirs.length, 0);
});
await test('Windows lpm2 start is explicit and keeps the isolated launcher/home', async () => {
  const f = await fixture({platform: 'win32', lpm2: true});
  assert.equal(f.module.pm2(['start', 'entry with spaces.js', '--name', 'gok-im']).ok, true);
  assert.deepEqual(f.calls[0].args, [f.lpm2Js, 'start', 'entry with spaces.js', '--name', 'gok-im']);
  assert.equal(f.calls[0].options.env.PM2_HOME, f.ownHome);
  assert.deepEqual(f.mkdirs, [f.ownHome]);
});
await test('Linux never adopts lpm2 even when the package is installed', async () => {
  const f = await fixture({lpm2: true}); f.live();
  assert.equal(f.module.lpm2Ready(), false);
  assert.equal(f.module.launcherInfo().kind, 'pm2');
  assert.deepEqual(f.module.pm2Proc('gok-watch'), f.records[0]);
  assert.equal(f.calls[0].options.env.PM2_HOME, f.home);
});
console.log(`PM2 runtime compatibility: ${checks} checks passed`);
