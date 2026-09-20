# 公式引擎与跨表关联计算 —— 源码审计报告 + UI 点验清单

> 性质：只读调研，未修改任何生产代码。
> 证据纪律：每条结论都带 `文件:行号`。抽查点已尽量分散在「实现 / 元数据 / 测试 / golden」四类文件上。
> 引擎真源：`apps/api/src/domain/formula.ts`（求值）+ `packages/shared-types/src/formula-functions.ts`（编辑器元数据）+ `apps/api/src/domain/hydrate.ts`（跨表点引用注入）。

---

## 0. 一页速览

| 项 | 结论 |
|---|---|
| 引擎实际支持的函数 | **36 个**（另有 2 个未在 UI 登记的别名：`CONCATENATE`、`OR_F`） |
| 已下线函数（保留迁移报错） | `LINK_VALUES` / `LINK_FIRST` / `LINK_LAST` / `LINK_COUNT` |
| 完全无单测覆盖的函数 | **0 个** |
| 只有 happy、无异常/边界用例的函数 | **11 个**（见 §1.5，其中最薄弱是 `DATETIME_DIFF`） |
| 点引用层数 | **1 层**。`{A.B.C}` 不支持（只切第一个点），团队 golden 已锁此为已知边界 R7 |
| 跨表写后即时反向重算 | 分两类：**公式字段读时实时算（无落库）**；**默认值公式落库，写事务外异步重算** |
| 循环引用 | **保存时不检测、读取时静默置 null，界面无任何报错提示** |

---

## 1. 公式函数全表

### 1.1 读法说明

- **「用户书写形式」**：函数名大小写不敏感，eval 处统一 uppercased（`apps/api/src/domain/formula.ts:489`）。
- **参数类型**：引擎**不做运行时类型校验**（`evalCall` 无 arity 检查，`apps/api/src/domain/formula.ts:513-675`）。类型不匹配时走各自转换函数：`asNum`（`formula.ts:44-57`）、`asString`（`formula.ts:28-42`）、`asBool`（`formula.ts:59-72`）。
- **「元数据」列**：指 `packages/shared-types/src/formula-functions.ts` 中 `FORMULA_FUNCTIONS` 条目起始行。**缺元数据的函数，前端公式编辑器会直接报「未知函数」并禁用保存按钮**（`apps/web/src/features/designer/FormulaEditorModal.tsx:364-365`、`243`），即 UI 上根本存不进去。
- **实现列**：`apps/api/src/domain/formula.ts` 中 `case` 所在行。

### 1.2 函数全表（36 个）

| # | 函数 | 参数个数/类型 | 可变参 | 返回 | 实现（formula.ts） | 元数据（formula-functions.ts） | 单测证据 |
|---|---|---|---|---|---|---|---|
| 1 | `IF` | 2~3：`布尔, 任意, 任意` | 否 | 任意（取分支） | `:523` | `:41` | `formula.test.ts:198`；`formula-functions.test.ts:128,129,130`；`cross-formula.test.ts:83` |
| 2 | `SWITCH` | ≥3：`目标, 情形1, 结果1, ...[, 默认]` | **是** | 任意 | `:527` | `:97` | `formula.test.ts:205,206,207`；`formula-functions.test.ts:131,132` |
| 3 | `CONCAT` | ≥1：`文本/列表…` | **是** | 文本 | `:537` | `:54` | `formula.test.ts:132`；`formula-functions.test.ts:59,61,62`；`cross-formula.test.ts:57` |
| 4 | `TRIM` | 1：`文本` | 否 | 文本 | `:540` | `:153` | `formula.test.ts:137`；`formula-functions.test.ts:66` |
| 5 | `UPPER` | 1：`文本` | 否 | 文本 | `:542` | `:162` | `formula.test.ts:138`；`formula-functions.test.ts:67,69` |
| 6 | `LOWER` | 1：`文本` | 否 | 文本 | `:544` | `:171` | `formula.test.ts:139`；`formula-functions.test.ts:68` |
| 7 | `LEN` | 1：`文本 / 列表` | 否 | 数值 | `:546` | `:180` | `formula.test.ts:143`；`formula-functions.test.ts:73,74`；`cross-formula.test.ts:61,69` |
| 8 | `LEFT` | 2：`文本, 数值` | 否 | 文本 | `:551` | `:189` | `formula.test.ts:148,150`；`formula-functions.test.ts:75,76` |
| 9 | `RIGHT` | 2：`文本, 数值` | 否 | 文本 | `:553` | `:198` | `formula.test.ts:149,151`；`formula-functions.test.ts:77,78` |
| 10 | `REPLACE` | 3：`文本, 文本, 文本` | 否 | 文本 | `:558` | `:213` | `formula.test.ts:155`；`formula-functions.test.ts:88,89` |
| 11 | `SEARCH` | 2：`被搜索文本, 目标串` | 否 | 数值（1-based，0=未找到） | `:560` | `:251` | `formula.test.ts:159,160,161`；`formula-functions.test.ts:82,83,84` |
| 12 | `ROUND` | 1~2：`数值, 数值` | 否 | 数值 | `:565` | `:74` | `formula.test.ts:173,174,175`；`formula-functions.test.ts:99,100,101`；`cross-formula.test.ts:79` |
| 13 | `CEILING` | 1：`数值` | 否 | 数值 | `:572` | `:265` | `formula.test.ts:179`；`formula-functions.test.ts:102,103` |
| 14 | `FLOOR` | 1：`数值` | 否 | 数值 | `:574` | `:274` | `formula.test.ts:180`；`formula-functions.test.ts:104` |
| 15 | `ABS` | 1：`数值` | 否 | 数值 | `:576` | `:283` | `formula.test.ts:181`；`formula-functions.test.ts:105` |
| 16 | `MIN` | ≥1：`数值/列表…` | **是** | 数值 | `:578` | `:292` | `formula.test.ts:189`；`formula-functions.test.ts:109`；`cross-formula.test.ts:46` |
| 17 | `MAX` | ≥1：`数值/列表…` | **是** | 数值 | `:582` | `:301` | `formula.test.ts:190`；`formula-functions.test.ts:110`；`cross-formula.test.ts:47` |
| 18 | `FIRST` | 1：`任意/列表` | 否 | 任意（首元素） | `:586` | `:399` | `cross-formula.test.ts:51,53,66` |
| 19 | `LAST` | 1：`任意/列表` | 否 | 任意（末元素） | `:592` | `:409` | `cross-formula.test.ts:52,67` |
| 20 | `ISNULL` | 0~1：`任意` | 否 | 布尔 | `:597` | `:133` | `formula.test.ts:216,217`；`formula-functions.test.ts:145,146`；`cross-formula.test.ts:118,119` |
| 21 | `BLANK` | 0 | 否 | 空 | `:599` | `:142` | `formula.test.ts:216`（借 ISNULL）；`formula-functions.test.ts:147` |
| 22 | `NOW` | 0 | 否 | 日期时间文本（ISO） | `:601` | `:363` | `formula.test.ts:228`；`formula-functions.test.ts:153` |
| 23 | `TODAY` | 0 | 否 | 日期文本（YYYY-MM-DD） | `:603` | `:86` | `formula.test.ts:223`；`formula-functions.test.ts:157`；`formula-output-type.test.ts:56` |
| 24 | `AND` | ≥1：`布尔…` | **是** | 布尔 | `:605` | `:106` | `formula.test.ts:212,213`；`formula-functions.test.ts:136,137` |
| 25 | `OR` | ≥1：`布尔…` | **是** | 布尔 | `:607` | `:115` | `formula.test.ts:214`；`formula-functions.test.ts:138,139` |
| 26 | `NOT` | 1：`布尔` | 否 | 布尔 | `:610` | `:124` | `formula.test.ts:215`；`formula-functions.test.ts:140,141` |
| 27 | `SQRT` | 1：`数值` | 否 | 数值 | `:612` | `:319` | `formula.test.ts:183`；`formula-functions.test.ts:117` |
| 28 | `POWER` | 2：`数值, 数值` | 否 | 数值 | `:614` | `:328` | `formula.test.ts:184`；`formula-functions.test.ts:118` |
| 29 | `MOD` | 2：`数值, 数值` | 否 | 数值（除零→null） | `:616` | `:339` | `formula.test.ts:185`；`formula-functions.test.ts:119,120` |
| 30 | `INT` | 1：`数值` | 否 | 数值（向零截断） | `:622` | `:352` | `formula.test.ts:182`；`formula-functions.test.ts:121,122` |
| 31 | `AVERAGE` | ≥1：`数值/列表…` | **是** | 数值 | `:624` | `:310` | `formula.test.ts:192`；`formula-functions.test.ts:112`；`cross-formula.test.ts:42,70` |
| 32 | `SUM` | ≥1：`数值/列表…` | **是** | 数值 | `:628` | `:65` | `formula.test.ts:191`；`formula-functions.test.ts:111,113`；`cross-formula.test.ts:30,34,38,65,99,103` |
| 33 | `SUBSTR` | 2~3：`文本, 数值[, 数值]` | 否 | 文本 | `:633` | `:227` | `formula.test.ts:165`；`formula-functions.test.ts:90,91` |
| 34 | `REPT` | 2：`文本, 数值` | 否 | 文本 | `:639` | `:239` | `formula.test.ts:166,167`；`formula-functions.test.ts:92,93` |
| 35 | `DATETIME_DIFF` | 2~3：`日期, 日期[, 文本单位]` | 否 | 数值 | `:641` | `:372` | `formula.test.ts:233,234,235`（**仅这 3 行，全 happy**） |
| 36 | `DATEADD` | 2：`日期, 数值` | 否 | 日期文本 | `:657` | `:385` | `formula.test.ts:239`；`formula-functions.test.ts:213,216,220,223`；`formula-output-type.test.ts:57` |

