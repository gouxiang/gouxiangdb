# 待裁决清单（PENDING DECISIONS）

> 生成：2026-09-20 · 只读盘点第二阶段（**未删除、未修改任何既有文件，未 commit**）
> 用途：给主理人拍板。凡列入本文件的条目，在拍板前**一律保持原样**。
> 盘点口径：所有体量/行数/引用均为真实命令输出（`du` / `stat` / `md5` / `wc -l` / `git ls-files` / Grep），无估算。
> 配套背景：git 已跟踪仅 **1152 个文件 / 10.4 MB**；工作区 **1.4 G**（含 node_modules 1.0 G）。
> 也就是说：本文件里几乎所有大块都是**未跟踪且被 `.gitignore` 忽略**的本地产物 —— **删了 git 找不回来**。

---

## 清理红线（执行清理的人必须先读完这一段）

### 1. 任何清理命令必须排除以下对象

| 必须排除 | 原因（实证） |
|---|---|
| `docs/help-center/**` | 帮助中心目录（任务 #392 将新建）。**当前尚不存在**，一旦建成即为正式资产，**不是清理对象** |
| `docs/acceptance/screenshots/70-*.png`<br>`71-*.png`<br>`72-*.png`<br>`73-*.png` | 这 **4 个是 `docs/acceptance/screenshots/` 下唯一已入库的文件**（`git ls-files docs/acceptance/screenshots` 只返回这 4 条）。删了会让 `git status` 长期显示 deleted，污染仓库状态 |
| `editor-canvas-*.png`（09-19 22 批，38 张） | 被 2 份报告逐张点名引用：`docs/acceptance/2026-09-20-editor-nav-remediation-report.md:96,105`、`docs/design/2026-09-19-editor-nav-remediation/REPORT.md:52` |
| `smoke-*.png`（09-19 09 批，37 张） | 有文档计数背书：`docs/acceptance/2026-09-19-menu-table-smoke.md:243` 记"共 37 张"，数量对得上 |
| `nav-governance/embedding-*`（9 张） | 被 `docs/acceptance/2026-09-19-embedding-remote-config.md:44` 逐张点名 |
| `进度看板.html` + `进度数据.js` | 主理人资产。**未跟踪但未被 ignore**（`git check-ignore` 返回 NOT ignored），是可入库资产 |
| `.workbuddy/memory/` | 项目记忆（跨会话继承），**严禁动** |
| `node_modules/` | 依赖，1.0 G，不动 |
| `apps/web/dist/` | 较新构建（2026-09-19 11:55），正在用 |
| `apps/web/src/features/shell/*`<br>`apps/web/src/features/sidebar/Sidebar.tsx`<br>`apps/web/src/features/kb/KbShell.tsx`<br>`apps/web/src/features/kb/KbSidebar.tsx`<br>`apps/web/src/features/kb/KbTree.tsx` | **flag-off 回退壳，是活代码不是垃圾**：`ShellGate.tsx:7,10` import → `App.tsx:160` 挂载，`GX_ENTERPRISE_NAV=off` 时整条回退路径靠它们。详见下文第 10 条 |

### 2. 一个必须写下来的坑：`.gitignore` 的 `screenshots/` 规则

`.gitignore:41` 的规则是 `screenshots/`，**无前导斜杠** → 会命中**任意层级、任何名为 `screenshots` 的目录**，实测 `git check-ignore -v docs/acceptance/screenshots/01-desktop.png` 命中该行。

**后果**：帮助中心的截图目录**必须叫 `assets/`**，不能叫 `screenshots/`。若建成 `docs/help-center/screenshots/`，所有帮助中心截图会被静默忽略、永远入不了库，且 `git status` 不会有任何提示。

### 3. 删除前一律先 `mv` 到仓库外暂存区

`release/`、`artifacts/`、`docs/acceptance/screenshots/`、`dist/`、`.playwright-cli/`、`.db-backups/` 全部未跟踪且被 ignore，**`rm` 之后 git 无法恢复、无回收站可依赖**。

