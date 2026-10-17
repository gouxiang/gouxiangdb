# PoC-4 报告：壳独立回环静态口 → 跨源连本地内核口（#816 承载验证）

- 日期：2026-10-17
- 分支：`feat/macos-desktop-d0`（本地提交，未 push）
- 依据：`docs/design/2026-10-node-mode/DESIGN-MACOS-APP.md` §8.5「界面承载方式的必要修订」、§6/§7、§15
- 机器：macOS Apple Silicon（darwin/arm64），Tauri 2.12.4 / tauri-plugin-updater 2.13.3 / 随包 Node arm64
- 结论一句话：**成立。壳在独立回环口只托管 `web/dist`、业务全部跨端口连本地内核口，CORS（含预检）、X-GX-Token、multipart、WebSocket、公开/私有图全部跑通；后端零改动，且不需要 §7.3 预告的桌面专用 CORP 放宽。同日在正式构建产物上补测远端：明文 http 局域网节点与 https 远端节点经一份最小 `Info.plist` ATS 配置后在 WKWebView 内连通（#91/#92 PASS）。**

## 1. 要验证什么

§8.5 把界面承载从 PoC-1/2 的「内核兼任前端同源托管」改为启动器模型必需的：

> 壳自己在回环口开一个极简静态服务，只托管 `web/dist`，不碰任何数据/API；数据源全走 resolver 跨源。

这样「任何节点连接前」启动器界面就已存在。但页面源（壳口）与本地内核源（内核口）端口不同 = **跨源**，必须在真实 WKWebView 里裁决：
CORS 简单请求、预检（OPTIONS）、自定义头 `X-GX-Token`、multipart、no-cors 公开图的 CORP、带票 fetch 私有图、跨源 WS。

node/curl 不强制浏览器 CORS/CORP，故只能在真机 WKWebView 判定——这就是本 PoC。

## 2. 怎么做的（零新后端、零新 Rust 依赖）

- **Rust（`apps/desktop/src-tauri/src/main.rs`，`GX_POC4=1` 门控，默认仍 PoC-1 同源路径）**：
  - `boot_local_kernel(..., navigate: bool) -> Result<u16>`：`navigate=false` 时只起内核、不跳页，返回内核口；
  - 新增 `serve_static_loopback(root)`：**纯 std**（`TcpListener` + thread-per-connection）的回环静态服务，只绑 `127.0.0.1:0`（随机口），带目录穿越防护与 MIME；
  - `run_poc4`：起内核（不导航）→ 起壳静态口托管 `server/public` → WebView 导到 `http://127.0.0.1:<壳口>/poc4.html?kernel=<内核口>`；
  - 壳口提供同源结果旁路 `GET /__poc4/...`，探针把结论编码进路径落 `/tmp/gx-poc4-shell.log`，实现无交互判定。
- **探针（`apps/desktop/poc/poc4.html`，仅 `GX_POC4=1` 由 stage 注入随包）**：页面由壳口提供，12 个核心步 + 2 个观察项，所有业务请求发往内核口（`mode:"cors"`）。
- **stage（`stage-node-sidecar.mjs`）**：`GX_POC4=1` 时把 poc4.html 复制进 `server/public`。
- **驱动（`poc/run-poc4.sh`）**：隔离安装副本 + 隔离数据目录 `/tmp/gx-poc4/data`（`GX_POC3_DATA_DIR` 覆盖），**不碰真实 `~/Library/Application Support`**；壳指纹硬校验、随包探针页核查、无交互等 `DONE`。

复跑：
```bash
GX_POC4=1 node apps/desktop/scripts/stage-node-sidecar.mjs     # 含原生件自检+真建库冒烟
cd apps/desktop/src-tauri
CARGO_BUILD_JOBS=2 tauri build --bundles app --config <含 updater 段的最小 config>   # 见 §5 踩坑 1
cd ../.. && bash apps/desktop/poc/run-poc4.sh run
```

## 3. 结果（末轮 12/12 + 远端观察 #91/#92 全 PASS）

末轮干净隔离数据复跑：壳口 `54539`、内核口 `54535`，确为跨源（不同端口）。原始无交互日志落在 `/tmp/gx-poc4-shell.log`（被 `.gitignore` 的 `*.log` 规则排除，不入库；下表为解码后的完整证据）。

