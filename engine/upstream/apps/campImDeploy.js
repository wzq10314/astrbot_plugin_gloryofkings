/**
 * 营地消息服务端的**一键部署**：#营地消息部署 / #营地消息服务。
 *
 * ## 服务端代码从哪来
 *
 * **不在 master 上** —— 单独住在仓库的 **`im-server` 分支**里。部署时把那个分支
 * 浅克隆到 `<插件>/server-im/`，`.gitignore` 把整个 `server-im/` 挡住，所以：
 *   · 客户端的插件更新（拉 master）永远碰不到服务端代码
 *   · 服务端也不用跟着插件的发版节奏走
 *
 * ⚠️ 分支名是 `im-server`。**别和另外两个搞混**：
 *   · `watch-server` → 营地观战服务（apps/watchDeploy.js，落在 `server/`）
 *   · `server`       → 营地ID共享库（apps/shareDeploy.js）
 *
 * ## 为什么部署在插件目录里
 *
 * 服务端要读 `data/AuthPool.json`。留在 `server-im/` 下，`HERE/..` 这个相对路径
 * 天然成立 —— 一行路径代码都不用改。它也自带一份零依赖的 `lib/xxtea.js`，
 * 不依赖插件本体的 utils（服务端是独立进程，import 不了那边的云崽运行时依赖）。
 *
 * ## 两条硬规矩（跟 watchDeploy / shareDeploy 同源）
 *
 * 1. **只动自己起的那个进程**：cwd 或入口脚本必须落在本插件的 server-im 目录下。
 *    光比进程名会把别人的同名进程停掉 —— 这条教训是从 meme 的卸载逻辑带过来的。
 * 2. **认不出就不动**：`server-im/` 存在、没 `.git`、里面又没有 `camp-im-server.js`
 *    （认不出是我们的目录）→ 拒绝，让主人自己确认。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache, isOurProcess } from '../utils/pm2.js'
import {
  installPackage, fetchPackageMeta, probeStatus, waitStatus, fmtUptime,
  normalizeBase, STATE_FILE
} from '../utils/deploy.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 服务端代码解到这里（在插件目录里，被 .gitignore 挡着，不跟插件本体一起提交） */
const SERVER_DIR = path.join(PluginPath, 'server-im')
const ENTRY_FILE = path.join(SERVER_DIR, 'camp-im-server.js')

/** 分发服务上的包名（对应 `im-server` 分支） */
const PKG_NAME = 'im'

const PROC_NAME = 'gok-im'
const DEFAULT_PORT = 8900

/** 引导语：没配分发服务时统一用这句 */
const GROUP_HINT = '进群 972915804 找主人要部署地址和令牌，然后发 #营地消息接入 <地址> <令牌>'

/**
 * 解下来之后必须齐活的文件。少一个服务端起不来。
 *
 * ⚠️ `lib/xxtea.js` 由**代码包**提供（服务端自带一份零依赖的），
 *    和观战那边从插件本体读 `utils/xxtea.js` 的做法不同 ——
 *    因为 IM 服务端完全不需要云崽运行时。
 */
const NEEDED = [
  'server-im/camp-im-server.js',
  'server-im/lib/xxtea.js'
]

/* ------------------------------------------------------------ 小工具 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 分发服务的地址 + 令牌（观战和营地消息共用同一套） */
function distConfig () {
  const c = cfg()
  return {
    url: normalizeBase(c.distUrl),
    token: String(c.distToken || '').trim()
  }
}

/** 服务端在哪个端口：从配置的服务地址里抠，抠不到按默认 */
function serverPort () {
  const m = String(cfg().campImApiUrl || '').match(/:(\d+)/)
  return m ? Number(m[1]) : DEFAULT_PORT
}

/* ------------------------------------------------------------ 插件 */

