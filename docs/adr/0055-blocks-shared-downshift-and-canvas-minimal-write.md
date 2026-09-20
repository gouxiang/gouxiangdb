# ADR-0055：块模型下沉 shared 与画布最小写入（C-2 终审定稿）

**状态（Status）**：Accepted（M6 计划 §10 第 5 条、§0-7/11、S5/S6b 定稿；C-2 终审判定"画布写入必须进 M6、保 AC-M6-3 P0"；S5 已过块移动门、S6b 已过校验器门、S6b-FE 已过浏览器 golden、S8 已过写入面对抗；2026-09-18 M6 出口归档）
**作者**：架构师 高见远（M6-S9 归档；实现由后端 贝洛奇 与前端 协作落地）
**上游依据**：docs/_archive/originals/planning-phase2-M6-implementation-plan.md §0-7（:23）/§0-11（:27）、§4.5（:220-243）、S5（:388-392）、S6b（:399-407）、§11 C-2（:442）、§12-3（:457）、§10（:430）；SPEC-enterprise §9 AC-M6-3（:127）、§10（:135）；ARCH-enterprise §1.4（Plait 六不变量）、§8.5；docs/baseline/m6-connectivity.md §4.3/§10
**关联**：ADR-0019（总纲三语言与能力说明书）；ADR-0053（画布写走引擎 u 判定）；ADR-0046（record.search 复用 M5——同属"薄封装既有服务"模式）

---

## 1. 背景（Context）

M6 交付文档块语言与画布图元语言，两条线都要复用前端已有的块模型/画布模型，且 AC-M6-3
（SPEC-enterprise :127）要求"AI 按图元语言写入的内容在 Web 端打开结构完整、不破坏 Plait 不变量"——
这是冻结的 P0，**不得在实施切片里悄悄降为只读**（C-2 终审判定）。两个事实约束了实现路径：

1. **块模型纯函数当前在前端**：`apps/web/src/features/kb/blocks.ts`（993 行，`mdToBlocks/blocksToMd/newBlock`，
   全文件 0 处 `document/window/navigator` 调用，已实测纯函数）、`markdown.ts`（473 行）。api 侧要复用
   必须下沉，否则双源实现会漂移。
2. **画布规则长在前端交互代码里**：`apps/web/src/features/kb/canvas/canvas-ops.ts`（747 行）的 Plait
   六不变量逻辑嵌在 `plait` transform 调用中，无现成纯函数可零成本抽；服务端只存取 `content` JSON。

## 2. 决策（Decision）

### 2.1 块模型零行为下沉 `@gx/blocks`（纯移动）

- `blocks.ts` / `markdown.ts` 从 web 特征目录**零行为移动**到 `packages/blocks`（包名 `@gx/blocks`，
  commit `656f9fb`，纯移动 **0 行改动**，git 可追踪 rename），api 与 web 同源消费（web 改 import 路径）。
- 移动前在 web 补 `md <-> blocks` round-trip golden（含表格/任务/align/图片/raw），移动后 api/web 双跑
  同一组 golden **0 diff**。
- doc 四工具（`doc.get_doc_blocks / append_blocks / update_block / delete_blocks`）以 `blocksToMd` 为
  **唯一写出口**，锚 `contentVersion` 乐观锁（复用 `routes/kb.ts` 现有条件更新与 `VERSION_CONFLICT +
  currentVersion` 的 409 机制，不另造）；align 只走注释通道；op≤100 / 批文本≤100KB / 文档 10MB。

### 2.2 画布六不变量数据层规则下沉 `@gx/canvas`（服务端纯函数校验器）

- 把 Plait「六不变量」中的**数据层规则**抽成服务端可消费的纯函数校验器 `packages/canvas`
  （包名 `@gx/canvas`，commit `d1a7a72`；`src/validate.ts` 293 行）：`parseBoardContent` / `validateCreateOps`，
  **零 IO、零 `@plait` 依赖、零 DOM**，Node/浏览器同构。
- 规则集 = 矩形/几何 JSON 形状校验、**id 由服务端生成**（AI 不得自带）、尾插位置、**z 序 = 数组序**、
  `gx*` 自定义键白名单、非 `gx` 普通键**透传不剥离**、硬拒危险键（`id` / `zIndex` / `data-gx-*` /
  `plait-data-id` / 选区态）、整板 ≤10MB。
- 前端 `canvas-ops.ts` 的 DOM/手势/选区/渲染补偿逻辑**留前端**（本片前端一行不改，规则以 shared 为
  唯一真源；是否让前端反向消费由 S9 按真实收益评估）。PlaitBoard 强耦合函数**不硬搬**服务端。

### 2.3 M6 只开 `canvas.commit_elements` 的 `element.create` 最小集

- 工具入参：`{ docId, baseVersion, ops: [{ op: "element.create", element: { type: "geometry",
  shape: "rectangle", points/坐标/尺寸, gxNote? } }], confirm: true }`；执行期 `canvas` 节点 `u` 判定
  （`canvas:write` scope + 引擎 `u`）。
- **最小集** = `geometry/rectangle` 图元 + `contentVersion` 乐观锁 + `confirm:true` 强制 + `requestId`
  幂等；写入路径 = children 数组**尾插**（复用 doc 写同款条件更新，冲突 409 `VERSION_CONFLICT +
  currentVersion`）。
- **完整操作集列二期，未支持操作必须显式返 `UNSUPPORTED_OPERATION` 且不得静默成功**：
  `tools/canvasWrite.tools.ts:22-24` 返回 `isError:true` + `{code:"UNSUPPORTED_OPERATION",
  supported:["element.create"], message}`；`@gx/canvas` 对未开放操作名（`element.update/move/delete/connect`、
  `zorder`）、其它形状（`arrow-line`/`vector-line`…）、含二期 `gx*` 键的元素**整批拒绝**
  （`validate.ts:264-266, 185-190, 196-198`），**绝不静默成功、绝不静默丢弃**。

