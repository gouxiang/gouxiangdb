# M7 企业版总验收 — 发布门切片（验收/回归/升级/回滚/部署物/报告）

- 日期：2026-09-18
- 作者：架构师 高见远
- 状态：**待项目总监终审**（M3/M4/M5/M6 实施尚未开工，本文件是它们收口时唯一执行的总验收手册；文中所有数字分"已落地留证"与"门时必填"两类，不得用规划值冒充实测）
- 性质：**M7 不是功能切片，是验收/发布门**。没有 S0 式业务代码开发，只有按本手册逐条执行、留证、签字；任一门不过即"不通过"，按 §10 判据处理（降级发布或阻断发布），不得带病放行。
- 上游依据：SPEC-enterprise-v1.0 §2（M7 行，:27）、§9（AC-M2-1 `:118`、AC-M3-1 `:119`、AC-M4-1/2/3 `:120-122`、AC-M5-1/2 `:123-124`、AC-M6-1/2/3/4 `:125-128`、**AC-UPG-1 `:129`**）、§10（`:134` 成员 500/资源 10 万节点首屏 <1s、`:135` 单批与 MCP 30s）、§11（内嵌坑 `:138-150`）、§12（端到端验证步骤 `:152-182`）；M2~M6 五份实施切片（docs/planning/phase2/M{2,3,4,5,6}-implementation-plan.md）的出口 DoD 与 gate baseline；40 RC 回归集（docs/baseline/2026-09-12-regression-cases.md）；M1 门留证（docs/baseline/2026-09-13-m1-*）。
- 适用代码基线：`main` @ `45784f4`（M2-S8 收口；M3/M4/M5/M6 未开工）；根 package.json v0.1.0；git tag `v0.1.0` 与分支 `baseline/0.1` 存在（AC-UPG-1 直升起点）。
- 本阶段只产出规划文档，不改任何 .ts 源码；本文件入库 commit 见文末自报。

---

## 0. 结论先行

1. **M7 = 八道门，一门一证，无证不过**：①五主线端到端对抗回归（AC-M2~M6 逐条映射到测试位置）；②v0.1.0→M7 直升抽样零损坏（AC-UPG-1）；③全 flag 回滚演练（30 分钟内一键收回）；④RC-40 + 各里程碑新增对抗用例总台账全绿；⑤性能门证据汇总（区分开发机留档与 Tier-L 真机承诺）；⑥三环境部署物（飞牛 fpk / Docker / macOS）更新清单与冒烟；⑦发布 checklist；⑧总验收报告与签字。
2. **发布默认姿态在本文件锁死，发布时不得临场发明**（§4.1 矩阵为唯一真源）：组织/导航门默认 on；权限引擎代码默认 off、**生产建议 shadow**（是否随发布置 shadow 由项目总监在部署配置下令，ADR-0036）；**embedding 默认 off + FTS trigram 为默认发布姿态，cloud 语义检索是高配能力**——Tier-L 双真机门不过不阻塞 M7，但对外材料禁止出现"10 万 chunk P95<500ms"承诺（M5 B-5）；MCP 随 GX_ENTERPRISE_ORG 门控，off 即 /mcp 与 /api/v1/pats 404。
3. **升级零损坏是 P0 硬门不是抽样仪式**：AC-UPG-1 的五类对象（记录数/附件/正文/画布/旧分享链接）逐项有抽样口径、命令、判定阈值（§3），从 tag v0.1.0 的真实旧库一路 `migrate deploy` 到 M7 终态迁移（现 14 个，预计约 24 个，以落地为准），任何一类出现损坏即不通过。
4. **回滚是肌肉记忆不是文档想象**：每面旗一次真实 off 演练并计时，硬指标 = 从做出回滚决定到旧行为恢复服务 **≤30 分钟**（SPEC:60 铁律）；代码回滚走 deploy.sh/rollback.sh 既有原子切换（deploy.md §8），数据回滚走发布前在线快照（主路径），down SQL 仅辅助。
5. **M1 读路径翻门遗留必须在 M7 前结清姿态**：keyset/sidecar 读生产默认（task #103/#106/#107/#110 在途）要么带 shadow 双零证据翻 on，要么明确以 off 姿态发布并在报告中写清；不允许"默认值是什么没人说得清"地进入总验收。
6. **测试数字门时实跑回填**：当前实测 api 64 文件 724 passed / 3 skipped（45784f4，M2-S8 留证）、web 3 文件（含在途 M2-FE）；M3~M6 计划新增数百条，M7 报告只认门时全仓一次 `NODE_ENV=test pnpm -w test` 的实数与 CI 留痕，不认各里程碑自报之和。
7. **本文件的执行产出**：`docs/baseline/2026-09-XX-m7-acceptance-report.md`（模板 §10）+ 三环境冒烟记录 + 升级/回滚演练记录 + 签字行。没有这份报告 = M7 未发生 = 不发布。

---

## 1. 现状证据与门时基线（行号已核对，2026-09-18 于 45784f4 实读）

### 1.1 代码/测试/迁移现状

| 事实 | 证据（已核对） |
|---|---|
| HEAD / tag | `45784f4`；tag `v0.1.0`（直升起点）；M2-S8 提交说明记录 api **64 文件 724 passed/3 skipped** |
| 测试文件分布（61 api + 3 web + 4 shared-types = 68，find 实查） | api 关键：routes/v1/org/__tests__/ 下 ac-m2-1.adversarial(7)/s8-query-count(2)/s8-members-perf(3)/s8-upgrade-drill(2)/lifecycle/members/roles-admin/departments；v1 enterprise-flag-off/auth-state；queryPlan 9 文件；characterization 5 文件；全量清单见 §5 台账 |
| 迁移目录 | **14 个**（20260904063648_init … 20260915090100_enterprise_org_backfill，`ls apps/api/prisma/migrations` 实查）；M3 +2（预期 16）、M4 +1~2（预期 17~18，见 M4 §5.1）、M5 主库 change_events/app_settings 两迁移（预期约 20；search.db 表不经 prisma 迁移）、M6 personal_access_tokens + mcp_idempotency 两迁移（预期约 22~24，**门时以 `ls` 实数为准，ci-quality.sh 第 8 步动态对账**） |
| 在途遗留（总验收前必须有姿态） | task #103 keyset/sidecar 读 shadow 集成等价、#106 三档双跑、#107 EXPLAIN/RSS/SQL 计数、#110 shadow-equivalence baseline 文档；#89 S5b  hydration 扇出（已后移·按规模触发，非发布阻断，报告中登记现状即可） |
| RC 回归集 | docs/baseline/2026-09-12-regression-cases.md，RC-01~RC-40，A 数据/B 并发/C 画布/D 健壮/E 公式/F 环境六组 |

### 1.2 全量 flag 清单（回滚矩阵的输入，门时与 config 实读对账）