### 1.3 未在元数据表登记、但引擎真实支持的别名（2 个）

| 别名 | 等价 | 实现 | 后果 |
|---|---|---|---|
| `CONCATENATE` | `CONCAT` | `formula.ts:538` | **无元数据条目** → 前端编辑器报「未知函数：CONCATENATE」并禁用保存（`FormulaEditorModal.tsx:364-365`）。后端可正常求值，测试见 `formula.test.ts:133`、`formula-functions.test.ts:60` |
| `OR_F` | `OR` | `formula.ts:608` | **无元数据条目** → 同上，UI 存不进去。**全仓无任何测试引用 `OR_F` 的求值行为** |

> 这是本次审计发现的一处「元数据与实现不一致」，已在 §3 清单中给出对应点验动作（结论：UI 上**无法**验到这两个别名，只能验到「被前端拦下」这一行为）。

### 1.4 已下线函数（保留专用报错，非「未知函数」）

实现：`apps/api/src/domain/formula.ts:506-511`（`REMOVED_CROSS_FNS`）、抛出点 `:514-516`。

| 函数 | 报错文案（节选） | 测试 |
|---|---|---|
| `LINK_VALUES` | `LINK_VALUES 已下线：请改用点引用 {关联字段.子字段}…` | `cross-formula.test.ts:132-137` |
| `LINK_FIRST` | `请改用点引用配合 FIRST 函数…` | `cross-formula.test.ts:140` |
| `LINK_LAST` | `请改用点引用配合 LAST 函数…` | `cross-formula.test.ts:141` |
| `LINK_COUNT` | `请改用 LEN({关联字段.子字段}) 或 count 字段…` | `cross-formula.test.ts:142` |

**未找到**（明确声明：以下常见表格函数在源码中不存在，不要凭印象点验）：`VLOOKUP`、`COUNT`、`COUNTA`、`COUNTIF`、`SUMIF`、`MATCH`、`INDEX`、`TEXT`、`MID`、`FIND`、`SPLIT`、`JOIN`、`IFERROR`、`ARRAYFORMULA`、`LOG`、`EXP`、`RAND`、`YEAR/MONTH/DAY`、`WORKDAY`、`DATEDIF`、`T`。
（佐证：`formula.ts:522-675` 的 switch 全量分支；`formula.ts:673-674` 的 default 即 `未知函数`；`FORMULA_FUNCTIONS` 全量 36 条见 `formula-functions.ts:38-418`。）

### 1.5 覆盖缺口

- **完全无单测的函数：0 个。** 36 个函数全部至少被一条断言直接命中（见上表「单测证据」列）。
- **只有 happy、无异常/边界用例的函数（11 个）**——这些是点验时必须人工补刀的：

  `TRIM` `UPPER` `LOWER` `REPLACE` `SQRT` `POWER` `MIN` `MAX` `ISNULL` `BLANK` `DATETIME_DIFF`

  其中 **`DATETIME_DIFF` 最薄弱**：全仓仅 `formula.test.ts:233-235` 三条断言，只测「默认按天 / 显式 days / weeks」三种 happy；**没有**非法日期、`seconds`/`minutes`/`hours`/`milliseconds` 四种单位、未知单位回退 days、跨月跨年任何一项。
- **`OR_F` 无任何求值测试**（仅存在于 `formula.ts:608` 与 `formula.ts:768` 的返回类型表）。
- **测试命名与实现不符的一处**：`apps/api/src/domain/__tests__/formula-functions.test.ts:108` 的 describe 标题写了 “MIN / MAX / SUM / AVERAGE / **COUNT**”，但仓内并无 `COUNT` 函数，用例体用的也是 `SUM`。走查员不要据此认为存在 `COUNT`。

