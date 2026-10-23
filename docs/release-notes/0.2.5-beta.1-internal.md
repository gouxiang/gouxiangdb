# 构想工作台 v0.2.5-beta.1 发版说明（首个桌面端测试版 / Pre-release）

- **对外版本名**：`0.2.5-beta.1`（预发布，**不是正式版**）；Git tag：`v0.2.5-beta.1`
- **内部包版本号**：`0.2.5`（版本单一真源 = 根 `package.json` 的 `version`；运行时与 fpk `manifest.version`、esbuild `GX_VERSION` 同源，禁止硬编码）。对外用 `-beta.1` 后缀表预发布，内部包号不动，避免为测试版改动版本单源。
- **展示名**：构想工作台（技术标识 `gouxiangdb`，仅包名 / 目录使用）；macOS bundle id `cc.gouxiang.desktop`
- **发布日期**：2026-10-19
- **Gitea Release 性质**：**prerelease（勾选预发布）**；**只上传 dmg + fpk 两个安装包，不上传 `update-manifest.json`**。更新器只认「带 update-manifest.json 资产的 release」（`apps/api/src/domain/update/sourceGitea.ts:104`），故本 beta **不会出现在 0.2.4 正式用户的在线更新里**，稳定频道零污染。
- **本轮主题**：①**全新 macOS 桌面客户端**（Tauri v2 壳 + 内置本地服务内核，双击即用、零配置连本机 / 远程）；②**帮助中心在线百科化**（Gitea Wiki 单一来源，并修复图片附件被当页面的卡顿 / 乱码）；③服务端离线双向同步地基已铺好但**默认关闭**（继承 0.2.5 服务端工作，本 beta 桌面端不含离线同步）。

> 历史发版说明归档：0.2.4 见 `docs/release-notes/0.2.4.md`；0.2.3 见 `docs/release-notes/0.2.3-full.md` / `0.2.3.md`；本次对外发布说明见 `docs/release-notes/0.2.5-beta.1.md`。
>
> **设计文档**：`docs/design/2026-10-node-mode/DESIGN-MACOS-APP.md`（macOS 独立 App）、`DESIGN-OFFLINE-SYNC.md`（离线同步）、`docs/design/2026-10-license/DESIGN-LICENSE-PRESEED.md`（正版授权预埋，本版仅文档零代码）。

---

## 〇、给非技术同事的一句话

这是构想工作台**第一个能在苹果电脑上双击使用的测试版**：把服务器内核装进了一个 App，不用再敲命令；连自己电脑里的库或远程服务器都不用做任何网络配置。同时帮助中心改成了在线百科、修好了之前图片乱码卡顿的问题。**这是给试用者的测试版**：桌面版的「断网也能用」这次还没做，软件也还没买苹果签名（第一次要右键打开）。

---

## 一、本版交付内容

### 1. macOS 桌面客户端（全新，本次主角）
- `apps/desktop`：Tauri v2（Rust）壳 + 随包 Node 侧车（单二进制 gxnode + server 树 + 41 枚迁移）。
- **壳内回环出口反代**：壳在 `127.0.0.1` 随机端口静态托管 web 成品，并把 `/api`、`/health(z)`、`/readyz`、`/uploads`、`/ws`、`/__gx/probe` 按当前单活上游（None / Local / Remote / Replica）动态转发（含 WS 裸中继、剥 Origin/Referer、流式不缓冲）。浏览器全程同源，**被连服务器零 CORS 配置、禁止手填白名单**。
- **节点启动器**：添加 / 重命名 / 切换多个节点；连远程只选路不存密码（remote-empty），登录走远端自己的 `/login`；登录 / 改密按活动节点分槽。
- **内核生命周期**：sidecar start/stop/status + 首 boot + `/readyz` 五探针；外部 SIGTERM/SIGINT 由壳 reaper 收尸（gxnode 是壳子进程、同进程组，**无 LaunchAgent/Daemon/登录项**，重启无孤儿）。
- **JWT 密钥入 macOS 钥匙串**（service=`cc.gouxiang.desktop` / account=`jwt-secret`，含损坏短项自愈）；vault 预留 `.vault`。
- 菜单栏驻留、关窗驻留、彻底退出、Reopen 唤窗；禁用 HTML 拖放（`dragDropEnabled=false`）。
- 适配 **Apple 芯片 arm64、macOS 11+**；ad-hoc 签名（未公证），**首次右键 → 打开**。

