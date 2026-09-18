# M7 门①/门④ 权威台账：五主线 AC + RC → 实际自动化测试（逐条实跑坐绿）

- 日期：2026-09-18
- 作者：research-m7-ledger（只读审计 + 单文件定向实跑；不改任何生产码/测试码）
- 基线：`main` @ `85da169`（AC-UPG-1 门②已由 team-lead 独立重跑坐实之后）
- Node：受管 `/Users/daijing/.workbuddy/binaries/node/versions/22.22.2-3/bin/node`（v22.22.2）
- 方法：`cd apps/api && npx vitest run <单文件...>` 分批定向实跑；规模门显式 `GX_M4_GATE=1`；
  e2e 用 `vitest run --config vitest.e2e.config.ts`（`GX_S8_SKIP_BUILD=1`，dist 为 06:59 构建）；
  web/shared-types/canvas 各自 `npx vitest run <单文件>`。**每个标"自动"的文件均本机实跑通过**，
  非 grep 推断。负载全程 1min <5。
- 计数口径：vitest 汇总 "Tests N passed"（it.each 展开后实数）。

## 0. 实跑总账

| 包/套件 | 定向文件数 | 实跑 passed | 备注 |
|---|---|---|---|
| apps/api 常规 vitest（分批定向，非全量 189 文件） | 159 | **1597** | 全部 passed，0 fail |
| apps/api e2e（6 件，独立 config） | 6 | **64** | 含 Inspector CLI 真出网跑通（clients 件 16 tests） |
| packages/shared-types | 4 | 56 | RC-01/02 等 |
| packages/canvas | 1 | 33 | M6-S6b 校验器（18 it 块/33 测试） |
| apps/web vitest | 23 | **278** | 与 web 基线 278 精确一致（9+13+1 三批 128+141+9） |
| **合计定向实跑** | **193** | **2028** | Playwright 1 spec 见 §D-9（需 dev-up，未在本轮） |

- 门①覆盖：47 条对外 AC **全部有自动化归属，零"找不到文件"**；其中 **39 条全自动闭环**，
  8 条为"自动 + 需人工/真机签字"（无纯手测 AC）。
- 门④ RC-01~40：**20 条有自动化**（18 全自动 + RC-02/RC-26 半自动），20 条为 RC 文档自标
  【UI】/【手册】类手测（画布 RC-13~25 占 13）；RC-41~55（G/H 组 15 条）全自动化。
- M4 规模门（默认 skip）本轮以 `GX_M4_GATE=1` 真跑 **10/10 绿**（scope-scale+s10-scale-gate）。

---

## A. 门① 五主线端到端对抗（M7 计划 §2.1~§2.6）

方式列：**自动**=实跑绿；**自动+手测**=有自动化但含浏览器/真机签字成分；**真机**=外部机器。

### A.1 M2 组织（9/9 自动）

| AC | 断言（精简） | 真实文件:用例 | 方式 | 实跑 |
|---|---|---|---|---|
| M2-1 | 6层部门/兼两部门/祖先链三路径来源完整 | routes/v1/org/__tests__/ac-m2-1.adversarial.test.ts（对抗1-3） | 自动 | 7/7 |
| M2-2 | 调岗移出/移入下次请求角色即时变化（无 sleep） | 同文件对抗4；domain/org/__tests__/roles-eval.test.ts | 自动 | 同批 92 passed |
| M2-3 | owner 停用 U：旧 tv 对 /auth/me 与 members 连续两次 401 UNAUTHORIZED | ac-m2-1 对抗5/6；routes/v1/__tests__/auth-state.test.ts（8）；domain/org/authStateCache.test.ts（6） | 自动 | ✅ |
| M2-4 | 自停用400；唯一owner（含部门继承展开）停用409；两owner可停其一 | ac-m2-1 对抗7；routes/v1/org/__tests__/lifecycle.test.ts（8） | 自动 | ✅ |
| M2-5 | 停用无关成员后匿名 /api/public/s/:token 仍 200 | ac-m2-1 对抗8；domain/org/__tests__/characterization/public-share-current.test.ts（5） | 自动 | ✅ |
| M2-6 | 停用同事务吊销全部 PAT，重激活不恢复 | mcp/pat/__tests__/patService.test.ts「停用联动(C-4)」；e2e/m6-s8-ac34.e2e.ts | 自动 | pat 10/10；e2e 64 |
| M2-7 | effectiveOrgRoles/listMembers 查询计数与层数/人数无关（定数上界） | routes/v1/org/__tests__/s8-query-count.test.ts（:145 ≤3、listMembers 恒4、500人恒等） | 自动 | 2/2（与 ac-m2-1 同跑 9/9） |
| M2-8 | 500成员通讯录三接口性能 | s8-members-perf.test.ts（3） | 自动 | 3/3（**仅 console 留证，无阈值断言**，见 §5 疑点 C-1） |
| M2-9 | GX_ENTERPRISE_ORG=off：v1 全 404、邀请公开路由不挂 | routes/v1/__tests__/enterprise-flag-off.test.ts（3，org+nav 双 off） | 自动 | 13 文件 92 |
| 辅 | 迁移/部门树/成员/角色/升级演练 | enterprise-migration(9)、deptTree(10)、members(10)、departments(11)、roles-admin(7)、s8-upgrade-drill(2)、**last-owner-bypass（新，两旁路 409 回滚）** | 自动 | 同批 92 |

