# GouXiangDB v2 历史 Bug 回归用例集（升级后深度回归依据）

- 日期：2026-09-12
- 基线：`main @ 637eb9d` / tag `v0.1.0` / 分支 `baseline/0.1`
- 用法：每次功能升级/依赖升级后逐条回归；P0 阻断类（RC-01~RC-12、RC-25~RC-30）必须全过；画布类（RC-16~RC-24）在改动 Plait/Drawnix/选区/z 序时必跑。
- 标记：【自】=有单测可直接 `pnpm --filter @gx/<pkg> test`；【API】=接口脚本；【UI】=Playwright/真机；【读】=代码/只读核对。
- 通用前置：dev 已起（api 3001 / web 5173）；测试账号凭据从环境变量 `GX_TEST_EMAIL/GX_TEST_PW` 注入，禁止硬编码。临时数据用后即删。

---

## A. 数据正确性（最高优先）

### RC-01 日期字段 gt/lt/gte/lte 筛选【自】
- 模块：shared-types/filter（D-1）
- 触发：对 date/datetime 字段做"晚于/早于/区间"筛选。
- 修复：toNumber 识别日期形态，按时间戳比较，不走 `Number()`。
- 步骤：构造 `2026-09-10/11/12` 三条记录，筛选 `>2026-09-10`、`<2026-09-12`、区间。
- 预期：命中数分别为 2、1、1；datetime 带时分秒同样正确，不静默为空。对应 `filter-date-multiselect.test.ts`。

### RC-02 多选字段 contains/isAnyOf 按选项 id 命中【自/UI】
- 模块：FilterPanel + filter（D-2）
- 触发：multiSelect 单元格存 option.id，筛选"包含/属于任一"。
- 修复：FilterPanel 对 multiSelect 用 `o.id` 作筛选值。
- 步骤：建多选字段两选项，记录分别选 A/B；UI 选 A 筛选。
- 预期：仅含 A 的记录命中；isAnyOf[A,B] 命中并集。

### RC-03 纯日期 Calendar 不跨时区错位一天（D-3）【UI】
- 模块：CalendarView
- 步骤：把系统时区临时设为西半球（如 America/Los_Angeles），建 `2026-09-15` 纯日期记录，看日历。
- 预期：落在 9-15 当日，不错到 9-14。

### RC-04 CSV 导出公式注入防护（U-5）【API/UI】
- 模块：api/domain/csv.ts、GridView.exportCsv
- 步骤：文本单元格填 `=1+1`、`+x`、`-y`、`@z`、以 Tab/回车开头，导出 CSV 并用 Excel 规则解析。
- 预期：危险前导字符被前导单引号中和，不被当公式执行。

### RC-05 表格单元格 IME 组词/Esc/blur 不重复提交（U-8）【UI】
- 模块：grid/CellEditor
- 步骤：①中文输入法组词中按 Enter（isComposing）②改值后按 Esc ③Enter 提交后再触发 blur。
- 预期：组词中不提前提交；Esc 取消且不 PATCH 草稿；Enter 与 blur 不产生两条 PATCH。

### RC-06 复选框快速连点不产生重复翻转/终态错乱（U-1）【UI】
- 模块：GridView / CheckboxEditor
- 步骤：对 checkbox 单元格快速单击 5 次 + 双击。
- 预期：双击不进入翻转型 editor；在途同方向 PATCH 去重；服务端终值与 UI 勾选态一致。

---

## B. 并发 / 事务 / 数据一致性

### RC-07 KB 文档乐观锁 409（S-1）【API】
- 模块：kb_docs.contentVersion、useDocPersistence
- 步骤：GET 取 version=v；用旧 baseVersion 连续 PUT 两次 content。
- 预期：首次成功 version+1；旧 baseVersion 返回 409 VERSION_CONFLICT + currentVersion；前端保留草稿并提示，不静默覆盖。

### RC-08 SQLite WAL/busy_timeout 生效（U-7）【读/API】
- 模块：api/src/db.ts
- 步骤：重启 API；查 `PRAGMA journal_mode`、`PRAGMA busy_timeout`。
- 预期：wal、5000ms；异字段并发写不轻易 BUSY 500。

### RC-09 CSV 导入行级事务，无半截记录（U-4）【API】
- 模块：routes/records CSV 导入
- 步骤：导入含 1 行非法（如类型不符）的 CSV。
- 预期：非法行整行回滚、不产生部分字段半成品；合法行正常；结果计数准确。

