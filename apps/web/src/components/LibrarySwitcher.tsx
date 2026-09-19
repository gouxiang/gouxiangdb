// apps/web/src/components/LibrarySwitcher.tsx
// 统一库切换器：一份菜单集中展示全部「智能数据库」与「知识库」，支持搜索过滤、直接切换，
// 底部「新建库」弹窗一次填写名称 + 库类型（数据库 / 知识库）。
// 数据表侧栏（Sidebar）与知识库侧栏（KbSidebar）共用本组件，消除两套切换器的割裂感。
// 颜色全走 gx-* token；图标全用自建 SVG（无 emoji）。

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBases, useGXMutations } from "../api/hooks";
import { useKbList, useCreateKb } from "../features/kb/kb-hooks";
import { Input, Menu, MenuItem, MenuDivider, Modal, Popover, toast } from "./ui";
import { Icon, type IconName } from "./icons";
import { entityIconColor, isEntityIconDefault, resolveEntityIcon } from "./EntityIconPicker";
import { AVATAR_PALETTE, colors } from "@gx/design-tokens";

export type ActiveLibrary =
  | { kind: "base"; id: string | null }
  | { kind: "kb"; id: string | null };

function dotColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

type LibType = "base" | "kb";

export function LibrarySwitcher({ active }: { active: ActiveLibrary }) {
  const navigate = useNavigate();
  const { data: bases } = useBases();
  const { data: kbs } = useKbList();
  const m = useGXMutations();
  const createKb = useCreateKb();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<LibType>("base");
  const [creating, setCreating] = useState(false);

  const q = query.trim().toLowerCase();
  const filteredBases = useMemo(
    () => (bases ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)),
    [bases, q],
  );
  const filteredKbs = useMemo(
    () => (kbs ?? []).filter((k) => !q || k.name.toLowerCase().includes(q)),
    [kbs, q],
  );

  const currentName =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id)?.name ?? null
      : kbs?.find((k) => k.id === active.id)?.name ?? null;
  const currentColor =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id)?.iconColor ?? colors.textTertiary
      : kbs?.find((k) => k.id === active.id)?.iconColor ?? colors.accent;

  /**
   * 切换器头部：默认仍是「圆点」（未自定义时逐像素保持原样）；
   * 实体自定义了【图标】才换成图标渲染，颜色取自定义色（未设色时用各类型的既有默认色）。
   */
  const currentEntity =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id) ?? null
      : kbs?.find((k) => k.id === active.id) ?? null;
  const currentCustomized = !isEntityIconDefault(currentEntity);
  const currentResolved = resolveEntityIcon(currentEntity, {
    name: active.kind === "base" ? "database" : "book",
    color: currentColor,
  });

  async function create() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      if (newType === "base") {
        const b = await m.createBase.mutateAsync({ name, iconColor: dotColor(name) });
        setShowNew(false);
        setNewName("");
        setOpen(false);
        navigate(`/base/${b.id}`);
      } else {
        const r = await createKb.mutateAsync({ name, iconColor: dotColor(name) });
        setShowNew(false);
        setNewName("");
        setOpen(false);
        navigate(`/kb/${r.knowledgeBase.id}`);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建库失败", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left hover:bg-gx-row-hover"
      >
        {currentCustomized ? (
          <Icon
            name={currentResolved.name}
            size={14}
            className="shrink-0"
            style={currentResolved.color ? { color: currentResolved.color } : undefined}
          />
        ) : (
          <span
            className="h-4 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: currentColor }}
          />
        )}
        <span className="flex-1 truncate text-gx-13 font-medium text-gx-text-primary">
          {currentName ?? "选择库"}
        </span>
        <Icon name="chevronDown" size={14} className="text-gx-text-tertiary" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={264}>
        <div className="p-2">
          <Input
            autoFocus
            placeholder="搜索数据库 / 知识库"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Menu width={264}>
          <div className="max-h-[60vh] overflow-y-auto">
            {filteredBases.length > 0 && (
              <>
                <div className="px-3 py-1 text-gx-11 font-medium text-gx-text-hint">智能数据库</div>
                {filteredBases.map((b) => (
                  <MenuItem
                    key={`b-${b.id}`}
                    // 库切换器下拉：读实体自定义图标 + 自定义色（修掉原来写死 database 且丢色）
                    icon={resolveEntityIcon(b, { name: "database" }).name}
                    iconColor={entityIconColor(b)}
                    label={b.name}
                    active={active.kind === "base" && b.id === active.id}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/base/${b.id}`);
                    }}
                  />
                ))}
              </>
            )}

            {filteredKbs.length > 0 && (
              <>
                <div className="mt-1 px-3 py-1 text-gx-11 font-medium text-gx-text-hint">知识库</div>
                {filteredKbs.map((k) => (
                  <MenuItem
                    key={`k-${k.id}`}
                    icon={resolveEntityIcon(k, { name: "book" }).name}
                    iconColor={entityIconColor(k)}
                    label={k.name}
                    active={active.kind === "kb" && k.id === active.id}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/kb/${k.id}`);
                    }}
                  />
                ))}
              </>
            )}

            {filteredBases.length === 0 && filteredKbs.length === 0 && (
              <div className="px-3 py-2 text-gx-12 text-gx-text-hint">没有匹配的库</div>
            )}
          </div>
          <MenuDivider />
          <MenuItem icon="plus" label="新建库" onClick={() => { setOpen(false); setShowNew(true); }} />
        </Menu>
      </Popover>

      <Modal
        open={showNew}
        title="新建库"
        onClose={() => setShowNew(false)}
        footer={
          <>
            <button
              className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
              onClick={() => setShowNew(false)}
            >
              取消
            </button>
            <button
              className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
              disabled={!newName.trim() || creating}
              onClick={create}
            >
              创建
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="库名称，如：客户管理 / 产品资料库"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <div>
            <div className="mb-1.5 text-gx-12 text-gx-text-tertiary">库类型</div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { t: "base" as LibType, icon: "database" as IconName, title: "智能数据库", desc: "表格 / 视图 / 字段" },
                { t: "kb" as LibType, icon: "book" as IconName, title: "知识库", desc: "文档 / 画布" },
              ]).map((opt) => (
                <button
                  key={opt.t}
                  type="button"
                  onClick={() => setNewType(opt.t)}
                  className={[
                    "flex flex-col items-start gap-1 rounded-gx-lg border p-3 text-left transition-colors",
                    newType === opt.t
                      ? "border-gx-accent bg-gx-accent-bg"
                      : "border-gx-border bg-gx-surface hover:bg-gx-bg",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-1.5 text-gx-13 font-medium text-gx-text-primary">
                    <Icon name={opt.icon} size={15} className="text-gx-accent" />
                    {opt.title}
                  </span>
                  <span className="text-gx-11 text-gx-text-hint">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
