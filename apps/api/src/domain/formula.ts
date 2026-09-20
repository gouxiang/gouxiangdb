// apps/api/src/domain/formula.ts
// 公式引擎（v1 Core/FormulaEngine.swift 严格 1:1 移植）
//
// 架构：Tokenizer → Pratt Parser → AST → Eval
// 移植要点（必须与 v1 行为一致，否则对比测试会红）：
//   1. 字段引用用 {字段名}（中文/任意字符）
//   2. `=` 在 tokenizer 阶段直接变成 `==`
//   3. `&` 单字符 = 字符串拼接(CONCAT_OP)，`&&` = AND；`||` = OR，单个 `|` 报错
//   4. binding power: OR(1,2) AND(3,4) 比较(5,6) +-/concat(7,8) */%(9,10)，一元 11
//   5. 相等判定：两边都是 string → 严格字符串比较；否则都能转数字 → 数值比较；其余退化为字符串
//   6. SEARCH 是 1-based（开头返回 1，未找到返回 0）
//   7. LEFT/RIGHT 长度做 max(0, n) 下界保护
//   8. 函数名大小写不敏感（eval 处 uppercased）

export type FormulaValue =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "list"; v: FormulaValue[] }
  | { t: "null" };

export const FNULL: FormulaValue = { t: "null" };
export const fnum = (v: number): FormulaValue => ({ t: "num", v });
export const fstr = (v: string): FormulaValue => ({ t: "str", v });
export const fbool = (v: boolean): FormulaValue => ({ t: "bool", v });
export const flist = (v: FormulaValue[]): FormulaValue => ({ t: "list", v });

export function asString(v: FormulaValue): string {
  switch (v.t) {
    case "num":
      return v.v % 1 === 0 ? String(Math.trunc(v.v)) : String(v.v);
    case "str":
      return v.v;
    case "bool":
      return v.v ? "true" : "false";
    case "list":
      // 兜底：用 ", " 拼接（CONCAT 聚合会单独无分隔拼接）
      return v.v.map(asString).join(", ");
    case "null":
      return "";
  }
}

export function asNum(v: FormulaValue): number | null {
  switch (v.t) {
    case "num":
      return v.v;
    case "str":
      return v.v.trim() === "" ? null : Number(v.v);
    case "bool":
      return v.v ? 1 : 0;
    case "list":
      return null; // 列表不直接转数值，聚合走 SUM/AVERAGE 等
    case "null":
      return null;
  }
}

export function asBool(v: FormulaValue): boolean {
  switch (v.t) {
    case "num":
      return v.v !== 0;
    case "str":
      return v.v !== "";
    case "bool":
      return v.v;
    case "list":
      return v.v.length > 0;
    case "null":
      return false;
  }
}

// ============ Token ============

export type FormulaToken =
  | { k: "number"; v: number }
  | { k: "string"; v: string }
  | { k: "fieldRef"; v: string }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "lparen" }
  | { k: "rparen" }
  | { k: "comma" };

export type FormulaAST =
  | { k: "number"; v: number }
  | { k: "string"; v: string }
  | { k: "boolean"; v: boolean }
  | { k: "fieldRef"; v: string }
  | { k: "unary"; op: string; expr: FormulaAST }
  | { k: "binary"; op: string; lhs: FormulaAST; rhs: FormulaAST }
  | { k: "call"; name: string; args: FormulaAST[] };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

// ============ Tokenizer ============

class Tokenizer {
  private pos = 0;
  constructor(private readonly src: string) {}

