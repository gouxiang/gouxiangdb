# 协同编辑 · 真实浏览器点验报告

- 时间：2026-09-22
- 执行：两个独立 Playwright chromium 上下文（两个不同登录身份），真点键真读屏，结论全部来自屏幕上看到的东西或 `prisma/dev.db` 查出来的行，没有一条是"看代码推测"。
- 环境：`apps/api` :3001（tsx，无 watch）、`apps/web` :5173（vite dev，`VITE_COLLAB=1`）、知识库「统一测试知识库」`cmtxr0jok0001607owi2oydgd`
- 身份：owner `test@gx.dev`（统一测试）、第二个可写身份 `s7owner@example.com`（S7老板）、受限身份 `restricted-navgov@gx.test`（受限验证账号）

---

## 〇、先说结论：第 0 步落库到底过没过

**过了。** 唯一的门槛项落库已真机验证通过：双方输入都进了 `kb_docs`，`contentVersion` 递增、`updatedAt` 变化、`updatedBy` 是真实编辑者、`searchText` 同步更新，冷归结走的是既有的 `saveDocContentTx`（版本快照 / outbox / nav 对账一个都不少）。

但这个过程里踩到两层坑，必须写清楚，否则"过了"两个字会误导人：

### 0.1 第一轮按环境原样跑：**没过，且是灾难性的**

`apps/web/vite.config.ts` 的 `server.proxy` 原本只配了 `/api` `/health` `/healthz` `/readyz` `/uploads` 五个前缀，**没有 `/ws`**。

于是前端按 `buildWsUrl()` 算出的 `ws://127.0.0.1:5173/ws/collab/doc%3A<id>` 打不到后端，协同状态机永远停在 `connecting`，`collabActive` 为 false，`useDocPersistence` 退化成单机防抖整篇 PUT。

实测（文档 `cmubiuyjn00049n62dteem1xa`，基线 `"初始内容 AAA"` / v1）：

| 现象 | 证据 |
|---|---|
| 两边各打各的，互不可见 | A 屏 `初始内容 AAA甲甲甲`，B 屏 `初始内容 AAA乙乙乙` |
| A 的写落库、B 的被拒 | `/tmp/gx-api.log`：`PUT .../content 200` 紧跟 `PUT .../content 409` |
| B 的内容丢失 | 查库 `content = "初始内容 AAA甲甲甲\n"`，v1→v2，**没有"乙乙乙"** |
| 服务端完全没有协同痕迹 | `collab_docs` 表 0 行；`GET /api/collab/presence` 返回 `entries: []` |

即：**代理缺失时，"协同"其实没开，界面却照常显示"已保存到云端"，后写的人被 409 静默丢内容。** 阻断级。**已修**（见 D-1）。

### 0.2 补上 `/ws` 代理 + 重启后端后的复跑：**过了**

修复后不再做任何浏览器侧改写，走的就是真实链路（`:5173` → vite 代理 → `:3001`）。

实测（文档 `cmubvcnof0002r5ps7xprsimi`，基线 `"初始内容 AAA"` / v1）：

| 阶段 | 屏幕 | 数据库 |
|---|---|---|
| A 打开 | `["初始内容 AAA"]` | — |
| B 打开 | `["初始内容 AAA"]` | — |
| A 打「甲甲甲」、B 打「乙乙乙」 | **两边都是 `初始内容 AAA甲甲甲乙乙乙`** | — |
| 两个页面全关，等 6s | — | `content = "初始内容 AAA甲甲甲乙乙乙\n"`，**v1→v3**，updatedAt=1790032896604，updatedBy=S7老板 |

（`v1→v3` 是因为这轮里 30s tick 与房间空置各归结了一次；内容一致，不是丢字也不是重复。单写场景见 §二 S9：只 bump 一次。）

### 0.3 最终 T-0（重启后端 + 补 `/ws` 代理之后，真实链路）的 sqlite 前后对照

文档 `cmubvwowg0027r5ps2wtezswq`，两个浏览器上下文（owner + s7owner）各打 3 个字：

```
=== BEFORE ===
{"content":"初始内容 AAA","contentVersion":1,"updatedAt":1790033801639,"updatedBy":"cmtxqyk8m0000607oodg2c6uk"}

A 打开: ["初始内容 AAA"]        B 打开: ["初始内容 AAA"]
A 输入后: ["初始内容 AAA甲甲甲乙乙乙"]      ← 两边屏幕一致
B 输入后: ["初始内容 AAA甲甲甲乙乙乙"]
（全部关闭，等 8s > 冷归结防抖）

=== AFTER ===
{"content":"初始内容 AAA甲甲甲乙乙乙\n","contentVersion":3,"updatedAt":1790033821250,"updatedBy":"cmu0zg47a0001vkzqr4x6yhbw"}
```