| # | 项 | 结果 |
|---|---|---|
| 0 | 壳口与内核口确为跨源 | PASS |
| 1 | 跨源 GET `/auth/bootstrap-status`（简单请求，ACAO 放行、可读 JSON） | PASS |
| 2 | 跨源 POST `/auth/signup`（`application/json` 触发预检，通过）拿 token | PASS |
| 3 | 带 `X-GX-Token` 跨源 GET `/api/health`（自定义头预检 + ACAH 放行） | PASS |
| 4 | 跨源 GET `/auth/me`（X-GX-Token 身份头） | PASS |
| 5 | 跨源 POST `/bases` 201（写） | PASS |
| 6 | 跨源 GET `/bases` 读回，CRUD 闭环 | PASS |
| 7 | 跨源 multipart POST `/auth/me/avatar` | PASS |
| 9 | 私有附件带票 `cors fetch → blob → <img>` 解码 1×1 | PASS |
| 10 | 跨源无票私有附件 → 401（错误响应仍带 CORS 头，状态可读） | PASS |
| 11 | 跨源 WebSocket `/ws/collab/...` 升级并收服务端首帧 4B | PASS |
| 12 | 跨源坏票 WS → 先握手再 `close(4401 ticket_invalid)` | PASS |
| 80（观察） | 公开头像 no-cors `<img src=内核口>` **跨端口直接显示** | PASS |
| 91（观察） | **明文 http 局域网节点** `http://192.168.31.15:3001/uploads/avatars/__ats_probe__.png`，no-cors opaque，**64ms 连通**（ATS 放行后） | PASS |
| 92（观察） | **https 远端节点** `https://gitea0.hn.takin.cc/`，no-cors opaque，**201ms 连通** | PASS |

> 注：#90 仅在**未放** `poc4-node.json` 时出现（"跳过远程观察"）。配置了远程节点后探针改发 #91/#92，故正式结果以 #91/#92 为准。
> 复跑小坑：隔离数据目录若残留上一轮建的「PoC4 库」，#5 会撞 409 停在 pass5（`数据库名「PoC4 库」已存在`）——这是测试数据残留、非产物回归；清空 `/tmp/gx-poc4/data`（仅此 PoC 临时目录）后即 12/12。

## 4. 关键根因（curl 坐实，决定 D1 不用动后端）

业务 API 与公开图走的是两条不同的中间件路径（`apps/api/src/app.ts`）：

- **业务 `/api/*`**：过 `cors`（:122）与 `secureHeaders`（:138）。
  - CORS 源回显精确白名单：桌面启动注入 `CORS_ORIGIN=http://127.0.0.1:*,http://localhost:*`，经 `buildCorsPatterns`（`config.ts:191-198`）转成正则 `^http://127\.0\.0\.1:.*$`，命中壳口随机端口；
  - 响应带 `cross-origin-resource-policy: same-origin`，但 CORP **只拦 no-cors 资源加载**；业务数据全是 `mode:"cors"` 的 fetch（可读，受 CORS 保护），私有附件也走「带 X-GX-Token fetch→blob→objectURL」，故 CORP 不构成障碍。
  - curl 实证（带 `Origin: http://127.0.0.1:63107`）：`access-control-allow-origin: http://127.0.0.1:63107`、`cross-origin-resource-policy: same-origin`。
- **公开头像/品牌图 `/uploads/avatars|branding/:file`**：在 app.ts 中**注册早于 CORS/secureHeaders 中间件**，handler 直接 `new Response(buf)`，**既不发 CORP、也不过 CORS**。
  - curl 实证：响应只有 `Content-Type: image/png` 与 `Cache-Control`，**无任何 cross-origin/access-control 头**。
  - 因此启动器界面里 `<img src=内核口/uploads/avatars/...>` 这种 no-cors 加载没有 CORP 头可拦，跨端口天然显示。

**结论：§7.3 预告的「桌面专用 env 放宽内核 CORP」在当前后端实现下不需要**——公开图通道本就不发 CORP，业务通道的 CORP 不影响 cors fetch。D1 产品化沿用现有 CORS（回环通配）即可，后端零改动。

WebSocket：`collab/attach.ts` 自管 upgrade、**不校验 Origin**；WS 不受 CORS 限制，跨端口升级 + 短票 + 首帧、坏票 4401 全部符合预期。

## 5. 踩坑与处理（供 D1/D2 复用，避免重复掉坑）

