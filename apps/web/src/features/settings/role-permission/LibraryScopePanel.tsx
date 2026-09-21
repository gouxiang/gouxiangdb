// apps/web/src/features/settings/role-permission/LibraryScopePanel.tsx
// 权限管理 · 下半 (B)：库权限——可管理库 / 可见库两份多选清单，逐个库细配。
//
// 两条纪律：
//   1. 可管理隐含可见。后端 visible=false 且 canManage=true 时人根本进不去这个库，
//      界面就不该允许勾出「管得了但看不见」这种无法解释的状态。
//   2. 清单里的库 = 「当前登录者看得见的库」∪「这个角色已经被授过的库」。
//      只取前者会让一条已存在的授权从界面上凭空消失（保存时被整份替换掉），
//      等于悄悄收回权限——宁可显示成一个看得到名字的条目也不能让它消失。

import { useState } from "react";
import { Button, Checkbox, EmptyState, Spinner, toast } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { useBases } from "../../../api/hooks";
import { useRoleScopes, useRoleScopesSave } from "../../../api/hooks";
import { useKbList } from "../../kb/kb-hooks";
import type { LibraryKind, OrgRoleDTO } from "@gx/shared-types";
import { LIBRARY_KIND_LABEL } from "./labels";
import { scopeKey } from "./role-permission-hooks";
import { LibraryScopeModal } from "./LibraryScopeModal";
import { ShareToggleBlock } from "./ShareToggleBlock";
import {
  EMPTY_CONFIG,
  draftFromScopes,
  draftToItems,
  type LibraryRow,
  type LibraryScopeDraft,
} from "./library-scope-draft";

