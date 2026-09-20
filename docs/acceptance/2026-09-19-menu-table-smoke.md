# 真机冒烟验收报告 — L1 菜单精细化 / 数据表精细化

- 验收日期：2026-09-19
- 验收对象：`4107c3f` L1 菜单精细化、`32d6773` 数据表区域精细化
- 验收方式：真机（Chromium 常驻实例 `agent-browser`）+ DOM 实测取数 + API 交叉校验
- 角色：QA（**未修改任何业务代码，未提交任何 commit**）

---

## 1. 结论

**有条件通过（Conditional Pass）**

| 维度 | 结论 |
|------|------|
| L1 菜单（手风琴移除 / 节奏 / 图标语义） | ✅ 通过 |
| 深层浮出子菜单（位置 / 圆角 / 阴影 / 入场动画 / 键盘 / 防误关 / 收窄档） | ✅ 通过 |
| 浮出「自动翻转到左侧」 | ⚠️ **有条件通过** — 逻辑正确（注入位移实测通过），但**当前 L1 布局下该分支不可达**，真实窗口宽度无法触发（见缺陷 D-1） |
| 数据表精细化（行高 / 表头 / 内边距 / 对齐 / 状态 / 优先级 / 空值） | ✅ 通过 |
| 悬停 / 选中 / 冻结列白缝（本轮两个修复项） | ✅ 通过，已复测确认 |
| 表格功能回归（排序/筛选/分组/批量/复制视图/新建/行内编辑/删除撤销/行高三档） | ✅ 通过 |
| 其他页面回归抽查（5 页） | ✅ 通过，0 控制台错误 / 0 页面异常 / 0 失败请求 |

**放行的前提条件**：缺陷 D-1（浮出翻转分支不可达）需产品/架构确认是「接受现状」还是「补兜底」。其余无 P0/P1 阻塞项。

> 说明：本报告所有像素/颜色结论均来自浏览器 DOM `getComputedStyle` + `getBoundingClientRect` 实测数值，并附截图供人工复核。**QA 侧模型无法查看 PNG 图像内容**，故不以"看截图"作为判定依据，全部以数值为准。

---

## 2. 环境

| 项 | 值 |
|---|---|
| 仓库 | `/Users/daijing/Desktop/GouXiangDB` |
| HEAD | `4107c3f`（菜单）、`32d6773`（表格） |
| 启动方式 | `bash scripts/dev-up.sh restart` |
| API | `http://localhost:3001`（pid 52168，health 200），DB = `apps/api/prisma/dev.db` |
| Web | `http://localhost:5173`（pid 52197，Vite 7.3.6；**仅监听 `[::1]`，须用 `localhost` 而非 `127.0.0.1`**） |
| 账号 | `test@gx.dev`（工作区 owner，含 测试数据库/统一测试知识库 数据） |
| 口令获取 | 未猜测。官方脚本 `apps/api/scripts/init-admin.ts --reset`（产物 `apps/api/dist/init-admin.js`，`DATABASE_URL` 指向 `apps/api/prisma/dev.db`）重置后，经 `/api/auth/me/change-password` 改为自设口令；`mustChangePassword=false`，`tokenVersion=17` |
| 登录态 | Zustand persist，`localStorage["gx-auth"]`；守护进程重启会丢失，需重新注入 |
| 浏览器 | `agent-browser`（vercel-labs）常驻 Chromium |
| 视口 | 主测 1440×900；另测 1280×900 / 1024×900 / 900×900 / 800 / 768 / 700 / 640 / 600 / 560 |
| 自动化前置 | 每次操作前注入 `window.confirm = () => true`（原生对话框会挂住自动化） |
| 编译/单测（他人已验） | `pnpm --filter @gx/web typecheck` 0 error；`pnpm --filter @gx/web test` 547 passed / 40 files |

**测试数据与清理**：
- 因现有菜单只有两层，无法验证深层浮出 → 自建三级导航（QA4组 › QA4子组 › 测试数据表2 / 产品需求说明文档）。
- 因现有表缺 状态/优先级/工时 字段 → 自建一次性测试库 `QA冒烟库-可删除`（含 6 条记录），**未动用户主库**。
- 验收结束已全部清理：QA 库删除 200；`menu_qa4_*` 菜单项删除 200；`navgrp_*` 分组删除 200（`strategy=retain`）。复核：`GET /api/bases` 仅剩 `测试数据库`（tableCount 2）；主库视图配置未变（`rowHeight:"medium"`、`filters:null`、`sorts:[]`、`groupByFieldId:null`）；菜单恢复 16 行、无 QA 残留。
- `git status --porcelain | grep -E "apps/|packages/"` → **空**（业务代码零改动）。

