import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { writeFileAtomic, quarantineCorrupt } from './safeStore.js'

const AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.json')
const LEGACY_AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.yaml')
const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function normalizeUserId(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return ''
  }

  return String(value)
}

function toStringValue(value) {
  if (value === null || typeof value === 'undefined') {
    return ''
  }

  return String(value)
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback)
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    // AuthPool.json 存的是所有人的登录态，坏了就是全员重新扫码。
    // 静默按默认值继续会让下一次写把默认值固化下来，所以先把坏文件挪走留证。
    quarantineCorrupt(filePath, error, '[王者账号]')
    return structuredClone(fallback)
  }
}

/** JSON 带缩进落盘（人可读，方便手工救数据），走原子写 */
function writeJsonPretty(filePath, data) {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function readYamlSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback)
    }

    return readYamlFile(filePath) ?? structuredClone(fallback)
  } catch (error) {
    // UserData.yaml 是绑定关系，同上：坏了要留证，不能静默清空
    quarantineCorrupt(filePath, error, '[王者账号]')
    return structuredClone(fallback)
  }
}

/**
 * 这份登录态有没有资格发请求（token / userId / 密钥三样齐）。
 * 导出给 api.js 用：它判「池里还有没有能用的账号」时要和选候选同一套判据，
 * 两边各写一份迟早漂移。
 */
export function isUsableAuth(auth) {
  return Boolean(auth?.token && auth?.userId && (auth?.userKey || auth?.encodeRes))
}

