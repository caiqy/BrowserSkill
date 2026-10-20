# DSH 插件增强交付说明

此分支在官方 DSH 插件上维护小补丁，复用官方 CLI、daemon 及 Chrome/Edge 扩展。本文的接口说明是候选实现契约；构建命令不等于执行证据，未完成的真实验收见文末。

| 项目 | 固定基线或边界 |
| --- | --- |
| 官方 tag / commit | `dsh-plugin-v0.3.3` / `d9a78aed47874459ae1e44523a597e42dd9acf99` |
| 实现仓库 / 分支 | `packages/browser-skill` / `dsh/plugin-parity-0.3.3` |
| 发行包名及插件注册 ID | `@caiqy/browser-skill-dsh-plugin`；patch entry 仍为 `browserskill`，客户端 loader ID 与发行包名一致 |
| 当前发行版本 | `0.3.3-dsh.3`，npm dist-tag 为 `dsh`；此前本地 `0.3.3-dsh.1` 保留原 tag 和交付记录 |
| 组件 | 官方 0.3.3 能力配套的 CLI、daemon 和浏览器扩展；运行时版本必须另行核实 |
| 非目标 | 不做用户操作轨迹录制（旧交接功能 A5）；保留已有 video；不增 PDF、原生拖拽、任意 CDP、远程浏览器文件传输或自定义扩展/二进制 |

公开工具仍为六个 `bsk_*`。新增能力经过原会话归属、FIFO、超时、取消与观察链路；`evaluate`、主动悬停及整页截图会影响页面。`browsers` 与 `wait-ms` 是不要求创建会话的 daemon 级操作。`list` 仍只列插件拥有的会话。HTTP 路由与附件授权边界不变。

## 结构化工具示例

调用前加载插件 skill，按实际结果替换 ID、ref 和路径。以下文件路径在插件/CLI 所在电脑，不是远程浏览器电脑。示例是使用说明，尚不证明当前候选已通过真实浏览器验收。

```text
bsk_session({ action: "browsers" })
bsk_session({ action: "start", browser: "<verified-instance-id>", name: "DSH enhancement smoke" })
bsk_interact({ action: "evaluate", session: "<id>", expression: "Promise.resolve(document.title)", awaitPromise: true, returnByValue: true, timeoutMs: 10000 })
bsk_interact({ action: "upload", session: "<id>", target: "@e3", files: ["C:/task/a.txt", "C:/task/b.txt"], mode: "input" })
bsk_interact({ action: "upload", session: "<id>", target: "@e4", files: ["C:/task/a.txt"], mode: "drop" })
bsk_interact({ action: "download", session: "<id>", target: "@e5", output: "C:/task/result.txt", overwrite: false })
bsk_inspect({ action: "screenshot", session: "<id>", fullPage: true, scope: "current", timeoutMs: 120000, output: "C:/task/page.png" })
bsk_assist({ action: "emulate", session: "<id>", device: "iphone-14", width: 420, dpr: 2, ua: "Mozilla/5.0 task-test", acceptLanguage: "zh-CN", mobile: false, touch: true, maxTouchPoints: 5 })
bsk_inspect({ action: "observe", session: "<id>", probeHover: true, debugSurfaces: true })
bsk_inspect({ action: "html", session: "<id>", maxBytes: 65536, output: "C:/task/page.html" })
bsk_page({ action: "wait-ms", durationMs: 250 })
bsk_assist({ action: "emulate", session: "<id>", off: true })
bsk_session({ action: "stop", session: "<id>" })
```

- `evaluate` 要求非空 expression，默认等待 Promise、按值返回；显式 false 保留。页面异常即使底层 exit 0 仍是失败，超时/取消不能当成功。详见 [JS 与文件传输](../skill/references/interaction-details.md)。
- upload 的 files 非空，默认 input，drop 使用投放目标；download 必须给 output，默认不覆盖，仅明确允许后使用 overwrite:true，沿用官方暂存、原子提交与释放。
- fullPage 与 ref/裁剪互斥；scope 需 fullPage:true，默认 follow 跟随追加内容，current 限初始文档高度。截图和 HTML 显式 output 都独占新建且保留用户文件；截图仍有原附件预览。HTML 无 output 保留内联正文，有 output 只返回 path、UTF-8 writtenBytes、原始 byteSize、truncated 等元数据，不重复正文。详见 [截图与 HTML](../skill/references/screenshots-and-canvas.md)。
- emulate 的手动值覆盖预设，预设可补齐宽高；mobile:false/touch:false 显式关闭。dpr/mobile 需尺寸或预设，acceptLanguage 需 ua/预设，maxTouchPoints 为正整数并隐含启用 touch，但显式 touch:false 优先于预设和 maxTouchPoints，仍关闭触摸。off:true 与任何覆盖（包括 false）互斥。probeHover/debugSurfaces 默认关闭；主动悬停会触发事件，返回实际 hoverProbe/debug/dialogs，不与页面操作并发。wait-ms 接受整数 0..300000，可取消，完成只代表时间经过；原 wait 仍是生命周期等待。详见 [交互细节](../skill/references/interaction-details.md)。
- browsers 不创建/切换会话，仅返回官方实际字段；指定 profile 仍须核实实例映射并明确传 browser，目标不可用时停止。name 进入原 tracked start，不改变恢复、日志、失败清理或所有权。详见 [浏览器与会话](../skill/references/tabs-and-profiles.md)。

