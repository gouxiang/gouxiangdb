# 客户端接入官方商业授权 · 落地计划（feat/license-client）

> 基线：main@6a45409（0.2.7 封版）。隔离 worktree `~/Desktop/GouXiangDB-license`，不碰主工作树队友 beta.2 WIP。
> 权威契约：`GouXiangDB-Server/docs/client-handoff/00–09` + `simulator/`（参考实现逐字节移植）。
> 本文是唯一施工 spec；每节标注"与授权中心提示词不同的融合决策"。

## 0. 最高约束
- **内存红线**：本机（16GB）只跑 tsc / eslint / 定向 vitest；不 pnpm install（已软链主仓 node_modules）、不 vite/esbuild/tauri/cargo、不全量 vitest。四门与全量剧本/联调走 VM15。
- **不破坏真实数据**：零 Prisma 迁移、零新表（复用 `app_settings` KV）、不动 users.status；新功能增量、旁路、`GX_LICENSE_MODE=off` 默认关闭，升级逐字节同今天。只本地 commit，不 push。
- **信任边界铁律**：只信"内置 Ed25519 公钥验签通过的信封字节"；信封外明文（头/DNS/URL/明文字段）一律不信；任何验签/指纹/版本/时钟异常的结果只能是**免费 5 人**，**永不出现无限版**（`Infinity` 仅在 `mode==="off"` 的 bypassed 出现）。

## 1. 融合态关键决策（不 100% 照搬授权中心 AI 提示词）
1. **纯 TS/Node 内置实现，零 Rust/cargo、零 Prisma 迁移、零新依赖**。干净 main 上队友的 Rust `license.rs/vault.rs/sidecar.rs` 全是未提交 WIP，不可依赖。信封缓存与"vault 加密区"用 Node `crypto` AES-256-GCM 落 dataDir 文件实现（机器派生密钥，目标是冗余防删痕迹，不是防读——单据本就发给本机）。
2. **"默认 off" 与 "接线通电" 的调和**：`mode=off` 时不仅不收敛，**也不启动心跳、零出网、零闸门、零额外查询**（逐字节同今天）。`mode` 即通电总闸：切到 `verify`（灰度起点）运行时立刻启动心跳、授权页/高级区/反馈入口全部真实可见可用，闸门②只提示不拦截；`enforce` 才真收敛。不设第二个藏功能的 flag。
3. **desktop 系统卷 UUID 免编译获取**：Node 侧首启一次性 `diskutil info /` 解析 `Volume UUID`（毫秒级子进程），结果缓存 KV；失败回落字符串 `"no-vol"`（与 simulator 完全一致）。`hostname=os.hostname()`。
4. **平台/包类型**：env `GX_LICENSE_PLATFORM` / `GX_LICENSE_PACKAGE_TYPE` 可显式注入（打包/sidecar 用）；缺省自动探测（darwin→desktop/dmg；linux 据 `GX_DATA_DIR` 含 fnos/trim 线索→fnos/fpk，`/.dockerenv`→docker/docker，否则 unknown/unknown）。fnos/docker 指纹**禁用**卷 UUID，用 `platform|persist|hostname|deploymentId`。
5. **suspendList 的角色来源** = `role_assignments`（subjectType=user 且 roleId ∈ `role_owner`,`role_admin`），不看 users.status；占席 = users.status ∈ ACTIVE+INVITED。
6. **grandfathered 事实**：模块首次在非 off 模式初始化时做一次性快照——若占席数 >5、从无单据且 everCommercial=假，则写 `license.grandfathered="1"`（只增不改），代表"升级前已超 5 人的老团队"。
7. **闸门②用独立中间件落地，不侵入 `resolveActiveAuth` 的 401 语义**：新增 `licenseSeatGate` 挂 `mount.use("/api/*", …)`（位置紧随 mustChangePassword），内部 `resolveActiveAuth`→短缓存挂起集合→命中抛 403 `LICENSE_SEAT_SUSPENDED`。效果等同"每请求、连未过期 JWT 一起拦"，且 off 零开销、可白名单、不污染旧 `/api` 与 `/api/v1` 两条鉴权链的既有契约。

## 2. everCommercial 三处冗余（拍板，不依赖 Rust vault）
任一为真即"曾商业"，防删本地痕迹逃逸到期挂起：
1. **DB KV**：`app_settings.k = "license.ever_commercial"`，v=`"1"`（随主库备份）。
2. **独立隐藏标记文件**：`<dataDir>/.license/.ever-commercial`（与库分离的介质；删库不删文件仍为真）。
3. **加密信封缓存文件**：`<dataDir>/.license/cache.enc`（AES-256-GCM，内含最近单据 + everCommercial 真值 + nonce）。
读取三路 OR（任一不存在/损坏按该路 false，但不影响其它路）；写入在同一"接收商业单据成功"点三路同写。彻底清库+删目录重装技术上防不住——靠 `licensedTo` 常驻 UI + AGPL/合同追责（契约既定）。

