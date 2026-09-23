// apps/web/src/components/confirm-table.ts
// 数据表级危险确认预设：清空数据 / 删除数据表。
//
// 为什么从 feedback.tsx 挪出来单开一个文件：feedback.tsx 是 confirmAction 的**通用机制层**
// （分级 → gate → 弹窗渲染 → 宿主），改动前已 298 行，再往上加业务预设会顶破「单文件 ≤300 行」公约。
// 这两个预设又是同一层的一对姊妹动作（都是「对整张表下手」），放一起比拆在两处更好维护。
//
// 它们没造第二套确认实现：内部仍然调用 feedback 的 confirmAction，弹窗也仍由 ConfirmHost 渲染，
// 差别只在「填什么文案、走第几级」。
//
// 口径：两者都是 R-D-23 L3 —— 必须原样输入表名才放行。此前「删除表」走 L2（点两下就删），
// 比同一份表操作菜单里破坏性更小的「清空数据」还松，这里对齐到同一强度。
//
// 每个预设都拆成「拼参数」+「发起确认」两步：参数函数（xxxConfirm）是纯函数，测试可以直接断言
// 分级与名称约束，不必渲染弹窗（node 环境 SSR 不支持 portal）。

import { confirmAction, type ConfirmOptions, type DangerLevel } from "./feedback";

/** 拼好的确认参数：level 显式必填，测试可直接拿去跑 confirmGateFor 而不必渲染弹窗。 */
type TableConfirmSpec = ConfirmOptions & { level: DangerLevel };

/**
 * 清空表数据的确认参数（R-D-23 L3）。
 *
 * 服务端 `POST /tables/:id/clear` 是软删全部记录（进回收站，30 天内可恢复），但只回 `{ ok: true }`，
 * **不返回被清掉的 id 列表** → 做不出「一键撤销」的 toast，故用「输入表名」的强度补偿；
 * 文案如实说明要去回收站逐条恢复，不谎称可撤销（R-D-22 的精神是给用户真退路，不是假按钮）。
 */
export function clearTableConfirm(tableName: string, scopedToView = false): TableConfirmSpec {
  return {
    title: `清空「${tableName}」的数据`,
    confirmText: "清空数据",
    cancelText: "取消",
    level: 3,
    confirmName: tableName,
    description: `${scopedToView ? "当前视图内" : "整张表"}的记录会被清空并移入回收站，30 天内可在回收站恢复。清空没有一键撤销，需要在回收站逐条恢复。`,
  };
}

export function confirmClearTable(opts: { tableName: string; scopedToView?: boolean }): Promise<boolean> {
  return confirmAction(clearTableConfirm(opts.tableName, opts.scopedToView ?? false));
}

/**
 * 删除数据表的确认参数（R-D-23 L3，与「清空数据」同一口径）。
 *
 * 修复背景：删表此前走 L2（只有「取消 / 删除数据表」两个按钮），而同一份表操作菜单里破坏性更小的
 * 「清空数据」却要求输入表名 —— 强度倒挂，误触删表比误触清空更容易得手。两者后端都只是软删进回收站、
 * 都有恢复链路，所以对齐到同一个 L3 强度；恢复侧的 toastDeleted 撤销由调用点保留。
 */
export function deleteTableConfirm(tableName: string): TableConfirmSpec {
  return {
    title: `删除数据表「${tableName}」`,
    confirmText: "删除数据表",
    cancelText: "取消",
    level: 3,
    confirmName: tableName,
    description: "数据表会移入回收站，30 天内可恢复。删除前请先确认这张表已经不需要了。",
  };
}

export function confirmDeleteTable(opts: { tableName: string }): Promise<boolean> {
  return confirmAction(deleteTableConfirm(opts.tableName));
}