---

## 3. 菜单（L1）逐项结果

### 3.1 手风琴已移除 / 分组标题 + 平铺菜单项

| 检查项 | 结果 | 截图 | 实测值 |
|---|---|---|---|
| 点击分组标题不再就地展开/收起 | ✅ | `smoke-01-landing-table.png`、`smoke-02-group-click-no-accordion.png`（**两张 MD5 相同 `e4c28db3…`，即点击前后画面完全一致，正是"无变化"的证据**） | 点击「测试数据库」「统一测试知识库」前后 `[data-nav-row]` 行数恒为 **16** |
| 深层子项始终平铺可见 | ✅ | 同上 | 16 行全部渲染，无隐藏 |
| 无展开/收起箭头 | ✅ | 同上 | 分组行内无 chevron 类图标（仅有标题文本） |
| 分组标题行语义 | ✅ | 同上 | `data-nav-row="group"`；「个人用户」为 `DIV`（不可交互）；「测试数据库」「统一测试知识库」为 `BUTTON`（仅切换 L2 面板：L2 标题文本由「测试数据库」变为「统一测试知识库」） |
| 分组标题行高度 | ✅ | 同上 | **h = 24**，`NAV_GROUP_ROW_H=24` |
| 分组标题字号/字重/色 | ✅ | 同上 | **11px / 500 / `rgb(138,148,172)`**（#8A94AC hint 色）；激活分组为 accent `rgb(58,109,240)` |
| 分组行下间距 | ✅ | 同上 | `margin-bottom = 2`（`NAV_ROW_GAP=2`） |
| 菜单项行高度 | ✅ | 同上 | **h = 32**（`ITEM_SHELL` = `h-8`） |
| 菜单项字号 / 左内边距 / 图文间距 | ✅ | 同上 | **13px** / `px-2` → **padding-left 8** / `gap-2` → **8** |
| 图标尺寸 | ✅ | 同上 | SVG **14×14**，`viewBox 0 0 24 24`，`stroke-width 1.75` |
| 图标/文字水平位置 | ✅ | 同上 | 图标 left=14；文字 left=36（间距 8 稳定） |
| 选中态 | ✅ | 同上 | bg `rgb(255,255,255)`、`font-weight 600`、文字 `rgb(58,109,240)` |
| 未选中 hover | ✅ | 同上 | bg `rgb(241,245,251)`（#F1F5FB） |
| 过渡 | ✅ | 同上 | `transition: color, background-color … 0.15s`（`NAV_ROW_TRANSITION`） |
| 底部区与主区分隔 | ✅ | 同上 | `border-top: 1px rgb(233,239,249)` |

### 3.2 图标语义逐项核对（反查 `icons.tsx` 的 `PATHS` 签名后比对线上 DOM SVG path）

| 菜单项 | 期望语义 | 实测图标 | 尺寸 | 结果 |
|---|---|---|---|---|
| 个人门户 | 用户 | `user` | 14 | ✅ |
| 工作台首页 | 首页 | **`home`（新增）** | 14 | ✅ |
| 我的待办 | 待办/勾选项 | **`checkSquare`（新增）** | 14 | ✅ |
| 我的收藏 | 收藏 | `star` | 14 | ✅ |
| 测试数据库（挂载容器） | 数据库 | `database` | 14 | ✅ |
| 客户表(冒烟) / 测试数据表2 | 表 | `table` | 14 | ✅ |
| 统一测试知识库（挂载容器） | 知识库 | `book` | 14 | ✅ |
| 各文档 | 文档 | `doc` | 14 | ✅ |
| 各画布 | 画布 | `canvas` | 14 | ✅ |
| 通讯录 | 组织 | `building` | 14 | ✅ |
| 权限管理 | 权限 | `shield` | 14 | ✅ |
| 导航编排 | 编排 | `sitemap` | 14 | ✅ |
| 工作区设置 | 设置 | **`settings`** | 14 | ✅ |
| 收起导航 | 收起 | `chevronLeft` | 14 | ✅ |
| 浮出面板行尾指示 | 下一级 | `chevronRight`（12px） | 12 | ✅ |

