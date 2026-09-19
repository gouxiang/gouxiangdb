// M4 统一授权管理面板：左资源树（M3 tree，后端剪枝）+ 右节点策略编辑。
// 写入口经 useAuthzCapability 门控（默认 fail-closed）；只读解释（effective/面包屑）随面板可见。
//
// 页面级门控（交互治理第一批）：直访 /workspace/authz 必须先过与 FooterNav 同一判定
// （features/workspace/lib/nav-gate.ts 的 canSeeAuthz）——不具备相应能力时只出「无权限」态，
// 一棵策略树都不渲染。原先门控只下沉到面板内部写入口，导致无权账号直访仍能看到完整策略树。
import { useState } from "react";
import type { NavNodeDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Button, EmptyState } from "../../components/ui";
import { PermNodeTree } from "./PermNodeTree";
import { PermNodeEditor } from "./PermNodeEditor";
import { EffectiveDrawer } from "./EffectiveDrawer";
import { NodeBreadcrumb } from "./NodeBreadcrumb";
import { useAuthzCapability } from "./useAuthzCapability";
import { useMyOrgActions } from "../contacts/contacts-hooks";
import { canSeeAuthz } from "../workspace/lib/nav-gate";

export default function PermPanel({ embedded }: { embedded?: boolean } = {}) {
  const [selected, setSelected] = useState<NavNodeDTO | null>(null);
  const [showEffective, setShowEffective] = useState(false);
  const { canManage } = useAuthzCapability();
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  // 探针未回来先按不可见处理（fail-closed）：先出树再改成无权限态等于把策略树闪给无权账号。
  const canView = !actionsLoading && canSeeAuthz(actions, canManage);

  // 无权限：整页替换为无权限态（不渲染 PermNodeTree / PermNodeEditor）。
  if (!canView) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg">
        <EmptyState
          icon="shield"
          title="无权限查看权限管理"
          description="权限管理仅向工作区所有者或持「授权管理」动作的成员开放。"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-gx-bg">
      <header className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
        {/* embedded：由宿主（工作区设置分区）提供标题，这里只留面包屑/来源按钮，不重复一个大标题 */}
        {!embedded && (
          <>
            <Icon name="shield" size={16} className="text-gx-text-secondary" />
            <h1 className="text-gx-15 font-semibold text-gx-text-primary">权限管理</h1>
          </>
        )}
        <div className="min-w-0 flex-1 px-2">
          {selected && <NodeBreadcrumb nodeId={selected.id} />}
        </div>
        {selected && (
          <Button variant="ghost" size="sm" icon="inherit" onClick={() => setShowEffective(true)}>
            权限来源
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-gx-separator bg-gx-surface">
          <PermNodeTree selectedId={selected?.id ?? null} onSelect={setSelected} />
        </aside>
        <main className="min-w-0 flex-1 bg-gx-bg">
          {selected ? (
            <div key={selected.id} className="flex h-full flex-col">
              <PermNodeEditor node={selected} />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-gx-text-hint">
              <Icon name="shield" size={28} className="opacity-50" />
              <p className="text-gx-13">从左侧选择一个资源，查看与管理其授权。</p>
            </div>
          )}
        </main>
      </div>

      {showEffective && selected && (
        <EffectiveDrawer nodeId={selected.id} nodeName={selected.name} onClose={() => setShowEffective(false)} />
      )}
    </div>
  );
}
