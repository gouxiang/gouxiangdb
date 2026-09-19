// apps/web/src/components/CreateLibraryModal.tsx
// 新建库弹窗（名称 + 库类型）：库切换器下拉的「新建库」与一级导航的「新建数据库 / 新建知识库」
// 共用这一份，避免两处各写一套建库逻辑。
//
// 后端已在建库/建知识库的同一写事务内写入一级导航的 menu shortcut，故创建成功后只需
// 失效导航查询（menu/tree），左侧立刻出现新库，不再需要手动「收纳到导航」。
// 颜色全走 gx-* token；图标全用 icons.tsx 自建 SVG（无 emoji）。

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useGXMutations } from "../api/hooks";
import { useCreateKb } from "../features/kb/kb-hooks";
import { NAV_QK } from "../features/workspace/nav-hooks";
import { Input, Modal, toast } from "./ui";
import { Icon, type IconName } from "./icons";
import { AVATAR_PALETTE } from "@gx/design-tokens";

export type LibType = "base" | "kb";

function dotColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

const TYPE_OPTIONS: readonly { t: LibType; icon: IconName; title: string; desc: string }[] = [
  { t: "base", icon: "database", title: "智能数据库", desc: "表格 / 视图 / 字段" },
  { t: "kb", icon: "book", title: "知识库", desc: "文档 / 画布" },
];

export function CreateLibraryModal({
  open,
  title = "新建库",
  initialType = "base",
  /** 入口已明确类型时锁死：不渲染「库类型」二选一（一级导航的两个明确入口走这条）。 */
  fixedType = false,
  onClose,
}: {
  open: boolean;
  title?: string;
  initialType?: LibType;
  fixedType?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const m = useGXMutations();
  const createKb = useCreateKb();

  const [name, setName] = useState("");
  const [type, setType] = useState<LibType>(initialType);
  const [creating, setCreating] = useState(false);

  // 每次打开都从干净态开始：类型跟随入口，名称不留上次残值。
  useEffect(() => {
    if (!open) return;
    setName("");
    setType(initialType);
  }, [open, initialType]);

  /** 建库成功即入左侧导航：失效导航查询，不等 staleTime。 */
  const refreshNav = () => {
    void qc.invalidateQueries({ queryKey: NAV_QK.menu });
    void qc.invalidateQueries({ queryKey: NAV_QK.tree });
  };

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      if (type === "base") {
        const b = await m.createBase.mutateAsync({ name: trimmed, iconColor: dotColor(trimmed) });
        refreshNav();
        onClose();
        navigate(`/base/${b.id}`);
      } else {
        const r = await createKb.mutateAsync({ name: trimmed, iconColor: dotColor(trimmed) });
        refreshNav();
        onClose();
        navigate(`/kb/${r.knowledgeBase.id}`);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建库失败", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button
            className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
            disabled={!name.trim() || creating}
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        {fixedType ? null : (
          <div>
            <div className="mb-1.5 text-gx-12 text-gx-text-tertiary">库类型</div>
            <div className="grid grid-cols-2 gap-2">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.t}
                  type="button"
                  onClick={() => setType(opt.t)}
                  className={[
                    "flex flex-col items-start gap-1 rounded-gx-lg border p-3 text-left transition-colors",
                    type === opt.t
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
        )}
      </div>
    </Modal>
  );
}