### A.2 M3 导航（6 条全自动 + 4 条自动含手测；无 ac-m3-1.nav.test.ts 后端文件）

| AC | 断言 | 真实文件:用例 | 方式 | 实跑 |
|---|---|---|---|---|
| M3-1 | 同表挂3容器，快捷项拖拽/删除不改权威归属与权限 | web features/workspace/lib/ac-m3-1.test.ts（17，#1 菜单 diff 仅 insert、ops 不含 newParentId）；后端 routes/v1/__tests__/menu-write.test.ts（:88 同节点两处引用、reorder/delete） | 自动+**缺1条后端直断（C-2）** | web 128 批；后端 152 |
| M3-2 | 仅"移动到分组"改 parentId，未确认 409 MOVE_NEEDS_CONFIRM 带 impact，确认后子树 path 重写 | routes/v1/__tests__/groups-move.test.ts（:129 409、:144 确认 path 重写、:168 环/实体父 400，12 例）；web ac-m3-1 #5 extractMoveImpact | 自动 | 152；128 |
| M3-3 | 软删隐藏/reconcile 0差/恢复还原；视图物理删有引用 409 NAV_NODE_IN_USE | domain/nav/__tests__/nav-sync-views.test.ts（:141 409 NAV_NODE_IN_USE、双向回滚强证，14）、nav-sync-tables(12)、reconcile-drill(6)、prune(10) | 自动 | 152 |
| M3-4 | doc move 后 nav 子树与 KbTree 双视图一致 | nav-sync-kb.test.ts(12)、nav-sync-kb-docs.test.ts(13) | 自动 | 152 |
| M3-5 | 画布新壳手势/右键/参考卡 | apps/web/e2e/canvas-mcp-golden.spec.ts（Playwright，MCP写→真实浏览器加载/编辑/往返，chromium+webkit）；RC-13~25 逐项手测 | 自动(Playwright，需 dev-up)+手测 | 见 §4 |
| M3-6 | flag off 回退旧两壳 | enterprise-flag-off.test.ts（后端 tree/menu 404，3）；**前端无 flag 组件测试（C-3）**，视觉回退手测 | 自动+手测 | 92 |
| M3-7 | 旧匿名分享 /s/:token 新壳外不受影响 | routes/__tests__/public.test.ts（13，闭包行为冻结）；n5-new-shell-links 不委托断言 | 自动 | 47；web 128 |
| M3-8 | 非 manage_menu 改菜单 403；M3 期菜单零剪枝 | menu-write.test.ts:66（viewer 403）；manage-menu-action.test.ts（5）；workspace-nav-read.test.ts:274（无关系用户 state 逐字段=零剪枝） | 自动 | 152 |
| M3-9 | N5 旧链矩阵：旧 URL 生成点新壳可达、步数 ≤旧+1 | web lib/__tests__/n5-new-shell-links.test.ts（13 it 块）、nav-urls.test.ts(10)、nav-links.test.ts(9)；真机点击（搜索三类/关联卡/内链/库切换器）手测 | 自动+手测 | web 128/278 |
| M3-10 | 回填 A/B/C 0 差、重跑幂等；openapi 冻结对拍 | nav-backfill-s2(6)、nav-migration-s1(11)、reconcile-drill(6)、scripts/nav reconcile-cli(2)+reconcile-dist(2)；docs/openapi-contract(19)+s8-openapi-shapes(12)+s9-dto-cross(8) | 自动 | 152/155/4 |

补充：nav 同步 18 写点=nav-sync-{primitives9,tables12,views14,bases9,records6,kb12,kb-docs13}；
特征三件 entity-lifecycle-current(10)/membership-list-current(6)/rbac-current(7)；
部署接线产物测试 scripts/nav/__tests__/reconcile-dist.test.ts（exit64/首跑 pathsRebuilt/二次 no changes，40ae7c3）。

### A.3 M4 权限（10/10 自动；规模门本轮显式真跑）

