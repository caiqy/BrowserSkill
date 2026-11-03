# DSH 插件增强交付说明

此分支合入官方稳定版，只在 DSH 插件中保留官方接口尚未等效覆盖的适配。浏览器扩展、CLI、daemon 和协议均保持官方原版。本文说明源码契约与复现方式；实际检查、候选包和浏览器报告由对应 Comet 验收记录确认。

| 项目 | 固定来源或边界 |
| --- | --- |
| 官方 tag / commit | `dsh-plugin-v0.4.1` / `b8f2d4f0fa35c8c7c866229e1cf3b3329ae39de5` |
| 长期增强分支 | `dsh/plugin-parity-0.3.3`；名称中的旧版本表示初始基线 |
| 发行包及客户端 loader | `@caiqy/browser-skill-dsh-plugin`；Cordis patch entry 保持 `browserskill` |
| 本次候选 | `0.4.1-dsh.1`；候选不表示已发布，公开版本以 npm 和市场索引为准 |
| 配套组件 | 官方 CLI、运行中的 daemon、Chrome/Edge 扩展均为 0.4.1，协议 1.8 |
| 非目标 | 定制浏览器扩展、bsk 或宿主；操作轨迹录制、PDF、任意 CDP、远程文件传输、自动更新服务；不整批吸收 upstream/main |

六个公开 `bsk_*` 工具保持原名，复用官方控制与传输机制，以及插件的所有权、取消、队列、附件和本地 HTTP 路由。官方 evaluate/upload/download 替代旧重复适配；drag、step、view、incognito、原生对话框和待完成操作恢复一并保留。

## 控制流程与已知限制

先加载当前包的 `browser-skill`，核实浏览器实例，创建自有会话。在初始空白页完成导航后执行 `sync`，使用返回的 `context_id` 作为 `contextId`。默认 target 策略允许 DOM 操作与补充读取复用上下文；业务事实使用 `expect` 保护。脚本、无目标按键和视觉操作还需要该次 sync 返回且未消费的 `observation_id`。人工输入或文档替换撤销控制后重新同步并调整计划。

```text
bsk_session({ action: "browsers" })
bsk_session({ action: "start", browser: "<verified-instance-id>", name: "DSH enhancement smoke", url: "https://example.com" })
bsk_session({ action: "sync", session: "<owned-session-id>" })
bsk_interact({ action: "evaluate", session: "<owned-session-id>", contextId: "<received-context-id>", observationId: "<received-observation-id>", expression: "Promise.resolve(document.title)", awaitPromise: true, returnByValue: true })
```

上述 ID 必须替换为实际结果。`observe`、HTML、viewport screenshot 和历史 `view` 不授予新的行动权限。`step` 组合一次行动、可选就绪检查和只读 post-sync；检查其 `ok/action/readiness/post`，不能因后置读取失败而重复输入。原生对话框按官方 dialog 与 operation-await/cancel 恢复原操作，不能重新发起下载或脚本。

- evaluate 默认等待 Promise、按值返回，保留显式 false。页面异常是正常工具结果中的 `ok:false/error` 及存在时的可选 `dialogs`；调用方必须检查。进程、传输、超时及取消仍按实际失败报告。`returnByValue:false` 返回序列化描述。
- upload 验证 1..20 个本机文件，支持 input/drop；download 必须指定本机 output，默认不覆盖，明确授权覆盖才使用 `overwrite:true`。复用官方暂存、原子提交与释放机制。
- CLI 全局控制 flags 位于 `--` 前，表达式或目标字面量作为其后的单个参数，保留前导连字符和 Unicode；不通过 shell 拼接或去除守卫解决参数问题。
- 官方 0.4.1 的后台 fullPage 可能返回 `page_hidden` 或中断；本插件不保证后台等效，也不自动置顶、录像保活或绕守卫。前台成功不能充作后台通过证据。
- Edge 上传可能在派发期间撤销控制并返回 `control_context_invalid` / `effect_state: unknown`，具体触发原因未确定，本插件不宣称修复。允许时重新同步并只读核对一次文件名与内容，然后停止该会话，不重放上传。报告将该情况单列为已接受限制，不能算上传成功；其他错误仍按失败处理。

详细参数见包内 [skill](../skill/SKILL.md) 及其条件引用。

## 保留的七类增强

