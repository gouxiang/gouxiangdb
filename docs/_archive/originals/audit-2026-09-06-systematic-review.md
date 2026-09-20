# GouXiangDB-v2 系统性复盘报告

> 日期：2026-09-06
> 方法：4 路并行深度审计（前端 UI/交互、后端 API/数据、权限/隔离、模块架构），全部基于真实代码逐行阅读，附文件:行号。
> 分级：【严重问题】崩溃 / 数据丢失 / 越权 / 安全漏洞；【建议改进】功能缺陷 / 一致性 / 性能；【体验优化】规范 / 可维护性。

---

## 一、严重问题（P0，必须修复）

### 安全 / 越权（后端）

| # | 问题 | 位置 | 场景与影响 |
|---|------|------|-----------|
| A1 | **JWT 无过期 + 密钥硬编码默认值** | `apps/api/src/auth.ts:10,37` | token 永久有效、无 exp；生产漏配 `JWT_SECRET` 时用公开默认密钥可伪造任意用户。整个认证体系可被绕过 |
| A2 | **关联字段 relatedTableId 不校验同 Base** | `routes/fields.ts:100-152`、`domain/fieldService.ts:154-212`、`fieldValidation.ts:53-148` | creator 在自己 Base 建 links 字段指向**别人 Base 的表**，服务端在受害者表内写反向字段，并经 hydrate/lookup 读回他人记录。跨租户数据泄露 + 结构污染 |
| A3 | **写 linkRow 不校验目标记录归属** | `routes/records.ts:62-89`（writeLinks）、读取 `hydrate.ts:402-423` | editor PATCH 自己记录时 links 填**任意 Base 的 recordId**，即可链接并经 title/lookup/rollup 读出受害者记录内容。最直接 IDOR |
| A4 | **CSV 导入仅需 canEditData 却能新建字段** | `routes/records.ts:523-597`（guard 527，建字段 562） | editor 放任意新列名 CSV 即批量建字段，绕过 canManageSchema。垂直越权 |
| A5 | **回收站恢复表/字段仅需 canEditData** | `routes/records.ts:672-715`（field 687 / table 703） | editor 可恢复 owner 删除的整表/字段，抵消结构管理决策。垂直越权（删要 schema 权限，恢复却不要） |
| A6 | **知识库可授 owner 角色、可踢 owner / 自移除** | `routes/kb.ts:192-226`（enum 198 含 owner；delete 221 无保护） | 加他人为 owner 后被反踢；owner 自移除导致知识库无 owner 变孤儿。Base 侧有保护，KB 侧缺失 |
| A7 | **personal 视图无 per-user 隔离，viewer 可改** | `routes/views.ts:129-158`（139-142）；`schema.prisma:162-176` View 无 userId | personal 视图所有成员共享一条记录，且任何角色（含 viewer）可 PATCH 改名/配置/锁模式。水平越权 |
| A8 | **bulk-delete 的 linkRow 清理未限定表/Base** | `routes/records.ts:476-482` | ids 混入他人记录 id，记录软删被 tableId 挡住，但 linkRow.deleteMany 全局删，可物理删除他人关联关系。跨租户破坏 |
| A9 | **CORS 反射任意 Origin + credentials** | `apps/api/src/index.ts:21-28` | 任意网站跨域带凭证请求被放行。应白名单 |