### RC-10 建表/删表/建链多步写事务化（U-9）【API】
- 模块：routes/tables、fieldService
- 步骤：建表后人为在步骤中制造失败（或审查 DbTx 覆盖）；建双向关联字段。
- 预期：表+主字段+默认字段+视图要么齐全要么全无；双向字段配对不残留单向。

### RC-11 bt 正向写多目标明确 400，不静默丢值（U-6）【API】
- 模块：routes/records
- 步骤：对 bt 关联字段一次性写 2 个目标。
- 预期：返回 400（不再 slice 静默取第一个）；写 1 个目标正常。

### RC-12 软删/恢复/级联清理（linkRow/评论/字段）【API】
- 模块：records/fields
- 步骤：删关联行→恢复（restoreLinkRows）；物理删字段；物理删记录。
- 预期：linkRow 软删可恢复；field purge 连带清 `linkFieldId` 的 linkRow；record purge 清 linkRow+评论，无孤儿。

---

## C. 画布 / 知识库编辑器（高耦合区，改动必跑）

### RC-13 只读画布数据层兜底（C-1）【UI】
- 模块：DrawnixCanvas handleAfterInit 包装 board.apply
- 步骤：以只读分享打开含画布文档；焦点在 body 时按删除键/快捷键、尝试拖入、滚轮平移。
- 预期：只放行 set_viewport（平移/缩放可用），拒绝一切数据变更 op；库不被改写。

### RC-14 关联卡内嵌画布 canvas-embed 正常挂载（C-2）【UI】
- 模块：RefEmbedBody + enhanceCanvasEmbeds
- 步骤：在画布里关联一篇"内含画布引用"的文档，看关联卡/预览。
- 预期：嵌入画布真实渲染（非 220px 空白块），嵌套一律只读。

### RC-15 预览增强 root 不泄漏（C-3）【UI】
- 模块：MarkdownEditor/enhanceEmbeds cleanup
- 步骤：反复"编辑→预览"20 次，观察 detached 节点/监听/body 游离浮层与内存。
- 预期：每次 cleanup 卸载独立 root，无线性累积、无 body 游离 UI、无 React 警告。

### RC-16 嵌入只读小画布打开即 fit（C-4）【UI】
- 预期：文档内嵌入画布打开内容居中适配，不停在 origin(0,0)/zoom1。

### RC-17 样式条弹层锚定正确（C-5）【UI】
- 模块：NodeStyleBar（shape/line 分支 id 去重）
- 步骤：同时选形状与线，点开填充/描边弹层。
- 预期：弹层锚到实际触发按钮，不串到后渲染的同名按钮。

### RC-18 弹窗内编辑画布/文档关闭有脏确认（C-6）【UI】
- 模块：DocEditModal/CanvasEditModal requestClose
- 步骤：弹窗输入脏内容后按 Esc/点遮罩/点关闭。
- 预期：弹出未保存确认；取消保留、确定保存/丢弃符合选择，不静默丢内容。

### RC-19 DocRefCardNode 不在渲染期 setState（C-7）【UI/读】
- 步骤：删除/取消关联节点，观察控制台。
- 预期：无"渲染期 setState"警告/循环。

### RC-20 LinkBlockForeignObject observer 合帧（C-8）【读/UI】
- 预期：多关联块拖拽时每帧每 FO 最多一次检查，无 O(N²) 风暴；g 缺失不无限轮询。

### RC-21 z-index 全部走 token（C-9）【读/UI】
- 步骤：grep 裸 `z-[数字]`；关联块拖到左上角(36,36)。
- 预期：无裸值；entry50<block60，"关联"入口不被关联块盖；版本抽屉内 fixed 工具条不溢出。

### RC-22 脑图子节点右键样式/重排反馈（C-10）【UI】
- 步骤：右键脑图子节点改样式；对不可重排子节点按 ⌘]。
- 预期：能选中并改具体子节点（不按根包围盒选整根）；不可重排时有反馈，不静默 return。

### RC-23 WebKit 负 viewBox 关联卡不白卡【UI/Safari】
- 模块：补偿 g `g[data-gx-link-comp]` + FO 坐标 cardVb-vbOrigin
- 步骤：用 Playwright webkit 引擎，平移画布使 viewBox 原点为负，插入/查看 HTML 关联卡。
- 预期：卡片完整栅格化（非整树白屏）；zoom/scroll 后位置仍正确。（Chromium 为对照应始终正常）