**通过**：content 含双方输入、contentVersion 递增、updatedAt 变化、updatedBy 是真实编辑者。

`v1→v3` 说明（不是重复写、不是丢字）：这两次写分别来自**周期性的 30s tick 归结**和**房间空置归结**。tick 是全局 30s 定时间隔（`registry.ts:87`），不与房间创建时刻对齐，所以它会落在任意一次测试的中间；它先落了一次中间态，页面关闭时的空置归结再落最终态。最终 content 与屏幕一致，`collab_docs.base_version=2` 也印证房间基线被正常推进。这不是缺陷，恰恰是 D-3 修好之后 tick 真的在工作的表现 —— 修复前整个 42s 窗口里一次 tick 都没触发过。

### 0.4 关于"协同内容完全不落库"的更正

**我这一轮从头到尾没有观测到"完全不落库"**，这个 P0 描述与我的实测不符，请不要按这个口径记录。我这轮每一版（包括重启前）查库都能看到 content 变化，真正的缺陷是下面三条，它们都不是"不落库"：

1. **dev 代理缺失时**：协同根本没连上，退化成 HTTP 整篇 PUT → 后写者被 **409** 拒，内容进的是 HTTP 那条路，协同房间 0 痕迹（`collab_docs` 空）。这是"走的不是协同路"，不是"协同不落库"
2. **重复播种**：落库了，但内容被播成两份（D-2）
3. **30s tick 不触发**：落库了，但只在房间空置/关进程时落一次，长会话期间不落（D-3）

你那条独立探针（直连 :3001 发增量更新 → close → 等 5s → `contentVersion 0→1`）走的是**房间空置归结**，这条路径在我这轮任何一版都是通的，所以它验证不到 D-3；要验证 D-3 必须**保持连接不关**、观察 30s 以上 —— 我的 S9 就是这么做的（修复前 42s 零变化，修复后 +32.5s 落库）。

### 0.5 关于"4401/4403 循环"的更正

**我这一轮从头到尾没有观测到任何 4401/4403** —— 这不是我报的。核对证据：

- 浏览器侧采集了两个上下文全部协同 WS 的 `close` 事件码，结果是**空数组**（连接全程没有异常关闭，页面关闭是 context 级销毁，不产生可采样的 close 码）
- 服务端日志全量检索 `4401|4403|ticket_invalid|no_access`：**0 命中**
- 我这轮唯一跟 4403 有关的内容是缺口 D-8：`COLLAB_CLOSE.READONLY_WRITE`（4403）这条只读档位**没能真机验证**，因为凑不出"可读不可写"的身份 —— 是"没测到"，不是"测到了循环"

第一轮的现象也印证了这一点：代理缺失时 WS 压根没建立连接（不是被 4401/4403 拒绝），所以前端停在 `connecting`、`collab_docs` 0 行。这条与"票据/档位判定"无关，是纯代理缺失。

---

## 一、覆盖场景清单

| # | 场景 | 做法 |
|---|---|---|
| S0 | 落库真机验证 | 新建文档 → 记基线 → 双开 → 各输不同字 → 关页面 → 等 6s → 查 kb_docs |
| S1 | 先后打开双写（复现率） | A 先开 3.5s，B 后开，各打 3 字；用 3 份新文档各跑一遍 |
| S2 | 在线名单 UI | 读 `[aria-label^="当前在线协作者"]` 的 DOM 与服务端 presence 端点对拍 |
| S3 | 加入顺序反转 | B 先开、A 后开，看谁看得见谁 |
| S4 | 协同光标 / 租约遮罩 | 一人打字并停留光标，另一屏找光标与占用遮罩节点 |
| S5 | 保存回写反馈 | 每 0.5s 采一次顶栏状态文本，连采 6s；另做 42s 长会话观察 |
| S6 | 冲突收敛 | 两人同时在同一行末尾交替打字 6 轮，等 3.5s 比对两边 |
| S7 | 断线 | 关掉 B 的整个 context，A 继续编辑并落库 |
| S8 | 只读参与者 | 受限身份打开同一文档，看界面、看 WS、看有没有改坏内容 |
| S9 | 落库延迟 | 打字后每 2s 查一次 kb_docs，直到内容变化 |
| S10 | 单人开关 | 只开一个人，看会不会自己把内容播成两份 |

---

## 二、结果（逐项：现象 + 证据 + 是否通过）

### S0 落库真机验证 —— ✅ 通过（补 `/ws` 代理 + 重启后端后；修复前 ❌）
证据见 §〇。修复前 content 只含 A 的输入、B 被 409 拒掉；修复后走真实链路，content 含双方输入、v1→v3、updatedAt/updatedBy/searchText 全部正确。