## 3. 配置默认值
| env | 默认 | 说明 |
|---|---|---|
| `GX_LICENSE_MODE` | `off` | off/verify/enforce；非精确值回 off。灰度从 verify 起。 |
| `GX_LICENSE_URL` | 内置调试常量 `http://127.0.0.1:8787`（正式域名待定，发版替换） | 自托管覆盖；地址迁移另持久 KV。空串=不联网（授权页高级区提示）。 |
| `GX_LICENSE_PLATFORM` / `GX_LICENSE_PACKAGE_TYPE` | 自动探测 | 见 §1-4 |
| `GX_LICENSE_HEARTBEAT_DEBUG_WINDOW` | off | 置 1 时间隔 60s（检测窗口用），否则桌面 86400 / fnos,docker 21600 |
| `GX_LICENSE_SEAT_TTL_MS` | 30000 | 挂起集合短缓存 |
公钥：内置当前开发公钥 PEM（kid 已本机复核 = `da469cd3`）；`keys` 模块以 `[{kid,pem}]` 数组内置，预留轮换。

## 4. 后端文件清单（apps/api，全部新建，除注明外零改动存量）
```
src/domain/license/
  keys.ts            # 内置公钥数组 + kid 自派生(spki sha256 前8hex) + 按 kid 选钥
  verify.ts          # 移植 simulator/verify：verifyAndParse / acceptEntitlement / RejectError（逐字节）
  state.ts           # 移植 simulator/state：currentEntitlement / suspendList / FREE_SEATS / GRACE_SECONDS
  clock.ts           # maxSeenTime 持久(KV license.max_seen_time) + effectiveNow(本机 vs maxSeen 取严)
  fingerprint.ts     # 移植 simulator/fingerprint + Node 运行时身份(deploymentId KV 首启 UUID、diskutil 卷UUID、平台探测)
  store.ts           # KV + 两文件 三冗余；加密缓存读写；nextBaseUrl 列表(≤3)；grandfathered 快照
  configLicense.ts   # 纯函数解析 mode/url/平台/包型/间隔（仿 configM5Search，易单测）
  client.ts          # fetch 传输：heartbeat/activate/refresh/feedback*；接收链顺序固定；地址迁移 tryMigrate；429退避；5xx回退
  runtime.ts         # 单 timer + inFlight 心跳调度（仿 replicaSyncRuntime），off 直接返回 false 零副作用
  seats.ts           # 占席计数 + role 解析 + 挂起集合(短缓存)；assertSeatAddAllowed（闸门①预算）
  copy.ts            # 06 文件唯一文案表（后端错误消息/状态 DTO 用）
src/middleware/licenseSeatGate.ts        # 闸门②（新建）
src/routes/license.ts                    # /api/license/status|activate|refresh|offline-code|import|org-name|feedback*
src/routes/licenseAttachment.ts         # GET /api/license/feedback/attachment/:name（能力 URL，无需鉴权头，经壳同源）
__tests__/  license-vectors.test.ts      # 跑 05-TEST-VECTORS.json 8+2 向量
             license-verify.test.ts      # 篡改字节/旧version/异机指纹/吊销/坏kid
             license-seats-gate.test.ts  # 两闸门 + 空库/邀请/续费恢复
             license-privacy.test.ts     # 免费心跳不含 adminEmail/orgName/hostname
```
存量改动（最小、可回滚）：
- `src/config.ts`：仅 re-export license 配置（不加入生产 fail-fast）。
- `src/domain/org/members.ts`：`createInvitedUser`(:183) 与 `createActiveUser`(:223) 事务回调**首行**插闸门①断言（预算结果由入参传入，回调内只比数字，不用全局 prisma）。
- `src/auth.ts`：signup 两造人分支（:87 事务 / :100 裸 create）过闸；空库自举（userCount=0，命中 bootstrapFirstOwner）放行；login 成功后非阻塞触发一次心跳。acceptInvite（INVITED→ACTIVE，不造人）**不拦**。
- `src/app.ts`：挂 `licenseSeatGate` 于 `/api/*`（mustChangePassword 之后）；挂 `mount.route("/api/license", licenseRoutes)`（不走挂起闸，路径前缀白名单）；附件公开路由。
- `src/index.ts`：`listen` 回调加 `bootLicense()`（仿 bootReplicaSync，失败只 warn），shutdown 停 timer。
- init-admin CLI：建首 owner 后尽力触发一次心跳（失败不影响建号）。

## 5. 两道闸门精确语义
- **闸门① 新增账号**（仅 enforce；verify 不拦）：事务外预算 `view` 与当前占席数；若造人后将超 `view.seats` 且 verdict∈{free,grandfathered,expired,invalid}，抛 403 `LICENSE_SEAT_LIMIT`（免费/祖父两版文案见 06）。licensed/grace 按单据 seats；bypassed(off) 放行。空库、init-admin、acceptInvite 不拦。
- **闸门② 登录态**（仅 enforce 且 verdict∈{expired,invalid}）：每请求现算 suspend 集合（30s 短缓存）；命中→403 `LICENSE_SEAT_SUSPENDED` + 管理员邮箱。软挂起不改 status、不释放名额、不删数据，与 DISABLED 的 401/审计彻底分开；续费后下一缓存窗自动恢复。licensed/grace/grandfathered/free 不拦。

