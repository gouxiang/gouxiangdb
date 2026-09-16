// M5/S2 vecLoader 单测：平台映射 / 路径解析（GX_VEC_EXT_PATH > native/<triplet> > node_modules）/
// vec0 真实加载与坏路径可捕获降级（H7/H8）/ BigInt 与 Float32-BLOB 绑定 helper（H2/H3）。

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  VEC_ENTRY_BASENAME,
  describeVecPlatform,
  bundledVecPath,
  resolveVecPath,
  loadVec0,
  readVecVersion,
  vecInt,
  vecBlob,
} from "../vecLoader.js";

const exists = (set: Set<string>) => (p: string) => set.has(p);
const appDir = "/app";

describe("describeVecPlatform", () => {
  it("五个受支持 os/cpu 映射到正确 triplet/ext/子包", () => {
    expect(describeVecPlatform("darwin", "arm64")).toMatchObject({
      triplet: "darwin-arm64", ext: "dylib", subPackage: "sqlite-vec-darwin-arm64", supported: true,
    });
    expect(describeVecPlatform("darwin", "x64").triplet).toBe("darwin-x64");
    expect(describeVecPlatform("linux", "x64")).toMatchObject({ ext: "so", subPackage: "sqlite-vec-linux-x64" });
    expect(describeVecPlatform("linux", "arm64").triplet).toBe("linux-arm64");
    expect(describeVecPlatform("win32", "x64")).toMatchObject({ ext: "dll", subPackage: "sqlite-vec-windows-x64" });
  });

  it("不支持平台（win32-arm64/linux ia32）supported=false，加载侧据此直接降级", () => {
    expect(describeVecPlatform("win32", "arm64").supported).toBe(false);
    expect(describeVecPlatform("linux", "ia32").supported).toBe(false);
    expect(describeVecPlatform("freebsd", "x64").supported).toBe(false);
  });

  it("入口文件名恒 vec0（H7），bundled 路径按 triplet 分目录不改名", () => {
    expect(VEC_ENTRY_BASENAME).toBe("vec0");
    expect(bundledVecPath(appDir, describeVecPlatform("linux", "x64")))
      .toBe(path.join("/app", "native", "linux-x64", "vec0.so"));
    expect(bundledVecPath(appDir, describeVecPlatform("darwin", "arm64")))
      .toBe(path.join("/app", "native", "darwin-arm64", "vec0.dylib"));
  });
});

describe("resolveVecPath", () => {
  const linuxX64 = describeVecPlatform("linux", "x64");
  const bundled = path.join(appDir, "native", "linux-x64", "vec0.so");
  const pkgPath = path.join("/node_modules/sqlite-vec-linux-x64", "vec0.so");
  const pkgResolver = () => pkgPath;

  it("优先级1：GX_VEC_EXT_PATH 指向文件（绝对/相对）直接命中", () => {
    const abs = "/opt/vec/vec0.so";
    expect(resolveVecPath(abs, appDir, linuxX64, exists(new Set([abs])), pkgResolver)).toBe(abs);
    const rel = resolveVecPath("vendor/vec0.so", appDir, linuxX64,
      exists(new Set([path.resolve(appDir, "vendor/vec0.so")])), pkgResolver);
    expect(rel).toBe(path.resolve(appDir, "vendor/vec0.so"));
  });

  it("优先级1：env 给目录则拼恒名 vec0.so（不据 env 改名，H7）", () => {
    const dir = "/opt/vec";
    expect(resolveVecPath(dir, appDir, linuxX64, exists(new Set([path.join(dir, "vec0.so")])), pkgResolver))
      .toBe(path.join(dir, "vec0.so"));
  });

  it("优先级2：env 缺失时用 native/<triplet>/vec0 白名单拷贝", () => {
    expect(resolveVecPath(undefined, appDir, linuxX64, exists(new Set([bundled])), pkgResolver)).toBe(bundled);
  });

  it("优先级3：前两者无，回退 node_modules 平台子包解析", () => {
    expect(resolveVecPath(undefined, appDir, linuxX64, exists(new Set([pkgPath])), pkgResolver)).toBe(pkgPath);
  });

  it("三候选皆无 -> null（调用方降级，不抛）", () => {
    expect(resolveVecPath(undefined, appDir, linuxX64, exists(new Set()), () => null)).toBeNull();
  });

  it("不支持平台 -> 恒 null（不尝试 dlopen）", () => {
    expect(resolveVecPath(undefined, appDir, describeVecPlatform("linux", "ia32"),
      exists(new Set(["/anything"])), pkgResolver)).toBeNull();
  });
});