### 数据正确性（后端）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | **PATCH 记录"先写入后唯一校验"** | `routes/records.ts:420-423`（写 420，校验 423）；bulk 500-501 | 唯一冲突时数据已落库才返回 409，唯一约束被破坏。校验应前置 |
| B2 | **公式链式引用按字段顺序求值，拓扑排序是死代码** | `domain/hydrate.ts:164-170`（实际）vs `192-236`（computeFormulas 从未调用） | A 公式引用后序字段 B 时取到 null，结果随字段排列顺序变化。文件注释承诺的 Kahn 拓扑未接线 |
| B3 | **脏 FilterNode 导致整表 500** | `packages/shared-types/src/filter.ts:227-235`；写入 `views.ts:18,151`、`fields.ts:63` 无结构校验 | 视图 config.filters / 字段 recordFilter 缺 children/child 时 `node.children.length` 抛 TypeError，冒泡到 app.onError，整表列表/详情全 500 |
| B4 | **软删硬删 link_row，回收站恢复后关联永久丢失** | `records.ts:452-456,480-482`、`tables.ts:355-364`、`fieldService.ts:384-386`；恢复 `records.ts:680,688-699` 不恢复 linkRow | 删记录/清表/删关联列后恢复，记录/字段回来了但关联全空。软删设计目标（可恢复）自相矛盾 |
| B5 | **bt（多对一）基数约束可经反向写入绕过** | `routes/records.ts:62-89` | 反向 hm 字段写链接时只清本记录的行，可让一条"多侧"记录同时挂多个"一側"父，违反 bt 基数 |
| B6 | **subtable 未计入 computed 类型集合** | `domain/types.ts:156`（COMPUTED_TYPES 缺 subtable） | subtable 语义同 links 却被当物理字段，靠各调用点零散特判维持正确；CSV 导入等路径可能把关联 ID 写进 fields JSON |
| B7 | **count 快速路径未过滤已删记录** | `domain/hydrate.ts:567-571` | 无 filter 时直接返回 linkRow 数，软删记录未排除，count 比 lookup/rollup 偏大 |
| B8 | **关键多表写操作无事务** | 建表 `tables.ts:72-121`、建关联字段对 `fieldService.ts:167-206`、删字段级联 `370-401`、KB 文档+快照 `kb.ts:270-285,340-349` 等 | 中途失败留脏数据（有表无主字段、正反字段不互指、快照缺失）；快照并发撞 `@@unique([docId,version])` 500 |
| B9 | **全局搜索未过滤已删字段** | `routes/search.ts:71-74` | 已删字段的历史值仍被命中并作为 snippet 返回 |

### 前端崩溃 / XSS / 断链

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| C1 | **原子块选中后全局键盘劫持** | `features/kb/WysiwygEditor.tsx:485-510` | 选中图片/分割线后，焦点移到任意输入框按 Backspace，处理器不判断 target 是否在编辑器内，误删文档原子块且输入框退格失效。数据丢失 |
| C2 | **IME 中文输入法下 Enter 被斜杠菜单截获** | `WysiwygEditor.tsx:337-343`、`MarkdownEditor.tsx:360-366` | 不检查 `isComposing`，拼音组词时 Enter/Backspace/方向键被劫持，候选词无法上屏 |
| C3 | **存储型 XSS：markdown 链接 javascript: 协议** | `features/kb/blocks.ts:97-98`（inlineMdToHtml 无协议白名单）；点击委托 `lib/internal-links.ts:41` | `[x](javascript:alert(document.cookie))` 在编辑器/单元格点击即执行，偷 token 调 API |
| C4 | **存储型 XSS：richText 字段原样 innerHTML** | `features/cells/CellRenderer.tsx:148-159` | richText 存 `<img src=x onerror=...>`，网格渲染即执行 |
| C5 | **全应用无 ErrorBoundary** | `main.tsx:23-32`；抛错点 `blocks.ts:585`、`WysiwygEditor.tsx:1024` 等 | 任一单元格/文档脏数据导致整页白屏 |
| C6 | **内部链接/全局搜索跳记录后详情不打开（断链）** | `lib/internal-links.ts:30`、`SearchDialog.tsx:86` 生成 `?record=`，但全前端无代码读取该参数（ViewRouter 只认 sessionStorage） | 从 Cmd+K 点记录落到表格页但抽屉不开、无定位，用户不知点了哪条 |
| C7 | **callout/toggle 块内 Enter/Backspace/快捷转换损坏结构** | `WysiwygEditor.tsx:935-995` 配合 splitBlock 365 / mergeOrDemote 411 / shortcut 302 | 提示块正文回车后半句逃出块外；行首 Backspace 把整块降级为段落丢失样式；`# ` 把整块转 h1 |
| C8 | **401/token 失效无全局处理** | `api/client.ts:75-90`、`store/auth.ts` | token 过期/被踢后所有请求 401，无自动登出跳登录，用户卡在报错态 |

