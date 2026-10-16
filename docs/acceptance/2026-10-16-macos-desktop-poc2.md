# macOS 桌面 App PoC-2 验收：真实 WKWebView 同源零 CORS 业务闭环

- 日期：2026-10-16
- 分支：`feat/macos-desktop-d0`（spike，承接 PoC-1 提交 `2178dca`）
- 结论：**通过 ✅ —— DESIGN-MACOS-APP 方案 L（WKWebView 加载内核同源 `http://127.0.0.1:<随机端口>/`）成立，无需回退 §7.3。**
- 数据安全：全程使用隔离数据目录（`GX_POC2_DATA_DIR=/tmp/...`），**零触碰**真实 `~/Library/Application Support/cc.gouxiang.desktop/`（验收后核对 dev.db 时间戳仍停在 PoC-1，无新增备份）。

---

## 1. PoC-2 要回答的问题

PoC-1 证明了「干净 .app 内嵌 Node sidecar 能建库、起内核、只绑回环、同源托管前端」。
PoC-2 要在**真实 Tauri WKWebView**（而非 curl/Node）里回答：

1. 界面、REST API、WebSocket、图片/附件全部走同一 origin（`http://127.0.0.1:<port>`）时，是否**完全没有 CORS / CORP / 混合内容 / ATS 拦截**；
2. Web 端自定义头 `X-GX-Token`（飞牛网关约束）在 WKWebView 同源 fetch 里是否正常；
3. 浏览器带不了自定义头的 WebSocket，走「HTTP 换一次性短票 → query 升级」是否在 WKWebView 连通；
4. 节点模式要连**远程明文 http 局域网节点**时，WKWebView 默认 ATS 会不会拦（要不要在 Info.plist 加 ATS 例外）；
5. 记录 WKWebView 的真实 `Origin` 与 `User-Agent`。

---

## 2. 方法（无交互、可自动判定、内核零改动）

- 探针页 `apps/desktop/poc/poc2.html` 经组装脚本旁路投进内核同源静态目录，由内核以 `/poc2.html` 同源托管；**不修改任何内核接口/中间件**。
- Rust 侧仅加 `GX_POC2=1` 自测门控：开启时 sidecar stdout/stderr 落 `/tmp/gx-poc2-sidecar.log`、启动导航改到 `/poc2.html`；**默认（无 env）行为与 PoC-1 逐字一致**（导航 `/`、日志丢弃、数据目录走真实 Application Support）。另加 `GX_POC2_DATA_DIR` 用于隔离数据（不能靠覆盖 HOME——会让 Tauri `resource_dir()` 解析失败 `UnknownPath`）。
- 探针在 WKWebView 内跑完整业务闭环，逐项把 `pass/fail/status/错误名` 编码进同源 `GET /__poc2/s/...` 图片请求路径，命中 SPA catch-all（200），仅出现在 sidecar 访问日志里——**纯旁路回传通道，后端无此路由、无任何副作用**。
- 启动用 `open -n <.app> --env GX_POC2=1 --env GX_POC2_DATA_DIR=...`（LaunchServices 真实 GUI 启动；直接 exec 包内 Unix 二进制会因 Bundle 路径解析失败而 `resource_dir: UnknownPath`）。
- 远程节点：VM15（`192.168.31.15`）起一个返回 `Access-Control-Allow-Origin: *` 的**明文 HTTP** 服务（端口 39222），先从 Mac `curl` 证明网络层 200 可达，再让 WKWebView 访问，确保失败可唯一归因到 ATS。

---

## 3. WKWebView 实测指纹