---

## 2. 跨表关联计算链路

### 2.1 点引用语法的完整规则

注入入口：**`apps/api/src/domain/hydrate.ts:340-409` `buildFormulaSource()`**。执行顺序：

1. 取公式里所有 `{...}` 引用 → `formulaFieldRefs()`（`formula.ts:702-730`）。
2. 对每个含 `.` 的引用切分：**`hydrate.ts:352-354`** —— `const dot = ref.indexOf(".")`，`linkName = ref.slice(0, dot)`，`subName = ref.slice(dot + 1)`。**只切第一个点**，因此 `{A.B.C}` 的 `subName` 会是 `"B.C"`。
3. 在本表字段里找 `linkName`，且类型必须是 `links` 或 `subtable`：**`hydrate.ts:356`**。找不到 → 该引用置 `null`（`:357-359`）。
4. 关联为空 → `null`（`:362-365`）。
5. 逐条关联记录取子字段：在对端表字段里按 `subName` **精确同名查找**（`:372-373`）。找不到就 `continue`（该条不贡献值）。
6. 取到的是**完整 hydration 后的值**（含对端的 formula/lookup/rollup/count 结果）—— `getMergedCached()`（`:377`、实现 `:424-450`，其中 `:443-444` 先跑第一轮再跑公式）。
7. 结果形态三态（**`hydrate.ts:382-384`**）：
   - 0 条有效值 → `null`
   - **恰好 1 条** → **标量**（数字/布尔/字符串，保留原始类型）
   - **多条** → `list`
8. 取值函数（`:387-408`）：含 `.` 走预解析表；否则按字段名找本表字段；`LinkRef[]` 用 `", "` 拼 title（`:401-403`）；自引用字段返回 null（`:395`）。

**结论表：**

| 问题 | 结论 | 证据 |
|---|---|---|
| 支持几层点？ | **字面量只支持 1 层** | `hydrate.ts:352-354` 只切第一个点 |
| 能写 `{A.B.C}` 链式吗？ | **不能，求值恒为 null**（除非对端真有名为 `B.C` 的字段） | 团队 golden 已锁为已知边界 R7：`apps/api/src/domain/__tests__/__snapshots__/hydrate-ring-golden.json` → `knownBoundaries[0].id = "R7"`，原文「`{AB.BC.cv}` 链式点引用现状只切第一个点…故 f7=null，不做真两跳」；实跑 golden 值 `{"id":"a1","fa":null,"la":[7],"f7":null}` |
| 有变相的 2 层吗？ | **有**：`{关联.对端公式字段}` —— 对端字段若本身是 formula，会被完整求值（第 6 步），可再套它自己的点引用，形成**跨表多跳**。UI 上也选得到：对端子字段列表来自 `lookupTargetFields`，其过滤黑名单是 `links/lookup/rollup/count/tabs/subtable`，**`formula` 不在黑名单内** | `hydrate.ts:424-450`；`apps/api/src/domain/fieldService.ts:237-251`（黑名单见 `:250`） |
| 能在聚合函数里直接用 list 吗？ | **能**。`SUM/MIN/MAX/AVERAGE/CONCAT` 走 `flattenArgs` 展平列表（`formula.ts:496-503`、各 case 用 `flat`）；`LEN/FIRST/LAST` **不走展平**，只看 `a[0]`（`formula.ts:546-550`、`:586-596`） | `formula.ts:496-503` |
| `{关联字段}` 不带点是什么？ | `LinkRef[]` → title 用 `", "` 拼成一个字符串 | `hydrate.ts:401-403`；测试 `hydrate.test.ts:350-353` 期望 `"登录页改版 / 张三, 李四"` |
| 反向关联字段能点吗？ | 能。`links` 的 `isReverse` 分支走 `resolveReverseLinks`（`:486-495`），点引用逻辑对正反一视同仁 | `hydrate.ts:486-495`；测试 `hydrate.test.ts:269-284` |

### 2.2 四类字段的实现入口

| 字段类型 | 第一轮实现入口 | 支持什么 | 备注 |
|---|---|---|---|
| `formula` | **第二轮**：`hydrate.ts:274-316` `computeFormulas()`（先 Kahn 拓扑，再 `:318-328 evalOneFormula`） | 任意公式表达式；可引用第一轮全部结果（含 `{关联}` / `{关联.子字段}`） | **不落库**（`hydrate.test.ts:417-426` 明确断言「计算字段不回写 records.fields」） |
| `lookup` | `hydrate.ts:616-667` `resolveLookup()` | 取对端**某个字段**的原始值数组，可配 `recordFilter` 子集筛选 | **读的是 raw stored JSON**（`:651`、`:663`），**不走 hydration**——所以对端是 formula 字段时永远取不到值 |
| `rollup` | `hydrate.ts:669-692` `applyRollup()`（数据源同样来自 `resolveLookup`，见 `:257-258`） | 聚合函数：`sum` / `avg` / `min` / `max` / `count`（`:678-691` switch，default → `null`）。类型约束在 `:88` `rollupFunction` 联合类型 | 空集时：`count` 返回 `0`，其余返回 `null`（`:671`） |
| `count` | `hydrate.ts:694-733` `resolveCount()` | 只数条数；支持 `recordFilter`（`:712-731`）；无筛选时走「过滤软删」快路径（`:713-718`） | 无关联返回 `0`（`:704`） |

**rollup 聚合方式清单（全）**：`sum`（求和）/ `avg`（平均）/ `min`（最小）/ `max`（最大）/ `count`（计数）—— 来源 `apps/api/src/domain/types.ts:88` 联合类型 + `hydrate.ts:678-691` 实现分支，两处一致。
前端可选项：`packages/shared-types/src/type-groups.ts:121-132` `rollupAggOptions()`，5 个选项与后端一一对应；`sum/avg` 非数值组源字段置灰、`min/max` 非数值且非日期组置灰、`count` 永不置灰。
服务端兜底卡控：`apps/api/src/domain/fieldValidation.ts:117-129`（sum/avg 限数值组；min/max 限数值或日期组）。

### 2.3 跨表写操作后的即时反向重算

**先分清两类「公式」，这是本节的关键：**

| 类别 | 是否落库 | 是否需反向重算 |
|---|---|---|
| 字段类型 = `formula` | **否**，读时 hydrate 现算 | 不需要。子表一改，父表读出来就是新值 |
| 字段的**默认内容**配置为 `formula` 模式 | **是**，写进 `records.fields` | **需要**，否则子表改了父表不更新 |

证据：`apps/api/src/domain/defaults.ts:483-486` 注释原文——「公式字段（type=formula）在读取时实时 hydrate，子表数据一变，父表读出来就是新值，无需落库。但「默认设置里的公式」是落库值…因此需要这里的反向重算」。

**写点与触发路径：**