---

## 二、建议改进（P1）

- **D1 单条读/写触发全表 hydrate**：`records.ts:253,397,438` 改一个单元格就 `queryRecords({noPaging:true})` 全表水合再 find 一条；应改用 `hydrateRecord(单条)`。性能生命线。
- **D2 N+1 查询 / 全表内存计算**：hydrate 每 links/lookup/count 字段单查、用户名逐条查；搜索每表 take:2000 内存 includes；assertUnique 全表扫描。需批量预取 / FTS / 预算控制。
- **D3 字段重名不校验 + 公式按名引用不随改名更新**：`fieldService.ts:239-356` update 不查重名；公式 `{字段名}` 改名后静默变 null，重名后错绑。
- **D4 lookup/rollup/count 只看对端物理存储**：`hydrate.ts:517-527,577-582` 指向对端计算字段时静默失效。
- **D5 分享 token 用 Math.random()**：`bases.ts:343` 非加密安全，应 crypto.randomBytes。
- **D6 auth 路由裸 c.req.json()**：`auth.ts:23,50` 非法 JSON body → 500（其它路由都有 .catch）。
- **D7 KB 文档 content 无大小上限**：`kb.ts:335` 仅 z.string()，dataURL 媒体 + 快照全量复制，单文档可膨胀至数百 MB。
- **D8 后端 domain/types.ts 与 shared-types 大面积重复定义**：FieldType 28 项、LinkRef、FieldValue、分类集合手写两份已漂移（FieldValue 成员不一致、recordFilter 类型后端放弃为 unknown）。
- **D9 KB DTO 定义在前端 client.ts**：脱离 shared-types 契约唯一真源，后端返回内联字面量无编译对齐。
- **D10 useDocPersistence 裸 fetch 硬编码 /api**：`useDocPersistence.ts:100-117` 绕过 client.ts 和 BASE_URL，跨域 API 配置时卸载保存静默失败。
- **D11 知识库无内容乐观锁**：`kb.ts:330-354` 直接 update content，多人/多端最后写覆盖无提示（前端 staleTime 5min 故意不失效）。
- **D12 routes 层堆积领域逻辑**：writeLinks/applyFieldWrites/assertUnique/KB 权限子系统应下沉 domain；KB RANK 与 shared-types ROLE_RANK 两套数值。
- **D13 跨 feature 网状互引**：detail↔views↔designer↔drawer 互相 import 内部组件，field-controls 实为共享件却放在 views。
- **D14 前端 MdContent inline 无 memo**：`components/MdContent.tsx:28-42` 网格每行 longText 每次父渲染都全量跑正则；千行卡顿。
- **D15 外链无 target=_blank（编辑器/单元格）**：`blocks.ts:97-98` 点外链当前页跳走丢失未保存状态（预览态 markdown.ts 有）。
- **D16 上传媒体块永远追加到文档末尾**：`WysiwygEditor.tsx:734`，而非斜杠触发位置（源码态按光标插入，行为不一致）。
- **D17 弹窗无 body 滚动锁/焦点陷阱/Esc 多层同关**：`ui.tsx:417-521`、RecordDrawer 与内部 Modal Esc 冲突。
- **D18 SearchDialog 文档项缺 data-idx**：`SearchDialog.tsx:115-144`，键盘选中文档分组时不滚动跟随。
- **D19 validateUpload 无扩展名文件绕过格式白名单**：`upload-limits.ts:102-105`。
- **D20 回收站恢复级联不完整**：恢复字段不恢复同批软删的 lookup/rollup/count dependents。
- **D21 索引缺失**：records 缺 (tableId,deletedAt) 复合索引；link_rows 缺 parentRowId/childRowId 单列索引；kb_docs 缺 deletedAt。
- **D22 错误信息泄漏内部细节**：`guards.ts:102-105` 把 Prisma 异常原文回客户端。
- **D23 单文档 ACL 的 editor 可软删文档但无权恢复**：`kb.ts:356-366` vs 368-383。
- **D24 知识库 trash/成员列表对 viewer 开放**：`kb.ts:405-419,168-190` 泄漏邮箱/已删文档标题。