## 可复现构建与打包

在 BrowserSkill 独立 workspace 根执行；根 dsh-plugins workspace 的构建不覆盖此包。使用现有依赖与 pnpm 10.17.0；Node 基线以仓库配置为准，需要安装/切换 SDK 时用 vfox。下列是交付复现步骤，执行前确保依赖已准备，不能用旧 lib 证明源码正确。

```sh
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin typecheck
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin test
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin build
node scripts/check-dsh-package.mjs
npm pack ./packages/dsh-plugin-browserskill --ignore-scripts --pack-destination .
corepack pnpm dlx publint@0.3.25 run ./caiqy-browser-skill-dsh-plugin-0.3.3-dsh.3.tgz
```

官方基线虽有 `lint:publint` 脚本，却未声明或安装 publint；上方用固定版本的临时 dlx 工具执行相同检查，不改项目依赖或锁文件。官方客户端 CSS 构建的 classMap 键顺序不固定，重复构建可能仅此处字节不同；交付一致性检查只对这些纯字符串 CSS 映射排序后比较，其他客户端代码及 runtime、类型、skill 和包元数据保持逐字节检查。

先完成 build，再用上方 `npm pack --ignore-scripts` 从当前生成物打包到 workspace 根，随后 publint 直接检查该 tgz；避免 dlx 的 cwd/包管理器推断选中 monorepo 根包。常规 pack 的 prepack 会重复构建，当前流程已显式完成构建，因此关闭脚本。当前发行包为 `caiqy-browser-skill-dsh-plugin-0.3.3-dsh.3.tgz`；按实际命令输出确认位置。包保留 lib、skill、patch、LICENSE 和客户端资源。check-dsh-package 在无关 cwd 检查实际归档及技能资源解析，使用 fake runner，不替代浏览器实测。技能入口含 frontmatter 的 UTF-8 总大小仍限 4500 字节，各 references 必须从入口直接路由；构建器生成内容，不手改生成文件。

开发中仅核对技能时可使用：

```sh
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin build:skill
corepack pnpm --filter @caiqy/browser-skill-dsh-plugin exec vitest run tests/skill.test.ts
node scripts/check-skill-bundles.mjs
node --test scripts/check-skill-bundles.test.mjs
```

## 候选包真实冒烟

从 BrowserSkill workspace 运行以下脚本，使用新的结果目录。它解包 tgz，在无关 cwd 通过包的 `apply` 注册六工具并使用默认真实 runner；不安装到任何 profile。已安装的 peer 依赖仅链接到临时目录；本地 HTTP 页面、数据、临时目录和自有会话由脚本清理。Chrome/Edge 参数必须是当次核实的实例，目标不可用时停止该浏览器测试。

```sh
node packages/dsh-plugin-browserskill/scripts/test-enhancement-live.mjs <absolute-candidate.tgz> <new-absolute-results-dir> <verified-chrome-id> <verified-edge-id>
# 可追加 chrome 或 edge 只补测某浏览器；再追加以逗号分隔的 feature 名仅补测这些特性。
```

脚本保存实际调用与逐项结果、截图、HTML 和下载内容。截图使用真实 PNG，附件保存及 renderer 使用本地宿主接口 fixture，证明字节与 image block 路径；此结果不代表真实 DSH GUI 的显示或授权接口已经验收。BrowserSkill 的文件上传需要对应扩展开启“允许访问文件网址”；缺少权限时保留官方错误，由用户处理权限后补测，不能记为成功。

## 安装与生效边界

正式 desktop 安装与在用 profile 重启必须等验收结果被接受后，再取得对应明确授权。本文不代表授权，也未执行安装、重启或 npm 发布。安装应使用已验证候选 tgz 的绝对路径，核对 profile 依赖及 bundle 指向，随后按宿主要求重载；重新加载 skill 后确认六工具是当前候选，再验证 UI 和附件。

已获授权后的正式安装命令模板：

