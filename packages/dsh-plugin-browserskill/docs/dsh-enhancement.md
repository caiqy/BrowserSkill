# DSH 插件增强交付说明

此分支合入官方稳定版，再保留官方 DSH 接口尚未等效覆盖的小型适配。CLI、daemon 保持官方 0.4.1；本次已确认范围另含独立标识的扩展后台兼容候选，协议保持 1.8。本文说明源码契约与复现方式；命令不等于执行证据，最终结果以对应 Comet 验收记录和候选报告为准。

| 项目 | 固定来源或边界 |
| --- | --- |
| 官方 tag / commit | `dsh-plugin-v0.4.1` / `b8f2d4f0fa35c8c7c866229e1cf3b3329ae39de5` |
| 长期增强分支 | `dsh/plugin-parity-0.3.3`；名称中的旧版本表示初始基线 |
| 发行包及客户端 loader | `@caiqy/browser-skill-dsh-plugin`；Cordis patch entry 保持 `browserskill` |
| 本次候选 | `0.4.1-dsh.1`；候选不表示已发布，公开版本以 npm 和市场索引为准 |
| 配套组件 | 官方 CLI/daemon 0.4.1、协议 1.8；扩展应用 0.4.1-dsh.1、数字 manifest 0.4.1.1，单独记录 build/source/hash |
| 非目标 | 自定义 Rust CLI/daemon、协议或宿主；操作轨迹录制、PDF、任意 CDP、远程文件传输、自动更新服务；不整批吸收 upstream/main |

兼容修复以当前请求授权为边界，复用现有 controller/guard/driver 后台许可；人工接管、取消、导航与页面身份变化仍可撤销，不因渲染许可而放宽控制。多持有者分别释放，未知效果先只读核对再停止。后台截图和 Edge 上传须以对应配套候选的真实报告为准，旧候选分项通过不代表新修复已完成。

六个公开 `bsk_*` 工具保持原名；会话所有权、取消、清理、附件和本地 HTTP 路由的信任边界保持。官方 evaluate/upload/download 适配替代旧重复实现；官方 drag、step、view、incognito、原生对话框和待完成操作恢复一并保留。

## 控制流程与行为变化

先加载当前包的 `browser-skill`，核实浏览器实例，使用 `bsk_session` 创建自有会话。正常页面操作前执行 `sync`，使用实际返回的 `context_id` 作为 `contextId`。默认 target 策略允许 DOM 操作与补充读取复用上下文；业务事实使用 `expect` 保护。脚本、无目标按键和视觉操作还需要该次 sync 返回且未消费的 `observation_id`。人工输入或文档替换撤销控制后重新同步，不自动重试未知结果的动作。

```text
bsk_session({ action: "browsers" })
bsk_session({ action: "start", browser: "<verified-instance-id>", name: "DSH enhancement smoke" })
bsk_session({ action: "sync", session: "<owned-session-id>" })
bsk_interact({ action: "evaluate", session: "<owned-session-id>", contextId: "<received-context-id>", observationId: "<received-observation-id>", expression: "Promise.resolve(document.title)", awaitPromise: true, returnByValue: true })
```

上述 ID 必须替换为实际结果；示例只说明接口。每次后续操作按当前证据重新决定参数，不能机械重复同一观察凭据。`observe`、HTML、viewport screenshot 和历史 `view` 本身不授予新的行动权限。`step` 组合一次行动、可选就绪检查和只读 post-sync；检查其 `ok/action/readiness/post`，不能因后置读取失败而重新输入。原生对话框出现时，按官方 dialog 与 operation-await/cancel 恢复原操作，不能重复发起下载或脚本。

- evaluate 默认等待 Promise、按值返回，显式 false 保留。页面异常返回正常工具结果中的 `ok:false/error` 及存在时的可选 `dialogs`，调用方必须检查；进程、传输、超时及取消仍按实际失败报告。`returnByValue:false` 返回序列化描述，不提供可直接操纵的进程内 JS 对象。
- upload 验证 1..20 个本机文件，支持 input/drop；download 必须指定本机 output，默认不覆盖，明确授权覆盖才使用 overwrite:true。复用官方传输归属、暂存、原子提交与释放机制。
- 所有 CLI 全局控制 flags 位于 `--` 前，表达式或目标字面量作为其后的单个参数，保留前导连字符和 Unicode；不通过 shell 拼接或去除守卫解决参数问题。

详细操作与参数见包内 [skill](../skill/SKILL.md) 及其条件引用；该入口只包含公开工具示例。

## 保留的七类增强

