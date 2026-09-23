// apps/web/src/components/CreateLibraryModal.tsx
// 新建库弹窗（名称 + 库类型）：库切换器下拉的「新建库」与一级导航的「新建库」是同一个入口，
// 共用这一份，避免两处各写一套建库逻辑。
// 一级导航曾按类型挂两个按钮（fixedType 锁死），2026-09-20 已合并为一个「新建库」，
// 库类型改由本弹窗内的 TYPE_OPTIONS 二选一。
//
// 后端已在建库/建知识库的同一写事务内写入一级导航的 menu shortcut，故创建成功后只需
// 失效导航查询（menu/tree），左侧立刻出现新库，不再需要手动「收纳到导航」。
// 颜色全走 gx-* token；图标全用 icons.tsx 自建 SVG（无 emoji）。

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useBases, useGXMutations } from "../api/hooks";
import { useCreateKb, useKbList } from "../features/kb/kb-hooks";
import { NAV_QK } from "../features/workspace/nav-hooks";
import {
  findLibraryNameConflict,
  libraryNameConflictMessage,
} from "../features/workspace/lib/library-name";
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
  const basesQ = useBases();
  const kbsQ = useKbList();

  const [name, setName] = useState("");
  const [type, setType] = useState<LibType>(initialType);
  const [creating, setCreating] = useState(false);

  // A4：库名 / 知识库名全局唯一，两类合并判重（新建无自身可排除）。
  const conflict = findLibraryNameConflict(basesQ.data, kbsQ.data, name);

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
    // Enter 提交不经过按钮的 disabled：入口再挡一次（并防御异步列表到达前的旧闭包）。
    const hit = findLibraryNameConflict(basesQ.data, kbsQ.data, name);
    if (!trimmed || hit || creating) return;
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
            disabled={!name.trim() || !!conflict || creating}
            onClick={create}
          >
            创建
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <Input
            autoFocus
            placeholder="库名称，如：客户管理 / 产品资料库"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          {/* 即时重名提示：红字口径同 SecondaryNavTableOps 的行内报错 */}
          {conflict && (
            <p className="px-1 pt-1 text-gx-12 text-gx-danger">
              {libraryNameConflictMessage(conflict)}
            </p>
          )}
        </div>
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
