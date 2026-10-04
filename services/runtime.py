"""Materialize the pinned upstream without mixing account state into plugin updates."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import yaml
from .pm2_compat import adapt_pm2


def adapt_deploy_errors(source: str, helper: Path) -> str:
    """Replace network diagnostics only in the runtime copy; upstream stays exact."""
    replacements = (
        ("""    // 原始错误进日志，别丢 —— 用户看到的是一句人话，排查靠的是这行
    logger?.warn?.(`[deploy] 请求 ${base} 失败：${error?.name} ${error?.message} code=${error?.cause?.code || '-'}`)
    return { ok: false, message: describeNetError(error, base) }""",
         """    // AstrBot: only fixed descriptions and a parsed host may leave this boundary.
    return { ok: false, message: describeNetError(error, base) }""", 'metadata failure'),
        ("""    // 下载阶段超时通常是网络慢或包太大，和「连不上」是两回事，文案分开
    logger?.warn?.(`[deploy] 下载 ${name} 失败：${error?.name} ${error?.message} code=${error?.cause?.code || '-'}`)
    const msg = error?.name === 'TimeoutError'
      ? '下载超时（网络慢或包太大，重试一次）'
      : describeNetError(error, base).replace(/^连不上分发服务/, '下载中断')
    return { ok: false, message: msg }""",
         """    return { ok: false, message: describeNetError(error, base, 'download') }""", 'download failure'),
    )
    for before, after, name in replacements:
        if source.count(before) != 1:
            raise ValueError('Upstream deployment error hook changed: ' + name)
        source = source.replace(before, after)
    # The upstream function is removed, including its raw-message fallback and HTTP advice.
    pattern = (r'^function describeNetError \(error, base\) \{\n.*?^\}'
               r'(?=\n\n/\*\*\n \* 下载代码包到内存。)')
    source, count = re.subn(pattern, '', source, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise ValueError('Upstream deployment error hook changed: network classifier')
    return (f'import {{describeDeployNetworkError as describeNetError}} from '
            f'{json.dumps(helper.resolve().as_uri())};\n' + source)


def prepare_runtime(engine: Path, destination: Path, settings: dict, host_blacklist=()):
    source = engine / 'upstream'
    target = destination / 'plugins/GloryOfKings-Plugin'
    destination.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((engine.parent / 'UPSTREAM.json').read_text(encoding='utf-8'))
    # Only repository-tracked files are copied. data, user config and downloaded servers survive.
    previous_file = destination / 'upstream-files.json'
    previous = json.loads(previous_file.read_text(encoding='utf-8')) if previous_file.exists() else []
    for relative, digest in manifest['files'].items():
        src, dst = source / relative, target / relative
        if src.resolve().is_relative_to(source.resolve()) is False:
            raise ValueError('Invalid upstream path')
        if hashlib.sha256(src.read_bytes()).hexdigest() != digest:
            raise ValueError('Bundled upstream integrity mismatch: ' + relative)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists() or hashlib.sha256(dst.read_bytes()).hexdigest() != digest:
            shutil.copy2(src, dst)
    for relative in set(previous) - set(manifest['files']):
        path = (target / relative).resolve()
        if not path.is_relative_to(target.resolve()) or relative.startswith(('data/', 'config/config/', 'server/', 'server-im/')):
            raise ValueError('Invalid stale source path')
        path.unlink(missing_ok=True)
    previous_file.write_text(json.dumps(list(manifest['files'])), encoding='utf-8')
    pm2 = target / 'utils/pm2.js'
    pm2.write_text(adapt_pm2(pm2.read_text(encoding='utf-8')), encoding='utf-8')
    deploy = target / 'utils/deploy.js'
    deploy.write_text(adapt_deploy_errors(deploy.read_text(encoding='utf-8'), engine / 'deploy-errors.mjs'),
                      encoding='utf-8')
    remote = target / 'utils/remoteAccounts.js'
    text = remote.read_text(encoding='utf-8')
    policy = (engine / 'remote-policy.mjs').resolve().as_uri()
    text = (f'import {{approvedRemote, REMOTE_NOTICE}} from {json.dumps(policy)};\n'
            "import AdapterConfig from '../components/Config.js';\n" + text)
    anchor = '  const accounts = usableGlobalAccounts()'
    if text.count(anchor) != 1:
        raise ValueError('Upstream remote account hook changed')
    text = text.replace(anchor, "  if (!approvedRemote(url, AdapterConfig.getConfig('config').remoteAccountAllowedUrls)) return {ok: false, skipped: 'not-approved', error: REMOTE_NOTICE}\n" + anchor)
    text = text.replace("      method: 'POST',", "      method: 'POST',\n      redirect: 'error',")
    text = text.replace('这个服务设了口令，插件连不上（让对方去掉服务端口令）',
                        '服务要求身份验证。请由服务提供者配置兼容的认证接入；不要关闭公网服务的认证。')
    remote.write_text(text, encoding='utf-8')
    for name in ('watchDeploy.js', 'campImDeploy.js'):
        file = target / 'apps' / name
        text = file.read_text(encoding='utf-8')
        anchor = '    const probe = await probeRemoteStatus(url)'
        if text.count(anchor) != 1:
            raise ValueError('Upstream remote connection hook changed: ' + name)
        text = f'import {{approvedRemote, REMOTE_NOTICE}} from {json.dumps(policy)};\n' + text
        text = text.replace(anchor, "    if (!approvedRemote(url, Config.getConfig('config').remoteAccountAllowedUrls)) return e.reply(REMOTE_NOTICE, shouldQuote())\n" + anchor)
        file.write_text(text, encoding='utf-8')
    for name in ('campIm.js', 'campFriend.js'):
        file = target/'apps'/name
        text = file.read_text(encoding='utf-8')
        anchor = "return e.reply('没发出去，稍后再试', shouldQuote())"
        if text.count(anchor) != 1:
            raise ValueError('Upstream IM failure hook changed: '+name)
        helper = (engine/'im-errors.mjs').resolve().as_uri()
        text = f'import {{imSendFailure}} from {json.dumps(helper)};\n'+text
        file.write_text(text.replace(anchor, 'return e.reply(imSendFailure(res), shouldQuote())'), encoding='utf-8')
    # Keep vendored files byte-exact; apply explicit adapter hooks only to runtime copies.
    for name in ('campImDeploy.js', 'watchDeploy.js'):
        file = target/'apps'/name
        text = file.read_text(encoding='utf-8')
        anchor = '      const startup = restarting'
        if text.count(anchor) != 1:
            raise ValueError('Upstream deployment hook changed: '+name)
        hook = """      await e.reply('正在自动检查并安装服务依赖，请稍候…', shouldQuote())
      const prepared = await gok.call('server_dependencies', {directory: SERVER_DIR})
      if (!prepared.ok) throw new Error(prepared.message)

