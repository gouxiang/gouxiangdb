// apps/web/src/features/grid/ViewSwitcher.tsx
// 视图切换器：**横排选项卡**列出本表全部视图并切换；每个选项卡带竖排「⋯」菜单
// （重命名 / 删除），末尾一个「+」选项卡新建视图。
//
// 形态沿革：最早是 Popover + 下拉列表（挂在网格工具栏最左侧）。下拉的问题是把「当前是哪个视图」
// 和「一共有几个视图」都藏在一层浮层后面，切视图要两步；改成选项卡后一眼可见、一步可达。
//
// 约束：
//  - 删除必须保留至少一个视图（后端也校验，前端同步禁用避免白屏）
//  - 切换 = 导航到 /base/:baseId/table/:tableId/view/:viewId（与全站既有跳转写法一致）
//  - 写操作后 await 视图列表失效再跳转，避免目标视图还没进列表就渲染
//  - 重命名 / 删除 / 新建属**管理类**操作：canManageSchema 为假时入口**不渲染**，
//    不做成灰色 disabled（与 settings/perm-hide-gating.test.ts 同一条红线）
//
// 溢出：选项卡区 `overflow-x-auto` 横向滚动（隐藏滚动条，观感与 shell/ViewTabs 一致）。
// 「+」放在滚动容器**之外**而不是用 sticky：sticky 依赖滚动容器宽度且滚到最右仍会贴边抖动，
// 放在外面则是结构上就永远可见，不必滚到最后才能新建视图。
// 菜单用 Popover 的 fixed + anchorEl 模式 portal 到 body —— 否则会被滚动容器裁掉
// （overflow-x:auto 会让同元素 overflow-y 也变 auto，绝对定位浮层必然被剪裁）。

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useViews, useGXMutations } from "../../api/hooks";
import { type ViewType } from "@gx/shared-types";
import { Icon, VIEW_ICON } from "../../components/icons";
import { confirmIrreversible } from "../../components/feedback";
import { Menu, MenuItem, Popover, toast } from "../../components/ui";
import ViewNameModal from "./ViewNameModal";
import { defaultViewName, nextDefaultViewName } from "./view-default-name";

export interface ViewSwitcherProps {
  baseId: string;
  tableId: string;
  viewId: string;
  canManageSchema: boolean;
}

/** 删除某个视图后，选中态该往哪去（纯函数，便于单测直接覆盖三种情形）。 */
export type ViewAfterDelete =
  | { kind: "stay" } // 删的不是当前视图 → 原地不动
  | { kind: "goto"; viewId: string } // 删的是当前视图 → 迁到相邻位（末位删掉则回退到前一位）
  | { kind: "table" }; // 一个都不剩（后端会拦，这里兜底回表首页）

export function nextViewAfterDelete(
  list: { id: string }[],
  deletedId: string,
  currentId: string,
): ViewAfterDelete {
  if (deletedId !== currentId) return { kind: "stay" };
  const rest = list.filter((v) => v.id !== deletedId);
  if (rest.length === 0) return { kind: "table" };
  const idx = list.findIndex((v) => v.id === deletedId);
  // 取被删项原来的下标：正好是它的后一位；删的是末位时下标越界 → 自动回退到前一位
  const at = Math.min(idx < 0 ? 0 : idx, rest.length - 1);
  return { kind: "goto", viewId: rest[at].id };
}