统一做法：

```bash
mkdir -p ~/gx-trash-20260920
# 例：mv release ~/gx-trash-20260920/release
# 观察一轮（跑通 typecheck / test / build）确认无影响后，再自行清空 ~/gx-trash-20260920
```

---

## 待裁决条目

### 1. 截图主体：约 290 张 / ~30 MB（09-18 21+22 批、09-19 05+06 批）

- **体量/位置**：`docs/acceptance/screenshots/` 全目录 **60 M**。其中根目录 367 个 PNG（39.9 MB）+ `nav-governance/` 108 文件（12 M）+ `entity-icon-smoke/` 67 文件（6.9 M）。待裁决部分为根目录的两批：
  - 09-18 21 批：69 张 / 11.8 MB（`01-desktop`…`08-wizard-step2`，fnOS 安装流程）
  - 09-18 22 批：4 张 / 0.3 MB（同批续拍）
  - 09-19 05 批：178 张 / 15.7 MB（`01-root`…`07-table2`、`08-kb-list`…，库/表/KB 全量走查）
  - 09-19 06 批：5 张 / 0.6 MB（续拍）
- **为什么现在不敢删**：两批是**同一批场景换编号整体重拍**（都有 desktop / root / appcenter / base-home / table-view / trash 等同一组画面），但**没有任何文档声明哪一批是权威留证**。反而两批都有文档挂账：`docs/acceptance/2026-09-18-fnos-ux-acceptance.md:42` 记"截图 67 张"、`:345` 记"截图证据（72 张）"；09-19 05 批又是独立的一轮全量走查。"同场景不同字节"的近似重复**无工具证据**（md5 只能证明完全相同的 39 组 / 54 副本 / 5.5 MB，那部分已单列可删）。
- **删了会怎样**：若删掉的是被某份验收报告当作留证的那批，该报告就变成"有结论、无证据"，事后无法复盘。**留着会怎样**：占 30 MB 本地磁盘，不进 git、不影响构建与测试。
- **建议倾向**：**需先看 `docs/acceptance/2026-09-18-fnos-ux-acceptance.md` 与 `2026-09-19-menu-table-smoke.md` 定"哪批算权威留证"再定**。在此之前一律**保留**。
- **证据**：`stat -f "%Sm %z" -t "%Y-%m-%d %H" *.png` 按小时桶统计；`find . -name "*.png" -exec md5 -r {} \;` 得 39 组完全重复；`git ls-files docs/acceptance/screenshots` = 4 条。

---

### 2. `artifacts/bench/` 6.5 M —— 已 grep 结论：**文档确实引用，倾向保留**

- **体量/位置**：`artifacts/bench/` **6.5 M**（9 组 `*.json` / `*.md` / `*.read|write.server.log`，均为 2026-09-13，M1 时期压测；另有 `artifacts/bench/cpu-prof/` 5.1 M 的 `.cpuprofile`）。
- **为什么现在不敢删（grep `docs/**` 的实测结论：有引用，且是硬引用）**：
  - `docs/adr/0008-sqlite-capacity-falsification-gate.md:147-148`：产物清单直接写 `artifacts/bench/5000-c8-on.json`、`5000-c8-on.md`、`5000-c8-on.{read,write}.server.log`
  - 同 ADR `:267`、`:268`、`:272`：证据表三行把 `artifacts/bench/5000-c8-on.json` 列为 E2 级证据来源
  - `docs/baseline/2026-09-13-m1-s10-t0-unlock.md:29`（`5000-c8-on-fixed.*`）、`:79`（`100k-c1-gate-clean.*`）、`:111,:117`（复跑命令 `--out-dir artifacts/bench`）
  - `docs/baseline/2026-09-13-m1-s10-gate.md:117`：明写"产物默认落 `artifacts/bench/`"
  - `docs/baseline/2026-09-14-s5b-cpuprof-attribution.md:47,55,59`：cpu-prof 复跑命令 `--out-dir artifacts/bench/cpu-prof`
  - **最关键**：ADR-0008 `:329` 记"S5b-Ⅱ（字段投影器）**正式后移**"这一**已生效的架构决策**，其证伪依据正是 2026-09-14 cpu-prof 归因（点引三函数 self 仅 1.15%）。删掉产物 = 抽掉这条决策的原始证据。
  - 反证（也照实记）：ADR-0008 `:29` 自陈"E2 本地产物 落于 `artifacts/`（gitignored），附复跑命令可重新生成"。