| 触发场景 | 入口 | 文件:行号 | 是否同事务 |
|---|---|---|---|
| 子记录创建 | `applyReverseDefaultsForChild(tableId, [rec.id], userId)` | `apps/api/src/routes/records.ts:192` | ❌ 在写事务之后 |
| 子记录更新（改物理字段） | 同上 | `apps/api/src/routes/records.ts:411` | ❌ 在 `withWriteTx("record.update")` 之后，另包在 `runWrite("defaults.reverseOnUpdate")` 内，外层 `try/catch` 失败只 `console.error`（`:409-422`） |
| 本记录 links/subtable 集合增删 | `applyLinkChangeDefaults` | `apps/api/src/routes/records.ts:418` | ❌ 同上 |
| 记录软删 | `applyReverseDefaultsForChild(..., { includeDeleted: true })` | `apps/api/src/routes/records.ts:456` | ❌ 在 `withWriteTx("record.softDelete")` 之后（`:448-458`） |
| 批量删除 | 同上 | `apps/api/src/routes/records.ts:515` | ❌ |
| 批量更新 | 同上 | `apps/api/src/routes/records.ts:585` | ❌ |
| MCP 写工具 | 同上 | `apps/api/src/mcp/tools/record.tools.ts:219` | ❌ |

**关键结论：反向重算与主写事务不同事务，且失败静默（只打日志，不回滚、不报错给用户）。**
证据：`routes/records.ts:388-391`（事务体 `withWriteTx("record.update", …)`）→ `:396-406`（`applyEditDefaults` 包在 try/catch）→ `:409-422`（`applyReverseDefaultsForChild` / `applyLinkChangeDefaults` 再包一层 try/catch，catch 里 `console.error("[defaults] reverse recalc failed:", e)`）。
落库写本身在 `defaults.ts:530-537`（`prisma.record.update` + `syncRecordsTx`）。

**短路条件（很重要，会造成「看起来没生效」）**：只有当父表存在 `defaultConfig.mode === "formula"` 且**公式文本里含 `.`** 的字段时才重算——`defaults.ts:489-496`（`tableHasFormulaDefaultDots`）、`:507-512`（`dotDefaults` 过滤）、`:588`、`:606`。

### 2.4 已知限制

| 限制 | 行为 | 证据 |
|---|---|---|
| **同表公式字段循环引用**（A 引 B、B 引 A） | Kahn 拓扑排不完 → **剩下的字段置 `null`，静默，无任何报错** | `hydrate.ts:298-315`（`:312` 注释「剩下的都是循环依赖」，`:313-315` 置 null） |
| **跨表点引用环**（X 的公式点引 Y，Y 又点引 X） | `merging` 守卫命中 → `getMergedCached` 返回 `null` → 公式结果 null，**静默** | `hydrate.ts:432`（`if (ctx.merging.has(key)) return null;`）；实跑 golden：`ring_x.xf`/`ring_y.yf` 互引，两个态的捕获值均为 `null`（`__snapshots__/hydrate-ring-golden.json` → `captures.batch["r2-root-x"].values = [{"id":"x1","xf":null}]`，`r2-root-y` 同理） |
| **公式自引用**（字段 A 的公式里写 `{A}`） | 取值为 `null`（`excludeFieldId`） | `hydrate.ts:395`；测试 `hydrate.test.ts:383-390` |
| **保存时是否检测循环** | **完全不检测**。后端 `fieldValidation.ts:57-64` 对 `type=formula` 只做 `parseFormula` 语法校验；前端 `FormulaEditorModal.tsx:341-372` 只查括号配平 / 顶层字段名存在 / 函数存在与 arity。全仓 grep「循环引用 / circular」在公式链路无命中 | `apps/api/src/domain/fieldValidation.ts:57-64`；`FormulaEditorModal.tsx:341-372` |
| **未知函数** | 保存不拦（后端不校验函数名）；**读时** `safeEvaluateFormula` 返回 null 且 `error` 被 `evalOneFormula` **丢弃** → 单元格空白，**界面无任何提示** | `hydrate.ts:326`（`const { value } = safeEvaluateFormula(...)`，未取 error）；`formula.ts:673-674`；测试 `hydrate.test.ts:392-397`（`FOO(1)` → null） |
| **关联字段（links/subtable）被删** | 公式里 `{该字段.子字段}` → 找不到 link 字段 → `null`，单元格空 | `hydrate.ts:356-359` |
| **对端子字段被删** | 逐条 `continue`，0 条有效值 → `null` | `hydrate.ts:372-373` + `:382` |
| **对端记录被软删** | `getRecordsByIds` 带 `deletedAt: null` 过滤 → 不参与计算 | `apps/api/src/domain/prismaDeps.ts:100-105`（`:103`） |
| **关联行被软删**（记录软删会连带软删 linkRow） | `getLinkRows` 带 `deletedAt: null` 过滤 | `prismaDeps.ts:107-127`（`:112`）；软删连带见 `apps/api/src/domain/recordWrite.ts:317-320` |
| **空值 / 空数组** | 见下表 §2.5 | — |
| **除零 / 取余零** | `/` 与 `%` 返回 `null`（非空值语义），`MOD(x,0)` 返回 `null` | `formula.ts:451-456`、`:457-462`、`:616-621` |

### 2.5 空值 / 空数组行为对照（点验时逐条比对）

| 表达式（点引用为空关联时） | 结果 | 证据 |
|---|---|---|
| `SUM({空关联.金额})` | `0`（不是 null） | `cross-formula.test.ts:65`；`formula.ts:628-632` |
| `AVERAGE({空关联.金额})` | `0` | `cross-formula.test.ts:70`；`formula.ts:624-627` |
| `MIN(...)` / `MAX(...)` 无可转数值元素 | **`0`**（陷阱：应为 null 更符合直觉） | `formula.ts:578-585`（`nums.length === 0 ? 0 : …`） |
| `FIRST({空关联.金额})` / `LAST(...)` | `null` | `cross-formula.test.ts:66-67`；`formula.ts:586-596` |
| `CONCAT({空关联.金额})` | `""` | `cross-formula.test.ts:68`；`formula.ts:537-539` |
| `LEN({空关联.金额})` | `0` | `cross-formula.test.ts:69`；`formula.ts:546-550` |
| `{a} - {b}` / `{a} * {b}` / `{a} / {b}`（任一为空） | `null` | `cross-formula.test.ts:107-110`；`formula.ts:439-462` |
| `{a} + {b}`（数值语境、一边为空） | 另一边数值（+ 对空值按 0 参与的路径由 asNum 分支决定） | `cross-formula.test.ts:106` 注释 `+ 法数值场景空→0 处理一致` |
| 文本拼接遇 null | 当空串，**绝不出现 "null" 字样** | `cross-formula.test.ts:113-115` |
| `asNum(list)` | `null`（列表不能直接转数字，必须走聚合） | `formula.ts:52-53` |
| 非数字文本混进 SUM | 被过滤，不产生 NaN；纯文本列表求和 = 0 | `cross-formula.test.ts:96-104`；`formula.ts:629-631` |