export function ViewSwitcher({ baseId, tableId, viewId, canManageSchema }: ViewSwitcherProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: views } = useViews(tableId);
  const m = useGXMutations();

  /** 当前展开「⋯」菜单的视图 id */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [modal, setModal] = useState<"new" | "rename" | null>(null);
  /** 重命名目标：可能是非当前视图（从它的「⋯」菜单发起） */
  const [renameId, setRenameId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<ViewType>("grid");
  const [busy, setBusy] = useState(false);
  // 「⋯」触发按钮在浮层之外：mousedown 会先经 Popover 的外部点击把浮层关掉，
  // 紧随其后的 click 再切换就会立刻重新打开（表现为"点了关不掉"），这里记时间做抑制。
  const closedAtRef = useRef(0);
  const closeMenu = () => {
    closedAtRef.current = Date.now();
    setMenuFor(null);
    setAnchorEl(null);
  };

  const list = views ?? [];
  const current = list.find((v) => v.id === viewId);
  const onlyOne = list.length <= 1;

  const goToView = (id: string) => {
    setMenuFor(null);
    setAnchorEl(null);
    navigate(`/base/${baseId}/table/${tableId}/view/${id}`);
  };

  const openNew = () => {
    setType("grid");
    // 默认名跟着类型走（不要写死成「网格视图」：选了看板，名字就得叫「看板视图」）
    setName(defaultViewName("grid"));
    setModal("new");
    closeMenu();
  };

  /** 弹窗里换类型：类型变了默认名跟着变；用户自己改过的名字原样保留。 */
  const pickType = (t: ViewType) => {
    setType(t);
    setName((cur) => nextDefaultViewName(cur, t));
  };

  const openRename = (id: string) => {
    setRenameId(id);
    setName(list.find((v) => v.id === id)?.name ?? "");
    setModal("rename");
    closeMenu();
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
    const targetId = renameId ?? viewId;
    if (!n || busy) return;
    setBusy(true);
    try {
      await m.updateView.mutateAsync({ viewId: targetId, tableId, data: { name: n } });
      setModal(null);
      toast("视图已重命名", "success");
    } catch (e) {
      toast((e as Error)?.message ?? "重命名失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeView(id: string) {
    if (onlyOne || busy) return;
    const target = list.find((v) => v.id === id);
    // R-D-23 L4（不可恢复）+ R-D-24 主按钮必须是具体动词，不用「确定 / 是」
    const ok = await confirmIrreversible({
      title: "删除视图",
      confirmText: "删除视图",
      description: `视图「${target?.name ?? ""}」会被删除，此操作不可撤销。至少要保留一个视图。`,
    });
    if (!ok) return;
    closeMenu();
    setBusy(true);
    try {
      await m.deleteView.mutateAsync({ viewId: id, tableId });
      await qc.invalidateQueries({ queryKey: ["views", tableId] });
      const next = nextViewAfterDelete(list, id, viewId);
      if (next.kind === "goto") goToView(next.viewId);
      // stay：删的是别的视图，当前视图不受影响，不跳转
      else if (next.kind === "table") navigate(`/base/${baseId}/table/${tableId}`);
    } catch (e) {
      toast((e as Error)?.message ?? "删除视图失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center">
      {/* 选项卡区：横向溢出可滚动，滚动条隐藏（与 shell/ViewTabs 同一套观感） */}
      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        style={{ scrollbarWidth: "none" }}
      >
        {list.map((v) => {
          const active = v.id === viewId;
          return (
            <div key={v.id} className="relative flex shrink-0 items-center">
              <button
                type="button"
                data-gx-view-tab={active ? "active" : "idle"}
                aria-current={active ? "page" : undefined}
                title={v.name}
                onClick={() => goToView(v.id)}
                className={[
                  "flex h-7 max-w-[168px] items-center gap-1.5 rounded-gx-lg px-2 text-gx-12 transition-colors",
                  active
                    ? "bg-gx-accent-bg font-medium text-gx-accent"
                    : "text-gx-text-secondary hover:bg-gx-bg",
                ].join(" ")}
              >
                <Icon name={VIEW_ICON[v.type] ?? "grid"} size={13} className="shrink-0" />
                <span className="truncate">{v.name}</span>
              </button>

              {/* 权限口径：重命名 / 删除属管理类操作，无权限即**不渲染**（不是 disabled 假装禁用） */}
              {canManageSchema && (
                <button
                  type="button"
                  data-gx-view-more
                  aria-label={`视图操作：${v.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === v.id}
                  title="重命名 / 删除视图"
                  onClick={(e) => {
                    if (Date.now() - closedAtRef.current < 250) return;
                    if (menuFor === v.id) {
                      closeMenu();
                      return;
                    }
                    setAnchorEl(e.currentTarget);
                    setMenuFor(v.id);
                  }}
                  className="ml-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded-gx-sm text-gx-text-hint hover:bg-gx-bg hover:text-gx-text-primary"
                >
                  <Icon name="moreVertical" size={13} />
                </button>
              )}

              {menuFor === v.id && (
                <Popover open onClose={closeMenu} align="left" width={168} fixed anchorEl={anchorEl}>
                  <Menu width={168}>
                    <MenuItem icon="edit" label="重命名视图" onClick={() => openRename(v.id)} />
                    <MenuItem
                      icon="trash"
                      label="删除视图"
                      danger
                      // onlyOne 是业务规则（至少保留一个视图）不是权限，保留 disabled + 原因
                      disabled={onlyOne}
                      description={onlyOne ? "至少保留一个视图" : undefined}
                      onClick={() => void removeView(v.id)}
                    />
                  </Menu>
                </Popover>
              )}
            </div>
          );
        })}

        {list.length === 0 && (
          <span className="px-1 text-gx-12 text-gx-text-hint">暂无视图</span>
        )}
      </div>

      {/* 新建视图：常驻在滚动容器右侧，视图再多也不用滚到最后 */}
      {canManageSchema && (
        <button
          type="button"
          data-gx-view-new
          aria-label="新建视图"
          title="新建视图"
          onClick={openNew}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-secondary hover:bg-gx-bg hover:text-gx-accent"
        >
          <Icon name="plus" size={14} />
        </button>
      )}

      {/* 新建 / 重命名弹窗：状态在本组件，表单呈现抽到 ViewNameModal（单文件 ≤300 行） */}
      <ViewNameModal
        mode={modal}
        name={name}
        type={type}
        busy={busy}
        onName={setName}
        onType={pickType}
        onClose={() => setModal(null)}
        onSubmit={() => void (modal === "new" ? submitNew() : submitRename())}
      />
    </div>
  );
}

export default ViewSwitcher;