| AC | 断言 | 真实文件:用例 | 方式 | 实跑 |
|---|---|---|---|---|
| M4-1 | 三源并集/逐一切断/来源链/viaAncestor/O8 effective 列 | domain/authz/__tests__/s10-ac-sources.test.ts（6）、decision-matrix(11)、routes/v1/s9-identity-snapshots(9) | 自动 | 97；164 |
| M4-2 | 调岗后下次请求即时变化（无 policyVersion 等待） | s10-ac-sources；routes/v1 m5-ac-m5-3.cloud:148 联调 | 自动 | 97；85 |
| M4-3 | 中断继承：未确认409+状态不变；确认 restricted+审计；多部门去重失访=1；createdBy/owner豁免；孙节点边界；重开对称 | s7-inheritance.test.ts（14）、s10-ac-cutoff-grandchild(3)、s7-move-impact(3)、cutoff(9) | 自动 | 97/164 |
| M4-4 | hidden 字段六通道一致缺席；写键 403 FORBIDDEN_FIELD 行不变；只读键 403 | s6-mask-exits(8)、s6-a4-special(9)、s6-mask-sanitize(9)、field-mask(7) | 自动 | 97/164 |
| M4-5 | M1 flags 四组合下掩码一致 | s6-a4-special 专项 4 例 | 自动 | 97 |
| M4-6 | 越权直调矩阵：无关系者/ viewer写/停用旧JWT；on态菜单 | s10-ac-authz-matrix.test.ts（8 it 块/it.each 展18例） | 自动 | 97 |
| M4-7 | v0.1.0 风格库升级 20主体×20节点新旧判定全同 | s10-ac-upgrade-20x20.test.ts（2，LCG seed42 400格）；backfill-reconcile(8)；s11-kb-single-row-equiv(6) | 自动 | 97/164 |
| M4-8 | 11 写点投影双写共生死（双向故障注入整体回滚） | s5-dual-write(11)、s5-purge(3)、s5-toggle-roundtrip(2)、routes/v1/policies-api(14) | 自动 | 97/164 |
| M4-9 | shadow 翻转：off→shadow 双零；on 后反向 shadow；回 off 恢复 | shadow(13)、shadow-integration(5)、shadow-kb-escalation(7)、s10-flip-drill(5)、scope-parity(8) | 自动（一迭代时间窗 DRIFT 留证门时补） | 164/97 |
| M4-10 | 500用户/万节点 decide/scope P95+定数 SQL+EXPLAIN 无 SCAN | **GX_M4_GATE=1 真跑** scope-scale(5)+s10-scale-gate(5)：scope/decide 12000 次 0 差异、P95 上界断言通过 | 自动（门控 skip，需显式开） | **10/10** |
| S0 | 旧三表决策 golden | characterization/legacy-decision-matrix(13 块,9 it.each)+legacy-response-shapes(3) | 自动 | 45 |

### A.4 M5 检索（8 自动 + M5-8 真机已跑未达线）

| AC | 断言 | 真实文件:用例 | 方式 | 实跑 |
|---|---|---|---|---|
| M5-1 | vec缺失/cloud连败/search.db损坏/worker故障→降级 fts/like，主应用读写不受损 | routes/v1 m5-s12-corrupt.off(8，魔数/截断/连损自愈+主写不受影响)、degrade.badvec(2)、degrade.cloud(5)、degrade-audit(2)、domain searchCorruption(8)、searchRecovery(8)、vecLoader(16)、emergencyLike(5)、query-ac-degrade-decide(8)、degradeAudit(7)、indexer-claim(5,stalled回收)/indexerSchedule(4) | 自动（"真实 kill 进程"未模拟，域级锁回收覆盖，建议手测登记 C-4） | 85/173 |
| M5-2 | reindex 幂等：连跑等价、409防重、双库 rename 无空窗 | reindex-swap(5)；m5-s12-reindex（inflight 读旧库200） | 自动 | 173/85 |
| M5-3 | 独特语句三态零命中；召回全 JOIN temp_scope；二次 decide 失配=0 | domain/search/query-ac-m5-2.test.ts（12）；query-s11-gate(11，EXPLAIN 白名单) | 自动 | 85/173 |
| M5-4 | 隐藏字段纯命中行可见但 snippet 中性；表级不可见整体缺席 | query-ac-m5-2；query-hydrate-primarymask；fieldGrant 纯函数 | 自动 | 173 |
| M5-5 | 调岗/收权/继承中断/move 下次搜索即变 | routes/v1 m5-ac-m5-3.cloud(7)+.off(5)：移除授予三mode零召回、breakInheritance、move进组、部门调入调出、停用401、白名单密文零泄漏 | 自动 | 85 |
| M5-6 | outbox 同事务共生死；覆盖度 A-E=0 可复跑 | outbox(7)、outbox-wiring(11，含级联/ANON/触发器)；check-coverage(7)+scripts/search/check-coverage.ts | 自动 | 173/85 |
| M5-7 | key 零泄漏/轮换/JWT_SECRET 变更回落/off 默认零外网 | embedding/cloud(12)、embeddingConfig(17)、off(4)、m5-s12-zero-egress(3，fetch 计数+409确认)、adminEmbedding、m5-admin-audit(1) | 自动 | 173/85 |
| M5-8 | Tier-L 10万 chunk P95<500ms 十轮 | docs/baseline/2026-09-17-m5-gate-tierL.md：x86 单真机 100k p95≈14.6s、流畅上限≈6476 chunk，arm64 未做 → **门未达线，按 B-5 降级发布**（embedding 默认 off） | 真机（外部依赖，已有结论） | 不适用 |
| M5-9 | 旧 /api/search 字节零 diff；MCP record.search 薄封装 | routes/__tests__/m5-search-golden.test.ts（5+snapshot）；mcp tools m6-p0a-search-scope（10）+m6-s4-read-tools(9) | 自动 | 173/208 |
| 辅 | gate 404/admin 六端点/主写 P95 | m5-search-gate(12)、m5-admin-search(13)、query-v1-route(6)；outbox-wiring:274-289 主写 P95 **toBeLessThan(150) 阈值断言** | 自动 | 85/173 |