| flag | 来源 | 代码默认 | 形态/取值 | 门控对象 |
|---|---|---|---|---|
| GX_ENTERPRISE_ORG | M2（config.ts:175/:229，`!== "off"`） | on | on/off | /api/v1 全挂载、邀请公开路由；**M6 起同管 /mcp 与 /api/v1/pats（C-5 定稿）** |
| GX_ENTERPRISE_NAV | M3（计划 S5） | on | on/off | v1 nav 路由 + 前端新外壳（探测 404 回退旧两壳） |
| GX_AUTHZ_ENGINE | M4（计划，仿 flags.ts 三态） | **off** | off/shadow/on | 旧 guards.ts/kb.ts 包壳、fieldMask 投影、tree/menu 剪枝；**M4 出口生产建议 shadow，翻 on 五前置 + 总监下令（ADR-0036）** |
| GX_M1_SIDECAR / GX_M1_SIDECAR_READ / GX_M1_KEYSET | M1（queryPlan/flags.ts:16-57） | write=on；read=**off**；keyset=**off** | on/off；off/shadow/on | sidecar 写维护、物理读计划器、keyset 分页 |
| GX_HYDRATE_PREFETCH(_BUDGET/_DEPTH) | M1（hydrateBatch） | 在库 | 数值 | 两阶段批量化 hydration |
| GX_EMBEDDING_MODE | M5（B-1 后两态） | **off** | off/cloud | 向量路；cloud 需四与门（配置齐+探活+dim 一致），失败回落 off |
| GX_SEARCH_WORKER | M5（B-7 唯一内嵌形态） | on | on/off | 内嵌索引 worker，仅排障关 |
| GX_MCP_BODY_LIMIT / GX_MCP_RATE_* / GX_MCP_TOKEN | M6（C-1） | 11MB；patId 120/60s、IP 300/60s、PAT REST 30/60s；TOKEN 无默认 | 数值/字符串 | /mcp body 豁免；两段式限流；stdio bin 启动凭据 |
| GX_VEC_EXT_PATH | M5（spike §5.3） | 空=按 triplet 拼 native/vec0 | 路径 | sqlite-vec 扩展加载；失败即 FTS+LIKE 降级 |

> 门时动作：在发布候选构建上 `strings`/grep 配置解析与 env.conf.example 逐行对账，**所有 flag 必须在 env.conf.example / docker env example 有注释段或显式记录"故意不入样例"**；未登记的环境变量视为发布阻断（配置可发现性）。

### 1.3 部署物现状

| 环境 | 入口（已核对） | 企业版要更新的点（详见 §7） |
|---|---|---|
| 裸机（Linux 主线） | deploy/bin/package-release.mjs（tar：api/dist+prisma、web/、node_modules 运行时白名单）、deploy.sh/rollback.sh（原子切换+发布前快照+30s readyz 轮询）、systemd 三单元、Caddyfile | MCP SDK 外置依赖、stdio bin、14+N 迁移、新 env、反代 11m |
| 飞牛 fpk | deploy/fnos/build-fpk.mjs（Linux 目标机 fail-fast 校验）、gouxiangdb/{manifest,cmd,app} | 同裸机 + native/<triplet>/vec0.so 0755/0644 + file 架构自检 + 网关 body 11m |
| Docker | deploy/docker/Dockerfile（node:22-bookworm-slim 双阶段、buildx 双架构、runner 侧 generate）、docker-entrypoint.sh、compose、env example | SDK、sqlite-vec 平台子包、vec_version 冒烟、11m 反代注释 |
| macOS | package-release.mjs 在 macOS arm64 构建已实跑（deploy.md:5）；better-sqlite3 带 darwin prebuilds（deploy.md:149）；apps/desktop Tauri 壳 | 同仓 tar 本机直跑冒烟；vec0 darwin 加载路径（GX_VEC_EXT_PATH）与缺扩展降级；**旧桌面端连新服务端的升级提示（SPEC:133）手测** |

---

## 2. 门①：五主线端到端对抗回归清单（AC → 测试位置 → 执行方式）

> 规则：每条 AC 必须有至少一个**自动化**位置；标注【手测】的是画布/浏览器类补充，不能替代自动化。门时在报告中逐条填"结果/证据 commit or 文件/执行人/日期"。文件路径中 M3~M6 部分为各切片计划定稿的预期路径，门时若落地路径不同，以实际路径回填并在报告说明，不允许出现"找不到对应用例"的 AC。

### 2.1 M2 组织（AC-M2-1：停用即时失效 + 调岗兼岗并集即时变化）

| # | 对抗断言 | 测试位置（现状/计划） | 方式 |
|---|---|---|---|
| M2-1 | 6 层部门、成员兼两部门，角色经祖先链命中，三路径来源完整 | routes/v1/org/__tests__/ac-m2-1.adversarial.test.ts（已落地，7 例，45784f4） | 自动 |
| M2-2 | 调岗（移出/移入部门）下次请求有效角色即时变化，无 sleep | 同上（例 4） | 自动 |
| M2-3 | owner 停用 U：旧 tv token 对 /api/auth/me 与 /api/v1/org/members 连续两次（iframe 刷新）均 401 且 code=UNAUTHORIZED | 同上（例 5/6）；auth-state.test.ts | 自动 |
| M2-4 | owner 自停用 400；含部门继承展开的唯一 owner 停用 409；两 owner 可停其一 | 同上（例 7）；lifecycle.test.ts | 自动 |
| M2-5 | 匿名 /api/public/s/:token 在停用无关成员后仍 200（公开外链口径不被误伤） | 同上（例 8）；characterization/public-share-current.test.ts | 自动 |
| M2-6 | **M6 联动**：停用用户同事务其全部 PAT revokedAt，下一 MCP 调用 401；重新激活不恢复 PAT（C-4） | M6 S1/S8（mcp pat lifecycle 用例，§5 台账 M6 段） | 自动（M6 交付后） |
| M2-7 | effectiveOrgRoles/listMembers 查询计数与层数/人数无关（定数上界） | s8-query-count.test.ts（2 例，已落地） | 自动 |
| M2-8 | 500 成员通讯录三接口并行留证（性能门 §6 汇总） | s8-members-perf.test.ts（3 例，已落地，median 3.27ms 等） | 自动 |
| M2-9 | flag off：GX_ENTERPRISE_ORG=off 时 v1 全 404、邀请公开路由不挂 | routes/v1/__tests__/enterprise-flag-off.test.ts（已落地） | 自动 |

### 2.2 M3 导航（AC-M3-1：快捷项拖拽/删除不改权威归属与权限；仅"移动到其他分组"改父级且弹影响预览）

| # | 对抗断言 | 测试位置（M3 计划定稿路径） | 方式 |
|---|---|---|---|
| M3-1 | 同一 table 挂 3 个容器，各容器快捷项拖拽排序/删除后 nav_nodes.parentId 与归属不变、GET table 200、权限矩阵不变 | routes/v1/__tests__/ac-m3-1.nav.test.ts（M3-S10，八条之 1） | 自动 |
| M3-2 | 仅"移动到其他分组"改 parentId，必经影响预览；未确认 409，确认后子树 path 重写正确（去重人数/内容数） | 同文件（八条之 2）；M3-S6 move-impact 用例 | 自动 |
| M3-3 | 软删表→快捷项隐藏、reconcile 0 差异、回收站恢复→引用自动还原；视图物理删遇引用 409 NAV_NODE_IN_USE | 同文件（之 3）；M3-S3 18 写点回滚证明 | 自动 |
| M3-4 | doc move 后 nav 子树与 KbTree 双视图一致 | 同文件（之 4） | 自动 |
| M3-5 | 画布 R10：新壳打开画布矩形/箭头/连线手势/右键菜单/参考卡跳转 | 同文件（之 5）+ RC-13~RC-25【手测/Playwright】 | 自动+手测 |
| M3-6 | flag off 全链路回退旧两壳，视觉/路径与 32f7bea 一致 | web 新壳 flag 测试（M3-S8/S10）；enterprise nav flag 后端 404 用例 | 自动+手测 |
| M3-7 | 旧匿名分享 /s/:token 在新壳外不受影响 | ac-m3-1.nav.test.ts（之 7） | 自动 |
| M3-8 | 非 manage_menu 改菜单 403；M3 期菜单不剪枝（零剪枝裁决，M4 翻转点注释在） | 同文件（之 8） | 自动 |
| M3-9 | N5 旧链矩阵：§1.3 全部旧 URL 生成点（32 文件级）在新壳可达且步数 ≤旧+1；正文内链/画布引用/匿名分享抽样 0 损坏 | M3-S10 N5 回归矩阵（手测/冒烟+可自动化的别名路由测试） | 混合 |
| M3-10 | 回填对账 0 差异（A 实体节点/B 默认菜单/C 异常三类），重跑幂等；openapi.yaml 首版冻结且形状对拍 | M3-S2/S4 用例；S7 openapi 对拍 | 自动 |