### RC-24 画布右键菜单不被 globalPointerUp 清选区【UI】
- 模块：浮层 `menuClassName="plait-board-attached"`
- 步骤：选中元素→右键→点 portal 到 body 的菜单项。
- 预期：操作作用于原选区且不弹"未选中"误 toast。

### RC-25 插入关联卡定位：空画布首张也在可见区网格【UI】
- 模块：canvas-ops insertLinkBlock（3×2 网格，cycle +60px）
- 步骤：空画布连插 6 张；第二轮再插。
- 预期：6 张按 3×2 可见区网格分布不重叠；第二轮整体多移 60px；无卡片飘屏外被裁切。

---

## D. 健壮性 / 安全 / 协议

### RC-26 媒体 URL 白名单 + align 往返（E-1）【自/API】
- 模块：renderMarkdown isSafeUrl、blocks align 注释协议
- 步骤：①视频/音频/PDF src 给 `javascript:`、`data:text/html`；②align=center/right 走 blocksToMd→mdToBlocks→render。
- 预期：危险 URL 降级为转义文本；align 序列化为 `<!-- align:X -->` 且三端识别、往返保持、注释不泄漏到正文。

### RC-27 附件容量与内容长度上限（U-3/U-10）【UI/API】
- 预期：单附件 >2MB 或单格 >20 个被拦截并 toast；公开写 >2MB、内部写 >10MB 返回 4xx；500 不回传内部 message（仅 dev 附带）。

### RC-28 DATEADD 纯日期与时区、defaultNow 本地墙钟（U-10）【自】
- 步骤：纯日期 `DATEADD(date, n)` 跨月/跨年/零天/非法；新建记录默认日期时间。
- 预期：返回纯日期形态不升级为 datetime、不跨日；默认时间为本地墙钟（UTC+8 凌晨不记成昨天）。

### RC-29 创建期必填校验与 draft 豁免【自/API/UI】
- 模块：routes/records、required-create.test.ts
- 步骤：①POST /records 缺必填（非草稿）②带 `draft:true` 从 Grid/详情/画廊/看板/抽屉新建 ③Form/DetailLayout 显式提交。
- 预期：严格态缺必填 400（跳过计算/系统字段；autoNumber 有规则、static 默认非空豁免）；draft 放行；显式提交仍严格。

### RC-30 公开分享鉴权与引用闭包【API】
- 模块：routes/public、buildShareReferenceClosure
- 步骤：用只读分享 token 访问闭包内/越界 doc/ref；尝试写。
- 预期：闭包内（BFS 深 3 ≤50 防环）只读 canEdit=false 可访问；越界 403；已删 404；匿名写受 2MB 限。

---

## E. 公式引擎（2026-09-12 重构后契约）

### RC-31 无跨表专用函数，统一点引用【自/API】
- 模块：api/domain/formula
- 步骤：公式里写 `LINK_VALUES(...)`/`LINK_FIRST/LINK_LAST/LINK_COUNT`；正常写 `SUM({子表.金额})`。
- 预期：LINK_* 抛 FormulaError 并给迁移指引；点引用 0 条→null、1 条→标量、多条→list。对应 cross-formula.test.ts 20 例。

### RC-32 SUM/AVERAGE/MIN/MAX 多子记录正确，不把列表 join 成串【自/API/UI】
- 步骤：子表金额建 100、200 两条，父公式 `SUM({明细.金额})`；纯文本列 SUM；空关联。
- 预期：多子记录 SUM=300（旧 bug 曾得 0）；纯文本 SUM=0 不 NaN；空→0/null 符合函数语义。

### RC-33 点引用可读子表 lookup/rollup/公式字段（嵌套 hydrate）【自】
- 预期：`{子表.子公式字段}` 经 getMergedCached 取到完整 hydration 值；循环点引用（A↔B）置 null 不无限递归。

### RC-34 运算边界：null/除零/空 CONCAT/自引用【自】
- 预期：`- * / %` 遇 null 或除零→null（非 Infinity）；CONCAT null→空串（无 "null" 字样）；自引用按 null 不死循环。

