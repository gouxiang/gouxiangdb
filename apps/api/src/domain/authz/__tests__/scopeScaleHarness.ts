// M4/S4 规模夹具造数（计划 §7-S4：500 用户 / 6 层部门 / 人均 2 部门 / 1 万 nav 节点 / 约 3000 策略）。
//
// 从 scope-scale.test.ts 拆出以守单文件 <=300 行门禁；只负责造数，不含断言。
// 数据可复现：固定 seed 的 mulberry32，各轮迁移临时库结果一致。

import type { PrismaClient } from "@prisma/client";

export const N_USERS = 500;
export const N_NAV = 10_000;
export const N_BASE = 40;
export const N_TABLE_PER_BASE = 10; // 40*10=400 tables，其余 9560 为 doc 叶子

/** 确定性 PRNG（造数可复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 升序数组的 P 分位（近秩法）。 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[idx]!;
}

/** 计数 Proxy（与 scope-parity 同口径，含 $queryRawUnsafe；返回客体调用 labels）。 */
export function counted(client: PrismaClient) {
  const labels: string[] = [];
  const wrap = (delegate: object, name: string): unknown =>
    new Proxy(delegate, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function"
          ? (...a: unknown[]) => {
            labels.push(`${name}.${String(prop)}`);
            return Reflect.apply(v as (...x: unknown[]) => unknown, t, a);
          }
          : v;
      },
    });
  const wrapped = new Proxy(client, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      const name = String(prop);
      const v = Reflect.get(t, prop, receiver);
      if (typeof v !== "function") {
        return typeof v === "object" && v !== null && !name.startsWith("$") && !name.startsWith("_")
          ? wrap(v as object, name) : v;
      }
      if (name === "$queryRawUnsafe") {
        return (...a: unknown[]) => {
          labels.push(name);
          return Reflect.apply(v as (...x: unknown[]) => unknown, t, a);
        };
      }
      return (v as (...x: unknown[]) => unknown).bind(t);
    },
  }) as unknown as PrismaClient;
  return { client: wrapped, labels: () => [...labels] };
}

export interface ScaleFixtureStats {
  userIds: string[];
  deptCount: number;
  membershipCount: number;
  policyCount: number;
}

