// M4 继承开关（仅 doc/canvas）：先 GET impact 预览弹确认，PATCH confirmed:true；
// 若遇 409 INHERITANCE_CONFIRM_REQUIRED（竞态：服务端要求确认），用附 impact 重弹同一 Modal 原样重放。
import { useState } from "react";
import type { InheritanceImpactDTO, NavNodeDTO } from "@gx/shared-types";
import { toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useInheritanceImpact, usePatchInheritance } from "./authz-hooks";
import { InheritanceConfirmModal } from "./InheritanceConfirmModal";
import { extractInheritanceImpact, isInheritableKind } from "./lib/policy-model";

const PAGE_LIMIT = 100;

export function InheritanceToggle({
  node,
  inheritAncestors,
  editable,
}: {
  node: NavNodeDTO;
  inheritAncestors: boolean;
  editable: boolean;
}) {
  const [impact, setImpact] = useState<InheritanceImpactDTO | null>(null);
  const impactQ = useInheritanceImpact();
  const patch = usePatchInheritance(node.id);

  // 仅 doc/canvas 有继承开关；其它 kind 不渲染（后端 400 NODE_NOT_INHERITABLE）。
  if (!isInheritableKind(node.kind)) return null;

  const begin = async () => {
    // 目标值：当前开→关（中断 losing）；当前关→开（恢复 gaining）。
    const value = !inheritAncestors;
    try {
      const data = await impactQ.mutateAsync({ nodeId: node.id, value, limit: PAGE_LIMIT, offset: 0 });
      setImpact(data);
    } catch (e) {
      toast(e instanceof Error ? e.message : "无法获取继承影响面", "error");
    }
  };

  const confirm = async (snapshot: InheritanceImpactDTO) => {
    const value = snapshot.to;
    try {
      await patch.mutateAsync({ value, confirmed: true });
      setImpact(null);
    } catch (e) {
      const forced = extractInheritanceImpact(e);
      if (forced) {
        // 服务端状态与预览竞态：用 409 附 impact 替换快照重弹，用户再确认即原样重放。
        setImpact(forced);
      } else {
        toast(e instanceof Error ? e.message : "继承设置失败", "error");
      }
    }
  };

  const loadMore = async () => {
    if (!impact) return;
    const offset = impact.items.length;
    try {
      const more = await impactQ.mutateAsync({
        nodeId: node.id,
        value: impact.to,
        limit: PAGE_LIMIT,
        offset,
      });
      setImpact({ ...more, items: [...impact.items, ...more.items] });
    } catch {
      toast("加载更多失败", "error");
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        disabled={!editable || impactQ.isPending}
        onClick={begin}
        title={inheritAncestors ? "当前从上级继承，点击可中断" : "已中断继承，点击可恢复"}
        className={[
          "flex items-center gap-1 rounded-full border px-2 py-1 text-gx-12 transition-colors",
          inheritAncestors
            ? "border-gx-separator text-gx-text-secondary hover:bg-gx-row-hover"
            : "border-gx-accent bg-gx-accent-bg font-medium text-gx-accent",
          editable ? "" : "cursor-not-allowed opacity-60",
        ].join(" ")}
      >
        <Icon name={inheritAncestors ? "inherit" : "cutoff"} size={13} />
        {inheritAncestors ? "继承上级" : "已中断继承"}
      </button>
      {impact && (
        <InheritanceConfirmModal
          impact={impact}
          busy={patch.isPending}
          loadingMore={impactQ.isPending}
          onMore={impact.items.length < impact.count ? loadMore : undefined}
          onConfirm={() => confirm(impact)}
          onCancel={() => setImpact(null)}
        />
      )}
    </div>
  );
}
