# GouXiangDB v2 深度对比测试矩阵（v1 → v2 回归基线）

**目的**：作为 v2 重构后"功能 1:1 对等"的判定标准。每个测试点必须有 v1 现状快照 + v2 重写后回归用例 + 通过/失败标记。

**对比维度**：
- ✅ = 功能行为 + 视觉风格 + 性能均与 v1 一致
- 🟡 = 行为一致但视觉/性能略有不同（可接受）
- ❌ = 行为不一致（阻塞回归，必须修复）

---

## 1. 字段类型系统（Field Types）

v1 共支持以下字段类型，v2 必须 1:1 覆盖：

| # | 字段类型 | v1 行为 | v2 测试用例 | 状态 |
|---|---|---|---|---|
| 1 | SingleLineText | 单行文本，trim，长度限制可选 | `assert insert + read + filter` | ⏳ |
| 2 | LongText | 多行文本，支持换行 | `assert multi-line roundtrip` | ⏳ |
| 3 | RichText | 富文本（粗体/斜体/列表/链接） | `assert bold/italic/list/link render` | ⏳ |
| 4 | Number | 数字，支持整数/小数/精度/单位/负数 | `assert numeric ops + precision` | ⏳ |
| 5 | Currency | 货币，¥/$/€ 等 + 千分位 + 小数位 | `assert currency format` | ⏳ |
| 6 | Percent | 百分比，0.5 → 50% | `assert percent format` | ⏳ |
| 7 | Duration | 时长，秒/分/时/天 | `assert duration format` | ⏳ |
| 8 | Date | 日期，时间戳可选 | `assert date + ISO + timezone` | ⏳ |
| 9 | DateTime | 日期时间 | `assert datetime + ISO + timezone` | ⏳ |
| 10 | Checkbox | 布尔，true/false | `assert bool roundtrip` | ⏳ |
| 11 | SingleSelect | 单选，颜色 + 排序 | `assert option + color + order` | ⏳ |
| 12 | MultiSelect | 多选，颜色 + 排序 + 数组 | `assert multi option + order` | ⏳ |
| 13 | Email | 邮箱，校验格式 | `assert email validate` | ⏳ |
| 14 | URL | URL，可点击 | `assert url render + click` | ⏳ |
| 15 | Phone | 电话号码 | `assert phone format` | ⏳ |
| 16 | Rating | 星级 1-5 | `assert rating render` | ⏳ |
| 17 | AutoNumber | 自增 ID | `assert auto increment` | ⏳ |
| 18 | JSON | JSON 对象，任意结构 | `assert json roundtrip` | ⏳ |
| 19 | Attachment | 附件（图片/文件），多文件 | `assert upload + download + preview` | ⏳ |
| 20 | Links | 关联字段，结构化 [GXLinkRef] | `assert links insert + read + navigate` | ⏳ |
| 21 | Lookup | 关联字段的子字段值 | `assert lookup value + multi-link` | ⏳ |
| 22 | Rollup | SUM/AVG/MIN/MAX/COUNT + 子字段 | `assert rollup aggregate` | ⏳ |
| 23 | Count | 关联记录数 | `assert count = N` | ⏳ |
| 24 | Formula | 公式 `{字段}` / `{关联.子字段}` / 函数 | `assert formula eval` | ⏳ |
| 25 | CreatedTime | 创建时间，自动 | `assert created_at auto-set` | ⏳ |
| 26 | LastModifiedTime | 最后修改时间，自动 | `assert updated_at auto-update` | ⏳ |
| 27 | CreatedBy | 创建者，需 Member 系统 | `assert created_by member_id` | ⏳ |
| 28 | LastModifiedBy | 最后修改者 | `assert updated_by member_id` | ⏳ |

---

## 2. 关系系统（Relationships）

| # | 功能点 | v1 行为 | v2 测试用例 | 状态 |
|---|---|---|---|---|
| 1 | 多对多 mm | 双向都多 | `assert mm records count + bidirectional` | ⏳ |
| 2 | 一对多 hm | 主表单值，从表多值 | `assert hm primary + many` | ⏳ |
| 3 | 多对一 bt | 主表多值，从表单值 | `assert bt many + primary` | ⏳ |
| 4 | 反向关联自动建 | 创建 A→B 时自动建 B→A | `assert reverseFieldId sync` | ⏳ |
| 5 | 反向映射语义 | bt → hm (反向不是 bt) | `assert reverse type mapping` | ⏳ |
| 6 | 级联对称软删 | 删 A 字段 → 删 B 反向字段 | `assert cascade delete pair` | ⏳ |
| 7 | 显示字段配置 | linkDisplayFieldId 决定胶囊标题 | `assert chip title = display field value` | ⏳ |
| 8 | 跨表跳转 | 点击胶囊跳到目标表对应行 | `assert navigate to linked record` | ⏳ |
| 9 | 浅层 hydration | 防双向递归栈溢出 | `assert no recursion stack overflow` | ⏳ |
| 10 | 公式点引用 | `{关联字段.子字段}` | `assert dot reference expand` | ⏳ |

---

## 3. 视图系统（Views）