- **删了会怎样**：ADR-0008 与 3 份 baseline 出现指向不存在路径的证据行，S5b-Ⅱ 后移决策失去可复核依据。**留着会怎样**：占 6.5 M 本地磁盘，不进 git。
- **建议倾向**：**保留**。若一定要删，需先把上述 4 份文档里的路径引用改为"见 §5 复跑命令 / 已归档"，否则文档会失真。
- **证据**：Grep `artifacts/bench|5000-c8|100k-c1|cpu-prof` 全仓（排除 node_modules）命中 6 份 md，行号见上。

---

### 3. `.db-backups/` 5.0 M

- **体量/位置**：根目录 `.db-backups/` **5.0 M**：`dev.db-pre-qa-1789764718.bak` 1,028,096 B、`dev.db-wal-pre-qa-1789764718.bak` 4,202,432 B（均 2026-09-19 04:51）、空目录 `20260912-100746/`。
- **为什么现在不敢删**：文件名 `pre-qa` 表明是某次 QA 前的库快照，属取证素材而非构建产物。`.workbuddy/memory/2026-09-19.md:188` 的清理清单里明确列了 `.db-backups/dev.db-pre-qa-*.bak`×2 —— 说明**有人已经注意到它但尚未处置**。另：`docs/_archive/originals/planning-phase2-M0-implementation-plan.md:39,730` 记 `.db-backups/20260912-100746/` 是"分别 cp 的多文件、非 WAL 一致性快照"，那是旧备份机制的负面证据，也说明这个目录被文档引用过。
- **删了会怎样**：若 QA 阶段还要对 pre-QA 状态做比对/复现，就再也回不去。**留着会怎样**：占 5 M 本地磁盘，已 ignore。
- **建议倾向**：**保留**（成本低、取证价值明确）。若要删，请先确认当前 QA 轮次已收口（任务 #395「VM 清库重部署 + 全量走查」结束之后再议）。
- **证据**：`ls -la .db-backups`；Grep `db-backups` 命中 `docs/_archive/originals/planning-phase2-M0-implementation-plan.md:39,204,730`、`apps/api/scripts/backup/online-backup.mjs:27`（默认备份目录同名 `apps/api/.db-backups`，与根目录这份不是同一个）。

---

### 4. `.workbuddy/artifacts/` 1.5 M

- **体量/位置**：`.workbuddy/artifacts/` **1.5 M**，**21 个文件**；含 `ui-redesign-shots/` 344 K。
- **为什么现在不敢删**：这不是"过程垃圾"，里面是**正式交付文档与调研报告**：`kb-module-delivery.md`（知识库模块交付）、`表单设计器全链路修复报告.md`、`KB六大功能深度测试报告.md`、`field-validation-and-kb-module-plan.md`、`field-settings-upgrade-plan.md`、`default-values-upgrade-plan.md`、`overview.md`，以及 13 张中文命名的功能截图（子表格/选项卡/详情抽屉/设计器移动端适配等）。`.gitignore` 只忽略 `.workbuddy/verify/` 与 `.workbuddy/**/*.png`，**没有忽略这整个目录**，说明 `.md` 是被当作可入库内容对待的。
- **删了会怎样**：丢掉知识库模块与表单设计器的交付/修复报告原文，以及一批真实 UI 缺陷证据截图。**留着会怎样**：占 1.5 M。
- **建议倾向**：**保留**（其中 13 张 PNG 若确要瘦身，可考虑只保留 `.md`、删 PNG，但需主理人点头）。
- **证据**：`find .workbuddy/artifacts -type f | wc -l` = 21；`.gitignore` 中 `.workbuddy/` 段只排除 `verify/` 与图片后缀。

