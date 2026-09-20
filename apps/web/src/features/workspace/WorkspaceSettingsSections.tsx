// apps/web/src/features/workspace/WorkspaceSettingsSections.tsx
// 工作区设置里两个「实体列表型」分区：资产入口、回收站聚合入口。
// 拆出本文件是为了让 WorkspaceSettingsPage 只剩「分区调度 + 布局」，
// 同时避免两个分区各抄一遍「加载 / 空态 / 行按钮」的模板代码。

import { useNavigate } from "react-router-dom";
import { useBases } from "../../api/hooks";
import { useKbList } from "../kb/kb-hooks";
import { EmptyState, Spinner } from "../../components/ui";
import {
  resolvedEntityColor,
  resolveEntityIcon,
  type EntityIconValue,
} from "../../components/EntityIconPicker";
import { Icon, type IconName } from "../../components/icons";

type LinkEntity = EntityIconValue & { id: string; name: string };

function EntityLinkList({
  rows,
  fallbackIcon,
  rowLabel,
  onOpen,
}: {
  rows: LinkEntity[];
  fallbackIcon: IconName;
  /** 读屏/悬停说明这一行点进去是什么，避免只剩一个裸名字 */
  rowLabel: (name: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-gx-separator rounded-gx-lg border border-gx-separator">
      {rows.map((e) => {
        const color = resolvedEntityColor(e);
        return (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onOpen(e.id)}
              title={rowLabel(e.name)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-gx-13 hover:bg-gx-row-hover"
            >
              {/* 行图标：读实体自定义图标（未自定义时回落到 fallbackIcon + tertiary 色） */}
              <Icon
                name={resolveEntityIcon(e, { name: fallbackIcon }).name}
                size={15}
                className="shrink-0 text-gx-text-tertiary"
                style={color ? { color } : undefined}
              />
              <span className="min-w-0 flex-1 truncate text-gx-text-primary">{e.name}</span>
              <Icon name="chevronRight" size={14} className="shrink-0 text-gx-text-hint" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EntityGroup({
  title,
  loading,
  rows,
  fallbackIcon,
  emptyIcon,
  emptyTitle,
  emptyDesc,
  rowLabel,
  onOpen,
}: {
  title: string;
  loading: boolean;
  rows: LinkEntity[];
  fallbackIcon: IconName;
  emptyIcon: IconName;
  emptyTitle: string;
  emptyDesc: string;
  rowLabel: (name: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-gx-13 font-medium text-gx-text-primary">{title}</h3>
      {loading ? (
        <Spinner size={16} />
      ) : rows.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDesc} />
      ) : (
        <EntityLinkList rows={rows} fallbackIcon={fallbackIcon} rowLabel={rowLabel} onOpen={onOpen} />
      )}
    </section>
  );
}

// 「资产」分区已移除（AssetsSection 随之删除）：单个库/知识库的深度设置改由
// 一级导航条目行尾的「…」菜单进入（重命名 / 设置），设置里不再重复列一份入口。

/** 回收站聚合入口：库回收站 / 知识库回收站都从这里进（各资产侧边的就近入口保留不动）。 */
export function TrashSection() {
  const navigate = useNavigate();
  const { data: bases, isLoading: loadingBases } = useBases();
  const { data: kbs, isLoading: loadingKb } = useKbList();

  return (
    <div className="flex flex-col gap-6">
      <EntityGroup
        title="数据库回收站"
        loading={loadingBases}
        rows={bases ?? []}
        fallbackIcon="database"
        emptyIcon="trash"
        emptyTitle="暂无数据库"
        emptyDesc="删除的数据表、字段与记录会进入对应数据库的回收站。"
        rowLabel={(n) => `打开「${n}」的回收站`}
        onOpen={(id) => navigate(`/base/${id}/trash`)}
      />
      <EntityGroup
        title="知识库回收站"
        loading={loadingKb}
        rows={kbs ?? []}
        fallbackIcon="book"
        emptyIcon="trash"
        emptyTitle="暂无知识库"
        emptyDesc="删除的文档与画布会进入对应知识库的回收站。"
        rowLabel={(n) => `打开「${n}」的回收站`}
        onOpen={(id) => navigate(`/kb/${id}/trash`)}
      />
      <p className="text-gx-11 text-gx-text-hint">
        这里只是聚合入口；数据库与知识库侧边栏各自的「回收站」就近入口继续保留。
      </p>
    </div>
  );
}
