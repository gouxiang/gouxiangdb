#!/usr/bin/env node
// apps/api/scripts/collab-smoke.mjs
// 阶段 1 协同底座的硬验收：**对真实启动的 API 进程**用手写 y-protocols 客户端做断言。
//
//   node apps/api/scripts/collab-smoke.mjs          （退出码 0 = 全绿，非 0 = 有断言失败）
//
// 跑法（脚本自己拉起服务，不需要预先起）：
//   1) 用 better-sqlite3 把 apps/api/prisma/dev.db 备份到临时目录（不污染开发库），
//      再插入本次专用夹具：编辑者 = role_owner（超级管理员，全权可写）、
//      只读者 = role_admin（管理员，可见但该库无管理权 → 只读，见 libraryPolicy.ts）；
//   2) 起真实 API 进程（tsx src/index.ts），DATABASE_URL 指向临时库，
//      GX_BASE_PATH=/gxs（顺带验 basePath 剥离与 wsPath 拼装）；
//   3) 用 .env 的 JWT_SECRET 按 domain/org/authState.ts:44 issueToken 的载荷
//      { userId, tv, iat, exp } 本地签 HS256 JWT，走 X-GX-Token 头换票据；
//   4) 断言逐条执行，任一条失败即打印服务端日志尾部并非零退出。
//
// 客户端实现在同目录 collab-smoke-client.mjs（按单文件 ≤300 行拆出，无新增依赖）。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as Y from "yjs";
import {
  CollabClient,
  MSG,
  SYNC_SUB,
  bytesVarUint8Array,
  concat,
  frameSubType,
  rawConnect,
  varUintBytes,
  waitClose,
} from "./collab-smoke-client.mjs";
import {
  API_DIR,
  Database,
  freePort,
  prepareTempDb,
  readEnvFile,
  seedFixtures,
  signJwt,
  waitHealth,
} from "./collab-smoke-fixtures.mjs";

const BASE_PATH = "/gxs";
const ROOM = "doc:doc_smoke";

