# 构想工作台 v0.2.7 发版说明（修好 macOS「重启后远端连接丢失」的正式版）

- **对外版本名 / Git tag**：`v0.2.7`（**正式版，非预发布**）
- **内部包版本号**：`0.2.7`（版本单一真源＝根 `package.json` 的 `version`；与 fpk `manifest.version`、Tauri `tauri.conf.json`、esbuild `GX_VERSION` 同源，禁止硬编码）
- **展示名**：构想工作台（技术标识 `gouxiangdb`）；macOS bundle id `cc.gouxiang.desktop`
- **封版日期**：2026-10-24；**Git 基线**：封版 `6a45409` ＋ 本版桌面壳固定口修复 `c7154b2`（tag `v0.2.7` 指向含发版文档的最新头）
- **Gitea Release 性质**：**正式 Release（不勾预发布）**；上传 fpk + dmg + 两个 `.sha256`，**不传 `update-manifest.json`**。
- **本轮主题**：①头等修复 **macOS 重启电脑后远端节点「失忆」**（桌面壳端口随机改固定 `47831`，localStorage origin 稳定，远端地址 / 登录态跨重启保留）；②权限收口（管理员看得到超管建的库、非超管不能授予管理员）；③远端连接用户菜单分槽；④详情页编辑体验返工。基于 0.2.6，**无数据库迁移、前端与服务端零改动**（仅 Mac 桌面 Rust 壳）。

> 对外发布说明：`docs/release-notes/0.2.7.md`；上一版 0.2.6 完整发版说明见本文件下方归档。

---

## 〇、给非技术同事的一句话

这一版专门修好苹果电脑客户端最烦的毛病：**以前重启电脑后，之前连过的服务器会凭空消失，得重新手打地址、重新登录**；现在它会牢牢记住，重启后自动回到上次连的服务器、不用重登。同版还修好几个权限问题。只动了 Mac 客户端的「外壳」，**没碰任何业务数据、无数据库迁移**，老数据原样保留；Mac App 仍是 Apple 芯片专用、未买苹果签名，**第一次右键 → 打开**。

---

## 一、相对 0.2.6 的关键变化

1. **头等修复：macOS 重启后远端连接「失忆」（桌面壳固定口）**。根因：壳冷启动绑 `127.0.0.1:0` 随机口，WebView localStorage 按 origin（含端口）隔离，端口每变一次记忆就整屋丢失。修法：壳口固定回环主口 **47831**，占用则在 **47832–47836** 依次回退，全占才 `:0` 保底（保启动）。仅 Rust 壳（`main.rs` 端口绑定 + `shell_server.rs`/`commands.rs` 注释同步），前端 / 服务端零改动；新增 4 个端口选择 headless 测试，壳 headless 共 31 全绿。门牌号稳定后远端注册表、`gx-node-session:*` 登录令牌（不含密码）、本机登录态全部跨重启保留。
2. **权限收口（#1046/#1046b/#1046c）**：零投影老库库门兜底 + nav 库门改判 `enter`；启动对老库权限投影**幂等自愈补齐**（重装 / 升级自动补全）；后端提权硬闸（非超管不得授予管理员 / 超管）＋前端对非超管隐藏入口，前后端双保险。
3. **远端连接用户菜单（#1056，`22f5db4`）**：连远端时右上角用户菜单可点开；退出登录 / 个人资料按当前会话节点分槽，不再串机。
4. **详情页编辑体验（#1047，多提交）**：消「框中框」、输入框不再跳动；编辑 / 只读统一为同一张卡；ghost 融入卡全字段类型适配。

---

## 二、安装包指纹

### 飞牛 fnOS（x86_64）
- 文件：`gouxiangdb-0.2.7-x86.fpk`
- 大小：**60,831,523 B（58.01 MiB）**
- sha256：**`8cd964c05d8dd65f066c1de692762ca28d24acfdb7e49c8f6149d33792ec5085`**
- VM15（`192.168.31.15`，Debian12 x86_64，Node v22，fnpack 1.2.0）构建；`manifest.version=0.2.7/platform=x86/service_port=9527`；**44 枚迁移**（与 0.2.6 同，无新增）；Prisma query engine 与 better-sqlite3 原生件均 ELF x86-64；`node_modules` hoisted 零软链；禁带扫描、入口一致性、六处图标 md5 自检全过；不内置更新只读令牌。本版唯一代码差异（Mac 壳固定口）不进 Linux fpk，fpk 内容＝0.2.7 封版树。

