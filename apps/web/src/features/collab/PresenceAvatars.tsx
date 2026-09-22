// apps/web/src/features/collab/PresenceAvatars.tsx
// 在线头像列表：内容页固定区域显示当前正在看/编辑这份内容的人（DESIGN.md §5.1 在线名单 UI）。
//
// 这是需求本体的一部分（决策 D4「匿名参与者参与协同」要求看得见有谁在），属**新增** UI，
// 不改动任何既有组件 —— D6 红线。
//
// D6 关键约束：**没有他人时必须渲染成 null**。
// 「单机模式（不建立任何协同连接）下页面 DOM 逐元素一致」是-stage 验收的机械判据，
// 一个空的占位容器（哪怕 0 高度）也会破坏逐元素一致，所以一条 peers 都没有就直接返回 null。

import type { CollabPresenceEntry } from "@gx/shared-types";
import { displayNameOf, initialOf, splitPresence } from "./collab-peers";

/**
 * 折叠阈值：默认 3。
 *
 * 理由：本组件挂在内容页顶栏的横向空间里。单个 chip ≈ 头像 28px + 名字（截断到 6 字约 60px）
 * + 间距 6px ≈ 95px，三个已达 ~285px。而 `DocEditorPage.tsx:193-219` 顶栏右侧已有
 * 「保存 / 分享 / 版本历史」三个按钮（约 260px），再多就会挤压既有工具区 —— 那是**既有 UI**，不可撼动。
 * 故所见最多 3 个，其余折叠为 `+N`；被折叠的人名不丢，全部放进 title 里，hover 可见。
 */
export const AVATAR_MAX_VISIBLE = 3;

export interface PresenceAvatarsProps {
  /** 直接传 useCollabSession 的 entries（含自己，组件内部自行剔除）。 */
  entries: readonly CollabPresenceEntry[];
  /** 本连接 id，用于剔除自己；null = 尚未连上或未启用协同。 */
  selfId: string | null;
  /** 可见上限，超过折叠；默认 AVATAR_MAX_VISIBLE。 */
  max?: number;
  /** 附加在根节点上的类名，供宿主排版。 */
  className?: string;
}

export function PresenceAvatars({
  entries,
  selfId,
  max = AVATAR_MAX_VISIBLE,
  className,
}: PresenceAvatarsProps): JSX.Element | null {
  const { peers } = splitPresence(entries, selfId);
  // D6：单机模式零 DOM 增量 —— 没有他人就不渲染任何东西
  if (peers.length === 0) return null;

  const visible = peers.slice(0, Math.max(max, 1));
  const rest = peers.slice(visible.length);
  const restNames = rest.map(displayNameOf).join("、");

  return (
    <div
      className={`inline-flex items-center gap-1.5 ${className ?? ""}`}
      aria-label={`当前在线协作者 ${peers.length} 人`}
    >
      {visible.map((peer) => {
        const name = displayNameOf(peer);
        return (
          <span key={peer.id} className="inline-flex items-center gap-1" title={name}>
            {/* 圆形头像沿用既有做法 DocAclModal.tsx:131；
                底色只能走 inline style：color 是服务端分配的数据，契约明写客户端不得自行生成 */}
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gx-border text-gx-12 font-medium text-white"
              style={{ backgroundColor: peer.color }}
              aria-hidden="true"
            >
              {initialOf(name)}
            </span>
            <span className="max-w-[6em] truncate text-gx-12 text-gx-text-secondary">{name}</span>
          </span>
        );
      })}
      {rest.length > 0 && (
        <span
          className="shrink-0 rounded-full bg-gx-bg px-1.5 text-gx-11 text-gx-text-tertiary"
          title={restNames}
        >
          {/* 单个子节点，避免渲染成带注释分隔符的碎片（SSR 输出要可被稳定断言） */}
          {`+${rest.length}`}
        </span>
      )}
    </div>
  );
}