### 2.3 M4 权限（AC-M4-1 三源并集/来源链；AC-M4-2 中断继承二次确认+去重失访人数；AC-M4-3 字段六通道一致缺席）

| # | 对抗断言 | 测试位置（M4 计划定稿路径） | 方式 |
|---|---|---|---|
| M4-1 | 仅经部门获权，角色页移除其角色后仍按其余来源判定；三源逐一切断动作集与来源链正确；O8 effective 列全 role/dept/direct（含 viaAncestor） | domain/authz/__tests__/ac-m4-1.sources.test.ts（M4-S10 定名以落地为准） | 自动 |
| M4-2 | 调岗后下一次请求权限即时变化（无 policyVersion 等待） | 同文件；联 M2-2 | 自动 |
| M4-3 | 关继承：未确认 PATCH 409+impact 状态不变；确认→restricted+审计；失访人数多部门去重=1；createdBy/owner 豁免；孙节点边界两条；重开对称含"恢复人数" | ac-m4-2.inheritance.test.ts（M4-S7/S10） | 自动 |
| M4-4 | hidden 字段六通道（列表/详情/导出/直调 GET/关联 LinkRef/公式引用）无该列与原值；写该字段键 403 FORBIDDEN_FIELD 且行不变；带只读键 403 | ac-m4-3.fieldmask.test.ts（M4-S6/S10） | 自动 |
| M4-5 | M1 flags 四组合（sidecar read off/on × keyset off/on）下字段掩码行为一致 | 同文件矩阵 | 自动 |
| M4-6 | 越权直调：无关系用户 /api 与 v1 端点 403/404；viewer 直调写端点 403；停用用户持旧 JWT 全端点 401；on 态菜单无权项剔除、URL 直访行为 | M4-S10 越权矩阵；联 M2-3 | 自动 |
| M4-7 | v0.1.0 风格库升级后随机 20 主体×20 节点新旧判定全同；旧分享 /s/* 可开 | M4-S2/S10 回填对拍 | 自动 |
| M4-8 | 11（计划口径）旧表写点投影双写共生死：注入策略写失败→成员写整体回滚；可映射档双向同步；不可映射授权旧表不动且有提示 | M4-S5 真库双向证明，S10 抽全复跑 | 自动 |
| M4-9 | shadow 翻转演练：off→shadow 旧测试全绿；连续一迭代 DRIFT_OVERALLOW=0 且 DRIFT_OVERDENY=0；on 后反向 shadow 一迭代；回 off 旧行为恢复 | M4-S3/S10 + drift 计数证据（报告中必须有时间窗证据，不能只有测试夹具） | 自动+留证 |
| M4-10 | 500 用户/万节点 decide/scope P95 与定数 SQL 计数 | M4-S10 规模门 → docs/baseline/2026-09-17-m4-gate.md | 自动 |

### 2.4 M5 检索（AC-M5-1 崩溃降级 FTS-only 主应用不受影响 + reindex 幂等；AC-M5-2 召回前剔除零泄漏 + 不索引字段物理缺席）

| # | 对抗断言 | 测试位置（M5 计划定稿路径） | 方式 |
|---|---|---|---|
| M5-1 | vec 扩展缺失/加载失败、cloud 连续失败、search.db 损坏、worker 被 kill：五类故障自动降级 fts/like，主应用读写与编辑链路不受影响（有时延证据） | domain/search/__tests__/ac-m5-1.degrade.test.ts（M5-S9） | 自动 |
| M5-2 | reindex 幂等：连跑两次等价、409 防重、双库 rename 切换无空窗 | M5-S9/S11 | 自动 |
| M5-3 | "独特语句"对抗：无权内容在 hybrid/fts/like 三态下零命中；召回 SQL 全部 JOIN temp_scope（EXPLAIN 白名单留证）；二次 decide 失配计数 0 | ac-m5-2.leak.test.ts（M5-S6） | 自动 |
| M5-4 | 隐藏字段纯命中：行可出现（持表 r）但 snippet 中性占位、无字段原文；表级不可见整体缺席（B-3） | 同文件 | 自动 |
| M5-5 | 调岗/收权/继承中断/move 后下次搜索即变，无 reindex/缓存等待 | M5-S8 | 自动 |
| M5-6 | outbox 同事务共生死（每写点）、主写 P95 无回退；覆盖度对账 A-E=0 可复跑 | M5-S1/S11 | 自动 |
| M5-7 | cloud key 零泄漏：只回 configured/maskedLast4；轮换/清除；JWT_SECRET 变更解密失败优雅回落未配置不 500（B-2）；off 默认零外网连接抓包留证 | M5-S3/S7/S11 | 自动+留证 |
| M5-8 | Tier-L 双真机 10 万 chunk P95<500ms 十轮（或门不过的降级结论与降杠杆证据） | M5-S10 → docs/baseline/m5-gate.md | 真机（外部依赖） |
| M5-9 | 旧 /api/search/ 字节零 diff；MCP record.search 薄封装不重复鉴权（联 M6） | M5-S0 golden；M6-S4 | 自动 |

### 2.5 M6 MCP（AC-M6-1~4；AC-M6-3 按 C-2 最小集口径）

| # | 对抗断言 | 测试位置（M6 计划定稿路径） | 方式 |
|---|---|---|---|
| M6-1 | 只读 PAT tools/list 无写/删/admin 工具；绕过列表直调被裁工具返 UNKNOWN_TOOL，且与真不存在工具**逐字节同文案**（golden 0 diff） | mcp permissions 四身份 list 快照 + golden 对拍（M6-S3/S8） | 自动 |
| M6-2 | 字段受限 PAT：schema 无不可见字段、返回无不可见字段；参数携带无权字段/资源被二次拦截（FORBIDDEN_FIELD/RESOURCE）；IDOR 四族（base/doc/canvas 读/canvas 写） | M6-S3/S4/S8 | 自动 |
| M6-3a | doc 块写入 Web 端打开结构完整（round-trip golden + 人工）；contentVersion 冲突 409+currentVersion；无 confirm:true 的破坏性写一律拒绝；op=101/101KB 拒 | M6-S5/S8（packages/blocks 同源 golden） | 自动+手测 |
| M6-3b | **画布最小写入（C-2/S6b）**：canvas.commit_elements/element.create（geometry/rectangle+乐观锁）写入后 **Web 真实打开无白屏、坐标/绑定/层级完整、可继续编辑保存、GET 往返一致**；坏输入六类拒（自带 id/zIndex 键/非法 shape/自定义键越界/超 10MB/不支持操作名）；update/move/delete/connect 被请求时返 **UNSUPPORTED_OPERATION 显式错误，不静默成功**；canvas:write 缺失时工具不注册、直调 UNKNOWN_TOOL | M6-S6b 校验器单测 + S8 e2e + 【手测】Web 打开 + RC-13~25 复跑 | 自动+手测 |
| M6-4 | 吊销（含停用连带）后下一次调用立即拒绝；HTTP 与 stdio 两入口（stdio=下次启动即拒）；每次 tools/call 与每次认证失败入审计，参数脱敏无业务值；requestId 重放只产生一次写、**重启后窗口内仍幂等（mcp_idempotency 落库，C-8）** | M6-S1/S7/S8 | 自动 |
| M6-5 | 三客户端（curl 裸 JSON-RPC / 官方 SDK StreamableHTTPClient / Inspector CLI）+ stdio 客户端真实连通；根路径/子路径/unix socket 三形态各一轮 | M6-S8 → docs/baseline/m6-connectivity.md（真命令+输出摘要，不贴 token） | 自动+手测留证 |
| M6-6 | 11MB 豁免仅 /mcp 生效（/api 1MB 仍 413，S0 golden）；patId 120/IP 300/PAT REST 30 限流 429+Retry-After（C-1）；30s TIMEOUT 不挂连接 | M6-S0/S2/S7 | 自动 |
| M6-7 | 五态 401（无/伪造/过期/吊销/停用主体）文案快照；WWW-Authenticate、-32001 id:null；PAT 明文仅一次、GET/日志/审计/库/产物 grep 无完整 token | M6-S1/S2/S9 | 自动+扫描 |
| M6-8 | GX_ENTERPRISE_ORG=off：/mcp 与 /api/v1/pats 不挂载/404；stdio bin 在 fpk/Docker 产物内但不随 API 起服务（C-5） | M6-S2/S9；部署物核查 §7 | 自动 |
| M6-9 | zod4 不越 src/mcp/（lint/grep 守卫）；旧路由字节零 diff；M1 flags 四组合/M2-M5 回归全绿 | M6-S9 | 自动 |

### 2.6 横切（每主线都带）

- M0 生产基座：/healthz、/readyz 五探针、安全头、错误信封、审计 JSONL、备份/恢复演练（RC/ops 现有测试 + restore.md 季度演练在 M7 实跑一次）。
- 旧 /api 与 v1 双轨：M2~M6 期间旧端点字节不变，各里程碑 S0 golden 在 M7 全量复跑一次。
- 方言铁律（SPEC:60）：M2~M6 全部新迁移 SQL 无 SQLite 专有写死语法（为 ADR-0008 留口），M7 做一次全迁移 grep 巡检（函数索引/JSON 操作符等白名单逐处注释）。

---

## 3. 门②：AC-UPG-1 v0.1.0 → M7 直升抽样零损坏

### 3.1 总原则

- 起点 = tag `v0.1.0` 代码对一份**特征旧库**（不是当前 dev.db）：用 v0.1.0 代码/迁移建库并播种五类对象；起点版本记录在报告。
- 路径 = 一条直线 `prisma migrate deploy` 跑完终态全部迁移（现 14，门时预计约 22~24），**中间不允许逐里程碑人工修补**；部署到候选发布构建后做抽样。
- 既有自动化先例必须纳入并扩展：M2 s8-upgrade-drill.test.ts 已覆盖 12→14 组织迁移（owner 自举恰好一行、全 ACTIVE/ws_default、幂等）；M7 的演练是它的超集（起点更早、对象更全、含 search.db 重建与 PAT 新表），**不替代它**。
- 每个里程碑出口已各自做过升级演练（M2 12→14、M3 v0.1.0 风格库、M4 20 主体对拍）；M7 只认真库全程一次的结果 + 各里程碑证据链接。

### 3.2 旧库播种清单（抽样母体）

| 对象 | 播种口径（确定性脚本，种子入仓 scripts/acceptance/，门时可复跑） |
|---|---|
| 记录 | 3 个 base、每 base 3 张表（含 1 张宽表 ≥20 字段覆盖全部 FieldType、1 张含双向关联+bt+公式/lookup/rollup），每表 ≥50 行；含软删行、草稿行、必填空值边界行 |
| 附件 | 每类（图片/视频/音频/PDF/普通文件）各 ≥2 个，含 2MB 边界附件；公开写 2MB/内部写 10MB 限额各一边界 |
| 正文（Markdown 文档） | ≥10 篇：含表格、任务勾选、align 注释、图片、raw HTML、内链五形态、iframe/嵌入、长文（接近上限） |
| 画布 | ≥6 块：矩形/箭头/连线/关联卡（含 3×2 网格 6+1 张）、脑图、含 gxNote/gxDocRef/gxLinkRef 自定义键、负 viewBox 文档 |
| 旧分享链接 | ≥5 个 /s/:token（doc/canvas、深 3 引用闭包、含越界 ref），token 字符串原样记录用于升级后直开 |

### 3.3 逐项抽样口径、命令与判定

| 项 | 升级前取证（命令/产物） | 升级后核对 | 零损坏判据 |
|---|---|---|---|
| 记录数 | 每表 `SELECT count(*)` + 全量 id 集导出 JSON（脚本 dump-records）；记录字段值快照（宽表全列 JSON） | 同脚本再导 | 行数逐表相等；id 集集合相等；宽表全字段值 JSON 0 diff（时间戳字符串归一化后）；软删/草稿态一致 |
| 附件 | uploads 目录文件清单（相对路径+size+sha256）导出；记录中附件字段引用计数 | 重新 sha256 清单；UI 与公开链接各打开 2 个 | 清单 0 diff；引用不悬空；抽样文件可下载且字节哈希一致；限额行为不变（RC-27） |
| 正文 | KbDoc 全量 content/contentVersion/searchText 导出 md；blocks round-trip（M6 shared 后以同一 golden 跑） | 重导 + mdToBlocks→blocksToMd 往返 | content 逐字节一致；版本号不被升级过程递增（迁移不改内容）；往返 golden 0 diff；Web 打开 10 篇人工目检结构完整 |
| 画布 | 每块 content JSON 导出（元素数、z 序数组、自定义键、几何坐标）；RC-25 网格位置 | 重导 + JSON 结构对比 + Web 打开 | 元素数/数组序/自定义键/坐标 0 diff；Web 打开无白屏可编辑（SPEC:144 vite 缓存处置：必要时 rm node_modules/.vite 属部署清单，不算数据损坏）；RC-13~25 手测组全过 |
| 旧分享链接 | token 清单 + 闭包快照（闭包内 id 集、canEdit） | 逐 token curl（含越界 ref 403、已删 404、匿名写 2MB） | 5/5 可开且闭包 id 集一致；越界仍 403；RC-30 全过；新壳外旧链接形态可达（M3-7） |
| 组织/导航/权限新表 | 不适用（旧库无） | M2 自举（ws_default、五系统角色、owner 恰好一行、存量用户全 ACTIVE）；M3 回填 A/B/C 0 差异；M4 回填 20 主体新旧判定全同（M4-7） | 各里程碑对账脚本 exit 0；重跑 deploy 幂等（applied 跳过、行数零增长） |
| 派生库 | 不适用 | search.db 首启自动播种建索引；check-coverage A-E=0；vec 扩展缺席时 FTS-only 正常 | 覆盖度对账 0；kill 后降级（M5-1）；主库不出现 search.db 表 |
| PAT/幂等表 | 不适用 | 新表存在为空；迁移 down SQL 可干跑 | 表结构与 schema.prisma 一致；旧功能无任何对新表的读取依赖（摘除路由即无害） |

执行命令骨架（脚本化，输出全部进报告附件目录）：

```bash
# 1. 旧库（在 v0.1.0 checkout 上播种）
git -C "$REPO" checkout v0.1.0
pnpm -w install --frozen-lockfile
DATABASE_URL="file:$WORK/legacy.db" pnpm --filter @gx/api prisma migrate deploy
node scripts/acceptance/seed-legacy.mjs --db "$WORK/legacy.db" --out "$WORK/before"
# 2. 回到候选构建，发布前快照后直线升级
git -C "$REPO" checkout "$M7_CANDIDATE"
node apps/api/scripts/backup/online-backup.mjs --db "$WORK/legacy.db" --out "$WORK/pre-m7.bak"
DATABASE_URL="file:$WORK/legacy.db" pnpm --filter @gx/api prisma migrate deploy   # 一次跑完全部
DATABASE_URL="file:$WORK/legacy.db" pnpm --filter @gx/api prisma migrate deploy   # 幂等性：再跑一次
# 3. 起候选服务（三环境分别做，§7），逐项抽样
node scripts/acceptance/dump-records.mjs --db "$WORK/legacy.db" --out "$WORK/after"
node scripts/acceptance/diff-snapshot.mjs "$WORK/before" "$WORK/after"           # 必须 exit 0
bash scripts/acceptance/check-share-links.sh "$WORK/share-links.txt"             # 5/5 + 越界 403
```

判据：diff-snapshot exit 0 且人工目检段全部签字；任一 P0 类对象出现损坏 = 发布阻断；仅新表侧问题按对应里程碑缺陷处理。

---

## 4. 门③：回滚演练（flag off 矩阵 + 30 分钟计时）

### 4.1 发布默认姿态矩阵（唯一真源）

| 能力 | env（发布配置值） | 代码默认 | 回滚动作（行为层） | 数据层姿态 |
|---|---|---|---|---|
| 组织管理面 | GX_ENTERPRISE_ORG=on | on | =off，v1/邀请/mcp/pats 全不挂载（404），旧 /api 与登录主流程不受影响 | 五表保留无害 |
| 新导航外壳 | GX_ENTERPRISE_NAV=on | on | =off，前端探 404 回退旧两壳（保留一个迭代，PRD:258）；nav 同步无开关（强一致，回滚靠代码回退+快照） | nav/menu 表保留 |
| 权限引擎 | GX_AUTHZ_ENGINE=**shadow**（生产建议值，总监下令；代码默认仍 off） | off | 立即 =off：旧 guards/kb.ts 按旧表决策，投影双写保证旧表新鲜（M4 §4.6/ADR-0036） | auth_policies 保留；旧表在投影期完好 |
| M1 sidecar 写 | GX_M1_SIDECAR 沿用在库值 | on（非 off） | =off 停写（读侧自动不可用） | sidecar 表保留，可 backfill |
| M1 物理读/keyset | **门时定姿态**：要么 shadow 双零后 on，要么明确 off 发布（§0-5） | off/off | read=off（keyset 连带恒 false，flags.ts:51-57）回全表 hydrate 旧行为 | 无数据回滚 |
| Embedding | GX_EMBEDDING_MODE=**off**（Tier-L 门未过前的默认发布姿态） | off | off 即纯 FTS trigram+短词 LIKE，零外网 | search.db 可删可重建 |
| 检索 worker | GX_SEARCH_WORKER=on | on | =off 暂停消化（排障用），主应用/检索不受损 | outbox 积压，恢复后追平 |
| MCP | 随 GX_ENTERPRISE_ORG；另可在挂载层独立摘除（实施时若给独立开关需登记本表） | on（门控内） | org=off：/mcp、/api/v1/pats 404；紧急限流调 GX_MCP_RATE_*；stdio 不随 API 起 | PAT/幂等表保留，DROP 安全（无既有读取方） |

### 4.2 一键收回步骤（每面旗实演一遍并计时）

行为层（目标 ≤5 分钟）：

```bash
# 改 /etc/gouxiangdb/env.conf（或 docker compose environment）对应行 -> 重启
sudo systemctl restart gouxiangdb-api
curl -fsS http://127.0.0.1:3001/readyz          # 30s 轮询内恢复
# 验证旧行为：v1 404 / 旧壳可达 / 旧守卫决策生效 / 旧分页形态 / FTS-only / /mcp 404（按旗各一组断言）
```

代码层（目标 ≤30 分钟，含进程重启与探针）：

```bash
sudo bash deploy/bin/rollback.sh                 # 上一版（原子 symlink 切换，deploy.md:125-126）
curl -fsS http://127.0.0.1:3001/readyz
# 旧代码 + 新表并存：M2~M6 全部迁移只增，旧代码不读新表即无害（M3 workspaces 两列 SQLite 不可 DROP，已注明闲置无害）
```

数据层（仅当迁移本身致损，主路径 = 发布前快照）：按 restore.md：停服→在线快照备份现网→快照落临时库校验→就位→`migrate deploy`→readyz；30 分钟计时从决定回滚起算，演练用克隆机不碰真数据。

### 4.3 演练记录表（门时逐行填）

| 演练 | 操作 | 开始-恢复时刻 | 实测耗时 | 旧行为验证断言 | 结论 |
|---|---|---|---|---|---|
| R1 org off | env 改+重启+v1 404+旧登录可用 |  |  | enterprise-flag-off 测试组手跑 |  |
| R2 nav off | env 改+重启+旧两壳视觉对 32f7bea |  |  | M3-6 断言 |  |
| R3 authz off（从 shadow） | 改+重启+旧守卫决策（夹具用户视图恢复） |  |  | M4-9 回退断言 |  |
| R4 m1 read off | read=off 旧分页/旧响应形状 |  |  | keyset-flags + 响应快照 |  |
| R5 embedding off | cloud→off，FTS 结果可用、零外网 |  |  | M5-1 降级组 |  |
| R6 worker off/on | off 停消化→on 追平 outbox |  |  | 积压计数归零 |  |
| R7 mcp 摘除 | org=off 后 /mcp 与 pats 404，stdio bin 不在进程内 |  |  | M6-8 |  |
| R8 代码回滚 | rollback.sh 到上一候选 + readyz |  |  | 冒烟集（§7.4） |  |
| R9 快照恢复 | 克隆机 restore.md 全流程计时 |  |  | 抽样 §3.3 子集 |  |

硬判据：R1~R8 任一 >30 分钟 = 不通过（需修 runbook/自动化后重演）；R9 在克隆机完成且数据校验过。

---

## 5. 门④：RC-40 + 新增对抗用例总台账（用例 → 所在文件 → 覆盖 AC）

> 现状列基于 45784f4 实查；M3~M6 行为各计划定稿文件名，门时以实际路径回填。标记：自=自动化单测/集成，API=接口脚本，UI=Playwright/真机，读=只读核对。

### 5.1 既有 RC-40（docs/baseline/2026-09-12-regression-cases.md）

| RC | 主题 | 自动化位置（已在库）/ 执行 | 覆盖 |
|---|---|---|---|
| RC-01 | 日期 gt/lt 筛选 | packages/shared-types/src/__tests__/filter-date-multiselect.test.ts（自） | 数据正确性 |
| RC-02 | 多选按选项 id | shared-types filter-match-field.test.ts（自）+ FilterPanel【UI】 | 数据正确性 |
| RC-03 | 纯日期不跨时区 | CalendarView【UI 改时区】 | 数据正确性 |
| RC-04 | CSV 公式注入 | api domain/__tests__/csvExport.test.ts（自/API） | 安全 |
| RC-05 | IME/Esc/blur 不重复提交 | CellEditor【UI】 | 数据一致性 |
| RC-06 | checkbox 连点去重 | GridView/CheckboxEditor【UI】 | 数据一致性 |
| RC-07 | KB 乐观锁 409 | routes 层 kb 测试 + M6 doc 工具 409 用例（API） | AC-M6-3 前置 |
| RC-08 | WAL/busy_timeout | readiness/配置【读/API】 | 基座 |
| RC-09 | CSV 导入行级事务 | routes/records 导入用例（API） | 数据一致性 |
| RC-10 | 建表删表建链事务 | tables/fieldService（API） | 数据一致性 |
| RC-11 | bt 多目标 400 | record 写测试（API） | 数据一致性 |
| RC-12 | 软删/级联清理 | record/field 级联用例（API） | AC-UPG-1 记录 |
| RC-13~25 | 画布 13 项（只读兜底/嵌入/FO/z  token/脑图/WebKit/右键/网格） | 【UI/Playwright，改动 Plait/Drawnix/选区/z 序时必跑】；M6-S6b 后追加"服务端产出 JSON→前端加载"方向 | AC-M6-3 画布、M3-5 |
| RC-26 | URL 白名单+align 往返 | renderMarkdown/blocks 测试（自）；M6 blocks golden | AC-M6-3 文档 |
| RC-27 | 附件/内容上限 | 【UI/API】升级演练附件边界带 | AC-UPG-1 附件 |
| RC-28 | DATEADD/默认墙钟 | formula-functions/formula 相关（自） | 数据正确性 |
| RC-29 | 必填校验/draft | routes/__tests__/required-create.test.ts（自/API） | 数据正确性 |
| RC-30 | 公开分享鉴权闭包 | routes/__tests__/public.test.ts + characterization/public-share-current（自/API） | AC-UPG-1 分享、M2-5 |
| RC-31~37 | 公式 7 项（点引用/聚合/环/边界/默认值/候选） | cross-formula、formula、formula-functions、formula-output-type、hydrate*（自，M1 后全绿复跑） | 数据正确性；RC-33/34 联 M4-4 公式 mask |
| RC-38 | 全量质量门 | `bash scripts/ci-quality.sh`（自） | 全局 |
| RC-39 | 换机冷启动 | 【手册】干净机 | 部署 |
| RC-40 | @plait 补丁重放 | 【手册/UI】patches/@plait__draw@0.89.2.patch + rm .vite | 画布/构建 |

### 5.2 各里程碑新增对抗用例（门时必须全在仓且绿）

| 组 | 用例/文件 | 覆盖 AC | 状态 |
|---|---|---|---|
| M2 | ac-m2-1.adversarial（7）、s8-query-count（2）、s8-members-perf（3）、s8-upgrade-drill（2）、lifecycle、deptTree、members、roles-admin、departments、auth-state、authStateCache、enterprise-migration、enterprise-flag-off、三组 characterization（34） | AC-M2-1 | **已落地**（45784f4：724/3） |
| M2-FE | contacts/lib/tree.test.ts 等三栏纯函数 | M2 通讯录 UI | 在途（#142-147） |
| M3 | ac-m3-1.nav.test.ts（8 条）、18 写点回滚证明（M3-S3）、回填对账 A/B/C（S2/S4）、openapi 对拍（S7）、旧壳 flag 回退 web 组、N5 链接矩阵 | AC-M3-1、AC-UPG-1 | 计划（M3 §7-S3/S10） |
| M4 | ac-m4-1.sources、ac-m4-2.inheritance、ac-m4-3.fieldmask（六通道×四 flag 组合）、越权矩阵、20 主体对拍、11 写点双写共生死、drift shadow 证据、500/万规模 | AC-M4-1/2/3 | 计划（M4 §7-S10） |
| M5 | ac-m5-1.degrade（五故障）、ac-m5-2.leak（三态独特语句+EXPLAIN 白名单）、B-2 密钥六端点、S8 即时性、check-coverage A-E、Tier-L 真机门记录 | AC-M5-1/2 | 计划（M5 §9） |
| M6 | S3 四身份 list 快照+UNKNOWN_TOOL golden、S4 表/记录（含 delete/search）、S5 blocks 同源 golden、S6b 六不变量校验器六拒+Web 加载、S7 审计/幂等重启语义/TIMEOUT、S8 三客户端四对抗两入口、S0 body 档 golden | AC-M6-1/2/3/4 | 计划（M6 §9，含 S6b） |
| M7 新增 | acceptance/seed-legacy、dump-records、diff-snapshot、check-share-links（§3）；flag 计时演练记录（§4） | AC-UPG-1、回滚铁律 | 本门新增脚本（门时建，按 packages 纪律入 scripts/acceptance/） |

门判据：CI 一次跑全绿 + 本台账每行有结果；UI 类允许手测但必须有带日期/执行人的记录条目；**台账中不允许出现"未执行/未找到文件"行**。

---

## 6. 门⑤：性能门证据汇总（承诺数字 vs 留档数字）

### 6.1 指标与证据位

| 指标 | 口径（SPEC） | 证据位 | 数字性质 | 不过的姿态 |
|---|---|---|---|---|
| 通讯录三接口 | 500 成员（宽松门，非 SPEC 硬指标） | s8-members-perf：median 3.27 / p95 8.82ms，三接口并行 6.43ms（45784f4 已留证，目标 P95<150） | **已实测（开发机）** | 宽松门，留证即可 |
| 组织求值定数 SQL | 6 层×10 兼岗 | s8-query-count：effectiveRoleRows ≤3、listMembers 恒定 4 | 已实测 | — |
| 导航首屏 | **成员 500、资源 10 万节点首屏导航 <1s（SPEC:134）** | M3-S10：造 10 万实体节点，GET menu P95 + 前端首屏渲染 <1s（后端 ms + DOM 有界断言），tree maxDepth=2 P95，EXPLAIN 无全表 SCAN → docs/baseline/2026-09-16-m3-gate.md | **门时必填**；开发机数字可留证，**对客户承诺以目标机复测为准** | 不达：虚拟滚动/分页展开兜底已在方案内；仍不达阻断"10 万节点"承诺口径，报告标限定值 |
| 权限判定 | 500 用户/万节点 decide/scope P95、无 N+1、变更秒级 | M4-S10 → 2026-09-17-m4-gate.md | 门时必填 | 不达：缓存快照策略已备；阻断 on 翻转（可停 shadow 发布） |
| M1 容量 | 50 万行 P95<800ms；百万证伪门 | 2026-09-13-m1-s10-gate/t0-closure（已留证）；ADR-0008 三形态 | 已实测（按当时规格机口径） | 阈值触 ADR-0008/PG 评估，非 M7 重跑项 |
| 检索 | **10 万 chunk 混合检索 P95<500ms** | M5-S10 Tier-L **双真机**（飞牛 x86 + arm，2C4G 本地盘）十轮；灌库时长/主写影响/RSS/库体积；Tier-S 1-10 万流畅 | **只在 Tier-L 真机确认**；spike M5/113ms 与开发机数字仅参考 | **门不过 = GX_EMBEDDING_MODE=off + FTS trigram 默认发布，cloud 为高配能力，不阻塞 M7（B-5 定稿）；对外材料禁写该承诺** |
| MCP | 工具 30s 返回（SPEC:135）；单批 op≤100/文本≤100KB/10MB | M6-S7 慢夹具 TIMEOUT；限流档不拦正常 agent 流（120/60s） | 门时必填 | 30s 不达：返 jobId 是二期，首版超时即 TIMEOUT 引导重读，不改门限 |
| 主写影响 | outbox 同事务、索引不饿死主写 | M5-S1/S10 主写 P95 对比 | 门时必填 | worker off 即解（R6） |

### 6.2 数字纪律

1. 报告中每个数字标注：机器规格（cpu/ram/盘类型）、批次、P95 计算方法、原始日志路径。
2. **只有 Tier-L 双真机数字可写进对外承诺**；开发机数字一律标"内部留档"。
3. 真机/排期是外部依赖（项目总监向主理人申请）；到 M7 门时真机窗口仍未获批的情形：按 B-5 走降级发布姿态，报告如实记录"真机门未执行"，不补编、不推断。

---

## 7. 门⑥：三环境部署物更新清单与冒烟

### 7.1 通用变更（三环境共有）

| 变更 | 来源 | 打包/装配点 |
|---|---|---|
| 迁移 14 → 约 22~24（只增；search.db 不在 prisma 迁移内，首启自建） | M2~M6 | package-release.mjs 白名单随 prisma/migrations 整目录已覆盖（:83-85 dist 校验）；门时数目录与 ci-quality 动态对账 |
| 新运行时依赖 `@modelcontextprotocol/sdk@1.30.0`（精确 pin，纯 JS） | M6 | package-release runtimeDeps 白名单（:100 剔除 @gx/* 逻辑下 SDK 作为普通 dep 入包）；scripts/build.mjs external 增项；Docker pnpm install 自动带入；**fpk 同检** |
| stdio bin（gx-mcp-stdio 多入口产物） | M6 C-5 | build.mjs entryPoints 多产物；tar 白名单确认 dist/mcp/stdio.js 随包；fpk/Docker 只是文件、不建第二服务/第二 unit/第二端口 |
| 新 env 段 | M3/M4/M5/M6 | deploy/env.conf.example、deploy/docker/gouxiangdb.env.example 双写注释；config 启动闸门非法值拒启（M0 S3 纪律） |
| 反代 body 上限 11m | M6 | Caddyfile 增 /mcp（或全局对齐）client_body 等价配置；飞牛网关上载上限核查（fnos 配置项登记 runbook）；Docker 无 Caddy 时直连无需 |
| 静态托管/basePath/socket | M0 适配器（已落地） | 三形态回归：根路径、GX_BASE_PATH=/app/gouxiangdb、GX_SOCKET_PATH 各跑一次 MCP initialize + web 打开 |
| web 产物 | M3-FE/M4-FE/M5-FE/M6-FE | web/dist 整目录替换；index.html 存在性 fail-fast（package-release:130） |

### 7.2 飞牛 fpk 专项

- build-fpk.mjs 的 Linux 目标机 fail-fast 保持；新增：
  1. `native/<triplet>/vec0.{so}` 拷贝（M5 spike §5.3，0755 目录/0644 文件）与 `file` 架构自检（x86/arm 各一份 optionalDependencies 平台包）；
  2. vec0 缺失只影响向量路（默认 off 本就不加载），fpk 构建不得因 darwin 机无 linux 扩展而失败——扩展来自 sqlite-vec 包内平台子目录，按 triplet 选取；
  3. fpk manifest/cmd（install/upgrade/uninstall callback）核对：升级不重置 /data 数据目录、不重置 env；upgrade_callback 跑 migrate deploy 的姿态与裸机一致（只增迁移、先快照）；
  4. 启动后冒烟（探针或 callback 内）：/healthz 200、/readyz 五探针、`/mcp` 未认证返 401 边缘（证明挂载）、`vec_version`（仅 embedding 配置时）。
- 冒烟机：至少一台 x86 飞牛或等价 Linux；arm 随 Tier-L 真机窗口合并验证。

### 7.3 Docker 专项

- Dockerfile builder 已按 filter 安装 @gx/api... @gx/web...（:39-41）：新增 packages/blocks（及可选 canvas 包）必须加入该 filter 闭包（pnpm `...` 会随依赖自动带入，门时实际核验 node_modules 内含 SDK 与 blocks 包）。
- runner 阶段目标架构 prisma generate 纪律不变；增验：`node -e "require('@modelcontextprotocol/sdk')"` 烟测；sqlite-vec bookworm 平台包装载 + 一条 KNN（M5 发版冒烟）。
- compose env example 补全：GX_EMBEDDING_*（默认全注释=off）、GX_SEARCH_WORKER、GX_MCP_*、GX_ENTERPRISE_*；/data 卷含 search.db（派生库不进业务备份，文档注明）。
- buildx 双架构各跑一遍 §7.4 冒烟矩阵。

### 7.4 冒烟矩阵（三环境同一组，逐格留证）

1. 健康：/healthz 200；/readyz db/migrations/uploads/disk 全绿；版本单源 /api 版本端点与包版本一致。
2. 迁移：全新空库 deploy 成功（条数=门时实数）；旧库直升（§3）；二次 deploy 幂等。
3. 核心链路：登录→建表→建记录→宽表 hydration→搜索（off 态 FTS 命中）→建文档→开画布→建分享链接无痕打开。
4. 企业链路（flag on）：通讯录→新外壳导航→权限面板只读展示（shadow 期）→PAT 签发→curl `initialize`/`tools/list`（只读 PAT）→/mcp 11MB 档：2MB 画布载荷在 /mcp 200、在 /api 413。
5. 降级：删/改名 vec0 扩展后重启，主应用正常且检索 FTS-only；cloud 配置坏值不拖垮启动（四与门）。
6. 回滚：每环境至少跑 R1/R8 两格（env off、rollback.sh）。
7. macOS 补格：tar 包在 macOS arm64 本机直跑（dev-up 等价）；darwin 下 vec 扩展缺失时 M5-1 降级表现；**旧 Tauri 桌面端连新服务端出现升级提示（SPEC:133），不出现白屏/死连**。
8. 安全速扫：响应头（securityHeaders 测试组）、错误信封不泄内部栈、审计 JSONL 落盘、PAT 明文不出现在任何日志/产物（grep）。

---

## 8. 门⑦：发布 checklist

### 8.1 代码与质量

- [ ] `pnpm -w install --frozen-lockfile` 干净；`bash scripts/ci-quality.sh` 绿（真 ESLint、平台中立 CI 留痕）。
- [ ] `NODE_ENV=test pnpm -w test` 全量一次过，数字回填报告（api/web/shared-types 分列、skipped 原因逐条）。
- [ ] openapi.yaml 与实现对拍 0 diff（M3 冻结后只增，M5/M6 段齐备）；错误码词汇表（含 UNSUPPORTED_OPERATION、PAT_EXPIRY_INVALID）齐备。
- [ ] ADR 归档齐：0022-0027（M2/M3）、0036（authz 翻转）、0041-0049（M5）、0050-0054（M6）；状态字段无"越权 Accepted"（M2 教训）。
- [ ] 全仓 P0 设计纪律扫描：无 emoji 充当功能图标、icons.tsx 单一 SVG 体系新增语义齐、无紫粉渐变、无裸 z-[n]、无硬编码色值（白黑名单脚本/人工双检）。
- [ ] 方言巡检：全部企业版迁移无 SQLite 专有写死（SPEC:60）。
- [ ] 旧 /api 与旧页面字节零 diff 证明（各 S0 golden 汇总）。

### 8.2 安全

- [ ] AC-M6-1/2/4 与 M4 越权矩阵全绿；IDOR 零泄漏；PAT 零泄漏扫描；审计脱敏。
- [ ] 备份：发布前在线快照成功；age 异地策略按客户合同（默认不激活，PLAN-ADJUST 口径）；restore 演练（R9）在克隆机过。
- [ ] 密钥：JWT_SECRET 非默认；embedding key（如 cloud）加密落库仅 maskedLast4；600 权限位核查。

### 8.3 文档与交接

- [ ] runbooks 增章齐：M2 四章、M3 reconcile/新壳回退、M4 五章、M5 五章（musl 禁令/NFS/降级/key）、M6 章节（PAT 排查/401 四态/限流调档/Inspector/stdio/zod4 共存/SDK 升级门/11m 反代）；README 索引更新。
- [ ] 《MCP 客户端接入说明》协议无关版齐备（endpoint/headers/env/命令示例，无第三方 Logo/市场指引，C-9）。
- [ ] 发布说明 RELEASE.md：版本号、迁移数、flag 默认姿态矩阵（§4.1 原样转写）、降级姿态、已知不做项（§9）、桌面端兼容提示。
- [ ] 三份产物 checksums 签字；fpk/Docker 镜像 digest 入报告。

### 8.4 决策签字

- [ ] GX_AUTHZ_ENGINE 发布值（shadow/off）项目总监明确下令并记录（不许现场默认）。
- [ ] GX_EMBEDDING_MODE 发布值：默认 off；若某客户高配 cloud，单独配置交付，不进全局默认。
- [ ] Tier-L 真机门结果（过/未执行/不过）与对应对外措辞，项目总监+主理人知悉签字。
- [ ] M1 读路径姿态（on with 双零证据 / off 发布）项目总监签字。

---

## 9. 已知不做项（P1/P2 backlog，发布说明如实写，不许伪装成已交付）

| 项 | 出处/归属 | 本期姿态 |
|---|---|---|
| 行级权限（任意行自由条件 conditions）、deny/effect 拒绝语义、审批流/ABAC | SPEC §3 | 不做；收窄仅 fieldMask + 中断继承 |
| 收藏/最近访问 | PRD P1 | 不做（一级列表区留位，无入口） |
| base/kb 恢复端点（服务端回收站 API） | M3 边界（nav 侧只做实体删除同步与对账修复） | 不做；误删恢复靠发布前快照/runbook |
| 画布写完整操作集（element.update/move/delete/connect、zorder、关联卡插入、脑图布局） | M6 C-2 | 仅 element.create 最小集（S6b）；其余 UNSUPPORTED_OPERATION，二期 |
| OAuth 2.1/PKCE、PAT OAuth 发行 | ARCH §13-4 | 不留表/不留端点；仅 authenticate 分支扩展点 |
| record.batch / 大导入 jobId / 长任务 SSE 推送 | SPEC:135 | 二期；超限 -32602 |
| MCP prompts、Resources 业务数据通道、内置 AI 聊天/模型编排、单一平台适配 | R-MCP-2/SPEC §3 | 不做 |
| 旧 /api 下线、旧 guards 决策分支删除、旧五角色表物理删除 | 各里程碑"保留 N 迭代"纪律 | M7 不删；删除另开切片（M4 on 稳定两迭代后） |
| 独立检索 worker 进程/多实例/高可用/PG | B-7、单实例前提 | 内嵌唯一形态；触阈值立 ADR |
| 多主题/个人导航/跨工作区/多租户/正式国际化/移动端原生 | SPEC §3 | 不做 |
| S5b hydration 扇出收口（第三类成本） | task #89 | 按规模触发，已后移；非本次发布阻断 |

---

## 10. 门⑧：总验收报告模板与通过/不通过判据

### 10.1 报告模板（docs/baseline/2026-09-XX-m7-acceptance-report.md）

```markdown
# GouXiangDB 企业版 M7 总验收报告
- 候选版本/提交：<tag/commit>；迁移数：<实跑>；测试：api <n 文件 x passed/y skipped>、web、shared-types
- 验收窗口：<起-止>；执行人：后端/前端/架构/总监
- 三环境：裸机 <主机>、飞牛 <型号/arch>、Docker <digest>、macOS <机型>

## 1. 五主线对抗（§2 表逐行）：<全绿计数/豁免项+总监批字>
## 2. AC-UPG-1 直升：起点 tag、五类对象 diff 结果（贴 diff-snapshot 输出）、分享 5/5
## 3. 回滚演练：R1~R9 耗时表（max=<> 分钟，判据 30）
## 4. 用例台账：RC-40 结果、M2~M6 新增组结果、未执行项=0 的声明
## 5. 性能：已留证数字（含机器规格）、Tier-L 真机结论（过/未执行/不过）、发布姿态
## 6. 部署物：三环境冒烟矩阵逐格、SDK/vec0/bin 核查、checksums/digest
## 7. 默认姿态确认：§4.1 矩阵实际 env 截图/摘抄 + 总监四项签字
## 8. 缺陷清单：阻断项/收尾项/挂账项（挂账须有 backlog 链接）
## 9. 结论：通过 / 有条件通过（降级姿态）/ 不通过
```

### 10.2 判据

**通过**（全部满足）：

1. §2 五主线 AC 全绿（每个 AC 有自动化证据；手测项有签字记录）；
2. AC-UPG-1 五类对象 0 损坏、幂等升级过；
3. R1~R8 ≤30 分钟且旧行为断言全过；R9 克隆机恢复成功；
4. RC-40 + 新增对抗全绿，测试计数实数回填，CI 留痕；
5. 三环境冒烟矩阵逐格过；
6. 安全扫描（PAT/字段/越权/审计/头）零阻断发现；
7. 四项发布姿态签字齐（authz/embedding/Tier-L 措辞/M1 读）。

**有条件通过（降级发布）**：仅限已预批的降级路径——Tier-L 真机门未过或未执行时，以 GX_EMBEDDING_MODE=off + FTS 为默认发布、cloud 高配交付，对外措辞按 §6.2 收口；其余 AC 仍须全绿。任何其他"带病放行"不在预批路径内，一律按不通过处理。

**不通过**（任一即）：AC-UPG-1 任一 P0 对象损坏；AC-M2~M6 任一 P0 AC 失败；回滚超 30 分钟或旧行为不可恢复；越权/泄漏类对抗失败；三环境任一冒烟阻断且无可用降级；测试/迁移数字对不上或证据缺失。处置：阻断发布 → 缺陷回 respective 里程碑切片修复 → 重跑相关门（升级/回滚门必须整门重跑，不接受局部修补声明）。

---

## 11. M7 执行切片（门自身的排期，不是业务开发）

| 步 | 内容 | 负责 | 前置 |
|---|---|---|---|
| G0 | 候选构建封版：tag、frozen-lockfile、CI 绿、ADR/openapi 齐 | 后端+前端 | M6-S9 收口 |
| G1 | 门④台账试跑（RC-40+全部新增），缺口先行补齐 | 后端 | G0 |
| G2 | 门② acceptance 脚本入仓 + v0.1.0 旧库直升全程 + 抽样签字 | 后端 | G1 |
| G3 | 门①五主线对抗逐条核验（含 M6 画布 Web 手测、M3 N5 矩阵） | 后端+前端 | G1 |
| G4 | 门③ R1~R9 演练计时 | 后端+运维 | G2 |
| G5 | 门⑥三环境打包/冒烟（fpk/Docker/macOS，含双架构） | be-deploy-adapter/运维 | G0 |
| G6 | 门⑤性能证据汇总（Tier-L 窗口排期是外部依赖，尽早提） | 后端+总监申请真机 | M3/M4/M5 门数据齐 |
| G7 | 门⑦ checklist 全勾 + 门⑧报告 + 四姿态签字 + RELEASE | 架构+总监 | G1~G6 |

关键路径风险：Tier-L 真机窗口（外部）、M2-FE 在途、M1 读路径姿态未结（#103 等）、S6b shared 抽取若证明超片需立即升级（M6 C-2 红线）。

---

## 12. 自报

- 本文档入库 commit：`78c2676`（2026-09-18，纯文档；与 M6 九裁决回填同批）。
- 基线：`main` @ `45784f4`（2026-09-18 实读）；M6 九裁决回填与本文件同一文档批。
- 本文件不含任何业务代码改动；门中新建脚本（scripts/acceptance/）在 G2 随测试提交，不提前写。