### S1 先后打开双写 —— ✅（修复后 3/3 干净，另见 §〇.2 复跑）
- 修复前（文档 G/H/I）：3/3 全复现
  - `B 打开: ["初始内容 AAA", "初始内容 AAA"]` ← B 一进来正文就是两份
  - `A 输入后: ["初始内容 AAA甲甲甲乙乙乙", "初始内容 AAA"]`
  - 落库 `content = "初始内容 AAA甲甲甲乙乙乙\n\n初始内容 AAA\n"`
- 修复后（文档 M/N/O，浏览器侧改写 WS 时）：3/3 全干净
- 修复后 + 补 `/ws` 代理 + 重启后端（文档 R1，真实链路无改写）：`B 打开: ["初始内容 AAA"]`，输入后两边一致 `初始内容 AAA甲甲甲乙乙乙`，落库正确

### S2 在线名单 —— ✅（修复后双向可见）
- 修复前：A（先开）屏上有「S7老板」，B（后开）屏上**该节点完全不存在**；同一时刻服务端 presence 明明返回 2 条
- 修复后（文档 R3，重启后端后）：
  - A 屏 `aria-label="当前在线协作者 1 人"`，头像底色 `rgb(22,163,74)`，名字「S7老板」
  - B 屏 `aria-label="当前在线协作者 1 人"`，头像底色 `rgb(220,38,38)`，名字「统一测试」
  - **两边都能看见对方**
- 关于"含自己"：每屏显示的是**除自己以外**的 1 人，自己不显示。这是 `splitPresence`（`apps/web/src/features/collab/collab-peers.ts:33`）按 DESIGN §5.1 的既定语义（同账号多标签页算多个参与者，各自只渲染他人）。不是缺陷，但如果你要的是"含自己在内的总人数"，那是另一条需求，需要改组件

### S3 加入顺序反转 —— ✅（修复后双向可见，不再依赖谁先来）
- 修复前：B 先开 → B 无头像；A 后开 → B 立刻看到 A、A 仍看不到 B（单向）
- 修复后（重启后端后）：
  - `B(先开) 看到: 当前在线协作者 1 人 | 统 统一测试`
  - `A(后开) 看到: 当前在线协作者 1 人 | S S7老板`
  - A 关闭后 `B(A已关) 看到: 无头像区`（下线即时生效）

### S4 协同光标 / 租约 —— ❌ 缺口
- 光标：A 打字并停留光标后，B 屏 `[class*='cursor']` 命中 0 个
- 租约：B 屏 `[class*='lease']` 命中 0 个
- 服务端 presence 每行都是 `"selection": null, "leases": []`
- 代码侧事实：全仓只有 `collab-provider.ts:224` 一处 `awareness.setLocalStateField`，且只写 `user`；没有任何地方写 `selection` 或 `leases`

### S5 保存回写反馈 —— ❌ 缺口（谎报 + 无失败路径）
- 顶栏状态时序（每 0.5s 一采，共 6s）：**12 次全是「已保存到云端」**，从未出现「保存中…」，也从未出现「有未保存更改」
- 42s 长会话：界面全程「已保存到云端」，而**数据库 42s 内一次都没变**（见 S9）
- 失败路径：`useDocPersistence` 的 `catch` 分支在协同模式下根本不会走到（`markDirty` 直接 `setStatus("saved")` 就 return 了）

### S6 冲突收敛 —— ✅ 通过
- 两人交替在同一行末尾打「1」「2」各 6 次
- 结果两边完全一致：`冲突基线行 ABCDEF121212121212`（不丢字、不重复、不错乱）
- 修复后重跑（真实链路）：`A 打开: ["冲突基线行 ABCDEF"]`（单块，不再翻倍）→ 冲突后 `["冲突基线行 ABCDEF121212121212"]`，`两边一致: true`

### S7 断线 —— ✅ 通过
- 关掉 B 的整个 context 后，A 继续输入「断线后ZZZ」
- A 屏正常渲染、无报错、A 的头像区正确变回无（B 已下线）
- 修复后重跑（真实链路）：落库 `content = "冲突基线行 ABCDEF121212121212断线后ZZZ\n"`（**单块、无重复残留**），v1→v3

### S8 只读参与者 —— ⚠️ 安全侧 ✅ / 档位本身未能验证
- 受限身份打开同一文档：整页渲染「没有访问权限 / 你当前无权查看该内容，可联系所有者开通权限后重试。」
- 没有 `.kb-wy-editable` 节点、没有「保存」按钮、WS 未建立
- 强制点击 + 键盘输入后：DB `content` 保持 `"初始内容 AAA"`，**没被改坏**
- 但「可读不可写」档位（服务端 `role=viewer` → `close(4403)`，`packages/shared-types/src/collab.ts:86`）**没能真机验证**：该账号连读权限都没有（`GET /api/kb/docs/<id>` 与 `/api/collab/ticket` 双双 403）。详见 D-8 —— 已确认是权限侧没放行，不是协同降级