| 项 | 实测值 |
|---|---|
| Origin | `http://127.0.0.1:<随机端口>`（每实例不同，实测 60850 / 60987 / 61135 / 61484） |
| User-Agent | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)` |
| 说明 | 原生 WebKit：**无** `Chrome/`/`Version/`/`Edg/` 标识。前端不得依赖 UA 嗅探判定 Chrome 特性（现有代码不靠 UA，无影响）。 |
| Info.plist ATS | 无 `NSAppTransportSecurity` 键（默认策略），未加任何例外 |

---

## 4. 核心验收结果：12/12 通过（`DONE/12/true/pass12`）

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 0 | WKWebView 加载同源探针页 | ✅ | origin/UA 正确取得 |
| 1 | 免鉴权 `GET /api/auth/bootstrap-status` | ✅ | 200 `initialized=false signupOpen=false` |
| 2 | 空库首用户注册自举 owner，拿票 | ✅ | `POST /api/auth/signup` 200，返回 JWT（`X-GX-Token` 同源 POST） |
| 3 | 自定义头鉴权 `GET /api/auth/me` | ✅ | 200，`X-GX-Token` 自定义头被接受，email 读回 |
| 4 | 写：`POST /api/bases`（JSON + 自定义头） | ✅ | 201，建库 id=`cmvb1...`，默认表数=1 |
| 5 | 读：`GET /api/bases` CRUD 闭环 | ✅ | 200，含刚建库（n=1） |
| 6 | multipart：`POST /api/auth/me/avatar` | ✅ | 200，返回 `/uploads/avatars/<id>.png?v=...` |
| 7 | 公开静态图 `<img src>` 同源渲染 | ✅ | 1×1 解码成功 |
| 8 | multipart：`POST /api/attachments`（业务附件） | ✅ | 201，返回 `/api/attachments/<id>/content` |
| 9 | **私有图带票 `fetch→blob→objectURL→<img>`** | ✅ | 1×1 解码，`mime=image/png`，响应 **`Cross-Origin-Resource-Policy: same-origin` 同源未拦** |
| 10 | 无票访问私有附件 | ✅ 401 | `cache:"no-store"` 下 401（鉴权真实生效；见 §6 附带发现） |
| 11 | **协同 WebSocket**：建知识库→建文档→`GET /api/collab/ticket` 换票→`new WebSocket(ws://127.0.0.1:<port>/ws/collab/doc%3A<id>?t=...)` | ✅ | 握手成功，**收到服务端主动下发的二进制首帧 4 字节**（sync step1），无自定义子协议 |
| 12 | 坏票安全对照 | ✅ | 先完成握手再 `close(4401 ticket_invalid)`（私有永久错误码，客户端不无限重连，符合 attach.ts 拒绝纪律） |

全程 sidecar 访问日志中**没有任何 CORS 预检/拒绝、没有 CORP 拦截、没有 ATS 失败**；REST/WS/图片三类负载与页面完全同源。

---

## 5. 远程节点 ATS / CORS 观察（不计入核心通过数）

| # | 目标 | 结果 | 含义 |
|---|---|---|---|
| 92 | **明文 `http://192.168.31.15:39222` 局域网节点**（curl 已证 200 + `ACAO:*`） | ✅ **HTTP 200，110ms，未被 ATS 拦** | **关键结论：WKWebView 对 `http://127.0.0.1` 页面发起的明文局域网 http 请求默认放行，Info.plist 无需加 `NSAllowsArbitraryLoads`/本地网络 ATS 例外。** 对端回 `Access-Control-Allow-Origin: *` 时 body 可读——节点模式由我们自己的节点服务回 CORS 头即可。 |
| 93 | 公网 `https://example.com`（不回 CORS 头） | `Load failed`（875ms，有网络往返） | TLS 本身通过（非 ATS 拦截），失败发生在**跨域 CORS** 读取阶段——属预期：不回 `Access-Control-Allow-Origin` 的第三方源本就不可读。 |

节点模式推论：

- 连**远程局域网明文节点**：WKWebView 默认即可连，配合节点服务回 CORS 头（或经桌面侧本地反代/桥，S2/S3 数据源抽象层处理），无 ATS 配置负担，也无需降低全站 ATS 安全等级。
- 连**远程 https 节点**：TLS 正常，跨域由节点服务的 CORS 白名单解决，与现 Web 端同构。

---

## 6. 附带发现（不阻断 PoC，登记给 D 阶段/后端）

1. **私有附件响应存在 60s HTTP 协商缓存，且未按凭据分隔缓存。**
   `GET /api/attachments/:id/content` 的 200 响应头为 `Cache-Control: private, max-age=60`，**没有 `Vary: X-GX-Token`（也无 `Vary: Authorization`）**。同一 URL 先带票 200、随后 60s 内不带票 `fetch` 会直接命中浏览器缓存返回 200（探针第 10 步首跑即踩中；加 `cache:"no-store"` 后服务端客观返 **401**，`curl` 无票/坏票也均 401，证明鉴权本身正确）。
   - 影响面：单机单用户桌面场景风险低（私有缓存、同机同用户）；但在多账号/登出切换、浏览器共享 HTTP 缓存的部署里，可能让"登出后/另一身份"在 60s 内仍从缓存看到上一张私有图。
   - 建议（不在本 spike 改，避免动生产面）：对鉴权内容响应补 `Vary: X-GX-Token, Authorization` 或改 `Cache-Control: private, no-store`；可作为 0.2.x 后端一个小的独立硬化项评估。
2. **GUI 退出路径的优雅宽限偏紧。** `osascript quit`/Cmd+Q 实测走的是 `RunEvent::Exit` backstop（不是可 `prevent_exit` 的 `ExitRequested`）：对 sidecar 进程组 SIGTERM 后 node 在 3s 宽限内未完成优雅退出（keep-alive/WS 在途），最终 SIGKILL 收割。**结果无孤儿进程**（复查 `all reaped`），但 D 阶段若要保证最后一段协同编辑必落盘，应把 backstop 宽限调大或在退出前主动 `flushAllAndClose`（PoC-1 的双保险机制仍有效，这里只是宽限时长问题）。
3. 探针辅助函数首版在 `onopen` 即判定，漏掉了服务端连上即发的二进制首帧——属**测试脚本问题**已修正（改为等 `onmessage` 收到 ArrayBuffer 才算业务连通），产品 WS 行为始终正确。

---

## 7. 改动清单（全部 additive / 默认关闭）

| 文件 | 改动 | 默认行为 |
|---|---|---|
| `apps/desktop/src-tauri/src/main.rs` | 加 `GX_POC2` / `GX_POC2_DATA_DIR` 门控：开启才落 sidecar 日志、导航 `/poc2.html`、可覆盖数据目录 | 无 env 时与 PoC-1 完全一致：导航 `/`、stdio null、数据目录=`~/Library/Application Support/cc.gouxiang.desktop` |
| `apps/desktop/poc/poc2.html` | 新增同源探针页（仅自测；随结果渲染 + 旁路日志回传） | 不进正式包（见下） |
| `apps/desktop/scripts/stage-node-sidecar.mjs` | 仅 `GX_POC2=1` 时把探针页投进 `public/poc2.html` | 正式 stage 默认**不含**探针 |

内核（`apps/api`）生产代码 **0 改动**；CORS / CORP / ATS 均**未为桌面做任何放宽**——靠同源从根上消除跨域。

---

## 8. 复现步骤

```bash
# 1) 组装 sidecar（带探针）
GX_POC2=1 node apps/desktop/scripts/stage-node-sidecar.mjs

# 2) 编译 Tauri（release）
cd apps/desktop/src-tauri && cargo build --release
# 3) 用 tauri CLI 打 .app（或复用 PoC-1 bundle，替换 MacOS 二进制 + 向 Resources/server/public 投 poc2.html）

# 4) 隔离数据启动（LaunchServices）
open -n "apps/desktop/src-tauri/target/release/bundle/macos/构想工作台.app" \
  --env GX_POC2=1 --env GX_POC2_DATA_DIR=/tmp/gx-poc2-data

# 5) 约 12s 后读结果（DONE 行 + 逐条 s/<ok>/<idx>/<base64url-msg>）
grep -oE 'DONE/[0-9]+/(true|false)/pass[0-9]+' /tmp/gx-poc2-sidecar.log
```

远程 ATS 观察：向 `Resources/server/public/poc2-node.json` 写
`{"httpNode":"http://<局域网节点>/path","httpsNode":"https://..."}` 后重启。

回滚：删除 `apps/desktop/poc/`、还原 main.rs/stage 脚本三处门控即可；无迁移、无内核改动、无数据变更。

---

## 9. 对后续阶段的意义

- **方案 L 锁定**：桌面 WebView 与内嵌内核同源，现 Web 端的 `client.ts`（`X-GX-Token`）、协同短票 WS、附件/头像渲染**可原样运行，无需 CORS 白名单、无需自定义 scheme、无需放宽 CORP/ATS/CSP**。S2 改 client.ts 的数据源抽象（本地内核/远程节点 baseURL+token 切换）在网络层无障碍。
- 远程节点（含明文局域网）默认可达，跨域由节点侧 CORS 头解决。
- PoC-3（无 Apple 账号 updater 旧→新闭环 + quarantine「仍要打开」实测）可继续；其中首次 Gatekeeper 交互仍按约定**等戴总在场**再做。
