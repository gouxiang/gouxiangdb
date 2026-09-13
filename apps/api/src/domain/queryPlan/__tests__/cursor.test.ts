// M1/S7：keyset 不透明游标编解码 + 客户端错误类型。
import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  InvalidCursorError,
  OffsetWindowError,
} from "../cursor.js";

describe("encodeCursor/decodeCursor", () => {
  it("null 往返：encode(null)→null", () => {
    expect(encodeCursor(null)).toBeNull();
  });

  it("合法令牌往返，c/id 逐值还原", () => {
    const tok = { c: Date.parse("2026-02-01T00:00:00.123Z"), id: "cm9abcDEF123" };
    const raw = encodeCursor(tok);
    expect(typeof raw).toBe("string");
    expect(raw).not.toContain("{"); // base64url，不泄露 JSON 明文结构
    expect(decodeCursor(raw)).toEqual(tok);
  });

  it("令牌不透明：不含明文 id 子串之外的可注入 SQL 字符（无引号/分号/空白）", () => {
    const raw = encodeCursor({ c: 1, id: "x" })!;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("非法输入一律 null（不抛、不猜）", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(123)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("not-json", "utf8").toString("base64url"))).toBeNull();
  });

  it("结构/版本/值域不符一律 null", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(decodeCursor(enc({ v: 2, c: 1, id: "a" }))).toBeNull(); // 版本不符
    expect(decodeCursor(enc({ c: 1, id: "a" }))).toBeNull(); // 缺版本
    expect(decodeCursor(enc({ v: 1, c: -1, id: "a" }))).toBeNull(); // 负毫秒
    expect(decodeCursor(enc({ v: 1, c: 1.5, id: "a" }))).toBeNull(); // 非整数
    expect(decodeCursor(enc({ v: 1, c: Number.MAX_SAFE_INTEGER + 1, id: "a" }))).toBeNull();
    expect(decodeCursor(enc({ v: 1, c: "1", id: "a" }))).toBeNull(); // c 非 number
    expect(decodeCursor(enc({ v: 1, c: 1, id: "" }))).toBeNull(); // 空 id
    expect(decodeCursor(enc({ v: 1, c: 1, id: 1 }))).toBeNull(); // id 非 string
    expect(decodeCursor(enc([1, 2, 3]))).toBeNull(); // 非对象
  });

  it("超长令牌（>512）拒绝，防伪造巨载荷", () => {
    const raw = encodeCursor({ c: 1, id: "a".repeat(600) })!;
    expect(raw.length).toBeGreaterThan(512);
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe("客户端错误类型", () => {
  it("InvalidCursorError 默认文案引导回首页，name 固定", () => {
    const e = new InvalidCursorError();
    expect(e.name).toBe("InvalidCursorError");
    expect(e.message).toContain("第一页");
  });

  it("OffsetWindowError 携带 limit/pages 且文案含上界行数", () => {
    const e = new OffsetWindowError(200, 5);
    expect(e.name).toBe("OffsetWindowError");
    expect(e.limit).toBe(200);
    expect(e.pages).toBe(5);
    expect(e.message).toContain("1000");
  });
});