### macOS（arm64 / Apple 芯片）
- 文件：`构想工作台_0.2.7_aarch64.dmg`
- 大小：**109,620,131 B（104.54 MiB）**
- sha256：**`c72e8ffe7655097dd4aa68f43c6df447109670c7a1620f8693e266032a04d66e`**
- **签名形态（双层，刻意为之）**：外层 `.app` 为**完整 ad-hoc（flags=0x2，带资源封条）**——tauri 直出仅 linker-signed 且缺资源封条，故只对外层 `codesign --force --sign -`（**不带 --deep**）重签；随包官方 Node 运行时 gxnode **保留苹果官方签名 TeamIdentifier=HX7739G8FX** 不被破坏；Prisma / better-sqlite3 等 `.node` 为链接期 ad-hoc。`codesign --verify --deep --strict` 通过（valid on disk / satisfies Designated Requirement）。
- 规格：arm64 thin、macOS 11+（`LSMinimumSystemVersion=11.0`）、identifier `cc.gouxiang.desktop`、`CFBundleShortVersionString=0.2.7`；UDZO 压缩（zlib-9）；未公证，**首次右键 → 打开**（`spctl --assess` rejected 为 ad-hoc 常态，同 0.2.6）。
- 随包内容挂载实测：**44 枚迁移**、`native/darwin-arm64/vec0.dylib` Mach-O arm64、api dist 四件、门控前端 `public/assets/index-DFihveSz.js`（base=/）、随包 Node v22.22.2 arm64；stage 真建库 `migrate deploy` + 随包 Node `/readyz` 五探针全过。
- 构建链：门控前端 dist-shell（重 vite）与 api esbuild 均在 **VM15** 构建后回传，不占本机内存；Mac 侧仅 stage 组装 ＋ Tauri CLI **2.12.3** `build --bundles app,dmg`（不带 `--target`，复用宿主热缓存，`CARGO_BUILD_JOBS=2`，全程内存空闲 ≥35%），重签后用重签 `.app` 经 `ditto` + `hdiutil create … UDZO` 重压。

> 两包归档本机 `release/0.2.7/`（gitignored），各附 `.sha256` sidecar。

---

## 三、质量门实数（VM15 四门 + Mac 壳增量）

| 门 | 结果 |
|---|---|
| 四包 `tsc --noEmit`（shared-types/canvas/api/web） | **0 错误** |
| 四包 eslint | **0 error**（各自阈值内） |
| `@gx/shared-types` 全量 | **10 文件 / 181 用例全绿** |
| `@gx/canvas` 全量 | **2 文件 / 51 用例全绿** |
| `apps/api` 全量 | **349 文件 / 3670 通过 + 14 跳过（共 3684），0 失败** |
| `apps/web` 全量 | **202 文件 / 2538 用例全绿** |
| Mac 壳 headless | **31 全绿**（含 4 个新增端口选择用例：主口命中 / 占用回退 / 全占保底 / 生产序列） |
| Mac 壳 clippy | **0 warning / 0 error** |
| 迁移 | **44 / 44**（本版无新增迁移，只增不改旧表） |
| TLS 供应链红线 | **aws-lc-rs = 0**，统一 rustls 0.23.46 + ring 0.17（macOS 钥匙串信任根） |

> 补充实证：壳门控前端构建产物 index.html base=/ 硬校验通过；fpk 与 dmg stage 打包冒烟（migrate deploy + /readyz 五探针）全过；dmg 挂载 deep-strict 签名 VALID + 44 迁移 + vec0 arm64 + 门控前端齐备。全量测试 / 重 vite / esbuild 只在 VM15 跑；16GB 本机仅做 Mac 壳**增量**编译（复用热缓存、限 2 并发，全程内存空闲 ≥35%），不跑全量、不挤爆内存。

---

## 四、升级 / 数据须知