function toNumberValue(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function maskValue(value, keepStart = 6, keepEnd = 4) {
  const text = toStringValue(value)
  if (!text) {
    return ''
  }

  if (text.length <= keepStart + keepEnd) {
    return text
  }

  return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
}

class AuthStore {
  #getDefaultPool() {
    return { accounts: {} }
  }

  #getDefaultUserData() {
    return {}
  }

  /**
   * 全局账号轮询游标。只活在进程内存里，重启后从优先级最高的号重新开始。
   *
   * 关键约束：**只有全局账号多于一个时它才会被推进**（见 #rotateGlobals 的调用点），
   * 所以单账号场景下它恒为 0，候选顺序与引入轮询之前逐字节一致。
   */
  #globalCursor = 0

  /**
   * 把本轮该用的全局账号转到队首，其余按原优先级跟在其后，并推进游标。
   *
   * 是「旋转」而不是「只返回一个」：轮到的号万一失效，调用方（api.js 的候选循环）
   * 还能顺着后面的号继续回退，现有的 failover 能力原样保留。
   */
  #rotateGlobals(accounts = []) {
    if (accounts.length <= 1) {
      return accounts
    }

    const offset = this.#globalCursor % accounts.length
    this.#globalCursor = (offset + 1) % accounts.length
    return [...accounts.slice(offset), ...accounts.slice(0, offset)]
  }

  #sortAccountsByPriority(accounts = []) {
    return [...accounts].sort((left, right) => {
      const globalCompare = Number(Boolean(right.isGlobalDefault)) - Number(Boolean(left.isGlobalDefault))
      if (globalCompare !== 0) {
        return globalCompare
      }

      const priorityCompare = Number(left.priority || 0) - Number(right.priority || 0)
      if (priorityCompare !== 0) {
        return priorityCompare
      }

      return String(left.userId).localeCompare(String(right.userId))
    })
  }
  #normalizeAccount(account = {}, existing = {}) {
    const userId = normalizeUserId(account.userId || existing.userId)
    const timestamp = new Date().toISOString()
    const isGlobalDefault = typeof account.isGlobalDefault === 'boolean'
      ? account.isGlobalDefault
      : Boolean(existing.isGlobalDefault)
    const authInvalid = typeof account.authInvalid === 'boolean'
      ? account.authInvalid
      : Boolean(existing.authInvalid)
    const authErrorCount = Number(account.authErrorCount ?? existing.authErrorCount ?? 0)
    const priority = toNumberValue(account.priority ?? existing.priority ?? 100, 100)

    return {
      ...existing,
      ...account,
      userId,
      token: toStringValue(account.token ?? existing.token),
      userKey: toStringValue(account.userKey ?? existing.userKey),
      encodeRes: toStringValue(account.encodeRes ?? existing.encodeRes),
      openId: toStringValue(account.openId ?? existing.openId),
      gameOpenId: toStringValue(account.gameOpenId ?? existing.gameOpenId),
      gameRoleId: toStringValue(account.gameRoleId ?? existing.gameRoleId),
      gameServerId: toStringValue(account.gameServerId ?? existing.gameServerId),
      gameAreaId: toStringValue(account.gameAreaId ?? existing.gameAreaId),
      gameUserSex: toStringValue(account.gameUserSex ?? existing.gameUserSex),
      kohDimGender: toStringValue(account.kohDimGender ?? existing.kohDimGender),
      xLogUid: toStringValue(account.xLogUid ?? existing.xLogUid),
      traceparent: toStringValue(account.traceparent ?? existing.traceparent),
      accessToken: toStringValue(account.accessToken ?? existing.accessToken),
      refreshToken: toStringValue(account.refreshToken ?? existing.refreshToken),
      appOpenid: toStringValue(account.appOpenid ?? existing.appOpenid),
      avatar: toStringValue(account.avatar ?? existing.avatar),
      bigAvatar: toStringValue(account.bigAvatar ?? existing.bigAvatar),
      icon: toStringValue(account.icon ?? existing.icon),
      nickname: toStringValue(account.nickname ?? existing.nickname),
      snsnickname: toStringValue(account.snsnickname ?? existing.snsnickname),
      userName: toStringValue(account.userName ?? existing.userName),
      sex: toStringValue(account.sex ?? existing.sex),
      expires: toStringValue(account.expires ?? existing.expires),
      uin: toStringValue(account.uin ?? existing.uin),
      userSig: toStringValue(account.userSig ?? existing.userSig),
      realRegisterTime: toStringValue(account.realRegisterTime ?? existing.realRegisterTime),
      ownerBotUserId: normalizeUserId(account.ownerBotUserId || existing.ownerBotUserId),
      loginPlatform: toStringValue(account.loginPlatform ?? existing.loginPlatform),
      remark: toStringValue(account.remark ?? existing.remark),
      isGlobalDefault,
      priority,
      authInvalid,
      authErrorCount,
      lastAuthErrorAt: toStringValue(account.lastAuthErrorAt ?? existing.lastAuthErrorAt),
      lastAuthErrorMessage: toStringValue(account.lastAuthErrorMessage ?? existing.lastAuthErrorMessage),
      lastSuccessAt: toStringValue(account.lastSuccessAt ?? existing.lastSuccessAt),
      createdAt: existing.createdAt || timestamp,
      updatedAt: timestamp,
      lastLoginAt: toStringValue(account.lastLoginAt ?? existing.lastLoginAt ?? timestamp)
    }
  }

  #normalizePool(pool = {}) {
    const sourceAccounts = pool.accounts && typeof pool.accounts === 'object' ? pool.accounts : {}
    const accounts = {}

    for (const [userId, account] of Object.entries(sourceAccounts)) {
      const normalizedUserId = normalizeUserId(userId || account?.userId)
      if (!normalizedUserId) {
        continue
      }

      accounts[normalizedUserId] = this.#normalizeAccount({
        ...account,
        userId: normalizedUserId
      })
    }

    return { accounts }
  }

  #savePool(pool) {
    writeJsonPretty(AUTH_POOL_FILE, this.#normalizePool(pool))
  }

  #saveUserData(userData) {
    ensureDirectory(USER_DATA_FILE)
    writeYamlFile(USER_DATA_FILE, userData)
  }

  #migrateLegacyPoolIfNeeded() {
    if (fs.existsSync(AUTH_POOL_FILE) || !fs.existsSync(LEGACY_AUTH_POOL_FILE)) {
      return
    }

    const legacyPool = readYamlSafe(LEGACY_AUTH_POOL_FILE, this.#getDefaultPool())
    this.#savePool(legacyPool)
  }

  getPool() {
    this.#migrateLegacyPoolIfNeeded()
    return this.#normalizePool(readJsonSafe(AUTH_POOL_FILE, this.#getDefaultPool()))
  }

  getAccount(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    return this.getPool().accounts[normalizedUserId] || null
  }

  listAccounts() {
    return this.#sortAccountsByPriority(Object.values(this.getPool().accounts))
  }

  upsertAccount(account) {
    const userId = normalizeUserId(account.userId)
    if (!userId) {
      throw new Error('缺少营地 userId，无法保存登录态')
    }

    const pool = this.getPool()
    const existing = pool.accounts[userId] || {}
    const next = this.#normalizeAccount({
      ...account,
      userId
    }, existing)

    if (account.resetAuthState) {
      next.authInvalid = false
      next.authErrorCount = 0
      next.lastAuthErrorAt = ''
      next.lastAuthErrorMessage = ''
    }

    pool.accounts[userId] = next

    // 刻意不再「一山不容二虎」地清掉其他全局账号：全局账号现在是一个轮询池
    // （见 getAuthCandidates 里的 #rotateGlobals），扫码登记第二个号不该把第一个顶掉。

    this.#savePool(pool)
    logger.debug('[营地账号池] 已保存账号登录态', {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      loginPlatform: next.loginPlatform,
      isGlobalDefault: next.isGlobalDefault,
      priority: next.priority,
      token: maskValue(next.token),
      userKey: maskValue(next.userKey),
      encodeRes: maskValue(next.encodeRes),
      appOpenid: maskValue(next.appOpenid),
      openId: maskValue(next.openId),
      gameOpenId: maskValue(next.gameOpenId),
      gameRoleId: next.gameRoleId,
      gameServerId: next.gameServerId,
      gameAreaId: next.gameAreaId,
      gameUserSex: next.gameUserSex,
      kohDimGender: next.kohDimGender,
      nickname: next.nickname || next.userName || ''
    })
    return next
  }

  markAuthFailure(userId, message = '') {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    const pool = this.getPool()
    const account = pool.accounts[normalizedUserId]
    if (!account) {
      return null
    }

    const next = this.#normalizeAccount({
      ...account,
      authInvalid: true,
      authErrorCount: Number(account.authErrorCount || 0) + 1,
      lastAuthErrorAt: new Date().toISOString(),
      lastAuthErrorMessage: toStringValue(message)
    }, account)

    pool.accounts[normalizedUserId] = next
    this.#savePool(pool)
    logger.warn('[营地账号池] 已标记账号登录态失效', {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      isGlobalDefault: next.isGlobalDefault,
      authErrorCount: next.authErrorCount,
      lastAuthErrorMessage: next.lastAuthErrorMessage
    })
    return {
      ...next,
      newlyInvalid: !Boolean(account.authInvalid)
    }
  }

  markAuthSuccess(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    const pool = this.getPool()
    const account = pool.accounts[normalizedUserId]
    if (!account) {
      return null
    }

    const next = this.#normalizeAccount({
      ...account,
      authInvalid: false,
      authErrorCount: 0,
      lastAuthErrorAt: '',
      lastAuthErrorMessage: '',
      lastSuccessAt: new Date().toISOString()
    }, account)

    pool.accounts[normalizedUserId] = next
    this.#savePool(pool)
    return next
  }

  setGlobalAccount(userId = '') {
    const normalizedUserId = normalizeUserId(userId)
    const pool = this.getPool()
    let found = !normalizedUserId

    for (const [accountUserId, account] of Object.entries(pool.accounts)) {
      const shouldBeGlobal = normalizedUserId && accountUserId === normalizedUserId
      if (shouldBeGlobal) {
        found = true
      }

      if (Boolean(account.isGlobalDefault) === Boolean(shouldBeGlobal)) {
        continue
      }

      pool.accounts[accountUserId] = this.#normalizeAccount({
        ...account,
        isGlobalDefault: shouldBeGlobal
      }, account)
    }

    if (!found) {
      throw new Error(`账号池中不存在营地账号 ${normalizedUserId}`)
    }

    this.#savePool(pool)
    return normalizedUserId
  }

  getGlobalAccount() {
    const globals = this.#sortAccountsByPriority(
      this.listAccounts().filter(account => account.isGlobalDefault)
    )

    return globals[0] || null
  }

  getGlobalAccountId() {
    return this.getGlobalAccount()?.userId || ''
  }

  /**
   * 某个机器人用户自己扫码登记的全局账号（可用的那些）。
   *
   * 用途：`#营地观战` 要拿「发起人自己的营地好友」，就得知道哪些全局账号是他扫的。
   * `ownerBotUserId` 从 2026-09-17 起在全局登录时一起写入。
   *
   * ⚠️ `includeOrphan`：这之前扫的全局账号 `ownerBotUserId` 是空的（那时全局登录只有主人能发，
   * 所以那批号一律算主人的）。主人查询时传 true 才不会把老号漏掉。
   */
  listGlobalAccountsByOwner(botUserId, { includeOrphan = false } = {}) {
    const owner = normalizeUserId(botUserId)
    return this.listAccounts().filter(account => {
      if (!account.isGlobalDefault || account.authInvalid || !isUsableAuth(account)) {
        return false
      }
      const accountOwner = normalizeUserId(account.ownerBotUserId)
      if (!accountOwner) {
        return includeOrphan
      }
      return Boolean(owner) && accountOwner === owner
    })
  }

  /**
   * 把一个账号登记进全局账号池。
   *
   * 全局账号可以有多个（微信/QQ 扫出来的都行），请求会在它们之间轮换，
   * 所以这里是「加入」而不是「替换唯一的那一个」——扫码登记第二个号不该顶掉第一个。
   */
  upsertGlobalAccount(account = {}) {
    const next = this.upsertAccount({
      ...account,
      isGlobalDefault: true,
      resetAuthState: true
    })

    logger.info('[营地全局账号] 已更新全局账号池配置', {
      userId: next.userId,
      token: maskValue(next.token),
      userKey: maskValue(next.userKey),
      encodeRes: maskValue(next.encodeRes)
    })

    return next
  }

  removeAccount(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return false
    }

    const pool = this.getPool()
    if (!pool.accounts[normalizedUserId]) {
      return false
    }

    delete pool.accounts[normalizedUserId]
    this.#savePool(pool)
    return true
  }

  clearInvalidAccounts() {
    const pool = this.getPool()
    const removedAccounts = []
    const skippedGlobalAccounts = []

    for (const account of Object.values(pool.accounts)) {
      if (!account?.authInvalid) {
        continue
      }

      if (account.isGlobalDefault) {
        skippedGlobalAccounts.push({
          userId: account.userId,
          ownerBotUserId: account.ownerBotUserId || '',
          nickname: account.nickname || account.userName || '',
          lastAuthErrorMessage: account.lastAuthErrorMessage || ''
        })
        continue
      }

      removedAccounts.push({
        userId: account.userId,
        ownerBotUserId: account.ownerBotUserId || '',
        nickname: account.nickname || account.userName || '',
        lastAuthErrorMessage: account.lastAuthErrorMessage || ''
      })

      delete pool.accounts[account.userId]
    }

    if (!removedAccounts.length) {
      return {
        removedAccounts,
        skippedGlobalAccounts
      }
    }

    this.#savePool(pool)

    logger.info('[营地账号池] 已清理失效登录态', {
      removedCount: removedAccounts.length,
      skippedGlobalCount: skippedGlobalAccounts.length,
      removedAccounts,
      skippedGlobalAccounts
    })

    return {
      removedAccounts,
      skippedGlobalAccounts
    }
  }

  bindCampUserId(botUserId, campUserId) {
    const normalizedBotUserId = normalizeUserId(botUserId)
    const normalizedCampUserId = normalizeUserId(campUserId)
    const userData = readYamlSafe(USER_DATA_FILE, this.#getDefaultUserData())

    if (!userData[normalizedBotUserId]) {
      userData[normalizedBotUserId] = {
        ids: [],
        current: 0
      }
    }

    const entry = userData[normalizedBotUserId]

    if (!Array.isArray(entry.ids)) {
      entry.ids = []
    }

    let index = entry.ids.indexOf(normalizedCampUserId)
    if (index === -1) {
      entry.ids.push(normalizedCampUserId)
      index = entry.ids.length - 1
    }

    entry.current = index
    this.#saveUserData(userData)
    logger.debug('[营地账号池] 已绑定营地ID到机器人用户', {
      botUserId: normalizedBotUserId,
      campUserId: normalizedCampUserId,
      current: entry.current,
      ids: entry.ids
    })
    return entry
  }

  /**
   * 挑这次请求可以用的鉴权账号。
   *
   * 现在**只有全局账号**这一类候选，多个时轮询（见 #rotateGlobals）。
   * 早先还有「共享账号」和「个人登录态兜底」两档，都是「全局账号都不可用才轮到」的
   * 兜底——多全局账号轮询 + 按账号冷却换号之后，那个前提基本不会发生，
   * 2026-09-13 一并删掉了（连字段一起）。
   *
   * `targetUserId` 参数留着是为了不给调用方添改动，实际已经用不到了。
   */
  getAuthCandidates(targetUserId, options = {}) {
    const { includeGlobal = true } = options
    const pool = this.getPool()
    const candidates = []
    const seen = new Set()

    const pushCandidate = (auth, source, label) => {
      if (!isUsableAuth(auth)) {
        return
      }

      if (auth.authInvalid) {
        return
      }

      const key = normalizeUserId(auth.userId)
      if (!key || seen.has(key)) {
        return
      }

      seen.add(key)
      candidates.push({
        auth: {
          ...auth,
          enabled: true
        },
        source,
        label: label || key
      })
    }

    if (includeGlobal) {
      const globalAccounts = this.#sortAccountsByPriority(
        Object.values(pool.accounts).filter(account => account.isGlobalDefault)
      )
      // ⚠️⚠️ 这里**不要再 rotate**：api.js 的 `#getAuthCandidates` 已经转过一次了。
      //   两处都转 = 每次请求队首前进 **2** 格，池子大小是偶数时「奇数位永远当不上队首」
      //   → **一半的账号从来不会被用到**（2026-09-19 实测：8 个号实际只用到 4 个，
      //   另一半一直闲置到登录态失效，保活也救不到它们）。
      //   轮转的活儿交给调用方做（api.js 那边有游标和日志），这里只负责「给全 + 排好序」。
      for (const globalAccount of globalAccounts) {
        pushCandidate(globalAccount, 'global', `全局账号 ${globalAccount.userId}`)
      }
    }

    return candidates
  }

  getGuobaAccounts() {
    return this.listAccounts().map(account => ({
      userId: account.userId,
      ownerBotUserId: account.ownerBotUserId,
      isGlobalDefault: Boolean(account.isGlobalDefault),
      priority: Number(account.priority || 100),
      authInvalid: Boolean(account.authInvalid),
      authErrorCount: Number(account.authErrorCount || 0),
      nickname: account.nickname || account.userName || '',
      userName: account.userName || '',
      snsnickname: account.snsnickname || '',
      remark: account.remark || '',
      token: account.token || '',
      userKey: account.userKey || '',
      encodeRes: account.encodeRes || '',
      accessToken: account.accessToken || '',
      refreshToken: account.refreshToken || '',
      appOpenid: account.appOpenid || '',
      openId: account.openId || '',
      gameOpenId: account.gameOpenId || '',
      gameRoleId: account.gameRoleId || '',
      gameServerId: account.gameServerId || '',
      gameAreaId: account.gameAreaId || '',
      gameUserSex: account.gameUserSex || '',
      kohDimGender: account.kohDimGender || '',
      avatar: account.avatar || '',
      bigAvatar: account.bigAvatar || '',
      icon: account.icon || '',
      sex: account.sex || '',
      expires: account.expires || '',
      uin: account.uin || '',
      userSig: account.userSig || '',
      realRegisterTime: account.realRegisterTime || '',
      loginPlatform: account.loginPlatform || '',
      updatedAt: account.updatedAt || '',
      lastLoginAt: account.lastLoginAt || '',
      lastSuccessAt: account.lastSuccessAt || '',
      lastAuthErrorAt: account.lastAuthErrorAt || '',
      lastAuthErrorMessage: account.lastAuthErrorMessage || ''
    }))
  }

  replaceAccountsFromGuoba(accounts = []) {
    const pool = this.getPool()
    const nextAccounts = {}

    for (const item of accounts) {
      const userId = normalizeUserId(item.userId)
      if (!userId) {
        continue
      }

      const existing = pool.accounts[userId] || {}

      // ⚠️⚠️ 只在 payload **明确给了布尔值**时才改全局标记，其余沿用池子里的现状。
      //
      // 原本写的是 `Boolean(item.isGlobalDefault)`：payload 里少了这个字段（undefined）
      // 就会被静默算成 false，把「扫码登录时设成的全局账号」一把刷回非全局。
      // 2026-09-20 实测踩到：主人用 #营地QQ全局登录 扫的号，锅巴保存一次之后就
      // 不在全局名单里了 —— #营地消息开 再也管不着它，而号本身还是好的
      // （token / userSig 都在），排查时极难对上账。
      //
      // 注意：拿 `existing.isGlobalDefault` 兜底而不是包成 Boolean(existing...)，
      // 是为了保留「面板上显式关掉某个全局号」的能力（那时 payload 带的是明确的 false）。
      const isGlobalDefault = typeof item.isGlobalDefault === 'boolean'
        ? item.isGlobalDefault
        : Boolean(existing.isGlobalDefault)

      // 被从全局刷成非全局时留一条日志：这种改动以前是完全静默的，
      // 出事后只能靠翻 createdAt 反推。
      if (existing.isGlobalDefault === true && isGlobalDefault === false) {
        logger.warn(
          `[营地账号池] 全局账号 ${userId} 被标记为非全局（isGlobalDefault: true → false）`
        )
      }
      const next = this.#normalizeAccount({
        ...existing,
        userId,
        ownerBotUserId: normalizeUserId(item.ownerBotUserId),
        isGlobalDefault,
        priority: toNumberValue(item.priority ?? existing.priority ?? 100, 100),
        authInvalid: Boolean(item.authInvalid),
        authErrorCount: Number(item.authErrorCount ?? existing.authErrorCount ?? 0),
        nickname: toStringValue(item.nickname || existing.nickname || existing.userName),
        userName: toStringValue(item.userName),
        snsnickname: toStringValue(item.snsnickname),
        remark: toStringValue(item.remark),
        token: toStringValue(item.token),
        userKey: toStringValue(item.userKey),
        encodeRes: toStringValue(item.encodeRes),
        accessToken: toStringValue(item.accessToken),
        refreshToken: toStringValue(item.refreshToken),
        appOpenid: toStringValue(item.appOpenid),
        openId: toStringValue(item.openId),
        gameOpenId: toStringValue(item.gameOpenId),
        gameRoleId: toStringValue(item.gameRoleId),
        gameServerId: toStringValue(item.gameServerId),
        gameAreaId: toStringValue(item.gameAreaId),
        gameUserSex: toStringValue(item.gameUserSex),
        kohDimGender: toStringValue(item.kohDimGender),
        avatar: toStringValue(item.avatar),
        bigAvatar: toStringValue(item.bigAvatar),
        icon: toStringValue(item.icon),
        sex: toStringValue(item.sex),
        expires: toStringValue(item.expires),
        uin: toStringValue(item.uin),
        userSig: toStringValue(item.userSig),
        realRegisterTime: toStringValue(item.realRegisterTime),
        loginPlatform: toStringValue(item.loginPlatform),
        updatedAt: toStringValue(item.updatedAt || existing.updatedAt),
        lastLoginAt: toStringValue(item.lastLoginAt || existing.lastLoginAt),
        lastSuccessAt: toStringValue(item.lastSuccessAt || existing.lastSuccessAt),
        lastAuthErrorAt: toStringValue(item.lastAuthErrorAt || existing.lastAuthErrorAt),
        lastAuthErrorMessage: toStringValue(item.lastAuthErrorMessage || existing.lastAuthErrorMessage)
      }, existing)

      nextAccounts[userId] = next
    }

    this.#savePool({ accounts: nextAccounts })
  }
}

export const authStore = new AuthStore()
export default authStore
