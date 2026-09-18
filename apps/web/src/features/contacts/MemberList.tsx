// M2/S7 通讯录中栏：成员目录（服务端分页+q/部门/状态过滤，自实现定高行虚拟滚动），选中开编辑抽屉。
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, Input, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { UserAccountStatus } from "@gx/shared-types";
import {
  useDepartments,
  useOrgMembers,
  type MemberFilter,
} from "./contacts-hooks";
import { virtualWindow } from "./lib/tree";
import { STATUS_LABEL, STATUS_ORDER, StatusBadge } from "./contacts-ui";
import { MemberDrawer } from "./MemberDrawer";
import { InviteMemberModal } from "./InviteMemberModal";

const ROW_H = 52;
const OVERSCAN = 8;

export function MemberList({
  filter,
  onFilterChange,
  canManageMembers,
}: {
  filter: MemberFilter;
  onFilterChange: (next: MemberFilter) => void;
  canManageMembers: boolean;
}) {
  const { data: depts } = useDepartments();
  const query = useOrgMembers(filter);
  const [qInput, setQInput] = useState(filter.q);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  // 搜索 300ms 防抖
  useEffect(() => {
    const t = setTimeout(() => onFilterChange({ ...filter, q: qInput }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const selected = useMemo(
    () => query.items.find((m) => m.id === selectedId) ?? null,
    [query.items, selectedId],
  );

  const deptName = useMemo(() => {
    const map = new Map((depts ?? []).map((d) => [d.id, d.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [depts]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(560);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, []);

  // 过滤切换后回到顶部
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filter.q, filter.deptId, filter.status]);

  // 触底自动续拉下一页
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      const el = scrollerRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 6) {
        void query.fetchNextPage();
      }
    }
  });

  const win = virtualWindow(scrollTop, viewportH, ROW_H, query.items.length, OVERSCAN);
  const visibleRows = query.items.slice(win.start, win.end);

  return (
    <div className="relative flex h-full flex-col">
      {/* 工具条 */}
      <div className="border-b border-gx-separator px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gx-text-hint" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="搜索姓名或邮箱…"
              className="h-8 pl-7"
            />
          </div>
          {canManageMembers && (
            <Button size="sm" variant="primary" icon="userPlus" onClick={() => setInviteOpen(true)}>添加</Button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <select
            value={filter.deptId ?? ""}
            onChange={(e) => onFilterChange({ ...filter, deptId: e.target.value || null })}
            className="h-7 max-w-[140px] truncate rounded-gx-lg border border-gx-border bg-gx-surface px-2 text-gx-12 text-gx-text-primary"
          >
            <option value="">全部部门</option>
            {(depts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <div className="inline-flex rounded-gx-lg border border-gx-border bg-gx-surface p-0.5">
            {([null, ...STATUS_ORDER] as (UserAccountStatus | null)[]).map((s) => (
              <button
                key={s ?? "all"}
                type="button"
                onClick={() => onFilterChange({ ...filter, status: s })}
                className={`rounded-gx-sm px-2 py-0.5 text-gx-12 font-medium transition-colors ${
                  filter.status === s ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-tertiary hover:bg-gx-bg"
                }`}
              >
                {s === null ? "全部" : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <span className="ml-auto text-gx-12 text-gx-text-hint">{query.total} 人</span>
        </div>
      </div>

      {/* 虚拟列表 */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>
        ) : query.items.length === 0 ? (
          <EmptyState icon="users" title="没有匹配的成员" description="试试调整搜索关键字或筛选条件" />
        ) : (
          <div style={{ height: win.totalHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${win.padTop}px)` }}>
              {visibleRows.map((m, i) => {
                const idx = win.start + i;
                const mainDept = m.deptMemberships.find((d) => d.isMain)?.departmentId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedId(m.id)}
                    style={{ height: ROW_H }}
                    className={`flex w-full items-center gap-3 border-b border-gx-separator px-3 text-left hover:bg-gx-row-hover ${
                      idx % 2 === 1 ? "bg-gx-zebra" : ""
                    } ${selectedId === m.id ? "bg-gx-accent-bg" : ""}`}
                  >
                    <Avatar name={m.displayName || m.email} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-gx-13 font-medium text-gx-text-primary">{m.displayName}</span>
                        <StatusBadge status={m.status} />
                      </div>
                      <div className="truncate text-gx-12 text-gx-text-tertiary">{m.email}</div>
                    </div>
                    <div className="hidden shrink-0 items-center gap-1 sm:flex">
                      {mainDept && (
                        <span className="max-w-[120px] truncate rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-secondary">
                          {deptName(mainDept)}
                        </span>
                      )}
                      {m.deptMemberships.length > 1 && (
                        <span className="text-gx-11 text-gx-text-hint">+{m.deptMemberships.length - 1}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            {query.isFetchingNextPage && (
              <div className="flex justify-center py-2 text-gx-12 text-gx-text-hint">
                <Spinner size={14} />
              </div>
            )}
          </div>
        )}
      </div>

      {selected && (
        <MemberDrawer
          member={selected}
          canManage={canManageMembers}
          onClose={() => setSelectedId(null)}
        />
      )}

      <InviteMemberModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const ch = (name || "?").charAt(0).toUpperCase();
  // 用 token 体系的中性底 + 首字符，不引头像依赖、不用色值。
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gx-accent-bg text-gx-13 font-semibold text-gx-accent">
      {ch}
    </span>
  );
}