---

### 5. `apps/api/artifacts/` 6.0 M

- **体量/位置**：`apps/api/artifacts/bench/` **6.0 M**，其中 `cpu-prof/` **5.1 M**、`t0-rerun-on-c8-full.{json,md,read|write.server.log}` 约 0.9 M。
- **为什么现在不敢删**：
  - `t0-rerun-on-c8-full.*` 被文档引用：`docs/baseline/2026-09-13-m1-s10-t0-closure-multinum.md:7`、`:118`（复跑命令 `--out-dir apps/api/artifacts/bench`）、`:122`、`:124`。
  - `cpu-prof/` 被 `docs/baseline/2026-09-14-s5b-cpuprof-attribution.md:129` 明确引用（写的是 `apps/api/artifacts/bench/cpu-prof/`）。
  - 但实测 `apps/api/artifacts/bench/cpu-prof/`（5.1 M）与根目录 `artifacts/bench/cpu-prof/`（5.1 M）**是同一批 `.cpuprofile` 的两份拷贝**（文件名一一对应：p2-home / p2-home-on / p2-range / p2-range-on）。
- **删了会怎样**：删错那份（apps/api 的）会让 `s5b-cpuprof-attribution.md:129` 指向空路径。**留着会怎样**：多占 5.1 M 的**纯重复**。
- **建议倾向**：`t0-rerun-on-c8-full.*` **保留**；`cpu-prof/` 两份二选一 —— **保留被文档点名的 `apps/api/artifacts/bench/cpu-prof/`，删根目录 `artifacts/bench/cpu-prof/`**（或反之，但必须先统一文档里的路径写法）。
- **证据**：`du -sh artifacts/bench/cpu-prof apps/api/artifacts/bench/cpu-prof` = 各 5.1 M；`find apps/api/artifacts -type f` 列出 16 个文件。

---

### 6. `/tmp/gx-*` 732 M（255 个条目）—— **与本项目有关，不是无关垃圾**

- **体量/位置**：仓库外 `/tmp`，**255 个条目 / 732 M**（`du -csh /tmp/gx-*`）。
- **为什么现在不敢删**：**先纠正一个可能的误解——它与本仓库强相关**，产生者可逐条溯源：
  - `docs/acceptance/acceptance-run.mjs:12` → `gx-acceptance-${randomUUID()}`
  - `scripts/dev-up.sh:16-17` → `gx-v2-api.log` / `gx-v2-web.log`
  - `scripts/acceptance/run-upgrade-drill.sh:31,44` → `gx-upgrade-drill-*`、`/tmp/gx-v010/apps/api`
  - `scripts/acceptance/run-rollback-drill.sh:29` → `gx-rollback-drill-*`
  - `apps/api/src/routes/__tests__/records-keyset.test.ts:39` → `mkdtemp gx-keyset-route-`
  - `scripts/acceptance/rollback/selftest-netguard.mjs:15` → `gx-netguard-selftest-*`
  - 另有 `gx-api-dev/test.log`、`gx-recheck/`、`gx-t0-rerun/` 等被 `docs/baseline/*` 与 `docs/acceptance/*` 提及。
  - **硬约束：必须等本项目所有跑测结束后才能清。** 当前仍有 in_progress 跑测（任务 #106 三档 run-gate shadow 双跑、#347 api 全量门、#350 api 全量门重跑、#305 部署物冒烟）。此时清 /tmp 会直接打断正在跑的测试/演练，且失败原因极难定位。
- **删了会怎样**：打断进行中的跑测；或丢失演练中间产物导致结论无法复核。**留着会怎样**：占 732 M 磁盘（在 `/tmp`，不占仓库配额；系统重启通常自动清）。
- **建议倾向**：**保留到全部跑测收口**；收口后整批清（`/tmp` 本就是临时区，清它不需要 mv 暂存）。
- **证据**：`ls -d /tmp/gx-* | wc -l` = 255；`du -csh /tmp/gx-*` = 732 M；Grep `/tmp/gx-` 命中 6 个仓库内脚本/测试 + 多份文档。