- **从 0.2.6 升级**：本版无数据库迁移、无数据结构变更，存量数据 / 登录令牌 / 附件 / 品牌设置原样保留。
- **macOS**：新 dmg 拖入替换旧 `.app`。升级后第一次启动若旧版当时恰好用随机口，其 localStorage 挂在旧随机 origin 下读不回来——**这是最后一次**；从本版起端口固定 47831，今后所有重启延续同一记忆。数据落点不变：`~/Library/Application Support/cc.gouxiang.desktop/`，钥匙串 service `cc.gouxiang.desktop`。
- **飞牛覆盖安装**：appcenter 无 upgrade，先 `uninstall`（保留数据与 env）再 `install-fpk -e <向导文件>`，然后 `start`；要求 Node **v22**；同版本号不能覆盖安装。

---

## 五、诚实缺口：本版【没有】什么

1. **桌面离线编辑 / 断网双向同步仍不含**（侧车 + outbox + 冲突双栏手选为后续 beta.2 内测形态）。
2. **桌面在线自动更新未正式接通**：不带 update-manifest，菜单「检查更新」暂不可用，需手动下载。
3. **无 Apple 开发者签名 / 公证**：仅 ad-hoc，首次右键打开；仅 arm64，无 Intel / Windows / Linux 桌面包。
4. **dmg 真机 GUI 两次冷启动冒烟待产品负责人在场**：固定口逻辑已由 31 条 headless 测试证明，但真机「添加远端 → 退出 → 重启 App → 远端地址仍在 / 免重登」目验会与戴总正在运行的 0.2.6 争同一数据目录与 47831 端口，故不擅自拉起，换装新 dmg 后首验（顺带目验 Finder 卷宗图标）。飞牛 183 真机换装亦待在场执行（先备份、保数据）。
5. **帮助中心 Wiki 版本号文案**在外部 Gitea Wiki 仓库维护，代码仓改不到，需另行更新。

---

## 六、发布动作

1. 壳固定口修复代码精确提交（**仅** `apps/desktop/src-tauri/` 的 `main.rs`/`shell_server.rs`/`commands.rs`/`headless_tests.rs`/`Cargo.lock` 5 文件，精确 add，**不碰队友 beta.2 Rust WIP**：license.rs/vault.rs/secret.rs/sidecar.rs/gx-shell.toml 等）。
2. 发版文档提交（本文件 + `docs/release-notes/0.2.7.md`）。
3. fast-forward 推送 `main`（本地 release/0.2.7 领先 origin/main 10 提交、origin/main 为祖先，可 FF；不强推、不覆盖）。
4. 打 annotated tag `v0.2.7` 并推送。
5. Gitea 建**正式 Release**，上传 fpk + dmg + 两 `.sha256` + 发布说明，**不传 update-manifest.json**；核对仓库 default_branch=main。
6. 戴总在场真机冒烟（见诚实缺口 4）。

---
---

# 【归档】构想工作台 v0.2.6 发版说明（首个含 macOS 桌面客户端的正式收口版）

- **对外版本名 / Git tag**：`v0.2.6`（**正式版，非预发布**）
- **内部包版本号**：`0.2.6`（版本单一真源＝根 `package.json` 的 `version`；与 fpk `manifest.version`、Tauri `tauri.conf.json`、esbuild `GX_VERSION` 同源，禁止硬编码）
- **展示名**：构想工作台（技术标识 `gouxiangdb`）；macOS bundle id `cc.gouxiang.desktop`
- **封版日期**：2026-10-23；**Git 基线**：`3ea1f65`
- **Gitea Release 性质**：**正式 Release（不勾预发布）**；上传 fpk + dmg + 两个 `.sha256`，**不传 `update-manifest.json`**（在线更新器只认带该资产的 release，本版更新通道未正式接通，避免误推）。
- **本轮主题**：①P0 修复「匿名公开表被硬跳登录」；②飞牛 fnOS 改**独立端口 9527 + 安装向导**（替代吞 `Authorization` 的 CGI 反代）；③公开分享扩到 doc/table/base 三类；④前端 v6 底板令牌全线收口；⑤macOS 桌面客户端随正式版发布（仍 arm64、ad-hoc、首次右键打开）。

> 对外发布说明：`docs/release-notes/0.2.6.md`；历史：0.2.5-beta.1 对外版 `docs/release-notes/0.2.5-beta.1.md`、内部详版 `docs/release-notes/0.2.5-beta.1-internal.md`（本文件末尾亦归档）；0.2.4 见 `docs/release-notes/0.2.4.md`。

