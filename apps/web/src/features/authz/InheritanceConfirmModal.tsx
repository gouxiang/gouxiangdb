// M4 Break/Restore 继承二次确认 Modal：精确失访/恢复人数 + 受影响用户（分页）+ 豁免主体。
// 文案区分 losing/gaining；exempt（creator/workspace_owner）不计入失访数、单独展示。
import { Button, Modal, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { InheritanceImpactDTO } from "@gx/shared-types";

const VIA_LABEL: Record<string, string> = {
  direct: "直接授权",
  dept: "部门授予",
  role: "角色授予",
};

export function InheritanceConfirmModal({
  impact,
  busy,
  loadingMore,
  onMore,
  onConfirm,
  onCancel,
}: {
  impact: InheritanceImpactDTO;
  busy: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const losing = impact.delta === "losing";
  return (
    <Modal
      open
      width={520}
      title={losing ? "中断从上级继承？" : "恢复从上级继承？"}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant={losing ? "danger" : "primary"} onClick={onConfirm} loading={busy} disabled={busy}>
            {losing ? "确认中断" : "确认恢复"}
          </Button>
        </>
      }
    >
      <ConfirmBody impact={impact} busy={busy} loadingMore={loadingMore} onMore={onMore} />
    </Modal>
  );
}

/** Modal 内容体（不套 Portal，供 node 环境快照测试直接渲染）。 */
export function ConfirmBody({
  impact,
  busy,
  loadingMore,
  onMore,
}: {
  impact: InheritanceImpactDTO;
  busy: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
}) {
  const losing = impact.delta === "losing";
  const hiddenCount = Math.max(0, impact.count - impact.items.length);
  return (
    <>
      <p className="mb-3 text-gx-13 text-gx-text-primary">
        {losing
          ? `中断后，将有 ${impact.count} 人失去从上级继承来的访问。`
          : `恢复后，将有 ${impact.count} 人重新获得从上级继承来的访问。`}
        {losing && impact.exempt.length > 0
          ? ` 另有 ${impact.exempt.length} 位创建者/工作区所有者不受影响。`
          : ""}
      </p>

      {impact.items.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-gx-11 font-medium text-gx-text-hint">
            {losing ? "将失去访问的成员" : "将重新获得访问的成员"}（{impact.count}）
          </div>
          <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto rounded-gx-lg border border-gx-separator p-1">
            {impact.items.map((it) => (
              <div key={it.userId} className="flex items-center gap-2 rounded-gx-sm px-1.5 py-1">
                <Icon name={it.via === "direct" ? "keyRound" : "inherit"} size={13} className="shrink-0 text-gx-text-hint" />
                <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">{it.name ?? "已删除成员"}</span>
                <span className="shrink-0 text-gx-11 text-gx-text-hint">{VIA_LABEL[it.via] ?? it.via}</span>
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className="px-1.5 py-1 text-gx-12 text-gx-text-hint">另有 {hiddenCount} 人未列出。</div>
            )}
          </div>
          {onMore && impact.limit > 0 && impact.items.length >= impact.limit && (
            <button
              type="button"
              onClick={onMore}
              disabled={loadingMore}
              className="mt-1 text-gx-12 text-gx-accent hover:underline disabled:opacity-50"
            >
              {loadingMore ? "加载中…" : "显示更多"}
            </button>
          )}
        </div>
      )}

      {losing && impact.exempt.length > 0 && (
        <div>
          <div className="mb-1 text-gx-11 font-medium text-gx-text-hint">不受影响（{impact.exempt.length}）</div>
          <div className="flex flex-col gap-0.5">
            {impact.exempt.map((ex) => (
              <div key={ex.userId} className="flex items-center gap-2 px-1.5 py-0.5">
                <Icon name="shield" size={13} className="shrink-0 text-gx-text-hint" />
                <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-secondary">{ex.name ?? "已删除成员"}</span>
                <span className="shrink-0 text-gx-11 text-gx-text-hint">
                  {ex.reason === "creator" ? "创建者" : "工作区所有者"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {busy && (
        <div className="mt-2 flex justify-center">
          <Spinner size={16} />
        </div>
      )}
    </>
  );
}