### 2.4 偏离登记：`gxDocRef` / `gxLinkRef` 收紧为二期（对计划的一处有意偏离）

- 计划 §401 把 `gxNote` / `gxDocRef` / `gxLinkRef` **三键**列入字面白名单；实施**收紧**为仅 `gxNote`
  可用，**`gxDocRef` / `gxLinkRef` 返回 `UNSUPPORTED_OPERATION`、列二期**
  （`packages/canvas/src/validate.ts:9, 146-149, 196-198`；`tools/manuals.ts:101`）。
- **理由**：服务端**无法校验引用目标（关联文档/关联块）的存在性与可见性**，放行会产生**悬空引用**
  ——引用一个不存在或对该主体不可见的 doc/block，破坏画布一致性且服务端无法拦截。
- **后续条件**：待二期引入"引用目标存在性/可见性服务端校验"（或关联块完整结构校验器）后再放开，
  届时须配 Web 端回归。此偏离已与项目总监确认（`validate.ts:7` 注释"已与项目总监确认，勿改"）。
- 同步：图元语言说明书须与最小集口径一致，明示二期操作与 `supported:["element.create"]`
  （`tools/manuals.ts:105-108`）。

### 2.5 必须配浏览器 golden（静态校验不够）

- Plait 六不变量里有两条（**选区 WeakMap、WebKit 渲染补偿**）**根本不进 JSON**，由"只保留白名单键 +
  禁键硬拒"顺带处理；但服务端无 `PlaitBoard`，**只靠静态校验证不了前端 load 时 normalize 不报错、不吞键**。
- 故必须有「**服务端产出 JSON -> 前端真画布加载**」方向的浏览器 golden：`apps/web/e2e/canvas-mcp-golden.spec.ts`
  （Playwright，**chromium + webkit 双绿**）——无白屏、坐标/绑定/层级完整、往返一致。

## 3. 被否决的备选

1. **画布写入降为只读（spike §5.3 原倾向）**：AC-M6-3 是冻结 P0（SPEC :127），不得在实施切片悄悄降级；
   C-2 终审判定画布写入必须进 M6。否决。
2. **把 `canvas-ops.ts` 整文件搬到服务端**：其规则长在 `plait` transform 调用里，无现成纯函数可零成本抽，
   PlaitBoard 强耦合函数不能硬搬；定稿只抽数据层规则、前端一行不改（`validate.ts:4-5` 注释）。
3. **块模型复制一份到 api（不共享）**：双源实现必然漂移；定稿下沉 `@gx/blocks` 单一真源。
4. **服务端放开 `gxDocRef`/`gxLinkRef`（照计划三键白名单）**：无法校验引用目标存在性/可见性 -> 悬空引用；
   定稿收紧为二期（见 2.4 偏离登记）。
5. **只做服务端 JSON 校验、不做浏览器 golden**：证不了前端 load 时 normalize 行为；定稿补 Playwright golden。

## 4. 后果（Consequences）

- 块/图元语言成为单一真源（`@gx/blocks`、`@gx/canvas`），api 与 web 同源；**web 后续任何画布相关改动
  必须以 shared 为唯一规则源**（`canvas-ops.ts` 自身退化为消费方）。
- AC-M6-3 以**最小集达标**：`element.create`（`geometry/rectangle` + 乐观锁 + confirm）写入的图元在
  Web 端打开结构完整（浏览器 golden 双绿）；`update/move/delete/connect` 等完整操作集为二期。
- **最小集 vs 二期边界必须在验收报告中如实写明，不伪装成全量画布写入达标**；未支持操作被拒时**整批不落库**
  （S8 实证：DB `content` 与 `contentVersion` 逐字节不变）。
- 偏离代价：`gxDocRef`/`gxLinkRef` 能力延后到二期（须补引用目标校验）；接入说明与图元语言说明书须与
  最小集口径保持一致（`manuals.ts:105-108`）。
- 回滚干净：块下沉是独立纯移动 commit（可 revert rename）；`@gx/canvas` 模块保留无害；画布写工具可注销。

## 5. 验证证据

- 块下沉：commit `656f9fb`（`refactor(m6-s5): 文档块引擎下沉 @gx/blocks（纯移动）`，`blocks.ts`/`markdown.ts`
  `| 0` 行）；web round-trip golden（`apps/web/src/features/kb/__tests__/blocks-roundtrip-golden.test.ts`）；
  m6-connectivity.md §10（doc round-trip 引用 `transport/__tests__/m6-s5-doc-tools.test.ts`）。
- 画布校验器：commit `d1a7a72`（`feat(m6-s6b): @gx/canvas 纯函数校验器`，`packages/canvas/src/validate.ts`
  293 行 + `__tests__/validate.test.ts` 196 行，六类坏输入各有拒绝用例）。
- 偏离登记：`packages/canvas/src/validate.ts:9, 146-149, 196-198`；`tools/manuals.ts:101, 105-108`。
- 未支持操作不静默 + 整批不落库：m6-connectivity.md §4.3（7 发二期输入 `element.update/move/delete/connect`、
  `arrow-line`、`gxLinkRef`、`gxDocRef` 全部 `UNSUPPORTED_OPERATION`；被拒批次 DB 逐字节不变；stdio 同款）。
- 浏览器 golden：`apps/web/e2e/canvas-mcp-golden.spec.ts`（Playwright，chromium + webkit 双绿，
  m6-connectivity.md §10 / S6b-FE commit `99c16ae`）。
