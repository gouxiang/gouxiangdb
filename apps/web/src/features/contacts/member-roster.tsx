// apps/web/src/features/contacts/member-roster.tsx
// 「成员字段」复用件：成员名册 hook + 头像/名字展示 + 成员选择编辑器。
// 数据源唯一＝组织通讯录 useOrgMembers；成员字段把 userId 存进 records.fields JSON，
// 故此处只做「userId -> 展示信息」的前端映射，不新增请求、不动后端存储。
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { CURRENT_USER_SENTINEL } from "@gx/shared-types";
import { useOrgMembers } from "./contacts-hooks";
import { Input, Popover, Spinner } from "../../components/ui";
import { DropdownSelect } from "../../components/settings-controls";

export interface RosterMember {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

/**
 * 取在岗成员名册（首屏一页 100 人）。通讯录以 view_directory 门控，
 * 无该动作时拿到空列表（fail-closed），成员选择器随之无候选。
 */
export function useMemberRoster() {
  const q = useOrgMembers({ q: "", deptId: null, status: "ACTIVE" });
  const members = useMemo<RosterMember[]>(
    () =>
      (q.isError ? [] : q.items).map((m) => ({
        id: m.id,
        displayName: m.displayName || m.email || "成员",
        email: m.email,
        avatarUrl: m.avatarUrl,
      })),
    [q.items, q.isError],
  );
  const byId = useMemo(() => {
    const map = new Map<string, RosterMember>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);
  return { members, byId, isLoading: q.isLoading };
}

/** 单个成员的圆形头像（有头像显头像，否则显姓名首字）。 */
export function MemberAvatar({
  member,
  size = 22,
}: {
  member: RosterMember | null;
  size?: number;
}) {
  const s = { width: size, height: size, fontSize: size * 0.5 };
  if (member?.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt=""
        style={s}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={s}
      className="flex shrink-0 items-center justify-center rounded-full bg-gx-accent font-medium text-white"
    >
      {(member?.displayName ?? "?").charAt(0)}
    </span>
  );
}

/** 成员字段只读展示：头像 + 名字；userId 不在名册（停用/无权限）时兜底显短 id。 */
export function MemberDisplay({
  userId,
  byId,
}: {
  userId: unknown;
  byId: Map<string, RosterMember>;
}) {
  if (typeof userId !== "string" || !userId) {
    return <span className="text-gx-13 text-gx-text-hint">—</span>;
  }
  const member = byId.get(userId) ?? null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <MemberAvatar member={member} />
      <span className="truncate text-gx-13 text-gx-text-primary">
        {member?.displayName ?? userId.slice(0, 8)}
      </span>
    </span>
  );
}

/**
 * 成员选择编辑器（单元格 / 抽屉共用）。
 * 单值：选中即提交；可清除。搜索在首屏名册内本地过滤。
 */
export function MemberSelect({
  value,
  members,
  isLoading,
  onCommit,
  onCancel,
}: {
  value: CellValueLike;
  members: RosterMember[];
  isLoading: boolean;
  onCommit: (userId: string | null) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const kw = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      kw
        ? members.filter(
            (m) =>
              m.displayName.toLowerCase().includes(kw) ||
              m.email.toLowerCase().includes(kw),
          )
        : members,
    [members, kw],
  );
  const current = typeof value === "string" ? value : "";

  return (
    <Popover open onClose={onCancel} width={280} className="p-2">
      <Input
        autoFocus
        placeholder="搜索成员姓名或邮箱"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="mb-1"
      />
      <div className="max-h-56 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-gx-12 text-gx-text-hint">
            <Spinner size={14} />
            <span>加载中…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-1 py-3 text-center text-gx-12 text-gx-text-hint">
            无匹配成员
          </div>
        ) : (
          filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onCommit(m.id === current ? null : m.id)}
              className={clsx(
                "flex w-full items-center gap-2 rounded-gx-sm px-1.5 py-1.5 text-left hover:bg-gx-bg",
                m.id === current && "bg-gx-accent-bg",
              )}
            >
              <MemberAvatar member={m} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-gx-13 text-gx-text-primary">
                  {m.displayName}
                </span>
                {m.email && (
                  <span className="block truncate text-gx-11 text-gx-text-hint">
                    {m.email}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-gx-separator pt-1.5">
        <span className="text-gx-11 text-gx-text-hint">单选成员</span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-gx-sm px-2 py-0.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onCommit(null)}
            className="rounded-gx-sm px-2 py-0.5 text-gx-12 text-gx-danger hover:bg-gx-danger-bg"
          >
            清除
          </button>
        </div>
      </div>
    </Popover>
  );
}

type CellValueLike = unknown;

/**
 * 成员字段「默认内容 → 自定义」专用的平铺选择器（与单元格里的 MemberSelect 不同：
 * 设置面板是内嵌表单控件，不能自带 Popover）。
 *
 * 首项是动态的「当前用户」——建记录时落到实际操作人头上，特别适合「负责人默认是我」这类场景；
 * 其后是在岗成员名册，选中的是 userId（与成员字段的存储口径一致）。
 */
export function MemberDefaultValueSelect({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (userId: string) => void;
}) {
  const { members, byId } = useMemberRoster();
  const current = typeof value === "string" ? value : "";
  const currentName = current === CURRENT_USER_SENTINEL
    ? "当前用户"
    : (byId.get(current)?.displayName ?? "");
  const options = [
    { value: CURRENT_USER_SENTINEL, label: "当前用户（谁新建记录就填谁）" },
    ...members.map((m) => ({ value: m.id, label: m.displayName })),
  ];
  return (
    <div className="flex flex-col gap-1">
      <DropdownSelect
        value={current}
        options={options}
        onChange={(v) => onChange(v)}
        placeholder="选择默认成员"
      />
      {!current && (
        <p className="text-gx-11 text-gx-text-hint">未选择时，新建记录的该成员字段留空。</p>
      )}
      {current === CURRENT_USER_SENTINEL && (
        <p className="text-gx-11 text-gx-text-hint">每次新建记录时，自动填入创建者本人。</p>
      )}
      {current && current !== CURRENT_USER_SENTINEL && currentName && (
        <p className="text-gx-11 text-gx-text-hint">固定填入：{currentName}</p>
      )}
    </div>
  );
}
