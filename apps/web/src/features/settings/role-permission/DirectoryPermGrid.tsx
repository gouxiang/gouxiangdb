// apps/web/src/features/settings/role-permission/DirectoryPermGrid.tsx
// 权限管理 · 下半 (A)：通讯录权限——十三枚动作勾选 + 两条「勾不出来」的硬规则。
//
// 十三枚动作的清单与顺序取自后端真源 ORG_DIRECTORY_ACTIONS，前端不自己排一遍：
// 「面板能勾但后端不认」是权限面最贵的一类 bug，宁可少一个勾选项也不能多一个。

import { useState } from "react";
import { Button, Checkbox } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { toast } from "../../../components/ui";
import { useOrgRoleMutations } from "../../contacts/contacts-hooks";
import type { OrgAction, OrgRoleDTO } from "@gx/shared-types";
import { DIRECTORY_ACTIONS, HARD_RULES, directoryActionHint, directoryActionLabel } from "./labels";

export function DirectoryPermGrid({
  role,
  canEdit,
}: {
  role: OrgRoleDTO;
  canEdit: boolean;
}) {
  const { updateRole } = useOrgRoleMutations();
  const [draft, setDraft] = useState<OrgAction[]>(() => role.actions.filter((a) => DIRECTORY_ACTIONS.includes(a)));

  const toggle = (a: OrgAction, on: boolean) =>
    setDraft((prev) => (on ? [...prev, a] : prev.filter((x) => x !== a)));

  // 面板不渲染的动作（历史粗粒度位 create_library / manage_departments / manage_roles /
  // manage_menu / manage_share）保存时必须原样带上：只提交勾选面板里的动作，会把它们悄悄摘掉
  // ——例如预设「管理员」在这里点一次「保存通讯录权限」，就丢掉 create_library 与 manage_share。
  // 按仓库一贯口径「一枚冗余位 >> 一次无声的能力收回」，一律保守保留。
  const others = role.actions.filter((a) => !DIRECTORY_ACTIONS.includes(a));
  const nextActions = [...others, ...draft];
  const dirty =
    nextActions.length !== role.actions.length || nextActions.some((a) => !role.actions.includes(a));

  async function save() {
    if (!canEdit || !dirty) return;
    try {
      await updateRole.mutateAsync({ id: role.id, data: { actions: nextActions } });
      toast("已保存这个角色的通讯录权限", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败，请重试", "error");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {DIRECTORY_ACTIONS.map((a) => (
          <div key={a} title={directoryActionHint(a)}>
            <Checkbox
              checked={draft.includes(a)}
              disabled={!canEdit}
              onChange={(v) => toggle(a, v)}
              label={<span className="text-gx-13">{directoryActionLabel(a)}</span>}
            />
          </div>
        ))}
      </div>

      <HardRuleNote
        label={HARD_RULES.createLibrary.label}
        who={HARD_RULES.createLibrary.who}
        hint={HARD_RULES.createLibrary.hint}
      />
      <HardRuleNote
        label={HARD_RULES.deleteLibrary.label}
        who={HARD_RULES.deleteLibrary.who}
        hint={HARD_RULES.deleteLibrary.hint}
      />

      {canEdit && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={updateRole.isPending}
            disabled={!dirty}
            disabledReason="还没有任何改动"
            onClick={() => void save()}
          >
            保存通讯录权限
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(role.actions)}>
              撤销改动
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** 硬规则单独成行：看起来像勾选项但实际勾不了，必须写明谁能做，否则管理员会一直找那个开关。 */
function HardRuleNote({ label, who, hint }: { label: string; who: string; hint: string }) {
  return (
    <div
      title={hint}
      className="flex items-center gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg px-3 py-2"
    >
      <Icon name="lock" size={13} className="shrink-0 text-gx-text-hint" />
      <span className="text-gx-13 text-gx-text-tertiary">{label}</span>
      <span className="shrink-0 rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-11 font-medium text-gx-accent">
        {who}
      </span>
      <span className="ml-auto hidden truncate text-gx-11 text-gx-text-hint sm:block">{hint}</span>
    </div>
  );
}