export async function seedScale(db: PrismaClient): Promise<ScaleFixtureStats> {
  const rnd = mulberry32(20260916);
  const userIds = Array.from({ length: N_USERS }, (_, i) => `su_${i.toString().padStart(4, "0")}`);
  await db.user.createMany({
    data: userIds.map((id) => ({
      id, email: `${id}@example.com`, displayName: id, passwordHash: "x",
      workspaceId: "ws_default", status: "ACTIVE",
    })),
  });

  // 6 层部门：lvl0 唯一根，lvl1..5 每层 6 个，挂上层 (idx % 上层数)，覆盖 6 层继承深度。
  const depts: { id: string; parentId: string | null; path: string }[] = [];
  const levels: string[][] = [];
  const PER_LEVEL = 6;
  for (let lvl = 0; lvl < 6; lvl++) {
    const ids: string[] = [];
    const count = lvl === 0 ? 1 : PER_LEVEL;
    for (let i = 0; i < count; i++) {
      const id = `sd_${lvl}_${i}`;
      ids.push(id);
      const parentId = lvl === 0 ? null : levels[lvl - 1]![i % levels[lvl - 1]!.length]!;
      depts.push({ id, parentId, path: "/" });
    }
    levels.push(ids);
  }
  const deptById = new Map(depts.map((d) => [d.id, d]));
  for (const d of depts) {
    const segs: string[] = [d.id];
    let p = d.parentId;
    while (p) { segs.unshift(p); p = deptById.get(p)?.parentId ?? null; }
    d.path = `/${segs.join("/")}/`;
  }
  await db.department.createMany({
    data: depts.map((d) => ({
      id: d.id, workspaceId: "ws_default", parentId: d.parentId, path: d.path, name: d.id,
    })),
  });

  // 人均 2 部门（主部门 + 兼岗；落到同一部门时去重为一条）。
  const joinable = depts.filter((d) => d.parentId !== null);
  const memberships = [];
  for (let i = 0; i < N_USERS; i++) {
    const a = joinable[(i * 2) % joinable.length]!;
    const b = joinable[(i * 2 + 1) % joinable.length]!;
    memberships.push({ id: `sdm_${i}_0`, departmentId: a.id, userId: userIds[i]!, isMain: 1 });
    if (b.id !== a.id) {
      memberships.push({ id: `sdm_${i}_1`, departmentId: b.id, userId: userIds[i]!, isMain: 0 });
    }
  }
  await db.deptMember.createMany({ data: memberships });

  await db.role.createMany({
    data: [
      { id: "sr_read", workspaceId: "ws_default", name: "sr_read", isSystem: 0, permissions: "[]" },
      { id: "sr_ru", workspaceId: "ws_default", name: "sr_ru", isSystem: 0, permissions: "[]" },
    ],
  });
  const assignments = [];
  for (let i = 0; i < 50; i++) {
    assignments.push({ id: `sra_r_${i}`, roleId: "sr_read", subjectType: "user" as const, subjectId: userIds[i]!, scopeType: "workspace" as const, createdBy: "seed" });
  }
  for (let i = 50; i < 100; i++) {
    assignments.push({ id: `sra_ru_${i}`, roleId: "sr_ru", subjectType: "user" as const, subjectId: userIds[i]!, scopeType: "workspace" as const, createdBy: "seed" });
  }
  assignments.push({ id: "sra_owner", roleId: "role_owner", subjectType: "user" as const, subjectId: "su_0499", scopeType: "workspace" as const, createdBy: "seed" });
  await db.roleAssignment.createMany({ data: assignments });

  // nav：40 base -> 400 table -> 9560 doc 叶子（约 2% inheritAncestors=0 覆盖 cutoff）。
  const navRows = [];
  const baseIds: string[] = [];
  const tableIds: string[] = [];
  for (let b = 0; b < N_BASE; b++) {
    const bid = `sb_${b.toString().padStart(3, "0")}`;
    baseIds.push(bid);
    navRows.push({
      id: bid, workspaceId: "ws_default", parentId: null as string | null, kind: "base", resourceType: "base",
      resourceId: bid, name: bid, path: `/${bid}/`, depth: 0, isSystem: 1, inheritAncestors: 1,
    });
  }
  await db.base.createMany({ data: baseIds.map((id, i) => ({ id, name: id, createdBy: userIds[i % N_USERS]! })) });

  for (let b = 0; b < N_BASE; b++) {
    const bid = baseIds[b]!;
    for (let t = 0; t < N_TABLE_PER_BASE; t++) {
      const tid = `st_${b.toString().padStart(3, "0")}_${t}`;
      tableIds.push(tid);
      navRows.push({
        id: tid, workspaceId: "ws_default", parentId: bid, kind: "table", resourceType: "table",
        resourceId: tid, name: tid, path: `/${bid}/${tid}/`, depth: 1, isSystem: 1, inheritAncestors: 1,
      });
    }
  }
  await db.table.createMany({
    data: tableIds.map((id, i) => ({
      id, baseId: baseIds[Math.floor(i / N_TABLE_PER_BASE)]!, name: id,
      primaryFieldId: `pf_${id}`, createdBy: userIds[(i + 7) % N_USERS]!,
    })),
  });

  let docSeq = 0;
  outer: for (let b = 0; b < N_BASE; b++) {
    for (let t = 0; t < N_TABLE_PER_BASE; t++) {
      const tid = tableIds[b * N_TABLE_PER_BASE + t]!;
      for (let d = 0; d < 239; d++) {
        if (navRows.length >= N_NAV) break outer;
        const did = `sdoc_${docSeq.toString().padStart(5, "0")}`;
        docSeq++;
        navRows.push({
          id: did, workspaceId: "ws_default", parentId: tid, kind: "doc", resourceType: "doc",
          resourceId: did, name: did, path: `/${baseIds[b]!}/${tid}/${did}/`, depth: 2,
          isSystem: 1, inheritAncestors: rnd() < 0.02 ? 0 : 1,
        });
      }
    }
  }
  await db.navNode.createMany({ data: navRows });

  // 约 3000 策略：1000 user + 50 带 fieldMask 的 table user + 1000 sr_read + 500 sr_ru + 450 dept。
  // 唯一键 (nodeId,subjectType,subjectId)：同主体对同节点只造一条，用 seen 集去重并重抽。
  const policyRows: {
    id: string; workspaceId: string; nodeId: string;
    subjectType: "user" | "dept" | "role"; subjectId: string;
    actions: string; fieldMask: string | null; createdBy: string;
  }[] = [];
  const nodeIds = navRows.map((n) => n.id);
  let pid = 0;
  const seen = new Set<string>();
  const mk = (subjectType: "user" | "dept" | "role", subjectId: string, nodeId: string, actions: string,
    fieldMask: string | null = null): boolean => {
    const key = `${subjectType}:${subjectId}:${nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    policyRows.push({
      id: `spol_${pid.toString().padStart(5, "0")}`, workspaceId: "ws_default", nodeId,
      subjectType, subjectId, actions, fieldMask, createdBy: "seed",
    });
    pid++;
    return true;
  };
  const randomNode = () => nodeIds[Math.floor(rnd() * nodeIds.length)]!;
  for (let i = 0; i < 1000; i++) {
    // 500 用户循环授两条（不同随机节点），subjectId 不得越界为 undefined。
    const user = userIds[i % N_USERS]!;
    while (!mk("user", user, randomNode(), "r")) { /* 同节点碰撞重抽 */ }
  }
  for (let i = 0; i < 50; i++) {
    const user = userIds[100 + (i % 400)]!;
    let node = tableIds[Math.floor(rnd() * tableIds.length)]!;
    while (!mk("user", user, node, "r", '{"allowFields":["f1","f2"]}')) {
      node = tableIds[Math.floor(rnd() * tableIds.length)]!;
    }
  }
  let made = 0;
  while (made < 1000) if (mk("role", "sr_read", randomNode(), "r")) made++;
  made = 0;
  while (made < 500) if (mk("role", "sr_ru", randomNode(), "r,u")) made++;
  made = 0;
  while (made < 450) {
    const dept = joinable[Math.floor(rnd() * joinable.length)]!;
    if (mk("dept", dept.id, randomNode(), "r")) made++;
  }
  await db.authPolicy.createMany({ data: policyRows });

  return {
    userIds, deptCount: depts.length,
    membershipCount: memberships.length, policyCount: policyRows.length,
  };
}