export function LibraryScopePanel({ role, canEdit }: { role: OrgRoleDTO; canEdit: boolean }) {
  const scopesQ = useRoleScopes(role.id);
  const basesQ = useBases();
  const kbQ = useKbList();
  const save = useRoleScopesSave();
  const [override, setOverride] = useState<LibraryScopeDraft | null>(null);
  const [editing, setEditing] = useState<LibraryRow | null>(null);

  if (scopesQ.isLoading || basesQ.isLoading || kbQ.isLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  // fail-closed：库视野取不到就不给可勾的框——整份替换的写语义下，
  // 拿一份空清单去保存等于把这个角色的库权限全清掉，比不显示危险得多。
  if (scopesQ.isError) {
    return (
      <EmptyState
        icon="alertCircle"
        title="这个角色的库权限没取到"
        description="界面按「无权限」处理，不显示可勾选项，也不提供保存，避免误清已有授权。"
        action={
          <Button variant="secondary" icon="refresh" onClick={() => void scopesQ.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  const rows: LibraryRow[] = [
    ...(basesQ.data ?? []).map((b) => ({
      key: scopeKey("base", b.id),
      kind: "base" as LibraryKind,
      id: b.id,
      name: b.name,
    })),
    ...(kbQ.data ?? []).map((k) => ({
      key: scopeKey("kb", k.id),
      kind: "kb" as LibraryKind,
      id: k.id,
      name: k.name,
    })),
  ];
  const known = new Set(rows.map((r) => r.key));
  for (const s of scopesQ.data ?? []) {
    const key = scopeKey(s.libraryKind, s.libraryId);
    if (known.has(key)) continue;
    rows.push({
      key,
      kind: s.libraryKind,
      id: s.libraryId,
      name: s.libraryName || "（这个库你现在看不到）",
    });
  }

  const draft = override ?? draftFromScopes(scopesQ.data ?? []);
  const patch = (next: LibraryScopeDraft) => setOverride(next);

  const toggleManage = (key: string, on: boolean) => {
    const manage = new Set(draft.manage);
    const visible = new Set(draft.visible);
    if (on) {
      manage.add(key);
      visible.add(key);
    } else {
      manage.delete(key);
    }
    patch({ ...draft, manage, visible });
  };

  const toggleVisible = (key: string, on: boolean) => {
    const visible = new Set(draft.visible);
    if (on) visible.add(key);
    else visible.delete(key);
    patch({ ...draft, visible });
  };

  async function submit() {
    try {
      await save.mutateAsync({ roleId: role.id, items: draftToItems(draft) });
      setOverride(null);
      toast("已保存这个角色的库权限", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败，请重试", "error");
    }
  }

  const groups: { kind: LibraryKind; items: LibraryRow[] }[] = ([
    { kind: "base", items: rows.filter((r) => r.kind === "base") },
    { kind: "kb", items: rows.filter((r) => r.kind === "kb") },
  ] as { kind: LibraryKind; items: LibraryRow[] }[]).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 ? (
        <EmptyState
          icon="database"
          title="还没有数据库或知识库"
          description="先在一级导航建一个库，再回来给这个角色配它能进哪些库。"
        />
      ) : (
        <div className="flex flex-col gap-3">
          <PickList
            title="可管理库"
            hint="能改这个库的结构、增删改数据、开关分享。勾了可管理就一定能进。"
            picked={draft.manage}
            disabled={!canEdit}
            onToggle={toggleManage}
            groups={groups}
          />
          <PickList
            title="可见库"
            hint="能进这个库。不进一步设置的话，库里全部内容都是只读可见。"
            picked={draft.visible}
            locked={draft.manage}
            disabled={!canEdit}
            onToggle={toggleVisible}
            groups={groups}
            onConfigure={canEdit ? setEditing : undefined}
          />
        </div>
      )}

      <p className="text-gx-11 text-gx-text-hint">
        勾了库但不点「设置」就保存，这个库的全部内容对这个角色是只读可见：能看，不能增、改、删。
      </p>

      {canEdit && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={save.isPending}
            disabled={!override}
            disabledReason="还没有任何改动"
            onClick={() => void submit()}
          >
            保存库权限
          </Button>
          {override && (
            <Button size="sm" variant="ghost" onClick={() => setOverride(null)}>
              撤销改动
            </Button>
          )}
        </div>
      )}

      <ShareToggleBlock rows={rows} />

      {editing && (
        <LibraryScopeModal
          kind={editing.kind}
          libraryId={editing.id}
          libraryName={editing.name}
          config={draft.config.get(editing.key) ?? EMPTY_CONFIG}
          onClose={() => setEditing(null)}
          onSave={(cfg) => {
            const config = new Map(draft.config);
            config.set(editing.key, cfg);
            patch({ ...draft, config });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PickList({
  title,
  hint,
  picked,
  locked,
  disabled,
  onToggle,
  groups,
  onConfigure,
}: {
  title: string;
  hint: string;
  picked: Set<string>;
  /** 这些 key 被别处隐含锁住（可管理隐含可见），不允许单独取消。 */
  locked?: Set<string>;
  disabled: boolean;
  onToggle: (key: string, on: boolean) => void;
  groups: { kind: LibraryKind; items: LibraryRow[] }[];
  onConfigure?: (row: LibraryRow) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-gx-12 font-medium text-gx-text-secondary">{title}</div>
      <p className="text-gx-11 text-gx-text-hint">{hint}</p>
      <div className="max-h-56 overflow-y-auto rounded-gx-lg border border-gx-separator">
        {groups.map((g) => (
          <div key={g.kind}>
            <div className="sticky top-0 bg-gx-bg px-3 py-1 text-gx-11 text-gx-text-tertiary">
              {LIBRARY_KIND_LABEL[g.kind]}
            </div>
            {g.items.map((r) => {
              const on = picked.has(r.key);
              const lockedOn = locked?.has(r.key) ?? false;
              return (
                <div
                  key={r.key}
                  className="flex items-center gap-2 border-t border-gx-separator px-3 py-1.5"
                >
                  <Checkbox
                    checked={on || lockedOn}
                    disabled={disabled || lockedOn}
                    onChange={(v) => onToggle(r.key, v)}
                    label={<span className="text-gx-13">{r.name}</span>}
                  />
                  {onConfigure && on && (
                    <button
                      type="button"
                      onClick={() => onConfigure(r)}
                      className="ml-auto inline-flex items-center gap-1 rounded-gx-lg px-1.5 py-0.5 text-gx-11 text-gx-accent hover:bg-gx-accent-bg"
                    >
                      <Icon name="settings" size={12} />
                      设置
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
