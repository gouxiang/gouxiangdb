# 构想工作台 v0.1.7 发版说明

- **版本号**：`0.1.7`（版本单一真源 = 根 `package.json` 的 `version` 字段；运行时禁止再出现硬编码版本字面）
- **展示名**：构想工作台（技术标识 `gouxiangdb` / `gouxiangdb-v2`，仅包名/目录使用）
- **本轮变更区间**：2026-09-19 ~ 2026-10-01
- **上游阶段**：M0–M6 全部收口，**六项产品需求（响应式/表级权限/视图管理员/层级视图甘特/多模态语义检索/MCP 全功能）全部完成**；四门回归、生产部署冒烟、五档真机验收、飞牛 x86 fpk 构建均通过。唯一待办：飞牛真机安装冒烟（需设备凭证）、多模态真召回（需真 ARK key）

> **2026-10-01 增补**：六项需求收口情况见下方「〇、六项产品需求收口（2026-10-01）」。

> 本文件是 **0.1.7 的发版说明**。2026-09-04 那份「第二轮 6 类问题修复自测报告」已被归档为
> `docs/_archive/originals/release-2026-09-04-self-test-report.md`（登记见根目录 `ARCHIVE-LOG.md` 第 15 项），
> 不再作为当前部署 / 配置依据。

---

## 〇、六项产品需求收口（2026-10-01）

| # | 需求 | 状态 | 关键证据 |
|---|---|---|---|
| 1 | 响应式布局 | ✅ 完成 | 五档真机验收（sm/md/lg/xl/2xl），截图 `docs/acceptance/2026-10-01-responsive/`：sm 单栏抽屉、md 卡片化+浮面板、lg 收 L2、xl/2xl 三栏完整 |
| 2 | 数据表表级管理权限 | ✅ 完成 | P1-S1～S9 全套；`manage_table` 动作 + 行级条件 + 新守卫；翻 `AUTHZ_ENFORCE_READY=true` 仍须戴总专门点头 |
| 3 | 视图管理员配置 | ✅ 完成 | #560 admin/user 分层 + 封面/字段/筛选 UI + 脱敏 |
| 4 | 用户视图个性化 | ✅ 完成 | #561 `view_user_prefs` 表 + store + 路由 + 列表合成 |
| 5 | 层级视图 + 甘特图 | ✅ 完成 | #562 TreeView/GanttView 组件注册 + 契约/后端透传 |
| 6 | 多模态语义检索 | ⚠️ 代码完成，真 key 待补 | #563 doubao-embedding-vision：查询侧图片向量化、`POST /api/v1/search` 以图搜图、前端 UI；待取得真 ARK key 后全量 reindex + 真召回 + 权限对抗 + 结束删 key |
| 7 | MCP 全功能 | ✅ 完成 | #564 #620–#623：table/field/view/doc/canvas 搭建工具 + canvas update/move/delete/connect + base.create_base/kb.create_kb；工具总数 **28**；三身份矩阵 + gate=false 安全边界全验 |

**质量门实数**

- api：本地 **2803 通过 / 零失败**（权威）；VM15 交叉复验 2801 通过 / 3 flaky（departments/lifecycle/docFlush，隔离单跑均全绿）
- web 1527 / shared-types 103 / canvas 51，三包类型检查零错误
- eslint：api 零告警；web/packages 0 error（100 warning 均历史既有）
- api + web 生产构建成功（GX_VERSION 0.1.7，迁移 applied=38）
- 生产部署冒烟（VM15）：readyz 五探针全 true、登录→强制改密→建 Base/KB（回执含完整字段）→默认表随事务建好，全链路通过
- 飞牛 x86 fpk：`deploy/fnos/dist/gouxiangdb-0.1.7-x86.fpk`（59.61 MiB，hoisted 零软链、vec0.so、产物冒烟全绿）

**仍待外部凭证（非代码缺口）**

1. 飞牛真机 192.168.31.183 安装冒烟：需设备 SSH 密码（用户「戴静」），或由戴总在 fnOS 应用中心手动安装 fpk
2. 多模态真召回：需真 ARK API key
3. 权限总闸：`AUTHZ_ENFORCE_READY=true` 须戴总专门点头，当前仍为 off

---

## 一、本轮实际变更

### 1. 导航重构收口（L1 列库 / L2 列子项 / 下线导航编排）

