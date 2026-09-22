// apps/web/src/features/collab/CollabLeaseLayer.tsx
// 块级占用的遮挡层：某人正在编辑某一块时，本地不能编辑那一块，并提示是谁在编辑。
//
// D6 硬约束：与光标层同理，本组件是编辑器容器的**兄弟节点**，不进编辑器内部 DOM。
//   判定所需的一切数据都来自 awareness 的 leases + 模块级单例登记表（lease-registry.ts），
//   判定为零自建样式之外的部分全部在下层。
//
// 怎么做到「本地不能编辑」却不改编辑器：在每个被占用块的 rect 上盖一层遮罩，并让它吃掉了指针事件
// （父层 pointer-events-none + 本层 pointer-events-auto）。这是**唯一**既不侵入编辑器内部、又能真正
// 拦住点击的手段 —— 单纯加 class 或禁用属性都需要改编辑器，被 D6 明令禁止。
//
// 已知边界（如实记录）：遮罩拦的是指针。若光标**已经**在该块内（比如对方刚抢占、或本地持有焦点时
// 对方才开始编辑），键盘输入不会被拦。租约本身是体验层软锁，不承担数据安全职责（CRDT 会合并，
// 见 DESIGN.md §5.2「冲突回退」），故这个边界可接受，不为此去改编辑器。
//
// 覆盖不到的部分：无 jsdom，querySelector/getBoundingClientRect 无法单测；
// 登记表的全部语义已由 lease-registry.test.ts 覆盖。

import { useMemo } from "react";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { splitPresence } from "./collab-peers";
import type { LeaseHolder } from "./lease-registry";
import { cssEscape } from "./block-cursor-locator";
import { toLocalRect, useDomTicker } from "./overlay-anchors";
import { useCollabLeases } from "./useCollabLeases";

export interface CollabLeaseLayerProps {
  containerRef: React.RefObject<HTMLElement | null>;
  entries: readonly CollabPresenceEntry[];
  selfId: string | null;
  /** 别人正占着、本地用户却硬要点进去时的回调（宿主可据此给 toast 提示）。可选。 */
  onBlocked?: (unit: string, holder: LeaseHolder) => void;
}

interface PlacedMask {
  unit: string;
  holder: LeaseHolder;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function CollabLeaseLayer({
  containerRef,
  entries,
  selfId,
  onBlocked,
}: CollabLeaseLayerProps): JSX.Element | null {
  const { registry, version } = useCollabLeases(entries, selfId);
  const peers = useMemo(() => splitPresence(entries, selfId).peers, [entries, selfId]);

  // 只关心「被他人占用」的单元；自己占着自己的块不遮自己（登记表已保证本地优先）。
  // version / peers 是失效信号（登记表变更、awareness 名单变更），闭包里读不到但必须参与依赖，
  // 否则占用状态更新后遮罩不会重算 —— 这里定向关掉 lint 的误报。
  const foreignUnits = useMemo(() => {
    return [...registry.heldUnits().values()]
      .filter((h) => !h.self)
      .map((h) => h.unit)
      .sort();
    // version 是登记表变更信号；peers 保证 awareness 名单更新时也重算
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version/peers 为失效信号
  }, [registry, version, peers]);

  const signal = foreignUnits.join(",");
  const tick = useDomTicker(containerRef, foreignUnits.length > 0, signal);

  const masks = useMemo<PlacedMask[]>(() => {
    const container = containerRef.current;
    if (!container || foreignUnits.length === 0) return [];
    const box = container.getBoundingClientRect();
    const out: PlacedMask[] = [];
    for (const unit of foreignUnits) {
      const holder = registry.holderOf(unit);
      const el = container.querySelector(`[data-block="${cssEscape(unit)}"]`);
      if (!holder || holder.self || !el) continue;
      const rect = el.getBoundingClientRect();
      const local = toLocalRect(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      );
      out.push({ unit, holder, left: local.left, top: local.top, width: local.width, height: local.height });
    }
    return out;
    // tick 同上：滚动 / resize 后必须重新量测块矩形
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick 为重算节拍信号
  }, [containerRef, foreignUnits, registry, tick]);

  // D6：没有任何占用时不产出任何 DOM
  if (masks.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-gx-collab="leases"
    >
      {masks.map((m) => (
        <div
          key={m.unit}
          /* 只有吃掉指针事件才真正拦得住本地编辑；父层 pointer-events-none 保证其余区域照常穿透 */
          className="pointer-events-auto absolute cursor-not-allowed rounded-gx-sm bg-gx-bg/60"
          style={{ left: m.left, top: m.top, width: m.width, height: m.height }}
          title={`${m.holder.nick} 正在编辑此块，暂时无法修改`}
          onPointerDown={() => onBlocked?.(m.unit, m.holder)}
        >
          <span className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-gx-sm border border-gx-border bg-gx-surface px-1.5 py-0.5 text-gx-11 text-gx-text-tertiary shadow-gx-sm">
            <Icon name="lock" size={11} />
            {m.holder.nick} 正在编辑
          </span>
        </div>
      ))}
    </div>
  );
}