  tokenize(): FormulaToken[] {
    const tokens: FormulaToken[] = [];
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === " " || c === "\t" || c === "\n") {
        this.pos += 1;
        continue;
      }
      if (this.isDigit(c) || (c === "." && this.isDigit(this.src[this.pos + 1] ?? ""))) {
        tokens.push(this.readNumber());
      } else if (c === "'" || c === '"') {
        tokens.push(this.readString());
      } else if (c === "{") {
        tokens.push(this.readFieldRef());
      } else if (this.isLetter(c)) {
        tokens.push(this.readIdent());
      } else if (c === "(") {
        this.pos += 1;
        tokens.push({ k: "lparen" });
      } else if (c === ")") {
        this.pos += 1;
        tokens.push({ k: "rparen" });
      } else if (c === ",") {
        this.pos += 1;
        tokens.push({ k: "comma" });
      } else if ("+-*/%".includes(c)) {
        this.pos += 1;
        tokens.push({ k: "op", v: c });
      } else if (c === "=") {
        // v1 语义：单个 `=` 在 tokenizer 阶段就变成 `==`
        // v2 增强：同时接受 `==` 写法（v1 下 `==` 会被拆成两个 op 而报错，属缺陷）
        if (this.src[this.pos + 1] === "=") {
          this.pos += 2;
        } else {
          this.pos += 1;
        }
        tokens.push({ k: "op", v: "==" });
      } else if (c === "!") {
        if (this.src[this.pos + 1] === "=") {
          this.pos += 2;
          tokens.push({ k: "op", v: "!=" });
        } else {
          this.pos += 1;
          tokens.push({ k: "op", v: "!" });
        }
      } else if (c === "<") {
        if (this.src[this.pos + 1] === "=") {
          this.pos += 2;
          tokens.push({ k: "op", v: "<=" });
        } else {
          this.pos += 1;
          tokens.push({ k: "op", v: "<" });
        }
      } else if (c === ">") {
        if (this.src[this.pos + 1] === "=") {
          this.pos += 2;
          tokens.push({ k: "op", v: ">=" });
        } else {
          this.pos += 1;
          tokens.push({ k: "op", v: ">" });
        }
      } else if (c === "&") {
        if (this.src[this.pos + 1] === "&") {
          this.pos += 2;
          tokens.push({ k: "op", v: "AND" });
        } else {
          this.pos += 1;
          tokens.push({ k: "op", v: "CONCAT_OP" });
        }
      } else if (c === "|") {
        if (this.src[this.pos + 1] === "|") {
          this.pos += 2;
          tokens.push({ k: "op", v: "OR" });
        } else {
          throw new FormulaError(`公式错误：意外字符 '${c}' 位置 ${this.pos}`);
        }
      } else {
        throw new FormulaError(`公式错误：意外字符 '${c}' 位置 ${this.pos}`);
      }
    }
    return tokens;
  }

  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }

  // 标识符允许中文（v1 用 isLetter，Swift 的 isLetter 对中文为 true）
  private isLetter(c: string): boolean {
    return /[\p{L}]/u.test(c);
  }

  private readNumber(): FormulaToken {
    let s = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (this.isDigit(c) || c === ".") {
        s += c;
        this.pos += 1;
      } else break;
    }
    const d = Number(s);
    if (!Number.isFinite(d)) throw new FormulaError(`公式错误：意外 token ${s}`);
    return { k: "number", v: d };
  }

  private readString(): FormulaToken {
    const quote = this.src[this.pos]!;
    this.pos += 1;
    let s = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\\" && this.pos + 1 < this.src.length) {
        this.pos += 1;
        s += this.src[this.pos]!;
        this.pos += 1;
      } else if (c === quote) {
        this.pos += 1;
        return { k: "string", v: s };
      } else {
        s += c;
        this.pos += 1;
      }
    }
    throw new FormulaError("公式错误：未闭合字符串");
  }

  private readFieldRef(): FormulaToken {
    this.pos += 1; // {
    let s = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "}") {
        this.pos += 1;
        return { k: "fieldRef", v: s };
      }
      s += c;
      this.pos += 1;
    }
    throw new FormulaError("公式错误：未闭合字段引用");
  }

  private readIdent(): FormulaToken {
    let s = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (/[\p{L}\p{N}_]/u.test(c)) {
        s += c;
        this.pos += 1;
      } else break;
    }
    return { k: "ident", v: s };
  }
}