// ---------------------------------------------------------------- 主流程

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${e && e.message ? e.message : e}`);
  }
}

async function main() {
  const envFile = readEnvFile(path.join(API_DIR, ".env"));
  const jwtSecret = envFile.JWT_SECRET;
  assert.ok(jwtSecret, "apps/api/.env 里缺少 JWT_SECRET");

  const { tmpDir, dbPath } = await prepareTempDb();
  seedFixtures(dbPath);
  console.log(`[smoke] 临时库 ${dbPath}（dev.db 副本 + 本次夹具）`);

  const port = await freePort();
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbPath}`,
      JWT_SECRET: jwtSecret,
      PORT: String(port),
      GX_BASE_PATH: BASE_PATH,
      GX_WEB_DIST: "",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  const live = !!process.env.GX_SMOKE_DEBUG;
  const collect = (d) => {
    serverLog.push(d.toString());
    if (live) process.stdout.write(d);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(tmpDir, { force: true, recursive: true });
  };

  try {
    await waitHealth(port);
    const base = `http://127.0.0.1:${port}${BASE_PATH}`;
    const editorJwt = signJwt("u_smoke_editor", 0, jwtSecret);
    const viewerJwt = signJwt("u_smoke_viewer", 0, jwtSecret);

    const ticket = async (jwt, rid) => {
      const res = await fetch(`${base}/api/collab/ticket?roomId=${encodeURIComponent(rid)}`, {
        headers: { "X-GX-Token": jwt },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const t1 = await ticket(editorJwt, ROOM);
    assert.equal(t1.status, 200, `编辑者票据应 200，实为 ${t1.status}`);
    assert.equal(t1.body.role, "editor", "编辑者角色应为 editor");
    assert.ok(t1.body.wsPath.startsWith(`${BASE_PATH}/ws/collab/`), `wsPath 应带 basePath：${t1.body.wsPath}`);
    const wsBase = `ws://127.0.0.1:${port}${t1.body.wsPath}`;

    console.log("\n[1] 双向广播（A 写 → B 收到；B 写 → A 收到）");
    const a = new CollabClient(`${wsBase}?t=${t1.body.ticket}`, { nick: "甲" });
    const t2 = await ticket(editorJwt, ROOM);
    const b = new CollabClient(`${wsBase}?t=${t2.body.ticket}`, { nick: "乙" });
    await a.open();
    await b.open();

    await check("A 插入后 B 收敛", async () => {
      a.insert("你好协同");
      await b.waitFor(() => b.text() === "你好协同", "B 收到 A 的文本");
      assert.equal(b.text(), "你好协同");
    });
    await check("B 插入后 A 收敛", async () => {
      b.insert("-收到");
      await a.waitFor(() => a.text() === "你好协同-收到", "A 收到 B 的文本");
      assert.equal(a.text(), "你好协同-收到");
    });

    console.log("\n[附加] presence 端点返回在线名单");
    await check("presence 至少两条且配色由服务端下发", async () => {
      const res = await fetch(`${base}/api/collab/presence?roomId=${encodeURIComponent(ROOM)}`, {
        headers: { "X-GX-Token": editorJwt },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(
        body.entries.length >= 2,
        `在线条目应 >=2，实为 ${body.entries.length}：${JSON.stringify(body.entries)}`,
      );
      assert.ok(body.entries.every((e) => /^#[0-9A-Fa-f]{6}$/.test(e.color)), "配色必须服务端下发");
    });

    console.log("\n[2] 无票据 / 伪造票据 → 4401（先 accept 再 close，非 1006）");
    await check("无票据 → 4401", async () => {
      const conn = await rawConnect(wsBase);
      assert.equal(await waitClose(conn, "无票据"), 4401);
    });
    await check("伪造票据 → 4401", async () => {
      const conn = await rawConnect(`${wsBase}?t=${"z".repeat(32)}`);
      assert.equal(await waitClose(conn, "伪造票据"), 4401);
    });

    console.log("\n[3] 同一票据第二次使用 → 4401（单次核销）");
    await check("票据单次核销", async () => {
      const once = await ticket(editorJwt, ROOM);
      const first = await rawConnect(`${wsBase}?t=${once.body.ticket}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(first.closeCode, null, "首次使用不应被关闭");
      const second = await rawConnect(`${wsBase}?t=${once.body.ticket}`);
      assert.equal(await waitClose(second, "二次核销"), 4401);
      first.ws.close();
    });

    console.log("\n[4] 只读连接：sync update → 4403；sync step1 正常收 step2");
    await check("只读读放行、写被拒", async () => {
      const vt = await ticket(viewerJwt, ROOM);
      assert.equal(vt.status, 200);
      assert.equal(vt.body.role, "viewer", "管理员对该库应为只读档位");
      const conn = await rawConnect(`ws://127.0.0.1:${port}${vt.body.wsPath}?t=${vt.body.ticket}`);
      // 手工发 sync step1：varUint(0) varUint(0) varUint8Array(状态向量)
      const sv = bytesVarUint8Array(Y.encodeStateVector(new Y.Doc()));
      conn.ws.send(concat([varUintBytes(MSG.SYNC), varUintBytes(SYNC_SUB.STEP1), sv]));
      const started = Date.now();
      while (!conn.frames.some((f) => frameSubType(f) === SYNC_SUB.STEP2)) {
        if (Date.now() - started > 6000) throw new Error("只读连接未收到 step2（读被误伤）");
        await new Promise((r) => setTimeout(r, 50));
      }
      const tmp = new Y.Doc();
      tmp.getText("body").insert(0, "只读也想写");
      conn.ws.send(
        concat([
          varUintBytes(MSG.SYNC),
          varUintBytes(SYNC_SUB.UPDATE),
          bytesVarUint8Array(Y.encodeStateAsUpdate(tmp)),
        ]),
      );
      assert.equal(await waitClose(conn, "只读写被拒"), 4403);
    });

    console.log("\n[5] 房间空置后落盘 + 重连收敛");
    const before = a.text();
    await check("断开后 collab_docs 出现该 room 行（seq>=1）", async () => {
      a.close();
      b.close();
      await new Promise((r) => setTimeout(r, 1200));
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT seq, length(state) AS n FROM collab_docs WHERE room_id = ?").get(ROOM);
      db.close();
      assert.ok(row, "collab_docs 应出现该 room 行");
      assert.ok(row.seq >= 1, `seq 应 >=1，实为 ${row.seq}`);
      assert.ok(row.n > 0, "state 应非空");
      console.log(`      seq=${row.seq} stateBytes=${row.n}`);
    });
    await check("重连拿到之前的内容", async () => {
      const t3 = await ticket(editorJwt, ROOM);
      const c = new CollabClient(`${wsBase}?t=${t3.body.ticket}`, { nick: "丙" });
      await c.open();
      await c.waitFor(() => c.text() === before, "重连收敛到落盘内容");
      assert.equal(c.text(), before, `应为 ${before}，实为 ${c.text()}`);
      c.close();
    });

    console.log("\n[6] 非法 roomId → HTTP 400");
    await check("foo:bar → 400", async () => {
      const r = await ticket(editorJwt, "foo:bar");
      assert.equal(r.status, 400, `应为 400，实为 ${r.status}`);
    });
    await check("table:x → 400（阶段 3 才开）", async () => {
      const r = await ticket(editorJwt, "table:x");
      assert.equal(r.status, 400, `应为 400，实为 ${r.status}`);
    });

    console.log("\n[7] 非 doc/canvas 的 roomId 不产生 collab_docs 行");
    await check("collab_docs 无越界 room", async () => {
      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare("SELECT room_id FROM collab_docs WHERE room_id NOT LIKE 'doc:%' AND room_id NOT LIKE 'canvas:%'")
        .all();
      db.close();
      assert.equal(rows.length, 0, `越界 room：${rows.map((r) => r.room_id).join(", ")}`);
    });
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] 断言 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log("[smoke] 服务端日志尾部：\n" + serverLog.join("").split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  console.log("[smoke] ALL PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] 致命错误：", e);
  process.exit(1);
});
