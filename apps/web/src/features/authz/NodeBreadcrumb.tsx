// M4 面包屑（A-6 防泄漏）：只渲染后端下发的可见链 chain；truncatedAbove=true 时
// 在链首渲染中性"上级受限"标记。绝不请求/猜测/拼接被截祖先（响应不含其 id/name/path）。
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { useBreadcrumb } from "./authz-hooks";
import type { NodeBreadcrumbDTO } from "@gx/shared-types";

/** 纯展示：给定面包屑数据渲染链 + 截断标记（零数据请求，便于快照测试）。 */
export function BreadcrumbChain({ data, onNavigate }: {
  data: NodeBreadcrumbDTO;
  onNavigate?: (nodeId: string) => void;
}) {
  return (
    <nav aria-label="节点面包屑" className="flex min-w-0 flex-wrap items-center gap-0.5 text-gx-12 text-gx-text-secondary">
      {data.truncatedAbove && (
        <span
          className="flex items-center gap-1 rounded-gx-sm bg-gx-row-hover px-1.5 py-0.5 text-gx-text-hint"
          title="上级节点超出你的可见范围"
        >
          <Icon name="cutoff" size={12} />
          上级受限
        </span>
      )}
      {data.truncatedAbove && data.chain.length > 0 && <Sep />}
      {data.chain.map((node, i) => {
        const last = i === data.chain.length - 1;
        return (
          <span key={node.id} className="flex items-center gap-0.5">
            {onNavigate && !last ? (
              <button
                type="button"
                onClick={() => onNavigate(node.id)}
                className="rounded-gx-sm px-1 py-0.5 hover:bg-gx-row-hover hover:text-gx-text-primary"
              >
                {node.name}
              </button>
            ) : (
              <span className={last ? "px-1 py-0.5 font-medium text-gx-text-primary" : "px-1 py-0.5"}>
                {node.name}
              </span>
            )}
            {!last && <Sep />}
          </span>
        );
      })}
    </nav>
  );
}

function Sep() {
  return <Icon name="chevronRight" size={11} className="shrink-0 text-gx-text-hint" />;
}

/** 带数据请求的面包屑容器；off/shadow 态后端回全链 truncatedAbove=false，前端无需分支。 */
export function NodeBreadcrumb({ nodeId, onNavigate }: {
  nodeId: string | null;
  onNavigate?: (nodeId: string) => void;
}) {
  const { crumb, isLoading, isError } = useBreadcrumb(nodeId);
  if (!nodeId) return null;
  if (isLoading) return <Spinner size={13} />;
  if (isError || !crumb) return null; // 无权/失败不渲染，不猜测祖先
  return <BreadcrumbChain data={crumb} onNavigate={onNavigate} />;
}