---

## 三、体验优化 / 规范（P2）

- **E1 硬编码 hex**：`field-controls.tsx:138,371` rating 色、`DetailLayout.tsx:633,879`、`MarkdownEditor.tsx:148` 内联色、`kb.css:515-524` callout 五色无 var；应走 gx-* token。三处 AVATAR_COLORS/DOT_COLORS 重复定义。
- **E2 符号当功能图标（违反 P0）**：`field-controls.tsx:132,140,380` ☑☐★☆、`RecordDrawer.tsx:258` ⊞、`markdown.ts:203` 附件用纯文本 "FILE"；应统一 `<Icon>`。
- **E3 超长文件**（Top）：FormDesigner 1684、WysiwygEditor 1197、formula.ts 943、DetailLayout 895、FieldEditorSheet 797、records.ts 750、GridView 685、ui.tsx 674、blocks.ts 621、hydrate.ts 614。
- **E4 死代码**：`sidebar/BaseSwitcher.tsx`（零引用）、`kb-hooks.ts:135-144 useSaveDoc`、`useToast:18-25`、`void ROLES/tableId/useToast` 抑制语句、根目录 `_tmp_*`、`apps/web/_dist_bak/`、desktop 壳 `main.ts` 仅 void 0。
- **E5 markdown round-trip 有损**（blocks.ts）：表格单元格含 `|` 不转义错列；嵌套列表缩进丢失全变一级；有序列表原编号丢失；软换行 `<br>`→`\n` 语义消失；URL 含 `)` 截断；code/math 内含 ``` / $$ 提前闭合。
- **E6 toggle summary 内 Enter 无处理**：`WysiwygEditor.tsx:938-945` 可插入多行污染标题。
- **E7 斜杠菜单在屏幕底部溢出无翻转**；无匹配结果时 `/query` 残留需删 `/` 重来。
- **E8 权限 UI "隐藏"与"禁用"混用**：多处 `{canX && ...}` 直接隐藏，规范要求禁用+tooltip。
- **E9 API dist 产物结构异常**：tsconfig 未设 rootDir，shared-types 源码被编进 dist，根级与镜像目录并存。
- **E10 类型断言**：前端 134 处、后端 63 处 `as X`，根因是 Prisma 字符串列无字面量类型；建议 db 边界 zod 解析。

---

## 四、修复计划（本轮执行）

**第一批 · 后端安全/数据正确性（P0）**：A1 JWT、A2/A3 跨 Base 关联校验、A4 CSV 越权、A5 恢复越权、A6 KB owner 保护、A7 personal 视图、A8 bulk linkRow 收敛、A9 CORS、B1 唯一校验前置、B3 FilterNode 防御、B2 公式拓扑、B7 count 过滤、B6 subtable 归类、B9 搜索已删字段、D5 分享 token、D6 auth json 兜底。

**第二批 · 前端崩溃/XSS/断链（P0）**：C1 键盘劫持、C2 IME、C3/C4 XSS 消毒、C5 ErrorBoundary、C6 record 跳转、C8 401 处理、D18 data-idx、D15 外链 target。

**第三批 · 数据一致性（P1）**：B4 软删不硬删 linkRow、B5 bt 基数、B8 关键路径事务（择要）、D10 flush 走 client、D16 上传插入位置、C7 callout/toggle 守卫。

**第四批 · 清理（P2）**：E4 死代码、E2 符号图标、E1 关键硬编码色。

每批后跑 typecheck + 单测 + build 回归。