**缺失/不匹配项：无。** 全部 15 类图标齐全，尺寸统一 14×14，无 emoji。

### 3.3 深层浮出子菜单

| 检查项 | 结果 | 截图 | 实测值 |
|---|---|---|---|
| hover 触发浮出 | ✅ | `smoke-03-flyout-open-right.png`、`smoke-10-flyout-vw1024.png` | `[class*=gx-flyout-in]` 面板出现 |
| 面板定位方式/宽度 | ✅ | 同上 | `position: fixed`；`width = 200`（`FLYOUT_PANEL_W`） |
| 与触发行间距 | ✅ | 同上 | **8**（`FLYOUT_GAP`）：触发行 `[6,217]` → 面板 `[225,425]` |
| 纵向对齐 | ✅ | 同上 | 面板 top 与触发行 top 一致（618 / 576 两档均一致） |
| 圆角 | ✅ | 同上 | `border-radius = 8px`（`rounded-gx-lg`） |
| 边框 | ✅ | 同上 | `1px rgb(223,227,234)` |
| 阴影 | ✅ | 同上 | `shadow-gx-lg` |
| 入场动画 | ✅ | 同上 | `animation: gx-flyout-in-right 0.15s ease-out` |
| 层级 | ✅ | 同上 | `z-index = 900`（`gx-z-popover`），浮于内容之上 |
| 面板内结构 | ✅ | 同上 | 面板头 h=24、11px、带 1px 下边框；菜单行 h=28、12px、图标 14 |
| 无视口溢出 | ✅ | 同上 | `右溢出=false`，`左溢出=false` |
| 键盘：Tab 聚焦触发行即打开 | ✅ | `smoke-04-flyout-keyboard-tab-open.png` | Tab×2 后 `document.activeElement` = 「QA4子组」`BUTTON[data-nav-row="item"]`，面板同步打开 |
| 键盘：Esc 关闭并回焦 | ✅ | `smoke-05-after-esc-closed.png` | Esc 后面板消失，**焦点仍在触发行** |
| 斜穿 8px 间隙不误关 | ✅ | （DOM 计时） | 鼠标 `(110,634) → (320,660)` 对角穿越，面板保持打开（`panelStillOpen:true`，落点为面板内 SPAN）；实测关闭延迟 **153ms**（`FLYOUT_CLOSE_DELAY_MS=150`） |

### 3.4 浮出「自动翻转到左侧」——⚠️ 有条件通过

真实窗口宽度扫描（触发行恒为 L1 最左侧，`left=6`）：

| 视口宽 | L1 状态 | 侧 | 触发行 | 面板 | 溢出 | 截图 |
|---|---|---|---|---|---|---|
| 1440 | 展开 224 | right | `[6,217]` | `[225,425]` w200 | 无 | `smoke-03-flyout-open-right.png` |
| 1280 | 展开 224 | right | `[6,217]` | `[225,425]` w200 | 无 | — |
| 1024 | 展开 224（菜单区需滚动） | right | `[6,217]` | `[225,425]` w200 | 无 | `smoke-10-flyout-vw1024.png` |
| 1000 / 900 / 800 / 768 | **自动收窄为 56 图标栏** | right | `[6,49]` | `[57,257]` w200 | 无 | `smoke-11-flyout-vw900-collapsed.png` |
| ≤700 | `aside` 整体消失（移动端布局） | — | — | — | — | — |

**结论**：`fitsLeft` 要求 `触发行.left - 208 ≥ 8` 即 `left ≥ 216`，而 L1 触发行 `left` 恒为 6；同时展开态只在 vw≥1024 渲染，此时右侧需求 425 永远放得下。**因此"翻转到左侧"分支在当前 L1 布局下不可达**（详见缺陷 D-1）。

为验证分支逻辑本身正确，采用注入位移把触发行推到近右缘（`aside.style.marginLeft`），强制构造"右侧放不下、左侧放得下"：

| 场景 | 视口 | 触发行 | 面板 | 侧 | 左间距 | 动画 | 截图 |
|---|---|---|---|---|---|---|---|
| 位移 1020 | 1280 | `[1026,1237]` | `[818,1018]` w200 | **left** | **8** | `gx-flyout-in-left 0.15s ease-out` | `smoke-12-flip-left-vw1280.png` |
| 位移 1180 | 1440 | `[1186,1397]` | `[978,1178]` w200 | **left** | **8** | `gx-flyout-in-left 0.15s ease-out` | `smoke-13-flip-left-vw1440.png` |