| 能力 | 行为 |
| --- | --- |
| fullPage screenshot | `scope:current/follow`、tabId/timeout、附件预览与显式新文件共存；output 排他创建，EEXIST 保留旧文件，stop 后保留显式输出；fullPage 与 ref/裁剪互斥；受上述官方后台限制约束 |
| browsers | 无会话读取官方实际 metadata；指定 profile 须核实映射并显式传 browser，目标不可用时停止 |
| emulate | 尺寸、dpr、UA、language、mobile/touch/maxTouchPoints、tabId 及预设覆盖；保留 false，off 与任何覆盖互斥；关闭后按真实设备基线核对 |
| observe 诊断 | probeHover/debugSurfaces 默认关闭，保留 tabId、hoverProbe/debug/dialogs；主动探针可能触发页面事件，不与页面输入并发 |
| HTML output | 显式 output 按 UTF8 排他新建，返回实际 writtenBytes、原始 byteSize、truncated；失败只清理自己未完成的文件 |
| wait-ms | daemon 级无会话整数 0..300000ms，可取消；时间经过不能证明页面业务就绪 |
| start name | 在官方 tracked/recoverable start 和 incognito 上叠加名称，不改变所有权、恢复和失败清理 |

路径均在插件/CLI 所在电脑。隐身会话需要浏览器明确允许扩展在隐身模式运行；不能借用普通标签或降级成普通会话。

## 可复现构建与打包

在 BrowserSkill 独立 workspace 根使用 pnpm 10.17.0；根 dsh-plugins 检查不覆盖此包。SDK 安装或切换使用 vfox。

```sh
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin typecheck
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin build
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin test
node scripts/check-dsh-package.mjs
npm pack ./packages/dsh-plugin-browserskill --ignore-scripts --pack-destination .
```

实际归档应为 `caiqy-browser-skill-dsh-plugin-0.4.1-dsh.1.tgz`；记录 pack 回执、哈希和源码提交。包包含 lib、客户端资源、skill、patch 和 LICENSE。包检查从无关 cwd 检查真实归档与技能资源，使用 fake runner，不能替代真实浏览器验证。不手改生成物；技能预算由构建和测试检查。

## 候选包真实冒烟

从 BrowserSkill workspace 运行，结果目录须为本次新目录，实例参数须当次核实：

```sh
node packages/dsh-plugin-browserskill/scripts/test-enhancement-live.mjs <absolute-candidate.tgz> <new-absolute-results-dir> <verified-chrome-id> <verified-edge-id> <chrome-or-edge> <comma-separated-features>
```

常规功能与 `screenshot`、`screenshotBackground` 分组运行，避免截图未知结果阻塞余下用例。Edge 的 `uploadSingle`、`uploadMultiple`、`uploadDrop` 各用一次新调用和新结果目录；不要一次请求多个 Edge 上传模式。实际完整参数保存在各次报告的 `requestedBrowsers/requestedFeatures` 中。

脚本在无关 cwd 经 tarball 的 `apply` 注册六工具，使用真实 runner、官方 CLI/daemon/扩展 0.4.1、协议 1.8 和本地无敏感页面，不安装到 profile。记录实际插件 hash、版本、实例、调用、输出及清理。后台截图单独验证并保留非前台/非 active 证据；官方后台拒绝与 Edge 上传不确定结果按上述已接受限制报告。清理失败、参数回归、其他错误不能归入该限制。

宿主注册、模型元数据与附件接口使用 fixture；PNG 字节与 renderer image block 检查不能证明真实 Desktop GUI 或附件授权服务已验收。缺权限、离线及其他环境阻塞须如实记录。失败或 unknown 后不继续同一会话的业务动作；允许的只读核对完成后清理自有资源。

## 安装、升级与成套回退

在用 profile 安装或重启均按明确授权执行。先准备已验证候选、哈希、原配置与恢复包，并确认没有未完成的浏览器任务。核对官方组件与协议后才安装插件；仅刷新网页不能证明宿主已加载新包。

```sh
# 已获对应授权后的命令模板：
dsh plugin --profile desktop add <absolute-path-to-verified-candidate.tgz>
```

回退到旧公开插件 `0.3.3-dsh.3` 时须成套恢复其官方 0.3.3 CLI、daemon 与扩展。若改用官方 0.4.1 DSH 插件，先停用增强包，避免重复注册；七类增强不再保证保留。旧定制扩展候选已撤回，不属于当前安装或回退方案。不改历史 tag 或已安装 node_modules。

开发检查、Runtime、独立 Verifier、两浏览器及实际 Desktop 验证分别报告。历史 0.3.3、旧候选或定制扩展实验不证明当前候选通过；未运行、失败、取消、阻塞及已接受限制不得计为功能通过。用户接受最终结果、npm 发布、远端 CI、push、PR 分别由主工作流及明确授权处理。
