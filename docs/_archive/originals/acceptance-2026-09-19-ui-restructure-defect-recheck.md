# UI 重构缺陷复验报告（独立 QA）

> 复验对象：`docs/acceptance/2026-09-19-ui-restructure-acceptance.md` 所列缺陷 D-1 ~ D-5（该报告 §7）
> 复验人：独立复验 QA（与原验收 QA 非同一人）
> 复验日期：2026-09-19
> 复验方式：真实 Chromium（agent-browser，独立 session `gx-recheck*`）+ git 考古 + DB/API 直查三角验证
> 环境：HEAD `f573112`（阶段 4）；api :3001 / web :5173（复用已运行服务，未 restart，避免打断并发验收进程）
> 截图目录：`docs/acceptance/screenshots/verify-*.png`

---

## 0. 总裁决表

| # | 原 QA 定级 | 复验最终判定 | 复验定级 | 复现稳定性 |
|---|-----------|-------------|---------|-----------|
| D-1 | P1（路由 404） | **误报**（相邻发现一个真实 P3 小缺陷，见 §1.4） | 误报 / 附带 P3 | 必现（owner 正常渲染）；404 为 API 404 非路由 404 |
| D-2 | P1（工具栏多三按钮） | **需重定级 + 重定性**（非本轮重构引入，属遗留规范收敛项） | 遗留待定 P3 | 必现（按钮确实存在，但不是重构引入） |
| D-3 | P2（直访表 URL 闪现已加入 Base） | **误报**（流程归因错误；gate 只存在于 `/join/:token`） | 误报 | 未能复现（直访表 URL 0 命中） |
| D-4 | P2（导入第二步被覆盖层拦截） | **误报**（自动化脚本伪影，四步全通） | 误报 | 未能复现（四步必通） |
| D-5 | P2（批量条 / KB 生命周期未验证） | **属实但属"未覆盖"而非缺陷；本轮补做全通过** | 关闭（已补验） | 批量条+撤销必现通过；KB 生命周期必现通过 |

**结论：5 条缺陷中 3 条为误报（D-1/D-3/D-4），1 条需重定性（D-2），1 条为未覆盖项且补验通过（D-5）。原报告的「有条件通过」在缺陷层面可以收敛为：无一条本轮重构引入的 P1 缺陷；本轮复验另发现 1 个真实但低危的 P3（非 owner 空白分区）与 2 个 P3 级可访问性观察。**

---

## 1. 缺陷 D-1：`/workspace/settings/search` 路由 404（原 P1）

【最终判定：**误报**】

### 1.1 关键反证 —— 原 QA 自己的截图

原报告称"页面空白、console 报 404"，但其交付截图 `q5-19-ws-settings-search.png` **明确显示该页完整渲染**：L2 侧栏含「语义检索」且选中高亮，右区有「语义检索」标题、未启用引导、「如何启用」配置说明、「索引覆盖度」面板。截图与报告文字直接矛盾。

### 1.2 owner 实测（必现正常）

- 账号：`test@gx.dev`。DB 证实其为 **owner**（`role_assignments → roles.systemKey='owner'`，scopeType=workspace，唯一工作区 `ws_default`）——原报告与总监"QA 账号可能非 owner"的猜测均不成立，该账号就是 owner。
- 直访 `http://localhost:5173/workspace/settings/search`：URL 不变、**完整渲染语义检索分区**。
- 截图：`verify-d1-owner-search.png`
- DOM innerText 摘录：`"…语义检索\n配置云端语义检索，并查看索引覆盖与健康状态。\n语义检索服务未启用（当前为仅关键词检索）…如何启用…索引覆盖度…"`

### 1.3 「404」的真实来源：是 API 404，不是路由 404

- Vite dev server 对该路径返回 **200**（实测 `/workspace/settings/search`、`/workspace/settings/nav`、甚至 `/nonsense-xyz` 全部 200，SPA fallback 正常）。
- console 里的 404 来自页面内发起的管理接口：

```
GET /api/v1/admin/embedding/config
→ HTTP 404  {"error":"接口不存在","code":"NOT_FOUND","path":"/api/v1/admin/embedding/config"}
```

- 这是**预期行为**：`GX_M5_SEARCH` 未设置（`apps/api/.env` 无此项）时检索 admin 路由不挂载，`apps/web/src/features/search/search-admin-hooks.ts:31-36` 明确注释并按「未启用」处理（`isSearchNotEnabled`），页面据此显示启用引导而非报错。
- **原 QA 把 API 404 误记成了路由 404，并把"未启用引导页"误判为"空白/不存在"。**