---

## 〇、给非技术同事的一句话

这是第一个**带苹果电脑客户端的正式版**：在 0.2.5-beta.1 试用版基础上，飞牛服务器改成独立端口、安装时有向导填端口（修掉跨网络访问偶发白屏 / 被网关拦），并修好「任何人打开公开分享表格都被错误踹去登录页」这个最扎眼的毛病。Mac App 仍只支持 Apple 芯片、未买苹果签名，第一次要右键 → 打开。

---

## 一、相对 0.2.5-beta.1 的关键变化

1. **P0 匿名公开表硬跳登录（`3ea1f65`）**：公开表页 `/s/:token(/t/:tableId)` 匿名打开时，成员列组件无条件请求私有 `GET /api/v1/org/members` → 401 → 全局拦截器硬跳 `/login`。两层修：`useOrgMembers` 加会话门控（匿名 `enabled:false`，成员格兜底短 id/「—」）；新增纯函数 `isPublicSharePathname`，公开路径下私有 401 只复位标志不登出/跳转，品牌名走公开 `/api/auth/branding`。6 文件 +178/-1，新增 13 测试。
2. **飞牛独立端口交付（`964b6aa`/`d7eb4cc`/`461704e`）**：弃 CGI 反代改独立端口，默认 **9527**，安装/升级向导字段 `wizard_port`（1024–65535）；非交互安装必须 `install-fpk -e <向导文件>`；修连字符图标与向导白屏；Node 统一 v22；Web 令牌头 `X-GX-Token`。
3. **公开分享三类（`0ff6c20`/`f749a6c`）**：doc/table/base 可公开，base 外壳表带 token 可匿名只读；CSV 附件列导文件名；修四处分享体验缺陷。
4. **v6 视觉令牌**：左栏 76px 图标轨、二级面板 236、顶栏/工具条/弹层/KB/通讯录/帮助/登录全线迁移冷灰底板 + 发丝线，配套守护测试。
5. **离线同步地基默认关闭**：YN0–YN9 在 `apps/api/src/routes/v1/sync/`，`GX_SYNC_SERVER` fail-closed；桌面离线侧车本版不含。

---

## 二、安装包指纹（封版基线 `3ea1f65`）

### 飞牛 fnOS（x86_64）
- 文件：`gouxiangdb-0.2.6-x86.fpk`
- 大小：**60,822,956 B（58.00 MiB）**
- sha256：**`be4ebea6b3b98411051143f4c807d9e4ce795fb806dd295508c6dd0d53300d0a`**
- VM15 构建；解包 `manifest.version=0.2.6/platform=x86`，主入口 `server/public/assets/index-CpXqZ_Ar.js`（1,872,786 B）含 P0 字节标记 `^\/s\/[^/]+`（**marker=1**，旧 0.2.6 包 marker=0 已作废），44 枚迁移，`node_modules` 零符号链接。

### macOS（arm64 / Apple 芯片）
- 文件：`构想工作台_0.2.6_aarch64.dmg`
- 大小：**108,586,466 B（103.56 MiB）**
- sha256：**`90aabec9edf5087ac9990b2056632461781713d42ebeb0552179f1dbb2ed03bc`**
- ad-hoc（未公证）、arm64 thin、macOS 11+、identifier `cc.gouxiang.desktop`、`CFBundleShortVersionString=0.2.6`，首次右键 → 打开。

> 两包归档本机 `release/0.2.6/`（gitignored），各附 `.sha256` sidecar。

---

## 三、真机换装实证（飞牛 192.168.31.183，2026-10-23）

