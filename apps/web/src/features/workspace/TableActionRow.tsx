// 阶段 1 壳层：L2 表级操作行（R-I-16）—— 当前没有任何表级入口，整行不渲染。
//
// R-I-16 的原始口径是「导入 / 导出是表级能力，放在 L2 表级操作行，不放顶栏、不放表格工具栏」。
// 第四批入口收敛后导入 / 导出提升为网格工具栏的常驻按钮（IconButton 规格、位于搜索框右侧，
// 见 GridToolbar），L2 不再重复挂一份——两个入口指向同一套向导，留着只会各自漂移。
//
// 最后一格「分享数据」是 R-I-20 判定的「数据级（单条记录）分享」，现网无记录级分享接口，
// 按 R-N-17 挂的是「规划中」占位：点了只弹一条 toast，没有任何实际能力。产品已批准下线
// ——假入口不如没有入口，故整格删除。本行自此再无可渲染内容。
//
// 组件本身保留：上下文判定与挂载点仍归 SecondaryNav，等真正的表级能力回来往这里挂；
// 在此之前一律返回 null，L2 不留空操作条（一条 40px 的空 div 只会白占纵向空间，
// 与文件头「库首页 / 知识库 / 工作区路由下不占位」是同一条口径）。
// 全部经 api/client.ts，无裸 fetch、无新增依赖。
export interface TableActionRowProps {
  tableId: string | null;
  /** 当前视图（导出按视图范围）；无视图时导出整表，与旧顶栏口径一致。 */
  viewId?: string | null;
  /** 当前视图名，仅用于导出弹窗文案。 */
  viewName?: string;
  /** 取权限用；不给时退回「按表结构可写」的保守判定。 */
  baseId?: string | null;
  /** 显式隐藏（调用方已知当前不是表上下文）。 */
  hidden?: boolean;
}

/**
 * 只取 tableId / hidden：viewId / viewName / baseId 保留在 props 契约里（壳层照旧透传），
 * 但导入导出迁出、分享占位下线后本行不再用它们发请求，故不解构出来。
 */
export function TableActionRow({ tableId, hidden }: TableActionRowProps) {
  // 无表上下文（库首页 / 知识库 / 工作区）或调用方显式隐藏：不占位。
  if (hidden || !tableId) return null;
  // 有表上下文：表级入口已清空（分享数据占位下线），同样不渲染，不留空操作条。
  return null;
}
