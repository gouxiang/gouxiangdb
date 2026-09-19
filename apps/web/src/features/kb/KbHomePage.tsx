// apps/web/src/features/kb/KbHomePage.tsx
// /kb/:kbId —— 文档与画布混合列表：类型筛选 + 全文搜索 + 新建 + 行菜单（重命名/权限/删除）。

import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import {
  Badge,
  EmptyState,
  Input,
  Menu,
  MenuItem,
  MenuDivider,
  Modal,
  Popover,
  SegmentedControl,
  Spinner,
  toast,
} from "../../components/ui";
import { EntityIconPicker, resolvedEntityColor, resolveEntityIcon } from "../../components/EntityIconPicker";
import type { KbDocDTO, KbDocKind } from "../../api/client";
import { useKb, useKbDocs, useCreateDoc, useRenameDoc, useDeleteDoc, useRestoreDoc } from "./kb-hooks";
import { DocKindIcon, formatTime, roleLabel } from "./kb-ui";
import { colors } from "@gx/design-tokens";
// 阶段 4：删除统一走 L2 确认 + 撤销 toast（R-D-23 / R-I-08 / R-D-22）
import { confirmSoftDelete } from "../../components/feedback";
import { toastDeleted } from "../../components/interaction";
import { DocAclModal } from "./DocAclModal";

type Filter = "all" | KbDocKind;

