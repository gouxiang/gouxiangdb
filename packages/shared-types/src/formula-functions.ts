// packages/shared-types/src/formula-functions.ts
// 公式函数元数据（前后端共用）：前端公式编辑器的函数列表 / 悬停说明 / 实时校验，
// 后端可据此做函数存在性与参数个数校验。
// 函数实现见 apps/api/src/domain/formula.ts。函数名大小写不敏感。

export type FormulaCategory = "common" | "logic" | "text" | "math" | "date";

export interface FormulaFnParam {
  name: string;
  type: string;
  desc: string;
}

export interface FormulaFnDef {
  name: string;
  category: FormulaCategory;
  /** 签名展示，如 "SUM(数值1, 数值2, ...)" */
  signature: string;
  /** 用途说明 */
  description: string;
  params: FormulaFnParam[];
  /** 使用示例 */
  example: string;
  /** 返回值类型说明 */
  returns: string;
  /** 参数个数约束：min~max（max=null 表示可变参数） */
  arity: { min: number; max: number | null };
}

export const FORMULA_CATEGORY_LABEL: Record<FormulaCategory, string> = {
  common: "常用函数",
  logic: "逻辑函数",
  text: "文本函数",
  math: "数学函数",
  date: "时间函数",
};

export const FORMULA_FUNCTIONS: FormulaFnDef[] = [
  // ---- 常用 ----
  {
    name: "IF", category: "common",
    signature: "IF(条件, 满足时的值, 不满足时的值)",
    description: "条件判断：条件为真返回第二个参数，否则返回第三个参数（可省略第三参数，不满足返回空）。",
    params: [
      { name: "条件", type: "布尔", desc: "判断表达式，如 {数量} > 10" },
      { name: "满足时", type: "任意", desc: "条件为真时返回的值" },
      { name: "不满足时", type: "任意", desc: "条件为假时返回的值（可选）" },
    ],
    example: 'IF({数量} > 100, "大批量", "小批量")',
    returns: "任意（按参数）",
    arity: { min: 2, max: 3 },
  },
  {
    name: "CONCAT", category: "common",
    signature: "CONCAT(文本1, 文本2, ...)",
    description: "将多个文本/字段值合并成一个字符串。字段或函数之间用逗号分隔；字符串字面量需用引号包裹。点引用 {关联.子字段} 取出多条记录时会逐项拼接。",
    params: [
      { name: "文本", type: "文本/列表", desc: "待合并的值，可多个；列表参数会逐项拼接" },
    ],
    example: 'CONCAT({省}, {市}, "区") 或 CONCAT({订单明细.商品名})',
    returns: "文本",
    arity: { min: 1, max: null },
  },
  {
    name: "SUM", category: "common",
    signature: "SUM(数值1, 数值2, ...)",
    description: "求和。可传多个数值，也可直接对子表格/关联字段的点引用做跨表求和：多条记录自动聚合成列表后求和。",
    params: [{ name: "数值", type: "数值/列表", desc: "待求和的数值或数值列表" }],
    example: "SUM({单价} * {数量}) 或 SUM({订单明细.金额})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
  {
    name: "ROUND", category: "common",
    signature: "ROUND(数值, 小数位)",
    description: "按指定小数位四舍五入。",
    params: [
      { name: "数值", type: "数值", desc: "待取整的数" },
      { name: "小数位", type: "数值", desc: "保留的小数位数" },
    ],
    example: "ROUND({金额}, 2)",
    returns: "数值",
    arity: { min: 1, max: 2 },
  },
  {
    name: "TODAY", category: "common",
    signature: "TODAY()",
    description: "返回当前日期（YYYY-MM-DD）。",
    params: [],
    example: 'DATETIME_DIFF(TODAY(), {下单日期}, "days")',
    returns: "日期文本",
    arity: { min: 0, max: 0 },
  },

  // ---- 逻辑 ----
  {
    name: "SWITCH", category: "logic",
    signature: "SWITCH(目标值, 情形1, 结果1, ..., 默认值)",
    description: "多分支匹配：目标值等于某个情形时返回对应结果；都不匹配时返回最后的默认值。",
    params: [{ name: "参数", type: "任意", desc: "目标值 + 成对的情形/结果 + 可选默认值" }],
    example: 'SWITCH({状态}, "待付款", 1, "已付款", 2, 0)',
    returns: "任意",
    arity: { min: 3, max: null },
  },
  {
    name: "AND", category: "logic",
    signature: "AND(条件1, 条件2, ...)",
    description: "所有条件都为真才返回真。多个条件也可直接用 && 连接。",
    params: [{ name: "条件", type: "布尔", desc: "待判断的条件，可多个" }],
    example: 'AND({数量} > 0, {状态} = "已付款")',
    returns: "布尔",
    arity: { min: 1, max: null },
  },
  {
    name: "OR", category: "logic",
    signature: "OR(条件1, 条件2, ...)",
    description: "任一条件为真即返回真。多个条件也可直接用 || 连接。",
    params: [{ name: "条件", type: "布尔", desc: "待判断的条件，可多个" }],
    example: 'OR({类型} = "VIP", {金额} > 1000)',
    returns: "布尔",
    arity: { min: 1, max: null },
  },
  {
    name: "NOT", category: "logic",
    signature: "NOT(条件)",
    description: "逻辑取反。",
    params: [{ name: "条件", type: "布尔", desc: "待取反的条件" }],
    example: 'NOT({已完成})',
    returns: "布尔",
    arity: { min: 1, max: 1 },
  },
  {
    name: "ISNULL", category: "logic",
    signature: "ISNULL(值)",
    description: "判断值是否为空。",
    params: [{ name: "值", type: "任意", desc: "待判断的值" }],
    example: 'IF(ISNULL({备注}), "无备注", {备注})',
    returns: "布尔",
    arity: { min: 0, max: 1 },
  },
  {
    name: "BLANK", category: "logic",
    signature: "BLANK()",
    description: "返回一个空值，常用于 IF 的分支占位。",
    params: [],
    example: 'IF({数量} > 0, {数量}, BLANK())',
    returns: "空",
    arity: { min: 0, max: 0 },
  },

  // ---- 文本 ----
  {
    name: "TRIM", category: "text",
    signature: "TRIM(文本)",
    description: "去掉文本首尾空格。",
    params: [{ name: "文本", type: "文本", desc: "待处理文本" }],
    example: "TRIM({姓名})",
    returns: "文本",
    arity: { min: 1, max: 1 },
  },
  {
    name: "UPPER", category: "text",
    signature: "UPPER(文本)",
    description: "文本转大写。",
    params: [{ name: "文本", type: "文本", desc: "待处理文本" }],
    example: "UPPER({编号})",
    returns: "文本",
    arity: { min: 1, max: 1 },
  },
  {
    name: "LOWER", category: "text",
    signature: "LOWER(文本)",
    description: "文本转小写。",
    params: [{ name: "文本", type: "文本", desc: "待处理文本" }],
    example: "LOWER({邮箱})",
    returns: "文本",
    arity: { min: 1, max: 1 },
  },
  {
    name: "LEN", category: "text",
    signature: "LEN(文本)",
    description: "返回文本字符数；传入点引用的多条记录列表时返回元素个数。",
    params: [{ name: "文本/列表", type: "文本/列表", desc: "待统计对象" }],
    example: "LEN({说明}) 或 LEN({订单明细.商品名})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },
  {
    name: "LEFT", category: "text",
    signature: "LEFT(文本, 长度)",
    description: "从文本左侧取指定长度的字符。",
    params: [
      { name: "文本", type: "文本", desc: "源文本" },
      { name: "长度", type: "数值", desc: "截取字符数" },
    ],
    example: "LEFT({手机号}, 3)",
    returns: "文本",
    arity: { min: 2, max: 2 },
  },
  {
    name: "RIGHT", category: "text",
    signature: "RIGHT(文本, 长度)",
    description: "从文本右侧取指定长度的字符。",
    params: [
      { name: "文本", type: "文本", desc: "源文本" },
      { name: "长度", type: "数值", desc: "截取字符数" },
    ],
    example: "RIGHT({手机号}, 4)",
    returns: "文本",
    arity: { min: 2, max: 2 },
  },
  {
    name: "REPLACE", category: "text",
    signature: "REPLACE(文本, 旧串, 新串)",
    description: "把文本中的旧串全部替换为新串。",
    params: [
      { name: "文本", type: "文本", desc: "源文本" },
      { name: "旧串", type: "文本", desc: "被替换内容" },
      { name: "新串", type: "文本", desc: "替换为" },
    ],
    example: 'REPLACE({电话}, "-", "")',
    returns: "文本",
    arity: { min: 3, max: 3 },
  },
  {
    name: "SUBSTR", category: "text",
    signature: "SUBSTR(文本, 起始位置[, 长度])",
    description: "从起始位置（1 起）截取子串，可指定长度。",
    params: [
      { name: "文本", type: "文本", desc: "源文本" },
      { name: "起始", type: "数值", desc: "起始位置（1 起）" },
      { name: "长度", type: "数值", desc: "截取长度（可选）" },
    ],
    example: "SUBSTR({编号}, 2, 4)",
    returns: "文本",
    arity: { min: 2, max: 3 },
  },
  {
    name: "REPT", category: "text",
    signature: "REPT(文本, 次数)",
    description: "将文本重复指定次数。",
    params: [
      { name: "文本", type: "文本", desc: "待重复文本" },
      { name: "次数", type: "数值", desc: "重复次数" },
    ],
    example: 'REPT("*", {等级})',
    returns: "文本",
    arity: { min: 2, max: 2 },
  },
  {
    name: "SEARCH", category: "text",
    signature: "SEARCH(在其中找, 要找的串)",
    description: "返回要找的串在文本中的位置（1 起）；未找到返回 0。",
    params: [
      { name: "在其中找", type: "文本", desc: "被搜索文本" },
      { name: "要找", type: "文本", desc: "目标子串" },
    ],
    example: 'IF(SEARCH({邮箱}, "@") > 0, "有效", "无效")',
    returns: "数值",
    arity: { min: 2, max: 2 },
  },

  // ---- 数学 ----
  {
    name: "CEILING", category: "math",
    signature: "CEILING(数值)",
    description: "向上取整。",
    params: [{ name: "数值", type: "数值", desc: "待取整" }],
    example: "CEILING({重量})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },
  {
    name: "FLOOR", category: "math",
    signature: "FLOOR(数值)",
    description: "向下取整。",
    params: [{ name: "数值", type: "数值", desc: "待取整" }],
    example: "FLOOR({重量})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },
  {
    name: "ABS", category: "math",
    signature: "ABS(数值)",
    description: "取绝对值。",
    params: [{ name: "数值", type: "数值", desc: "源数值" }],
    example: "ABS({差额})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },
  {
    name: "MIN", category: "math",
    signature: "MIN(数值1, 数值2, ...)",
    description: "取最小值；可直接传点引用列表做跨表取最小。",
    params: [{ name: "数值", type: "数值/列表", desc: "待比较数值" }],
    example: "MIN({订单明细.单价})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
  {
    name: "MAX", category: "math",
    signature: "MAX(数值1, 数值2, ...)",
    description: "取最大值；可直接传点引用列表做跨表取最大。",
    params: [{ name: "数值", type: "数值/列表", desc: "待比较数值" }],
    example: "MAX({订单明细.金额})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
  {
    name: "AVERAGE", category: "math",
    signature: "AVERAGE(数值1, ...)",
    description: "求平均值；可直接传点引用列表做跨表平均。",
    params: [{ name: "数值", type: "数值/列表", desc: "待平均数值" }],
    example: "AVERAGE({订单明细.评分})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
  {
    name: "SQRT", category: "math",
    signature: "SQRT(数值)",
    description: "平方根。",
    params: [{ name: "数值", type: "数值", desc: "源数值" }],
    example: "SQRT({面积})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },
  {
    name: "POWER", category: "math",
    signature: "POWER(底数, 指数)",
    description: "求幂。",
    params: [
      { name: "底数", type: "数值", desc: "底数" },
      { name: "指数", type: "数值", desc: "指数" },
    ],
    example: "POWER({边长}, 2)",
    returns: "数值",
    arity: { min: 2, max: 2 },
  },
  {
    name: "MOD", category: "math",
    signature: "MOD(数值, 除数)",
    description: "取余数。",
    params: [
      { name: "数值", type: "数值", desc: "被除数" },
      { name: "除数", type: "数值", desc: "除数" },
    ],
    example: "MOD({序号}, 2)",
    returns: "数值",
    arity: { min: 2, max: 2 },
  },
  {
    name: "INT", category: "math",
    signature: "INT(数值)",
    description: "截断取整（向零取整）。",
    params: [{ name: "数值", type: "数值", desc: "源数值" }],
    example: "INT({数量})",
    returns: "数值",
    arity: { min: 1, max: 1 },
  },

  // ---- 时间 ----
  {
    name: "NOW", category: "date",
    signature: "NOW()",
    description: "返回当前日期时间（ISO 格式）。",
    params: [],
    example: "DATETIME_DIFF(NOW(), {创建时间}, \"hours\")",
    returns: "日期时间文本",
    arity: { min: 0, max: 0 },
  },
  {
    name: "DATETIME_DIFF", category: "date",
    signature: "DATETIME_DIFF(日期1, 日期2, 单位)",
    description: "计算两个日期之差。单位：milliseconds/seconds/minutes/hours/days/weeks。",
    params: [
      { name: "日期1", type: "日期", desc: "较晚日期" },
      { name: "日期2", type: "日期", desc: "较早日期" },
      { name: "单位", type: "文本", desc: "差值单位，默认 days" },
    ],
    example: 'DATETIME_DIFF(TODAY(), {下单日期}, "days")',
    returns: "数值",
    arity: { min: 2, max: 3 },
  },
  {
    name: "DATEADD", category: "date",
    signature: "DATEADD(日期, 天数)",
    description: "日期加指定天数，返回新日期。",
    params: [
      { name: "日期", type: "日期", desc: "起始日期" },
      { name: "天数", type: "数值", desc: "增加的天数（可为负）" },
    ],
    example: "DATEADD({下单日期}, 7)",
    returns: "日期文本",
    arity: { min: 2, max: 2 },
  },

  // ---- 列表取值（配合点引用 {关联字段.子字段}）----
  {
    name: "FIRST", category: "common",
    signature: "FIRST(值/列表)",
    description:
      "取列表第一个值；传入单值时原样返回。跨表场景配合点引用使用：{关联字段.子字段} 在多条关联记录时是列表，FIRST 取第一条记录的值；无关联记录时返回空。",
    params: [{ name: "值", type: "任意/列表", desc: "点引用字段或任意列表值" }],
    example: "FIRST({订单明细.金额})",
    returns: "任意（首元素）",
    arity: { min: 1, max: 1 },
  },
  {
    name: "LAST", category: "common",
    signature: "LAST(值/列表)",
    description:
      "取列表最后一个值；传入单值时原样返回。跨表场景配合点引用使用：{关联字段.子字段} 在多条关联记录时是列表，LAST 取最后一条记录的值；无关联记录时返回空。统计关联记录条数请用 LEN({关联字段.子字段}) 或 count 字段。",
    params: [{ name: "值", type: "任意/列表", desc: "点引用字段或任意列表值" }],
    example: "LAST({订单明细.备注})",
    returns: "任意（末元素）",
    arity: { min: 1, max: 1 },
  },
];

const FN_BY_NAME = new Map(FORMULA_FUNCTIONS.map((f) => [f.name.toUpperCase(), f]));

/** 按函数名（大小写不敏感）查元数据 */
export function getFormulaFn(name: string): FormulaFnDef | undefined {
  return FN_BY_NAME.get(name.toUpperCase());
}

export function formulaFnsByCategory(cat: FormulaCategory): FormulaFnDef[] {
  return FORMULA_FUNCTIONS.filter((f) => f.category === cat);
}
