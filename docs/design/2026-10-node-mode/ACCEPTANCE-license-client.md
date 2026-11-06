# 客户端「官方商业授权」本机门禁 + VM15 真机验收报告

- 分支：`feat/license-client`（隔离工作树 `~/Desktop/GouXiangDB-license`）
- 修复提交：`f6d61a5`（未 push，待授权）
- 验收时间：2026-10-29（VM15 192.168.31.15）
- 结论：**本机四门门禁全绿；VM15 真机可机读断言 129/129 PASS；信任边界（只信内置 Ed25519 公钥）与「绝无无限版」不变量在全部恶意故障注入下成立；默认 `GX_LICENSE_MODE=off` 逐字节不变。**

---

## 1. 隔离与资源纪律（红线执行情况）

- 全部重活/联调在 **VM15**；本机仅跑 tsc/eslint/定向 vitest（单 fork、`--max-old-space-size=2048`，跑前可回收内存实测 2933MB ≥ 2500MB 门槛）。
- VM15 三套网络角色严格隔离，**现网 `8787`（pid 1044809）全程未受影响**：
  - `8787` 现网授权中心——只读核对，零改动；
  - `8788` 隔离授权中心（pid 1163494，db `prisma/data/license-dev.db`）；
  - `3002` 隔离客户端 BFF（pid 1200523，db `~/gx-e2e-data/gx-e2e.db`，enforce）；
  - `8789` 一次性恶意授权中心——仅绑 `127.0.0.1`，验收完已按端口反解 pid 精确停止；H 段独立夹具 `~/gx-h-data*` 已删。
- 客户端 3002 的 license 信任链 17 个源文件 sha256 与本地 HEAD **逐字节一致**（含 P2/P3 修复）。
- 409/反馈剧本均用一次性指纹或独立工单，结束自动清理（许可/实例/审计/工单/附件）；孤儿附件按「DB 无引用」白名单删除。

## 2. 本机四门门禁（commit f6d61a5）

| 门 | 结果 |
|---|---|
| 定向 vitest（client/changes/runtime-changes/runtime-gate/licenseSeatGate 5 文件） | **40/40 passed** |
| 状态机 05-TEST-VECTORS（state-vectors.test.ts） | **11/11 passed** |
| 三包 tsc --noEmit（shared-types / api / web） | **0 error** |
| eslint（9 个改动文件） | **0 error** |

## 3. 本轮修复的两个真实缺陷（f6d61a5）

### P2（Major，fail-open）后台心跳漏清闸门②缓存
- 根因：常驻 `LicenseRuntime.tick` 成功路径只 `invalidateSeatCache()`，漏清闸门② `licenseSeatGate` 的 10s 进程内缓存。授权中心**主动下发**的吊销/续费恢复只经后台心跳（前台 activate/refresh/import 走 BFF 双清无此问题），导致吊销方向最长 10s fail-open（已挂账号仍能进业务）、续费恢复白等约 8s。
- 修法：新增 domain 层零依赖发布/订阅 `changes.ts`（避免 runtime→middleware 反向依赖成环）；心跳成功即 `emitLicenseChanged()`，gate 模块加载时订阅即时作废缓存。失败/5xx/429/网络错不发信号；off 模式永不启动心跳、零行为变化。
- 真机回归（reverify）：吊销心跳返回后 u6 **即时 403/LICENSE_SEAT_SUSPENDED/verdict=invalid**；重激活后 u6 **即时 200（探针 ≈11ms，旧实测 ≈8s）**，恢复后稳定不抖动。

### P3（Minor，契约口径）离线坏码误报 502
- 根因：`importOfflineResponse` 对非 base64url-JSON 坏码原返回 `{status:0,error:BAD_RESPONSE_CODE}`，BFF 回落 502；接收链其它拒绝统一是 `200 + rejected`。
- 修法：改为 `{status:200, rejected:"BAD_RESPONSE_CODE"}`，前端按 rejected 提示、停留当前档；补前端文案。真机回归 HTTP 200/`rejected=BAD_RESPONSE_CODE`，单据与席位不变。

## 4. VM15 真机剧本汇总（可机读断言 129/129）

| 剧本 | 覆盖 | 结果 |
|---|---|---|
| s00 免费闸门 | 免费 5 人、第 6 人 403 LICENSE_SEAT_LIMIT | 3/3 |
| s01 激活/席位 | key 激活 licensed/seats=10、第 11 人 403、seats 恒数字 | 5/5 |
| s03 改席 | 缩席 seats=3 即时、version 自增、licensed 不挂存量 | 5/5 |
| s04 吊销软挂起 | invalid/回落5席、超额 u6–u10 按 createdAt 挂起、owner 保底、白名单可查状态 | 10/10 |
| s05 重激活 | 吊销后恢复 licensed、被挂账号即时恢复 | 5/5 |
| s07a 到期宽限 | grace/expired 30 天窗与软挂起 | 7/7 |
| reverify P2/P3 | 本轮两缺陷的真机回归 | 11/11 |
| s08a 服务端离线签发 | 换机指纹拒签、合法/异机/过期应答码构造 | 6/6 |
| **H 段恶意服务器故障注入** | 见 §5 | **59/59** |
| **s10 409 幂等/异机** | 见 §6 | **7/7** |
| **s09 反馈中心闭环** | 见 §7 | **11/11** |

> 说明：s06 续费 happy-path 早前以 stdout 逐条验证（结果 json 未落结构化），其「续费→恢复」即时收敛路径已由 reverify P2-B（重激活即时 200）等价坐实；s08b 客户端离线导入已被 H-B 更完整地覆盖。为不破坏 3002 当前 v14 验收基线，未重跑会自增主许可 version 的续费造数。

## 5. H 段：恶意授权中心（8789）故障注入 —— 59/59