### S9 落库延迟 —— ✅（修复后 30s tick 真的归极了）／❌（修复前）
- 修复前（文档 P）：两人页面都开着，A 输入「延迟测试QQQ」，每 2s 查一次 kb_docs，**一直查到 42s 内容仍是 `"基线 PPP"`、v 仍是 1**；直到两个页面都关掉（房间空置）才落库。即设计里的 30s 兜底**一次都没触发**
- 修复后（文档 R2，重启后端后）：`>>> +32456ms 变化: v=2 content="初始内容 AAA延迟测试QQQ\n"`
  - **页面全程开着**，内容在输入后约 32.5s 落库（30s tick + 热防抖），v1→v2，**只写一次**
  - 之后再等 28s、两个页面关掉后再等 6s，`content` 与 `contentVersion` 都不再变化 —— 没有重复写、没有回退

### S10 单人开关 —— ✅ 通过（排除"自己播自己"的嫌疑）
- 只开 A：0ms / 1.5s / 3s 三次采样均为 `["冲突基线行 ABCDEF"]`，没有翻倍
- 说明 D-2 是"第二个人加入"触发的，不是单机自扰

---

## 三、缺陷与缺口

### D-1（阻断）dev 环境 vite 未代理 `/ws`，协同根本连不上，后写者内容静默丢失
- 根因：`apps/web/vite.config.ts:34` 原先是 `const rootPrefixes = ["/api", "/health", "/healthz", "/readyz", "/uploads"];` —— 五个前缀里没有 `/ws`
- 现象：WS 打不到后端 → 状态机停在 `connecting` → `collabActive=false`（`apps/web/src/features/kb/DocEditorPage.tsx:46`）→ 走 `useDocPersistence` 的单机防抖 PUT（`useDocPersistence.ts:163`）
- 后果：`PUT /content 200` + `PUT /content 409`，B 的输入被拒且界面无任何冲突提示（409 提示走 `persist.conflict`，但 B 那次是自动防抖保存，页面只落了个 toast，用户极易错过）
- **是否已修：已修**（team-lead 批准后改）。`vite.config.ts` 新增 `proxy["/ws"] = { target: API_TARGET, changeOrigin: true, ws: true }` —— **`ws: true` 必须显式开**，http-proxy 默认不转发 WebSocket upgrade
- 验证：
  - `ws://127.0.0.1:5173/ws/collab/doc%3Aprobe` 的 upgrade 现已成功转发（修复前该 URL 连不上）
  - 浏览器侧不再做任何地址改写，走真实链路重跑 S1/S2/S3/S9，全部见 §二
- **生产部署提醒（本轮未改部署，只记录）**：生产前置 nginx 必须把 `/ws/collab` 反代到 `:3001`，且 `proxy_read_timeout` 要放到 **3600s**。默认值 60s 会让每条协同长连接每分钟被掐断一次，表现为"每一分钟掉线重连一次"。同时要带上 `Upgrade` / `Connection` 头转发：
  ```
  location /ws/collab {
      proxy_pass http://127.0.0.1:3001;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 3600s;
  }
  ```

### D-2（阻断）第二个人加入即把正文播成两份
- 根因：`apps/web/src/features/kb/collab/useCollabDoc.ts` **第 152-173 行那段内联的播种 effect** 把"连上了"当成"内容到了"。`active` 来自 `status === "connected"`，而 y-websocket 的 `connected` 只表示 WebSocket 打开，sync step2 还没到；此刻 `binding.y.order.length === 0`，播种判定成立 → 再播一份。叠加 D-1 的"看不到 peer"（`peerCount` 恒 0），`ADOPT_WAIT_MS` 那份等待也一并失效，`setTimeout` 直接是 0ms
- 注：这段逻辑是**内联在 hook 里的 effect**，不是某个叫 `seedIfEmpty` 的独立函数 —— 全仓不存在这个名字，别按函数名去找
- 现象：`B 打开: ["初始内容 AAA", "初始内容 AAA"]`，落库 `"初始内容 AAA甲甲甲乙乙乙\n\n初始内容 AAA\n"`，3/3 稳定复现
- **是否已修：已修**。两处改动，都在 allowed 目录内：
  - `apps/web/src/features/collab/collab-provider.ts`：新增首次 sync 完成信号 `isDocSynced` / `onDocSynced` / `markDocSynced`，挂在 `provider.on("sync", ...)`
  - `apps/web/src/features/kb/collab/useCollabDoc.ts`：新增 `SEED_SYNC_GATE_MS = 3000` 常量，以及**第 140-150 行的 `syncReady` 闸门 effect**（`onDocSynced` 回调或 3s 超时两者先到者置起），播种 effect 的依赖加上 `syncReady` 并在开头加 `if (!syncReady) return`。超时兜底保证协同连不上时退化成单机也不卡死