### 2. 帮助中心在线百科
- 后端无鉴权同源代理 `apps/api/src/routes/helpProxy.ts`（挂 `/help`），匿名拉 Gitea Wiki 首页与侧边栏；配置 `GX_HELP_WIKI_BASE` / `GX_GITEA_API_BASE` / `GX_GITEA_TOKEN`。
- **附件修复（发布基线 4b36d18）**：新增 `isWikiAttachment()`，侧边栏与正文路由双重过滤 `images/`、`attachments/` 及图片 / 压缩包 / 音视频等扩展名——此前 8 张 `images/tour/*.png` 被当成页面，点开把数十万字符 PNG 二进制塞进 markdown，导致列表出现 png、乱码、卡顿。修复后只剩真实帮助页面，手工图片 URL 返回 `404 NOT_A_WIKI_PAGE`。

### 3. 服务端离线同步地基（默认关闭，桌面端本版不接线）
- YN0–YN9 已落地于 `apps/api/src/routes/v1/sync/`，由 `GX_SYNC_SERVER` 总门控制（fail-closed）：关闭整组 404、不建表数据。**桌面端离线侧车（#828）本 beta 不含**，仅随 fpk 提供服务端能力供内测环境开启。

### 4. 品牌 / 体验
- Mac 客户端图标定稿（`icon-mac` 源 + iconset/icns，缩回 macOS 安全边）。
- 真机目验修复：L2 导航零宽折叠、`gx-z-modal` 弹层层级倒置（800/820/860）、启动器横屏成品。
- 保留 0.2.4 的品牌外观自定义、注册开关、服务器对外访问网址声明等能力。

---

## 二、安装包指纹（2026-10-19 发布基线，含附件修复 4b36d18）

### macOS（arm64 / Apple 芯片）
- 文件：`构想工作台_0.2.5_aarch64.dmg`
- 大小：**105,757,377 B（100.86 MiB）**
- sha256：**`476d8a12d25d7abb2d525cd7c45be1f2cf05ba144d9b1c0a8ab23230b81f2fe9`**
- 本机构建链：`build-web-shell.mjs`（`VITE_NODE_LAUNCHER=1`、base=/、dist-shell）→ `stage-node-sidecar.mjs --web-dist apps/web/dist-shell --out ~/Library/Caches/gouxiangdb-desktop/build/stage` → Tauri CLI 2.12.3 `build --bundles app,dmg`。
- 校验：`.app` ad-hoc（flags=adhoc,linker-signed，无 TeamIdentifier）、arm64 thin、`CFBundleShortVersionString=0.2.5`、`LSMinimumSystemVersion=11.0`、identifier `cc.gouxiang.desktop`；真机已验含 `NOT_A_WIKI_PAGE` 修复、内核父子关系、回环反代、14 个真实帮助页无图片附件、钥匙串存取、拖入 /Applications 安装。

### 飞牛 fnOS（x86_64）
- 文件：`gouxiangdb-0.2.5-x86.fpk`
- 大小：**60,659,950 B（57.85 MiB）**
- sha256：**`326a4c654b7c7a6af91796f9832b624bfb046a3c45568f43caba2cadf7c80bd7`**
- 构建机：VM15（`192.168.31.15`，Debian12 x86_64，Node v22.22.1，pnpm 9，fnpack 1.2.x），源码基线 `git archive 4b36d18` 干净目录重建（旧 fpk `d8121a1b…` 基于 04ea891，**不含附件修复，已作废**）。
- 解包复核：外层 `manifest` `version=0.2.5` / `platform=x86`；内层 `server/dist/index.js` 实测含 `NOT_A_WIKI_PAGE`（附件修复新增错误码，旧包无此串）与 `avif` 扩展名；`native/linux-x64/vec0.so` 在位；`node_modules` **零符号链接**（hoisted 布局）；构建期 `/readyz` 五探针冒烟通过、禁带扫描通过。
- 本包**不内置更新只读令牌**（未设 `GX_READER_TOKEN`），覆盖升级不覆盖现网更新源凭证与 `JWT_SECRET`。