describe("loadVec0 真实加载（本机 darwin-arm64）", () => {
  it("vec0 加载成功且 vec_version 可读（H1）", () => {
    const db = new Database(":memory:");
    const r = loadVec0(db, { appDir: process.cwd() });
    // 本机已装 sqlite-vec 平台子包，应命中 node_modules 候选。
    expect(r.vecAvailable).toBe(true);
    expect(r.path).toMatch(/vec0\.dylib$/);
    expect(r.error).toBeNull();
    const v = readVecVersion(db);
    expect(v).toMatch(/^v?\d+\.\d+\.\d+$/);
    db.close();
  });

  it("坏路径/损坏扩展 -> 可捕获异常，vecAvailable=false 且进程存活（H8）", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-vec-bad-"));
    // 内容不是有效 Mach-O/ELF，loadExtension 必抛；路径文件名保持恒名 vec0.dylib（H7）。
    const bad = path.join(tmpDir, "vec0.dylib");
    fs.writeFileSync(bad, Buffer.from("this is definitely not a loadable extension", "utf8"));
    const db = new Database(":memory:");
    const r = loadVec0(db, { appDir: process.cwd(), envPath: bad });
    expect(r.vecAvailable).toBe(false);
    expect(r.path).toBe(bad);
    expect(r.error).toBeTruthy();
    // 连接仍可正常使用（FTS5 不依赖 vec0），主流程不 crash。
    db.exec("CREATE VIRTUAL TABLE f USING fts5(t)");
    db.prepare("INSERT INTO f(t) VALUES (?)").run("hello");
    expect(db.prepare("SELECT count(*) c FROM f").get()).toEqual({ c: 1 });
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("缺失（三候选皆无）-> vecAvailable=false，error 说明 not found，不抛", () => {
    const db = new Database(":memory:");
    const r = loadVec0(db, {
      appDir: process.cwd(),
      platformInfo: describeVecPlatform("linux", "x64"),
      // 模拟目标机未装平台子包（musl/打包遗漏）：node_modules 回退返回 null。
      resolvePackage: () => null,
    });
    // native/ 无白名单拷贝 + 包回退 null -> 降级。
    expect(r.vecAvailable).toBe(false);
    expect(r.error).toMatch(/vec0 not found|unavailable/);
    db.close();
  });

  it("不支持平台不 dlopen：vecAvailable=false 且不抛", () => {
    const db = new Database(":memory:");
    const r = loadVec0(db, { appDir: process.cwd(), platformInfo: describeVecPlatform("linux", "ia32") });
    expect(r.vecAvailable).toBe(false);
    expect(r.error).toMatch(/unsupported platform/);
    db.close();
  });
});

describe("vecInt / vecBlob 绑定铁律（H2/H3）", () => {
  it("vecInt：安全整数与 bigint -> bigint；非安全数/非数值抛 TypeError", () => {
    expect(vecInt(1)).toBe(1n);
    expect(vecInt(1789528289729n)).toBe(1789528289729n);
    expect(() => vecInt(1.5)).toThrow(TypeError);
    expect(() => vecInt(Number.NaN)).toThrow(TypeError);
    expect(() => vecInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it("vecBlob：Float32Array 转 4 字节/元素小端 BLOB；普通数组等价", () => {
    const a = new Float32Array([1, 0.5, -2]);
    const blob = vecBlob(a);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.length).toBe(12);
    expect(blob.equals(Buffer.from(new Float32Array([1, 0.5, -2]).buffer))).toBe(true);
    expect(vecBlob([1, 0.5, -2]).length).toBe(12);
  });

  it("vec0 实测：number 绑定 rowid/INTEGER 元数据被拒（H2 钉死），bigint 成功", () => {
    const db = new Database(":memory:");
    loadVec0(db, { appDir: process.cwd() });
    db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[2], etype INTEGER)");
    const blob = vecBlob([1, 0]);
    expect(() => db.prepare("INSERT INTO v(rowid, embedding, etype) VALUES (?,?,?)").run(1, blob, 1n))
      .toThrow(/[Ii]nteger/);
    expect(() => db.prepare("INSERT INTO v(rowid, embedding, etype) VALUES (?,?,?)").run(1n, blob, 1))
      .toThrow(/FLOAT|[Ii]nteger/);
    db.prepare("INSERT INTO v(rowid, embedding, etype) VALUES (?,?,?)").run(7n, blob, 1n);
    expect(db.prepare("SELECT count(*) c FROM v").get()).toEqual({ c: 1 });
    db.close();
  });
});
