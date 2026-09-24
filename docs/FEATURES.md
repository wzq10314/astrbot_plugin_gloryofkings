# 功能与路由清单

自动从本版实际加载的 Node 模块生成；原版 40 个模块、101 条路由，AstrBot 管理新增 1 个模块、2 条路由。
LLM 工具和 Python 依赖管理命令另计。

| 模块 | 处理函数 | 原版权限 |
| --- | --- | --- |
| astrbotManagement.js | `accounts` | master |
| astrbotManagement.js | `configure` | master |
| campImDeploy.js | `connect` | master |
| campImDeploy.js | `deploy` | master |
| campImDeploy.js | `status` | master |
| watchDeploy.js | `connect` | master |
| watchDeploy.js | `deploy` | master |
| watchDeploy.js | `status` | master |
| battleExport.js | `exportCsv` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `daily` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `weekly` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `monthly` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `toggleDaily` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `toggleWeekly` | 普通用户（函数内还会校验账号归属/场景） |
| battleReport.js | `toggleMonthly` | 普通用户（函数内还会校验账号归属/场景） |
| blackList.js | `add` | master |
| blackList.js | `remove` | master |
| blackList.js | `list` | master |
| cacheManager.js | `status` | master |
| cacheManager.js | `clean` | master |
| campFriend.js | `list` | 普通用户（函数内还会校验账号归属/场景） |
| campFriend.js | `chat` | 普通用户（函数内还会校验账号归属/场景） |
| campIm.js | `status` | 普通用户（函数内还会校验账号归属/场景） |
| campIm.js | `openMine` | 普通用户（函数内还会校验账号归属/场景） |
| campIm.js | `closeMine` | 普通用户（函数内还会校验账号归属/场景） |
| campIm.js | `reply` | 普通用户（函数内还会校验账号归属/场景） |
| campIm.js | `resync` | master |
| campIm.js | `tryQuote` | 普通用户（函数内还会校验账号归属/场景） |
| campRenew.js | `renewNow` | master |
| dataBackup.js | `backup` | master |
| dataBackup.js | `list` | master |
| gameRecordPush.js | `toggle` | 普通用户（函数内还会校验账号归属/场景） |
| gameRecordPush.js | `toggleOnline` | 普通用户（函数内还会校验账号归属/场景） |
| gameRecordPush.js | `toggleStatus` | 普通用户（函数内还会校验账号归属/场景） |
| gameRecordPush.js | `status` | 普通用户（函数内还会校验账号归属/场景） |
| gameRecordPush.js | `clearAll` | master |
| groupReport.js | `report` | 普通用户（函数内还会校验账号归属/场景） |
| groupReport.js | `toggle` | admin |
| groupReport.js | `status` | 普通用户（函数内还会校验账号归属/场景） |
| heroDetail.js | `heroDetail` | 普通用户（函数内还会校验账号归属/场景） |
| heroGuide.js | `guide` | 普通用户（函数内还会校验账号归属/场景） |
| heroMedalWall.js | `wall` | 普通用户（函数内还会校验账号归属/场景） |
| kingCompare.js | `compare` | 普通用户（函数内还会校验账号归属/场景） |
| rankTrend.js | `trend` | 普通用户（函数内还会校验账号归属/场景） |
| scoreTrend.js | `trend` | 普通用户（函数内还会校验账号归属/场景） |
| shareBind.js | `enable` | 普通用户（函数内还会校验账号归属/场景） |
| shareBind.js | `disable` | 普通用户（函数内还会校验账号归属/场景） |
| shareBind.js | `status` | 普通用户（函数内还会校验账号归属/场景） |
| shareBind.js | `resync` | 普通用户（函数内还会校验账号归属/场景） |
| shareBind.js | `masterPanel` | master |
| shareBind.js | `masterEnable` | master |
| shareBind.js | `masterDisable` | master |
| shareBind.js | `setUrl` | master |
| shareBind.js | `setToken` | master |
| shareBind.js | `setAdminSecret` | master |
| shareDeploy.js | `issue` | master |
| shareDeploy.js | `clients` | master |
| shareDeploy.js | `revoke` | master |
| shareDeploy.js | `syncAll` | master |
| shareDeploy.js | `lookup` | master |
| shareNotify.js | `remind` | master |
| skinMissing.js | `query` | 普通用户（函数内还会校验账号归属/场景） |
| skinNews.js | `calendar` | 普通用户（函数内还会校验账号归属/场景） |
| skinNews.js | `toggle` | admin |
| watchBattle.js | `watch` | 普通用户（函数内还会校验账号归属/场景） |
| watchBattle.js | `startHinted` | 普通用户（函数内还会校验账号归属/场景） |
| whoIsPlaying.js | `list` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `myWzryId` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `howToGetWzryId` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `bindWzryId` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `switchWzryId` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `deleteWzryId` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `wechatGlobalScanLogin` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `qqGlobalScanLogin` | 普通用户（函数内还会校验账号归属/场景） |
| accountManager.js | `showAuthPool` | master |
| accountManager.js | `clearInvalidCampAuth` | master |
| accountManager.js | `showHiddenProfiles` | master |
| accountManager.js | `clearHiddenProfiles` | master |
| allSeasonPerformance.js | `allRank` | 普通用户（函数内还会校验账号归属/场景） |
| allSeasonPerformance.js | `allPeak` | 普通用户（函数内还会校验账号归属/场景） |
| help.js | `showHelp` | 普通用户（函数内还会校验账号归属/场景） |
| help.js | `showMasterPanel` | master |
| myKingHomepage.js | `allKingHomepage` | 普通用户（函数内还会校验账号归属/场景） |
| myKingHomepage.js | `myKingHomepage` | 普通用户（函数内还会校验账号归属/场景） |
| peakPerformance.js | `peakPerformance` | 普通用户（函数内还会校验账号归属/场景） |
| queryGameStats.js | `queryModeStats` | 普通用户（函数内还会校验账号归属/场景） |
| queryGameStats.js | `queryGameStatsBySlot` | 普通用户（函数内还会校验账号归属/场景） |
| queryGameStats.js | `queryHeroStats` | 普通用户（函数内还会校验账号归属/场景） |
| queryGameStats.js | `queryHeroStats` | 普通用户（函数内还会校验账号归属/场景） |
| queryGameStats.js | `queryGameStats` | 普通用户（函数内还会校验账号归属/场景） |
| rankList.js | `globalRank` | 普通用户（函数内还会校验账号归属/场景） |
| rankList.js | `groupRank` | 普通用户（函数内还会校验账号归属/场景） |
| seasonPage.js | `rankPage` | 普通用户（函数内还会校验账号归属/场景） |
| seasonPage.js | `seasonAll` | 普通用户（函数内还会校验账号归属/场景） |
| heroList.js | `heroList` | 普通用户（函数内还会校验账号归属/场景） |
| heroTierList.js | `heroTierList` | 普通用户（函数内还会校验账号归属/场景） |
| myHeroList.js | `myHeroList` | 普通用户（函数内还会校验账号归属/场景） |
| skinWall.js | `skinWall` | 普通用户（函数内还会校验账号归属/场景） |
| skinWall.js | `allSkins` | 普通用户（函数内还会校验账号归属/场景） |
| update.js | `update` | master |
| update.js | `update_log` | master |
| heroFightingCapacity.js | `checkHeroFightingCapacity` | 普通用户（函数内还会校验账号归属/场景） |
| heroSkin.js | `checkHeroSkin` | 普通用户（函数内还会校验账号归属/场景） |

## 定时任务

任务使用原版配置，默认北京时间。原版额外保留营地消息短轮询和观战开播提示轮询。

- 王者战绩日报：`0 47 23 * * *`
- 王者战绩周报：`0 7 22 * * 0`
- 王者战绩月报：`0 41 23 28-31 * *`
- 王者图片缓存清理：`0 12 4 * * *`
- 营地登录态保活：`0 13 5 * * *`
- 王者战绩推送：`0 */2 * * * *`
- 王者群日报：`0 22 23 * * *`
- 王者群周报：`0 34 21 * * 0`
- 王者群月报：`0 18 23 28-31 * *`
- 王者皮肤上新：`0 26 12 * * *`

## 上游说明

上游完整 README 保留在 `engine/upstream/README.md`；其中锅巴配置页面对应本版的 AstrBot 设置与管理员命令。
OneBot11 不支持 QQ 官方交互按钮时不发送按钮段；查询、详情选择和切换功能仍可通过原命令完成。