// ============ Parser（Pratt）============

class Parser {
  private idx = 0;
  constructor(private readonly tokens: FormulaToken[]) {}

  static parse(src: string): FormulaAST {
    const p = new Parser(new Tokenizer(src).tokenize());
    const ast = p.parseExpr(0);
    if (p.idx < p.tokens.length) throw new FormulaError("公式错误：末尾多余 token");
    return ast;
  }

  private peek(): FormulaToken | undefined {
    return this.idx < this.tokens.length ? this.tokens[this.idx] : undefined;
  }

  private bindingPower(op: string): [number, number] | null {
    switch (op) {
      case "OR":
        return [1, 2];
      case "AND":
        return [3, 4];
      case "==":
      case "!=":
      case "<":
      case ">":
      case "<=":
      case ">=":
        return [5, 6];
      case "+":
      case "-":
      case "CONCAT_OP":
        return [7, 8];
      case "*":
      case "/":
      case "%":
        return [9, 10];
      default:
        return null;
    }
  }

  private parseExpr(minBP: number): FormulaAST {
    let lhs = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.k !== "op") break;
      const bp = this.bindingPower(tok.v);
      if (!bp || bp[0] < minBP) break;
      this.idx += 1;
      const rhs = this.parseExpr(bp[1]);
      lhs = { k: "binary", op: tok.v, lhs, rhs };
    }
    return lhs;
  }

  private parsePrefix(): FormulaAST {
    const tok = this.peek();
    if (!tok) throw new FormulaError("公式错误：表达式为空");
    switch (tok.k) {
      case "number":
        this.idx += 1;
        return { k: "number", v: tok.v };
      case "string":
        this.idx += 1;
        return { k: "string", v: tok.v };
      case "fieldRef":
        this.idx += 1;
        return { k: "fieldRef", v: tok.v };
      case "ident": {
        this.idx += 1;
        const name = tok.v;
        if (name === "true") return { k: "boolean", v: true };
        if (name === "false") return { k: "boolean", v: false };
        const next = this.peek();
        if (!next || next.k !== "lparen") throw new FormulaError(`公式错误：函数 ${name} 后应为 (`);
        this.idx += 1;
        const args: FormulaAST[] = [];
        const after = this.peek();
        if (after && after.k === "rparen") {
          this.idx += 1;
          return { k: "call", name, args };
        }
        for (;;) {
          args.push(this.parseExpr(0));
          const t = this.peek();
          if (t && t.k === "comma") {
            this.idx += 1;
            continue;
          }
          if (t && t.k === "rparen") {
            this.idx += 1;
            break;
          }
          throw new FormulaError("公式错误：函数参数列表");
        }
        return { k: "call", name, args };
      }
      case "lparen": {
        this.idx += 1;
        const e = this.parseExpr(0);
        const t = this.peek();
        if (!t || t.k !== "rparen") throw new FormulaError("公式错误：缺少右括号");
        this.idx += 1;
        return e;
      }
      case "op": {
        if (tok.v === "-" || tok.v === "!") {
          this.idx += 1;
          const e = this.parseExpr(11);
          return { k: "unary", op: tok.v, expr: e };
        }
        throw new FormulaError(`公式错误：意外 token ${tok.v}`);
      }
      default:
        throw new FormulaError(`公式错误：意外 token ${tok.k}`);
    }
  }
}

// ============ Eval ============

export type FieldValueSource = (name: string) => FormulaValue;

function compareOrdered(lv: FormulaValue, rv: FormulaValue): number {
  const a = asNum(lv);
  const b = asNum(rv);
  if (a !== null && b !== null) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  return asString(lv).localeCompare(asString(rv));
}

// v1 规则：两边都是 string → 严格字符串比较（'10' ≠ '10.0'）
// 否则都能转数字 → 数值比较；其余退化为字符串
function valueEqual(lv: FormulaValue, rv: FormulaValue): boolean {
  if (lv.t === "str" && rv.t === "str") return lv.v === rv.v;
  const a = asNum(lv);
  const b = asNum(rv);
  if (a !== null && b !== null) return a === b;
  return asString(lv) === asString(rv);
}