| 提交 | 内容 |
|---|---|
| `720e09c` | 一级导航列库、二级列选中容器的子项，**下线导航编排** |
| `032168a` | 摘除建库 / 建知识库自动写 `menu_items` shortcut |
| `98285a3` | L2 二级导航收起/展开持久化（`gx.l2.collapsed`）+ 56px 唤回窄条 |
| `4d1fc4e` | 建库 / 建知识库自动入一级导航，库入口从顶栏移入左侧 |
| `4107c3f` | L1 菜单精细化：取消手风琴改分组标题平铺 + 深层侧方浮出 + 图标语义/节奏统一 |
| `f1071d8` | 治理工作区设置页（口径统一 / 上传限制上提 / 回收站聚合 / 响应式） |
| `5e97def` | 权限管理与通讯录并入工作区设置 |
| `a397cf2` | 无权限的管理类入口**完全隐藏** |
| `fcb9a94` | 侧栏个人信息栏下线 + 底部管理入口按能力渲染 |
| `a08d96d` | 第五批回挂新 UI 改版后丢失的五处功能入口 |
| `9cdc85a` | 清理第三批导航重构遗留死代码 |
| `d562075` | 导入导出按钮移到搜索框右侧 |

### 2. 帮助中心上线

| 提交 | 内容 |
|---|---|
| `128fcdd` | 帮助中心入口与 md 预览页 |
| `9389476` | 正文改为分片真源 + 拼接生成物 |

### 3. 本批缺陷修复

**P0 / P1**

| 提交 | 内容 |
|---|---|
| `9a6ef44` | 修 P0 编辑器 / 画布五处缺陷（⑤①②④a④b），21/21 断言通过 |
| `9d54da9` | 窄屏 P1：工具栏按钮收进溢出菜单、顶栏搜索 <768 折叠为图标、R-D-30/31/32/33 档位接线与表格转卡片 |
| `f9d9911` | 补 `/share/:token` 路由，修库分享链接打不开（后端生成 `/share/<token>`，前端只注册了 `/join/<token>`） |
| `a943cff` | 设置页内容区守卫口径统一为 `effectiveSection`，修非 owner 直访 search 时右内容区空白 |

**P2 / P3 与体验**

| 提交 | 内容 |
|---|---|
| `4f794e3` | UI 重构收尾 · 三条 P3 可访问性修复 |
| `73156e9` / `bce74d4` | 五类实体自定义图标 + 颜色（迁移 **#25** `20260919102128_entity_icon_ddl` + 四端点校验 + DTO 透出 + 前端统一选择器） |
| `f610c73` / `d3ae063` / `ea8f038` | 实体图标「恢复默认」真正清色、未自定义时色板高亮、弹层改走 Popover fixed 防被 Modal 裁剪 |
| `32c3c6e` | 数据表页可改图标 + 颜色；KB 首页行菜单走 portal 防裁剪 |
| `32d6773` | 数据表区域精细化（行高 / 表头 / 内边距 / 对齐 / 状态与优先级 / 空值对齐参考图） |
| `3f0adcf` | 附件在网格与详情 / 抽屉可点击下载（消除三处各写一份的分叉） |
| `f161b94` | 表单视图不再引导到不存在的设置项，补上真正的表单配置入口 |
| `ddd106f` | 表单设计器保存失败不再谎报「已保存布局」 |
| `88fce6f` | 选项卡拖进选项卡改为显式拒绝，不再静默落到表单末尾 |
| `6efedf4` | 修正清空表 / 删库两处与后端恢复能力相悖的文案与确认级别 |
| `74e8382` | 部门菜单新增「添加已有成员」入口（复用 `assignDepartments`，已在本部门前端去重） |
| `7287dd6` | 语义检索远端配置补齐 provider / 维度 / 并发重试 / 总门覆盖 + 测试连接 |
| `6cec628` | 后台配置改造：语义检索总门变量化 + MCP 令牌权限继承签发者 |
| `d90c058` | L1 规划入口下线 + 新数据源补测试 |

**文档**：`853e3d3`（UI 重构阶段 0-5 全量落地与两轮验收结论）、`7aad0ef`（窄屏 P1 修复与两个真实断链缺陷）、`f4d8459`（验收后资源清理清单与 swap 根因）、`7ccfe62`（精修轮菜单 + 表格对标参考图落地记录）。

