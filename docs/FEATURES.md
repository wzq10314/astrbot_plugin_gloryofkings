# 功能与路由清单

本清单按 v1.0.15 实际加载后生成的 [routes.json](../routes.json) 同步。上游基准为 `2cb07250a1ff3ac0930b16c563b76f597995e4c1`（2026-10-06）。

上游 42 个模块、107 条路由，AstrBot 管理适配新增 1 个模块、2 条路由，合计 **43 个模块、109 条路由**。LLM 工具和 Python 依赖管理命令另计。

下表逐条对应路由规则，同一处理函数的不同匹配规则分别列出；完整命令表达式和别名见 routes.json。`master` 对应 AstrBot 管理员，`admin` 对应群主、群管理员或 AstrBot 管理员。普通用户入口仍执行函数内的账号归属和场景校验；营地 IM 入口额外强制私聊。

| 模块 | 处理函数 | 规则权限 |
| --- | --- | --- |
| astrbotManagement.js | `accounts` | master |
| astrbotManagement.js | `configure` | master |
| campImDeploy.js | `connect` | master |
| campImDeploy.js | `connectRemote` | master |
| campImDeploy.js | `deploy` | master |
| campImDeploy.js | `status` | master |
| help.js | `showHelp` | 普通用户 |
| help.js | `showSubHelp` | 普通用户 |
| help.js | `showMasterPanel` | master |
| watchDeploy.js | `connect` | master |
| watchDeploy.js | `connectRemote` | master |
| watchDeploy.js | `deploy` | master |
| watchDeploy.js | `status` | master |
| battleExport.js | `exportCsv` | 普通用户 |
| battleReport.js | `daily` | 普通用户 |
| battleReport.js | `weekly` | 普通用户 |
| battleReport.js | `monthly` | 普通用户 |
| battleReport.js | `toggleDaily` | 普通用户 |
| battleReport.js | `toggleWeekly` | 普通用户 |
| battleReport.js | `toggleMonthly` | 普通用户 |
| blackList.js | `add` | master |
| blackList.js | `remove` | master |
| blackList.js | `list` | master |
| cacheManager.js | `status` | master |
| cacheManager.js | `clean` | master |
| campFriend.js | `list` | 普通用户 |
| campFriend.js | `chat` | 普通用户 |
| campIm.js | `status` | 普通用户 |
| campIm.js | `openMine` | 普通用户 |
| campIm.js | `closeMine` | 普通用户 |
| campIm.js | `reply` | 普通用户 |
| campIm.js | `resync` | master |
| campIm.js | `tryQuote` | 普通用户 |
| campRenew.js | `renewNow` | master |
| dataBackup.js | `backup` | master |
| dataBackup.js | `list` | master |
| gameNews.js | `list` | 普通用户 |
| gameNews.js | `latest` | 普通用户 |
| gameNews.js | `toggle` | admin |
| gameRecordPush.js | `toggle` | 普通用户 |
| gameRecordPush.js | `toggleOnline` | 普通用户 |
| gameRecordPush.js | `toggleStatus` | 普通用户 |
| gameRecordPush.js | `status` | 普通用户 |
| gameRecordPush.js | `clearAll` | master |
| groupReport.js | `report` | 普通用户 |
| groupReport.js | `toggle` | admin |
| groupReport.js | `status` | 普通用户 |
| heroDetail.js | `heroDetail` | 普通用户 |
| heroGuide.js | `guide` | 普通用户 |
| heroGuideAlias.js | `guide` | 普通用户 |
| heroMedalWall.js | `wall` | 普通用户 |
| kingCompare.js | `compare` | 普通用户 |
| rankTrend.js | `trend` | 普通用户 |
| scoreTrend.js | `trend` | 普通用户 |
| shareBind.js | `enable` | 普通用户 |
| shareBind.js | `disable` | 普通用户 |
| shareBind.js | `status` | 普通用户 |
| shareBind.js | `resync` | 普通用户 |
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
| skinMissing.js | `query` | 普通用户 |
| skinNews.js | `calendar` | 普通用户 |
| skinNews.js | `toggle` | admin |
| watchBattle.js | `watch` | 普通用户 |
| watchBattle.js | `startHinted` | 普通用户 |
| whoIsPlaying.js | `list` | 普通用户 |
| accountManager.js | `myWzryId` | 普通用户 |
| accountManager.js | `bindWzryId` | 普通用户 |
| accountManager.js | `switchWzryId` | 普通用户 |
| accountManager.js | `deleteWzryId` | 普通用户 |
| accountManager.js | `wechatGlobalScanLogin` | 普通用户 |
| accountManager.js | `qqGlobalScanLogin` | 普通用户 |
| accountManager.js | `showAuthPool` | master |
| accountManager.js | `clearInvalidCampAuth` | master |
| accountManager.js | `showHiddenProfiles` | master |
| accountManager.js | `clearHiddenProfiles` | master |
| allSeasonPerformance.js | `allRank` | 普通用户 |
| allSeasonPerformance.js | `allPeak` | 普通用户 |
| myKingHomepage.js | `allKingHomepage` | 普通用户 |
| myKingHomepage.js | `myKingHomepage` | 普通用户 |
| peakPerformance.js | `peakPerformance` | 普通用户 |
| queryGameStats.js | `queryModeStats` | 普通用户 |
| queryGameStats.js | `queryGameStatsBySlot` | 普通用户 |
| queryGameStats.js | `queryHeroStats` | 普通用户 |
| queryGameStats.js | `queryHeroStats` | 普通用户 |
| queryGameStats.js | `queryGameStats` | 普通用户 |
| rankList.js | `globalRank` | 普通用户 |
| rankList.js | `groupRank` | 普通用户 |
| seasonPage.js | `rankPage` | 普通用户 |
| seasonPage.js | `seasonAll` | 普通用户 |
| heroList.js | `heroList` | 普通用户 |
| heroTierList.js | `heroTierList` | 普通用户 |
| myHeroList.js | `myHeroList` | 普通用户 |
| skinWall.js | `skinWall` | 普通用户 |
| skinWall.js | `allSkins` | 普通用户 |
| update.js | `update` | master |
| update.js | `update_log` | master |
| heroFightingCapacity.js | `checkHeroFightingCapacity` | 普通用户 |
| heroSkin.js | `checkHeroSkin` | 普通用户 |