function evalAST(ast: FormulaAST, src: FieldValueSource): FormulaValue {
  switch (ast.k) {
    case "number":
      return fnum(ast.v);
    case "string":
      return fstr(ast.v);
    case "boolean":
      return fbool(ast.v);
    case "fieldRef":
      return src(ast.v);
    case "unary": {
      const v = evalAST(ast.expr, src);
      if (ast.op === "-") return fnum(-(asNum(v) ?? 0));
      if (ast.op === "!") return fbool(!asBool(v));
      throw new FormulaError(`公式错误：意外 token ${ast.op}`);
    }
    case "binary": {
      const lv = evalAST(ast.lhs, src);
      const rv = evalAST(ast.rhs, src);
      switch (ast.op) {
        case "+": {
          // list + 任意 / 任意 + list → 列表拼接（跨表取数再组合场景）
          if (lv.t === "list" || rv.t === "list") {
            return flist([...(lv.t === "list" ? lv.v : [lv]), ...(rv.t === "list" ? rv.v : [rv])]);
          }
          const a = asNum(lv);
          const b = asNum(rv);
          // 有限性守卫：asNum 对非空非数字文本返回 NaN（如 Number("O1")），而 NaN !== null，
          // 会把「本应走文本拼接兜底」的场景误判为数值加法、产出 {t:"num",v:NaN}，
          // 序列化到接口/存储后落为 null（表现为单元格空白）。故非有限数一律退回拼接兜底。
          if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) return fnum(a + b);
          return fstr(asString(lv) + asString(rv));
        }
        case "-": {
          const a = asNum(lv);
          const b = asNum(rv);
          if (a === null || b === null) return FNULL;
          return fnum(a - b);
        }
        case "*": {
          const a = asNum(lv);
          const b = asNum(rv);
          if (a === null || b === null) return FNULL;
          return fnum(a * b);
        }
        case "/": {
          const a = asNum(lv);
          const b = asNum(rv);
          if (a === null || b === null || b === 0) return FNULL;
          return fnum(a / b);
        }
        case "%": {
          const a = asNum(lv);
          const b = asNum(rv);
          if (a === null || b === null || b === 0) return FNULL;
          return fnum(a % b);
        }
        case "CONCAT_OP":
          if (lv.t === "list" || rv.t === "list") {
            return fstr([...(lv.t === "list" ? lv.v : [lv]), ...(rv.t === "list" ? rv.v : [rv])].map(asString).join(""));
          }
          return fstr(asString(lv) + asString(rv));
        case "==":
          return fbool(valueEqual(lv, rv));
        case "!=":
          return fbool(!valueEqual(lv, rv));
        case "<":
          return fbool(compareOrdered(lv, rv) < 0);
        case ">":
          return fbool(compareOrdered(lv, rv) > 0);
        case "<=":
          return fbool(compareOrdered(lv, rv) <= 0);
        case ">=":
          return fbool(compareOrdered(lv, rv) >= 0);
        case "AND":
          return fbool(asBool(lv) && asBool(rv));
        case "OR":
          return fbool(asBool(lv) || asBool(rv));
        default:
          throw new FormulaError(`公式错误：意外 token ${ast.op}`);
      }
    }
    case "call": {
      const upper = ast.name.toUpperCase();
      return evalCall(upper, ast.args, src);
    }
  }
}

/** 把多个参数展平成数值/文本数组（list 参数展开其内元素） */
function flattenArgs(a: FormulaValue[]): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const v of a) {
    if (v.t === "list") out.push(...v.v);
    else out.push(v);
  }
  return out;
}