→ 翻转计算、间距、动画名/时长均正确，无溢出。

### 3.5 收窄档 56

| 检查项 | 结果 | 截图 | 实测值 |
|---|---|---|---|
| 点击收起后仅剩图标 | ✅ | `smoke-08-collapsed-rail-toggled.png` | `aside` 宽 **56**；图标行宽 43、`justify-center px-0`；分组标题行数量 **0**（`iconOnly` 时 `GroupHeaderRow` 返回 null） |
| 收窄态 hover 图标行仍能浮出且定位正确 | ✅ | `smoke-06-flyout-on-collapsed-rail56.png` | 触发行 `[6,514,49]` → 面板 `[57,514,257]` w200，侧 right，间距 **8**，无溢出 |
| 收窄态持久化 | ✅ | `smoke-09-collapsed-persist-after-reload.png` | 刷新后 `localStorage["gx.l1.collapsed"]="1"`，`aside` 仍为 56 |
| 展开恢复 | ✅ | 同上 | 点「展开导航」后 `aside` 回到 224 |

---

## 4. 数据表逐项结果（均为 DOM 实测像素值）

测试表：一次性库 `QA冒烟库-可删除` / `QA冒烟表`（字段：名称、数量、状态、日期、备注、优先级、工时；6 条记录）。视口 1440×900，`rowHeight=medium`。

| 检查项 | 结果 | 截图 | 实测值 |
|---|---|---|---|
| 表头行高 | ✅ | `smoke-20-qa-table-overview.png` | **36**（8 个 `th` 全部 36） |
| 数据行高（常规档） | ✅ | 同上 | **44**（8 个 `td` 全部 44） |
| 表头背景 | ✅ | 同上 | `rgb(249,250,252)` = **#F9FAFC** |
| 表头字号 / 字重 / 字色 | ✅ | 同上 | **12px / 500 / `rgb(91,103,133)` = #5B6785**（7 个字段表头全部一致） |
| 单元格左右内边距 | ✅ | 同上 | **12px / 12px**（`px-3`，7 列全部） |
| 主键列字重 | ✅ | 同上 | 名称列 `font-weight 500` |
| 列对齐（表头 ↔ 单元格同侧） | ✅ | 同上 | 表头 `[left, right, left, left, left, left, right]` ↔ 单元格 `[flex-start, flex-end, flex-start, flex-start, flex-start, flex-start, flex-end]`；**数量、工时右对齐，文本列左对齐，表头与单元格完全同侧** |
| 表头无竖向分割线 | ✅ | 同上 | 普通列 `border-right-width = 0px`（数量/状态均为 0）；仅冻结列「名称」保留 1px 右边框（功能性分隔，见建议 A-2） |
| 行分隔线 | ✅ | 同上 | `1px rgb(233,239,249)`（`gx-hairline`） |
| 状态列 = 药丸 | ✅ | 同上 | `data-gx-status-pill="true"`；`border-radius 9999px`、h=17、11px |
| 状态药丸四态配色（浅底深字） | ✅ | 同上 | 进行中 `rgba(58,109,240,0.18)` / 字 `rgb(29,55,120)`（蓝）；待评审 `rgba(224,138,46,0.18)` / 字 `rgb(112,69,23)`（橙）；已完成 `rgba(46,158,107,0.18)` / 字 `rgb(23,79,54)`（绿）；待开始 `rgba(138,148,172,0.18)` / 字 `rgb(69,74,86)`（灰） |
| 优先级 = 纯色文字（非药丸） | ✅ | 同上 | **无背景**（`rgba(0,0,0,0)`）、`border-radius 0px`；高 `rgb(226,75,74)` 红 / 中 `rgb(186,117,23)` 橙 / 低 `rgb(138,148,172)` 灰 |
| 空值显示弱色「—」 | ✅ | 同上 | 文本 `—`，字色 `rgb(138,148,172)` |
| **hover 变色** | ✅ | `smoke-22b-selected-vs-hover.png` | 未选中行 hover → `rgb(241,245,251)` = **#F1F5FB** |
| **选中态不被 hover 覆盖** | ✅ | 同上 | 选中行 `rgb(234,242,252)` = **#EAF2FC**；**对选中行再 hover 仍为 `rgb(234,242,252)`**（本轮修复项，已复测确认） |
| **行首勾选列 / 冻结列无白缝** | ✅ | `smoke-35b-frozen-scrolled-selected.png` | 选中态：`td0`(勾选列) 与 `td1`(名称冻结列) 背景同为 `rgb(234,242,252)`；横向滚动到最大（`scrollLeft=100`）时 `td0 [224,280]`、`td1 [280,480]` 背景仍同为 `rgb(234,242,252)`（`bg-inherit` 生效）→ **无白缝**（本轮修复项，已复测确认） |
| 行高三档 | ✅ | `smoke-21-rowheight-menu.png`、`smoke-22b-selected-vs-hover.png` | 紧凑 **36** / 常规 **44** / 宽松 **64**，表头恒 **36** |