## 公告与大神观战

英雄攻略：`#王者英雄攻略 妲己`、`#王者出装 亚瑟`、`#王者铭文 孙悟空`、`#王者克制 妲己`。`#王者攻略`、`#王者铭文出装` 同样支持。短命令 `#英雄攻略`、`#攻略`、`#出装`、`#铭文`、`#铭文出装`、`#克制` 加英雄名由 heroGuideAlias.js 处理，优先级为 5000；带“王者”的命令优先级为 0。英雄子帮助和原版按钮继续提供攻略入口。官网数据无需登录，营地核心装备和铭文是需要登录态的增强内容。

- 公告查询：`#王者公告`、`#王者公告列表`；“资讯”可代替“公告”。使用官网公开接口，不需要绑定或登录营地，过滤体验服并优先展示官方置顶。
- 公告订阅：在目标群发送 `#开启王者公告推送` / `#关闭王者公告推送`，限群管理员或 AstrBot 管理员；自然语言调用使用相同权限。
- 公告正文自动分页，最多 3 张图直发，超过 3 张合并转发；首次定时检查建立水位，不补历史。
- `#观战大神` / `#观战大神 打野` 使用公共对局池，调用人无需本人登录，但账号池须有可用的营地登录态，并已接通观战服务。好友观战仍按本人账号归属校验。

## 定时任务

以下 11 个 cron 任务来自 routes.json，列出本版默认值；实际运行采用 AstrBot 插件设置，时区为 `Asia/Shanghai`。调整时间后重载插件。个人战绩/上下线及日周月报任务执行前会刷新订阅群成员，成员信息获取失败时暂缓该轮个人推送。

| 任务 | 配置项 | 默认 cron |
| --- | --- | --- |
| 王者战绩日报 | `dailyReportCron` | `0 47 23 * * *` |
| 王者战绩周报 | `weeklyReportCron` | `0 7 22 * * 0` |
| 王者战绩月报 | `monthlyReportCron` | `0 41 23 28-31 * *` |
| 王者图片缓存清理 | `imgCacheCleanCron` | `0 12 4 * * *` |
| 营地登录态保活 | `campRenewCron` | `0 13 5 * * *` |
| 王者公告 | `gameNewsCron` | `0 53 */2 * * *` |
| 王者战绩推送 | `battleResultCron` | `0 */2 * * * *` |
| 王者群日报 | `groupDailyReportCron` | `0 22 23 * * *` |
| 王者群周报 | `groupWeeklyReportCron` | `0 34 21 * * 0` |
| 王者群月报 | `groupMonthlyReportCron` | `0 18 23 28-31 * *` |
| 王者皮肤上新 | `skinNewsCron` | `0 26 12 * * *` |

公告默认每两小时第 53 分检查一次，`gameNewsCron` 留空时关闭自动推送并保留手动查询。个人和群月报的 cron 在 28—31 日触发，业务逻辑只在当月最后一天实际推送。

此外保留上游非 cron 后台工作：营地消息短轮询（`campImPollMs`，默认 3000 毫秒），以及安装/更新后的共享库接入提醒。它们按各自配置、服务状态和记录决定是否执行，不计入上述 11 个 cron 任务。独立观战开播提示轮询在当前上游中保持停用，提示检查随战绩轮询执行。

## 上游说明

上游完整 README 保留在 [engine/upstream/README.md](../engine/upstream/README.md)；其中锅巴配置页面对应本版的 AstrBot 设置与管理员命令。

OneBot11 不支持 QQ 官方交互按钮时不发送按钮段；查询、详情选择和切换功能仍可通过原命令完成。观战、营地消息和共享库服务端由作者另行分发；更新插件不自动迁移或替换既有服务进程。
