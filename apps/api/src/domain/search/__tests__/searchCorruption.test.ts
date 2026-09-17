// M5/S12 损坏分类 + 物理隔离纯函数单测（临时真文件，无 app/无迁移）。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isCorruptionError,
  SearchStoreCorruptError,
  quarantineCorruptFiles,
} from "../searchCorruption.js";

describe("isCorruptionError 分类", () => {
  it("SQLITE_NOTADB / SQLITE_CORRUPT 码（含 cause.code 包装）判损坏", () => {
    expect(isCorruptionError({ code: "SQLITE_NOTADB" })).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("wrap"), { cause: { code: "SQLITE_CORRUPT" } }))).toBe(true);
  });
  it("malformed/not-a-database 消息兜底判损坏", () => {
    expect(isCorruptionError(new Error("SqliteError: database disk image is malformed"))).toBe(true);
    expect(isCorruptionError(new Error("SqliteError: file is not a database"))).toBe(true);
    expect(isCorruptionError(new Error("file is encrypted or is not a database"))).toBe(true);
  });
  it("缺文件/打不开目录（SQLITE_CANTOPEN）与普通错误不算损坏", () => {
    expect(isCorruptionError({ code: "SQLITE_CANTOPEN" })).toBe(false);
    expect(isCorruptionError(new Error("unrelated failure"))).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
  });
  it("SearchStoreCorruptError 自身被判损坏且携带路径", () => {
    const e = new SearchStoreCorruptError("/tmp/x/search.db", new Error("bad"));
    expect(isCorruptionError(e)).toBe(true);
    expect(e.filePath).toBe("/tmp/x/search.db");
    expect(e.message).toContain("/tmp/x/search.db");
  });
});

describe("quarantineCorruptFiles 三件隔离（rename，不删除）", () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s12-quar-")); file = path.join(dir, "search.db"); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("主库+wal+shm 一起 rename 成同 .corrupt-<ts>，原路径全空，证据可读", () => {
    fs.writeFileSync(file, "MAIN");
    fs.writeFileSync(`${file}-wal`, "WAL");
    fs.writeFileSync(`${file}-shm`, "SHM");
    const r = quarantineCorruptFiles(file, 1700000000000);
    expect(r.moved).toHaveLength(3);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
    expect(fs.readFileSync(r.quarantinedPath, "utf8")).toBe("MAIN");
    expect(fs.readFileSync(`${file}.corrupt-1700000000000-wal`, "utf8")).toBe("WAL");
    expect(fs.readFileSync(`${file}.corrupt-1700000000000-shm`, "utf8")).toBe("SHM");
  });

  it("只有主库（无 sidecar）也成功，moved 仅 1 件", () => {
    fs.writeFileSync(file, "ONLY");
    const r = quarantineCorruptFiles(file, 1700000000001);
    expect(r.moved).toEqual([`${file}.corrupt-1700000000001`]);
  });

  it("主库不存在 -> 抛错（缺文件是懒初始化场景，绝不走隔离）", () => {
    expect(() => quarantineCorruptFiles(file)).toThrow(/不存在/);
  });

  it("同毫秒二次隔离不覆盖证据，追加 -2 后缀", () => {
    fs.writeFileSync(file, "A");
    const first = quarantineCorruptFiles(file, 1700000000002);
    fs.writeFileSync(file, "B");
    const second = quarantineCorruptFiles(file, 1700000000002);
    expect(first.quarantinedPath.endsWith(".corrupt-1700000000002")).toBe(true);
    expect(second.quarantinedPath.endsWith(".corrupt-1700000000002-2")).toBe(true);
    expect(fs.readFileSync(first.quarantinedPath, "utf8")).toBe("A");
    expect(fs.readFileSync(second.quarantinedPath, "utf8")).toBe("B");
  });
});