- 验证：M/N/O 三份新文档各跑一遍，3/3 B 打开为单块、落库内容正确；补 `/ws` 代理 + 重启后端后又在 R1 上用真实链路跑通一遍

### D-3（阻断）30s 兜底归结永不触发，长会话内容只躺在 collab_docs
- 根因：`apps/api/src/collab/registry.ts:97` `if (!room.dirty) continue;` 用 `dirty` 当冷归结的门，而 `dirty` 在 500ms 热持久化成功后就被 `room.ts` 的 `writeState()` 清成 false。于是"长会话每 30s 兜底"永远跳过，冷归结只剩"房间空置"和"优雅关闭"两条触发路径
- 现象：S9 实测 42s 内 kb_docs 零变化；同期界面恒定「已保存到云端」
- 危害：进程被强杀（断电 / OOM / 容器重启）时，从上次空置以来的编辑**全部丢失**，且用户全程被"已保存"误导
- **是否已修：已修**。`room.ts` 新增 `coldDirty` 字段（只有 `flush()` 跑完 flusher 才清，热持久化不清）；`registry.ts:97` 改走 `coldDirty`；`docFlush.ts:66` 的 `noteFailure` 一并保留 `coldDirty`
- 验证：
  - 单测已锁：新增 `apps/api/src/collab/__tests__/room-coldflush.test.ts`，4 条契约（编辑同时置起两门 / 热持久化跑完只清 dirty、coldDirty 必须还在 / 归结成功才清 coldDirty / 归结失败保留 coldDirty 且下一轮继续试）
  - **真机已验证**：重启后端后重跑 S9 —— 输入后 **+32456ms**、**页面全程开着**的情况下 `kb_docs` 落库 `v1→v2`、`content="初始内容 AAA延迟测试QQQ\n"`，且之后不再重复写。修复前同一场景 42s 内零变化

### D-4（阻断）后加入者看不到已在线的人
- 根因：`apps/api/src/collab/attach.ts:134-138` 建连时只主动发了 sync step1，没发 awareness 快照。而 y-websocket 只广播自己的 awareness、不会主动发 `queryAwareness`；房间的 awareness 变更广播又一律排除发送者（`room.ts` `handleAwarenessUpdate` 的 `if (c === conn) continue`）。三者叠加 → 后来者永远收不到先来者的名单
- 现象：S2 / S3，B 屏 `[aria-label^="当前在线协作者"]` 不存在，服务端 presence 却是 2 条
- 连带危害：它是 D-2 的帮凶 —— `peerCount` 因它恒为 0，播种的等待窗口被跳过
- **是否已修：已修**。`attach.ts:145` 在 step1 之后补发 `room.encodeAwarenessSnapshot()`
- 验证：**已用连线级测试闭环**（真 `http.Server` + 真 WebSocket + 临时库，不依赖重启跑着的 API）:
  - `apps/api/src/collab/__tests__/attach-awareness.test.ts` 两条：① 后加入的连接全程不发 `queryAwareness`，也能在收到的 awareness 帧里看到先来者的 clientID；② 房间无人时建连不会收到服务端自己的空壳条目
  - **反向验证过**：把 `attach.ts` 那行 `sendFrame(conn, room.encodeAwarenessSnapshot())` 临时注掉后，第 ① 条立刻红（`expected [] to include <clientID>`），确认这条测试真的在守这个行为，不是摆设
  - **真机已验证**：重启后端后重跑 S2 —— A 屏出现「S7老板」、B 屏出现「统一测试」；重跑 S3（B 先开）同样双向可见，且 A 关闭后 B 的头像区即时消失。修复前是单向的

### D-5（缺口，未修）协同光标与编辑锁租约没有数据源
- 根因：全仓唯一一处 `awareness.setLocalStateField` 在 `apps/web/src/features/collab/collab-provider.ts:224`，只写 `user`。`selection` 与 `leases` 没有任何写入方，而 `CollabCursorLayer` / `CollabLeaseLayer` 的数据源分别是 `entries[].selection` 和 `entries[].leases` —— 恒空，UI 自然什么都不渲染
- 应该在哪写：
  - 光标：`apps/web/src/features/kb/WysiwygEditor.tsx:231` 附近的 `useCollabDoc` 调用处，编辑器已有 `focusedId`（:270）可直接当 selection 源，补一个 `useEffect` 把它 + 光标 offset 写进 awareness 的 `selection` 字段即可；解析函数 `parseSelection` 已在 `apps/web/src/features/collab/collab-presence.ts:58` 就绪
  - 租约：`apps/web/src/features/collab/useCollabLeases.ts` 已实现登记与裁决，但目前只被 `CollabLeaseLayer.tsx:51` 消费，没有上游往 awareness 写 `leases`；需在编辑器焦点/输入时调用它的 claim 接口
