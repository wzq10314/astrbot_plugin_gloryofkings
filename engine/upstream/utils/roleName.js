import { ApiService, cache } from '#utils'
import { mapConcurrent } from './parallel.js'

// 拿一次昵称要打营地接口，命中缓存就不用再打；空结果单独压短一点
const ROLE_NAME_TTL = 600
const EMPTY_ROLE_NAME_TTL = 60

/**
 * 按营地ID批量取游戏昵称，给「ID 旁边显示是谁」用。
 * 单个 ID 查失败只留空，不抛错 —— 展示层自己决定退回什么文案。
 * @param {Array<string|number>} ids 营地ID列表
 * @param {string|number} botUserId 属主，决定用谁的登录态去查
 * @returns {Promise<Object>} { [营地ID]: 游戏昵称 }
 */
export async function fetchRoleNames (ids = [], botUserId = '') {
  const nameMap = {}

  // 并发查：命中缓存的当场返回，没命中的那几发交给 api 层轮着分给不同账号
  await mapConcurrent(ids, async (id) => {
    const campId = String(id || '')
    if (!campId) return

    const cacheKey = `gok:roleName:${campId}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      nameMap[campId] = cached
      return
    }

    let roleName = ''
    try {
      const profile = await ApiService.getProfile(campId, String(botUserId || ''))
      const { roleList = [], targetRoleId } = profile?.data || {}
      const role = roleList.find(item => item.roleId === targetRoleId) || roleList[0]
      roleName = role?.roleName || ''
    } catch (error) {
      logger.debug(`[营地ID] 获取 ${campId} 游戏昵称失败: ${error.message}`)
    }

    // 空结果只压 60 秒：刚绑定还没登录态时拉不到昵称，压 10 分钟会让 ID 一直裸奔
    cache.set(cacheKey, roleName, roleName ? ROLE_NAME_TTL : EMPTY_ROLE_NAME_TTL)
    nameMap[campId] = roleName
  })

  return nameMap
}