### A.5 M6 MCP（6 全自动 + 3 自动含手测；9/9 有自动归属）

| AC | 断言 | 真实文件:用例 | 方式 | 实跑 |
|---|---|---|---|---|
| M6-1 | 只读PAT list 无写工具；直调被裁工具 UNKNOWN_TOOL 与不存在工具逐字节同文案 | mcp/tools/__tests__/registry-gate(5)、transport/m6-s3-gate(9)；e2e/m6-s8-ac12（:73/:91 http+stdio 同文案） | 自动 | 208；e2e 64 |
| M6-2 | 字段受限 PAT schema/返回裁剪+参数二次拦截+IDOR 四族；**P0-A 跨族**、**P1-B fail-closed** | m6-s4-read-tools(9)、m6-s4-write-tools(15)、permissions/m4Adapter(8)、**tools/m6-p0a-search-scope(10)**、**tools/m6-p1b-write-mask(7)**；e2e/m6-s8-idor(9) | 自动 | 208；64 |
| M6-3a | doc 块写入 Web 结构完整；409 currentVersion；无 confirm 拒；op=101/101KB 拒 | transport/m6-s5-doc-tools(28，VERSION_CONFLICT/confirm=false拒/原子批删/FORBIDDEN_RESOURCE)；web features/kb/__tests__/blocks-roundtrip-golden(6，import @gx/blocks)；Web 打开人工 | 自动+手测 | 208；278 |
| M6-3b | 画布最小写+六拒+UNSUPPORTED_OPERATION+Web 真实打开可编辑 | transport/m6-s6b-commit-elements(15)、m6-s6-canvas-read(11)；packages/canvas validate.test.ts（33）；web/e2e/canvas-mcp-golden Playwright 1 spec | 自动+Playwright+手测 | 208/33/§4 |
| M6-4 | 吊销（含停用连带）下次调用即拒；HTTP+stdio；审计四事件脱敏；requestId 重启窗口幂等 | m6-s7-audit-idempotency(12，:339 30s预算)；e2e/m6-s8-ac34(10)、m6-s8-401(:113 审计无token)；m6-s6-stdio(4)；patService/tokens | 自动 | 208；64 |
| M6-5 | 三客户端（curl/SDK/Inspector）+stdio 真连通；根/子路径/unix socket | e2e/m6-s8-clients（**16 tests，Inspector 0.16.6 本机真出网跑通**）；docs/baseline/m6-connectivity.md | 自动（Inspector CI 出网策略待定）+真机留证 | **16/16** |
| M6-6 | 11MB 仅 /mcp（/api 1MB 仍 413）；限流 429+Retry-After；30s TIMEOUT 不挂连接 | __tests__/m6-s0-characterization(8，:170 /api 413 golden)；e2e/m6-s8-limits(3，真服务 2MB/413/429/超时复用)；m6-s2-mcp-rate-limit(3) | 自动 | 208；64 |
| M6-7 | 401 五(六)态文案；WWW-Authenticate/-32001；PAT 明文仅一次 | e2e/m6-s8-401(10)、pat/tokens(14)、patService(10)、routes/v1/m6-s1-pats(7) | 自动（门时全产物 grep 明文） | 64；208 |
| M6-8 | ORG=off：/mcp 与 /api/v1/pats 404；stdio 不随 API 起服务 | m6-s2-mcp-app:189（/mcp 404）、enterprise-flag-off；stdio 分发为部署物核查（m6-exit §5） | 自动+部署核查 | 208；92 |
| M6-9 | zod4 不越 mcp/；旧路由对外行为零 diff | mcp/transport/zod4-isolation(4)；m6-s0-characterization(8) | 自动 | 208 |