---

## 3. 必须点验清单（UI 走查员操作手册）

### 3.0 前置：搭一套能覆盖全部用例的最小库

**库「验收库」下建 4 张表：**

| 表 | 字段（类型） | 初始值 |
|---|---|---|
| **客户** | 客户名（单行文本）、等级（单行文本）、账期（数字） | C1=大客户/P1/30；C2=小客户/P2/7 |
| **订单明细** | 商品名（单行文本）、金额（数字）、数量（数字）、备注（单行文本，留空） | D1=键盘/100/2；D2=鼠标/200/3；D3=显示器/50/1 |
| **订单** | 订单号（单行文本）、折扣（数字）、下单日期（日期）、客户（关联→客户，多选）、明细（子表格→订单明细） | O1 关联 C1+C2、挂 D1+D2+D3；O2 只关联 C1、只挂 D1 |
| **环表** | X（公式）、Y（公式） | 见 §3.4 |

> 「关联」与「子表格」在「布局/关联」类里建；「公式/查阅/聚合/计数」在「计算」类里建（`apps/web/src/features/designer/FieldEditorSheet.tsx:94-101`）。

**通用操作路径**：表视图 → 表头最后一列 `+` → 选类型 → 右侧编辑抽屉填配置 → 保存。
**公式编辑器路径**：类型选「公式」→ 点「设置公式」按钮（`FieldEditorSheet.tsx:668-674`）→ 弹窗内左栏插字段/函数、右栏看实时校验（`FormulaEditorModal.tsx`）。

---

### 3.1 每一个函数的正常用例（36 条）

> 操作统一为：订单表 → 新建公式字段 → 填公式 → 保存 → 看 O1 行单元格。
> 期望值按 O1：客户名 C1/C2、等级 P1/P2、账期 30/7、明细金额 100/200/50、数量 2/3/1、折扣 0.8、下单日期 2026-09-10。

| # | 字段名 / 公式 | 期望（O1） | 单测基线 |
|---|---|---|---|
| 1 | `IF({折扣} > 0.5, "大促", "常规")` | `大促` | `formula-functions.test.ts:128` |
| 2 | `SWITCH({客户.等级}, "P1", 1, "P2", 2, 0)` → 注意多值时取标量规则，见 §3.3 | O1 多值 → 见 §3.3；O2（单关联）→ `1` | `formula-functions.test.ts:131` |
| 3 | `CONCAT({订单号}, "-", {折扣})` | `O1-0.8` | `formula-functions.test.ts:59,62` |
| 4 | `TRIM("  ABC  ")` | `ABC` | `formula-functions.test.ts:66` |
| 5 | `UPPER("abc")` | `ABC` | `:67` |
| 6 | `LOWER("ABC")` | `abc` | `:68` |
| 7 | `LEN({订单号})` | `2` | `:73` |
| 8 | `LEFT({订单号}, 1)` | `O` | `:75` |
| 9 | `RIGHT({订单号}, 1)` | `1` | `:77` |
| 10 | `REPLACE({订单号}, "O", "X")` | `X1` | `:88` |
| 11 | `SEARCH({订单号}, "1")` | `2`（1-based） | `:82` |
| 12 | `ROUND(SUM({明细.金额}) * {折扣}, 2)` | `280` | `:99` |
| 13 | `CEILING(SUM({明细.金额}) / {折扣})` | `438`（350/0.8=437.5） | `:102` |
| 14 | `FLOOR(SUM({明细.金额}) / {折扣})` | `437` | `:104` |
| 15 | `ABS(0 - SUM({明细.金额}))` | `350` | `:105` |
| 16 | `MIN({明细.金额})` | `50` | `cross-formula.test.ts:46` |
| 17 | `MAX({明细.金额})` | `200` | `:47` |
| 18 | `FIRST({明细.商品名})` | `键盘` | `:51` |
| 19 | `LAST({明细.商品名})` | `显示器` | `:52` |
| 20 | `IF(ISNULL({明细.备注}), "无备注", "有")` | `无备注`（备注全空 → 0 有效值 → null） | `:145`；`cross-formula.test.ts:118` |
| 21 | `IF({折扣} > 1, "x", BLANK())` | 空白 | `formula-functions.test.ts:147` |
| 22 | `NOW()` | 形如 `2026-09-20T…` 的 ISO 串 | `:153` |
| 23 | `TODAY()` | `2026-09-20`（当天） | `:157` |
| 24 | `IF(AND({折扣} > 0, SUM({明细.金额}) > 0), "ok", "no")` | `ok` | `:136` |
| 25 | `IF(OR({折扣} > 1, SUM({明细.金额}) > 300), "ok", "no")` | `ok` | `:138` |
| 26 | `IF(NOT({折扣} > 1), "ok", "no")` | `ok` | `:140` |
| 27 | `SQRT(SUM({明细.金额}) - 326)` | `24`（√576… 请用 `SQRT(144)` 更稳：期望 `12`） | `:117` |
| 28 | `POWER(SUM({明细.数量}), 2)` | `36`（2+3+1=6） | `:118` |
| 29 | `MOD(SUM({明细.数量}), 4)` | `2` | `:119` |
| 30 | `INT(SUM({明细.金额}) / {折扣})` | `437` | `:121` |
| 31 | `ROUND(AVERAGE({明细.金额}), 1)` | `116.7`（350/3） | `cross-formula.test.ts:42,79` |
| 32 | `SUM({明细.金额})` | `350` | `cross-formula.test.ts:30` |
| 33 | `SUBSTR({订单号}, 2, 1)` | `1` | `:90` |
| 34 | `REPT("*", SUM({明细.数量}))` | `******` | `:92` |
| 35 | `DATETIME_DIFF(TODAY(), {下单日期}, "days")` | 当天减 2026-09-10 的天数 | `formula.test.ts:233` |
| 36 | `DATEADD({下单日期}, 7)` | `2026-09-17`（纯日期按 UTC 日历日） | `formula-functions.test.ts:213` |

---

### 3.2 每一个函数的异常 / 边界入参（重点，逐条触发）