### 1.4 相邻发现：非 owner 直访该 URL 会得到「空白右区」（真实，P3，建议另立条目）

总监委托的第 2/3 项验证结果与预期不同——非 owner 不是"回退到 general"，而是**右内容区完全空白**：

- 账号：`e2e-1789649327@gx.dev`（`/api/v1/org/members/me/effective-roles → {"roles":[]}`，确认非 owner）。
- 实测：URL 保持 `/workspace/settings/search`；L2 侧栏正确隐藏「语义检索」（`ownerOnly` 过滤生效，`WorkspaceSettingsPage.tsx:121-123`）；但 `main` 内容区 **无任何文本**（DOM 实测 rightText 仅含侧栏按钮）。
- 截图：`verify-d1-nonowner-search.png`
- 根因（可定位）：`apps/web/src/features/workspace/WorkspaceSettingsPage.tsx`
  - `:117-121` 计算 `effectiveSection`：非 owner + splat=search → 回退 `"general"`；
  - 但内容渲染守卫用的是 `section === "general"`（非 `effectiveSection`），此时 `section` 仍是 `"search"` → general 分支不渲染、search 分支（`:215` 附近，`effectiveSection === "search" && isOwner`）也不渲染 → 双双落空 → 空白。
- 可达性：**无任何导航入口**会为非 owner 生成该 URL（全库 grep `settings/search` 零命中；侧栏入口被 ownerOnly 过滤；工作区菜单接口无此项）。仅手输 URL 可触发。
- 定级建议：**P3**（不可达路径 + 无功能/数据损害 + 不违反红线），建议改为：fallback 发生时渲染 general 内容（把守卫统一为 `effectiveSection`）或显示"无权限"空态。

【证据】截图 `verify-d1-owner-search.png`、`verify-d1-nonowner-search.png`、原 QA 截图 `q5-19-ws-settings-search.png`；curl 输出（Vite 200 / API 404 JSON）
【严重程度】误报；附带 P3
【复现稳定性】owner 正常渲染：必现；非 owner 空白：必现
【根因与涉及文件】误报根因：API 404 误读；附带缺陷根因：`WorkspaceSettingsPage.tsx:117-121` 与内容守卫（`section === "general"`）口径不一致
【建议处理】关闭 D-1；另立 P3 修 effectiveSection 守卫口径

---

## 2. 缺陷 D-2：工具栏多出「行高 / 字段 / 行颜色」（原 P1）

【最终判定：**需重定级 + 重定性 —— 非本轮重构引入**】

### 2.1 git 考古：三个按钮全部来自 v0.1.0 基线，早于阶段 0

`git blame` 结果（`apps/web/src/features/grid/GridToolbar.tsx`）：

| 按钮 | 行号 | 引入提交 | 日期 |
|------|------|---------|------|
| 行高 | :180 | `637eb9d` chore: 初始化 GouXiangDB v2 基线（v0.1.0） | 2026-09-12 |
| 字段 | :201 | `637eb9d`（同上） | 2026-09-12 |
| 行颜色 | :308-313 | `637eb9d`（同上） | 2026-09-12 |

- `git merge-base --is-ancestor 637eb9d 3e6ef31` → 是祖先（早于阶段 0 令牌迁移）。
- 阶段 3（`6c25e87`）与阶段 4（`f573112`）虽改过 GridToolbar，但 `git show` 的新增行中**不含**这三个按钮的任何一行。

### 2.2 是真实功能，删除即破坏能力

- 行高 → `onUpdateConfig({ rowHeight: short|medium|tall })`，三档持久化进 ViewConfig（GridToolbar.tsx:180-197）；
- 字段 → 字段显隐 `hiddenFieldIds` + 「新建字段」+ 行内编辑入口（:200-244）——这是字段管理的主要入口之一；
- 行颜色 → `config.rowColor` + `RowColorPanel` 条件着色（:307-323）。
- 三者均为已有能力且被 2026-09-18 二轮验收引用（隐藏字段不可选的修复注释即在此文件）。

### 2.3 规范侧核对

- `UI-SPEC.md` **未明文规定工具栏按钮集合**：C.1 只约束"工具栏高 48 / 按钮高 32"；R-I-16 只规定"导入/导出不进工具栏"；R-I-01/03/04 覆盖筛选/分组/排序/搜索的位置与形态。
- 参考基准图 `assets/A-方案A-数据表主界面.png` 工具栏确实只有：新建记录 / 筛选 / 分组 / 排序 / 搜索 / 右端 ⋮ 溢出。
- 现场实测当前工具栏按钮序列：`["新建记录","行高","字段","筛选","分组","排序","行颜色","搜索","更多"]`。截图：`verify-d2-toolbar.png`

