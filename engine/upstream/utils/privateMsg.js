/**
 * 私聊给**任意** QQ 发消息，并真实判断有没有送达。
 *
 * 和 `masterMsg.js` 的分工：那个走 `Bot.sendMasterMsg` 只发给主人（主人必然在
 * 机器人的好友列表里）；这个要发给群友，只能 `pickFriend(qq).sendMsg(...)`。
 *
 * ⚠️ 群里 @ 人走的是**群临时会话**，不是好友关系 —— 对方关了临时会话、或者平台
 * 压根不支持（QQ 官方 bot 就没有 `pickFriend`），都会失败。各适配器抛的错五花八门，
 * 所以这里既 catch、也看返回值，统一翻译成 `{ ok: false }`，
 * 由调用方决定怎么跟用户说 —— **别把原始报错甩给用户**。
 */
import { normalizeId } from './adapter.js'

/**
 * @param {string|number} userId 目标 QQ（官方 bot 下是 openid，那种平台会走 no_api）
 * @param {string} message
 * @param {{bot?: object}} [options] 多账号下传 `e.bot`，默认用全局 Bot
 * @returns {Promise<{ok: boolean, reason?: string, messageId?: string}>} reason 只给日志用
 */
export async function sendPrivate (userId, message, { bot } = {}) {
  const target = normalizeId(userId)
  if (!target) return { ok: false, reason: 'no_target' }

  const api = bot || (typeof Bot !== 'undefined' ? Bot : null)

  let friend = null
  try {
    friend = api?.pickFriend?.(target) || null
  } catch (error) {
    logger?.debug?.(`[王者插件] 取私聊对象 ${target} 失败：${error?.message || error}`)
  }
  if (typeof friend?.sendMsg !== 'function') return { ok: false, reason: 'no_api' }

  try {
    const result = await friend.sendMsg(message)
    // 有的适配器不抛异常，而是把失败塞在返回值里（ICQQ 失败时给的是 { error }）
    if (result && result.error) return { ok: false, reason: String(result.error) }
    // ⭐ 把**发出去那条消息的 id** 带出去：引用回复要靠它精确匹配「引用的是哪一条推送」。
    //    各适配器字段名不一（NapCat 给 `message_id`、有的给 `messageId` / `seq`），
    //    挨个试，都拿不到就回空串 —— 调用方会退化成「按最近一条推送」兜底（那会回错人）。
    const rawId = result?.message_id ?? result?.messageId ?? result?.data?.message_id ?? result?.seq
    const messageId = (rawId === undefined || rawId === null || rawId === '') ? '' : String(rawId)
    return { ok: true, messageId }
  } catch (error) {
    // 没加好友、对方关了临时会话都落在这里，报错文本各平台不一样
    logger?.debug?.(`[王者插件] 私聊 ${target} 失败：${error?.message || error}`)
    return { ok: false, reason: error?.message || 'send_failed' }
  }
}
