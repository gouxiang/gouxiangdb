// apps/web/src/features/kb/KbSettingsPage.tsx
// /kb/:kbId/settings —— 知识库自身的信息设置：名称 + 实体图标与颜色。
//
// 权限口径（不要再加回来）：成员与权限区已移除 —— 全站唯一的权限配置入口是
// 「工作区设置 → 权限管理」，那里按库逐个管成员与分享。本页只保留与这个知识库
// 自身属性相关的设置，避免出现「两处都能改成员」的口径分裂。
// 单文档/画布的独立权限仍在内容列表与编辑器中按条目管理（DocAclModal），不受影响。

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Input, toast } from "../../components/ui";
import { EntityIconPicker } from "../../components/EntityIconPicker";
import { LibraryAccessPanel } from "../settings/MembersPanel";
import { useKb, useUpdateKb } from "./kb-hooks";

export default function KbSettingsPage() {
  const { kbId } = useParams();
  const navigate = useNavigate();
  const { data: kb } = useKb(kbId);
  const updateKb = useUpdateKb(kbId!);

  const [name, setName] = useState(kb?.name ?? "");

  const myRole = kb?.role ?? "owner";
  const isOwner = myRole === "owner";

  // 知识库加载 / 切库 / 他人改名后同步名称输入
  useEffect(() => {
    if (kb) setName(kb.name);
  }, [kb]);

  async function saveKb() {
    if (!kbId || !isOwner || !name.trim()) return;
    try {
      await updateKb.mutateAsync({ name: name.trim() });
      toast("已保存", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error");
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-gx-bg">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <div className="mb-5 flex items-center gap-2">
          <Icon name="settings" size={18} className="text-gx-accent" />
          <h1 className="text-gx-16 font-semibold text-gx-text-primary">知识库设置</h1>
          <span className="text-gx-12 text-gx-text-hint">{kb?.name}</span>
        </div>

        {/* 上传限制已上提到工作区设置：它对本机浏览器内的全部知识库生效，
            不是单个知识库的属性——这里只留说明 + 跳转，避免用户以为能按库分别设限。 */}
        <div className="mb-4 flex items-start gap-2 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3">
          <Icon name="paperclip" size={16} className="mt-0.5 shrink-0 text-gx-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-gx-13 font-medium text-gx-text-primary">上传限制</div>
            <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
              上传限制对这台浏览器里的全部知识库生效，不属于单个知识库，已移到「工作区设置 → 通用」统一管理。
            </p>
            <button
              type="button"
              onClick={() => navigate("/workspace/settings/general")}
              className="mt-2 inline-flex items-center gap-1.5 rounded-gx-lg border border-gx-border px-2.5 py-1 text-gx-12 text-gx-text-primary hover:bg-gx-row-hover"
            >
              <Icon name="external" size={13} />
              前往工作区设置修改
            </button>
          </div>
        </div>

        {/* 基本信息：名称 + 实体图标与颜色（图标/选色即时写库，失败由 EntityIconPicker toast） */}
        <div className="mb-4 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3">
          <div className="mb-2 text-gx-13 font-medium text-gx-text-primary">基本信息</div>
          <div className="flex items-center gap-3">
            <EntityIconPicker
              icon={kb?.icon ?? null}
              iconColor={kb?.iconColor ?? null}
              defaultIcon="book"
              ariaLabel="知识库图标与颜色"
              readOnly={!isOwner}
              onChange={(next) =>
                // iconColor 原样透传（含 null = 恢复默认色）。旧注释「后端 z.string().optional()」
                // 已过时：后端改 entityIconColorSchema 后接受 null，并对 NOT NULL 的
                // knowledge_bases.iconColor 列映射成系统默认色 #0F6E56。
                updateKb.mutateAsync({ icon: next.icon, iconColor: next.iconColor })
              }
            />
            <Input
              value={name}
              disabled={!isOwner}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKb()}
              className="flex-1"
              aria-label="知识库名称"
            />
            {isOwner && (
              <button
                type="button"
                disabled={!name.trim() || name.trim() === kb?.name}
                onClick={saveKb}
                className="inline-flex h-8 items-center rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-40"
              >
                保存
              </button>
            )}
          </div>
          <p className="mt-2 text-gx-11 text-gx-text-hint">
            图标与颜色选择后立即生效，名称需点「保存」；「恢复默认」清除自定义图标。
          </p>
        </div>

        {/* 成员与权限的**编辑**面已统一收敛到「工作区设置 → 权限管理」；
            这里只留一份只读台账 + 本知识库的「允许分享」开关（组件自带前往权限管理的入口）。 */}
        {kbId && <LibraryAccessPanel kind="kb" libraryId={kbId} />}
      </div>
    </div>
  );
}
