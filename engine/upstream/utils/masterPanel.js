import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Config } from '#components'
import authStore from './authStore.js'

function maskId(value, keepStart = 3, keepEnd = 3) {
  const text = String(value || '')
  if (!text) {
    return '未配置'
  }
  if (text.length <= keepStart + keepEnd) {
    return text
  }
  return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
}

export function buildMasterPanelData() {
  const authConfig = Config.getDefOrConfig('auth') || {}
  const accounts = authStore.listAccounts()
  const globalAccounts = accounts.filter(account => account.isGlobalDefault)
  const invalidAccounts = accounts.filter(account => account.authInvalid)
  const usableAccounts = accounts.filter(account => !account.authInvalid)
  const usableGlobals = globalAccounts.filter(account => !account.authInvalid)
  // 多个全局账号 = 轮询池，请求在它们之间轮换（见 authStore.getAuthCandidates）
  const globalRotating = usableGlobals.length > 1

  // 候选池现在只有全局账号这一类（共享账号、个人兜底都已删）
  const candidateOrder = [globalRotating ? `全局账号（${usableGlobals.length} 个轮询）` : '默认全局账号']

  return {
    generatedAt: new Date().toLocaleString(),
    strategyRows: [
      {
        label: '候选及鉴权顺序',
        value: candidateOrder.join(' -> '),
        desc: '请求按此顺序选号',
        tone: 'neutral'
      },
      {
        label: globalRotating ? '全局账号池' : '默认全局账号',
        // value 只给数字，账号明细放 desc：这行的 value 早先是「把 5 个号全列出来」，
        // 而 .row-val 是 nowrap，长列表会把左边挤成**一个字一行**的竖排（实测截图）。
        value: globalAccounts.length ? `${usableGlobals.length} 个可用` : '未配置',
        desc: globalAccounts.length
          ? `${globalRotating ? '请求在其间轮换' : '当前使用'}：${globalAccounts.map(account => `${maskId(account.userId)}${account.authInvalid ? '(失效)' : ''}`).join('、')}`
          : '配置指令：#营地wx全局登录 / #营地QQ全局登录 (刷新全局鉴权)',
        tone: usableGlobals.length ? 'on' : (globalAccounts.length ? 'off' : 'warn')
      }
    ],
    summaryRows: [
      { label: '账号总数', value: String(accounts.length), tone: 'neutral' },
      { label: '可用账号', value: String(usableAccounts.length), tone: 'on' },
      { label: '失效账号', value: String(invalidAccounts.length), tone: invalidAccounts.length ? 'off' : 'neutral' }
    ],
    commandGroups: [
      {
        title: '排查与维护',
        items: [
          { command: '#王者设置', desc: '查看本面板与链路状态' },
          { command: '#王者用户统计', desc: '精简版绑定情况统计' },
          { command: '#清理失效营地账号', desc: '移除无法使用的登录态' }
        ]
      },
      {
        title: '账号与更新',
        items: [
          { command: '#营地wx全局登录', desc: '扫码写入或更新，可多个' },
          { command: '#营地QQ全局登录', desc: 'QQ 扫码写入或更新，可多个' },
          { command: '#王者更新 / #农药更新', desc: '拉取最新插件代码' },
          { command: '#王者更新记录', desc: '查看近期更新功能' }
        ]
      }
    ]
  }
}

export async function renderMasterPanel(e) {
  const panelImage = await puppeteer.screenshot('helpConfig', {
    imgType: 'webp',
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/helpConfig.html',
    _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
    ...buildMasterPanelData()
  })

  await e.reply(panelImage)
}
