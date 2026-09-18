// apps/web/src/features/grid/ViewSwitcher.tsx
// 视图切换器：下拉列出本表全部视图并切换，底部提供新建 / 重命名 / 删除当前视图。
// 挂在网格工具栏最左侧，补上「复制视图后新视图在 UI 里不可达」的交互闭环。
//
// 约束：
//  - 删除必须保留至少一个视图（后端也校验，前端同步禁用避免白屏）
//  - 切换 = 导航到 /base/:baseId/table/:tableId/view/:viewId（与全站既有跳转写法一致）
//  - 写操作后 await 视图列表失效再跳转，避免目标视图还没进列表就渲染

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useViews, useGXMutations } from "../../api/hooks";
import { VIEW_TYPES, VIEW_TYPE_LABEL, type ViewType } from "@gx/shared-types";
import { Icon, VIEW_ICON } from "../../components/icons";
import { confirmIrreversible } from "../../components/feedback";
import {
  Button,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  Modal,
  Popover,
  toast,
} from "../../components/ui";

export interface ViewSwitcherProps {
  baseId: string;
  tableId: string;
  viewId: string;
  canManageSchema: boolean;
}

const NO_PERMISSION_HINT = "需要表结构管理权限";

export function ViewSwitcher({ baseId, tableId, viewId, canManageSchema }: ViewSwitcherProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: views } = useViews(tableId);
  const m = useGXMutations();

  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<ViewType>("grid");
  const [busy, setBusy] = useState(false);
  // 触发按钮在浮层之外：mousedown 会先经 Popover 的外部点击把浮层关掉，
  // 紧随其后的 click 再切换就会立刻重新打开（表现为"点了关不掉"），这里记时间做抑制。
  const closedAtRef = useRef(0);
  const closePopover = () => {
    closedAtRef.current = Date.now();
    setOpen(false);
  };

  const list = views ?? [];
  const current = list.find((v) => v.id === viewId);
  const onlyOne = list.length <= 1;

  const goToView = (id: string) => {
    setOpen(false);
    navigate(`/base/${baseId}/table/${tableId}/view/${id}`);
  };

  const openNew = () => {
    setType("grid");
    setName(`${VIEW_TYPE_LABEL.grid}视图`);
    setModal("new");
    setOpen(false);
  };

  const openRename = () => {
    setName(current?.name ?? "");
    setModal("rename");
    setOpen(false);
  };

  async function submitNew() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const v = await m.createView.mutateAsync({ tableId, name: n, type });
      setModal(null);
      // 等列表取回再跳，否则目标视图不在列表里会停在加载态
      await qc.invalidateQueries({ queryKey: ["views", tableId] });
      goToView(v.id);
    } catch (e) {
      toast((e as Error)?.message ?? "新建视图失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await m.updateView.mutateAsync({ viewId, tableId, data: { name: n } });
      setModal(null);
      toast("视图已重命名", "success");
    } catch (e) {
      toast((e as Error)?.message ?? "重命名失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeCurrent() {
    if (onlyOne || busy) return;
    // R-D-23 L4（不可恢复）+ R-D-24 主按钮必须是具体动词，不用「确定 / 是」
    const ok = await confirmIrreversible({
      title: "删除视图",
      confirmText: "删除视图",
      description: `视图「${current?.name ?? ""}」会被删除，此操作不可撤销。至少要保留一个视图。`,
    });
    if (!ok) return;
    setOpen(false);
    setBusy(true);
    try {
      await m.deleteView.mutateAsync({ viewId, tableId });
      await qc.invalidateQueries({ queryKey: ["views", tableId] });
      const rest = list.find((v) => v.id !== viewId);
      // 后端保证至少留一个，这里兜底回到列表首项；确实没了就回表首页重定向
      if (rest) goToView(rest.id);
      else navigate(`/base/${baseId}/table/${tableId}`);
    } catch (e) {
      toast((e as Error)?.message ?? "删除视图失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (Date.now() - closedAtRef.current < 250) return;
          setOpen(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 max-w-[220px] items-center gap-1 rounded-gx-lg px-2 text-gx-13 font-semibold text-gx-text-primary hover:bg-gx-bg"
      >
        <Icon name={VIEW_ICON[current?.type ?? "grid"] ?? "grid"} size={15} />
        <span className="truncate">{current?.name ?? "视图"}</span>
        <Icon name="chevronDown" size={13} className="shrink-0 text-gx-text-hint" />
      </button>

      <Popover open={open} onClose={closePopover} align="left">
        <Menu width={220}>
          {list.map((v) => (
            <MenuItem
              key={v.id}
              icon={VIEW_ICON[v.type] ?? "grid"}
              active={v.id === viewId}
              label={
                <span className="flex items-center gap-1">
                  <span className="truncate">{v.name}</span>
                  {v.id === viewId && <Icon name="check" size={12} />}
                </span>
              }
              onClick={() => goToView(v.id)}
            />
          ))}
          {list.length === 0 && (
            <div className="px-3 py-2 text-gx-12 text-gx-text-hint">暂无视图</div>
          )}

          <MenuDivider />

          <MenuItem
            icon="plus"
            label="新建视图"
            disabled={!canManageSchema}
            description={canManageSchema ? undefined : NO_PERMISSION_HINT}
            onClick={openNew}
          />
          <MenuItem
            icon="edit"
            label="重命名当前视图"
            disabled={!canManageSchema}
            description={canManageSchema ? undefined : NO_PERMISSION_HINT}
            onClick={openRename}
          />
          <MenuItem
            icon="trash"
            label="删除当前视图"
            danger
            disabled={!canManageSchema || onlyOne}
            description={
              !canManageSchema
                ? NO_PERMISSION_HINT
                : onlyOne
                  ? "至少保留一个视图"
                  : undefined
            }
            onClick={() => void removeCurrent()}
          />
        </Menu>
      </Popover>

      <Modal
        open={modal !== null}
        title={modal === "new" ? "新建视图" : "重命名视图"}
        onClose={() => setModal(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => void (modal === "new" ? submitNew() : submitRename())}
            >
              {modal === "new" ? "创建" : "保存"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {modal === "new" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-gx-12 text-gx-text-secondary">视图类型</span>
              <div className="flex flex-wrap gap-1.5">
                {VIEW_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={[
                      "flex items-center gap-1.5 rounded-gx-lg border px-2 py-1 text-gx-12",
                      type === t
                        ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                        : "border-gx-border text-gx-text-primary hover:bg-gx-bg",
                    ].join(" ")}
                  >
                    <Icon name={VIEW_ICON[t] ?? "grid"} size={13} />
                    {VIEW_TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-gx-12 text-gx-text-secondary">视图名称</span>
            <Input
              autoFocus
              value={name}
              maxLength={60}
              placeholder="视图名称"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                void (modal === "new" ? submitNew() : submitRename());
              }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default ViewSwitcher;