- 为什么没修：两处都要伸进编辑器的键盘与焦点路径，风险高于本轮授权范围（且 D6 要求单机零 DOM 增量，改动面需更谨慎）

### D-6（缺口，未修）协同模式下保存反馈是谎报，且没有失败路径
- 根因：`apps/web/src/features/kb/useDocPersistence.ts:163-167` —— `markDirty` 在 `collabActiveRef.current` 为真时直接 `setStatus("saved")` 就返回；`saveNow`（:180）同样直接置 `saved`。于是"保存中"永远不会出现，失败也永远不会上报
- 现象：S5 的 12 次采样全是「已保存到云端」，而 S9 证明此刻内容其实还没进 kb_docs
- 为什么没修：`useDocPersistence.ts` 不在本轮可改目录内

### D-7（轻微，未修）什么都没改也会 bump contentVersion
- 根因：`blocksToMarkdown` 归一出的尾换行与库里的 `content` 字面不等（`docFlush.ts:150` 的 `row.content === markdown` 判等），于是每次开关页面都会写一次 + 生成一条版本快照
- 现象：S10 单人打开再关闭，`content` 从 `"冲突基线行 ABCDEF"` 变成 `"冲突基线行 ABCDEF\n"`，v1→v2
- 影响：版本历史会被灌入无意义快照

### D-9（技术债，未做）结构对账的"纯移动"判定是长度启发式
- 位置：`apps/web/src/features/kb/collab/useCollabDoc.ts:121-126`，`syncStructureToY` 的收尾：
  ```ts
  const now = y.order.toArray();
  if (now.length === want.length && now.join("\u0000") !== want.join("\u0000")) {
    for (let i = now.length - 1; i >= 0; i -= 1) y.order.delete(i, 1);
    y.order.insert(0, want);
  }
  ```
- 现状：只在"两个 id 序列**长度相等**且内容不同"时才判为纯移动并整段重写 order。长度不等时（有增删）直接跳过，让增删路径自己处理 —— 这是有意的保守设计，避免增删场景误伤并发
- 隐患（**代码层面观察，本轮未真机复现**）：判定用的是"长度相等"而不是"集合相等"。若一次对账里同时删掉一个块、新增一个块，长度恰好相等但集合不同，就会走进整段 `delete + insert` 的重写分支。后果是整篇 order 被重写一次，可能把并发的远端顺序改动覆盖掉
- 更稳妥的判据：先比对 id **集合**是否相同（`new Set(now)` 与 `new Set(want)` 逐项相等），再判次序不同
- 为什么没做：这条不在本轮的缺陷清单里、也没有真机复现的现象支撑。改它要动结构对账的核心判定，风险高于收益，故单列为技术债交给你决定

### D-8（环境限制，未修）只读档位无法真机验证 —— **已确认是授权体系未接通，不是协同降级缺陷**
- 现象见 S8：受限身份打开文档整页是「没有访问权限」，协同票据也拿不到
- **实测证据（本轮重启后复测）**：
  - `kb_members` 里现在**确实有**这条 viewer 行：`{kbId: cmtxr0jok0001607owi2oydgd, userId: cmu7ymujq0001bky62ss9y9zw, role: "viewer"}`
  - 但用该身份 `GET /api/kb/docs/<docId>` → **403**；`GET /api/collab/ticket?roomId=doc:<docId>` → **403 `无权访问该知识库`**
- **结论写准**：这不是协同的缺陷，也不存在"协同的只读降级失败"。viewer 拿到 403 的根因是**授权体系本身还没接通**：
  - `kb_members` 已不参与放行（`apps/web/src/api/client.ts:885` 注释明写"写端点已下线，kb_members 行只作历史留档"），所以那条 viewer 成员行是**死数据**
  - 新的 `role_library_scope` **不是空表**（实测 `select count(*)` = **203** 行），但本库 `cmtxr0jok0001607owi2oydgd` 名下只有两行，且都只授予可管理/可见给 `role_owner` 与 `role_admin`：
    ```
    rls_seed_kb_cmtxr0jok0001607owi2oydgd_role_owner   role_owner   canManage=1 visible=1
    rls_seed_kb_cmtxr0jok0001607owi2oydgd_role_admin   role_admin   canManage=1 visible=1
    ```
    没有任何一条把"可见"授予只读档位的角色 —— 所以 viewer 在这个库上没有任何可见性
  - 协同侧的代码（`routes/collab.ts:39-49` 的 `resolveRole` 判 viewer、`attach.ts:165-168` 的 4403）**根本没被调用到** —— 请求在取票之前就被 403 拦下了