1. **updater 插件启动期反序列化 panic**：tauri-plugin-updater 2.13.3 即使运行期永不 check，`.plugin(Builder.build())` 也要求配置里有 `plugins.updater` 段（裸 `tauri build` 无该段 → `PluginInitialization("updater", invalid type: null)`）。PoC-3 一直用 `--config` 注入所以没暴露。**D1 的正式 `tauri.conf.json` 或 build 脚本必须提供 updater 段（pubkey/endpoints），即使默认不检查更新。**
2. **崩溃恢复原生弹窗卡死启动**：调试期几次 panic 被 macOS 记为崩溃史，之后 `open` 启动弹「是否恢复窗口」的 `NSAlert runModal`（经 `NSPersistentUIRestorer`），主线程进模态。处理：重开干净实例即可；PoC 期可 `defaults write cc.gouxiang.desktop ApplePersistence -bool no`。**D5 runbook 应记录未签名调试期此现象（产品稳定后不崩溃即无）。**
3. **不能直跑包内裸二进制**：`Contents/MacOS/gouxiangdb-desktop` 脱离 `.app` 直接跑会 `resource_dir(): UnknownPath`（且有 sandbox 扩展报错）。必须经 `open -n X.app --env ...`（PoC-3 同姿势）。
4. **探针手搓预检是错的**：`Origin` / `Access-Control-Request-*` 是 forbidden headers，fetch 里设置无效；预检由浏览器自动发、预检响应 JS 读不到。正确裁决＝发带自定义头的真实请求，看浏览器是否放行。中间一版用了不在白名单的 `X-GX-POC4-Probe`，预检被拒 `Load failed`——反而旁证了白名单严格生效。
5. **finish 统计 off-by-one**：核心编号跳过 8（#80 是观察项），不能按 `i<total` 过滤；改为以「核心 emit 实际入 RESULTS 的条数」判定，末轮得真 12/12。
6. shell 脚本在多字节 locale 下 `$VAR` 紧跟全角括号会被 bash 吞字节（`$DATA）` → `DATA�: unbound variable`），统一写 `${VAR}`。
7. **ATS 父键名 typo（本轮最大坑，系统静默忽略）**：正确键是 **`NSAppTransportSecurity`（无尾缀 s）**。一度误写成 `NSAppTransportSettings`，结果无论把 `NSAllowsLocalNetworking` / `NSAllowsArbitraryLoadsInWebContent` / `NSAllowsArbitraryLoads` 单开还是全开，#91 都在 53–198ms 被秒拒 `Load failed`，连公网明文 `http://example.com` 都 6ms 拒。系统对未知键不报错、整个字典静默失效。最终靠 `lsregister -dump | grep -A200 <bundleid>` 对比微信/Chrome 注册信息里的真实键名才定位。
8. **Tauri 配置键随版本变（`infoPlist` vs `infoPlistPath`）**：官网新版文档写 `infoPlistPath`，但本机 CLI **2.12.3**（核心 2.12.4）的 schema 只认 **`infoPlist`**，写错直接 `Additional properties are not allowed ('infoPlistPath' was unexpected)` 构建失败；以 `node_modules/@tauri-apps/cli/config.schema.json` 的 `MacConfig.properties` 为准。bundler 合并语义＝逐条 `plist.insert(key,value)` merge 进 Tauri 生成的字典（同名覆盖、其余 `CFBundle*` 保留），所以自定义 `Info.plist` 只写增补键即可，产物里 `CFBundleIdentifier/ShortVersionString/Executable/NSHighResolutionCapable` 等默认键俱在（已亲读产物 plist 验证）。
9. **no-cors 探针测的可能是 CORP 而不是 ATS（关键方法学反转）**：远程探针最初打 `/api/health`（`no-cors` 简单 GET），始终失败，一度误判 ATS、再误判"本地网络隐私权限"（`tccutil reset` 后无授权弹窗，排除）。抓 `com.apple.WebKit.Networking` 进程日志一锤定音：`nw_flow_connected ... IPv4 192.168.31.15:3001 ... Transport protocol connected(tcp) → http_messaging`（TCP/HTTP **早已连通**），随后才 `NetworkLoadChecker::validateResponse returned an error` + `didFailLoading (isAccessControl=1)`——因 `/api/*` 响应带 `Cross-Origin-Resource-Policy: same-origin`，WebKit 在**收到响应后**拒绝 no-cors 读取。这与 ATS 的**连接层**拦截是两回事。干净测 ATS 必须选**不发 CORP 的目标**：本 PoC 改用公开头像通道 `/uploads/avatars/__ats_probe__.png`（该通道注册早于 CORS/secureHeaders，404 也不发 CORP），no-cors 得 opaque 即证明连接层放行。WKWebView 网络走独立进程 `com.apple.WebKit.Networking`，按 app 名 `log stream` 抓不到，predicate 要按该进程名。
10. **`NSAllowsLocalNetworking` 救不了局域网 IP**：它只豁免 `.local` 主机名与 link-local（169.254/16、fe80::），**不覆盖 `192.168.*` 等 RFC1918 私网地址**。最小充分解是正确父键下**仅** `NSAllowsArbitraryLoadsInWebContent=true`（只放宽 WKWebView，壳原生 URLSession 网络仍受完整 ATS 保护）；不必开全局 `NSAllowsArbitraryLoads`。回环 `127.0.0.1`/`localhost` 本就豁免 ATS，故本地内核明文口无需任何配置。