### RC-35 默认值公式与公式字段两入口结果一致 + 即时反向重算【API/UI】
- 模块：defaults.ts applyReverseDefaultsForChild/applyLinkChangeDefaults、evaluateRecordFormula
- 步骤：数字字段"默认内容→通过公式计算"设 `SUM({子表.金额})`；详情改子表数字/增删子表行/删子记录；bt/links 增删。
- 预期：默认值落库随子表变化反向重算；records 写响应含 `affectedParents:[{tableId,recordId}]`，前端 invalidateAffectedParents 失效父表；五处写路由（POST/PATCH/DELETE/bulk-update/bulk-delete）均挂载。

### RC-36 默认值公式弹窗能选到子表字段（2026-09-12 修复）【UI】
- 模块：FieldSettingsPanel/FieldEditorSheet → DefaultValueEditor.selfFields
- 步骤：同表存在 subtable 时，打开数字字段"默认内容→通过公式计算"弹窗，看中栏。
- 预期：中栏含子表分组（可展开插 `{子表.字段}`），与"公式字段"编辑器候选一致。
- 回归断言：调用方必须传 `formulaFields`（只剔 tabs、保留 subtable），不能误传 `selfMatchFields`（会剔掉 subtable）。

### RC-37 FIRST/LAST 与常规聚合函数吃 list【自】
- 预期：FIRST/LAST 对 list 取首/尾、单值原样、空→null；CONCAT/LEN 对 list 行为确定。formula-functions.test.ts 86 例全绿。

---

## F. 环境 / 构建回归（每次提交/换机）

### RC-38 全量质量门【自】
- 步骤：`pnpm -r typecheck`；`pnpm --filter @gx/shared-types test`（56）；`pnpm --filter @gx/api test`（214）；`pnpm --filter @gx/api build`；`pnpm --filter @gx/web build`。
- 预期：typecheck 0 错；56、214 全绿；两构建成功（chunk 体积告警可接受，见 R7）。

### RC-39 换机冷启动【手册】
- 步骤：新机器 clone → `pnpm install` → `cp apps/api/.env.example apps/api/.env`（设 JWT_SECRET/相对 DATABASE_URL）→ `pnpm db:migrate`(deploy) → `pnpm dev`。
- 预期：api 3001 `/api/health db:ok`、web 5173 可登录；无需任何仓库外文件或绝对路径。

### RC-40 升级 @plait 依赖后补丁重放【手册/UI】
- 步骤：升级 drawnix/@plait 后重放 `patches/@plait__draw@0.89.2.patch`，`rm -rf apps/web/node_modules/.vite`，跑 RC-13~RC-25。
- 预期：连线手势守卫补丁在位；画布选区/z序/关联卡/WebKit 渲染无回退；不直接 import `@plait/mind`。

---

## G. M3 统一导航资源树（新壳 / 菜单引用层，2026-09-15 追加）

> 口径：M3 只换"工作区外壳 + 一级/二级导航"，内容 URL 与正文数据零变化（裁决 2/ADR-0028）。
> 自动化用例分布：`ac-m3-1.test.ts`（17）、`nav-window.test.ts`（11）、`n5-new-shell-links.test.ts`（20）、
> `menu-tree.test.ts`/`menu-ops/collection` 既有集；无 jsdom，组件点击项走【手册】。

### RC-41 旧链接在新壳下逐条可达（N5）【自/UI】
- 步骤（自）：跑 `n5-new-shell-links.test.ts`——navNodeHref 五 kind 输出 `/base/:id`、`/kb/:id/(doc|canvas)/:d` 旧形，view/group/祖先缺失返 null；App.tsx 7 条旧路由仍声明；SearchDialog 三类结果、DocRefCard/GxLinkBlockView/RefEmbedBody、ShareJoin、TopBar/ViewTabs、LibrarySwitcher 源码守卫仍 navigate 旧形；编辑器内不允许手拼 `/base//kb/`，一律经 `internalHref` 单一真源。
- 步骤（手册）：真机逐点点击——全局搜索三类结果回车落地；画布关联卡跳转与 LinkBlock 双击；文档正文内链 SPA 跳转不整页刷新；分享接受后进 base；表页面包屑（库名/表名）与视图 Tab；库切换器 base/kb 四入口。
- 预期：URL 与换壳前逐字符一致（含 `?record=`），无 `/w/node` 新形，无 404；`/s/:token` 公开页不被内部点击委托吞掉。

