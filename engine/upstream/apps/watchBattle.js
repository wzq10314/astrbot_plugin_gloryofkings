/**
 * #营地观战 —— 看营地好友里谁正在打，挑一个开直播
 *
 * 数据全部来自**观战服务**（server/watch-server.js，pm2 托管的独立进程）：
 *   GET  /api/friends        → 好友里正在打的对局（带来源账号）
 *   POST /api/start          → 开一路直播，回这一路**专属的网址** /r/<房间号>/
 *   GET  /api/rooms          → 现在正在播的有哪几路
 *   POST /api/stop           → 收工（带 rid 停某一路，不带停全部）
 *
 * ⭐ **多路**：一个对局一路，每路一个独立网址，互不干扰。
 *    「一路一个账号」—— 所以能同时开几路，取决于有几个账号有好友（服务端回 free）。
 *    想看的那个好友被别人占着账号时，服务端会挑另一个也能看到 TA 的账号。
 *
 * 为什么不自己在插件里调营地接口：好友归属跟着**登录态账号**走，
 * 而插件的 api.js 走的是「全局账号轮询」那套，没法指定用哪个号；
 * 更关键的是**取流必须用「好友所在的那个账号」**（换号一律 -1003），
 * 所以「查列表」和「取流」必须绑在同一个账号上 —— 这件事交给服务端一体处理最省心。
 *
 * 服务没起来 / 没装 ffmpeg 时，这条指令会给出人话提示，而不是抛栈。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { AT_HEAD, stripAtText } from '../utils/atTarget.js'
import { shouldQuote } from '#utils'
import { Config } from '#components'
import authStore from '../utils/authStore.js'

/** 配置读取。改成配置项后不用重启（Config 挂了 chokidar） */
function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 服务地址（本机调） */
function apiBase () {
  return String(cfg().watchApiUrl || 'http://127.0.0.1:8899').replace(/\/+$/, '')
}

/**
 * 对外地址（发到群里给群友点的那个）。
 * 没配就退回服务地址 —— 本机跑没问题，但群友多半点不开，所以部署时该配成公网可达的。
 */
function publicBase () {
  const p = String(cfg().watchPublicUrl || '').trim()
  return (p || apiBase()).replace(/\/+$/, '')
}

/**
 * 发起人自己扫码登记的全局账号。
 *
 * 观战名单只能是「他自己的营地好友」，所以这里必须按属主取号，不能用全局账号池那套轮询
 * （轮到谁是谁，查出来会是别人的好友）。
 *
 * `includeOrphan` 只给主人开：2026-09-17 之前扫的全局账号没记 ownerBotUserId，
 * 而那时只有主人能发全局登录，所以那批无主的号一律算主人的。
 */
function myWatchers (e) {
  return authStore
    .listGlobalAccountsByOwner(e.user_id, { includeOrphan: Boolean(e.isMaster) })
    .map(account => String(account.userId))
    .filter(Boolean)
}

