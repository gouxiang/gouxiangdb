// apps/api/src/domain/fieldValidation.ts
// 字段配置类型校验（创建/更新字段的服务端权威卡控）：
//   1. 默认内容「关联已有数据」取值字段必须与宿主字段类型兼容（禁止子表格关联文本字段等跨类型）
//   2. 子表格整表抓取：数据源表与实际关联目标表结构必须兼容（至少 1 个同名同类型字段）
//   3. 公式输出类型校验（默认内容 formula 模式；公式字段仅语法校验）
//   4. rollup 数字聚合函数要求源字段为数值类；min/max 允许日期类
//   5. 关联标题字段（linkDisplayFieldId）不得指向容器/子表格字段
//   6. lookup 取值字段不得指向 subtable/tabs（会递归或无值）
//   7. lookup / rollup / count 的 linkFieldId 必须是【本表】的 links 字段
//      （计算层 hydrate.ts resolveLookup/resolveCount 显式排除非 links，指向 subtable 会恒为无值）
// 前端做下拉过滤的双层保险；返回中文错误消息，null 表示通过。

import {
  fieldTypeGroup,
  isTypeAssignable,
  checkSubtableCompatibility,
  FIELD_TYPE_LABEL,
  type FieldShape,
  type FieldType,
} from "@gx/shared-types";
import { prisma } from "../db.js";
import { validateFormulaOutput, parseFormula } from "./formula.js";

export interface FieldConfigView {
  type: string;
  formula?: string | null;
  lookupFieldId?: string | null;
  rollupFunction?: string | null;
  linkDisplayFieldId?: string | null;
  relatedTableId?: string | null;
  /** 查阅/聚合/计数的关联源字段（linkFieldId）：必须是本表的 links 字段 */
  linkFieldId?: string | null;
  defaultConfig?: unknown | null;
}

interface FieldRow {
  id: string;
  name: string;
  type: string;
  /** 所属表：判定「关联源字段必须属于本表」时需要（fieldById 一并查出） */
  tableId?: string;
}

async function fieldsOfTable(tableId: string): Promise<FieldRow[]> {
  const rows = await prisma.field.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true, name: true, type: true },
    orderBy: { order: "asc" },
  });
  return rows;
}

async function fieldById(id: string): Promise<FieldRow | null> {
  return prisma.field.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, type: true, tableId: true },
  });
}