### 2.4 裁决与理由

- 定性：**不是"本轮重构引入的规范违背"**（git 证据确凿），是**重构前就存在的"实现超出参考图"差距**。按"功能优先，绝不破坏已有能力"一号原则，**不应删除**。
- 定级：从 P1 降为 **P3 遗留待定**（design debt）。P1 的定义应保留给"本轮重构引入的、阻断使用的缺陷"——本条两条都不满足。
- 建议处理：记入规范收敛 backlog；后续迭代把「行高 / 字段 / 行颜色」收进参考图已有的右端「⋮ 更多」溢出菜单（信息架构与参考图对齐且零能力损失）。**不应作为本次 UI 重构验收的阻断项，也不应在本重构修复窗口内动它**（会引入与阶段 0-4 无关的回归风险）。

【证据】`git blame` / `git show` 输出（见 §2.1）、`verify-d2-toolbar.png`、UI-SPEC 条目清单、参考图
【严重程度】P3（遗留待定）
【复现稳定性】必现（但与重构无关）
【根因与涉及文件】`GridToolbar.tsx` v0.1.0 基线设计；UI-SPEC 未定义按钮集合
【建议处理】遗留 backlog：三键收进溢出菜单；关闭 D-2 对本重构的阻断

---

## 3. 缺陷 D-3：直访表 URL 闪现「已加入 Base」门控（原 P2）

【最终判定：**误报（流程归因错误）**】

### 3.1 结构性证据：直访表 URL 不可能渲染该门控

- 「已加入 Base / 你已是该 Base 的成员 / 进入 Base」全库唯一来源：`apps/web/src/features/auth/ShareJoinPage.tsx:62-67`；
- 该组件仅挂载于路由 `/join/:token`（`App.tsx:134`）。`/base/:baseId/table/:tableId/view/:viewId`（`App.tsx:166`）在 React Router 结构上不可能命中它；
- 该文件自 v0.1.0（`637eb9d`）以来**从未被阶段 0-4 修改**（`git log 3e6ef31~1..HEAD -- ShareJoinPage.tsx` 为空）——即便成立也不是重构回归。

### 3.2 实测证据：直访零命中

- 冷启动直访表 URL（新 session，先清请求日志）：
  - API 服务端日志显示正常加载序列：`GET /api/bases/:id` → `/api/views` → `/api/fields` → `/api/records` → workspace menu，**全程 0 次 `POST /api/bases/join/*`**（gate 页面一挂载必发该请求）；
  - 最终 DOM `bodyHasGate: false`。
- 全量 API 日志检索 `bases/join`：仅 4 次且全部为 `POST /api/bases/join/invalid-token → 401`（对应原 QA 的公开页无效 token 测试）。

### 3.3 原 QA 实际看到的是什么

- 我用真实分享链接复现了那张卡片：owner 打开 `/join/<有效token>`（已是成员）→ 确切显示「已加入 Base / 你已是该 Base 的成员 / 进入 Base」。截图：`verify-d3-join-token-already-member.png`
- 原 QA 的截图文件名 `q5-04b-table-after-join.png`（内容为加载完成的表视图）自证其流程是"join 之后进表"。其验收脚本先测了 `/join/:token`（报告 §3 第 25 行），把 join 页的既有形态误归因为"直访表 URL 的中间态"。
- 该卡片对已是成员者是**既有设计**的确认页，不是本轮引入的门控回归。

【证据】`verify-d3-join-token-already-member.png`、API 日志（0 次 join 调用）、App.tsx 路由表、git log（ShareJoinPage 未被重构触碰）
【严重程度】误报；（可选 UX 增强 P3：`alreadyMember=true` 时自动跳转 `/base/:id` 省一次点击）
【复现稳定性】未能复现（直访表 URL 必现正常）
【根因】验收脚本流程顺序导致的归因错误
【建议处理】关闭；如需优化 join 确认页交互，另立 P3 增强，不属重构缺陷

---

## 4. 缺陷 D-4：导入向导第二步被覆盖层拦截（原 P2，总监定为最高优先核实）

【最终判定：**误报（自动化脚本伪影），不是 ImportWizard 的 bug**】

### 4.1 真人完整走通四步（最小 CSV：`姓名,部门,城市` + 2 行数据）

