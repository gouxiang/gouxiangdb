# GouXiangDB v2 前端实现公约（所有前端 Agent 必读）

## 0. 项目背景

v2 是对 v1（macOS 原生 SwiftUI 应用）的**前后端分离重写**。目标是：功能操作与交互体验 1:1 复刻
NocoDB，视觉沿用 v1 已确定的「简洁明了」风格（实心表面层级、不用毛玻璃）。

**北极星**：功能与 v1 对等，视觉与 v1 同源。任何实现都要问一句「v1 里是怎么做的」。

## 1. 技术栈（已固定，不要引入新依赖）

- React 18 + TypeScript + Vite + Tailwind CSS 3
- 状态/数据：TanStack Query v5（`@tanstack/react-query`）
- 鉴权：Zustand（`src/store/auth.ts`，`useAuthStore`）
- 路由：react-router-dom v6
- 类名工具：`clsx`
- **禁止**引入 antd / MUI / 图标库 / 日期库等新依赖。图标用 `src/components/icons.tsx`。

## 2. 必须复用的既有模块（不要重写，不要修改）

```
src/api/client.ts        — 所有 API 方法与共享类型（唯一真源）
src/api/hooks.ts         — useBases / useTables / useFields / useRecords / useViews /
                           useMembers / useTrash / useComments / useSearch +
                           useGXMutations()（所有写操作）
src/components/ui.tsx    — Button / IconButton / Input / Textarea / Select / Checkbox /
                           Switch / SegmentedControl / Badge / Spinner / EmptyState /
                           FieldRow / Modal / Popover / Menu / MenuItem / MenuDivider /
                           toast / ToastHost / ColorPicker / FieldIcon / fieldIconName / fieldColor
src/components/icons.tsx — Icon 组件 + IconName 联合类型 + VIEW_ICON
src/store/auth.ts        — useAuthStore（token / user / setAuth / logout）
```

`ui.tsx` 和 `icons.tsx` 是**共享基础**，如确有缺失请先补充**新组件**而不是改坏已有签名。

## 3. 设计 token（Tailwind 类名，全部来自 @gx/design-tokens）

颜色：`bg-gx-surface` `bg-gx-bg` `bg-gx-card-bg` `bg-gx-zebra` `bg-gx-table-header`
　　`text-gx-text-primary` `text-gx-text-secondary` `text-gx-text-tertiary` `text-gx-text-hint`
　　`border-gx-border` `border-gx-separator` `border-gx-border-strong`
　　`text-gx-accent` `bg-gx-accent-bg` `bg-gx-danger` `bg-gx-success` `bg-gx-warning`
间距：`p-gx-xs` `p-gx-sm` `p-gx-md` `p-gx-lg` `gap-gx-sm` …（xxs/xs/sm/md/lg/xl/xxl/3xl…）
圆角：`rounded-gx-sm` `rounded-gx-md` `rounded-gx-lg` `rounded-gx-xl`
字号：`text-gx-11` `text-gx-12` `text-gx-13` `text-gx-14` `text-gx-16` `text-gx-18`
字重：`font-regular` `font-medium` `font-semibold` `font-bold`

**不要硬编码任何颜色**（`#xxxxxx` 一律不要用）。字段类型图标颜色用 `fieldColor(type)`。

## 4. 视觉规范（对齐 v1）

- 两栏骨架：**左侧栏灰底 `bg-gx-bg`**，主区内容面 `bg-gx-surface`；卡片类视图画布用 `bg-gx-card-bg`
- 表面层级靠**背景色深浅**区分，不用毛玻璃、不用大阴影（阴影只用于浮层/抽屉）
- 选中态：左侧 3px 蓝色竖条 + `bg-gx-accent-bg` 底
- Hover：表格行用 `bg-gx-row-hover`；按钮用 `hover:bg-gx-bg`
- 表格：表头 `bg-gx-table-header`，斑马纹奇数行 `bg-gx-zebra`
- 中文字号默认 13px（`text-gx-13`），标题 14/16，辅助说明 11/12
- 交互反馈：写操作成功用 `toast("已保存", "success")`，失败 `toast(err.message, "error")`

## 5. API 调用方式（严格遵守）

```tsx
import { useRecords, useFields, useGXMutations } from "../../api/hooks";

const { data, isLoading } = useRecords({ tableId, viewId });   // data.records / .fields / .groups / .aggregations
const m = useGXMutations();

await m.updateRecord.mutateAsync({ recordId, fields: { [fieldId]: value }, tableId, viewId });
```

**不要**直接用 `fetch`，**不要**绕过 hooks.ts 自己写请求。

`data.records[i].fields` 是**已 hydration 的平铺值**（物理字段 + 计算字段，key = fieldId）：
- links / lookup → `LinkRefDTO[]` 或值数组
- rollup / count / formula / autoNumber → 数值
- createdBy / lastModifiedBy → 用户名字符串
- 其余 → 原始类型

## 6. 权限

`useBase(baseId)` 返回的 `base.permissions` 是 `PermissionSet`：
`canManageBase` / `canManageSchema` / `canEditData` / `canComment` / `canView`。

- 数据编辑按钮/单元格：`canEditData` 为 false 时要禁用（不要隐藏，禁用 + tooltip 说明）
- 字段增删、视图配置：`canManageSchema`
- 成员/分享/删除 Base：`canManageBase`
- 评论：`canComment`

## 7. 代码风格

- 函数式组件 + hooks，默认导出组件
- 每个文件顶部写一行中文注释说明职责
- 复杂逻辑抽成小函数并写中文注释解释「为什么」
- 不要写 `any`（实在需要写 `unknown` 并收窄）
- 组件 props 用 `interface` 显式声明

## 8. 交付要求

- 只创建/修改**分配给你**的文件路径
- 完成后运行 `pnpm --filter @gx/web typecheck` 确认**你的文件**零错误
  （其他 Agent 的文件可能还没建好，报「找不到模块」可以先不管，但你自己文件内的类型错误必须清零）
- 不要修改：`src/api/*`、`src/components/*`、`src/App.tsx`、`src/main.tsx`、`src/index.css`、
  `tailwind.config.ts`、任何 `apps/api/**`