- **本项依赖授权体系接通后复验。** 目前有另一位同事正在接通授权体系，请在他的工作完成后重跑 T-10。届时预期结果：viewer 能读到文档（ticket 返回 `role: viewer`）、界面只读、尝试写入时服务端 `close(4403)`、他人内容不变
- 安全侧已验证（不依赖授权体系）：无权限身份拿到明确 403、WS 不建立、强制点击与键盘输入后 DB 内容未被改坏

---

## 四、本轮改动清单（未 commit）

| 文件 | 改动 |
|---|---|
| `apps/api/src/collab/attach.ts` | 建连时补发 awareness 快照（修 D-4） |
| `apps/api/src/collab/room.ts` | 新增 `coldDirty` 冷归结门 + `flush()` 成功后才清（修 D-3） |
| `apps/api/src/collab/registry.ts` | tick 兜底改走 `coldDirty`（修 D-3） |
| `apps/api/src/collab/docFlush.ts` | `noteFailure` 保留 `coldDirty`（修 D-3 配套） |
| `apps/web/src/features/collab/collab-provider.ts` | 新增 `isDocSynced` / `onDocSynced` / `markDocSynced`（修 D-2 配套） |
| `apps/web/src/features/kb/collab/useCollabDoc.ts` | 播种前置首次 sync 闸门 `SEED_SYNC_GATE_MS`（修 D-2） |
| `apps/api/src/collab/room.ts` | `encodeAwarenessSnapshot()` 只发有状态的客户端，避免把服务端的 null 槽位发成对端空壳条目（D-4 配套） |
| `apps/api/src/collab/__tests__/room-coldflush.test.ts` | 新增：锁住 coldDirty 的四条契约（编辑置起 / 热持久化不清 / 成功才清 / 失败保留） |
| `apps/api/src/collab/__tests__/attach-awareness.test.ts` | 新增：连线级证明"后加入者收得到已在线者名单"（真 WS，已反向验证过会红） |
| `apps/web/vite.config.ts` | 新增 `proxy["/ws"]`（`ws: true`），修 D-1 |

自验（补 `/ws` 代理 + 重启后端之后复跑）：
- `apps/web`：`npx tsc --noEmit` 0 错；`npx eslint src/features/collab src/features/kb/collab` 0 错；`npx vitest run src/features/collab src/features/kb/collab` → 12 文件 / **171 测试全绿**
- `apps/api`：`npx tsc --noEmit` 0 错；`npx eslint src/collab` 0 错（1 条既存 warning，在 `docFlush.test.ts:202`，非本轮引入）；`npx vitest run src/collab` → 4 文件 / **17 测试全绿**（新增 `room-coldflush.test.ts` 4 条 + `attach-awareness.test.ts` 2 条）
- 后端重启确认：`/tmp/gx-api.log` 出现 `[GouXiangDB API] http://localhost:3001`，`/healthz` 200；旧进程优雅关闭日志 `收到 SIGTERM，开始优雅关闭` 正常
- D6 UI 冻结：本轮改动全部落在 hook 内部逻辑与后端，**没有新增/删除/改写任何 JSX、class、组件层级**，单机模式 DOM 不受影响
- 未 git commit、未 stash、未 checkout、未 reset

---

## 五、复现方法（留给下一轮）

```bash
# 1. 起两个浏览器上下文，注入两份 gx-auth（node /tmp/gx-mint.mjs <email> 取 lsValue）
# 2. dev 环境：vite.config.ts 已补 /ws 代理（ws: true），无需再做浏览器侧地址改写
# 3. 打开 http://127.0.0.1:5173/kb/<kbId>/doc/<docId>
# 4. 关闭全部页面后等 6s，查库：
cd apps/api && node -e "
const D=require('better-sqlite3');const db=new D('prisma/dev.db',{readonly:true});
console.log(db.prepare('select content,contentVersion,updatedAt,updatedBy from kb_docs where id=?').get('<docId>'));
"
```

## 六、测试文档清理清单（已执行，软删）

删除前逐条校验过四件事才动手：**属于「统一测试知识库」** + **未被删除** + **createdBy 是 owner `cmtxqyk8m0000607oodg2c6uk`** + **标题与清单一致**。共 26 篇，全部 200 软删成功。