export default function KbHomePage() {
  const { kbId } = useParams();
  const navigate = useNavigate();
  const { data: kb } = useKb(kbId);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [renaming, setRenaming] = useState<KbDocDTO | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 行尾「…」菜单：弹层走 Popover 的 fixed（portal 到 body）模式，逃出列表卡片与滚动容器的双重裁剪。
  // ① 卡片本身 overflow-hidden（:197）；② 外层列表又是 overflow-y-auto 滚动容器 —— 只去掉卡片的
  //    overflow-hidden 不够（照样被滚动容器裁），还会让行 hover 背景把卡片圆角切成直角，
  //    所以选 portal 而不是把圆角下沉到首末行。
  // fixed 模式的锚点必须指向触发按钮，否则回退到弹层父元素、坐标会偏。
  const rowMenuRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // 触发按钮在浮层之外：mousedown 先经 Popover 的外部点击把菜单关掉，紧随的 click 再切换就会
  // 立刻重新打开（表现为"点了关不掉"）。记时间做抑制，与 ViewSwitcher 同一套写法。
  const menuClosedAtRef = useRef(0);
  const closeRowMenu = () => {
    menuClosedAtRef.current = Date.now();
    setMenuFor(null);
  };
  const [aclFor, setAclFor] = useState<KbDocDTO | null>(null);
  // 文档/画布「图标与颜色」入口的下标：存 id 而非快照，改完 invalidation 回来即时跟着变
  const [iconFor, setIconFor] = useState<string | null>(null);

  const { data: docs, isLoading } = useKbDocs(kbId, filter, debouncedQ);
  const createDoc = useCreateDoc(kbId!);
  const deleteDoc = useDeleteDoc(kbId!);
  const restoreDoc = useRestoreDoc(kbId!);
  // 重命名目标变化时，mutation 闭包跟随最新 docId（hook 始终调用，仅参数变化）
  const renameDoc = useRenameDoc(renaming?.id ?? "__none__", kbId ?? "__none__");
  const renameIconDoc = useRenameDoc(iconFor ?? "__none__", kbId ?? "__none__");
  // 图标面板绑定的文档：从列表按 id 取，避免快照过期
  const iconDocEntity = (docs ?? []).find((d) => d.id === iconFor) ?? null;


  // 搜索输入防抖
  const [qt, setQt] = useState<ReturnType<typeof setTimeout> | null>(null);
  function onSearch(v: string) {
    setQ(v);
    if (qt) clearTimeout(qt);
    setQt(setTimeout(() => setDebouncedQ(v.trim()), 250));
  }

  const canCreate = useMemo(() => {
    const r = kb?.role ?? "owner";
    return r === "owner" || r === "editor";
  }, [kb?.role]);

  async function create(kind: KbDocKind) {
    if (!kbId || createDoc.isPending) return;
    try {
      const r = await createDoc.mutateAsync({ kind, title: kind === "canvas" ? "未命名画布" : "未命名文档" });
      const d = r.doc;
      navigate(kind === "canvas" ? `/kb/${kbId}/canvas/${d.id}` : `/kb/${kbId}/doc/${d.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建失败", "error");
    }
  }

  function openRename(d: KbDocDTO) {
    setMenuFor(null);
    setRenaming(d);
    setRenameVal(d.title);
  }

  async function submitRename() {
    if (!renaming || !renameVal.trim() || renameDoc.isPending) return;
    try {
      await renameDoc.mutateAsync(renameVal.trim());
      toast("已重命名", "success");
      setRenaming(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  // 阶段 4：删除确认改走 feedback.tsx 的 L2（与 KbTree 同一套文案与分级），
  // 并补齐 R-I-08 要求的撤销 toast——此前这里删完既无撤销也无与树一致的确认口径。
  async function doDelete(d: KbDocDTO) {
    const ok = await confirmSoftDelete({
      title: `删除「${d.title}」`,
      confirmText: "删除并移入回收站",
      description: "文档会移入回收站，30 天内可恢复；下级文档会一并保留在回收站。",
    });
    if (!ok) return;
    try {
      await deleteDoc.mutateAsync(d.id);
      toastDeleted({
        message: `已移入回收站「${d.title}」`,
        restoredMessage: `已恢复「${d.title}」`,
        onUndo: () => restoreDoc.mutateAsync(d.id),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  function openDoc(d: KbDocDTO) {
    navigate(d.kind === "canvas" ? `/kb/${kbId}/canvas/${d.id}` : `/kb/${kbId}/doc/${d.id}`);
  }

  return (
    <div className="flex h-full flex-col bg-gx-bg">
      {/* 顶部标题 + 操作 */}
      <div className="border-b border-gx-separator bg-gx-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* 库头图标：未自定义（icon 为空）时仍是 accent 色 book，与改动前一致 */}
            <Icon
              name={resolveEntityIcon(kb, { name: "book" }).name}
              size={18}
              className="text-gx-accent"
              style={resolvedEntityColor(kb) ? { color: resolvedEntityColor(kb) } : undefined}
            />
            <h1 className="text-gx-16 font-semibold text-gx-text-primary">{kb?.name ?? "知识库"}</h1>
            {kb?.role && <Badge variant="soft">{roleLabel(kb.role)}</Badge>}
          </div>
          {/* 权限治理第二批：新建文档/画布是内容创建的管理类入口，无权限即不渲染
              （不是 disabled 假装禁用——看不到入口才不会误以为功能坏了）。 */}
          {canCreate && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => create("doc")}
                className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-3 text-gx-13 text-gx-text-primary hover:bg-gx-bg"
              >
                <Icon name="doc" size={15} className="text-gx-accent" />
                新建文档
              </button>
              <button
                type="button"
                onClick={() => create("canvas")}
                className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95"
              >
                <Icon name="canvas" size={15} />
                新建画布
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="relative w-72">
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gx-text-hint" />
            <Input
              value={q}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="搜索文档内容 / 画布节点文本"
              className="pl-8"
            />
          </div>
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "doc", label: "文档" },
              { value: "canvas", label: "画布" },
            ]}
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="flex justify-center py-20"><Spinner size={22} /></div>
        ) : (docs ?? []).length === 0 ? (
          // R-D-13/14：搜索无结果走「筛选空态」（带清除筛选），首次为空走「首次空态」
          <EmptyState
            icon="doc"
            kind={debouncedQ ? "filtered" : "first"}
            title={debouncedQ ? undefined : "还没有内容"}
            description={debouncedQ ? undefined : "新建一篇 Markdown 文档或一张流程图画布开始"}
            onClearFilters={debouncedQ ? () => onSearch("") : undefined}
          />
        ) : (
          <div className="overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface">
            {(docs ?? []).map((d, idx) => (
              <div
                key={d.id}
                className={[
                  "group flex items-center gap-3 px-3 py-2.5 hover:bg-gx-row-hover",
                  idx !== 0 ? "border-t border-gx-separator" : "",
                ].join(" ")}
              >
                <button type="button" onClick={() => openDoc(d)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <DocKindIcon kind={d.kind} size={16} icon={d.icon} iconColor={d.iconColor} />
                  <span className="truncate text-gx-13 text-gx-text-primary">{d.title || "未命名"}</span>
                </button>
                <span className="hidden text-gx-11 text-gx-text-hint sm:block">
                  {d.kind === "canvas" ? "画布" : "文档"} · 更新于 {formatTime(d.updatedAt)}
                </span>
                {d.myRole && d.myRole !== "owner" && <Badge variant="soft">{roleLabel(d.myRole)}</Badge>}
                <span className="relative">
                  <button
                    type="button"
                    // P3-a11y：KB 列表行尾纯图标菜单，按行类型给具体作用名
                    aria-label={`${d.title || "未命名"} ${d.kind === "canvas" ? "画布操作菜单" : "文档操作菜单"}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === d.id}
                    title={d.kind === "canvas" ? "画布操作菜单" : "文档操作菜单"}
                    ref={(el) => {
                      rowMenuRefs.current[d.id] = el;
                    }}
                    onClick={() => {
                      // 抑制「mousedown 关闭 → click 又打开」导致的点了关不掉
                      if (Date.now() - menuClosedAtRef.current < 250) return;
                      setMenuFor(menuFor === d.id ? null : d.id);
                    }}
                    className="rounded p-1 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
                  >
                    <Icon name="more" size={15} />
                  </button>
                  <Popover
                    open={menuFor === d.id}
                    onClose={closeRowMenu}
                    align="right"
                    width={190}
                    fixed
                    anchorEl={rowMenuRefs.current[d.id] ?? null}
                  >
                    <Menu width={190}>
                      <MenuItem icon="edit" label="重命名" onClick={() => openRename(d)} />
                      {canCreate && (
                        <MenuItem
                          icon="palette"
                          label="图标与颜色"
                          onClick={() => {
                            setMenuFor(null);
                            setIconFor(d.id);
                          }}
                        />
                      )}
                      <MenuItem icon="lock" label="独立权限" onClick={() => { setMenuFor(null); setAclFor(d); }} />
                      <MenuDivider />
                      <MenuItem icon="trash" label="删除" danger onClick={() => { setMenuFor(null); void doDelete(d); }} />
                    </Menu>
                  </Popover>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 重命名 */}
      <Modal
        open={!!renaming}
        title={`重命名${renaming?.kind === "canvas" ? "画布" : "文档"}`}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setRenaming(null)}>
              取消
            </button>
            <button
              className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
              disabled={!renameVal.trim()}
              onClick={submitRename}
            >
              保存
            </button>
          </>
        }
      >
        <Input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitRename()} />
      </Modal>

      {/* 图标与颜色（文档/画布）：选完即时生效，不走「保存」 */}
      <Modal
        open={!!iconDocEntity}
        title={`${iconDocEntity?.kind === "canvas" ? "画布" : "文档"}图标与颜色`}
        onClose={() => setIconFor(null)}
        footer={
          <button
            className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
            onClick={() => setIconFor(null)}
          >
            完成
          </button>
        }
      >
        {iconDocEntity && (
          <div className="flex items-center gap-3">
            <EntityIconPicker
              icon={iconDocEntity.icon ?? null}
              iconColor={iconDocEntity.iconColor ?? null}
              defaultIcon={iconDocEntity.kind === "canvas" ? "canvas" : "doc"}
              defaultColor={iconDocEntity.kind === "canvas" ? colors.secondaryAlt : colors.accent}
              onChange={(next) => renameIconDoc.mutateAsync({ icon: next.icon, iconColor: next.iconColor })}
            />
            <span className="text-gx-12 text-gx-text-hint">
              选择后立即生效；「恢复默认」清除自定义图标与颜色。
            </span>
          </div>
        )}
      </Modal>

      {/* 独立权限 */}
      {aclFor && <DocAclModal doc={aclFor} onClose={() => setAclFor(null)} />}
    </div>
  );
}