> 两个安装包已归档到本机 `release/0.2.5-beta.1/`（gitignored）。

---

## 三、诚实缺口：本版【没有】什么

1. **桌面端离线编辑 / 断网双向同步不含**（#828 侧车：sparsebundle AES 一作用域一匣 + outbox + YN6 冲突双栏手选 + 失权本地擦除，是下一阶段内测形态 B）。
2. **桌面在线自动更新未接通**：updater 仅在 `GX_POC3=1` 自测门控下注册，正式 tauri.conf 无 updater 段；菜单「检查更新」当前不可用，新版手动下载（#829）。
3. **无 Apple 开发者签名 / 公证**：仅 ad-hoc，需右键打开；**仅 arm64**，无 Intel / Windows / Linux 桌面包。
4. **审批 / 工作流**：仅预留 `pending_approval` 枚举与 `reviewBaseId` 钩子。
5. 飞牛真机 `192.168.31.183` 升级（#881）待本 beta 放行后、产品负责人在场执行（先备份、保数据）。

---

## 四、质量门实数（2026-10-19 发布前亲跑）

| 门 | 结果 |
|---|---|
| api help-proxy 定向测试 | **32 用例全绿**（含附件过滤新增用例） |
| web 全量测试 | **178 文件 / 2261 用例全绿**（默认隔离 `--maxWorkers=2`；注意 singleFork 会混 jsdom/node 造 5 例假失败，非权威） |
| web / api `tsc --noEmit` | **0 错误** |
| web eslint | **0 error**（98 warning，阈值 114 内） |
| Rust 壳 | `CARGO_BUILD_JOBS=2 cargo check` 通过；clippy 清零；headless 用例（含目录穿越 / SPA fallback / WS 重建）绿 |
| 迁移 | **42 枚**（fpk 与 Mac `.app` 随包同源实测均为 42，最新 `20261015122228_sync_server_foundation`；同步地基默认 off 不触数据） |
| 桌面真机冒烟 | 壳拉起内核父子进程、五探针全 true、回环反代、百科 14 页无附件、钥匙串、安装流程通过 |
| 前端依赖 | 零新增第三方 npm 依赖；零裸 fetch；gx-* token |

> 本机 16GB 纪律：全量测试 / 重构建在 VM15 跑；本机仅 tsc / lint / 定向测试与 Tauri 打包（target 落本地缓存，避开 iCloud）。

---

## 五、升级 / 数据须知

- **飞牛覆盖安装**：执行 `prisma migrate deploy`（幂等），只新增不改旧表；存量数据、登录态、附件、品牌图保留；要求 Node **v22**（better-sqlite3@13 NAPI v10，Node20 会 SIGSEGV）；令牌头 `X-GX-Token`。
- **macOS 数据落点**：`~/Library/Application Support/cc.gouxiang.desktop/`（dev.db / uploads / .audit），钥匙串 service `cc.gouxiang.desktop`。删除 `.app` 后数据目录按 macOS 惯例保留（符合沙盒外应用通行做法）；需彻底清空可手动删该目录与钥匙串项。
- 是否需要初始化取决于**本地数据目录是否已有 dev.db**（与服务器 users 表首管理员判定是两层独立逻辑）。

---

## 六、发布动作（2026-10-19 产品负责人已在场授权）

1. 帮助附件修复 `4b36d18` 推送到 `origin/feat/macos-desktop-d0`（已完成：`04ea891..4b36d18`）。
2. VM15 用含修复的 `git archive 4b36d18` 重打飞牛 x86 fpk，回算指纹（已完成）。
3. 打 tag `v0.2.5-beta.1`，Gitea 建 **prerelease** Release（名「构想工作台 0.2.5-beta.1」），上传 dmg + fpk + 本发布说明，**不传 update-manifest.json**。
4. 发布后把最新代码并入 `main`（main 是 feat 分支祖先，fast-forward 合并后 push，不强推、不覆盖）。
5. 正版授权预埋仅交付设计文档（`docs/design/2026-10-license/DESIGN-LICENSE-PRESEED.md`），**零产品代码改动**；商业化加固（进程守护自检、恢复出厂、备份轮转、JS 混淆→字节码→核心下沉 Rust→机密服务端）列入未来计划。