---

## 5. 功能回归清单（逐项点过）

| # | 功能 | 结果 | 证据 |
|---|---|---|---|
| 1 | 排序（数量 降序） | ✅ | 渲染顺序 `21,12,8,5,3,—` |
| 2 | 筛选（状态 = 进行中） | ✅ | 工具条显示「匹配 2 条」，表格 2 行；`smoke-24-filter-applied.png` |
| 3 | 分组（按状态） | ✅ | 5 个分组头（待开始 1 / 进行中 2 / 待评审 1 / 已完成 1 / (空白) 1）+ 6 行，共 11 `tr`；API `groupByFieldId` 已写入；`smoke-25b-group-by-status-real.png` |
| 4 | 批量选择 | ✅ | 勾 3 行 → 批量条「删除 3 行」，计数 **3** 正确；`smoke-23-batch-select-bar.png` |
| 5 | 复制视图 | ✅ | 「QA副本视图」创建成功，API 查询该表 `views` 为 2；`smoke-27/28/29-*.png` |
| 6 | 新建记录 | ✅ | 行数 6 → 7；`smoke-30-new-record.png` |
| 7 | 行内编辑 | ✅ | 双击单元格出现 `INPUT`，写入「行内编辑测试」后回车，DOM 与 API 双向一致；`smoke-31-inline-edit.png` |
| 8 | 删除 + 撤销 | ✅ | 二次确认后 toast「已删除 1 行 撤销」，7 → 6；点「撤销」恢复 7；`smoke-33-delete-undo-toast.png`、`smoke-34-undo-restored.png` |
| 9 | 行高切换（三档） | ✅ | 36 / 44 / 64 实测生效（见第 4 节） |
| 10 | 冻结列横向滚动 | ✅ | 无白缝、无错位（见第 4 节） |

### 其他页面回归抽查（Playwright，含 console / pageerror / requestfailed 采集）

| 页面 | 控制台错误 | 页面异常 | 失败请求 | 横向溢出 | 截图 |
|---|---|---|---|---|---|
| `/workspace/settings/assets` | 0 | 0 | 0 | 否 | `smoke-50-workspace-settings.png` |
| 知识库文档页 | 0 | 0 | 0 | 否 | `smoke-51-kb-doc.png` |
| 库设置 | 0 | 0 | 0 | 否 | `smoke-52-base-settings.png` |
| 库回收站 | 0 | 0 | 0 | 否 | `smoke-53-base-trash.png` |
| `/workspace/settings` | 0 | 0 | 0 | 否 | `smoke-54-workspace-settings-general.png` |

（仅有 React Router 未来标志 warning，属无害告警，非错误。）

---

## 6. 缺陷清单