"""
        if name == 'campImDeploy.js':
            upstream_hook = "      const nodeDependencies = await ensureDependencies({ needWs: true, nodeDir: SERVER_DIR, cfg: cfg(), logger })\n      if (!nodeDependencies.ok) throw new Error(nodeDependencies.messages.join('；'))"
            if text.count(upstream_hook) != 1:
                raise ValueError('Upstream IM dependency hook changed')
            text = text.replace(upstream_hook, '')
        file.write_text(text.replace(anchor, hook+anchor), encoding='utf-8')
    (destination / 'package.json').write_text('{"type":"module"}', encoding='utf-8')
    # npm dependencies are resolved by loader.mjs for upstream imports.
    for relative, text in {
        'lib/puppeteer/puppeteer.js': f'export {{default}} from {json.dumps((engine / "renderer.mjs").resolve().as_uri())};',
        'lib/common/common.js': 'export default {sleep:ms=>new Promise(r=>setTimeout(r,ms)),makeForwardMsg:async(e,rows)=>({type:"forward",rows:rows.map(message=>({message}))})};',
        'plugins/other/update.js': '''export class update extends plugin {
          async update(){return this.e.reply(await gok.call('upstream',{}))}
          getPlugin(){return true}
          async getLog(){return await gok.call('upstream',{})}
        }''',
    }.items():
        file = destination / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding='utf-8')
    (target / 'data/user_settings').mkdir(parents=True, exist_ok=True)
    for name, initial in {'UserData.yaml': {}, 'GameRecordPush.yaml': {'pushList': {}},
                          'user_settings.yaml': {}, 'gameStatsPushSettings.yaml': {}}.items():
        file=target/'data'/name
        if not file.exists(): file.write_text(yaml.safe_dump(initial),encoding='utf-8')
    defaults = yaml.safe_load((source / 'config/default_config/config.yaml').read_text(encoding='utf-8'))
    defaults['remoteAccountAllowedUrls'] = []
    config_file = target / 'config/config/config.yaml'
    config_file.parent.mkdir(parents=True, exist_ok=True)
    current = yaml.safe_load(config_file.read_text(encoding='utf-8')) if config_file.exists() else {}
    prior_ui_file = destination / 'last-ui-settings.json'
    prior_ui = json.loads(prior_ui_file.read_text(encoding='utf-8')) if prior_ui_file.exists() else {}
    # Preserve command-side changes when unchanged WebUI defaults are replayed at reload.
    ui = {key: settings.get(key, value) for key, value in defaults.items()}
    for key, value in ui.items():
        if key not in current or key not in prior_ui or value != prior_ui[key]:
            current[key] = value
    config_file.write_text(yaml.safe_dump(current, allow_unicode=True, sort_keys=False), encoding='utf-8')
    auth = yaml.safe_load((source/'config/default_config/auth.yaml').read_text(encoding='utf-8'))
    for key, value in auth.items():
        supplied = settings.get('auth_'+key, value)
        if isinstance(value, dict) and isinstance(supplied, str): supplied=json.loads(supplied)
        auth[key]=supplied
    (config_file.parent/'auth.yaml').write_text(yaml.safe_dump(auth,allow_unicode=True),encoding='utf-8')
    prior_ui_file.write_text(json.dumps(ui, ensure_ascii=False), encoding='utf-8')
    host_file = destination / 'config/config/other.yaml'
    host_file.parent.mkdir(parents=True, exist_ok=True)
    host_file.write_text(yaml.safe_dump({'blackUser': list(host_blacklist)}), encoding='utf-8')
    return target