### A.6 横切（§2.6）——实跑坐绿

- M0 基座：healthz(1)、ops/readiness+readiness-wal+backup+serveWeb(14)、middleware securityHeaders(4，含 bodyLimit)+rateLimit(8)、
  config/deploy-config/version（合计基座批 10 文件 64 passed）。
- 旧 /api golden：domain characterization 5 件、org characterization auth-current(10)/resource-rbac-current(5)/public-share(5)、
  m5-search-golden+snapshot、m6-s0-characterization、search-bounds(2，2000 上限)、records-keyset(7)、
  keyset-flags(8) —— 9 文件 111 passed。
- RC-38 全量质量门：`scripts/ci-quality.sh`（脚本在库，门时由 team-lead 独占机跑全量）。

---

## B. 门④ RC-01~RC-40 + G/H 组 RC-41~55 + 新增对抗组

### B.1 RC-01~RC-40（20 条有自动化 / 20 条手册标注手测）

| RC | 主题 | 真实文件:用例 | 实跑/签字位 |
|---|---|---|---|
| RC-01 | 日期 gt/lt 筛选 | shared-types filter-date-multiselect.test.ts | 56 套 ✅ |
| RC-02 | 多选按选项 id | shared-types filter-match-field.test.ts；FilterPanel 真机 | 自动+UI 手测 |
| RC-03 | Calendar 纯日期不跨时区 | 无 CalendarView 自动化 | **手测签字** |
| RC-04 | CSV 公式注入 | domain/__tests__/csvExport.test.ts（3） | 47 批 ✅ |
| RC-05 | IME/Esc/blur 不重复提交 | 无 CellEditor 测试 | **手测签字** |
| RC-06 | checkbox 连点去重 | 无 CheckboxEditor 测试 | **手测签字** |
| RC-07 | KB 乐观锁 409 | m6-s0-characterization（kb PUT 409+currentVersion）；m6-s5-doc-tools:232 | 208 ✅ |
| RC-08 | WAL/busy_timeout | ops/readiness-wal(2)+配置只读核查 | 64 批 ✅ |
| RC-09 | CSV 导入行级事务 | **routes/__tests__/rc09-csv-row-tx.test.ts（506848f 新增）** | 47 批 ✅ |
| RC-10 | 建表/删表/建链事务 | **domain/__tests__/field-structure-tx.test.ts（506848f，失败注入整体回滚）** | 47 批 ✅ |
| RC-11 | bt 多目标 400 | **domain/__tests__/rc11-bt-cardinality.test.ts（506848f）** | 47 批 ✅ |
| RC-12 | 软删/级联清理 | **routes/__tests__/rc12-soft-hard-delete.test.ts（506848f）** | 47 批 ✅ |
| RC-13~25 | 画布 13 项 | RC-25 方向部分由 canvas-mcp-golden Playwright 覆盖（MCP写→加载）；其余 12 项无独立自动化 | **逐项手测签字**（见 §4） |
| RC-26 | URL 白名单 + align 往返 | align：blocks-roundtrip-golden:73 + m6-s5:258 ✅；**isSafeUrl（web lib/sanitize-html.ts）无 spec** | 半自动，缺口 C-5 |
| RC-27 | 附件/内容上限 | **全仓唯一上传端点 POST /me/avatar，无通用附件通道**；公开写 2MB 无对应用例 | 产品限制登记 + 手测（C-6） |
| RC-28 | DATEADD/默认墙钟 | formula-functions(86)/formula(43)/formula-output-type(9) | 公式批 181 ✅ |
| RC-29 | 必填校验/draft | routes/__tests__/required-create.test.ts（10） | 47 批 ✅ |
| RC-30 | 公开分享闭包 | routes/__tests__/public.test.ts（13，深3/越界403/环/404） | 47 批 ✅ |
| RC-31 | 点引用统一（cross-formula 20） | domain/__tests__/cross-formula.test.ts | 181 ✅ |
| RC-32 | 聚合多子记录 | formula.test.ts（43）等 | 181 ✅ |
| RC-33 | 嵌套 hydrate/环置 null | hydrate(21)、record-single-hydrate、hydrate-ring-characterization | 181 ✅ |
| RC-34 | 运算边界 null/除零/CONCAT | formula/formula-functions | 181 ✅ |
| RC-35 | 默认值反向重算 affectedParents | **routes/__tests__/rc35-reverse-defaults.test.ts（506848f 新增）** | 47 批 ✅ |
| RC-36 | 默认值公式弹窗选子表 | UI 无自动化 | **手测签字** |
| RC-37 | FIRST/LAST 吃 list | formula-functions（86） | 181 ✅ |
| RC-38 | 全量质量门 | scripts/ci-quality.sh | 门时 team-lead 独占机跑 |
| RC-39 | 换机冷启动 | 手册；deploy 冒烟部分覆盖 | **手测签字** |
| RC-40 | @plait 补丁重放 | patches/@plait__draw@0.89.2.patch 在库 | **手册+手测签字** |