/** 校验入口。tableId 为字段所属表；patch 为待落库配置（create 用全量，update 用合并后视图由调用方组装）。 */
export async function validateFieldConfig(tableId: string, cfg: FieldConfigView): Promise<string | null> {
  // ---------- 公式 ----------
  // type=formula 的公式字段：结果可文本可数值（渲染层通用展示），仅做语法/空值校验由前端负责；
  // 这里重点卡「默认内容 formula 模式」——宿主是文本/数值/日期等具体类型字段，输出必须匹配。
  if (cfg.type === "formula" && cfg.formula !== undefined && cfg.formula !== null && cfg.formula.trim() !== "") {
    // 公式字段：输出类型由公式决定、通用展示，不强制输出类型；仅做语法校验（解析失败即错）
    try {
      parseFormula(cfg.formula);
    } catch (e) {
      return e instanceof Error ? e.message : "公式语法错误";
    }
  }

  // ---------- 默认内容 ----------
  if (cfg.defaultConfig && typeof cfg.defaultConfig === "object") {
    const dc = cfg.defaultConfig as Record<string, unknown>;
    if (dc["mode"] === "formula" && typeof dc["formula"] === "string" && dc["formula"].trim()) {
      const all = await fieldsOfTable(tableId);
      const byName = new Map(all.map((f) => [f.name, f.type]));
      // inferAST 按「分组」判定输出类型：datetime 的 type 是 datetime 但 group 是 date，
      // 直接把 type 传进去会让日期/勾选字段的引用一律落到兜底 str，从而误报「类型不匹配」。
      // 这里显式传 group（单一真源 fieldTypeGroup），成员判定再单独传原始 type。
      const groupByName = (n: string): string | undefined => {
        const t = byName.get(n);
        return t === undefined ? undefined : fieldTypeGroup(t as FieldType);
      };
      const typeByName = (n: string): string | undefined => byName.get(n);
      const err = validateFormulaOutput(dc["formula"] as string, cfg.type, groupByName, typeByName);
      if (err) return `默认内容公式校验失败：${err}`;
    }
    if (dc["mode"] === "lookup") {
      const valueFieldId = dc["valueFieldId"] as string | null | undefined;
      const sourceTableId = dc["sourceTableId"] as string | null | undefined;

      if (cfg.type === "subtable") {
        // 子表格整表抓取：数据源表 ↔ 实际关联目标表 结构兼容性
        const targetTableId = cfg.relatedTableId;
        if (!sourceTableId) return "子表格默认内容需选择数据源表";
        if (!targetTableId) return "子表格尚未关联目标表，无法配置默认抓取";
        if (sourceTableId === targetTableId) {
          // 同表直连：天然兼容
        } else {
          const [srcRows, tgtRows] = await Promise.all([fieldsOfTable(sourceTableId), fieldsOfTable(targetTableId)]);
          const shape = (r: FieldRow): FieldShape => ({ name: r.name, type: r.type as FieldShape["type"] });
          const compat = checkSubtableCompatibility(srcRows.map(shape), tgtRows.map(shape));
          if (!compat.ok) {
            return `数据源表与子表格目标表结构不兼容：两表之间没有任何同名且类型一致的可写字段，无法抓取。请在目标表中建立与模板表同名的字段。`;
          }
          if (compat.typeMismatch.length > 0) {
            const mm = compat.typeMismatch.slice(0, 3).map((x) => `「${x.name}」(模板:${x.sourceType}/目标:${x.targetType})`).join("、");
            // 类型不匹配字段会被忽略（不阻断），但给出明确提示——通过 console，不在这里 400
            console.warn(`[subtable-defaults] 同名字段类型不匹配，抓取时将忽略：${mm}`);
          }
        }
      } else if (valueFieldId) {
        // 标量字段默认值抓取：取值字段类型必须与宿主字段兼容
        const vf = await fieldById(valueFieldId);
        if (!vf) return "默认内容取值字段不存在或已被删除";
        if (!isTypeAssignable(cfg.type as FieldShape["type"], vf.type as FieldShape["type"])) {
          const tg = fieldTypeGroup(cfg.type as FieldShape["type"]);
          const sg = fieldTypeGroup(vf.type as FieldShape["type"]);
          const groupLabel: Record<string, string> = {
            text: "文本类", number: "数值类", date: "日期时间类", bool: "布尔",
            select: "选项类", link: "关联/计算类", attachment: "附件类", container: "容器",
          };
          return `默认内容取值字段类型不兼容：当前字段为${groupLabel[tg] ?? tg}字段，只能关联${groupLabel[tg] ?? ""}类型的字段；「${vf.name}」是${groupLabel[sg] ?? sg}字段。请重新选择。`;
        }
      }
    }
  }

  // ---------- rollup 聚合函数与源字段类型 ----------
  if (cfg.type === "rollup" && cfg.rollupFunction && cfg.lookupFieldId) {
    const vf = await fieldById(cfg.lookupFieldId);
    if (vf) {
      const g = fieldTypeGroup(vf.type as FieldShape["type"]);
      const fn = cfg.rollupFunction;
      if ((fn === "sum" || fn === "avg") && g !== "number") {
        return `聚合函数「${fn === "sum" ? "求和" : "平均值"}」只能用于数值类字段；「${vf.name}」不是数值类字段，请改用计数类聚合或更换取值字段。`;
      }
      if ((fn === "min" || fn === "max") && g !== "number" && g !== "date") {
        return `聚合函数「${fn === "min" ? "最小值" : "最大值"}」只能用于数值或日期类字段；「${vf.name}」类型不支持。`;
      }
    }
  }

  // ---------- 关联标题字段：不得为容器/子表格 ----------
  if (cfg.linkDisplayFieldId) {
    const df = await fieldById(cfg.linkDisplayFieldId);
    if (df && (df.type === "tabs" || df.type === "subtable")) {
      return "关联记录标题字段不能选择选项卡或子表格字段";
    }
  }

  // ---------- lookup 取值字段：排除 subtable/tabs ----------
  if (cfg.type === "lookup" && cfg.lookupFieldId) {
    const vf = await fieldById(cfg.lookupFieldId);
    if (vf && (vf.type === "subtable" || vf.type === "tabs")) {
      return "查阅字段不能指向子表格或选项卡字段";
    }
  }

  // ---------- 查阅/聚合/计数的关联源：必须是本表的 links 字段 ----------
  // 取值链路 resolveLookup / resolveCount（hydrate.ts）显式只认 linkField.type === "links"，
  // 用 subtable 或其它类型当关联源会建出「永远为空」的字段（rollup 恒 null、count 恒 0），
  // 且界面上没有任何提示。前端口径同样只列 links，这里补服务端 400，与前端口径对齐。
  if (cfg.type === "lookup" || cfg.type === "rollup" || cfg.type === "count") {
    if (cfg.linkFieldId) {
      const lf = await fieldById(cfg.linkFieldId);
      if (!lf) return "关联字段不存在或已被删除";
      if (lf.type !== "links") {
        // 错误消息要「可行动」：点名当前选中的字段、它的真实类型、应该选什么类型
        // （与巡检脚本 check-link-source-integrity.mjs 同口径，用户据此能自己改对）。
        const label = FIELD_TYPE_LABEL[lf.type as FieldType] ?? lf.type;
        return `查阅/聚合/计数的关联字段必须是「关联」类型的字段；你现在选的是「${lf.name}」（${label}），`
          + "不是关联字段，请在本数据表内重新选择一个「关联」类型的字段。";
      }
      if (lf.tableId && lf.tableId !== tableId) {
        return `查阅/聚合/计数的关联字段必须属于当前数据表；「${lf.name}」属于其它数据表，请改选本表的「关联」字段。`;
      }
    }
  }

  return null;
}