| # | 触发方式（在公式编辑器里输入） | 期望表现 | 证据 |
|---|---|---|---|
| E1 | `IF({折扣} > 1, "x")` —— 少第 3 参（arity min=2，合法） | 条件假 → 单元格**空白**（`FNULL`） | `formula.ts:524-526`；`formula-functions.test.ts:130` |
| E2 | `IF()` —— 0 参 | 前端报「IF 参数个数应为 2~3 个（当前 0）」且**保存按钮置灰** | `FormulaEditorModal.tsx:368-369`、`243` |
| E3 | `SWITCH({订单号}, "X1", 1)` —— 无默认、不命中 | 空白 | `formula.test.ts:207-208` |
| E4 | `SWITCH()` / `SWITCH({订单号})` —— <3 参 | 前端拦截（arity min=3） | `FormulaEditorModal.tsx:368` |
| E5 | `LEFT({订单号}, -5)` / `RIGHT({订单号}, 0)` | 均为**空串**（下界保护 max(0,n)） | `formula.ts:552`、`:554`；`formula-functions.test.ts:76,78` |
| E6 | `SUBSTR({订单号}, 2)` —— 省第 3 参 | 截到末尾：`1` | `formula.ts:637`；`formula-functions.test.ts:91` |
| E7 | `SEARCH({订单号}, "ZZZ")` | `0`（不是 -1） | `formula.ts:563`；`formula-functions.test.ts:83` |
| E8 | `REPT("x", 0)` | 空串 | `formula-functions.test.ts:93` |
| E9 | `MOD(SUM({明细.数量}), 0)` | **空白**（null），不报错、不 NaN | `formula.ts:619`；`formula-functions.test.ts:120` |
| E10 | `SUM({明细.数量}) / 0` | **空白**（null） | `formula.ts:454`；`formula-functions.test.ts:197` |
| E11 | `SUM({明细.数量}) % 0` | **空白**（null） | `formula.ts:460` |
| E12 | `ROUND(-2.5)` | `-3`（远离零，不是 -2） | `formula.ts:570`；`formula-functions.test.ts:101` |
| E13 | `INT(-3.9)` | `-3`（向零截断，不是 -4） | `formula.ts:623`；`formula-functions.test.ts:122` |
| E14 | `CEILING(-3.1)` | `-3` | `formula-functions.test.ts:103` |
| E15 | `SQRT(-1)` | **空白**还是 `NaN`？→ 实现是 `Math.sqrt(-1)` = `NaN`，**未做过滤**（与 `SUM/MIN/MAX/AVERAGE` 的 `Number.isFinite` 过滤不同）→ 单元格可能显示 `NaN` | `formula.ts:612-613`；**【存疑】** 见 §4 |
| E16 | `POWER(2, 0.5)` | `1.414…` | `formula.ts:615` |
| E17 | `MIN({明细.商品名})` —— 纯文本列表求最小 | **`0`**（不是 null、不是报错）—— 陷阱点 | `formula.ts:578-581` |
| E18 | `MAX({明细.商品名})` | **`0`** —— 同上 | `formula.ts:582-585` |
| E19 | `SUM({明细.商品名})` | **`0`** | `cross-formula.test.ts:102-104` |
| E20 | `AVERAGE({明细.商品名})` | **`0`** | `formula.ts:624-627` |
| E21 | `MIN({不存在的关联.金额})` | 空白（前端会先报「未知字段引用」，因为顶层名不在字段表里） | `hydrate.ts:357-359`；`FormulaEditorModal.tsx:356-359` |
| E22 | `LEN({明细.商品名}, {明细.金额})` —— **传两个参数** | **不是** 6；实现只取 `a[0]`，且 `a.length!==1` 时走「文本化第一个列表（`, ` 拼接）取字符数」→ `键盘,鼠标,显示器` 的字符数 `8`。**与 SUM 的展平行为不一致** | `formula.ts:546-550` vs `:496-503`；**【存疑】** 见 §4 |
| E23 | `FIRST({明细.商品名}, {明细.金额})` | `键盘`（只取第 1 参，第 2 参被忽略且前端 arity max=1 会拦截） | `formula.ts:586-591` |
| E24 | `ISNULL()` —— 0 参（arity min=0，合法） | `true` | `formula.ts:598`；`formula-functions.test.ts` 未覆盖 → 补验 |
| E25 | `DATETIME_DIFF({订单号}, {下单日期}, "days")` —— 非日期入参 | **空白**（null），不报错 | `formula.ts:642-644` |
| E26 | `DATETIME_DIFF(TODAY(), {下单日期}, "months")` —— 未知单位 | 回退按 **days** 计算（不是报错） | `formula.ts:655` `per[unit] ?? per.days` |
| E27 | `DATETIME_DIFF(TODAY(), {下单日期}, "hours")` | 天差 ×24 | 同上；**仓内无此用例**，补验 |
| E28 | `DATEADD("not-a-date", 1)` | **空白**（null） | `formula.ts:668-669`；`formula-functions.test.ts:223-227` |
| E29 | `DATEADD({下单日期}, -40)` | 跨月：`2026-08-01` | `formula-functions.test.ts:216-219` |
| E30 | `DATEADD("2026-12-31", 1)` | `2027-01-01`（跨年） | `formula-functions.test.ts:218` |
| E31 | 公式框里输入 `FOOBAR(1)` | 前端红字「未知函数：FOOBAR」+ 保存按钮置灰 | `FormulaEditorModal.tsx:364-365`、`243` |
| E32 | 通过 **MCP / API 直调**强行存入 `FOOBAR(1)`（绕过前端） | 单元格**空白且无任何提示**（error 被丢弃） | `hydrate.ts:326`；`hydrate.test.ts:392-397` |
| E33 | `CONCATENATE("a","b")` | 前端红字「未知函数：CONCATENATE」+ 置灰（**后端其实支持**） | `formula.ts:538`；`FormulaEditorModal.tsx:364` |
| E34 | `LINK_VALUES({明细}, "金额")` | 前端报「未知函数」（无元数据）；绕过前端直存 → 后端抛 `LINK_VALUES 已下线：…`，单元格空白 | `formula.ts:506-516`；`cross-formula.test.ts:132-137` |
| E35 | `{折扣} = 0.8` 与 `{折扣} == 0.8` | 二者都成立（`=` 在 tokenizer 阶段变 `==`） | `formula.ts:136-144`；`formula-functions.test.ts:167-168` |
| E36 | `{订单号} \| 1`（单个竖线） | 前端报未知？→ 后端 tokenizer 抛「意外字符」→ 单元格空白 | `formula.ts:177-183`；`formula-functions.test.ts:180` |
| E37 | `{订单号} & "-"` vs `{订单号} + "-"` | `&` 与 `+` 在纯文本语境都是拼接，结果相同；但若两边都是数值，`+` 是**算术加** | `formula.ts:429-438`、`:463-467` |
| E38 | 字符串 `'10' = '10.0'` | **false**（两边都是 string → 严格字符串比较） | `formula.ts:401-407`；`formula.test.ts:121` |

---

### 3.3 跨表点引用：1 层 / 2 层 / 聚合内嵌套

