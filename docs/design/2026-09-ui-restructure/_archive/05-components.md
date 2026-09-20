# 05 · 组件状态规范

> 适用范围：`components/ui.tsx` 及各 feature 内自绘控件。落地时统一收敛到 ui.tsx，消除散落的重复实现。

## 1. 按钮 Button

尺寸三档：`sm` h28 / `md` h32 / `lg` h40；radius 统一 6（`gx-md`）；图标 14/16。

| Variant | Default | Hover | Active（按下） | Disabled | Loading |
|---|---|---|---|---|---|
| **primary** | 底 `gx-accent`、白字 500 | 底 `gx-accent-hover` | 底 `gx-accent-hover` + 内阴影 1px | `opacity .5` + cursor not-allowed | 图标位换成 Spinner 14，强制 disabled |
| **secondary**（默认） | 底 `gx-surface`、字 `gx-text-1`、边 `gx-border` | 底 `gx-hover` | 边 `gx-border-strong` | 同上 | 同上 |
| **ghost** | 透明底、字 `gx-text-2` | 底 `gx-hover`、字 `gx-text-1` | 底 `gx-selected` | 同上 | 同上 |
| **danger** | 底 `gx-danger`、白字 | `brightness .95` | 同上 | 同上 | 同上 |

> **补齐现状缺陷**：为所有 variant 增加 `focus-visible: 2px gx-selected 外环 + 1px gx-accent 描边`（键盘可达性）。

## 2. 图标按钮 IconButton

32×32（工具栏内 28×28），radius 6，图标 16（紧凑 14）。

| 状态 | 表现 |
|---|---|
| Default | 图标 `gx-text-3`，透明底 |
| Hover | 底 `gx-hover`，图标 `gx-text-1` |
| Active/选中 | 底 `gx-selected`，图标 `gx-accent` |
| Disabled | 图标 `gx-text-disabled`，无 hover（**现状缺失，需补**） |
| Danger | hover 时图标 `gx-danger` |

## 3. 输入框 Input / Textarea

h32（compact h28），radius 6，padding 8/10，字 `gx-13`。

| 状态 | 表现 |
|---|---|
| Default | 底 `gx-surface`、边 `gx-border` |
| Hover | 边 `gx-border-strong` |
| Focus | 边 `gx-accent` + 外环 `2px gx-selected`（**现状无外环，补**） |
| Filled | 同 default，文字 `gx-text-1` |
| Placeholder | `gx-text-hint` |
| Disabled | 底 `gx-canvas`、文字 `gx-text-disabled`、边 `gx-hairline`（**现状缺失，补**） |
| Error | 边 `gx-danger` + 下方 `gx-11` 错误文案 |

内嵌图标（搜索框）：图标左置 14，`gx-text-hint`；带 `⌘K` 徽标时徽标白底 radius 4。

## 4. 下拉选择 Select

触发器同 Input，右侧 `chevronDown` 14；焦点态同 Input Focus。
选项列表（Popover）：白底 radius 8 `gx-shadow-lg`；选项 h32 padding 8，hover 底 `gx-hover`，选中 `gx-selected` + `gx-accent` 文字 + `check` 图标，disabled `opacity .4`。

## 5. 菜单 Menu / MenuItem

容器：Popover 白底 radius 8，`gx-shadow-lg`，padding 4，宽 180–240。

| 状态 | 表现 |
|---|---|
| Default | `gx-13`/400/`gx-text-1`，h32，padding 8，图标 16 在左 |
| Hover | 底 `gx-hover` |
| Active（当前项） | 底 `gx-selected` + `gx-accent` 文字 |
| Disabled | `opacity .4` + not-allowed |
| Danger | 文字 `gx-danger`，hover 底 `gx-danger-bg` |
| Divider | 1px `gx-hairline`，上下留 4 |
| Shortcut | 右侧 `gx-11`/`gx-text-hint` |