### B.2 RC-41~RC-55（G 组导航 / H 组权限，全部有自动化）

| RC | 文件:用例 | 实跑 |
|---|---|---|
| RC-41 N5 旧链 | n5-new-shell-links(13)、nav-urls(10)、nav-links(9)（真机点击另签字） | web 278 ✅ |
| RC-42 多处挂载不改归属 | web ac-m3-1 #1（17）；menu-write:88 | 128/152 ✅ |
| RC-43 三态可见性 | web ac-m3-1 #2/#3 | 128 ✅ |
| RC-44 二级三分区迁移 | web ac-m3-1 #4；collection(14) | 128 ✅ |
| RC-45 move-impact 409 | web ac-m3-1 #5；groups-move:129（真机弹窗另签字） | 128/152 ✅ |
| RC-46 大菜单 DOM 有界 | nav-window(11，挂载行≤49)、nav-dom-bounds(2)（真机滚动另签字） | web 278 ✅ |
| RC-47 旧决策 golden | legacy-decision-matrix(13块)+legacy-response-shapes(3) | 45 ✅ |
| RC-48 shadow 双零/fail-open/off 零接入 | shadow(13)+shadow-integration(5)+shadow-kb-escalation(7) | 164 ✅ |
| RC-49 回填幂等+20×20 | backfill-reconcile(8)+s10-ac-upgrade-20x20(2) | 164/97 ✅ |
| RC-50 11 写点双写共生死 | s5-dual-write(11)+s5-purge(3)+policies-api(14) | 97/164 ✅ |
| RC-51 fieldMask 六通道 | s6-mask-exits(8)+s6-a4-special(9)+s6-mask-sanitize(9) | 97 ✅ |
| RC-52 继承 EARS+孙节点 | s7-inheritance(14)+cutoff-grandchild(3)+s7-move-impact(3) | 97 ✅ |
| RC-53 三源即时+越权矩阵+停用401 | s10-ac-sources(6)+s10-ac-authz-matrix(8块18例)+auth-state(8) | 97 ✅ |
| RC-54 规模门定数 SQL/EXPLAIN/P95 | scope-scale+s10-scale-gate（GX_M4_GATE=1） | **10/10 真跑** |
| RC-55 三态翻转+四组合 | s5-toggle-roundtrip(2)+s10-flip-drill(5)+s7-prune(11)+s6-a4-special(9) | 97/164 ✅ |

### B.3 §5.2 里程碑新增对抗组（门时必须全在仓且绿）——均已在仓并实跑

- M2：ac-m2-1(7)/s8-query-count(2)/s8-members-perf(3)/s8-upgrade-drill(2)/lifecycle(8)/deptTree(10)/members(10)/
  roles-admin(7)/departments(11)/auth-state(8)/authStateCache(6)/enterprise-migration(9)/enterprise-flag-off(3)/
  last-owner-bypass（新）/三 org characterization。
- M3：nav-sync 七件/backfill-s2/migration-s1/reconcile-drill/prune/menu-write/groups-move/workspace-nav-read/
  manage-menu-action/manage-share-action/scripts nav 2 件/openapi 3 件/web 9 件。
- M4：s5/s6/s7/s10/s11 全系列 + shadow/scope/backfill/characterization。
- M5：s12 六件/query-ac-m5-2/query-ac-degrade-decide/m5-ac-m5-3 两形态/admin 两件/check-coverage/reindex-swap/
  outbox 两件/embedding 三件/gate/golden。
- M6：S0-S7 单测 20 件（含 p0a/p1b）+ e2e 6 件 + canvas 包 + web blocks golden + Playwright 1 spec。
- M7 新增：scripts/acceptance/（0d0692b 门②脚本已入仓）；reconcile-dist 产物测试；rc09/10/11/12/35 补测（506848f）。

---