---

### 7. `apps/desktop/` 空壳 —— 删＝砍掉桌面端路线，属产品决策，不是瘦身决策

- **体量/位置**：`apps/desktop/` 540 K（其中 508 K 是 node_modules）。**git 入库仅 9 个文件**。
- **为什么现在不敢删**：
  - 实测确认为空壳：`src/main.ts` 全文只有 `void 0;`（1 行）；`src-tauri/src/lib.rs` 24 行（Tauri 模板）、`main.rs` 5 行、`build.rs` 2 行、`package.json` 21 行。无任何业务代码。
  - 但它是**有意保留的占位**：根 `package.json:15,19` 有 `dev:desktop` / `build:desktop` 两个脚本指向它；README 所述技术路线含"客户端壳化"。
  - **删除它的含义是砍掉桌面端（Tauri）路线**，这不是"清理冗余文件"，是产品方向决策，瘦身任务无权决定。
- **删了会怎样**：桌面端路线归零，将来想做要从零重建脚手架；且要同步删 `package.json` 的两个脚本。**留着会怎样**：占 540 K，不产生构建负担（未被任何 build/test 主流程调用）。
- **建议倾向**：**保留**。若主理人明确决定放弃桌面端，再单独立项处理（含删脚本、改 README），不要夹带在瘦身里。
- **证据**：`wc -l apps/desktop/src-tauri/src/lib.rs src-tauri/src/main.rs src/main.ts` = 24 / 5 / 1；`git ls-files apps/desktop | wc -l` = 9；Grep `@gx/desktop` 仅命中 `package.json:15,19`。

---

### 8. 四个「UI 无入口但功能仍在」的组件 —— **一律保留**

> 主理人明确交代：**UI 没入口 ≠ 功能冗余，很可能是新版 UI 漏做了入口。** 这四条按此口径一律标「保留」。

#### 8.1 `apps/web/src/features/designer/ViewSettingsPanel.tsx`（132 行）

- **功能是什么**：视图设置面板 —— 视图**重命名 / 锁定模式（协作·已锁定）/ 复制视图 / 删除视图**。`LOCK_OPTIONS`（`:21-`）已完整实现，含 `confirmIrreversible` 危险操作二次确认（`:11`）。
- **零 import 的实证**：全仓（含 `.test.`）Grep `ViewSettingsPanel` 仅 2 处命中，都在旧壳注释里 —— `features/shell/TopBar.tsx:220`（"designer/ViewSettingsPanel **尚未实现**，集成时替换"）、`:223`（"视图设置面板将在 designer 模块接入（ViewSettingsPanel）"）。**没有任何 `import`。**
- **本应挂在哪个界面位置**：旧壳 `features/shell/TopBar.tsx:220-223` 那个占位 `<Modal>` 的位置；新壳则应挂在表页视图上下文菜单 / ContextBar 的视图操作区。
- **用户现在点相关位置看到的是什么**：**旧壳**：`TopBar.tsx:146` 有"视图设置"图标按钮，点开是 `:221-224` 的**占位 Modal**，正文写着"视图设置面板将在 designer 模块接入"——即点了没功能。**新壳**：对 `apps/web/src/features/workspace/` 全目录 Grep「视图设置」**零命中**，连入口都没有。
- **建议倾向**：**保留**（且建议单独立项把入口补上）。
- **证据**：Grep `designer/ViewSettingsPanel` 全仓；`sed -n '1,20p'` 与 `sed -n '21,40p'` 读实现；`TopBar.tsx:146,220-223`。

#### 8.2 `apps/web/src/features/designer/RecordFilterBuilder.tsx`（112 行）

