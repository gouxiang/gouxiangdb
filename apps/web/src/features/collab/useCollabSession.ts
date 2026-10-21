// apps/web/src/features/collab/useCollabSession.ts
// 阶段 1 · 协同会话 hook：把连接层的状态机与在线名单接到 React，供**阶段 2 起**的
// 头像列表 / 远端光标接线使用。本阶段不渲染任何 UI（D6 UI 冻结）。
//
// 职责边界：
//   1. roomId 变化 / 组件卸载 → 必须 disconnect（Vite 热重载与路由切换都会重跑 effect，
//      漏关闭会泄漏长连接）。
//   2. WS 尚未连通时，先用 getCollabPresence 拉一次服务端名单兜底（DESIGN.md §4.3）。
//   3. awareness 载荷按白名单裁剪后才进 state（toPresenceEntries）。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Doc } from "yjs";
import { getCollabPresence } from "../../api/client";
import { dataSourceResolver } from "../../node/datasource";
import { createCollabConnection, type CollabConnection, type CollabStatus } from "./collab-provider";
import { toPresenceEntries } from "./collab-presence";
import { yOfflineEnabled } from "./yOfflineGate";
import type { CollabDenyReason, CollabPresenceEntry } from "@gx/shared-types";

export interface UseCollabSessionResult {
  status: CollabStatus;
  entries: CollabPresenceEntry[];
  /**
   * 本连接的身份 id；与 entries[].id 同源（包含在 entries 里）。
   * 叠加层用它把自己从「他人」里剔除（DESIGN.md §5.1：同账号多标签页算多个参与者）。
   */
  selfId: string | null;
  /** 协同文档实例（尚未连通时也已存在，可供后续绑定本地内容）；未启用协同时为 null。 */
  doc: Doc | null;
  /**
   * 本地 gx-y 累积被确认合并到服务端的次数（首连 / 断线重连，且确有本地更新被带走时自增）。
   * 门控关时恒为 0、永不自增。页面据此把整篇 gx-kb-draft 降级清掉。
   */
  localMergedTick: number;
  /** denied 时的可展示原因文案；其余状态为 null。 */
  error: string | null;
  /**
   * 发布本地 awareness 字段（阶段 2：`{ selection }` / `{ leases }`；传 null 清除）。
   * 未启用协同（roomId 为 null）或连接已销毁时是 no-op。
   *
   * **引用必须稳定**：页面层会把 publish 放进 effect 依赖数组（光标上报是长驻监听），
   * 每次 render 换一个函数就会带着监听反复解绑重绑。故这里只持有连接引用、用空依赖
   * useCallback 固定自身。
   */
  publish: (fields: Record<string, unknown>) => void;
}

const DENY_TEXT: Record<CollabDenyReason, string> = {
  ticket_invalid: "协同连接凭据无效",
  ticket_expired: "协同连接凭据已过期",
  no_access: "没有该内容的协同访问权限",
  readonly: "当前为只读，无法参与编辑",
  handshake_timeout: "协同握手超时",
  downgraded: "权限已降级，已转为只读",
};

export function useCollabSession(roomId: string | null): UseCollabSessionResult {
  const [status, setStatus] = useState<CollabStatus>("idle");
  const [entries, setEntries] = useState<CollabPresenceEntry[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [localMergedTick, setLocalMergedTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 节点模式 S2：订阅数据源，nodeId 进 effect 依赖——切节点（local↔远端）时本 effect 重跑，
  // 清理函数 disconnect 旧长连、按新节点重新取票（取票走 apiFetch 自动跟源）并建新 WS。
  // 只订阅 nodeId 这个稳定标量：同节点 token 刷新不会误触发长连重建。
  const nodeId = useSyncExternalStore(
    dataSourceResolver.subscribe,
    () => dataSourceResolver.current().nodeId,
    () => "local",
  );

  /** 当前连接（发布口的实际落点）；用 ref 而非 state，避免 publish 因重渲染而换引用。 */
  const connRef = useRef<CollabConnection | null>(null);
  const publish = useCallback((fields: Record<string, unknown>) => {
    connRef.current?.setLocalFields(fields);
  }, []);

  useEffect(() => {
    if (!roomId) {
      connRef.current = null;
      setEntries([]);
      setSelfId(null);
      setDoc(null);
      setLocalMergedTick(0);
      setError(null);
      setStatus("idle");
      return;
    }
    let alive = true;
    let connectedOnce = false;
    setEntries([]);
    setError(null);
    setLocalMergedTick(0);

    // WS 未连通时的首屏兜底名单：一旦连通即让位给 awareness（见下面的 connectedOnce）。
    void getCollabPresence(roomId)
      .then((snapshot) => {
        if (!alive || connectedOnce) return;
        setEntries(snapshot.entries ?? []);
      })
      .catch(() => {
        /* 兜底失败不影响主链路：连上后 awareness 会给出完整名单 */
      });

    const conn = createCollabConnection(roomId, {
      // S2：WS origin 取当前数据源的纯 host（不含 basePath，wsPath 已自带网关前缀，防双前缀）。
      // effect 内同步读取：重跑时必为当前节点 origin；恒 local 时与旧默认 defaultOrigin 逐字节一致。
      origin: dataSourceResolver.wsHostOrigin(),
      // 离线 gx-y 累积：门控关时显式传 false（不写任何 localStorage）；门控开时让底座开累积。
      offlinePersistence: yOfflineEnabled(),
      onLocalMerged: () => {
        if (alive) setLocalMergedTick((n) => n + 1);
      },
      onStatus: (next, reason) => {
        if (!alive) return;
        if (next === "connected") connectedOnce = true;
        setStatus(next);
        setError(next === "denied" ? (reason ? DENY_TEXT[reason] : "协同连接被拒绝") : null);
      },
    });
    connRef.current = conn;
    setSelfId(conn.selfId);
    setDoc(conn.doc);

    const unsubscribe = conn.onAwarenessChange((states) => {
      if (!alive) return;
      setEntries(toPresenceEntries(states));
    });

    return () => {
      alive = false;
      connRef.current = null;
      unsubscribe();
      conn.disconnect();
    };
    // nodeId 入依赖：切节点销毁重建；origin 在 effect 体内同步读 resolver，不进依赖（避免字符串抖动）。
  }, [roomId, nodeId]);

  return { status, entries, selfId, doc, localMergedTick, error, publish };
}