| 能力 | 行为 |
| --- | --- |
| fullPage screenshot | `scope:current/follow`、tabId/timeout、附件预览与显式新文件共存；output 排他创建，EEXIST 保留旧文件，stop 后保留显式输出；fullPage 与 ref/裁剪互斥 |
| browsers | 无会话读取官方实际 metadata，不创建或切换会话；指定 profile 须核实映射并显式传 browser，目标不可用时停止 |
| emulate | 全部尺寸、dpr、UA、language、mobile/touch/maxTouchPoints、tabId 及预设覆盖；false 保留，off 与任何覆盖互斥；按官方控制要求传凭据 |
| observe 诊断 | probeHover/debugSurfaces 默认关闭，保留 tabId、hoverProbe/debug/dialogs；主动探针可能触发页面事件，不与页面输入并发 |
| HTML output | 内联正文行为保持；显式 output 按 UTF8 排他新建，返回实际 writtenBytes、原始 byteSize、truncated 等，不重复正文；失败只清理自己未完成的文件 |
| wait-ms | daemon 级无会话整数 0..300000ms，可取消；完成只说明时间经过，不能证明页面业务就绪 |
| start name | 在官方 tracked/recoverable start 和 incognito 上叠加名称，不改变所有权、恢复和失败清理 |

路径均在插件/CLI 所在电脑。隐身会话需要浏览器明确允许扩展在隐身模式运行；不能借用普通标签或降级成普通会话。

## 可复现构建与打包

在 BrowserSkill 独立 workspace 根执行，使用该仓库的 pnpm 10.17.0 和现有依赖；根 dsh-plugins workspace 检查不覆盖此包。SDK 安装或切换使用 vfox。先构建当前源码，再打包当前生成物。

```sh
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin typecheck
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin build
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin test
node scripts/check-dsh-package.mjs
npm pack ./packages/dsh-plugin-browserskill --ignore-scripts --pack-destination .
```

归档名应为 `caiqy-browser-skill-dsh-plugin-0.4.1-dsh.1.tgz`，以实际 pack 回执为准；记录其哈希和对应源码提交。包应包含 lib、客户端资源、skill、patch 和 LICENSE。包检查在无关 cwd 解析实际归档与技能资源，使用 fake runner，不能替代真实浏览器验证。不手改生成的 lib 或技能 bundle；技能入口与引用预算由构建和测试检查。

## 候选包真实冒烟

从 BrowserSkill workspace 运行；结果目录须为本次新目录，Chrome/Edge 参数为当次核实的实例。

```sh
node packages/dsh-plugin-browserskill/scripts/test-enhancement-live.mjs <absolute-candidate.tgz> <new-absolute-results-dir> <verified-chrome-id> <verified-edge-id>
# 可追加 chrome 或 edge，仅测该浏览器；再追加逗号分隔的 feature 名补测。
```

脚本解包 tarball，在无关 cwd 经包的 `apply` 注册六工具，使用默认真实 runner、官方 CLI/daemon 和指定兼容扩展及本地无敏感页面；不安装到 profile。核实官方 CLI/daemon 0.4.1、协议 1.8、扩展应用 0.4.1-dsh.1/数字 manifest 0.4.1.1 及对应 build/source/hash；配套缺失或目标离线如实阻塞。后台场景须在不置顶、目标非 active 的自有标签实际完成；request-help 恢复前台后成功不能代替。每组结果保留版本、实例、调用、输出和清理证据；unknown 后在允许范围内重新同步、只读核对再停止，不重放动作。

注册上下文、模型元数据和附件接口使用宿主 fixture。真实 PNG 字节及 renderer image block 的检查不能证明真实 Desktop GUI 或附件授权服务已验收。文件上传可能需要扩展的文件网址权限，incognito 需要单独许可；缺权限时保留官方错误，由用户决定后补测。

## 安装、升级与成套回退

在用 profile 的安装、重启及配套组件升级分别按明确授权执行。先准备已验证候选、哈希、原配置和恢复包；确认没有未完成的浏览器任务。按官方方式使 CLI、运行中的 daemon、两端扩展先后到达配套版本，再安装候选并重载相同 profile，重新调用 skill，核对当前六工具与实际协议。仅刷新网页不能证明宿主已加载新包。

已获对应授权后的安装命令模板：

```sh
dsh plugin --profile desktop add <absolute-path-to-verified-candidate.tgz>
```

移除本轮兼容扩展并恢复官方扩展 0.4.1，可恢复官方基底行为与其已知后台限制，CLI/daemon 不需更换；这不等于后台验收通过。旧公开增强包 `0.3.3-dsh.3` 配套官方 0.3.3；若回退到该包，须成套恢复插件、CLI、daemon 和扩展，而非只回退一个组件。若改用官方 0.4.1 DSH 插件，先按宿主支持方式停用增强包，避免两个插件同时注册；此时七类增强不再保证保留。保留旧版本与新候选，不改写历史 tag，不手改已安装 node_modules。

本次开发、正式检查、两浏览器及实际 Desktop 验证分别报告。旧 2026-10-19 的 0.3.3 报告仅为历史；当前候选未运行、失败、取消或阻塞的项目不得计为通过。Comet 独立验收及用户结果接受由主工作流记录，npm 发布、远端 CI、push、PR 不由本文授权。