/** 已移除的跨表专用函数 → 给出迁移指引，而非笼统的"未知函数" */
const REMOVED_CROSS_FNS: Record<string, string> = {
  LINK_VALUES: "请改用点引用 {关联字段.子字段}（多记录自动为列表），如 SUM({订单明细.金额})",
  LINK_FIRST: "请改用点引用配合 FIRST 函数，如 FIRST({订单明细.金额})",
  LINK_LAST: "请改用点引用配合 LAST 函数，如 LAST({订单明细.金额})",
  LINK_COUNT: "请改用 LEN({关联字段.子字段}) 或 count 字段统计关联条数",
};

function evalCall(name: string, args: FormulaAST[], src: FieldValueSource): FormulaValue {
  if (name in REMOVED_CROSS_FNS) {
    throw new FormulaError(`${name} 已下线：${REMOVED_CROSS_FNS[name]}`);
  }
  const a = args.map((x) => evalAST(x, src));
  const flat = flattenArgs(a);
  const num = (i: number): number | null => (i < a.length ? asNum(a[i]!) : null);
  const str = (i: number): string => (i < a.length ? asString(a[i]!) : "");

  switch (name) {
    case "IF":
      if (a.length >= 3) return asBool(a[0]!) ? a[1]! : a[2]!;
      if (a.length === 2) return asBool(a[0]!) ? a[1]! : FNULL;
      return FNULL;
    case "SWITCH": {
      if (a.length < 3) return FNULL;
      const target = asString(a[0]!);
      let i = 1;
      while (i + 1 < a.length) {
        if (asString(a[i]!) === target) return a[i + 1]!;
        i += 2;
      }
      return a.length % 2 === 0 ? a[a.length - 1]! : FNULL;
    }
    case "CONCAT":
    case "CONCATENATE":
      return fstr(flat.map(asString).join(""));
    case "TRIM":
      return fstr(str(0).trim());
    case "UPPER":
      return fstr(str(0).toUpperCase());
    case "LOWER":
      return fstr(str(0).toLowerCase());
    case "LEN": {
      // 列表参数 → 返回元素个数；文本 → 字符数
      if (a.length === 1 && a[0]!.t === "list") return fnum(a[0]!.v.length);
      return fnum([...str(0)].length);
    }
    case "LEFT":
      return fstr([...str(0)].slice(0, Math.max(0, Math.trunc(num(1) ?? 0))).join(""));
    case "RIGHT": {
      const n = Math.max(0, Math.trunc(num(1) ?? 0));
      const chars = [...str(0)];
      return fstr(n === 0 ? "" : chars.slice(Math.max(0, chars.length - n)).join(""));
    }
    case "REPLACE":
      return fstr(str(0).split(str(1)).join(str(2)));
    case "SEARCH": {
      // v1 约定：SEARCH(within, find) — within.indexOf(find) + 1（1-based，0 = 未找到）
      const idx = str(0).indexOf(str(1));
      return fnum(idx === -1 ? 0 : idx + 1);
    }
    case "ROUND": {
      const p = Math.trunc(num(1) ?? 0);
      const m = Math.pow(10, p);
      const v = num(0) ?? 0;
      // Swift .toNearestOrAwayFromZero
      return fnum(Math.sign(v) * Math.round(Math.abs(v) * m) / m);
    }
    case "CEILING":
      return fnum(Math.ceil(num(0) ?? 0));
    case "FLOOR":
      return fnum(Math.floor(num(0) ?? 0));
    case "ABS":
      return fnum(Math.abs(num(0) ?? 0));
    case "MIN": {
      const nums = flat.map(asNum).filter((x): x is number => x !== null && Number.isFinite(x));
      return fnum(nums.length === 0 ? 0 : Math.min(...nums));
    }
    case "MAX": {
      const nums = flat.map(asNum).filter((x): x is number => x !== null && Number.isFinite(x));
      return fnum(nums.length === 0 ? 0 : Math.max(...nums));
    }
    case "FIRST": {
      // 点引用多记录→list：取首条；单标量原样返回；空→null
      const v0 = a[0] ?? FNULL;
      if (v0.t === "list") return v0.v[0] ?? FNULL;
      return v0;
    }
    case "LAST": {
      const v0 = a[0] ?? FNULL;
      if (v0.t === "list") return v0.v[v0.v.length - 1] ?? FNULL;
      return v0;
    }
    case "ISNULL":
      return fbool(a.length === 0 ? true : a[0]!.t === "null");
    case "BLANK":
      return FNULL;
    case "NOW":
      return fstr(new Date().toISOString());
    case "TODAY":
      return fstr(new Date().toISOString().slice(0, 10));
    case "AND":
      return fbool(a.every(asBool));
    case "OR":
    case "OR_F":
      return fbool(a.some(asBool));
    case "NOT":
      return fbool(!(a.length > 0 && asBool(a[0]!)));
    case "SQRT":
      return fnum(Math.sqrt(num(0) ?? 0));
    case "POWER":
      return fnum(Math.pow(num(0) ?? 0, num(1) ?? 0));
    case "MOD": {
      const x = num(0);
      const y = num(1);
      if (x === null || y === null || y === 0) return FNULL;
      return fnum(x % y);
    }
    case "INT":
      return fnum(Math.trunc(num(0) ?? 0));
    case "AVERAGE": {
      const nums = flat.map(asNum).filter((x): x is number => x !== null && Number.isFinite(x));
      return fnum(nums.length === 0 ? 0 : nums.reduce((s, x) => s + x, 0) / nums.length);
    }
    case "SUM": {
      // 非数字文本 asNum→NaN 被过滤，绝不静默产出 NaN；空关联/纯文本列表求和为 0
      const nums = flat.map(asNum).filter((x): x is number => x !== null && Number.isFinite(x));
      return fnum(nums.reduce((s, x) => s + x, 0));
    }
    case "SUBSTR": {
      const s = [...str(0)];
      const start = Math.max(0, Math.trunc(num(1) ?? 1) - 1);
      const len = num(2);
      return fstr(len === null ? s.slice(start).join("") : s.slice(start, start + Math.max(0, Math.trunc(len))).join(""));
    }
    case "REPT":
      return fstr(str(0).repeat(Math.max(0, Math.trunc(num(1) ?? 0))));
    case "DATETIME_DIFF": {
      const d1 = new Date(str(0)).getTime();
      const d2 = new Date(str(1)).getTime();
      if (Number.isNaN(d1) || Number.isNaN(d2)) return FNULL;
      const unit = (str(2) || "days").toLowerCase();
      const ms = d1 - d2;
      const per: Record<string, number> = {
        milliseconds: 1,
        seconds: 1000,
        minutes: 60_000,
        hours: 3_600_000,
        days: 86_400_000,
        weeks: 604_800_000,
      };
      return fnum(ms / (per[unit] ?? per.days!));
    }
    case "DATEADD": {
      const s0 = str(0);
      const days = Math.trunc(num(1) ?? 0);
      // U-10：纯日期（YYYY-MM-DD）按 UTC 日历日加减并原样回纯日期——
      // 原先一律走本地时区 setDate + toISOString，负时区会跨日、且纯日期输入被升级为 datetime 形态。
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s0.trim());
      if (dm) {
        const d = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])));
        d.setUTCDate(d.getUTCDate() + days);
        return fstr(d.toISOString().slice(0, 10));
      }
      const d = new Date(s0);
      if (Number.isNaN(d.getTime())) return FNULL;
      d.setDate(d.getDate() + days);
      return fstr(d.toISOString());
    }
    default:
      throw new FormulaError(`公式错误：未知函数 ${name}`);
  }
}