| # | docId | 标题 | 用途 |
|---|---|---|---|
| 1 | `cmubiuyjn00049n62dteem1xa` | 协同落库验证-0922 | S0（dev 原样，代理缺失） |
| 2 | `cmubj2x5i001l9n62y3dtil1m` | 协同落库验证-0922-B | S0 打通 WS 后 |
| 3 | `cmubj4yhh00239n62c1csk79s` | 协同点验-C | S0 打通 WS 后 |
| 4 | `cmubj4ym4002a9n62w6jrsnjf` | 协同点验-D | S2 在线名单 |
| 5 | `cmubj4yqo002h9n62soz7b7z8` | 协同点验-E | S3 加入顺序反转 |
| 6 | `cmubj4ywq002o9n62rbvf085a` | 协同点验-F | S4/S8 光标租约与只读 |
| 7 | `cmubjdiu000439n62wmqebwea` | 协同点验-G | D-2 复现 1/3 |
| 8 | `cmubjdj0i004a9n62lkmtd5q9` | 协同点验-H | D-2 复现 2/3 |
| 9 | `cmubjdj5f004h9n62b7lhczgv` | 协同点验-I | D-2 复现 3/3 |
| 10 | `cmubjh766004z9n62kadxlyj8` | 协同点验-J | S6 冲突收敛 / S7 断线 |
| 11 | `cmubjh7gt00569n62jtw2h44p` | 协同点验-K | S10 单人开关 |
| 12 | `cmubjo28400609n628fzvwz5t` | 协同点验-M | D-2 修复后 1/3 |
| 13 | `cmubjo2e300679n620xzry4j8` | 协同点验-N | D-2 修复后 2/3 |
| 14 | `cmubjo2jz006e9n626q17n6ro` | 协同点验-O | D-2 修复后 3/3 |
| 15 | `cmubjuarm007d9n62p321d399` | 协同点验-P | S9 落库延迟（修复前） |
| 16 | `cmubk599n00839n62cqa9mz1e` | 协同点验-Q | 单人回归 |
| 17 | `cmubvcnof0002r5ps7xprsimi` | 协同点验-R1 | S0 真实链路 |
| 18 | `cmubvcnun0009r5ps6hfkzuwj` | 协同点验-R2 | S9（+32.5s tick 落库） |
| 19 | `cmubvco0v000gr5ps2bay5lut` | 协同点验-R3 | S2 双向可见 |
| 20 | `cmubvifhn0014r5psvqvhzrjx` | 协同点验-S3 | S3 反向顺序（重启后） |
| 21 | `cmubvmik9001nr5pserekfpme` | 协同点验-R4 | S6/S7（重启后复跑） |
| 22 | `cmubvwowg0027r5ps2wtezswq` | T0-最终验证 | 最终 T-0 before/after |
| 23 | `cmubvj63m001fr5psui7y8laq` | 协同落库探针 | team-lead 探针 |
| 24 | `cmubvugmn0020r5psp8mtgvu0` | 协同落库探针2 | team-lead 探针 |
| 25 | `cmubvzntm002or5psv5yabxx2` | 协同落库探针3 | team-lead 探针 |
| 26 | `cmubw2a7m002yr5ps9mcb8as7` | 长会话兜底验证 | team-lead 探针 |

**既有文档未被触碰**：清理后「统一测试知识库」剩余 17 篇未删文档，全部是本轮之前就存在的
（`cmtxr1yi80005607o1edy6wwb` 产品需求说明文档、`cmtxr3zfe0009607or3hizl6r`、`cmtxr44jh000d607ob50o741b`、`cmtxr71gz000h607oo2q15mpx`、`cmtxr71h1000l607okdoth5bu`、`cmtxr71h3000p607od1nnb4d1`、`cmtxr71h5000t607of9patt2y`、`cmu7hfaca0045k1bsegrtfdce`、`cmu7i3lyh0092k1bs42a786cf` 复验QA临时文档-可删除、`cmu8g1iqz0002cebe328kfhnv`、`cmu8g1ist0009cebe9was91y8`、`cmu8g1iui000gcebe823mp56p`、`cmu8heagp004b5wm7d3k40rus`、`cmu8hecew004h5wm789yifjmb`、`cmu8hej8v004p5wm73cfe9n59`、`cmubkzoif009r9n62xfwfkk2t`、`cmublpqyn00b59n62pufjy0wr`）。
注意最后两篇 `cmubkzoif…` / `cmublpqyn…`（09-21 18:31 / 18:51 创建）**不是本轮建的**，我没有动它们。

删除方式是**软删**（`DELETE /api/kb/docs/:id`），26 篇现在都在回收站里，可恢复。如果你要彻底清掉（走 `/permanent`），说一声我再执行 —— 彻底删除不可逆，我没擅自做。
