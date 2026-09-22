// apps/api/src/routes/__tests__/_tableSharesHarness.ts
// 数据表分享链接路由测试的共享夹具（内存 fake prisma + 可变 state）。
// 从 tableShares.test.ts 拆出，只为守「单文件 <= 300 行」：夹具是纯数据构造，
// 与用例断言没有耦合，单独放也便于后续其它分享路由复用。
//
// ★本夹具刻意【不 mock】权限判定链：只顶替 db.js（取数）、auth.js（身份）、
//   audit/emit.js（落盘），libraryPolicy / shareCaps 跑真实代码。
//   若把 resolveBaseAccessByTable 也 mock 掉，测到的就只是"路由有没有调那个函数"，
//   而不是"这条判定链到底算得对不对"。
//
// 取数形态按真实调用点对齐（改生产代码的取数会在这里先炸，属于预期）：
//   table.findFirst({select:{id}})                  —— assertCanShareTable 的存在性
//   table.findUnique({select:{baseId}})             —— baseIdBy / create
//   table.findUnique({select:{shareEnabled,base}})  —— tableShareAllowed 的两级开关
//   roleAssignment.findMany({where.OR})             —— effectiveRoleRows
//   roleLibraryScope.findMany({where.roleId.in})    —— synthesizeAccess

export const TABLE = "t1";
export const BASE = "b1";
/** 普通可见成员：只读（建不了可编辑链接）。 */
export const MEMBER = "u1";
/** 另一个普通成员：不是链接创建者、也无管理权。 */
export const OTHER = "u2";
/** 对本库有管理权的人：可吊销别人建的链接。 */
export const MANAGER = "u3";