// ============ 公开入口 ============

// U-2 子项：公式 AST 缓存。hydrate 全表 N 条记录对同一公式重复 Parser.parse N 次，
// 而 AST 是纯数据（evalAST 只读），按源码串缓存即可。上限 500 条，FIFO 淘汰防无界增长。
const astCache = new Map<string, FormulaAST>();
const AST_CACHE_MAX = 500;
function parseCached(src: string): FormulaAST {
  const hit = astCache.get(src);
  if (hit) return hit;
  const ast = Parser.parse(src);
  if (astCache.size >= AST_CACHE_MAX) {
    const oldest = astCache.keys().next().value;
    if (oldest !== undefined) astCache.delete(oldest);
  }
  astCache.set(src, ast);
  return ast;
}

/** 解析不求值（用于 UI 实时校验） */
export function parseFormula(src: string): FormulaAST {
  return parseCached(src);
}

/** 提取公式里引用的顶层字段名（用于依赖分析 / 循环检测） */
export function formulaFieldRefs(src: string): string[] {
  try {
    const ast = parseCached(src);
    const out = new Set<string>();
    const walk = (n: FormulaAST) => {
      switch (n.k) {
        case "fieldRef":
          out.add(n.v);
          break;
        case "unary":
          walk(n.expr);
          break;
        case "binary":
          walk(n.lhs);
          walk(n.rhs);
          break;
        case "call":
          n.args.forEach(walk);
          break;
        default:
          break;
      }
    };
    walk(ast);
    return [...out];
  } catch {
    return [];
  }
}

