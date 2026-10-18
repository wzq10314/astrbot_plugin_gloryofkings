# 上游维护约定

指定上游固定为 https://gitee.com/longhengmu/GloryOfKings-Plugin ，默认 master。不要误切到原作者仓库或其他 fork。

本次 AstrBot v1.0.20 基准为 7187b9eefba0cb27a6b2131ba11e03a0550ef404（2026-10-18，上游 2.0.0）：英雄战力总排名、开黑组队、共享排名与头像展示。上一版 v1.0.19 基准 8b1ef1c53de6a9d2d9a687c9bcb0d00ddaf0761d 的隐私与查询修复保留。

## 适配边界

engine/upstream 归档 278 个上游文件，UPSTREAM.json 包含各文件 SHA-256，维护时按清单核对。适配位于 engine/worker.mjs、renderer.mjs、management.mjs，以及 Python services/、main.py。runtime.py 在运行目录应用有锚点检查的部署依赖和错误提示补丁，不修改归档的上游源码。

首次启动把受跟踪源码复制到 plugin_data 下的运行目录，建立 lib/puppeteer、lib/common、plugins/other/update 适配入口。源码更新只覆盖清单中的文件，保留 data、config/config、server、server-im。插件安装目录中不存放用户登录态。

## 更新准备

维护者运行：

```bash
python scripts/stage_upstream.py --stage ../gok-next-upstream
```

也可提供已经从指定上游检出的干净仓库：

```bash
python scripts/stage_upstream.py --checkout /path/to/GloryOfKings-Plugin --stage ../gok-next-upstream
```

脚本验证 origin、记录提交与文件摘要，并输出新增/修改/删除清单。只准备候选源码，不自动覆盖正在运行的插件。

## 合并与回归

1. 阅读上游提交，特别关注认证协议、外部服务接口、配置字段、定时任务和新增宿主 API。
2. 把已审查的候选 engine/upstream、UPSTREAM.json 合入开发分支。禁止复制上游 data、config/config、私人 local 扩展或外部分发服务。
3. 同步 AstrBot 的配置 schema/default、routes.json、LLM 工具说明和命令允许列表。
4. 安装锁定依赖并运行 `python -m unittest discover -s tests -v`。运行真实浏览器/存储测试前准备隔离的 runtime，再执行 `node tests/render_and_store.mjs <runtime目录> <截图输出路径>`。
5. 使用测试账号验证改变的外部接口。没有账号/私有服务时明确记录未验证部分，不能把 mock 测试说成真实联调。
6. 更新本项目版本、CHANGELOG 和验证记录，打包时排除 node_modules、运行数据、凭据和缓存。

原版 test/authPool.test.mjs 依赖作者本机 data/AuthPool.json，部分 sandbox 清单也引用公开仓库中不存在的文件。不要为跑测试索要作者凭据；本适配提供合成账号的等价回归验证。

机器人内 `#王者更新` 用来读取上游最新提交和日志；源码安装通过 AstrBot 的适配包完成。这样可避免上游 Yunzai 更新器把 AstrBot 入口和适配层覆盖掉。没有设置未经用户要求的定时监控或自动升级。

历史 v1.0.6 基准为 813e1d7c490916ed4ed1defb1b14ae03ad41d0d3（2026-09-27）。运行时加入的远端凭据明确地址授权继续保留，vendor 保持原样。公共默认配置中服务地址、令牌和管理密钥保持为空；不要复制维护者的实际接入信息。升级时保留用户配置与运行数据。

运行副本的部署错误提示使用 `engine/deploy-errors.mjs`：固定分类、主机名脱敏，不将原始异常或 URL 凭据回显，不建议因证书失败而降低传输安全。修改上游相关函数时必须同步检查运行时注入锚点与失败用例。

营地隐私指令只在私聊处理。LLM 可读取隐私帮助，但 `setPrivacy` / `battleShortcut` 只接受用户直接发出的命令；更新测试不修改真实账号隐私。

开黑 `teamUpEnabled` 默认 false、`teamBroadcastGroups` 默认空。运行模板仅清空上游作者的默认 distUrl，不覆盖现有用户值；新服务需管理员显式配置。新版 team/hero 排名外部 API 需服务端同时支持，纯源码更新不代表这些私有服务已完成真实联调。