export interface TablePerm {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

export interface UserScope {
  visible: boolean;
  canManage: boolean;
  /**
   * 角色 × 库的「可分享」位。本轮收紧后建/看/吊销分享链接都要过 access.canShare
   * （= canManage ∪ 这一位）。夹具默认给 true：这些用例的靶子是档位现算 / 降级 / 吊销，
   * 默认带分享权才能让它们继续测原本的东西；「没有分享权」的情形由新增用例显式构造。
   */
  canShare: boolean;
  tablePerm: TablePerm;
}

export interface FakeLink {
  id: string;
  token: string;
  objectType: string;
  objectId: string | null;
  baseId: string;
  viewId: string | null;
  mode: string;
  createdBy: string | null;
  role: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface PrismaArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  data?: Record<string, unknown>;
  orderBy?: unknown;
  include?: unknown;
}

export interface AuditCall {
  event: string;
  status: number;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

export const state = {
  /** 当前请求身份；空串 = 未登录。 */
  userId: MEMBER,
  /** 每个用户的角色库视野（判定链只认这一份，不看 members.role）。 */
  scopes: {} as Record<string, UserScope>,
  /** 两级「允许分享」开关。 */
  baseShareEnabled: 1,
  tableShareEnabled: 1,
  tableExists: true,
  links: [] as FakeLink[],
  /** 属于本表的视图 id。 */
  viewIds: ["v1"],
  deletedLinkIds: [] as string[],
};

let seq = 0;

/** 造库视野时的可选项：表四动作 + canShare 位（缺省 true，见 UserScope.canShare 注释）。 */
export interface ScopeOpts extends Partial<TablePerm> {
  canShare?: boolean;
}

/** 造一份库视野。默认：可见 + 可分享 + 只读（update=false 是"建不了可编辑链接"的常态）。 */
export function scope(visible: boolean, canManage: boolean, opts: ScopeOpts = {}): UserScope {
  const { canShare = true, ...perm } = opts;
  return {
    visible,
    canManage,
    canShare,
    tablePerm: { read: true, create: false, update: false, delete: false, ...perm },
  };
}

/** 造一条分享链接行。objectType/objectId 默认指向本表，可按用例覆盖（跨表吊销用例）。 */
export function link(p: Partial<FakeLink> & Pick<FakeLink, "id" | "mode" | "createdBy">): FakeLink {
  return {
    token: `tok-${p.id}`,
    objectType: "table",
    objectId: TABLE,
    baseId: BASE,
    viewId: null,
    role: "viewer",
    expiresAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...p,
  };
}

/** 角色 id 编码为 r_<userId>：roleLibraryScope 据此回各自的视野，实现"按人给权限"。 */
function roleOf(userId: string): string {
  return `r_${userId}`;
}

export const fakePrisma = {
  table: {
    findFirst: ({ where }: PrismaArgs) =>
      Promise.resolve(state.tableExists && where?.id === TABLE ? { id: TABLE } : null),
    findUnique: ({ where, select }: PrismaArgs) => {
      if (where?.id !== TABLE || !state.tableExists) return Promise.resolve(null);
      if (select && "base" in select) {
        return Promise.resolve({
          shareEnabled: state.tableShareEnabled,
          base: { shareEnabled: state.baseShareEnabled },
        });
      }
      return Promise.resolve({ id: TABLE, baseId: BASE });
    },
    findUniqueOrThrow: ({ where }: PrismaArgs) => {
      if (where?.id !== TABLE || !state.tableExists) return Promise.reject(new Error("not found"));
      return Promise.resolve({ id: TABLE, baseId: BASE });
    },
  },
  shareLink: {
    findMany: ({ where }: PrismaArgs) =>
      Promise.resolve(
        state.links
          .filter((l) => l.objectType === where?.objectType && l.objectId === where?.objectId)
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    findFirst: ({ where }: PrismaArgs) =>
      Promise.resolve(
        state.links.find(
          (l) => l.id === where?.id && l.objectType === where?.objectType && l.objectId === where?.objectId,
        ) ?? null,
      ),
    create: ({ data }: PrismaArgs) => {
      const id = `link-${++seq}`;
      const row: FakeLink = {
        id,
        token: `tok-${id}`,
        objectType: "table",
        objectId: TABLE,
        baseId: BASE,
        viewId: null,
        mode: "view",
        createdBy: null,
        role: "viewer",
        expiresAt: null,
        createdAt: new Date("2026-10-02T00:00:00.000Z"),
        ...(data as Partial<FakeLink>),
      };
      state.links.push(row);
      return Promise.resolve(row);
    },
    delete: ({ where }: PrismaArgs) => {
      state.deletedLinkIds.push(String(where?.id));
      state.links = state.links.filter((l) => l.id !== where?.id);
      return Promise.resolve({ id: where?.id });
    },
  },
  view: {
    findFirst: ({ where }: PrismaArgs) =>
      Promise.resolve(
        state.viewIds.includes(String(where?.id)) && where?.tableId === TABLE
          ? { id: where?.id, tableId: TABLE }
          : null,
      ),
  },
  // —— 以下四条是 effectiveRoleRows -> synthesizeAccess（真实判定链）需要的取数 ——
  deptMember: { findMany: () => Promise.resolve([]) },
  department: { findMany: () => Promise.resolve([]) },
  roleAssignment: {
    // ★必须按 where 里的 subjectId 取角色，不能用「当前请求者」顶替：
    //   降级判定是以【分享人】的身份发起的，与看列表的人往往不是同一个人。
    //   夹具写成忽略 where 会让降级用例"看起来通过"，实际测的是请求者的权限。
    findMany: ({ where }: PrismaArgs) => {
      const or = (where?.OR as Array<Record<string, unknown>>) ?? [];
      const uid = String(or[0]?.subjectId ?? "") || state.userId;
      return Promise.resolve([
        {
          subjectType: "user",
          subjectId: uid,
          role: {
            id: roleOf(uid),
            deletedAt: null,
            name: "成员",
            systemKey: "member",
            isSystem: 1,
            permissions: "[]",
          },
        },
      ]);
    },
  },
  roleLibraryScope: {
    findMany: ({ where }: PrismaArgs) => {
      const roleIds = (where?.roleId as { in: string[] }).in as string[];
      const rows = roleIds
        .map((rid) => {
          const s = state.scopes[rid.slice(2)];
          if (!s) return null;
          return {
            canManage: s.canManage ? 1 : 0,
            visible: s.visible ? 1 : 0,
            canShare: s.canShare ? 1 : 0,
            config: JSON.stringify({ tables: { [TABLE]: s.tablePerm } }),
          };
        })
        .filter(
          (r): r is { canManage: number; visible: number; canShare: number; config: string } =>
            r !== null,
        );
      return Promise.resolve(rows);
    },
  },
};

export const auditCalls: AuditCall[] = [];

export function resetState(): void {
  state.userId = MEMBER;
  state.scopes = {
    [MEMBER]: scope(true, false),
    [OTHER]: scope(true, false),
    [MANAGER]: scope(true, true, { create: true, update: true, delete: true }),
  };
  state.baseShareEnabled = 1;
  state.tableShareEnabled = 1;
  state.tableExists = true;
  state.links = [];
  state.viewIds = ["v1"];
  state.deletedLinkIds = [];
  seq = 0;
  auditCalls.length = 0;
}