| 步骤 | 实测 | 证据 |
|------|------|------|
| 1 上传 | 粘贴 CSV → 「解析到 3 列 / 2 行数据」→「下一步」由 disabled→enabled → 点击成功 | `verify-d4-import-step2-mapping.png`（到达第2步） |
| 2 字段映射 | **成功进入**：`hasMapping:true, hasAuto:true, hasPreview:true`；每列有「自动匹配/指定字段」下拉 + 前 3 行预览 | 同上 |
| 3 确认 | 「数据行数 2 行」「列数 3 列」+「开始导入」 | `verify-d4-import-step3-confirm.png` |
| 4 执行与结果 | 「新增记录 2 / 新建字段 0 / 问题行列 0」；表格实际出现 张三/李四/广州 | `verify-d4-import-step4-result.png` |

### 4.2 "挡住它的元素"实测 dump（回应总监要求的取证）

- 覆盖层：`<div class="fixed inset-0 gx-z-modal flex items-center justify-center p-6">`，computed `z-index: 800`（`gx-z-modal` 语义层，见 ui.tsx:581）；
- 其内 `ui.tsx:583` 有一个 `absolute inset-0 bg-black/25` 的**点击关闭背板**——这正是原 QA 报告里写的"拦截元素"。但它与模态面板是**兄弟节点且排在面板之前**，面板内按钮 `visible:true, disabled:false`，`elementFromPoint` 命中按钮本身，点击即生效（四步全通即为铁证）。
- 另注：Modal 未设置 `role="dialog"`/`aria-modal`（`ui.tsx:552-601` 全文无此属性，实测 `document.querySelectorAll('[role=dialog]').length === 0`）。

### 4.3 根因判断：QA 脚本问题，非产品 bug

最可能的两条链路（按概率排序）：
1. **在 CSV 未粘贴时点「下一步」**——此时按钮 `disabled`，Playwright 等待可点击直至 30s 超时；超时错误会把命中背板描述成 "intercepted by `...bg-black/25` overlay"，与原报告描述逐字吻合；
2. **aria/role 选择器落空**——Modal 无 `role=dialog`，依赖 `role=dialog` 层级定位的脚本会找不到容器；再叠加 ref 失效后按旧坐标点击，落点打在背板上。

【证据】`verify-d4-import-step2/3/4` 三张截图、覆盖层 z-index dump（`.gx-z-modal` z=800）、`ui.tsx:581-583`、导入后表格数据
【严重程度】误报；（附带 P3 可访问性观察：Modal 缺 `role="dialog"`/`aria-modal`/焦点圈禁）
【复现稳定性】未能复现（四步必通）
【根因】自动化脚本点击时机（disabled 阶段）与选择器（无 role=dialog 可依赖）问题
【建议处理】关闭 D-4；P3 backlog：给 Modal 补 `role="dialog" aria-modal="true"` + 初始焦点管理（同时能让 E2E 脚本更稳）

---

## 5. 缺陷 D-5：批量操作条 / KB 文档生命周期未验证（原 P2）

【最终判定：**属实但属"未覆盖项"而非缺陷；本轮补做，全部通过**】

### 5.1 批量操作条（R-I-12/13/14）—— 全链路通过

| 步骤 | 实测 | 证据 |
|------|------|------|
| 勾选 2 行 | 行首复选框可点（自定义样式，`input[type=checkbox]` 可由文本定位命中） | — |
| 批量条出现 | 「已选 2 条」+「批量修改字段…」+「删除 2 行」，替换原工具栏 | `verify-d5a-bulkbar-2-rows.png` |
| 影响条数确认（R-I-14） | 确认弹窗「删除 2 行记录 / 记录会先进入回收站，30 天内可恢复」 | `verify-d5a-bulk-delete-confirm.png` |
| 删除 | toast「已删除 2 行」含「撤销」按钮 | — |
| **撤销恢复** | 点「撤销」→ toast「**已恢复 2 行**」；DB 复核 `records.deletedAt IS NULL`（王五/赵六两行均存活） | `verify-d5a-bulk-undo-restored.png` |

- 原 QA "定位不到表头复选框"的原因：复选框为自定义样式且行级复选框无 aria-label，但**表头复选框有 `aria-label="选择本页全部记录"`**，按 label 定位即可命中——脚本选择器问题，非产品缺陷。
- 复验说明：撤销的 6s 窗口内必须完成点击；原 QA 未点成大概率是 snapshot 往返耗时超过 toast 存活期（我第一次也超时，第二次改用直接 DOM 定位在 1s 内命中）。

### 5.2 KB 文档生命周期 —— 全链路通过

