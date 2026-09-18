// scripts/acceptance/rollback/check-mounts.mjs
// 门③ R1(org off) / R2(nav off) / R7(mcp 摘除) 挂载面探针。
//
// 读码核实的挂载契约（apps/api/src/app.ts:144-159, routes/v1/index.ts:30-74）：
//   - 旧 /api（/auth /bases /tables /records /views /kb /public /search）始终挂载；
//   - 顶层 /mcp 与 /api/v1/auth/invite 仅 enterpriseOrg on 时挂载；
//   - /api/v1 仅在 org||nav 任一 on 时挂载；挂在后 v1.use("*", requireActiveUser)
//     —— 故所有 v1 探针（含期望 404 的）都必须带有效 ACTIVE token，否则得 401 而非路由 404；
//   - /api/v1/org|/pats|/meta 仅 org on；/api/v1/workspaces|/nav|/nodes 仅 nav on。
//
// 子命令：baseline | orgoff | navoff
//   baseline：全开姿态，org/nav/mcp/pats/tree 全部可达（证明种子库确实全开，off 404 才有意义）。
//   orgoff ：nav 仍 on，org/mcp/pats 摘除 => R1 + R7。
//   navoff ：org 仍 on，nav/workspaces 摘除，org/pats 仍在 => R2。

import { parseArgs, loadContext, http, HitCounter, expectStatus, runCheck } from "./probe.mjs";

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode;
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], `mounts:${mode}`);
  const base = ctx.baseUrl;
  const T = ctx.tokens.owner;

  const get = (path, token) => http(base, "GET", path, { token });

  if (mode === "baseline") {
    // 全开姿态：nav 面（根层须显式 parentId=root，否则命中 10 万节点全树保护 400）
    expectStatus(await get("/api/v1/workspaces/current/tree?parentId=root", T), 200, "baseline nav tree", hits);
    // org 面
    expectStatus(await get("/api/v1/org/departments", T), 200, "baseline org departments", hits);
    // pats 面（列表 200）
    expectStatus(await get("/api/v1/pats", T), 200, "baseline pats list", hits);
    // mcp 已挂载：未带 PAT 不是 404（挂载态统一 401/400/405），用"非 404"佐证路由存在
    const mcp = await get("/mcp", null);
    if (mcp.status === 404) throw new Error(`baseline /mcp 期望已挂载(非404)，实得 404`);
    hits.hit(`baseline /mcp mounted => ${mcp.status}（非404）`);
    // 旧 /api 与 readyz
    expectStatus(await get("/api/auth/me", T), 200, "baseline legacy /api/auth/me", hits);
    expectStatus(await get("/readyz", null), 200, "baseline /readyz", hits);
    return hits.n;
  }

  if (mode === "orgoff") {
    // R1：nav 仍在（根层带 parentId=root，避开 10 万全树保护）
    expectStatus(await get("/api/v1/workspaces/current/tree?parentId=root", T), 200, "R1 nav tree still 200", hits);
    // R1：org 面摘除
    expectStatus(await get("/api/v1/org/departments", T), 404, "R1 /api/v1/org/departments 404", hits);
    expectStatus(await get("/api/v1/pats", T), 404, "R1 /api/v1/pats 404", hits);
    expectStatus(await get("/api/v1/meta", T), 404, "R1 /api/v1/meta 404", hits);
    // R7：顶层 /mcp 摘除
    expectStatus(await get("/mcp", null), 404, "R7 /mcp 404", hits);
    // 旧 /api 与健康检查不受影响
    expectStatus(await get("/api/auth/me", T), 200, "R1 legacy /api/auth/me still 200", hits);
    expectStatus(await get("/readyz", null), 200, "R1 /readyz still 200", hits);
    return hits.n;
  }

  if (mode === "navoff") {
    // R2：org 仍在
    expectStatus(await get("/api/v1/org/departments", T), 200, "R2 org departments still 200", hits);
    expectStatus(await get("/api/v1/pats", T), 200, "R2 pats still 200", hits);
    // R2：nav 面摘除（tree 与 menu 两个读点）
    expectStatus(await get("/api/v1/workspaces/current/tree", T), 404, "R2 workspaces tree 404", hits);
    expectStatus(await get("/api/v1/workspaces/current/menu", T), 404, "R2 workspaces menu 404", hits);
    // 旧 /api 与健康检查不受影响
    expectStatus(await get("/api/auth/me", T), 200, "R2 legacy /api/auth/me still 200", hits);
    expectStatus(await get("/readyz", null), 200, "R2 /readyz still 200", hits);
    return hits.n;
  }

  throw new Error(`未知 mode：${mode}`);
}

runCheck("check-mounts", main);
