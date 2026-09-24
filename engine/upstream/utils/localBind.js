/**
 * 本地绑定表（`data/UserData.yaml`）的只读访问。
 *
 * 为什么单独一个文件而不是留在 utils/index.js 里：index.js 要 re-export 共享库的
 * `resolveCurrentId`，而共享库又要靠「本地优先」这一层判断该不该去查共享库。
 * 两边互相 import 就成环了，所以把最底层的读表逻辑摘出来，谁都能安全地引用它。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile } from './yamlUtils.js'

const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/** 直接读整张绑定表。读失败按空表处理，调用方各自决定怎么表达「没有」 */
export function readUserData () {
  try {
    return readYamlFile(USER_DATA_FILE) || {}
  } catch {
    return {}
  }
}

/**
 * 某个 QQ 绑定的全部营地ID。
 * @param {string|number} userId
 * @returns {string[]} 没绑过返回空数组
 */
export function getBoundIds (userId) {
  const entry = readUserData()[userId]
  return Array.isArray(entry?.ids) ? [...entry.ids] : []
}

/**
 * 某个 QQ 当前选中的营地ID。
 * @param {string|number} userId
 * @returns {string|null}
 */
export function getCurrentId (userId) {
  const entry = readUserData()[userId]
  if (!entry || !Array.isArray(entry.ids) || !entry.ids.length) return null

  const index = Number(entry.current) || 0
  return entry.ids[index] ?? entry.ids[0] ?? null
}
