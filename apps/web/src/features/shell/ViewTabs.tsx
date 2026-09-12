// apps/web/src/features/shell/ViewTabs.tsx
// 视图标签页：切换视图、双击重命名、末尾新建视图
// 选中态胶囊用 gx-* token；横向溢出可滚动

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBase, useViews, useGXMutations } from "../../api/hooks";
import { Icon, VIEW_ICON } from "../../components/icons";
import { Input, Modal, toast } from "../../components/ui";
import { VIEW_TYPES, VIEW_TYPE_LABEL, type ViewType } from "@gx/shared-types";

export function ViewTabs() {
  const navigate = useNavigate();
  const { baseId, tableId, viewId } = useParams();
  const { data: views } = useViews(tableId ?? null);
  const baseQ = useBase(baseId ?? null);
  const canManageSchema = baseQ.data?.permissions?.canManageSchema ?? false;

  const m = useGXMutations();

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ViewType>("grid");

  async function rename() {
    if (!editing || !editing.name.trim()) return;
    try {
      await m.updateView.mutateAsync({ viewId: editing.id, tableId: tableId!, data: { name: editing.name.trim() } });
      setEditing(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  async function create() {
    if (!newName.trim() || !tableId) return;
    try {
      const v = await m.createView.mutateAsync({ tableId, name: newName.trim(), type: newType });
      setNewName("");
      setShowNew(false);
      navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建视图失败", "error");
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {(views ?? []).map((v) => {
          const active = v.id === viewId;
          return (
            <div key={v.id} className="group flex shrink-0 items-center">
              {active ? (
                <span className="flex items-center gap-1.5 rounded-full border border-gx-border bg-gx-accent-bg px-2.5 py-1 text-gx-12 font-medium text-gx-accent">
                  <Icon name={VIEW_ICON[v.type] ?? "grid"} size={13} />
                  {editing?.id === v.id ? (
                    <input
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ id: v.id, name: e.target.value })}
                      onBlur={rename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="w-20 bg-transparent text-gx-accent outline-none"
                    />
                  ) : (
                    <span onDoubleClick={() => canManageSchema && setEditing({ id: v.id, name: v.name })}>{v.name}</span>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`)}
                  onDoubleClick={() => canManageSchema && setEditing({ id: v.id, name: v.name })}
                  className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg"
                >
                  <Icon name={VIEW_ICON[v.type] ?? "grid"} size={13} />
                  <span>{v.name}</span>
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          disabled={!canManageSchema}
          title={canManageSchema ? "新建视图" : "无管理结构权限"}
          onClick={() => setShowNew(true)}
          className="shrink-0 rounded-full px-2 py-1 text-gx-text-tertiary hover:bg-gx-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      </div>

      <Modal
        open={showNew}
        title="新建视图"
        onClose={() => setShowNew(false)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setShowNew(false)}>
              取消
            </button>
            <button
              className="rounded-gx-md bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
              disabled={!newName.trim()}
              onClick={create}
            >
              创建
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {VIEW_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setNewType(t)}
                className={[
                  "flex items-center gap-1.5 rounded-gx-md border px-2 py-1 text-gx-12",
                  newType === t ? "border-gx-accent bg-gx-accent-bg text-gx-accent" : "border-gx-border text-gx-text-primary hover:bg-gx-bg",
                ].join(" ")}
              >
                <Icon name={VIEW_ICON[t]} size={13} />
                {VIEW_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <Input
            autoFocus
            placeholder="视图名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
        </div>
      </Modal>
    </div>
  );
}