## C. 真缺口（无任何自动化归属 / 断言强度不足）——只报告，不在此修

| # | 项 | 现状 | 建议最小补测（文件:层） |
|---|---|---|---|
| C-1 | M2-8 s8-members-perf 无阈值断言 | median/p95 仅 console.log（:100-104），功能 200/total 有断言；性能回归无法机械判 | 同文件加门控阈值（如 GX_PERF_GATE 下 p95<150ms），避免抖动 CI |
| C-2 | M3-1 后端"快捷项拖拽/删不改 nav_nodes 权威 parentId"无 API 级直断 | menu-write:125 断言的是**菜单项** parentId；实体 parentId 不变仅由 nav-sync 同步原语间接覆盖 | routes/v1/__tests__/menu-write.test.ts 增 1 例：两容器挂同表→reorder/delete 其一后 GET tree 断言表节点 parentId 未变、GET table 200（真 app HTTP） |
| C-3 | M3-6 前端 flag off 回退旧壳无组件测试 | 后端 404 有（enterprise-flag-off）；web 无 GX_ENTERPRISE_NAV 探测/回退 spec | apps/web 新壳壳组件增 1 个 flag-off 回退测试（jsdom），或正式登记为视觉手测项 |
| C-4 | M5-1 "worker 进程被 kill" 只域级模拟 | indexer-claim stalled 回收(5)/schedule(4) 有；无真实杀进程 | 登记 runbook 手测（kill -9 worker 后降级与追平），不建议造进程测试 |
| C-5 | RC-26 isSafeUrl 无 spec | web lib/sanitize-html.ts 有实现零测试（javascript:/data: 降级） | apps/web 同目录增 sanitize-html.test.ts 纯函数 1 文件（最便宜） |
| C-6 | RC-27 附件限额无对应产品面 | 全仓唯一上传 POST /me/avatar；无通用附件/公开写 2MB 通道 | 先产品确认附件通道是否在本期范围；若不在，RELEASE 已知限制登记，不硬编测试 |
| C-7 | M3 10 万节点门（SPEC:134 首屏<1s）无门证据 | 手册 §6.1 引 docs/baseline/2026-09-16-m3-gate.md **不存在**；reconcile-scale 仅 1k/1w 且不断言阈值（task#158 pending） | task#158 N+1 批量化落地后补门控规模测试 + 产 m3-gate.md；或 M7 报告按限定值写法登记 |
| C-8 | RC-03/05/06/36 前端 UI 行为零自动化 | CalendarView/CellEditor/CheckboxEditor/DefaultValueEditor 无测试 | 本期可接受为手测项（RC 文档自标【UI】）；若要补，Component 测试成本高，建议保留手测签字 |
| C-9 | Inspector 入 CI | m6-s8-clients Inspector 本机真跑通（出网），CI 出网策略未裁决 | 门时 CI 允许出网则纳入；否则按 m6-exit §9-2 基线留证 |

**已被补掉的前序缺口**：RC-09/10/11/12/35 由 506848f+3cf3271 补齐并实跑绿；M2 最后 owner 两旁路由
last-owner-bypass.test.ts 覆盖（含在 92 passed 批）；P0-A（ab5b956）/P1-B（277fd95+63020ea 回归修复）
均在常规门无 skip 实跑绿。

### C.0 team-lead 裁决与处置（2026-09-18，main 85da169 之后）

