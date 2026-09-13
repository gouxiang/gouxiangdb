// 分组配置面板：选择分组字段（单选/复选/文本/关联等），写入 view.config.groupByFieldId，可清除分组。

import type { FieldDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Select, Button } from "../../components/ui";
import { isSortGroupRestricted } from "../../api/records-paging";

// 可作分组字段的类型
function canGroup(field: FieldDTO): boolean {
  return [
    "singleSelect",
    "multiSelect",
    "checkbox",
    "links",
    "singleLineText",
    "longText",
    "email",
    "phone",
    "url",
  ].includes(field.type);
}

export interface GroupPanelProps {
  fields: FieldDTO[];
  groupByFieldId: string | null;
  /** S8：降级原因码；computedInMem 时对非物理可分组字段（links/非主字段 longText 等）逐项禁用。 */
  degradedCodes?: string[];
  onChange: (fieldId: string | null) => void;
}

export function GroupPanel({ fields, groupByFieldId, degradedCodes, onChange }: GroupPanelProps) {
  const groupable = fields.filter(canGroup);

  const options = [
    { value: "", label: "不分组" },
    ...groupable.map((f) => {
      // 降级态下非物理字段分组会逼查询走内存路径 → 置灰；物理字段（单选/多选/勾选/短文本等）不受影响。
      const disabled = isSortGroupRestricted(degradedCodes, f);
      return {
        value: f.id,
        label: disabled ? `${f.name}（量大时不可用）` : f.name,
        // 已选中的当前分组值保持可用，避免原生 select 把 value 落到 disabled option 上。
        disabled: disabled && f.id !== groupByFieldId,
      };
    }),
  ];

  return (
    <div className="flex w-72 flex-col gap-3 p-3">
      <span className="text-gx-13 font-semibold text-gx-text-primary">分组</span>
      <div className="flex flex-col gap-1.5">
        <span className="text-gx-12 text-gx-text-secondary">分组字段</span>
        <Select
          value={groupByFieldId ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          options={options}
        />
      </div>
      {groupByFieldId && (
        <Button variant="ghost" size="sm" icon="close" onClick={() => onChange(null)}>
          清除分组
        </Button>
      )}
      {groupable.length === 0 && (
        <div className="flex items-center gap-1.5 text-gx-12 text-gx-text-hint">
          <Icon name="help" size={13} /> 暂无可分组字段
        </div>
      )}
    </div>
  );
}

export default GroupPanel;