| 编号 | 级别 | 问题 | 复现步骤 | 期望 | 实际 | 涉及位置 |
|---|---|---|---|---|---|---|
| **D-1** | **P2** | 浮出子菜单「自动翻转到左侧」分支在真实 L1 布局下**不可达**，需求「窄窗口自动翻转」实际无效果 | 1) 造三级菜单（父组 › 子组 › 节点）；2) hover 子组触发浮出；3) 把窗口从 1440 逐步收窄到 1024 / 1000 / 900 / 800 / 768 逐档 hover 复测 | 靠右或窄窗口时翻转到左侧 | 全部为 `side=right`。原因：`fitsLeft` 需 `触发行.left − 208 ≥ 8` ⇒ `left ≥ 216`，而 L1 触发行 `left` 恒为 6；展开态又只在 vw≥1024 渲染，此时右侧需求 425 永远放得下。**注入位移后逻辑正确**（`smoke-12/13`），说明是可达性问题不是算法问题 | `apps/web/src/features/workspace/PrimaryNav.tsx:451-457`（`fitsRight` / `fitsLeft` / `toRight`） |
| **D-2** | **P2** | 1024 宽度下 L1 菜单可视区不足，底部菜单项需滚动才能触达 | 视口 1024×900 → 菜单滚动容器 `scrollHeight 434` / `clientHeight 392`，底部项（如自建三级项）被裁剪，需手动滚动 | 常用菜单项应在首屏可达 | 需滚动；滚动后浮出定位仍正确 | `PrimaryNav.tsx` 菜单滚动容器（无 `min-height` 兜底） |
| **D-3** | **P2** | 优先级「低」字色 `rgb(138,148,172)` 与空值「—」同色，弱信息辨识度不足 | 打开含优先级与空值的表，对比「低」与「—」 | 两者视觉层级应有区分 | 同色，视觉上易混淆 | `apps/web/src/features/cells/format.ts`（`priorityTextClass`）、`EMPTY_CELL_TEXT` |

**无 P0 / P1 阻塞缺陷。**

### 建议项（非缺陷）

| 编号 | 建议 |
|---|---|
| A-1 | D-1 若产品仍要求"放不下就翻转"，建议增加兜底：右侧放不下时改为贴右边缘 + 压缩宽度，或把翻转判定改为"剩余右侧空间 < 面板宽"而非仅依赖左侧空间。否则该分支等同死代码。 |
| A-2 | 冻结列「名称」保留 1px 右边框，与"表头无竖向分割线"是功能性例外，建议在设计稿中明确标注，避免后续被误判为回归。 |
| A-3 | 分组下拉为原生 `<select>`：人工点击正常，但自动化/合成事件必须派发原生 `change`（本人首次用点击 option 文案未生效）。建议后续若要加 E2E，统一封装 `select` 设值助手。 |

---

## 7. 未能验证项（如实列出）

| # | 项目 | 卡点 / 说明 |
|---|---|---|
| U-1 | **自然窗口宽度下触发"自动翻转到左侧"** | 不可达，非操作问题。L1 触发行恒贴左（`left=6`），`fitsLeft` 需 `left≥216`；且 vw<1024 时导航自动收窄为 56 图标栏、vw<768 时 `aside` 整体移除（移动端布局）。**已用注入位移（`aside.style.marginLeft`）构造出近右缘场景，验证翻转算法、间距 8、`gx-flyout-in-left 0.15s ease-out` 均正确**（`smoke-12/13`）。 |
| U-2 | **"左右都放不下"的兜底行为** | 无法构造：触发行 `left=6` ⇒ 右侧需求恒为 ≤467，而展开态最小渲染宽度 1024，永远放得下。未验证。 |
| U-3 | **截图的视觉复核** | 报告结论全部基于 DOM 实测数值与 API 交叉校验；**我无法查看 PNG 图像内容**，截图仅作为总监人工复核材料。 |
| U-4 | **触屏 / 真机移动端手势** | vw<768 时 `aside` 不渲染，属既有响应式策略（表格同步转卡片），本轮未做移动端手势验证。 |
| U-5 | **深色模式** | 本轮两个 commit 未涉及深色主题，未验证。 |
| U-6 | **截图 `smoke-25-group-by-status.png` 证据无效** | 该文件 MD5 与 `smoke-24-filter-applied.png` 完全相同（`8041894e…`），判定为重复抓取。已补拍 `smoke-25b-group-by-status-real.png`（MD5 `b380f19f…`，与前者不同），**请以后者为准**。另 `smoke-01` 与 `smoke-02` MD5 相同是**有意为之**——正是"点击分组标题后画面零变化"的证据。 |

---

## 8. 交付物

- 报告：`docs/acceptance/2026-09-19-menu-table-smoke.md`（本文件）
- 截图：`docs/acceptance/screenshots/smoke-*.png`（共 37 张，编号 `01-13` 菜单、`20-35` 表格、`50-54` 回归抽查）
- 现场清理：QA 测试库 / 三级菜单 / nav 分组已全部删除并复核；`apps/`、`packages/` 无改动；**未提交 commit**；浏览器守护进程已关闭。
