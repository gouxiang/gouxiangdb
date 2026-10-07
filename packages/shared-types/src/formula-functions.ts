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
  /**
   * 别名标记：本条是 `aliasOf` 所指函数的等价别名（后端共用同一份实现）。
   * 用途边界（H-149）：引擎求值链路保留别名——历史公式里可能已经写过 OR_F，
   * 删它要动 case 分支，风险大于收益；但 UI 的函数选择器不得把它当独立函数展示，
   * 否则用户会以为是两个不同的函数。
   * 因此：本字段只影响「选择器展示」的过滤，不影响 getFormulaFn / arity 校验
   * ——手写的 OR_F 公式仍要能被接受。
   */
  aliasOf?: string;
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
    name: "CONCATENATE", category: "common",
    signature: "CONCATENATE(文本1, 文本2, ...)",
    description: "CONCAT 的等价别名：将多个文本/字段值拼接成一个字符串，字符串之间不加分隔符。列表参数会先展开再逐项拼接。",
    params: [
      { name: "文本", type: "文本/列表", desc: "待拼接的值，可多个；列表参数会逐项拼接" },
    ],
    example: 'CONCATENATE({省}, {市}, "区") 或 CONCATENATE({订单明细.商品名})',
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
    name: "SUMIF", category: "common",
    signature: "SUMIF(条件范围, 条件, [求和范围])",
    description:
      "按条件求和：逐行检查「条件范围」中的值是否满足「条件」，满足时把「求和范围」同一行的数值累加。"
      + "省略「求和范围」时直接累加条件范围自身的数值。常用于子表格场景，如只统计状态为已付款的明细金额。"
      + "空值行会以占位形式保留，两个范围始终按行号一一对应。",
    params: [
      {
        name: "条件范围",
        type: "任意/列表",
        desc: "逐行检查的值，通常是点引用列表，如 {订单明细.状态}",
      },
      {
        name: "条件",
        type: "数字/布尔/文本",
        desc:
          "匹配条件：数字或布尔按精确相等；文本可加比较符 >、>=、<、<=、<>、=（如 \">100\"、\"<>已完成\"），"
          + "不加比较符按相等匹配；支持通配符 *（任意个字符）和 ?（单个字符），用 ~ 转义（~*、~?、~~）",
      },
      {
        name: "求和范围",
        type: "数值/列表",
        desc: "满足条件时实际累加的数值，通常是点引用列表，如 {订单明细.金额}（可选，省略则累加条件范围）",
      },
    ],
    example: 'SUMIF({订单明细.状态}, "已付款", {订单明细.金额})',
    returns: "数值（无任何匹配时返回 0）",
    arity: { min: 2, max: 3 },
  },
  {
    name: "COUNTIF", category: "common",
    signature: "COUNTIF(范围, 条件)",
    description:
      "按条件计数：统计范围中满足条件的非空元素个数。条件写法与 SUMIF 相同：数字精确相等，"
      + "文本支持 >、>=、<、<=、<>、= 比较符以及 *、? 通配符（~ 转义）。",
    params: [
      { name: "范围", type: "任意/列表", desc: "逐行检查的值，通常是点引用列表" },
      {
        name: "条件",
        type: "数字/布尔/文本",
        desc: "匹配条件，支持比较符与通配符，规则同 SUMIF",
      },
    ],
    example: 'COUNTIF({订单明细.状态}, "已付款")',
    returns: "数值（无匹配时返回 0）",
    arity: { min: 2, max: 2 },
  },
  {
    name: "AVERAGEIF", category: "common",
    signature: "AVERAGEIF(条件范围, 条件, [求平均范围])",
    description:
      "按条件求平均：逐行检查条件，满足时取「求平均范围」同一行的数值求平均。"
      + "省略第三参数时对条件范围自身的数值求平均。条件写法与 SUMIF 相同。",
    params: [
      { name: "条件范围", type: "任意/列表", desc: "逐行检查的值，通常是点引用列表" },
      { name: "条件", type: "数字/布尔/文本", desc: "匹配条件，支持比较符与通配符，规则同 SUMIF" },
      { name: "求平均范围", type: "数值/列表", desc: "满足条件时参与平均的数值（可选）" },
    ],
    example: 'AVERAGEIF({订单明细.状态}, "已付款", {订单明细.金额})',
    returns: "数值（无任何匹配时返回 0）",
    arity: { min: 2, max: 3 },
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
    name: "OR_F", category: "logic",
    signature: "OR_F(条件1, 条件2, ...)",
    description: "OR 的等价别名：任一条件为真即返回真。多个条件也可直接用 || 连接。",
    params: [{ name: "条件", type: "布尔", desc: "待判断的条件，可多个" }],
    example: 'OR_F({类型} = "VIP", {金额} > 1000)',
    returns: "布尔",
    arity: { min: 1, max: null },
    // 与 OR 共用同一份实现（见 apps/api/src/domain/formula.ts 的 OR 分支）：
    // 求值链路保留，但不在函数选择器里单独展示。
    aliasOf: "OR",
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
    name: "COUNT", category: "math",
    signature: "COUNT(值1, 值2, ...)",
    description:
      "统计数值型元素的个数：列表会先展开，只有数字类型的值才计入；布尔值、文本、空值不计，"
      + "形如 \"100\" 的数字文本不会自动转成数字（与 Excel 口径一致）。",
    params: [{ name: "值", type: "任意/列表", desc: "待统计的值，可多个；列表参数会展开" }],
    example: "COUNT({订单明细.金额})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
  {
    name: "COUNTA", category: "math",
    signature: "COUNTA(值1, 值2, ...)",
    description:
      "统计非空元素的个数：列表会先展开，只有空值不计入；文本（含空字符串 \"\"）、数字、布尔均计入（与 Excel 口径一致）。",
    params: [{ name: "值", type: "任意/列表", desc: "待统计的值，可多个；列表参数会展开" }],
    example: "COUNTA({订单明细.备注})",
    returns: "数值",
    arity: { min: 1, max: null },
  },
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
    name: "YEAR", category: "date",
    signature: "YEAR(日期)",
    description:
      "取日期的年份。日期参数支持 ISO 文本（如 \"2026-10-06\"、\"2026-10-06T08:00:00.000Z\"）"
      + "或毫秒时间戳数字；无法解析为有效日期时返回空值。",
    params: [{ name: "日期", type: "日期文本/数值", desc: "ISO 日期文本或毫秒时间戳" }],
    example: "YEAR({下单日期})",
    returns: "数值（解析失败返回空值）",
    arity: { min: 1, max: 1 },
  },
  {
    name: "MONTH", category: "date",
    signature: "MONTH(日期)",
    description:
      "取日期的月份（1-12）。日期参数支持 ISO 文本或毫秒时间戳数字；无法解析为有效日期时返回空值。",
    params: [{ name: "日期", type: "日期文本/数值", desc: "ISO 日期文本或毫秒时间戳" }],
    example: "MONTH({下单日期})",
    returns: "数值（解析失败返回空值）",
    arity: { min: 1, max: 1 },
  },
  {
    name: "DAY", category: "date",
    signature: "DAY(日期)",
    description:
      "取日期是当月第几天（1-31）。日期参数支持 ISO 文本或毫秒时间戳数字；无法解析为有效日期时返回空值。",
    params: [{ name: "日期", type: "日期文本/数值", desc: "ISO 日期文本或毫秒时间戳" }],
    example: "DAY({下单日期})",
    returns: "数值（解析失败返回空值）",
    arity: { min: 1, max: 1 },
  },
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