/** 求值入口：返回 FormulaValue；出错抛 FormulaError */
export function evaluateFormula(
  src: string,
  values: (name: string) => FormulaValue,
): FormulaValue {
  return evalAST(parseCached(src), values);
}

/**
 * 容错求值：出错时返回 null 并在 error 里带消息。
 * 列表渲染走这个入口——单条记录公式错误不应该炸掉整个视图（v1 行为一致）。
 */
export function safeEvaluateFormula(
  src: string,
  values: (name: string) => FormulaValue,
): { value: FormulaValue; error: string | null } {
  try {
    return { value: evalAST(parseCached(src), values), error: null };
  } catch (e) {
    return { value: FNULL, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============ 输出类型推断（字段保存时校验：公式结果类型必须与字段类型匹配） ============

export type FormulaOutType = "num" | "str" | "bool" | "date" | "list" | "any";

/** 函数返回类型表（与 evalCall 实现一一对应） */
const FN_RETURN: Record<string, FormulaOutType> = {
  SUM: "num", ROUND: "num", CEILING: "num", FLOOR: "num", ABS: "num",
  MIN: "num", MAX: "num", SQRT: "num", POWER: "num", MOD: "num",
  INT: "num", AVERAGE: "num", LEN: "num", SEARCH: "num", DATETIME_DIFF: "num",
  CONCAT: "str", CONCATENATE: "str", TRIM: "str", UPPER: "str", LOWER: "str",
  LEFT: "str", RIGHT: "str", REPLACE: "str", SUBSTR: "str", REPT: "str",
  FIRST: "any", LAST: "any",
  NOW: "date", TODAY: "date", DATEADD: "date",
  AND: "bool", OR: "bool", OR_F: "bool", NOT: "bool", ISNULL: "bool",
  BLANK: "any",
};

function inferAST(
  ast: FormulaAST,
  fieldGroup: (name: string) => string | undefined,
): Set<FormulaOutType> {
  switch (ast.k) {
    case "number":
      return new Set(["num"]);
    case "string":
      return new Set(["str"]);
    case "boolean":
      return new Set(["bool"]);
    case "fieldRef": {
      const g = fieldGroup(ast.v);
      if (g === "number") return new Set(["num"]);
      if (g === "date") return new Set(["date"]);
      if (g === "bool") return new Set(["bool"]);
      if (g === "link") return new Set(["list", "str"]);
      // text / select / 未知字段：文本语境
      return new Set(["str"]);
    }
    case "unary":
      return ast.op === "-" ? new Set(["num"]) : new Set(["bool"]);
    case "binary": {
      switch (ast.op) {
        case "==":
        case "!=":
        case "<":
        case ">":
        case "<=":
        case ">=":
        case "AND":
        case "OR":
          return new Set(["bool"]);
        case "CONCAT_OP":
          return new Set(["str"]);
        case "+": {
          // 精确推断：两侧均可作数值 → 数值相加；任一为文本 → 字符串拼接。
          // 避免「1+2」这类纯数值表达式被误判为"可能产文本"而放行到文本字段。
          const L = inferAST(ast.lhs, fieldGroup);
          const R = inferAST(ast.rhs, fieldGroup);
          const out = new Set<FormulaOutType>();
          const lNum = L.has("num") || L.has("date");
          const rNum = R.has("num") || R.has("date");
          if (lNum && rNum) out.add("num");
          if (L.has("str") || R.has("str")) out.add("str");
          if (L.has("any") || R.has("any")) {
            out.add("num");
            out.add("str");
          }
          if (out.size === 0) out.add("num"); // bool 等相加按数值兜底
          return out;
        }
        default: // - * / % 等算术运算：结果恒为数值
          return new Set(["num"]);
      }
    }
    case "call": {
      const upper = ast.name.toUpperCase();
      if (upper === "IF") {
        // IF(cond, then, else?)：返回分支类型的并集
        const out = new Set<FormulaOutType>();
        for (let i = 1; i < ast.args.length; i++) inferAST(ast.args[i]!, fieldGroup).forEach((t) => out.add(t));
        if (out.size === 0) out.add("any");
        return out;
      }
      if (upper === "SWITCH") {
        const out = new Set<FormulaOutType>();
        for (let i = 1; i < ast.args.length; i += 2) {
          if (ast.args[i + 1]) inferAST(ast.args[i + 1]!, fieldGroup).forEach((t) => out.add(t));
        }
        // 奇数个参数时最后一个是 default
        if (ast.args.length % 2 === 0 && ast.args[ast.args.length - 1]) {
          inferAST(ast.args[ast.args.length - 1]!, fieldGroup).forEach((t) => out.add(t));
        }
        if (out.size === 0) out.add("any");
        return out;
      }
      const t = FN_RETURN[upper];
      return new Set([t ?? "any"]);
    }
  }
}

/**
 * 校验公式输出类型是否与宿主字段类型匹配。
 * @param src 公式文本
 * @param hostFieldType 宿主字段类型（formula 字段本身，或配置了 formula 默认内容的字段）
 * @param fieldTypeByName 按字段名查字段类型（公式用 {字段名} 引用）
 * @returns 错误消息（中文）；null 表示通过
 */
export function validateFormulaOutput(
  src: string,
  hostFieldType: string,
  fieldTypeByName: (name: string) => string | undefined,
): string | null {
  const trimmed = (src ?? "").trim();
  if (!trimmed) return "公式不能为空";
  let ast: FormulaAST;
  try {
    ast = Parser.parse(trimmed);
  } catch (e) {
    return e instanceof Error ? e.message : "公式语法错误";
  }
  const types = inferAST(ast, fieldTypeByName);

  const expect = ((): FormulaOutType => {
    const numTypes = ["number", "currency", "percent", "duration", "rating"];
    const dateTypes = ["date", "datetime"];
    if (numTypes.includes(hostFieldType)) return "num";
    if (dateTypes.includes(hostFieldType)) return "date";
    if (hostFieldType === "checkbox") return "bool";
    return "str";
  })();

  const expectLabel: Record<FormulaOutType, string> = {
    num: "数值",
    str: "文本",
    bool: "布尔（真/假）",
    date: "日期",
    list: "列表",
    any: "任意",
  };

  // any 视为通融（IF 空分支/FIRST 等动态情形）；list 不能作为标量字段输出
  if (types.has("any")) return null;
  if (!types.has(expect)) {
    return `公式输出类型与字段类型不匹配：该字段要求公式结果为「${expectLabel[expect]}」，但当前公式产出的是「${[...types].map((t) => expectLabel[t]).join(" / ")}」。请调整公式（例如数值字段用 SUM/ROUND 等数值函数，文本字段用 CONCAT/LEFT 等文本函数）。`;
  }
  return null;
}