| # | 处置 | 落地 commit / 位置 | 独立复验实数 |
|---|---|---|---|
| C-1 | **补码关闭**：s8-members-perf 增 GX_PERF_GATE 门控硬阈值（默认 skip，门控开 warm p95<150ms） | `528ecee` | 默认 3 passed/1 skipped；GX_PERF_GATE=1 4 passed，三接口 warmP95 2.22/0.67/0.44ms |
| C-2 | **补码关闭**：menu-write 增 1 例真断言"快捷项 reorder+delete 后权威 navNode.parentId 零变化 + GET /api/tables/:id 200 + reconcile 0 差" | `528ecee` | menu-write 12 passed（含真 HTTP GET 200 日志） |
| C-5 | **补码关闭**：isSafeUrlAttr URL 白名单纯函数 36 数据点对抗单测（无 jsdom、零新依赖）；DOM 标签剥离 sanitizeHtml 归手测 | 单测 `55f5213`；顺带删不可达 data 死代码 `e6d493e`（行为等价，fail-closed 不变） | web 36 passed、web tsc 0 |
| C-3 | **登记为手测，不补 jsdom**：项目禁新依赖（无 jsdom/happy-dom），"nav off 回退旧两壳视觉一致"本质是浏览器视觉项，强造 jsdom 组件测试反而给假信心。后端 404 已由 enterprise-flag-off 自动锁 | 进 §D 手测签字（M3-6）；门⑧报告如实写 | — |
| C-4 | **登记 runbook 手测**：真 `kill -9 worker` 是进程/环境项，域级 stalled 回收(indexer-claim 5 + schedule 4)已锁核心逻辑，不造脆弱进程测试 | 进 §D + 写进 m5 runbook 手测步 | — |
| C-6 | **产品限制登记，不硬编测试**：全仓唯一上传端点 POST /me/avatar（限图片 5MB），本期无通用附件/公开写 2MB 通道。RC-27 按已知产品限制写进 RELEASE 说明；若产品后续要附件通道，RC-27 随该通道补 | 进门⑧"已知不做项/限制" | — |
| C-7 | **按限定值登记，不伪造门证据**：SPEC:134「500 成员/10 万节点首屏<1s」缺门证据文档，reconcile-scale 仅 1k/1w 不断言阈值（task#158）。M7 不编造 m3-gate.md：报告把导航首屏标为「限定值待真机门」，对外承诺以目标机复测为准；task#158 转 M7 后 backlog | 门⑧报告限定值栏 + task#158 | — |
| C-8 | **保留手测**：RC-03/05/06/36 为 RC 文档自标【UI】交互（Calendar 时区/IME blur/checkbox 连点/默认值弹窗），组件测试成本高、价值低，本期人工签字 | §D 第 1 项 | — |
| C-9 | **CI 策略门时定**：Inspector 本机真出网已 16/16 通；是否入 CI 取决于门时出网策略，按 m6-exit §9-2 基线留证，不算产品缺口 | docs/baseline/m6-connectivity.md | — |

**门④结论（team-lead）**：RC-01~40 中 20 条有自动化（含本轮 C-1/C-2 加固），RC-41~55 全自动化；
RC-13~25 画布 13 项 + RC-03/05/06/36/39/40 为计划内手测/手册，C-3/C-4/C-6/C-7/C-8/C-9 已按上表处置，
无"该有自动化而缺失"的悬留硬缺口（C-7 是真机/容量门，归门⑤/外部依赖，不补编）。

## D. 待人工 / 真机 / 外部签字项（不算自动绿，门时需带日期+执行人）

1. RC-03（改时区 Calendar）、RC-05（IME/Esc/blur）、RC-06（checkbox 连点）、RC-36（默认值弹窗）。
2. RC-13~RC-25 画布 13 项（只读兜底/嵌入画布/root 泄漏/fit/样式条/脏确认/setState/FO 合帧/z-token/
   脑图右键/WebKit 负 viewBox/右键清选区/3×2 网格）——改动 Plait/Drawnix/选区/z 序时必跑。
3. RC-39 换机冷启动；RC-40 @plait 补丁重放 + rm .vite。
4. RC-41 真机点击矩阵（搜索三类结果/关联卡/内链/分享接受/面包屑/库切换器）；RC-45 真机 move-impact 弹窗；
   RC-46 1000+菜单真机滚动 DOM；M3-5 新壳画布手势；M3-6 旧两壳视觉回退。
5. RC-27 附件/内容上限真机（待产品面确认，C-6）。
6. M5-8 Tier-L：x86 画像已有（未达 500ms 线），**arm64 真机未做**；降级姿态 GX_EMBEDDING_MODE=off 需总监签字。
7. M6-3a/3b Web 端 doc/画布真实打开目检；M6-5 stdio 客户端 + 三形态真机留证；M6-8 stdio 不随 API 起的部署物核查。
8. M7 门③ R1~R9 回滚计时、门⑥三环境（裸机/fpk/Docker/macOS）冒烟矩阵、门②五类对象人工目检。
9. Playwright canvas-mcp-golden.spec.ts：需 `scripts/dev-up.sh` 起 :3001+:5173 后 `pnpm --filter @gx/web test:e2e`
   （chromium+webkit），本轮未起长服务，门时执行并贴报告。
10. PAT 明文全产物 grep、审计脱敏目检；ci-quality.sh 独占机全量实数回填。

## E. 备注：与早期 grep 台账的差异修正

- m5 主写 P95 **有** toBeLessThan(150) 阈值（outbox-wiring:289），M4 规模门**有**上界断言并已真跑——
  早期"只 console 留档"的疑点仅余 M2-8（C-1）与 M3 规模门（C-7）。
- e2e 实测 64 tests（clients 件 16 例，非早期 grep it 块的 40）。
- RC 文档若干用例数（n5 称20、legacy-matrix 称22、authz-matrix 称18、zod4 称3）与 it 块数差异源于
  it.each；门④报告一律采用门时 vitest 实数，本台账实数已按实跑填。