| # | 视图类型 | v1 行为 | v2 测试用例 | 状态 |
|---|---|---|---|---|
| 1 | Grid | 表格视图，行 + 列 | `assert grid render + sort + filter` | ⏳ |
| 2 | Gallery | 画廊，卡片 + 封面 | `assert gallery card + cover` | ⏳ |
| 3 | Form | 表单，字段垂直排列 | `assert form layout` | ⏳ |
| 4 | Detail | 详情，字段分组 | `assert detail grouping` | ⏳ |
| 5 | Drawer | 右侧抽屉，编辑/查看 | `assert drawer slide + edit` | ⏳ |
| 6 | 视图标签 | 同一表多个视图切换 | `assert view tabs switch` | ⏳ |
| 7 | 视图锁 | collaborative / locked / personal | `assert view lock permission` | ⏳ |

---

## 4. 权限系统（RBAC）

| # | 功能点 | v1 行为 | v2 测试用例 | 状态 |
|---|---|---|---|---|
| 1 | 角色 owner | 全权 | `assert owner can manage base` | ⏳ |
| 2 | 角色 creator | 管理 schema | `assert creator can edit schema` | ⏳ |
| 3 | 角色 editor | 编辑数据 | `assert editor can edit record` | ⏳ |
| 4 | 角色 commenter | 评论 | `assert commenter can comment` | ⏳ |
| 5 | 角色 viewer | 只读 | `assert viewer read-only` | ⏳ |
| 6 | 视图锁 模式 | collaborative 默认 / locked / personal | `assert lock mode enforced` | ⏳ |
| 7 | 服务端校验 | 后端独立校验权限（前端隐藏是辅助） | `assert server reject unauthorized` | ⏳ |

---

## 5. 数据导入导出

| # | 功能点 | v1 行为 | v2 测试用例 | 状态 |
|---|---|---|---|---|
| 1 | CSV 导入 | 列映射 + 数据校验 | `assert csv import + mapping` | ⏳ |
| 2 | CSV 导出 | 全部记录 | `assert csv export full` | ⏳ |
| 3 | 权限 | import 需要 canEditData | `assert import blocked for viewer` | ⏳ |

---

## 6. UI 视觉风格（1:1 复刻）

| # | 设计项 | v1 设计 | v2 测试 | 状态 |
|---|---|---|---|---|
| 1 | 两栏骨架 | 左 Sidebar + 主区 DetailRouter | `assert layout = sidebar + main` | ⏳ |
| 2 | 侧栏选中态 | 左侧 3pt 蓝色竖条 + 浅蓝底 | `assert selected style` | ⏳ |
| 3 | 视图标签选中态 | 蓝底胶囊 + 边框 | `assert view tab selected` | ⏳ |
| 4 | 字段类型彩色 | 文本紫/数字蓝/日期紫/选择青/关联绿/公式粉 | `assert field icon color per type` | ⏳ |
| 5 | 行斑马纹 | 偶数行浅灰底 | `assert zebra row` | ⏳ |
| 6 | 行 hover | 浅灰底加深 | `assert row hover state` | ⏳ |
| 7 | 状态栏底灰 | 底部状态条浅灰 | `assert status bar style` | ⏳ |
| 8 | 工具栏分组 | Divider 分隔记录操作/视图配置/搜索 | `assert toolbar group divider` | ⏳ |
| 9 | 主按钮按压反馈 | 按下时阴影反馈 | `assert press shadow` | ⏳ |
| 10 | 表头排序徽标 | 排序时浅蓝底圆角 | `assert sort badge` | ⏳ |

---

## 7. Core 数据层（25 条算法断言）

v1 在 `Tests/reverse_link_test.swift` 跑过的 25 条断言，v2 必须在 `apps/api/src/domain/__tests__/` 用 TS 重写并保持全绿：

| # | 断言类型 | v1 现状 | v2 测试 | 状态 |
|---|---|---|---|---|
| 1-25 | 关联字段全链路 + 反向映射 + 显示字段 + Lookup + 公式点引用 | 全绿 | TS 重写 | ⏳ |

---

## 8. 性能基线

| # | 操作 | v1 表现 | v2 必须不慢于 |
|---|---|---|---|
| 1 | 1000 行 Grid 渲染 | <500ms | ≤500ms |
| 2 | 100 字段类型切换 | <100ms | ≤100ms |
| 3 | 关联字段跳转 | <50ms | ≤50ms |
| 4 | 公式计算 100 行 | <200ms | ≤200ms |

---

## 9. 验证流程

每次 v2 提交对比时：

1. **数据快照**：从 v1 导出一份测试数据集（涵盖 14 种字段类型 + 关联 + 视图）
2. **导入 v2**：用迁移脚本导入相同数据
3. **逐项断言**：跑上面所有 ⏳ 测试用例
4. **视觉对比**：用 Playwright 在 v1 + v2 同一窗口尺寸下截图，逐像素 diff（≤2% 视为通过）
5. **性能基线**：跑性能测试，所有项不超过 v1 1.2 倍
6. **回归报告**：产出 `compare-report-{date}.md`，列出所有 ✅/🟡/❌

---

## 10. 验收门槛（用户拍板）

- ✅ 所有功能点行为一致
- ✅ 视觉对比 ≤2% 像素差异
- ✅ 性能不超过 v1 1.2 倍
- ✅ Core 层 25 条断言全绿
- ✅ 零 P0 缺陷
- ✅ 零新增 bug（对比基线后新增的 bug 必须修复或列入已知问题）

**未达标即不交付，重新迭代。**