### RC-42 菜单引用层写操作不改实体归属（多处挂载）【自/API】
- 步骤（自）：跑 `ac-m3-1.test.ts` #1——同一 table shortcut 挂 3 个容器，diff 仅含 insert；每个菜单 op 断言无 `newParentId/confirmed/resourceId` 字段；跨容器菜单移动/删菜单引用后，权威树实体 parentId 不变。
- 步骤（手册）：真机把一张表"添加到导航"到两个库容器，打开两处均可达；在编排里删掉其中一处引用，另一处与表本体仍在。
- 预期：菜单增删改排只写 menu_items，nav_nodes 归属零变化（ADR-0026）。

### RC-43 三态可见性：soft_dangling 双态隐藏 / broken 仅编排态显灰 / 源恢复自动还原【自/UI】
- 步骤（自）：跑 `ac-m3-1.test.ts` #2/#3——soft_dangling 浏览态不可见且未收纳计数 +1；编排态视图层同样过滤、但 draft 全量镜像保留（保存不产生误 delete）；源恢复 alive 后 menu diff 为空（引用非重建）。broken 浏览隐藏、编排显灰可清理；shortcut `node=null`（物理消失）编排态保留显灰；容器恒判 alive；只有手动移除才产 delete op。
- 预期：软删不误伤菜单、恢复不需重挂；broken 不污染浏览态但能在编排里被发现清理。

### RC-44 二级三分区随菜单 patch 迁移（收纳/退收纳/子树收集）【自】
- 步骤（自）：跑 `ac-m3-1.test.ts` #4——insert 后未收纳→已收纳计数迁移；delete 回退后"全部"视角实体仍在；多处挂载删一处仍收纳、全部删净才退；后代容器引用经 `collectedUnderSubtree` 被根容器收集。
- 预期：三视角计数恒等式（全部 = 已收纳 + 未收纳，按 C4 口径）在任意菜单 patch 后成立。

### RC-45 权威移动必经 move-impact + 409 确认【自/手册】
- 步骤（自）：跑 `ac-m3-1.test.ts` #5——409 且 `code=MOVE_NEEDS_CONFIRM` 且带 impact 时 extractMoveImpact 返 impact 弹确认；409 他 code、缺 impact、403/500/网络错误均返 null 走 toast。
- 步骤（手册）：真机"移动到分组"触发影响面弹窗（子树项/受影响用户/shortcut 数），取消不移动，确认后才落库；菜单编排里的拖动不触发该弹窗（那是引用层重排）。
- 预期：未带 `confirmed=true` 的权威移动被后端 409 拒绝，前端不绕过。

### RC-46 大菜单首屏 DOM 有界（窗口化）【自/手册】
- 步骤（自）：跑 `nav-window.test.ts`——挂载行数 = `ceil(vh/rowH)+2*overscan`，1k/10k/100k 菜单同为 ≤49 行（一级 32px ≤48、二级 31px ≤49）；折叠容器只留自身行；首帧保守视口 `rowH*24` 即有界；滚到真实底部 end=total、padBottom=0。PrimaryNav/ComposerTree/SecondaryNav 源码守卫挂 `scrollerRef` + 渲染 `virt.windowed`，hook 复用 M2 `virtualWindow`、ResizeObserver + passive scroll 接线齐全。
- 步骤（手册）：1000+ 菜单夹具下滚动一级/编排树/二级未收纳列表，DevTools Elements 检查行 DOM 数不随总量膨胀、滚动条高度正确、快速滚动无白屏久留、折叠容器后行数立即收敛。
- 度量口径：Node `performance.now()` 仅夹纯算术（1k ≈0.3ms、10k ≈15ms，挂载恒 48 行），**不是浏览器 P95**；浏览器交互/渲染耗时以真机 Performance 面板为准。
- 预期：DOM 节点数与菜单项总量解耦；窗口化重构后 RC-41 点击、RC-43/44 行为不回退。

---

## 附：回归优先级建议
- 每次提交：RC-38（自动）+ 当次改动域。
- 阶段升级收尾：A/B 全部（RC-01~RC-12）+ E 公式（RC-31~RC-37）。
- 动画布/Plait/编辑器：C 全部（RC-13~RC-25）。
- 动分享/鉴权/附件/构建：D（RC-26~RC-30）+ F（RC-38~RC-40）。
- 动工作区外壳/导航/菜单树：G 全部（RC-41~RC-46）；其中 RC-41 的手册点击项在任何路由/外壳改动后必跑。
