// 窄屏记录卡片列表（UI-SPEC v1.0 R-D-32 / R-D-33）。
//
// 768–1023 档规范明确「表格转卡片列表」，<768 沿用单栏卡片：表格在 <1024 必然横向溢出，
// 而卡片把每条记录压成一竖块（主字段当标题、其余字段「字段名：值」逐行），
// 单栏宽度下不横滚、不竖排断行。点击卡片即展开记录（与桌面行点击同语义）。
//
// 功能口径：勾选（批量选择）、展开记录、行颜色、分组标题、加载更多都在卡片态保留，
// 只**换呈现形态**，不删任何能力。

import { clsx } from "clsx";
import type { FieldDTO, GroupBucketDTO, LinkRefDTO, RecordDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { formatCell } from "../cells/format";

/** 卡片上除主字段外最多展示的字段行数（超出折叠，避免卡片过长）。 */
const MAX_META_FIELDS = 4;

export interface RecordCardListProps {
  records: RecordDTO[];
  fields: FieldDTO[];
  /** 主字段：作为卡片标题 */
  primaryFieldId: string;
  /** 分组桶（null 表示未分组） */
  groups: GroupBucketDTO[] | null;
  selectedIds: ReadonlySet<string>;
  /** 行颜色（用户配置色，来自 view.config.rowColor，非硬编码） */
  rowColorOf: (rec: RecordDTO) => string | null;
  onToggleRowSelect: (recordId: string) => void;
  onOpenRecord: (ref: LinkRefDTO) => void;
  hasNextPage?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

function RecordCard({
  record,
  fields,
  primaryFieldId,
  selected,
  rowColor,
  onToggleRowSelect,
  onOpenRecord,
}: {
  record: RecordDTO;
  fields: FieldDTO[];
  primaryFieldId: string;
  selected: boolean;
  rowColor: string | null;
  onToggleRowSelect: (recordId: string) => void;
  onOpenRecord: (ref: LinkRefDTO) => void;
}) {
  const primary = fields.find((f) => f.id === primaryFieldId) ?? fields[0];
  const title = primary ? formatCell(record.fields?.[primary.id], primary) : "";
  const meta = fields.filter((f) => f.id !== primary?.id).slice(0, MAX_META_FIELDS);

  return (
    <li
      className={clsx(
        "flex items-start gap-2 rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-2",
        selected && "bg-gx-accent-bg",
      )}
    >
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleRowSelect(record.id)}
          aria-label={`选择记录 ${title || record.id}`}
          title={`选择记录 ${title || record.id}`}
          className="h-4 w-4 accent-gx-accent"
        />
        {rowColor && (
          <span
            aria-hidden
            className="h-4 w-1 rounded-full"
            style={{ backgroundColor: rowColor }}
            title="行颜色"
          />
        )}
      </div>

      <button
        type="button"
        onClick={() => onOpenRecord({ tableId: record.tableId, recordId: record.id, title: title || "" })}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-gx-13 font-medium text-gx-text-primary">
            {title || <span className="text-gx-text-hint">未命名记录</span>}
          </span>
          <Icon name="expand" size={13} className="shrink-0 text-gx-text-hint" />
        </span>
        {meta.length > 0 && (
          <span className="mt-1 flex flex-col gap-0.5">
            {meta.map((f) => {
              const text = formatCell(record.fields?.[f.id], f);
              return (
                <span key={f.id} className="flex min-w-0 items-baseline gap-2 text-gx-12">
                  <span className="w-16 shrink-0 truncate text-gx-text-hint">{f.name}</span>
                  <span className={clsx("min-w-0 flex-1 truncate", text ? "text-gx-text-primary" : "text-gx-text-hint")}>
                    {text || "—"}
                  </span>
                </span>
              );
            })}
          </span>
        )}
      </button>
    </li>
  );
}

export function RecordCardList({
  records,
  fields,
  primaryFieldId,
  groups,
  selectedIds,
  rowColorOf,
  onToggleRowSelect,
  onOpenRecord,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: RecordCardListProps) {
  // GroupBucketDTO.recordIds 是普通 string，RecordDTO.id 是 RecordIdT 品牌类型，
  // 统一按 string 建索引（品牌类型只影响编译期，运行期同值）。
  const byId = new Map<string, RecordDTO>(records.map((r) => [String(r.id), r]));
  const card = (rec: RecordDTO) => (
    <RecordCard
      key={rec.id}
      record={rec}
      fields={fields}
      primaryFieldId={primaryFieldId}
      selected={selectedIds.has(rec.id)}
      rowColor={rowColorOf(rec)}
      onToggleRowSelect={onToggleRowSelect}
      onOpenRecord={onOpenRecord}
    />
  );

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {groups && groups.length > 0 ? (
        groups.map((g) => (
          <section key={g.key} className="mb-2">
            <div className="flex items-center gap-2 px-1 py-1 text-gx-13">
              {g.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: g.color }} />}
              <span className="min-w-0 truncate font-semibold text-gx-text-primary">{g.label}</span>
              <span className="text-gx-text-hint">（{g.recordIds.length}）</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {g.recordIds.map((id) => byId.get(id)).filter((r): r is RecordDTO => !!r).map(card)}
            </ul>
          </section>
        ))
      ) : (
        <ul className="flex flex-col gap-1.5">
          {records.map(card)}
        </ul>
      )}

      {hasNextPage && onLoadMore && (
        <div className="flex justify-center py-3">
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded-gx-lg border border-gx-border bg-gx-surface px-3 py-1.5 text-gx-13 text-gx-text-primary hover:bg-gx-bg"
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}

export default RecordCardList;
