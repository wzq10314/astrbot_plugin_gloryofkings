import path from 'path'
import { writeYamlFile, readYamlFile, Button, AT_HEAD, AT_TAIL, stripAtText, resolveTargetUserId, shouldQuote, invalidateShareCache, querySharedBind, listHiddenProfiles, clearHiddenProfile, clearAllHiddenProfiles } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, PluginPath } from '#components'
import authStore from '../utils/authStore.js'
import { syncUserBind } from '../utils/shareUsers.js'
import { fetchRoleNames } from '../utils/roleName.js'
import {
  createWechatLoginSession,
  waitForWechatLogin
} from '../utils/wechatLogin.js'
import {
  createQQLoginSession,
  waitForQQLogin
} from '../utils/qqLogin.js'

const pendingWechatLoginMap = new Map()
const LOGIN_QR_RECALL_SECONDS = 175
const LOGIN_SCAN_STATUS_RECALL_SECONDS = 60

export class AccountManager extends plugin {
  constructor() {
    super({
      name: '王者账号管理',
      dsc: '王者账号管理',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: new RegExp(`${AT_HEAD}#(?:营地|我的(?:王者|荣耀|农药)|(?:王者|荣耀|农药))ID${AT_TAIL}`, 'i'),
          fnc: 'myWzryId'
        },
        {
          reg: /^#(?:获取|怎么看|如何获取)营地ID$/i,
          fnc: 'howToGetWzryId'
        },
        {
          reg: `${AT_HEAD}#绑定营地\\s*(.*)$`,
          fnc: 'bindWzryId'
        },
        {
          reg: `${AT_HEAD}#切换营地\\s*(.*)$`,
          fnc: 'switchWzryId'
        },
        {
          reg: `${AT_HEAD}#删除营地\\s*(.*)$`,
          fnc: 'deleteWzryId'
        },
        // 两条全局登录**所有人都能发**：登录态记在扫码人自己名下（ownerBotUserId），
        // #营地观战 就靠它认「谁的营地好友」。谁扫的号只喂谁的观战名单，
        // 不会因为开放就串到别人的好友列表上。
        // 扫码成功后顺手把这个号绑定给扫码人，省掉再发一条 #绑定营地。
        {
          reg: new RegExp('^#营地wx全局登录$', 'i'),
          fnc: 'wechatGlobalScanLogin'
        },
        // 两条登录一律带 `i`：手机上打「qq」「wx」比大写顺手，
        // 用户不该为了大小写重发一遍。字符串形式的 reg 没法写内联标志，
        // 但 Yunzai 收 RegExp 对象（同文件那几条 ID 指令就是这么写的）
        {
          reg: new RegExp('^#营地QQ全局登录$', 'i'),
          fnc: 'qqGlobalScanLogin'
        },
        {
          reg: '^#王者用户统计$',
          fnc: 'showAuthPool',
          permission: 'master'
        },

        {
          reg: '^#清理失效营地账号$',
          fnc: 'clearInvalidCampAuth',
          permission: 'master'
        },
        {
          reg: '^#隐藏主页名单$',
          fnc: 'showHiddenProfiles',
          permission: 'master'
        },
        {
          reg: '^#清除隐藏主页\\s*(.*)$',
          fnc: 'clearHiddenProfiles',
          permission: 'master'
        }
      ]
    })
  }

  // 主人可以艾特别人代为操作（真 at 段与纯文本 @昵称都认），其他人只能操作自己
  // 返回空串表示 @ 的人没认出来，提示已经回给用户了
  async getReplyUserId(e) {
    const { userId, hint } = await resolveTargetUserId(e, { requireMaster: true })
    if (hint) {
      await e.reply(hint)
      return ''
    }
    return userId
  }

  // 获取用户数据
  getUserData(userId) {
    const filePath = path.join(PluginData, 'UserData.yaml')
    const userData = readYamlFile(filePath) || {}

    if (!userData[userId]) {
      userData[userId] = {
        ids: [],
        current: 0
      }
    }

    return { userData, filePath }
  }

  // 保存用户数据
  saveUserData(filePath, userData) {
    writeYamlFile(filePath, userData)
  }

  /**
   * 本地绑定变动后和共享库对一次账。
   *
   * 两件事：
   *  - 清掉这个 QQ 的共享缓存。本地值本来就会压住缓存值，但**删除/切换时必须清**——
   *    否则那份从共享库拿来的旧值会在本地已经没有之后继续被解析出来
   *  - 开了共享的人顺带把新绑定传上去。**故意不 await**：共享库是别人搭的外部依赖，
   *    它慢或者挂了都不该拖住「绑定成功」这个动作
   */
  syncShareAfterBind(userId) {
    invalidateShareCache(userId)
    syncUserBind(userId).catch(() => {})
  }

  // 新增公共方法处理HTML生成
  async generateAccountManageHTML(type, wzryId, idList, wzryName = '') {
    const parsedFuncs = [
      { cmd: '#绑定营地', example: '示例: #绑定营地 123' },
      { cmd: '#营地ID / #王者ID / #我的ID / #我的王者ID', example: '示例: #我的王者ID' },
      { cmd: '#切换营地', example: '示例: #切换营地2' },
      { cmd: '#删除营地', example: '示例: #删除营地2' },
      { cmd: '#营地wx全局登录 / #营地QQ全局登录', example: '示例: #营地wx全局登录' },
      { cmd: '#王者主页 / #全部王者主页', example: '示例: #王者主页2' },
      { cmd: '#查询战绩 / #查询N战绩', example: '示例: #查询2战绩' },
      { cmd: '#王者帮助', example: '示例: #王者帮助' }
    ]

    return await puppeteer.screenshot('accountManage', {
      imgType: 'webp',
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/accountManage.html',
      type,
      wzryId,
      wzryName,
      idList,
      parsedFuncs,
      timestamp: new Date().toLocaleString()
    })
  }

  async generateAuthPoolOverviewHTML(data) {
    return await puppeteer.screenshot('authPoolOverview', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/authPoolOverview.html',
      imgType: 'webp',
      ...data
    })
  }

  maskId(value, keepStart = 3, keepEnd = 3) {
    const text = String(value || '')
    if (!text) {
      return '未绑定'
    }

    if (text.length <= keepStart + keepEnd) {
      return text
    }

    return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
  }

  buildAuthPoolOverviewData() {
    const pool = authStore.getPool()
    const accounts = authStore.listAccounts()
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const boundUsers = Object.entries(userData)
      .map(([qqId, info]) => ({
        qqId: String(qqId),
        ids: Array.isArray(info?.ids) ? info.ids.map(id => String(id)) : [],
        current: Number(info?.current || 0)
      }))
      .filter(item => item.ids.length)

    const ownerMap = new Map()
    for (const boundUser of boundUsers) {
      ownerMap.set(boundUser.qqId, {
        qqId: boundUser.qqId,
        maskedQqId: this.maskId(boundUser.qqId, 3, 2),
        boundCampIds: boundUser.ids,
        currentCampId: boundUser.ids[boundUser.current] || boundUser.ids[0] || '',
        currentMaskedCampId: this.maskId(boundUser.ids[boundUser.current] || boundUser.ids[0] || '', 3, 3),
        tokens: []
      })
    }

    const unownedAccounts = []
    for (const account of accounts) {
      const ownerBotUserId = String(account.ownerBotUserId || '')
      const tokenItem = {
        campUserId: account.userId,
        maskedCampUserId: this.maskId(account.userId, 3, 3),
        nickname: account.nickname || account.userName || '未命名账号',
        statusClass: account.authInvalid ? 'invalid' : 'valid'
      }

      if (ownerBotUserId) {
        if (!ownerMap.has(ownerBotUserId)) {
          ownerMap.set(ownerBotUserId, {
            qqId: ownerBotUserId,
            maskedQqId: this.maskId(ownerBotUserId, 3, 2),
            boundCampIds: [],
            currentCampId: '',
            currentMaskedCampId: '未绑定',
            tokens: []
          })
        }

        ownerMap.get(ownerBotUserId).tokens.push(tokenItem)
      } else {
        unownedAccounts.push(tokenItem)
      }
    }

    const allOwnerSections = [...ownerMap.values()]
      .sort((left, right) => left.qqId.localeCompare(right.qqId))
      .map(owner => {
        const tokenMap = new Map(owner.tokens.map(item => [item.campUserId, item]))
        const mergedCampIds = [...new Set([
          ...owner.boundCampIds,
          ...owner.tokens.map(item => item.campUserId)
        ])]
        const validTokenCount = owner.tokens.filter(item => item.statusClass === 'valid').length
        const invalidTokenCount = owner.tokens.length - validTokenCount
        return {
          ...owner,
          tokenCount: owner.tokens.length,
          validTokenCount,
          invalidTokenCount,
          uidEntries: mergedCampIds.map(campUserId => {
            const token = tokenMap.get(campUserId)
            const isCurrent = owner.currentCampId && owner.currentCampId === campUserId
            return {
              campUserId,
              maskedCampUserId: this.maskId(campUserId, 3, 3),
              isCurrent,
              badgeText: token ? 'Token' : '无',
              badgeClass: token ? token.statusClass : 'none'
            }
          })
        }
      })
    const displayedOwnerSections = allOwnerSections.slice(0, 60)
    const omittedOwnerCount = Math.max(0, allOwnerSections.length - displayedOwnerSections.length)

    const overviewCards = [
      {
        label: '绑定QQ',
        value: String(boundUsers.length),
        tone: 'blue'
      },
      {
        label: '营地ID',
        value: String(boundUsers.reduce((sum, item) => sum + item.ids.length, 0)),
        tone: 'cyan'
      },
      {
        label: '持有TokenQQ',
        value: String(allOwnerSections.filter(item => item.tokenCount > 0).length),
        tone: 'green'
      },
      {
        label: 'Token总数',
        value: String(accounts.length),
        tone: 'purple'
      },
      {
        label: '可用',
        value: String(accounts.filter(account => !account.authInvalid).length),
        tone: 'emerald'
      },
      {
        label: '失效',
        value: String(accounts.filter(account => account.authInvalid).length),
        tone: 'red'
      }
    ]

    return {
      timestamp: new Date().toLocaleString(),
      overviewCards,
      ownerSections: displayedOwnerSections,
      omittedOwnerCount,
      unownedAccounts
    }
  }

  async replyBindResultCard(e, botUserId, wzryId) {
    const { filePath } = this.getUserData(botUserId)
    const nextUserData = readYamlFile(filePath) || {}
    const currentUserInfo = nextUserData[botUserId] || {
      ids: [wzryId],
      current: 0
    }

    // 昵称跟 ID 一起给：只看一串数字认不出是谁的号
    const nameMap = await fetchRoleNames(currentUserInfo.ids, botUserId)
    const idList = this.formatIdList(currentUserInfo, nameMap)
    const html = await this.generateAccountManageHTML('绑定', wzryId, idList, nameMap[wzryId])
    await e.reply([html, Button.homepage(wzryId)])
  }

  // 绑定ID
  async bindWzryId(e) {
    // 只在群里绑：这张绑定表（UserData.yaml）只存 QQ ↔ 营地ID，本身不带群信息，
    // 而绑定之后的用途（群推送、#谁在打游戏 名单）全是按群来的 —— 私聊里绑出来
    // 的绑定没有能用的地方，拦掉免得用户绑完不知道去哪儿开。
    if (!e.isGroup) {
      await e.reply(['绑定营地需要在群里进行，请到群里发送 #绑定营地 [营地ID]', Button.bind()])
      return
    }

    let userId = await this.getReplyUserId(e)
    if (!userId) return
    // 指令与ID之间允许有空格：#绑定营地123 与 #绑定营地 123 等价
    const wzryId = stripAtText(e.msg).replace(/^#绑定营地\s*/, '').trim()
    if (!/^\d+$/.test(wzryId)) {
      await e.reply(['营地ID仅支持数字，示例: #绑定营地123 或 #绑定营地 123', Button.bind()])
      return
    }
    const { userData } = this.getUserData(userId)

    if (userData[userId].ids.includes(wzryId)) {
      // 重复绑定也把昵称带上，不然用户看着两个数字对不上是谁
      const nameMap = await fetchRoleNames([wzryId], userId)
      await e.reply([`该ID已经绑定过了${nameMap[wzryId] ? `：${wzryId} ${nameMap[wzryId]}` : ''}`, Button.homepage(wzryId)])
      return
    }

    authStore.bindCampUserId(userId, wzryId)
    this.syncShareAfterBind(userId)
    await this.replyBindResultCard(e, userId, wzryId)
  }

  // 切换ID
  async switchWzryId(e) {
    let userId = await this.getReplyUserId(e)
    if (!userId) return
    const index = parseInt(stripAtText(e.msg).replace(/^#切换营地\s*/, '')) - 1
    const { userData, filePath } = this.getUserData(userId)

    if (!userData[userId].ids.length) {
      await e.reply(['您还没有绑定任何ID，请先绑定', Button.bind()])
      return
    }

    if (index < 0 || index >= userData[userId].ids.length) {
      await e.reply('序号无效，请输入正确的序号')
      return
    }

    userData[userId].current = index
    this.saveUserData(filePath, userData)
    this.syncShareAfterBind(userId)

    const currentId = userData[userId].ids[index]
    const nameMap = await fetchRoleNames(userData[userId].ids, userId)
    const idList = this.formatIdList(userData[userId], nameMap)
    const html = await this.generateAccountManageHTML('切换', currentId, idList, nameMap[currentId])
    await e.reply([html, Button.homepage(currentId)])
  }

  // 删除ID
  async deleteWzryId(e) {
    let userId = await this.getReplyUserId(e)
    if (!userId) return
    const index = parseInt(stripAtText(e.msg).replace(/^#删除营地\s*/, '')) - 1
    const { userData, filePath } = this.getUserData(userId)

    if (!userData[userId].ids.length) {
      await e.reply(['您还没有绑定任何ID', Button.bind()])
      return
    }

    if (index < 0 || index >= userData[userId].ids.length) {
      await e.reply('序号无效，请输入正确的序号')
      return
    }

    const deletedId = userData[userId].ids[index]
    userData[userId].ids.splice(index, 1)

    // 调整current索引
    if (userData[userId].current >= userData[userId].ids.length) {
      userData[userId].current = Math.max(0, userData[userId].ids.length - 1)
    }

    this.saveUserData(filePath, userData)
    this.syncShareAfterBind(userId)

    // 被删的 ID 已经不在列表里了，单独带上一起查，卡片顶部才认得出删的是谁
    const nameMap = await fetchRoleNames([deletedId, ...userData[userId].ids], userId)
    const idList = this.formatIdList(userData[userId], nameMap)
    const html = await this.generateAccountManageHTML('删除', deletedId, idList, nameMap[deletedId])
    await e.reply([html, Button.account(userData[userId].ids)])
  }

  // 展示ID列表
  async myWzryId(e) {
    let userId = await this.getReplyUserId(e)
    if (!userId) return
    const { userData } = this.getUserData(userId)

    if (!userData[userId]?.ids.length) {
      // 本机没绑过 —— 但共享库里可能有他（在别的机器人上绑过）。
      // 早先这里直接回一张「怎么获取营地ID」的教程图，用户一看就像在说
      // 「你还没绑定」，可他库里明明有。所以先问一次库。
      const shared = await querySharedBind(userId)
      if (shared.found && shared.campIds?.length) {
        const list = {
          ids: shared.campIds,
          current: Math.max(0, shared.campIds.indexOf(shared.current))
        }
        const nameMap = await fetchRoleNames(shared.campIds, userId)
        const idList = this.formatIdList(list, nameMap)
        const currentId = shared.campIds[list.current] || shared.campIds[0]
        const html = await this.generateAccountManageHTML('查询', currentId, idList, nameMap[currentId])

        return e.reply([
          '这些是从共享库拿到的，本机还没绑（推送类功能要本机绑一次）',
          html,
          Button.bind()
        ], shouldQuote())
      }

      return e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
    }

    const nameMap = await fetchRoleNames(userData[userId].ids, userId)
    const idList = this.formatIdList(userData[userId], nameMap)
    const currentId = userData[userId].ids[userData[userId].current] || userData[userId].ids[0]
    const html = await this.generateAccountManageHTML('查询', currentId, idList, nameMap[currentId])
    await e.reply([html, Button.account(userData[userId].ids)])
  }

  // 营地ID获取教程
  async howToGetWzryId(e) {
    await e.reply([
      segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
      Button.bind()
    ], shouldQuote())
  }

  // 格式化ID列表显示
  formatIdList(userInfo, nameMap = {}) {
    return userInfo.ids.map((id, index) => {
      const prefix = index === userInfo.current ? '✅' : '☑️'
      const roleName = nameMap[id]
      return `${prefix} ${index + 1}. ${id}${roleName ? `  ${roleName}` : ''}`
    }).join('\n')
  }

  getPendingWechatLogin(botUserId) {
    return pendingWechatLoginMap.get(botUserId) || null
  }

  clearPendingWechatLogin(botUserId) {
    const pending = this.getPendingWechatLogin(botUserId)
    if (pending?.recallTimer) {
      clearTimeout(pending.recallTimer)
    }
    if (pending?.scanStatusRecallTimer) {
      clearTimeout(pending.scanStatusRecallTimer)
    }
    pendingWechatLoginMap.delete(botUserId)
    return pending
  }

  async recallReplyMessage(e, messageId) {
    if (!messageId) {
      return false
    }

    try {
      let recall = null
      if (e.group?.recallMsg) recall = e.group.recallMsg.bind(e.group)
      else if (e.friend?.recallMsg) recall = e.friend.recallMsg.bind(e.friend)
      else if (e.bot?.recallMsg) recall = e.bot.recallMsg.bind(e.bot)
      else return false

      await recall(messageId)
      return true
    } catch (error) {
      logger.warn(`[营地登录] 撤回二维码消息失败: ${error.message}`)
      return false
    }
  }

  async recallWechatLoginMessages(e, pending) {
    if (!pending) {
      return
    }

    await this.recallReplyMessage(e, pending.qrMessageId)
    await this.recallReplyMessage(e, pending.scanStatusMessageId)
    pending.qrMessageId = ''
    pending.scanStatusMessageId = ''
    pending.scanStatusRecallTimer = null
  }

  async handleWechatLoginStatusChange(e, botUserId, taskId, status = {}) {
    const pending = this.getPendingWechatLogin(botUserId)
    if (!pending || pending.taskId !== taskId) {
      return
    }

    if (status.statusCode === 404) {
      pending.hasScanned = true

      if (!pending.scanStatusMessageId) {
        const scanReply = await e.reply('已扫码，请在手机上确认营地登录。若长时间未确认，本次登录会自动超时。')
        pending.scanStatusMessageId = scanReply?.message_id || ''
        pending.scanStatusRecallTimer = setTimeout(() => {
          void this.recallReplyMessage(e, pending.scanStatusMessageId)
            .finally(() => {
              pending.scanStatusMessageId = ''
            })
        }, LOGIN_SCAN_STATUS_RECALL_SECONDS * 1000)
      }
    }
  }

  async startWechatLogin(e, botUserId, options = {}) {
    if (this.getPendingWechatLogin(botUserId)) {
      await e.reply('当前已有一个营地登录任务在进行中，请先完成当前二维码或稍后再试')
      return true
    }

    const { qrPromptLines = [] } = options

    let session
    try {
      session = await createWechatLoginSession()
    } catch (error) {
      logger.error(`[营地登录] 生成二维码失败: ${error.message}`)
      await e.reply(`生成营地登录二维码失败：${error.message}`)
      return true
    }

    const taskId = `${botUserId}:${Date.now()}`
    const qrReply = await e.reply([
      ...qrPromptLines,
      '\n',
      segment.image(`base64://${session.qrcodeBuffer.toString('base64')}`)
    ])

    const pendingInfo = {
      taskId,
      qrMessageId: qrReply?.message_id || '',
      scanStatusMessageId: '',
      hasScanned: false,
      scanStatusRecallTimer: null,
      recallTimer: setTimeout(() => {
        void this.recallReplyMessage(e, pendingInfo.qrMessageId)
          .finally(() => {
            pendingInfo.qrMessageId = ''
          })
      }, LOGIN_QR_RECALL_SECONDS * 1000)
    }
    pendingWechatLoginMap.set(botUserId, pendingInfo)

    void this.waitForWechatLoginResult(e, botUserId, taskId, session)
    return true
  }

  async wechatGlobalScanLogin(e) {
    const botUserId = e.user_id
    return this.startWechatLogin(e, botUserId, {
      qrPromptLines: [
        `请扫描二维码完成营地登录，二维码 3 分钟内有效，将在 ${LOGIN_QR_RECALL_SECONDS} 秒后自动撤回。`,
        '\n登录成功后会自动保存登录态并绑定这个营地号，发 #营地观战 就能看你营地好友里谁在打。'
      ]
    })
  }

  async startQQLogin(e, botUserId, options = {}) {
    if (this.getPendingWechatLogin(botUserId)) {
      await e.reply('当前已有一个营地登录任务在进行中，请先完成当前二维码或稍后再试')
      return true
    }

    const { qrPromptLines = [] } = options

    let session
    try {
      session = await createQQLoginSession(e)
    } catch (error) {
      logger.error(`[营地QQ登录] 生成二维码失败: ${error.message}`)
      await e.reply('生成营地登录二维码失败，请稍后重试')
      return true
    }

    const taskId = `${botUserId}:qq:${Date.now()}`
    let qrReply = null
    try {
      qrReply = await e.reply([
        ...qrPromptLines,
        '\n',
        segment.image(`base64://${session.qrcodeBuffer.toString('base64')}`)
      ])
    } catch (error) {
      await session.close()
      logger.error(`[营地QQ登录] 发送二维码失败: ${error.message}`)
      return true
    }

    const pendingInfo = {
      taskId,
      qrMessageId: qrReply?.message_id || '',
      scanStatusMessageId: '',
      hasScanned: false,
      scanStatusRecallTimer: null,
      recallTimer: setTimeout(() => {
        void this.recallReplyMessage(e, pendingInfo.qrMessageId)
          .finally(() => {
            pendingInfo.qrMessageId = ''
          })
      }, LOGIN_QR_RECALL_SECONDS * 1000)
    }
    pendingWechatLoginMap.set(botUserId, pendingInfo)

    void this.waitForQQLoginResult(e, botUserId, taskId, session)
    return true
  }

  async qqGlobalScanLogin(e) {
    const botUserId = e.user_id
    return this.startQQLogin(e, botUserId, {
      qrPromptLines: [
        `请用手机 QQ 扫描二维码完成营地登录，二维码 3 分钟内有效，将在 ${LOGIN_QR_RECALL_SECONDS} 秒后自动撤回。`,
        '\n登录成功后会自动保存登录态并绑定这个营地号，发 #营地观战 就能看你营地好友里谁在打。'
      ]
    })
  }

  async waitForQQLoginResult(e, botUserId, taskId, session) {
    const pending = this.getPendingWechatLogin(botUserId)
    try {
      const result = await waitForQQLogin(session, {
        onStatusChange: (status) => {
          void this.handleWechatLoginStatusChange(e, botUserId, taskId, status)
        }
      })
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)

      await this.finishGlobalWechatLogin(e, botUserId, result)
    } catch (error) {
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)
      logger.error(`[营地QQ登录] 登录流程失败: ${error.message}`)

      if (error.code === 'QR_EXPIRED') {
        await e.reply('营地登录二维码已过期，请重新发起')
      } else if (error.code === 'QR_CANCELED') {
        await e.reply('营地登录已取消，请重新发起')
      } else if (error.code === 'QR_TIMEOUT') {
        if (pending?.hasScanned) {
          await e.reply('已扫码，但长时间未确认，营地登录已超时，请重新发起')
        } else {
          await e.reply('营地登录等待超时，请重新发起')
        }
      } else {
        await e.reply('营地登录失败，请稍后重试；若反复失败请反馈给主人')
      }
    } finally {
      await session.close()
      if (this.getPendingWechatLogin(botUserId)?.taskId === taskId) {
        this.clearPendingWechatLogin(botUserId)
      }
    }
  }

  async finishGlobalWechatLogin(e, botUserId, result) {
    const account = result.account || {}
    // ⚠️ ownerBotUserId 必须写：#营地观战 靠它认「这个号是谁扫的」，
    // 只把发起人自己扫的号拿去查好友。漏了这个字段，这个号在观战里就等于不存在。
    const savedAccount = authStore.upsertGlobalAccount({
      ...account,
      ownerBotUserId: botUserId
    })
    // 扫码即绑定：早先的「个人登录」就是「存登录态 + 顺手绑定」两件事，
    // 现在只留全局登录一条入口，把绑定并进来，用户不用再发一条 #绑定营地
    if (savedAccount.userId) {
      authStore.bindCampUserId(botUserId, savedAccount.userId)
      this.syncShareAfterBind(botUserId)
    }
    // 全局账号是可以有多个的（轮询池），所以扫码后要报当前池子大小，
    // 否则主人扫第二个号时会以为把第一个覆盖了。
    const globalCount = authStore.listAccounts().filter(item => item.isGlobalDefault).length

    logger.info('[营地全局账号] 已通过扫码写入全局账号池', {
      botUserId,
      userId: savedAccount.userId,
      nickname: savedAccount.nickname || savedAccount.userName || '',
      globalCount
    })

    const lines = [
      '登录成功，已绑定这个营地号。',
      `\n营地ID：${savedAccount.userId || '未获取'}`,
      `\n昵称：${savedAccount.nickname || savedAccount.userName || '未命名'}`,
      '\n发送 #营地观战 看你营地好友里谁在打。',
      '\n有效期约 30 天，失效了重发这条指令。'
    ]
    // 池子大小只报给主人：他要靠这个数判断请求摊得够不够开，普通用户看了没用
    if (e.isMaster) {
      lines.splice(1, 0, `\n当前账号池共 ${globalCount} 个全局账号。`)
    }
    await e.reply(lines)
  }

  async waitForWechatLoginResult(e, botUserId, taskId, session) {
    const pending = this.getPendingWechatLogin(botUserId)
    try {
      const result = await waitForWechatLogin(session, {
        onStatusChange: (status) => {
          void this.handleWechatLoginStatusChange(e, botUserId, taskId, status)
        }
      })
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)

      await this.finishGlobalWechatLogin(e, botUserId, result)
    } catch (error) {
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)
      logger.error(`[营地登录] 登录流程失败: ${error.message}`)

      if (error.code === 'QR_EXPIRED') {
        await e.reply('营地登录二维码已过期，请重新发起')
      } else if (error.code === 'QR_CANCELED') {
        await e.reply('营地登录已取消，请重新发起')
      } else if (error.code === 'QR_TIMEOUT') {
        if (pending?.hasScanned) {
          await e.reply('已扫码，但长时间未确认，营地登录已超时，请重新发起')
        } else {
          await e.reply('营地登录等待超时，请重新发起')
        }
      } else {
        await e.reply(`营地登录失败：${error.message}`)
      }
    } finally {
      if (this.getPendingWechatLogin(botUserId)?.taskId === taskId) {
        this.clearPendingWechatLogin(botUserId)
      }
    }
  }

  async showAuthPool(e) {
    const overviewData = this.buildAuthPoolOverviewData()

    try {
      const img = await this.generateAuthPoolOverviewHTML(overviewData)
      await e.reply(img, shouldQuote())
    } catch (error) {
      logger.error(`[王者用户统计] 渲染统计面板失败: ${error.message}`)
      await e.reply([
        '用户统计面板渲染失败，已回退为文本摘要。',
        `\n绑定营地ID的QQ：${overviewData.overviewCards[0]?.value || 0}`,
        `\n已绑定营地ID总数：${overviewData.overviewCards[1]?.value || 0}`,
        `\n拥有登录态的QQ：${overviewData.overviewCards[2]?.value || 0}`,
        `\n账号池登录态总数：${overviewData.overviewCards[3]?.value || 0}`,
        `\n可用登录态：${overviewData.overviewCards[4]?.value || 0}`,
        `\n失效登录态：${overviewData.overviewCards[5]?.value || 0}`
      ])
    }
    return true
  }

  // 营地账号的显示名：优先游戏昵称，取不到退回营地昵称，都没有就只剩 ID
  async describeCampAccount(account) {
    const campUserId = String(account?.userId || '')
    if (!campUserId) return ''

    let roleName = ''
    try {
      const nameMap = await fetchRoleNames([campUserId], account.ownerBotUserId || '')
      roleName = nameMap[campUserId] || ''
    } catch (error) {
      logger.debug(`[营地账号] 获取 ${campUserId} 昵称失败: ${error.message}`)
    }

    const name = roleName || account.nickname || account.userName || ''
    return name ? `${campUserId} ${name}` : campUserId
  }

  async clearInvalidCampAuth(e) {
    const {
      removedAccounts = [],
      skippedGlobalAccounts = []
    } = authStore.clearInvalidAccounts()

    if (!removedAccounts.length && !skippedGlobalAccounts.length) {
      await e.reply('当前没有已标记失效的营地登录态，无需清理')
      return true
    }

    const lines = []
    if (removedAccounts.length) {
      lines.push(`已清理 ${removedAccounts.length} 个失效营地登录态。`)
      lines.push('这些账号只会从本地账号池移除，不会删除用户已绑定的营地ID：')
      lines.push(...removedAccounts.map((account, index) => {
        const nickname = account.nickname || '未命名'
        const ownerText = account.ownerBotUserId ? ` owner:${account.ownerBotUserId}` : ''
        return `${index + 1}. ${account.userId} ${nickname}${ownerText}`
      }))
    }

    if (skippedGlobalAccounts.length) {
      lines.push(
        removedAccounts.length ? '' : '本次未删除任何账号。',
        `已跳过 ${skippedGlobalAccounts.length} 个失效的全局账号，失效标记会保留，后续可通过【#营地wx全局登录】/【#营地QQ全局登录】或锅巴更新后恢复。`
      )
    }

    await e.reply(lines.filter(Boolean).join('\n'))
    return true
  }

  /**
   * #隐藏主页名单（主人）
   *
   * 列出被标注「隐藏了主页」的营地ID。这些号 24 小时内不会被主动查询
   * （战绩推送轮询、排位刷榜、日报周报、群报），但用户点名查的指令不受影响。
   */
  async showHiddenProfiles (e) {
    const list = listHiddenProfiles()

    if (!list.length) {
      await e.reply('当前没有被标注「隐藏了主页」的营地ID。', shouldQuote())
      return true
    }

    const lines = list.map((item, index) => {
      // 不足 1 小时也显示成 1，别出现「还有约 0 小时」
      const hours = Math.max(1, Math.ceil(item.remainMs / 3600000))
      const name = item.nickname ? ` ${item.nickname}` : ''
      return `${index + 1}. ${item.campId}${name} —— 还有约 ${hours} 小时`
    })

    await e.reply([
      `被标注「隐藏了主页」的营地ID（共 ${list.length} 个）：`,
      ...lines,
      '',
      '这些号 24 小时内不会被主动查询：战绩推送轮询、排位刷榜、日报周报、群报。',
      '用户点名查（#王者主页 / #查询战绩 等）不受影响。',
      '清除：#清除隐藏主页 <营地ID>，或 #清除隐藏主页 all'
    ].join('\n'), shouldQuote())
    return true
  }

  /** #清除隐藏主页 <营地ID|all>（主人） */
  async clearHiddenProfiles (e) {
    const arg = String(e.msg || '').replace(/^#清除隐藏主页\s*/, '').trim()

    if (!arg) {
      await e.reply('用法：#清除隐藏主页 <营地ID>，或 #清除隐藏主页 all', shouldQuote())
      return true
    }

    if (/^all$/i.test(arg)) {
      const count = clearAllHiddenProfiles()
      await e.reply(
        count
          ? `已清除全部 ${count} 条隐藏主页标注，下一次轮询会重新查询它们。`
          : '当前没有标注可清除。',
        shouldQuote()
      )
      return true
    }

    const campId = arg.replace(/[^\d]/g, '')
    if (!campId) {
      await e.reply('没认出营地ID（要纯数字），或用 all 清除全部。', shouldQuote())
      return true
    }

    const removed = clearHiddenProfile(campId)
    await e.reply(
      removed
        ? `已清除 ${campId} 的隐藏主页标注，下一次轮询会重新查询它。`
        : `${campId} 不在标注名单里。`,
      shouldQuote()
    )
    return true
  }
}