- **换装前**：183 原跑旧 0.2.6（线上 bundle `index-DTKpWlm-.js`，**marker=0**）。先双备份（在线一致性 `app.db` + 全量目录旁路含 env/uploads/wal/shm）。
- **换装**：uninstall（**保留** data-share 数据与 env）→ `install-fpk 新fpk -e wizard_port=9527` → start；回调沿用整块 env（`JWT_SECRET` 不重生成），跑 `migrate deploy`（44）+ `nav-reconcile --apply`。
- **换装后全绿**：新 pid、`/readyz` 五探针全 true、44 迁移、端口 9527；主入口变 `index-CpXqZ_Ar.js`（**marker=1**，与新 fpk 字节一致）。
- **登录态不踢**：`JWT_SECRET` 指纹换装前后均 `1a6691c8a67f`（自签 owner JWT 实测 `/api/auth/me` 200，匿名 401）。
- **数据零丢失**：换装前/后逐字一致 `users=1 / bases=3 / tables_live=3 / records=8 / attachments=5 / applied=44 / integrity=ok`。
- **P0 真机 E2E**：匿名 Chromium 开 `/s/<token>` 渲染 19 列 +1 记录，成员列显「—」，**未跳登录、零 `/api/v1/org/members`、零 401**，仅 3 个公开接口。
- **10 页巡检零报错**：gallery/form/kanban/gantt/tree/表单问答/KB/库设置/通讯录/回收站，全部未踢登录、无空白、零 5xx、零 pageerror；甘特为优雅空态。
- **收尾**：临时分享吊销（`share_links=0`）、临时表软删（`temp_table_live=0`），计数回基线。

**历史 P2 五处复核**：代码均已修复，本轮只确认未改码——①日历月视图表头单行不重复；②长文本真换行无字面 `<br/>`；③帮助正文无字面 `<br/>`；④新建表 URL 自动补 `/view/:id`（真机实证）；⑤附件 20MB/40MB/20 个前后端常量对齐有守卫测试。

---

## 四、质量门实数（封版前，VM15）

| 门 | 结果 |
|---|---|
| `apps/web` 全量 | **198 文件 / 2507 用例全绿** |
| `apps/api` 全量 | **350 文件 / 3666 用例全绿** |
| `@gx/canvas` | **2 文件 / 51 全绿** |
| `@gx/shared-types` | **10 文件 / 181 全绿** |
| 三包 `tsc --noEmit` | **0 错误** |
| web eslint | **0 error** |
| 迁移 | **44/44**（只增不改旧表） |

> 全量测试 / 重构建只在 VM15；16GB 本机仅 tsc/lint/定向测试，**不在本机跑 Rust release 全量编译**（曾 OOM）。

---

## 五、升级 / 数据须知

- **飞牛**：appcenter 无 upgrade，先 uninstall（**保留数据/env**）→ `install-fpk -e <向导文件>` → start；回调自动 `migrate deploy`（只增），数据/登录态/附件/品牌图保留；Node 必须 v22；**同版本号不能覆盖安装**。
- **macOS**：数据落 `~/Library/Application Support/cc.gouxiang.desktop/`，钥匙串 service `cc.gouxiang.desktop`；删 `.app` 数据目录按惯例保留。

---

## 六、诚实缺口

1. **dmg 未做实机双击 GUI 安装冒烟**（构建/解包/签名/版本元数据已核，真机 GUI 待产品负责人在场首验）。
2. 附件限额未做真实大文件上传流（常量 + 守卫测试已对齐）。
3. **帮助中心首页版本号陈旧**：内容来自后端代理的**外部 Gitea Wiki**（`apps/api/src/routes/helpProxy.ts`），wiki 源仍写「稳定版 v0.2.4 / Mac v0.2.5-beta 内测中」，须在**外部 wiki 仓库**更新，本仓改不到。
4. 桌面离线编辑 / 断网双向同步不含；在线自动更新未接通（本 Release 不带 update-manifest）；无 Apple 签名/公证，仅 arm64。

---

## 七、发布动作

1. 文档回填（本文件 + `docs/release-notes/0.2.6.md` + README 测试基线）并本地提交（**精确 add，不碰队友 beta.2 Rust WIP**）。
2. fast-forward 推送 `feat/macos-desktop-d0`，并入 `main` 后 push（不强推、不覆盖）。
3. 打 tag `v0.2.6`（指向 `3ea1f65` 或含文档提交的最新头），推送 tag。
4. Gitea 建**正式 Release**，上传 fpk + dmg + 两 `.sha256` + 发布说明，不传 update-manifest；核对仓库 default_branch。

---
---

# 【归档】v0.2.5-beta.1 发版说明（首个桌面端测试版 / Pre-release，内部详版）

> 对外精简版见 `docs/release-notes/0.2.5-beta.1.md`；以下为内部完整记录。


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