用真实 `LicenseClient` + 内置公钥环验签 + 状态机 + PersistedClock + 真实文件 store/加密缓存 + 真实设备身份 + 真实 fetch（仅把 prisma KV 换成等价落盘 JSON KV），种子指向一次性恶意机。

**网络心跳通道（H-A）**
- 篡改信封字节留旧签名 → `BAD_SIGNATURE`
- 攻击者异钥 + 自有未知 kid → `KID_MISMATCH`
- 攻击者异钥但**盗用 dev kid da469cd3** → `BAD_SIGNATURE`（kid 仅索引，身份只由 Ed25519 字节确立）
- 异机指纹真签单 → `FINGERPRINT_MISMATCH`
- `v≠1` / `seats=null` / `seats=3.5` / `seats="999"` → `BAD_PAYLOAD`
- 合法 v10/seats3 接受后，重放 **v5+seats999** → `VERSION_ROLLBACK`，**席位不上升、停留 v10/seats3**
- 所有拒收期间 `cache.enc` 不存在（缓存不被污染）；每次拒收均停留原态

**离线应答码导入通道（H-B，同一接收链）**
- 过期导入码 → `OFFLINE_CODE_EXPIRED`；`offline=false` → `BAD_PAYLOAD`
- 低 version 高席位 → `VERSION_ROLLBACK`；异机指纹 → `FINGERPRINT_MISMATCH`；篡改 → `BAD_SIGNATURE`
- 坏应答码（P3）→ `200 + BAD_RESPONSE_CODE`

**时钟防回拨（H-C，未改 VM 系统时钟）**
- 合法未来 serverTime（+180 天）抬高并持久化水位；随后服务端时间回拨，水位**只进不退**
- 本机时钟手动回拨 400 天，`effectiveNow=max(local,maxSeen)` 仍取高水位（防回拨续命/逃逸）
- 全新进程载同一数据目录「重启」：缓存单据重新验签后采信、水位延续

**隐私分级**：免费态心跳不带 adminEmail/orgName（实测字段仅 fingerprint/deploymentId/platform 等设备字段）；商业化后才携带。

## 6. s10：409 激活幂等与异机拒绝 —— 7/7（直连 8788，一次性指纹）

- 同机同 key 重复激活（重装）→ **幂等 200**，仅 1 条 instance、许可 version 不自增；
- 本设备已绑他授权再激活另一 key → **409 LICENSE_ALREADY_BOUND**；
- 异机指纹激活已绑定 key → **409 LICENSE_ALREADY_BOUND**（授权不能随 key 转移）；
- 他机指纹 refresh → **403 LICENSE_FINGERPRINT_MISMATCH**；未知 key → 403 LICENSE_KEY_INVALID。

## 7. s09：反馈中心端到端闭环 —— 11/11（浏览器→3002 BFF→8788）

提交（含用户附件）→ 轮询见工单/附件 → 运营回复（fromAdmin 文本+附件，真实域服务造数）→ **心跳信封带角标 unread=1/open=1（红点通电）** → 轮询见运营回复且**附件经 BFF 代理下载字节一致** → 轮询后角标清零 → 运营 resolve → 用户追问**自动 reopen**、线程顺序 user→admin→user、3 附件齐 → sinceMs 增量轮询不回吐旧工单。

> 复测中发现并排除一处**测试夹具问题（非产品缺陷）**：运营附件落盘目录 `ATTACH_DIR=resolve(cwd,"data/attachments")` 随造数进程 cwd 变化；以授权中心目录为 cwd 后，直连 8788 与经 BFF 下载均 200 字节一致。误写的 3 个孤儿文件已按「DB 无引用」清理。

## 8. 安全不变量（全部用例逐条断言）

- **seats 恒为有限正整数**：免费/失效回落数字 `5`，商业为单据 seats；全程未出现 `null` / `Infinity`（BFF 仅在 mode=off 时把 Infinity 投影为 null）。
- **fail-safe 单向**：任何验签/指纹/版本/结构/时钟失败均停留当前态，不删数据、不抬席位、不污染缓存。
- **默认 off 零变化**：mode 非精确小写 verify/enforce 一律回 off；off 时 `start()` 第一道闸返回 false，不建 timer/身份、不出网、不查库，`/status` 返回 available:false/bypassed。

## 9. 待戴总拍板 / 遗留

1. **正式信任根公钥**：当前内置为开发公钥（kid `da469cd3`），代码注释已标注「开发钥不入生产客户端」；发正式版前须替换为生产 Ed25519 公钥（支持多 kid 并存轮换）。
2. 反馈透传协议后端部分 DTO 未最终冻结；前端 `normalizePollResponse` 为宽容投影，待后端契约定稿后收口（advisory，不影响本轮验收）。
3. UI 目检（授权状态/横幅/挂起页/反馈中心）建议戴总在真机过一遍；功能链路已全部通电并真机断言。

## 10. 现场状态与复现

- 保留供复核：8788（pid 1163494）、3002（pid 1200523，licensed/seats=3/version=14）。
- 已停止/清理：8789 恶意机、`~/gx-h-data*`、s09/s10 临时工单/许可/实例/附件。
- 全部验收脚本与结构化结果在 VM15 `~/gx-e2e-runs/`：
  - 结果：`.h-injection.json`(59) `.s10-409.json`(7) `.s09-feedback.json`(11) `.reverify-p2p3.json`(11) `.s00/.s01/.s03/.s04/.s05/.s07a.json`
  - 脚本：`gx-h-malicious-server.mjs` `gx-h-harness.mts` `gx-s10-409.mjs` `gx-s09-feedback.mts` `s00–s08*` `h.mjs` `lic-admin.mjs`
- **代码尚未 push**（铁律：本地提交，待戴总明确授权）。