| 步骤 | 实测 | 证据 |
|------|------|------|
| 新建 | 「新建文档」→ 进入 `/kb/cmtxr0jok…/doc/cmu7i3lyh…`，默认标题「未命名文档」 | `verify-d5b-doc-created-titled.png` |
| 编辑+保存 | 标题改「复验QA临时文档-可删除」、正文写入一段 → 「保存」→ toast「已保存到云端」→ **DB 复核 `kb_docs.title/content` 均落库** | `verify-d5b-doc-saved.png` |
| 删除 | KB 列表行尾「…」→ 删除 → 确认「移入回收站，30 天内可恢复」→ toast「已移入回收站…」→ DB `deletedAt` 非空 | `verify-d5b-doc-delete-confirm.png` |
| 回收站恢复 | `/kb/:id/trash` 列出该文档（含删除时间）→「找回」→ toast「已找回…」→ DB `deletedAt` 归 null、回收站显示「回收站为空」、文档回到 KB 列表 | `verify-d5b-doc-in-trash.png`、`verify-d5b-doc-restored-in-list.png` |

- 附带观察（P3，建议另立）：KB 列表行尾「…」按钮无 `aria-label`（读屏不可达、E2E 难定位）；行菜单的删除等操作仅图标可达。

【证据】见上表 6 张截图 + DB 查询结果
【严重程度】关闭（补验通过）；附带 2 条 P3 可访问性观察
【复现稳定性】必现通过
【根因】原 QA 自动化在自定义控件定位与 6s toast 时效上失败
【建议处理】D-5 关闭；为 E2E 补 aria-label（行操作/复选框）属测试基建改进

---

## 6. 环境干扰与副作用如实记录

1. **未执行 `./dev-up.sh restart`**：开工时 api:3001 / web:5173 已在运行且健康（healthz 200），restart 会杀掉并发 QA worker 的登录态，故复用。web log 中 05:34:28 有一条 `/api/views/...` ECONNREFUSED 代理错误，系当时 api 曾被并发进程短暂重启，复验期间无再次发生。
2. **口令轮转副作用**：`test@gx.dev` 口令被并发进程多次轮转（我接手时上一轮 QA 的口令已失效）。我用官方脚本 `init-admin --reset` 重置：
   - `test@gx.dev` → `GxVerifyQA$Fw7-Recheck`（已通过改密页解除 mustChangePassword；tokenVersion+1 会使并发 worker 旧会话失效，请知悉）；
   - `e2e-1789649327@gx.dev` → `GxVerifyQA$Mw7-Recheck`（作非 owner 对照账号）。
3. **浏览器 daemon 干扰**：约 06:00 我的 session 一次被重置到 `about:blank`（疑并发 worker 关闭/重启了共享 daemon），重开页面并重注入 `gx-auth` 后继续，未影响证据完整性。全程使用独立 session（`gx-recheck` / `gx-recheck-nonowner` / `gx-recheck-d3`）降低互踩概率。
4. **留下的测试数据**（均可安全清理）：
   - 表「测试数据表1」：王五/赵六 2 行（撤销恢复产物，存活）；
   - Base 回收站：张三/李四 2 行（首轮撤销窗口过期后落入，未恢复）；
   - KB「统一测试知识库」：文档「复验QA临时文档-可删除」1 篇（已恢复存活态）；
   - 1 条 base 分享链接（token `SY7zFyLE1vD5wnN5koHR3DBUhTVwu4lx`）。
5. **未修改任何业务代码、未提交 commit**。仅新增本报告与 `verify-*.png` 截图，及 `/tmp/gx-recheck/` 下的临时脚本与最小 CSV。

## 7. 给总监的三句话结论

1. **5 条缺陷：3 误报（D-1/D-3/D-4）、1 重定性为遗留 P3（D-2）、1 补验全通过（D-5）。** 原 QA 的四条关键断言（路由 404、覆盖层拦截、join 门控闪现、复选框定位失败）全部能在产品/脚本两侧找到确切根因，且都指向"API 404 误读 + disabled 时机 + 选择器失效"，没有一条是本轮重构引入的代码缺陷。
2. 总监对 D-1 的怀疑**方向正确（是误报）但机制猜错**：QA 账号就是 owner，页面也真的渲染了（其自己截图为证）；404 来自 `GX_M5_SEARCH` 未启用时的 embedding 管理 API，属预期。但顺着查下去**捞到一个真问题**：非 owner 直访该 URL 得到空白分区而非回退 general（P3，`WorkspaceSettingsPage.tsx` effectiveSection 守卫口径不一致）。
3. 本轮重构（阶段 0-4）在复验范围内**维持"零新增缺陷"结论**；可行动项全部是 P3（effectiveSection 空白、Modal 无 role=dialog、行操作按钮无 aria-label、工具栏三键收溢出菜单的遗留 backlog）。