- **功能是什么**：**子集筛选条件 UI**，专供 Rollup / Lookup / Count 三类字段用——在对面表上按字段条件筛选参与聚合的记录（仅支持一个 AND 拼接的条件列表，`:3-4`）。
- **零 import 的实证**：全仓 Grep `RecordFilterBuilder` 命中 2 处：自身文件头注释；`components/ui-five-states.test.tsx:236`（该测试是**把源码当文本读取做静态检查**，不是组件引用）。**无任何 `import`。**
- **本应挂在哪个界面位置**：`features/designer/FieldEditorSheet.tsx` 的「查阅/聚合/计数」配置区（`:605` 的 `isLookupLike` 分支内）。
- **用户现在点相关位置看到的是什么**：`FieldEditorSheet.tsx:592-601` 的"关联筛选条件（可选）"用的是 `FilterRuleModal` 的 `FilterRuleField`，**不是它**。也就是说：字段编辑器里**有**一个筛选条件控件，但那是给「关联字段」用的另一套；**Rollup/Lookup/Count 的子集筛选这一块目前没有 UI**。
- **建议倾向**：**保留**（需人工确认是"漏做入口"还是"已被 FilterRuleField 取代"，二者需要对照 `FieldEditorSheet.tsx:605+` 判定）。
- **证据**：Grep `RecordFilterBuilder`；`sed -n '588,615p' features/designer/FieldEditorSheet.tsx`。

#### 8.3 `apps/web/src/features/designer/FormulaBuilder.tsx`（227 行）

- **功能是什么**：公式构建器 —— 字段/函数插入 + **实时括号配平与引用校验**（纯前端校验，不请求后端，`:2`）。内置函数分组表 `FUNCTIONS`（逻辑/文本/数学/日期等，`:17-`），支持 `compact` 紧凑模式用于右侧设置面板窄空间（`:13`）。
- **零 import 的实证**：全仓 Grep `FormulaBuilder` **连测试都没有命中，只有自身文件头 1 行**。零 `import`。
- **本应挂在哪个界面位置**：字段编辑器的公式字段配置区 / 右侧设置面板的窄空间。
- **用户现在点相关位置看到的是什么**：公式编辑走的是 `FormulaEditorModal.tsx`（375 行，被 `FieldSettingsPanel.tsx:27` 与 `DefaultValueEditor.tsx:26` 引用），该 Modal **已自实现**"左栏函数分类列表（含搜索，`:106-111`）+ 右栏公式编辑区 + 实时校验 + 当前函数说明卡"（`:3-5`）。所以用户**有**公式编辑能力，只是走的是另一套组件。
- **建议倾向**：**保留**（疑被 `FormulaEditorModal` 取代，但需人工比对两者在函数覆盖/校验口径上是否等价再定；在比对前不得删）。
- **证据**：Grep `FormulaBuilder`（仅 1 处自身）；`FormulaEditorModal.tsx:3-5,106-111`；`FieldSettingsPanel.tsx:27`。

#### 8.4 `apps/web/src/features/workspace/MoveImpactModal.tsx`（82 行）