/** 调服务接口。服务没起来会抛，调用方统一兜住 */
async function callApi (path, { method = 'GET', body = null, timeout = 45000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(apiBase() + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    })
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      // ⚠️ 别把 HTTP 状态码写进 error —— 这串会原样发到群里（文案约定：不露实现细节）。
      //    真状态码留给日志。
      logger.error(`[营地观战] ${path} 返回的不是 JSON（HTTP ${r.status}）`)
      return { ok: false, error: '观战服务返回异常' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 「开局 3 分钟」。
 * 时间戳是 battleId 第三段换算来的（服务端已转成毫秒）。服务端时间和本地时钟
 * 可能有偏差，算出来是负数或超过一天就返回空串 —— 宁可不显示，也不能写个离谱的时长。
 */
function minsSince (ts) {
  if (!ts) return ''
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 0 || min > 24 * 60) return ''
  if (min < 1) return '刚开局'
  if (min < 60) return `开局 ${min} 分钟`
  return `开局 ${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

export class WatchBattle extends plugin {
  constructor () {
    super({
      name: '王者营地观战',
      dsc: '看营地好友谁在打，选一个开直播观战',
      event: 'message',
      // 完整锚定的短指令，抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: `${AT_HEAD}#(?:营地)?观战\\s*(.*)$`,
          fnc: 'watch'
        },
        // ⭐ 开播引导的入口：群里收到「某人开局 N 分钟，要不要开播」那条提示后，
        // 群友发这个就开「本群最近提示的那一场」。
        // 完整锚定，和上面那条观战指令不冲突（「开播」≠「观战」）
        {
          reg: '^#营地开播$',
          fnc: 'startHinted'
        }
      ]
    })
  }

  async watch (e) {
    const arg = stripAtText(e.msg).replace(/^#(?:营地)?观战\s*/, '').trim()
    // 运维词（#营地观战部署 / #营地观战服务）归 apps/watchDeploy.js 管 ——
    // 它 priority 是 -1、正常情况抢在前面就拦下了；这里再放行一次是兜底，
    // 万一 priority 语义变了，才不会掉进下面的序号解析里报一句「编号不对」。
    // `return false` = 不拦截，继续交给后面的 rule
    if (/^(部署|服务)$/.test(arg)) return false
    // ⚠️「停」「列表」「在播」放在最前判：别让它们掉进序号解析里去。
    // 停止不需要登录态：看的那一路可能是别人开的，谁在看谁就能收自己这一路。
    if (/^(停|停止|关|关闭|stop)$/i.test(arg)) return this.stopMine(e)
    // 全停：「停全部」「停 全部」「全停」都认（隔不隔空格都行）
    if (/^(?:停|停止|关|关闭)\s*全部$/.test(arg) || /^全(?:部)?(?:停|停止|关|关闭)$/.test(arg)) {
      return this.stopAll(e)
    }
    if (/^(停|停止|关|关闭)\s*(\d+)$/i.test(arg)) {
      return this.stopOne(e, Number(arg.match(/(\d+)/)[1]))
    }
    // ⚠️ 两个列表语义**完全不同**，别合并：
    //    · 「列表」= 谁在对局中（好友名单，编号给「#营地观战 N」选人开播用）
    //    · 「在播」= 现在有几路直播在跑（房间列表，编号给「停 N」用）
    //    以前「列表」指的是后者，主人明确纠正过：列表就该是「谁在打」。
    if (/^(在播|直播间|正在播|rooms?)$/i.test(arg)) return this.rooms(e)

    // 名单和开播都要用「发起人自己的营地好友」，没有他自己的登录态就无从下手
    const watchers = myWatchers(e)
    if (!watchers.length) {
      return e.reply(
        '要先登录自己的营地号才能看好友对局\n发送 #营地QQ全局登录 或 #营地wx全局登录 扫码',
        shouldQuote()
      )
    }

    // 「列表」和空参数等价：都是「谁在对局中」
    if (!arg || /^列表$/.test(arg)) return this.list(e, watchers)
    return this.start(e, arg, watchers)
  }

  /** 出名单 */
  async list (e, watchers) {
    let data
    try {
      data = await callApi(`/api/friends?watchers=${encodeURIComponent(watchers.join(','))}`)
    } catch (error) {
      logger.error(`[营地观战] 取好友列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) {
      return e.reply(`拿不到好友列表\n${data?.error || '稍后再试'}`, shouldQuote())
    }

    const playing = data.playing || []
    // 模板里不做计算：编号、显示用哪个名字、开局多久、能不能开，都在这里算好
    // ⚠️ `canWatch` 用**服务端算好的**那个 —— 它按「这个好友能被哪些账号看到、其中有没有空闲的」
    //    判，跟真正开播时 pickWatcher 的判据一致。
    //    别改回 `i < free`：`free` 是全体账号口径，跟某一行能不能开不是一回事。
    const rows = playing.map((p, i) => ({
      idx: i + 1,
      name: p.nick || p.campNick || '未知',
      avatar: p.avatar,
      jobName: p.jobName,
      minsText: minsSince(p.startTs),
      canWatch: p.canWatch !== false
    }))

    // 卡片不摆群名群头像：看的是全局账号的营地好友，跟从哪个群发指令无关
    const img = await this.shot({
      playing: rows,
      total: data.total || 0,
      online: data.online || 0,
      free: rows.filter(r => r.canWatch).length
    })

    // 这条指令跟「推送订阅」无关，所以不给按钮：
    // Button.push() 是「开启/关闭战绩推送」，摆在这儿容易被误触
    await e.reply(img || this.renderText(playing, data), shouldQuote())
  }

  /** 看现在正在播的有哪几路 */
  async rooms (e) {
    let data
    try {
      data = await callApi('/api/rooms')
    } catch (error) {
      logger.error(`[营地观战] 取直播间列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到直播间列表\n${data?.error || '稍后再试'}`, shouldQuote())

    const list = data.rooms || []
    if (!list.length) {
      return e.reply('现在没有在播的观战\n发送 #营地观战 看看好友里谁在打', shouldQuote())
    }
    const base = publicBase()
    const me = String(e.user_id || '')
    const lines = list.map((r, i) => {
      const extra = [r.recording ? '录制中' : '', `${r.clients} 人在看`].filter(Boolean).join(' · ')
      // 标出哪几路是自己开的 —— 「停 N」的 N 就是这个编号
      const mine = me && String(r.owner || '') === me ? '（你开的）' : ''
      return `${i + 1}. ${r.nick || r.rid}${mine}${extra ? `（${extra}）` : ''}\n${base}${r.url}`
    })
    const tail = '\n\n停自己开的：发 #营地观战 停\n停某一路：发 #营地观战 停 <上面的编号>'
    return e.reply(`📺 正在播的观战（${list.length}）\n\n${lines.join('\n')}${tail}`, shouldQuote())
  }

  /** 选了第 N 个 → 开一路直播 */
  async start (e, arg, watchers) {
    const n = Number(String(arg).match(/\d+/)?.[0])
    if (!n) {
      return e.reply(
        '用法：#营地观战 编号\n看谁在打：#营地观战 列表\n看正在播的：#营地观战 在播',
        shouldQuote()
      )
    }

    let data
    try {
      // 和出名单用同一个 watchers，序号才对得上（命中 90 秒缓存，不会重复打接口）
      data = await callApi(`/api/friends?watchers=${encodeURIComponent(watchers.join(','))}`)
    } catch (error) {
      logger.error(`[营地观战] 取好友列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到好友列表\n${data?.error || '稍后再试'}`, shouldQuote())

    const playing = data.playing || []
    const picked = playing[n - 1]
    if (!picked) {
      return e.reply(
        playing.length
          ? `没有第 ${n} 个，当前只有 ${playing.length} 个人在打`
          : '现在没有好友在对局里\n发送 #营地观战 看看最新名单',
        shouldQuote()
      )
    }

    await e.reply(`正在开播「${picked.nick || picked.campNick}」，稍等…`, shouldQuote())

    let res
    try {
      res = await callApi('/api/start', {
        method: 'POST',
        timeout: 60000,
        body: {
          // ⚠️ watcher 只是**首选**账号（好友所属的那个）；被占时服务端会从
          //    owners 里挑另一个也能看到 TA 的空闲账号（一个账号只能服务一路）
          watcher: picked.watcher,
          owners: picked.owners || [picked.watcher],
          battleID: picked.battleId,
          // ⚠️ 两个 ID 都要发：服务端拿 userID 取流、拿 roleId 轮询「这局还在不在」
          userID: picked.userId,
          roleId: picked.roleId,
          // 谁开的这一路 —— 多路下「停」只停自己开的，靠它认人
          owner: String(e.user_id || ''),
          nick: picked.nick || picked.campNick
        }
      })
    } catch (error) {
      logger.error(`[营地观战] 开播失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!res?.ok) {
      // 账号都占着 → 引导去看正在播的，而不是叫他重试
      if (res?.code === 'no-account') {
        return e.reply(`${res.error}\n发 #营地观战 在播 挑一个正在播的看`, shouldQuote())
      }
      // 其余失败：服务端已经把人话原因带回来了（「这个人现在不能被观战」之类），原样转达
      return e.reply(`${res?.error || '这局取不到画面'}\n重发 #营地观战 换一个试试`, shouldQuote())
    }

    // ⭐ 每一路一个**独立网址**（带房间号），两个人可以同时看不同的对局
    const url = `${publicBase()}${res.url || '/'}`
    await e.reply(
      // ⚠️ 别报「开局约 2 分钟」这种假数 —— 后台只知道「这一刻还没拿到画面」，
      //    跟开局多久无关（实测有一局开局 175 秒了照样要等 75 秒）。
      //    只说「在等画面 + 通常多快」，别替营地编理由。
      res.pending ? `直播间：${url}\n画面马上就来，最长等 1 分钟左右` : `直播间：${url}`,
      shouldQuote()
    )
  }

  /**
   * `#营地开播` —— 开「本群最近提示的那一场」。
   *
   * 来龙去脉：订阅了上下线提醒的人上线后，后台会盯他进对局；进对局满 N 分钟且
   * **确认能看**（是好友 + 排位/巅峰 + 没隐私）时往群里发一条「要不要开播」的提示，
   * 同时把那一场的坐标记到观战服务。这条指令就是那个提示的入口。
   *
   * ⚠️ **坐标存服务端**：`watcher`/`owners`（这个好友能被哪些账号看到）只有服务端知道，
   *    而取流必须用「加了这个好友的那个账号」（换号一律 -1003）。
   *
   * ⚠️ **现查**：提示发出后对局可能已经打完了，直接开播会得到一个死房间。
   *    所以这里重新查一次，打完就明确告诉用户，而不是让他等一个永远转圈的页面。
   */
  async startHinted (e) {
    const gid = String(e.group_id || '')
    if (!e.isGroup || !gid) {
      return e.reply('这个指令要在群里发（开的是本群最近提示的那一场）', shouldQuote())
    }

    let data
    try {
      data = await callApi(`/api/hint/latest?group=${encodeURIComponent(gid)}`)
    } catch (error) {
      logger.error(`[营地观战] 取开播提示失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到开播提示\n${data?.error || '稍后再试'}`, shouldQuote())

    const hint = data.hint
    if (!hint?.battleID) {
      return e.reply('本群还没有开播提示\n发送 #营地观战 看看好友里谁在打', shouldQuote())
    }

    // 现查：这一局还在不在。对局结束后营地不会立刻清 battleId，所以不能只看「有没有值」，
    // 要比 battleId 是否还是同一局 —— 变了说明他开了下一把，那这一场也已经结束了。
    //
    // ⚠️ **不带 `refresh=1`**：那会强制绕过服务端 90 秒缓存，每次开播都把池子里所有账号
    //    挨个查一遍（一个请求/账号）。群里几个人连着发 `#营地开播` 就是连打，有频控风险
    //    （命中要静默 12 小时）。缓存最多旧 90 秒，对「这局还在不在」这个判断完全够用 ——
    //    真要是刚好在这 90 秒里打完了，`/api/start` 那边取流会回 -1005，照样兜得住。
    // ⚠️ 复查要**带上这一场的账号范围**（owners / watcher），别裸调 `/api/friends`：
    //    服务端对空 watchers 会退回「整个账号池」（wanted=null），缓存 key 还变成 '*'
    //    —— 跟 scoped 的桶是两份缓存。也就是说，为了确认「这局还在不在」，
    //    反而把池子里每个号都探了一遍，跟上面「不带 refresh 防频控」的初衷正好相反。
    //    用 owners（= 当初能看到这个好友的那些账号）最准：那一场本来就是它们看到的。
    const scope = (Array.isArray(hint.owners) && hint.owners.length ? hint.owners : [hint.watcher]).filter(Boolean)
    let now
    try {
      now = await callApi('/api/friends' + (scope.length ? `?watchers=${encodeURIComponent(scope.join(','))}` : ''))
    } catch (error) {
      logger.error(`[营地观战] 开播前复查失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    const still = (now?.playing || []).find(p => String(p.battleId) === String(hint.battleID))
    if (!still) {
      return e.reply('这一局已经打完了\n发送 #营地观战 看看最新名单', shouldQuote())
    }

    await e.reply(`正在开播「${still.nick || hint.nick || '对局'}」，稍等…`, shouldQuote())

    let res
    try {
      res = await callApi('/api/start', {
        method: 'POST',
        timeout: 60000,
        body: {
          // ⚠️ watcher 只是首选；被占时服务端从 owners 里挑另一个也能看到 TA 的空闲账号
          watcher: still.watcher || hint.watcher,
          owners: still.owners || hint.owners || [],
          battleID: still.battleId,
          // ⚠️ 两个 ID 都要发：服务端拿 userID 取流、拿 roleId 轮询「这局还在不在」
          userID: still.userId,
          roleId: still.roleId,
          owner: String(e.user_id || ''),
          nick: still.nick || still.campNick
        }
      })
    } catch (error) {
      logger.error(`[营地观战] 开播失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!res?.ok) {
      if (res?.code === 'no-account') {
        return e.reply(`${res.error}\n发 #营地观战 在播 挑一个正在播的看`, shouldQuote())
      }
      return e.reply(`${res?.error || '这局取不到画面'}\n重发 #营地观战 换一个试试`, shouldQuote())
    }

    const url = `${publicBase()}${res.url || '/'}`
    await e.reply(
      res.pending ? `直播间：${url}\n画面马上就来，最长等 1 分钟左右` : `直播间：${url}`,
      shouldQuote()
    )
  }

  /**
   * 收工：只停**自己开的**那几路。
   *
   * ⚠️ 多路之后这条必须按发起人停 —— 裸「停」原先是全停，
   *    群里谁顺手发一句就会把别人正在看的直播间一起掐掉（实测两路全灭）。
   *    要全停请发「#营地观战 停全部」。
   */
  async stopMine (e) {
    // ⚠️ 拿不到发起人 QQ 就别发这个请求：服务端按 owner 停，空 owner 会掉进
    //    「没 rid 就全停」的分支，把别人正在看的几路一起掐掉（服务端已加拒空，
    //    这里再挡一道，用户看到的是人话而不是「停不了」）
    const me = String(e.user_id || '')
    if (!me) return e.reply('认不出你是哪个号，发不了停止\n请主人发 #营地观战 停 全部 收工', shouldQuote())
    try {
      const res = await callApi('/api/stop', {
        method: 'POST',
        body: { owner: me }
      })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      const n = Number(res.stopped || 0)
      return e.reply(
        n ? `已停止你开的 ${n} 路观战` : '你没有正在播的观战\n发 #营地观战 在播 看现在有哪几路',
        shouldQuote()
      )
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /** 收工：全部停掉（别的群友开的那几路也会停，所以文案要说清） */
  async stopAll (e) {
    try {
      const res = await callApi('/api/stop', { method: 'POST', body: { owner: '*' } })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      const n = Number(res.stopped || 0)
      return e.reply(n ? `已停止全部 ${n} 路观战` : '现在没有在播的观战', shouldQuote())
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /** 收工：只停第 N 路（编号看 #营地观战 在播） */
  async stopOne (e, n) {
    let data
    try {
      data = await callApi('/api/rooms')
    } catch (error) {
      logger.error(`[营地观战] 取直播间列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    const list = data?.rooms || []
    const target = list[n - 1]
    if (!target) {
      return e.reply(
        list.length
          ? `没有第 ${n} 路，现在有 ${list.length} 路\n发 #营地观战 在播 看编号`
          : '现在没有在播的观战',
        shouldQuote()
      )
    }
    try {
      const res = await callApi('/api/stop', { method: 'POST', body: { rid: target.rid } })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      return e.reply(`已停止「${target.nick || target.rid}」这一路`, shouldQuote())
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /** 服务没起来时的提示：说清发生了什么 + 下一步做什么 */
  serviceDownText (error) {
    const hint = /abort|timeout/i.test(error?.message || '')
      ? '观战服务没响应'
      : '观战服务没在跑'
    const master = '请主人发 #王者设置 检查观战服务地址，或到服务器上确认 gok-watch 进程还在'
    return `${hint}\n${master}`
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('WatchBattle', {
        imgType: 'webp',
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/WatchBattle.html',
        // 漏了这行样式表会 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        title: '营地观战',
        subText: '好友里正在打的对局',
        ...view
      })
    } catch (error) {
      logger.error(`[王者营地观战] 渲染失败: ${error.message}`)
      return null
    }
  }

  /** 出图挂了时的纯文字兜底 */
  renderText (playing, data = {}) {
    const lines = ['🎮 营地观战']
    if (!playing.length) {
      lines.push('', '好友里现在没人在打')
      if (data.online) lines.push(`有 ${data.online} 人在线但没开局`)
      return lines.join('\n')
    }
    lines.push('', `⚔️ 正在对局（${playing.length}）`)
    playing.forEach((p, i) => {
      const mins = p.startTs ? Math.max(0, Math.floor((Date.now() - p.startTs) / 60000)) : 0
      const extra = [p.jobName, mins ? `开局 ${mins} 分钟` : ''].filter(Boolean).join(' · ')
      // ⚠️⚠️ 必须用**服务端算好的** `canWatch`，别用 `i < free` ——
      //    `free` 是**全体账号**口径（池子里还有几个空闲号），而这一行能不能开取决于
      //    「这个好友能被哪几个账号看到、其中有没有空闲的」，两者不是一回事。
      //    用 `i < free` 会**报错行**：可能标着能看、实际开播时 pickWatcher 挑不出号
      //    （出图那份 rows 早就改对了，这里漏改 —— 出图挂了时用户反而看到错的）。
      const can = p.canWatch === false ? '（账号占着）' : ''
      lines.push(`${i + 1}. ${p.nick || p.campNick}${extra ? `（${extra}）` : ''}${can}`)
    })
    lines.push('', '发送 #营地观战 序号 开播')
    return lines.join('\n')
  }
}
