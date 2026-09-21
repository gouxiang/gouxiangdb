// apps/web/src/features/settings/role-permission/ShareToggleBlock.tsx
// 库级「允许分享」开关 + 「这个库被哪些角色覆盖」只读台账。
//
// 硬规则 C 的落地：开关只对「对该库有管理权的角色 + 超级管理员 + 管理员」出现，
// 其余人连开关都看不到（不是置灰——置灰等于告诉别人这里有个门）。
// 判据不用猜：拿 /libraries/:kind/:id/visibility 返回的角色覆盖表，
// 与「我属于哪些角色」求交，再看我是否属于超级管理员 / 管理员。
// 两端任一没回来（加载中 / 出错）一律按「不能开」处理。
//
// 台账顺带回答「为什么这个人进得来」：超级管理员与管理员不配库视野也能进所有库，
// 不单列人数的话页面会显示「没有任何角色能访问本库」，管理员照着错误结论去补授权。

import { useState } from "react";
import { Icon } from "../../../components/icons";
import { Select, Spinner, Switch, toast } from "../../../components/ui";
import { useRoleScopesShareEnabled, useRoleScopesVisibility } from "../../../api/hooks";
import { HARD_RULES, LIBRARY_KIND_LABEL, SHARE_MODE_HINT } from "./labels";
import { parseScopeKey, useMyRoleRefs } from "./role-permission-hooks";
import type { LibraryRow } from "./library-scope-draft";

export function ShareToggleBlock({ rows }: { rows: LibraryRow[] }) {
  const [value, setValue] = useState("");
  const target = parseScopeKey(value) ?? parseScopeKey(rows[0]?.key ?? "");

  const visQ = useRoleScopesVisibility(target?.kind ?? null, target?.libraryId ?? null);
  const { roleIds, isSuperOrAdmin, isLoading: myLoading } = useMyRoleRefs();
  const toggle = useRoleScopesShareEnabled();

  if (!target) {
    return (
      <p className="text-gx-11 text-gx-text-hint">
        建一个库之后，可以在这里开它的「允许分享」。
      </p>
    );
  }

  const groups = [
    {
      label: LIBRARY_KIND_LABEL.base,
      options: rows.filter((r) => r.kind === "base").map((r) => ({ value: r.key, label: r.name })),
    },
    {
      label: LIBRARY_KIND_LABEL.kb,
      options: rows.filter((r) => r.kind === "kb").map((r) => ({ value: r.key, label: r.name })),
    },
  ].filter((g) => g.options.length > 0);

  const vis = visQ.data ?? null;
  const canToggle =
    !visQ.isLoading && !visQ.isError && !myLoading && !!vis
      ? isSuperOrAdmin || vis.roles.some((r) => r.canManage && roleIds.has(r.roleId))
      : false;

  async function flip(next: boolean) {
    if (!target) return;
    try {
      await toggle.mutateAsync({ kind: target.kind, libraryId: target.libraryId, enabled: next });
      toast(next ? "已允许分享这个库" : "已关闭这个库的分享", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败，可能你没有这个库的分享管理权", "error");
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-gx-lg border border-gx-separator p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gx-12 font-medium text-gx-text-secondary">库级「允许分享」</span>
        <Select
          groups={groups}
          value={value || rows[0]?.key || ""}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 max-w-[16rem]"
          aria-label="选择要开关分享的库"
        />
      </div>

      {visQ.isLoading || myLoading ? (
        <div className="flex items-center gap-2 text-gx-11 text-gx-text-hint">
          <Spinner size={12} />
          正在确认你有没有权限开这个开关…
        </div>
      ) : canToggle && vis ? (
        <div className="flex flex-col gap-1">
          <Switch
            checked={vis.shareEnabled}
            onChange={(v) => void flip(v)}
            label={<span className="text-gx-13">允许把这个库的内容分享出去</span>}
          />
          <p className="text-gx-11 text-gx-text-hint">{SHARE_MODE_HINT}</p>
        </div>
      ) : (
        <div className="flex items-start gap-1.5 text-gx-11 text-gx-text-tertiary">
          <Icon name="lock" size={12} className="mt-0.5 shrink-0" />
          <span>
            {HARD_RULES.share.label}：{HARD_RULES.share.who}才能开。当前登录者不在这个范围内，所以这里没有开关。
          </span>
        </div>
      )}

      {vis && (
        <div className="flex flex-col gap-1 border-t border-gx-separator pt-2">
          <div className="text-gx-11 text-gx-text-secondary">这个库现在谁能进</div>
          <div className="flex flex-wrap gap-1.5">
            <CoverageChip
              icon="crown"
              text={`超级管理员 ${vis.implicitSuperAdminCount} 人（不配也能进）`}
            />
            <CoverageChip icon="shield" text={`管理员 ${vis.implicitAdminCount} 人（不配也能进）`} />
            {vis.roles.map((r) => (
              <CoverageChip
                key={r.roleId}
                icon={r.canManage ? "settings" : "eye"}
                text={`${r.roleName} · ${r.canManage ? "可管理" : "可见"} · ${r.memberCount} 人`}
              />
            ))}
            {vis.roles.length === 0 && (
              <span className="text-gx-11 text-gx-text-hint">还没有任何角色覆盖到这个库。</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageChip({
  icon,
  text,
}: {
  icon: "crown" | "shield" | "settings" | "eye";
  text: string;
}) {
  return (
    <span
      title={text}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-secondary"
    >
      <Icon name={icon} size={11} className="shrink-0 text-gx-text-tertiary" />
      <span className="truncate">{text}</span>
    </span>
  );
}