| # | 操作 | 期望 | 证据 |
|---|---|---|---|
| X1 | **1 层·标量**：订单表建公式 `{客户.客户名}`（O2 只关联 C1） | `大客户`（单条 → 标量） | `hydrate.ts:383` |
| X2 | **1 层·多值**：同一公式看 O1（关联 C1+C2） | 单元格显示**数组** `["大客户","小客户"]`（未套聚合时 list 原样转标量数组） | `hydrate.ts:384`；`hydrate.ts:745-759`（`formulaValueToCell` list→数组）；`hydrate.test.ts:355-359` 期望 `["P7","P6"]` |
| X3 | **1 层·显式拼接**：`CONCAT({客户.客户名})` | `大客户小客户`（无分隔） | `hydrate.test.ts:361-368` 期望 `P7P6` |
| X4 | **不带点**：`{客户}` | `大客户, 小客户`（title 用 `, ` 拼接） | `hydrate.ts:401-403`；`hydrate.test.ts:350-353` |
| X5 | **子表格点引用**：`{明细.金额}`（明细是 subtable 类型） | 与 links 行为一致。⚠️ 但 UI 的「插入子字段 ⌄」下拉**只对 `links` 类型出现**（`FormulaBuilder.tsx:83,117`），子表格需**手写** `{明细.金额}` | `hydrate.ts:356`（links 或 subtable 都收） |
| X6 | **聚合内嵌套（1 层）**：`SUM({明细.金额})` | `350` | `cross-formula.test.ts:30` |
| X7 | **聚合嵌套聚合**：`ROUND(AVERAGE({明细.金额}), 1)` | `116.7` | `cross-formula.test.ts:79-82` |
| X8 | **聚合内嵌 IF / LEN**：`IF(LEN({明细.金额}) >= 3, "批量单", "普通单")` | `批量单` | `cross-formula.test.ts:83` |
| X9 | **混合标量+列表**：`SUM({明细.金额}, {明细.数量}, 7)` | `363`（350+6+7，列表被展平） | `cross-formula.test.ts:90-92`；`formula.ts:496-503` |
| X10 | **四则混合**：`SUM({明细.金额}) * {折扣} + 10` | `290` | `cross-formula.test.ts:73-76` |
| X11 | **2 层字面量 `{A.B.C}`**：在客户表加关联字段指向「区域」表，订单表写 `{客户.区域.名称}` | **空白**（只切第一个点，对端无名为 `区域.名称` 的字段） | `hydrate.ts:352-354`；golden R7 |
| X12 | **变相 2 层（跨表公式字段）**：在「客户」表建公式字段 `客户标签` = `CONCAT({客户名}, "/", {等级})`；回订单表写 `{客户.客户标签}` | 应能取到 `大客户/P1`、`小客户/P2`（对端完整 hydration 含公式） | `hydrate.ts:424-450`（`:443-444`）；对端子字段下拉能看到 formula（黑名单不含 formula，`fieldService.ts:250`） |
| X13 | **跨表链最末端**：客户表的 `客户标签` 自己又引用 `{区域.名称}` → 订单表 `{客户.客户标签}` | 应能间接走出第 3 张表 | 同上（**【存疑】**：仓内无端到端用例，见 §4） |
| X14 | **反向关联点引用**：在「客户」表建公式 `{订单.订单号}`（订单是反向字段） | 取到该客户名下所有订单号 | `hydrate.ts:486-495`；`hydrate.test.ts:269-284` |
| X15 | **lookup 取对端公式字段**（对照 X12）：订单表建 `lookup` 字段，关联=客户，取值字段选「客户标签」（formula 类型） | **永远为空**——lookup 读 raw stored JSON，formula 字段不落库 | `hydrate.ts:651`、`:663`；**【存疑】** 见 §4 |
| X16 | **聚合字段被点引用**：订单表先建 rollup 字段 `明细合计` = SUM(明细.金额)，再建公式 `{明细合计} * 2` | `700`（同一表内计算字段可互相引用，走 Kahn 拓扑） | `hydrate.ts:274-316`；`hydrate.test.ts:399-414` |

---

### 3.4 删除 / 循环 / 空值的表现

| # | 操作 | 期望 | 证据 |
|---|---|---|---|
| D1 | 在「客户」表删除字段「等级」，回订单表看 `{客户.等级}` 公式 | 单元格**空白**，无报错、无提示 | `hydrate.ts:372-373` + `:382` |
| D2 | 在「订单」表删除关联字段「客户」，回看 `{客户.等级}` | 单元格**空白**（link 字段找不到） | `hydrate.ts:356-359` |
| D3 | 把客户 C2 **软删**（删除记录，进回收站） | O1 的 `{客户.客户名}` 变成**只剩 `大客户`**（单条→标量）；`SUM` 类聚合随之变小 | `prismaDeps.ts:103`（`deletedAt: null`）；`prismaDeps.ts:112`（linkRow 同理） |
| D4 | 在订单 O1 的明细子表格里**删掉 D3 行** | `SUM({明细.金额})` 立刻从 350 变 300（公式字段读时现算，**无需重算**） | `defaults.ts:483-486`；`hydrate.ts:274-316` |
| D5 | 在「订单明细」表**直接改** D1 金额 100→1000（不经过订单表） | 订单表 `SUM` 立刻变 1250。若订单表用的是**默认内容=formula**的字段，则依赖反向重算（见 D6） | `defaults.ts:483-486` |
| D6 | 建一个「订单总额」字段，类型=数字，默认内容设为 formula `SUM({明细.金额})`；然后在明细表改金额 | 父表**落库值**应同步刷新（走 `applyReverseDefaultsForChild`）。**若在刷新前刷新页面看到旧值，即为反向重算失败**——注意它**不在写事务内**且失败只打日志 | `routes/records.ts:409-422`；`defaults.ts:502-540` |
| D7 | 同上，但父表默认公式写成**不含点**（如 `{折扣} * 100`） | 子表改动**不会**触发父表重算（短路条件要求公式含 `.`） | `defaults.ts:489-496`、`:507-512` |
| D8 | **同表公式环**：订单表建 A = `{B} + 1`，B = `{A} + 1` | 两个字段都**空白**，界面**无任何错误提示**，保存时也不拦截 | `hydrate.ts:312-315`；`fieldValidation.ts:57-64`（保存不校验） |
| D9 | **跨表点引用环**：环表 X = `{Y.任一字段}`，Y = `{X.任一字段}`（互相关联） | X、Y 都**空白**，无任何提示 | `hydrate.ts:432`；golden `r2-root-x` / `r2-root-y` 均为 null |
| D10 | **自引用**：公式字段「标签」的公式写 `CONCAT({标签}, "x")` | 结果 `x`（自引用部分为 null），不死循环 | `hydrate.ts:395`；`hydrate.test.ts:383-390` |
| D11 | **空关联**：新建订单 O3 不关联任何客户、不挂明细 | `{客户.客户名}` 空白；`SUM({明细.金额})` = `0`；`LEN({明细.金额})` = `0`；`FIRST(...)` 空白；`CONCAT(...)` 空串 | `cross-formula.test.ts:64-71` |
| D12 | **循环引用报错可读性** | **结论：不可读——根本没有报错。** 保存不拦截、读取不提示、只表现为空白单元格。这是本次审计最重要的验收缺口 | `hydrate.ts:312-315`；`fieldValidation.ts:57-64`；`FormulaEditorModal.tsx:341-372` |