右键菜单（ContextMenu）沿用同一套状态，宽度 220，portal + 越界回弹。

## 6. 选项卡 Tabs

| 场景 | 选中 | 未选中 | 形态 |
|---|---|---|---|
| 视图标签（ContextBar） | 底 `gx-selected` + `gx-accent` 500 | 字 `gx-text-2`，hover 底 `gx-hover` | h28 radius 6 padding 8，图标+文字 |
| 视角切换（L2） | 底 `gx-selected` + `gx-accent` 500，胶囊 | 字 `gx-text-3`，hover 底 `gx-hover` | h24 radius pill padding 8 |
| 分段控件 SegmentedControl | 白底块 `gx-shadow-sm` + 字 `gx-text-1` 500 | 字 `gx-text-3` | 容器 `gx-canvas` 底 radius 6 padding 2 |

## 7. 表格单元格 Cell

| 状态 | 表现 |
|---|---|
| Default | 白底 / 斑马 `gx-surface-alt`，1px `gx-hairline` 网格线 |
| Row hover | 行底 `gx-hover`（覆盖斑马） |
| Row selected | 行底 `gx-selected` + 左缘 3px 竖条 |
| Cell active | `ring-2 inset gx-accent` |
| Cell editing | 单元格内绝对定位白底层 + `CellEditor`（z 30） |
| Readonly | 无编辑层，hover 显示 tooltip |

## 8. 勾选框 Checkbox / 开关 Switch

| 状态 | Checkbox（16） | Switch（36×20） |
|---|---|---|
| Unchecked | 白底 + `gx-border-strong` 边 radius 4 | 轨道 `gx-border-strong` |
| Checked | `gx-accent` 底 + 白 `check` | 轨道 `gx-accent`，滑块右移 |
| Hover | 边 `gx-accent` | 轨道加深 10% |
| Disabled | `opacity .4` | `opacity .4` |

## 9. 徽标 Badge / 计数徽标

- Badge：`gx-11`/500，padding 6/2，radius pill；variant `soft`（18% 底 + 加深文字）/ `solid`（85% 底 + 白字）。
- 计数徽标（工具栏）：16×16 圆形 `gx-accent` 底白字。
- 角标（Tab「未收纳」计数）：`gx-11` `gx-text-hint`，`tabular-nums`。

## 10. 浮层 Modal / Popover / Drawer / Toast

| 组件 | 规格 |
|---|---|
| Modal | 遮罩 `rgba(0,0,0,.25)`；面板白底 radius 12 `gx-shadow-xl`，max-h 85vh；头部 h48 底 `gx-hairline` 下边框；footer 右对齐，主按钮居右 |
| Popover | 白底 radius 8 `gx-shadow-lg` `gx-border`；延迟一帧挂载；fixed 模式防右/下溢出 |
| Drawer | 右侧 480px 白底 `gx-shadow-xl`；头部 h48；关闭钮右上 |
| Toast | 底部居中，radius 6，padding 8/12；success `gx-success` / error `gx-danger` / info `gx-text-1`，均白字，3200ms |

> **补齐现状缺陷**：Modal 无开合动画 → 统一加 180ms `cubic-bezier(.22,.61,.36,1)` 淡入 + scale .96→1（复用现有 `animate-pcdialog-in` keyframes，提升为全局 token）。

## 11. 现状缺失需新建的组件

| 组件 | 说明 |
|---|---|
| **Drawer**（通用） | 现 4 处各自实现（Record/PersonalCenter/VersionHistory/Member/Effective），统一收敛 |
| **Tabs**（通用） | 现 ViewTabs / SecondaryNav 三视角 / KbTree 文档画布三处手写 |
| **Tooltip** | 现全用原生 `title`；新增：深色 `gx-text-1` 底白字，radius 4，`gx-11`，延迟 300ms |
| **Breadcrumb** | 现 TopBar 手写 + authz NodeBreadcrumb 独立实现 |

---

- [修订 2026-09-18] 初版。