- **功能是什么**：**权威移动影响确认模态**。把实体拖到 nav group（改 `nav_nodes.parentId`）时，后端不带 `confirmed` 会返回 **409 `MOVE_NEEDS_CONFIRM` + impact**；本模态展示影响面，用户确认后 `confirmed=true` 重发（`:4-6`）。
- **零 import 的实证**：全仓 Grep `MoveImpactModal` 命中 3 处，全部是注释/测试文字：`MoveToGroupModal.tsx:2`（注释"409 再走 MoveImpactModal"）、`lib/ac-m3-1.test.ts:7` 与 `:289`（测试注释与用例标题）。**无任何 `import`。**
- **本应挂在哪个界面位置**：任何触发 nav_nodes 权威移动并收到 409 的前端流（原设计是 NavComposer 的拖拽）。
- **用户现在点相关位置看到的是什么**：**这条要特别注意** —— 后端与数据层**都还在**：`nav-hooks.ts:25 extractMoveImpact`（409 提取函数，有测试 `ac-m3-1.test.ts:289` 覆盖）、`api/client.ts:1092` 的 `GET /api/v1/nodes/:id/move-impact`。但实测 `useMoveNode` / `usePatchMenu` / `useCreateGroup` **只剩测试 mock 引用**（`nav-menu-polish.test.tsx:31-32`），生产零调用方；`SecondaryNav.tsx:9` 注释明写"「收纳到导航」入口已下线"。即：**当前没有任何界面会触发这个 409**，所以用户看不到任何东西——既不是"功能正常"，也不是"点了报错"。
- **建议倾向**：**保留**。若确认新壳不再提供 nav_nodes 权威移动（任务 #378「下线导航编排前端入口」落地后可确认），再与 #378 一并裁决；若新壳将来恢复任何权威移动入口，这个模态就是必需的。
- **证据**：Grep `MoveImpactModal` / `MOVE_NEEDS_CONFIRM` / `extractMoveImpact` / `useMoveNode`；`nav-hooks.ts:17,25-29`；`api/client.ts:1092`；`SecondaryNav.tsx:9`。

---

### 9. `apps/web/src/features/workspace/composer/ComposerTree.tsx`（269 行）—— 删前必须同步改测试

- **体量/位置**：269 行，位于已下线的 NavComposer 组件族内（`composer/` 目录三个文件互不 import，均无生产引用）。
- **为什么现在不敢删（与同目录另两个文件的关键区别）**：它不是"零引用"，而是**仅被测试引用**：
  - `apps/web/src/features/workspace/nav-dom-bounds.test.tsx:20` —— `import { ComposerTree } from "./composer/ComposerTree";`，并在 `:71`、`:78` 实际渲染、`:99` 打印度量。
  - 另有 `lib/nav-window.test.ts:249` 以**文本读取**方式断言其源码（删文件会让该用例的 read 失败）。
  - 生产引用：零。
- **删了会怎样**：直接删会让 `nav-dom-bounds.test.tsx` 编译失败（模块解析不到），连带 `nav-window.test.ts:249` 的 read 断言失败 → **测试门红**。**留着会怎样**：269 行死代码留在仓库里。
- **建议倾向**：**删除**，但**必须先同步修改 `nav-dom-bounds.test.tsx:20` 的依赖**（删掉 ComposerTree 的 import 与 `:71-99` 那条用例），并同步处理 `lib/nav-window.test.ts:243-249` 对 `../composer/ComposerTree.tsx` 的读取断言。建议与任务 **#378（下线导航编排前端入口）** 一并执行，不要单独动。
  - 同目录另两个文件 `DeleteMenuModal.tsx`（107 行）、`GroupCreateModal.tsx`（56 行）是真正的零引用（连测试都没有），可随 #378 直接删，无需改测试。
- **证据**：Grep `ComposerTree|DeleteMenuModal|GroupCreateModal` 全 `apps/`；`nav-dom-bounds.test.tsx:20,71,78,99`；`nav-window.test.ts:243,249`。

---

### 10. 附：一条差点造成误删的反证（供后续执行者参考，非待裁决项）

`apps/web/src/features/workspace/SecondaryNavKbOps.tsx:3` 与 `secondary-nav-lost-features.test.tsx:4` 的注释都写着"旧壳 KbTree（`features/kb/KbTree.tsx`）**已无任何引用点**"。

**该注释已过期/错误**：`features/kb/KbSidebar.tsx:9` 仍在 `import { KbTree } from "./KbTree"`，并在 `:70` 渲染；`KbSidebar` 又被 `KbShell.tsx:8` 引用，`KbShell` 再被 `ShellGate.tsx:10` 引用 → 最终由 `App.tsx:160` 在 `GX_ENTERPRISE_NAV=off` 时挂载。

**执行清理时：只认 import 证据，不认注释。** 同理 `features/shell/*` 与 `features/sidebar/Sidebar.tsx` 是 flag-off 回退壳（PRD 有"双壳保留一个迭代"的回滚承诺），不是旧垃圾。