---

## 4. 【存疑】未查清 / 需实机确认的项

> 以下均未在源码或测试中查到确定答案，**不做猜测**，请实机点验后回填。

1. **【存疑】`SQRT` 负数的实际渲染**：`formula.ts:612-613` 是 `fnum(Math.sqrt(num(0) ?? 0))`，未做 `Number.isFinite` 过滤（与 `SUM/MIN/MAX/AVERAGE` 的过滤写法不同）。`SQRT(-1)` 理论上得到 `NaN`。`NaN` 在单元格里渲染成什么（空白 / `NaN` / 异常）未查清，UI 渲染层未跟踪到相关分支。→ 对应点验 E15。

2. **【存疑】`LEN`/`FIRST`/`LAST` 与 `SUM` 的参数展平不一致**：`LEN({a}, {b})` 传两参时走 `str(0)` 文本化（`, ` 拼接后数字符），而 `SUM({a},{b})` 走 `flattenArgs` 展平。文档描述（`formula-functions.ts:182-186`）只写了单参语义。这是设计如此还是缺陷未判定。→ 对应点验 E22。

3. **【存疑】子表格（subtable）在公式编辑器里没有「插入子字段 ⌄」入口**：`FormulaBuilder.tsx:83,117` 只过滤 `f.type === "links"`。后端 `hydrate.ts:356` 明确同时接受 `subtable`。是「UI 有意不支持、只让手写」还是漏配，未查到说明；实机需确认手写 `{子表格名.子字段}` 是否真的能出值。→ 对应点验 X5。

4. **【存疑】跨表三跳（X13）是否真的端到端可用**：`getMergedCached`（`hydrate.ts:424-450`）递归 hydrate 对端记录含其公式，理论上支持任意跳深；但仓内**没有任何** ≥2 跳的端到端测试（环 golden 的 R7 边界反而证明了字面量 2 跳不可用）。是否受 `merging` 守卫或性能影响未验证。→ 对应点验 X13。

5. **【存疑】`lookup` 指向对端 `formula` 字段是否应当被禁止**：`fieldService.ts:250` 的黑名单不含 `formula`，所以 UI 能选；但 `resolveLookup`（`hydrate.ts:651,663`）读 raw stored JSON，formula 字段不落库 → 必然恒空。这是「可选但永远无值」的可疑组合，未查到是否有意。→ 对应点验 X15。

6. **【存疑】`OR_F` 的实现动机与是否有调用方**：全仓仅在 `formula.ts:608`（求值）与 `:768`（返回类型表）出现，**无任何测试、无元数据条目、无 UI 入口**。它是真实需要支持的别名还是历史残留，未查清。

7. **【存疑】`CONCATENATE` 无元数据是否是有意**：后端 `formula.ts:538` 与测试 `formula.test.ts:133`、`formula-functions.test.ts:60` 都明确支持并断言了它，但 `FORMULA_FUNCTIONS`（36 条）里没有它，导致前端编辑器直接判「未知函数」。一致性缺口，未查到裁决记录。→ 对应点验 E33。

8. **【存疑】M4 字段掩码（A-4）开启时的点验差异**：`hydrate.ts:374-376`、`:432-442`、`:505-507`、`:633-639`、`:706-710` 都有 `visibilityOf` 收窄逻辑。本次审计**未验证** `GX_AUTHZ_ENGINE=on` 时上述点验期望值是否改变；清单中全部期望值默认掩码关闭（off/shadow）。若验收环境开着引擎，需另出一份对照清单。

9. **【存疑】`hydrate.test.ts:383-390`「自引用」用例的期望值**：用例名写「返回 null」，断言却是 `"x"`（因为 `CONCAT` 把 null 当空串）。清单 D10 按断言值写。若走查员看到的是「公式字段整体为 null」而非 `x`，说明存在另一条路径，需复核。

---

## 附：关键文件清单（跨表链路）

| 角色 | 文件 |
|---|---|
| 公式求值引擎（Tokenizer/Parser/Eval） | `apps/api/src/domain/formula.ts` |
| 函数元数据（前端编辑器函数列表 / arity） | `packages/shared-types/src/formula-functions.ts` |
| 跨表点引用注入 + 四类计算字段 | `apps/api/src/domain/hydrate.ts` |
| 批量预取（性能，不改变取值） | `apps/api/src/domain/hydrateBatch.ts`、`hydrateBatchLinks.ts` |
| DB 依赖实现（软删过滤在此） | `apps/api/src/domain/prismaDeps.ts` |
| 字段类型 / 计算字段判定 | `apps/api/src/domain/types.ts` |
| 字段保存校验（公式只查语法） | `apps/api/src/domain/fieldValidation.ts` |
| lookup 目标字段白名单 | `apps/api/src/domain/fieldService.ts:237-251` |
| 默认值公式反向重算 | `apps/api/src/domain/defaults.ts:481-608` |
| 反向重算的 7 个写点 | `apps/api/src/routes/records.ts:192,411,418,456,515,585`；`apps/api/src/mcp/tools/record.tools.ts:219` |
| 写事务体 | `apps/api/src/domain/recordWrite.ts` |
| 前端公式编辑器 + 实时校验 | `apps/web/src/features/designer/FormulaEditorModal.tsx` |
| 前端公式构建器（插字段/函数） | `apps/web/src/features/designer/FormulaBuilder.tsx` |
| 前端字段编辑抽屉 | `apps/web/src/features/designer/FieldEditorSheet.tsx` |
| rollup 聚合选项（与后端一一对应） | `packages/shared-types/src/type-groups.ts:121-132` |
| 测试：公式语法/函数 | `apps/api/src/domain/__tests__/formula.test.ts`、`formula-functions.test.ts`、`formula-output-type.test.ts` |
| 测试：跨表点引用 | `apps/api/src/domain/__tests__/cross-formula.test.ts`、`hydrate.test.ts` |
| 测试：点引用环 golden | `apps/api/src/domain/__tests__/hydrate-ring-characterization.test.ts` + `__snapshots__/hydrate-ring-golden.json` |
| 测试：反向重算 | `apps/api/src/routes/__tests__/rc35-reverse-defaults.test.ts` |