## 6. 前端文件清单（apps/web，禁裸 fetch、禁新依赖、图标自建、gx-* token）
- `src/api/license.ts`：类型 + 调 `client.ts` 既有封装；拦截 403 `LICENSE_SEAT_SUSPENDED`/`LICENSE_SEAT_LIMIT`。
- `features/license/LicenseStatusPanel.tsx`：状态页（verdict、licensedTo、seats 已用/总额、到期、指纹短码、当前授权中心域名、异常提示"授权校验异常，已按免费版运行"）。
- `LicenseAdvanced.tsx`（折叠）：手填 key/8 位配对码激活、立即刷新、申请码（文本+二维码，纯前端生成，无新依赖用现有能力或轻量 SVG）、导入应答码、自报团队名、`GX_LICENSE_URL` 展示（自托管）。
- `FeedbackCenter.tsx`：提交工单（content 5–4000、category、联系方式、1–5 附件白名单/单 8MB/合计 20MB）、poll 列表、追问、附件下载；信封角标 unread 红点（unread=0/缺失不亮）。失败仅本地提示，不影响授权。
- `SeatLimitDialog.tsx`：第 6 人拦截（免费/祖父两版文案 + 购买商业许可/我已有密钥）。
- `SuspendedPage.tsx`：专用挂起全屏页 + 管理员邮箱，无绕过入口。
- `GraceBanner.tsx`：grace 提醒横幅（可当日关闭）。
- 接线：设置页加入口（`features/settings/SettingsPage.tsx`）；应用根挂挂起页路由与 grace 横幅；心跳/迁移/续费/直绑**全静默不弹 toast**（仅挂起页、新增拦截、grace 横幅可见）。隐私政策措辞落"关于/授权"页（07 原文）。
- shared-types：新增授权 DTO/枚举（改后 web+api 双 typecheck）。

## 7. 接收链（顺序不可变，逐字节对齐 simulator）
选 kid 公钥（无→KID_MISMATCH）→ base64 解码字节 raw Ed25519 `verify(null,…)`（失败→BAD_SIGNATURE）→ JSON.parse（坏→BAD_PAYLOAD）→ 校验 `v===1`、`product==="gouxiangdb"`、结构 → `entitlement.fingerprint===本机`（否则 FINGERPRINT_MISMATCH）→ `version>=缓存version`（否则 VERSION_ROLLBACK）→ 成功：校时 maxSeen、三冗余落缓存（revoked 清商业缓存但留 everCommercial）、记 interval/feedback 角标、按签名 `nextBaseUrl` 试迁移、回 `x-license-ack:<version>`。任何拒绝→停留当前态（免费 5），绝不无限。

## 8. 地址迁移 / 离线码
- 有序列表 `[当前,上一个,内置]`≤3 持久 KV，内置永不删；只信签名信封 `nextBaseUrl`；切换前向新址发 probe 心跳（不带邮箱）同 kid 验签通过才插表头、旧址留回退；scheme 仅 https，内网白名单 http（127/10/192.168/172.16-31），公网 http 拒；全失败 7 天重试内置；全程静默。
- 离线：申请码 base64url JSON{fingerprint,nonce,version,clientVersion}；应答码 base64url(wire) 复用同链，额外要求 `entitlement.offline===true` 且信封/单据 `importBeforeAt`（7 天内）；不做"未绑定首发"分支（服务端 2026-10-29 起拒签）。

## 9. 测试与验收（H）
- **本机（轻量）**：三包 `tsc --noEmit`、eslint（0 error）、只跑 `domain/license/__tests__` 定向 vitest（单 fork、`--max-old-space-size=2048`，跑前查空闲≥2500MB）。
- **VM15（重活）**：全量四门（vitest 收集数恒等、三包 tsc0、eslint0、S0 golden）；真实客户端替换 simulator 跑剧本 01–07；故障注入（篡改字节/旧 version/异机指纹/吊销单/断网 7d 与 30d/时钟回拨）断言任何异常路径 seats≤单据或 5、off 才 Infinity；activate 409 仅提示无绕开、同许可重装幂等；抓包验证免费心跳无 adminEmail/orgName/hostname。
- 验收交付：本地 commit 哈希、定向测试结果、向量 8+2 全绿截图/日志、UI 目检清单（verify 模式下授权页/高级区/反馈/第6人；enforce 下挂起页/grace）。

## 10. 提交策略
分原子提交：(1) config+keys+verify+state+clock+fingerprint+向量测试（纯函数，先绿）；(2) store 三冗余+seats；(3) client+runtime+routes；(4) 两闸门+app/index/auth/members 接线；(5) shared-types+web UI。仅本地提交，**不 push**，等戴总授权。
