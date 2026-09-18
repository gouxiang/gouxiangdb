// M4 权限来源链抽屉（O8 可解释，只读）：七动作 perAction 的最终判定 + 授予来源。
// 缺省查本人；查他人需 manage_share——后端 403 时隐藏"查他人"入口，前端不做本地越权判断。
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { Modal, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useEffective } from "./authz-hooks";
import { ACTION_META } from "./lib/policy-model";
import type { EffectiveSourceDTO, ResourceAction } from "@gx/shared-types";

export function EffectiveDrawer({
  nodeId,
  nodeName,
  onClose,
}: {
  nodeId: string;
  nodeName: string;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string>("");
  const [queryUserId, setQueryUserId] = useState<string | undefined>(undefined);
  const [canInspect, setCanInspect] = useState(true);
  const effective = useEffective(nodeId, queryUserId);

  // 查他人 403：收回"查他人"入口（manage_share 判定在后端）。
  useEffect(() => {
    if (effective.error instanceof ApiError && effective.error.status === 403) {
      setCanInspect(false);
      setQueryUserId(undefined);
    }
  }, [effective.error]);

  return (
    <Modal open onClose={onClose} width={560} title={`权限来源 · ${nodeName}`}>
      {canInspect && (
        <div className="mb-3 flex items-center gap-1.5 rounded-gx-sm border border-gx-separator bg-gx-surface px-2 py-1">
          <Icon name="search" size={13} className="shrink-0 text-gx-text-hint" />
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="输入成员 ID 查看其有效权限（需分享管理权限）"
            className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
          <button
            type="button"
            onClick={() => setQueryUserId(target.trim() || undefined)}
            className="shrink-0 rounded-gx-sm px-2 py-0.5 text-gx-12 text-gx-accent hover:bg-gx-accent-bg"
          >
            查询
          </button>
          {queryUserId && (
            <button
              type="button"
              onClick={() => {
                setTarget("");
                setQueryUserId(undefined);
              }}
              className="shrink-0 text-gx-12 text-gx-text-hint hover:text-gx-text-primary"
            >
              回到本人
            </button>
          )}
        </div>
      )}

      {effective.isLoading ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : effective.isError || !effective.view ? (
        <div className="py-10 text-center text-gx-12 text-gx-text-hint">无权查看该节点的有效权限来源。</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-gx-12 text-gx-text-hint">
            主体 {queryUserId ? queryUserId : "（你本人）"} · 策略版本 {effective.view.policyVersion}
          </div>
          {ACTION_META.map(({ action, label }) => {
            const pa = effective.view!.perAction.find((p) => p.action === action);
            return <ActionSources key={action} action={action} label={label} allowed={!!pa?.allowed} sources={pa?.sources ?? []} />;
          })}
        </div>
      )}
    </Modal>
  );
}

function ActionSources({
  action,
  label,
  allowed,
  sources,
}: {
  action: ResourceAction;
  label: string;
  allowed: boolean;
  sources: EffectiveSourceDTO[];
}) {
  return (
    <div className="rounded-gx-md border border-gx-separator px-2.5 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-gx-12 text-gx-text-secondary">{action}</span>
        <span className="flex-1 text-gx-13 font-medium text-gx-text-primary">{label}</span>
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-gx-11",
            allowed ? "bg-gx-accent-bg text-gx-accent" : "bg-gx-row-hover text-gx-text-hint",
          ].join(" ")}
        >
          {allowed ? "允许" : "拒绝"}
        </span>
      </div>
      {allowed && sources.length > 0 && (
        <ul className="flex flex-col gap-1">
          {sources.map((s, i) => (
            <SourceLine key={`${s.kind}:${s.policyId ?? "fb"}:${s.nodeId}:${i}`} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceLine({ s }: { s: EffectiveSourceDTO }) {
  const isFallback = s.kind === "owner_fallback" || !!s.fallback;
  return (
    <li className="flex items-start gap-1.5 text-gx-12 text-gx-text-secondary">
      <Icon
        name={isFallback ? "shield" : s.viaAncestor ? "inherit" : "keyRound"}
        size={12}
        className="mt-0.5 shrink-0 text-gx-text-hint"
      />
      <span className="min-w-0">
        <span className={s.subjectName ? "text-gx-text-primary" : "text-gx-text-hint"}>
          {s.subjectName ?? "已删除主体"}
        </span>
        {isFallback && <span className="text-gx-text-hint"> · {s.fallback === "creator" ? "创建者兜底" : "工作区所有者兜底"}</span>}
        {!isFallback && s.viaAncestor && <span className="text-gx-text-hint"> · 继承自祖先节点 {s.nodeName ?? s.nodeId}</span>}
        {!isFallback && !s.viaAncestor && <span className="text-gx-text-hint"> · 直接授予于 {s.nodeName ?? s.nodeId}</span>}
      </span>
    </li>
  );
}