## 6. 对后续阶段的影响

- **D1（骨架/静态承载）**：方案坐实——壳 std 级回环静态口足够（产品化可保留 std 或换 tiny_http/axum）；内核启动与前端承载解耦为两个口；`GX_BIND_HOST=127.0.0.1` + `CORS_ORIGIN=http://127.0.0.1:*,http://localhost:*` 已在启动注入。
- **D2（可启停 sidecar）**：本 PoC 的 `boot(navigate=false)->port` 已把「起内核拿端口但不导航」与「壳口承载」分离，正是 D2 把无条件 spawn 重构为 start/stop 托管服务所需的形状；本轮不改 D2 的启停本身。
- **D3（同源→跨源承载 + 启动器界面）**：风险最高的跨源项已全部实测通过；桌面构建注入 `VITE_NODE_LAUNCHER=1` 后，web 启动器（S1–S4）跑在壳口、resolver local 槽指内核口即可，无需后端配套。
- **远端节点（http 局域网 / https）**：✅ 本轮已在**正式构建产物**上裁决，见 §7。结论＝需在桌面壳 `Info.plist` 放 `NSAppTransportSecurity → NSAllowsArbitraryLoadsInWebContent`（已接入），明文 http 局域网与 https 远端在 WKWebView 内均连通。
- **遗留产品化项（非本 PoC 缺口）**：实测 VM15 节点因**硬配了自定义 `CORS_ORIGIN`**，带壳口 `Origin: http://127.0.0.1:<随机口>` 时**不回 ACAO**（其白名单不含回环通配）；本地 PoC 内核能跨源是因 `main.rs:523` 显式注入 `CORS_ORIGIN=http://127.0.0.1:*,http://localhost:*`。故 ATS 放行只解决"连得上"，业务 cors fetch 要"读得到"，硬配白名单的远端节点仍需管理员把 `http://127.0.0.1:*`（或经壳内 Rust 出口转发，本期不做）加回去——由 D1/D3 的 resolver 与节点配置承接，默认 CORS（未硬配）节点本就放行回环。
- **未做**：本 PoC 不触碰真实数据（全程 `/tmp/gx-poc4/data`），不进四门基线。后端/web/fnOS **零改动**；ATS 仅作用于桌面壳 app（`Info.plist`），对浏览器/fnOS/服务器现网默认面无任何影响。

## 7. 远端 ATS / 混合内容裁决（#91/#92，正式产物真机）

**背景**：§7.4 设计曾悬置一项 `[待 PoC 验证]`——WKWebView 从 `http://127.0.0.1:<壳口>` 页面连**非回环**明文 http 节点会不会被 ATS 拦。本节给结论。

**配置**（已落地，随仓库提交）：
- 新增 `apps/desktop/src-tauri/Info.plist`，只放一个增补键：
  ```xml
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>
  ```
- `tauri.conf.json` 的 `bundle.macOS` 加 `"infoPlist": "Info.plist"`（本机 CLI 2.12.3 的键名，非 `infoPlistPath`）。
- 该键**只放宽 WKWebView 网页内容**；壳自身原生网络（updater 走 https Gitea）仍受完整 ATS 保护。不上 App Store（独立分发 + minisign），放宽可接受。

**方法**：`tauri build --bundles app` 正式产物 → 复制到隔离 `/tmp/gx-poc4/install`（壳二进制 sha256 指纹比对一致）→ 在 `Contents/Resources/server/public/` 放 `poc4-node.json`（`httpNode` 指不发 CORP 的头像通道、`httpsNode` 指 gitea0）→ ad-hoc 重签 + `lsregister -f` → `open -n --env GX_POC4=1 --env GX_POC3_DATA_DIR=/tmp/gx-poc4/data`，无交互读 `/tmp/gx-poc4-shell.log`。亲读副本 `Info.plist` 确认 ATS 段已合并、`CFBundle*` 默认键俱在。

**结果**：核心 12/12 不回归，#91/#92 全 PASS（http 局域网 64ms / https 201ms，均 no-cors opaque）。

**两条独立的"关"，别混**：
1. **ATS（连接层）**：拦所有非回环明文 http。正确 `NSAppTransportSecurity` 配置后即放行；回环豁免；https 始终放行。
2. **CORP（响应后）**：no-cors 资源若目标回 `Cross-Origin-Resource-Policy: same-origin` 会在收到响应后被拒（与 ATS 无关）。业务数据走 `cors` fetch 不受此限，受对端 **CORS** 约束（见 §6 遗留项）。

此外澄清了设计里的一处错误假设：选 http 回环源只能避免"https 安全源页面连 http"的**混合内容**阻断，并不能豁免 ATS 对局域网明文 http 的拦截——两者是不同机制。