```sh
dsh plugin --profile desktop add <absolute-path-to-candidate.tgz>
```

退出并重新启动同一 desktop profile 的具体方式按实际宿主记录；不能假定 Web 刷新已加载新插件，也不能以旧 desktop 工具或直接 CLI 结果代替候选插件实测。隔离开发 profile 的装载也必须遵守相应授权边界。

## 更新与回退

采用 manual 更新：核对官方新稳定 tag 是否已吸收增强，在长期增强分支合入稳定 tag 并保留仍需要的小补丁，按新的官方组件版本重跑包检查与 Chrome/Edge 冒烟，再提高发行版本并重新打包。增强版使用 `@caiqy/browser-skill-dsh-plugin`，不维护自定义 CLI/扩展发行版。

通过索引中的精确版本或 npm `dsh` 标签升级增强版。官方包与增强包不能同时启用；如需回退，先卸载增强包，再安装官方 `0.3.3`，对应授权后执行：

```sh
dsh plugin --profile desktop remove @caiqy/browser-skill-dsh-plugin
dsh plugin --profile desktop add @wxg-prc-cpg/browser-skill-dsh-plugin@0.3.3
```

核对依赖恢复为官方版本，按宿主要求重载并重新加载 skill；CLI/daemon/扩展保持匹配官方能力。只替换插件并不自动更新其他组件。保留源码补丁和候选 tgz 便于重装；不手改已安装 node_modules。Git 提交、push、merge、发布及重启分别受各自授权约束。

## 当前验证记录与待补证据

2026-10-19 使用 Node v22.23.1 / pnpm 10.17.0。以下为 Build 的实际证据；正式 typecheck/test/build、publint、包检查和独立验收由 Comet Runtime 在冻结候选后执行，最终结论以该 change 的 verification 记录为准：

| 证据 | 当前边界 / 待填内容 |
| --- | --- |
| 技能定向检查 | `build:skill` 通过；`vitest run tests/skill.test.ts` 5/5；`node scripts/check-skill-bundles.mjs` 通过，DSH 入口 4109 UTF-8 bytes、7 个资源；`node --test scripts/check-skill-bundles.test.mjs` 6/6，含 LF/CRLF 与路由/预算契约 |
| 最终源码与 tgz | 源码在上述补丁分支；交付 manifest 记录最终提交。候选位于父 workspace `artifacts/browserskill-dsh-enhancement/wxg-prc-cpg-browser-skill-dsh-plugin-0.3.3-dsh.1.tgz`，SHA256 `81d7eec2d2315b0e95d5170d5a09e4c45d2269ed17c8f702485ecc71028e40b9` |
| 开发期源码检查 | tsc --noEmit 通过；runner/tools 定向测试 157/157；此前 enhancement 定向 41/41，含 FIFO、取消、实际 argv 和独占文件保护。build 通过并从生成物打包。正式完整计划交由 Runtime 执行，不把这些记录当独立验收 |
| 组件版本 | 2026-10-19 已核实官方 CLI / daemon / Chrome 与 Edge 扩展均为 0.3.3；浏览器均为 155.0.0.0、协议 1.3、无版本偏差。Chrome 实例 2303ebf6（chrome）；Edge 实例 daae7a27（edge-gmail3）。以各次报告记录的实际连接状态为准 |
| Chrome 实测 | 同一候选 SHA256；父 workspace 的 `artifacts/browserskill-dsh-enhancement/live-phase-4-chrome/report.json` 记录 JS、缺失文件错误、下载、整页 current/follow、HTML、模拟、悬停通过；首次上传因缺少扩展文件网址权限失败，用户开启后 `live-phase-5-chrome-upload/report.json` 单/多文件 input 与 drop 三项全部通过并逐字核对内容。会话停止、自有列表为空，969×2296 PNG 在 stop 后保留；HTML 4830 UTF-8 bytes |
| Edge 实测 | 原实例 daae7a27 恢复后，`artifacts/browserskill-dsh-enhancement/live-phase-6-edge/report.json` 的 10/10 特性通过，failures 为空；961×2296 PNG、HTML 4831 UTF-8 bytes，hcss 会话 stop/list 为空且截图保留。两端均覆盖 Promise/false/throw/真实超时/取消、wait-ms/命名；附件与宿主 fixture 边界见上文，不宣称 desktop GUI 已验收 |
| 正式 desktop | 未安装增强包，未重启；待验收接受后的明确授权，不与隔离环境结果混淆 |

真实冒烟使用无敏感本地页面和数据。失败、取消、阻塞、未运行分别如实记录；mock、技能测试和 fake runner 均不能证明扩展/daemon/宿主真实兼容。独立验收结论及用户接受结果由主工作流管理。