---

## 二、已知问题

**唯一清单：根目录 [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)**（本文件不复述条目）。

- 条数与级别分布以 `KNOWN-ISSUES.md` 主表标题行的**实时统计**为准（本文件不复制数字，避免漂移）。
- 它是**回归测试 checklist，不是缺陷跟踪系统**：发版前按主表「模块 + 复现要点」逐条走一遍。
- 新发现问题追加到主表，编号顺延，填满发现时间 / 修复时间 / 修复版本号 / 修复 commit 四列；拿不准写「待确认」，**不许编**。
- §二「误报 / 撤销 / 重定性」不是缺陷，别重复修；§三「历史遗留注意事项 / 已知坑」改相关模块前先读。

---

## 三、部署要点

| 项 | 要求 |
|---|---|
| **Node 版本** | **22 是硬要求**（飞牛 `nodejs_v22`；Docker 基础镜像 `node:22-bookworm`；本机开发 ≥20）。更换 Node 大版本必须重装依赖并复验。**详见 `docs/deployment/README.md` §2.4「Node 版本硬约束」** |
| **原生依赖** | `better-sqlite3 ^13.0.3`（`apps/api/package.json`），跨平台 prebuild 按 Node ABI 匹配——**换 Node 大版本必须重装依赖并复验**，否则原生模块加载失败 |
| **子路径部署鉴权头** | 飞牛网关会吞 `Authorization`，应用 JWT 改用自定义头 **`X-GX-Token`** 携带；服务端 `resolveActiveAuth` 先取 `Authorization: Bearer`，再回退 `X-GX-Token`（可带或不带 Bearer 前缀）。见 `docs/baseline/gate6-evidence/2026-09-18-fnos-fpk-0.1.1-delivery.md` |
| **部署形态** | 裸机 systemd / Docker / 飞牛 fpk（子路径 `/app/gouxiangdb`）三选一，见 `docs/deployment/` |
| **首次超管** | 见 `docs/deployment/first-admin-init.md` |

> **故障现象提醒**：Node 20 下不是报普通模块错误，而是进程直接 **SIGSEGV 崩溃**（原生模块 ABI/NAPI 档位不匹配），排查时极易误判为内存/磁盘/SQLite 文件损坏。**详见 `docs/deployment/README.md` §2.4「Node 版本硬约束」**。

---

## 四、升级注意

1. **迁移必须停服务执行**：`pnpm --filter @gx/api run db:deploy`（`prisma migrate deploy`）。`migrate dev` 为交互式，非交互环境禁用。
2. **迁移纪律：只增不删**（不删列、不改列类型），回填幂等可重跑。当前迁移目录 **38 个**（含 entity_icon / 组织 / nav / view_admin_config / view_user_prefs 等）。
3. **升级前先做在线快照**：`pnpm --filter @gx/api run backup:online`，并用 `backup:verify` 验证可恢复；回滚窗口 30 分钟内。
4. **升级后须跑 nav path 重算**：部署链路在 `migrate deploy` 之后接 `dist/cli/nav-reconcile.js`，失败必须在切换前 die —— 否则升级后导航失效（M7 AC-UPG-1 前置）。
5. **权限引擎默认不生效**：`AUTHZ_ENFORCE_READY = false` 且 `GX_AUTHZ_ENGINE` 默认 `off`，实际走旧三表决策，权限管理页只读。生产建议由部署侧显式设 `shadow`；翻 `on` 需满足五条前置且**仅由项目总监下令**。详见 README 文首警示与 `docs/runbooks/authz-engine-flip-on.md`。
6. **健康检查**：升级后确认 `/healthz` 与 `/readyz`（含迁移对账 / 磁盘 / WAL 探针）。

---

## 五、相关文件

| 想找什么 | 去哪 |
|---|---|
| 快速上手 / 技术栈 / 目录结构 | [`README.md`](README.md) |
| 已知问题 / Bug 回归清单 | [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) |
| 待裁决事项（含瘦身清理项） | [`PENDING-DECISIONS.md`](PENDING-DECISIONS.md) |
| 历史文档归档索引 | [`ARCHIVE-LOG.md`](ARCHIVE-LOG.md) |
| 部署细则 | `docs/deployment/` |
| 运维手册 | `docs/runbooks/` |
| 接口契约 | `docs/api/openapi.yaml` |
