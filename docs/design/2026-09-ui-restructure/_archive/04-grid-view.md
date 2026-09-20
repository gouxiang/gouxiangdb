# 04 · 数据表界面设计（Grid）

> 配套设计稿：Ardot `S1 数据表主界面`（1440×900），展示 15 行样例数据 + 聚合栏 + 状态栏。

## 1. 区域层级（自上而下）

| # | 区域 | 高度 | 底色 | 分隔 |
|---|---|---|---|---|
| 0 | TopBar / ContextBar | 48 / 40 | `gx-surface` | `gx-hairline` 下边框（见 `03` §3.3–3.4） |
| ① | 表格工具栏 | **40**（原 48） | `gx-surface` | 下边框 |
| ② | 降级提示条 | 条件 | — | 下边框，`ResultNotice` warning |
| ③ | 表头 | **32** | **`gx-surface-alt`** | 1px 网格线 |
| ④ | 数据行 | 32/44/64 | 白 / 斑马 `gx-surface-alt` | 1px 网格线 |
| ⑤ | 分组头 | 36 | `gx-canvas` | 下边框 |
| ⑥ | 聚合栏 | **32** | `gx-surface-alt` | 1px 网格线 |
| ⑦ | 状态栏 | **28** | `gx-surface-alt` | 上边框 |

**核心修正**：现状 `gx-table-header` 与页面底同值，表头与页底没有层级差。新方案用 `gx-surface-alt`（#FAFAFC）与白色数据面拉开层次，同时比 `gx-canvas` 更亮，明确「这是表格的 chrome，不是页面」。

## 2. 表格工具栏（GridToolbar）

h40，padding 8，元素间距 4，竖分隔 `gx-hairline` 18px：

```
[+ 新建记录] │ [筛选 ②] [分组] [排序 ①] [行高] [字段] [行颜色] ····· [搜索此视图…] [⋯ 更多]
```

- **新建记录**：主按钮 h28（`gx-accent` 底、白字 `gx-12`/500、radius 6、padding 10、plus 图标 14），本屏唯一主操作，`disabled = !canEditData`。
- **工具按钮** h28，图标 14 + 文字 `gx-12`：
  - 常态：文字 `gx-text-2`，图标 `gx-text-3`，hover 底 `gx-hover`；
  - **激活**（筛选/分组/排序/行颜色已配置）：底 `gx-selected`，文字/图标 `gx-accent`，字重 500；
  - 计数徽标：16×16 圆形 `gx-accent` 底白字 `gx-11`。
- **视图内搜索**：200×28，`gx-canvas` 底 + `gx-border`，防抖 300ms。
- **更多**：Popover 180 宽，Menu 项：CSV 导入 / CSV 导出 / ─ / 复制视图 / 清空表（danger）。
  - ⚠️ 修正现状缺陷：现「更多」按钮图标是 download 与文案不匹配 → 统一为 `⋯`。

**批量选中态**（selectionCount > 0）整条替换：底 `gx-selected`，内容「N 行已选」`gx-13`/500/`gx-accent` + 竖分隔 + 「批量修改字段…」（secondary）+「删除」（danger）+「取消选择」（ghost）。

## 3. 表头

- 行首固定列 44px（`sticky left-0 z-30`）：全选勾选框 14×14。
- 字段列：类型图标 13（`FIELD_TYPE_COLOR`）+ 字段名 `gx-12`/500/`gx-text-2` + 排序标记（`↑` 12 `gx-accent`，多字段排序显示序号）+ hover 出 `chevronDown` 菜单。
- 主字段列 `sticky`（left: 44），z 20。
- 列宽拖拽：右缘 1.5px 热区，hover `gx-selected`，拖拽中 `gx-accent`；最小 60px；默认宽度沿用现有 `defaultColWidth()`（checkbox 80 / select 160 / date 140 / 数值 120 / 其他 200）。
- 字段菜单（Popover 200）：升序 / 降序 / 取消排序 / ─ / 隐藏此列 / [canManageSchema] 重命名·编辑字段 / 删除字段（danger）。

## 4. 数据行

- 行高 44（默认），三档 32/44/64；斑马纹用 `gx-surface-alt`（奇偶行）。
- **选中行**：整行底 `gx-selected` + 左缘 3px `gx-accent` 竖条；行内任意空白点击打开 `RecordDrawer`。
- **行颜色**：保留左缘 3px 色条（`inset box-shadow`），与选中态叠加时**选中底色优先、色条保留**。
- 行首列内容：勾选框 14 + 展开按钮 13（hover 出现）。补上现状缺失的**行号**（`gx-11`/`gx-text-hint`，可选开关）。
- 单元格：padding 10，垂直居中；主字段 `sticky z-10`；active 单元格 `ring-2 inset gx-accent`；编辑态为绝对定位层（z 30）内挂 `CellEditor`。
- 展示类型样例（见设计稿）：
  - 单选 → 选项胶囊 h20 radius 4 padding 6，`gx-11`/500；
  - 用户 → 文本 `gx-13`（复杂场景可加头像点）；
  - 关联 → `gx-accent` 文字（可点击）；
  - 数字 → 右对齐 `tabular-nums`。
- 虚拟滚动：>300 行启用（现有 `useVirtual`，缓冲 20/40），保留。
- 只读类型（formula/rollup/count/lookup/autoNumber/时间戳/checkbox）不进双击编辑。

## 5. 分组头

h36，底 `gx-canvas`，内容：折叠箭头（rotate-90）+ 组色点 10px 圆 + 组名 600 + 计数 `gx-text-hint` + 组内聚合值；每组一个 `<tbody>`，degraded 时显示「受限」。

## 6. 聚合栏

h32，底 `gx-surface-alt`，行首 44px 显示「聚合」（`gx-11`/`gx-text-hint`）。

- 单元格右对齐：`函数名`（`gx-11`/`gx-text-hint`）+ `值`（`gx-12`/600/`gx-text-1`），`tabular-nums`；无函数时 hover 显示 `+`。
- 点击 → Popover 180，按字段类型列出可用函数（数值 9 / 日期 3 / 其他 5），底部「清除聚合」danger。
- degraded：显示「受限」替代数值。

## 7. 状态栏

h28，底 `gx-surface-alt`，padding 12，`gx-11`/`gx-text-hint`：

```
共 128 条   筛选后 15 条   已选 1 行(accent) ························ 表格视图
```

## 8. 空态 / 加载 / 错误

| 状态 | 表现 |
|---|---|
| 加载中 | 居中 Spinner 24 |
| 无记录 | `EmptyState`：图标圈 48 + 「暂无记录」`gx-14`/600 + 描述 + 主操作「新建记录」 |
| 降级 | `ResultNotice` warning 条 + 状态栏「受限」 |
| 加载更多 | 表格底部居中 secondary 按钮 |

## 9. 其他视图容器（本轮只定基调，不展开）

| 视图 | 基调 |
|---|---|
| 看板 | 画布底 `gx-canvas`，列 280px 白卡 radius 8，卡片 hover `gx-shadow-sm` |
| 画廊 | 画布底，卡片 min 260px，radius 8，hover `gx-shadow-md` |
| 日历 | 工具栏 `gx-surface`，今天 `gx-selected` 圆形，事件 chip `gx-selected`/`gx-accent` |
| 表单 / 详情 | 居中卡片 max 560/5xl，radius 8 |
| 记录抽屉 | 右侧 480px，`gx-surface`，`gx-shadow-xl` |

> 修正点：日历现状把右边框涂透明导致格线不齐，重构时统一用 `gx-hairline`。

---

- [修订 2026-09-18] 初版。