export class CampImDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地消息运维',
      dsc: '部署 / 查看营地消息服务端',
      event: 'message',
      // ⚠️ 必须是负的：`#营地消息` 那条规则是精确匹配 `^#营地消息$`，
      //    `#营地消息部署` 不会被它吃掉，但保险起见和 watchDeploy 保持一致。
      priority: -1,
      rule: [
        // 一步到位：写配置 + 立刻部署。主人和群友用的是同一条
        // （群友装了这个插件之后，在他自己那台机器人上就是主人）
        { reg: '^#营地消息接入\\s+(\\S+)\\s+(\\S+)$', fnc: 'connect', permission: 'master' },
        { reg: '^#营地消息部署$', fnc: 'deploy', permission: 'master' },
        { reg: '^#营地消息服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 接入 */

  /**
   * 一步接入：`#营地消息接入 <地址> <令牌>`。
   *
   * **先试连再落盘** —— 地址或令牌写错了要当场知道，而不是等发部署指令时才报错。
   */
  async connect (e) {
    const m = /^#营地消息接入\s+(\S+)\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地消息接入 <地址> <令牌>', shouldQuote())

    const url = normalizeBase(m[1])
    const token = m[2].trim()

    if (!/^https?:\/\//i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    if (token.length < 20) {
      return e.reply('令牌看着不对（太短了）。' + GROUP_HINT, shouldQuote())
    }

    const probe = await fetchPackageMeta({ name: PKG_NAME, url, token })
    if (!probe.ok) {
      return e.reply(
        `连不上分发服务：${probe.message}\n` +
        '地址和令牌都没错的话，' + GROUP_HINT,
        shouldQuote()
      )
    }

    Config.modify('config', 'distUrl', url)
    Config.modify('config', 'distToken', token)
    logger.mark(`[${PluginName}] 已接入分发服务：${url}`)

    return this.deploy(e, { adopted: true })
  }

  /* -------------------------------------------------------- 部署 */

  async deploy (e, { adopted = false } = {}) {
    if (!pm2Bin()) {
      return e.reply(
        '没找到 pm2，先装一个再部署：npm i -g pm2\n' +
        '（装完如果还报找不到，重启一下云崽让它认出新的 PATH）',
        shouldQuote()
      )
    }

    const { url, token } = distConfig()
    if (!url || !token) {
      return e.reply(
        adopted
          ? '配置没写进去，重发一次试试'
          : `还没接入分发服务。${GROUP_HINT}`,
        shouldQuote()
      )
    }

    // 同名进程但不是我们起的 —— 别去碰它，只说清楚（见文件头第 1 条规矩）
    const running = pm2Proc(PROC_NAME)
    if (running && !isOurProcess(running, SERVER_DIR)) {
      return e.reply([
        `有个叫 ${PROC_NAME} 的 pm2 进程，但跑的不是本插件的营地消息服务，没有动它。`,
        `（它的目录是 ${running.pm2_env?.pm_cwd || '未知'}）`
      ].join('\n'), shouldQuote())
    }

    // 认不出是我们的目录 → 拒绝动它（见文件头第 2 条规矩）
    const hasState = fs.existsSync(path.join(SERVER_DIR, STATE_FILE))
    if (fs.existsSync(SERVER_DIR) && !fs.existsSync(ENTRY_FILE) && !hasState) {
      return e.reply(
        `${path.relative(YunzaiRoot, SERVER_DIR)} 已经存在，但里面没有 camp-im-server.js —— ` +
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署',
        shouldQuote()
      )
    }

    const restarting = Boolean(running)
    await e.reply(
      restarting
        ? '正在更新营地消息服务…'
        : '正在部署营地消息服务（要从分发服务下载代码），几十秒就好…',
      shouldQuote()
    )

    try {
      // 老布局遗留：以前是 git 浅克隆，现在不用 git 了，把 .git 清掉免得困惑
      const oldGit = path.join(SERVER_DIR, '.git')
      if (fs.existsSync(oldGit)) {
        try {
          fs.rmSync(oldGit, { recursive: true, force: true })
          logger.mark(`[${PluginName}] 清掉旧的 .git（服务端代码现在从分发服务下载）`)
        } catch (error) {
          logger.warn(`[${PluginName}] 清旧 .git 失败（不影响部署）：${error?.message || error}`)
        }
      }

      const installed = await installPackage({
        name: PKG_NAME,
        url,
        token,
        destDir: SERVER_DIR,
        entry: 'camp-im-server.js',
        logger
      })
      if (!installed.ok) {
        throw new Error(`${installed.message}\n如果地址令牌没问题，${GROUP_HINT}`)
      }

      const missing = NEEDED.filter(f => !fs.existsSync(path.join(PluginPath, f)))
      if (missing.length) {
        throw new Error(`服务端文件不齐，缺：${missing.join('、')}`)
      }

      const startup = restarting
        ? pm2(['restart', PROC_NAME, '--update-env'], { timeout: 60000 })
        : pm2([
            'start', ENTRY_FILE,
            '--name', PROC_NAME,
            '--interpreter', 'node',
            '--cwd', SERVER_DIR
          ], { timeout: 60000 })

      if (!startup.ok) {
        throw new Error(`pm2 ${restarting ? '重启' : '启动'}失败：${startup.err || startup.out || '未知原因'}`)
      }

      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) logger.warn(`[${PluginName}] pm2 save 失败，开机自启可能没生效：${saved.err || saved.out}`)

      const port = serverPort()
      const status = await waitStatus(port)
      if (!status) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 营地消息服务起了但状态接口不通：${logs.out || logs.err}`)
        throw new Error('进程起了但状态接口没通，日志在 pm2 里，先发 #营地消息服务 看看')
      }

      resetPm2Cache()
      logger.mark(
        `[${PluginName}] 营地消息服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}` +
        `（${SERVER_DIR}，版本 ${String(installed.sha).slice(0, 8)}${installed.updated ? '' : '，已是最新'}）`
      )

      const online = (status.clients || []).filter(c => c.state === 'online').length
      const total = (status.clients || []).length
      const lines = [
        `✅ 营地消息服务${restarting ? '已更新' : '部署好了'}`,
        '',
        `进程：${PROC_NAME}（pm2 托管，开机自启）`,
        `端口：${port}`,
        `账号：${online}/${total} 在线`
      ]

      if (!total) {
        lines.push('', '还没有可用的营地账号\n发 #营地wx全局登录 扫码添加')
      }

      if (!installed.updated && restarting) {
        lines.push('', '代码本来就是最新的，只重启了一遍。')
      }

      lines.push('', '看状态：发 #营地消息')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署营地消息服务失败：${error?.stack || error}`)
      return e.reply(`❌ 部署失败：${error?.message || error}`, shouldQuote())
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const port = serverPort()
    const lines = ['📨 营地消息服务']

    if (!proc) {
      lines.push('', '没在跑', `发 #营地消息部署 装一个（${GROUP_HINT}）`)
      return e.reply(lines, shouldQuote())
    }
    if (!isOurProcess(proc, SERVER_DIR)) {
      lines.push('', `有个叫 ${PROC_NAME} 的进程，但不是本插件起的，没有动它`)
      return e.reply(lines, shouldQuote())
    }

    lines.push('', `进程：${proc.pm2_env?.status || '未知'}`)
    lines.push(`已跑：${fmtUptime(Date.now() - (proc.pm2_env?.pm_uptime || 0))}`)
    const restarts = proc.pm2_env?.restart_time
    if (restarts) lines.push(`重启次数：${restarts}`)
    lines.push(`端口：${port}`)

    const status = await probeStatus(port)
    if (!status) {
      lines.push('', '⚠️ 状态接口不通，先看看 pm2 日志')
    } else {
      const clients = status.clients || []
      const online = clients.filter(c => c.state === 'online').length
      lines.push(`账号：${online}/${clients.length} 在线`)
      if (status.queue) lines.push(`待处理：${status.queue.lastId || 0} 条`)
    }

    return e.reply(lines, shouldQuote())
  }
}
