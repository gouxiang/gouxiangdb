// 阶段 1 壳层：L2 表级操作行（R-I-16）—— 分享数据。
//
// R-I-16 的原始口径是「导入 / 导出是表级能力，放在 L2 表级操作行，不放顶栏、不放表格工具栏」。
// 第四批入口收敛后这条口径**收口为单一入口**：导入 / 导出提升为网格工具栏的常驻按钮
// （IconButton 规格、位于搜索框右侧，见 GridToolbar），L2 不再重复挂一份——两个入口指向
// 同一套向导，留着只会各自漂移。故本行现在只剩「分享数据」。
//
//   分享 → R-I-20 判定为「数据级（单条记录）分享」，现网无记录级分享接口，按 R-N-17
//          挂「规划中」占位，点击 toast 明说，不放死入口也不假装可用。
// 全部经 api/client.ts，无裸 fetch、无新增依赖。
//
// 两层结构：外层只做「有没有表」的判断，内层才拿 hooks。这样库首页 / 知识库 / 工作区路由下
// 不挂载任何数据 hook（SSR 断言与无 Provider 场景都不受影响），L2 也不会留下空操作条。
import { Icon } from "../../components/icons";
import { toast } from "../../components/ui";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";

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
 * 但导入导出迁出后本行不再用它们发请求，故不解构出来。
 */
export function TableActionRow({ tableId, hidden }: TableActionRowProps) {
  if (hidden || !tableId) return null;
  return (
    <div
      className="relative flex h-10 shrink-0 items-center gap-gx-xs pl-2.5 pr-2 pt-2"
      data-testid="l2-table-actions"
    >
      <button
        type="button"
        onClick={() => toast(plannedHint("分享数据"), "info")}
        title="分享数据 · 规划中"
        className="flex h-7 items-center gap-1 rounded-gx-lg px-2 text-gx-12 text-gx-accent transition-colors hover:bg-gx-row-hover"
      >
        <Icon name="share" size={13} />
        <span>分享数据</span>
        <PlannedBadge />
      </button>
    </div>
  );
}
