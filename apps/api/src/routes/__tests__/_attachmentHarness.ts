// 附件测试共享夹具（真迁移临时库 + 真路由 + 真落盘）。
//
// 与 _realApp.ts 同款纪律：db/guards/路由依赖 db.ts 单例，必须先把
// globalThis.__gx_prisma 注入好【再动态 import】。身份注入（vi.mock auth.js）
// 由各测试文件自己持有可变 currentUserId —— vi.mock 按路径对整个模块图生效，
// 夹具里发起的请求同样会走测试文件注入的那个 getUserId。
//
// 环境口径（本夹具显式收窄，避免测试造大缓冲）：
//   GX_BODY_LIMIT_JSON=0.25     → JSON 档 256KB（用来证明附件端点没落回这一档）
//   GX_BODY_LIMIT_ATTACHMENT=6  → 附件【整包】档 6MB（用来证明超大包在中间件层 413）
//   GX_ATTACHMENT_MAX_FILE=2    → 附件【单文件】上限 2MB（错误信息出现「2MB」）
// 两档刻意取不同值：这样才能证明「整包容量」与「单文件提示口径」是两个独立旋钮
// （同值会让下面那些用例退化成自证）。

import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export const OWNER_ID = "u1";
export const OUTSIDER_ID = "u2";

export interface UploadFileSpec {
  name: string;
  type: string;
  content: string | Buffer;
}

export interface AttachmentHarness {
  tmpDir: string;
  prisma: PrismaClient;
  /** 只挂路由（功能测试用）。 */
  app: Hono;
  /** 挂 bodyLimitDispatch + 路由（请求体分档用）。 */
  gatedApp: Hono;
  uploadRoot: string;
  auditFile: string;
  upload: (
    files: UploadFileSpec[],
    meta?: Record<string, string>,
    target?: Hono,
  ) => Promise<Response>;
  makeBase: (name?: string) => Promise<string>;
  /** 在该 base 下建一张表并插一条记录，fields 为已序列化的 JSON 串。 */
  makeRecord: (baseId: string, fieldsJson: string) => Promise<string>;
  /** 按 sha256 找到磁盘上的实际文件（不依赖返回结构以外的信息）。 */
  findStoredFile: (sha256: string) => string | null;
  readAudit: () => Record<string, any>[];
  teardown: () => Promise<void>;
}

export async function setupAttachmentHarness(prefix = "gx-attachment-"): Promise<AttachmentHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const uploadRoot = path.join(tmpDir, "uploads");
  const auditDir = path.join(tmpDir, ".audit");
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.UPLOAD_ROOT = uploadRoot;
  process.env.GX_AUDIT_DIR = auditDir;
  process.env.GX_BODY_LIMIT_JSON = "0.25";
  process.env.GX_BODY_LIMIT_ATTACHMENT = "6";
  process.env.GX_ATTACHMENT_MAX_FILE = "2";
  process.env.GX_M1_SIDECAR = "off";
  process.env.GX_M1_SIDECAR_READ = "off";
  delete process.env.GX_M1_KEYSET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });

  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  for (const id of [OWNER_ID, OUTSIDER_ID]) {
    await prisma.user.create({
      data: { id, email: `${id}@example.com`, displayName: id, passwordHash: "x" },
    });
  }
  // u1 = 超级管理员（角色×库裁决只认角色视野）；u2 无任何授予 → 对 u1 的库不可见。
  await prisma.roleAssignment.create({
    data: {
      roleId: "role_owner", subjectType: "user", subjectId: OWNER_ID,
      scopeType: "workspace", createdBy: "seed",
    },
  });

  const [guardsMod, routeMod, bodyLimitMod] = await Promise.all([
    import("../../guards.js"),
    import("../attachments.js"),
    import("../../middleware/bodyLimit.js"),
  ]);
  const app = new Hono();
  app.route("/api/attachments", routeMod.attachments);
  app.onError((err, c) => guardsMod.errorResponse(c, err));

  const gatedApp = new Hono();
  gatedApp.use("*", bodyLimitMod.bodyLimitDispatch);
  gatedApp.route("/api/attachments", routeMod.attachments);
  gatedApp.onError((err, c) => guardsMod.errorResponse(c, err));

  const upload = async (
    files: UploadFileSpec[],
    meta: Record<string, string> = {},
    target: Hono = app,
  ): Promise<Response> => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(meta)) fd.append(k, v);
    for (const f of files) {
      const body = typeof f.content === "string" ? f.content : new Uint8Array(f.content);
      fd.append("file", new File([body], f.name, { type: f.type }));
    }
    return target.request("/api/attachments", { method: "POST", body: fd });
  };

  const findStoredFile = (sha256: string): string | null => {
    const root = path.join(uploadRoot, "attachments");
    if (!fs.existsSync(root)) return null;
    for (const dir of fs.readdirSync(root)) {
      for (const sub of fs.readdirSync(path.join(root, dir))) {
        const p = path.join(root, dir, sub);
        for (const f of fs.readdirSync(p)) {
          if (f.startsWith(`${sha256}.`)) return path.join(p, f);
        }
      }
    }
    return null;
  };

  // 引擎永久单一化后，守卫反查资源必须命中活 nav 节点，否则 fail-closed。裸建实体后补一次
  // 标准 nav 同步。超管 u1 的放行靠 isWorkspaceOwner 硬短路，不依赖节点策略投影。
  async function syncNav(): Promise<void> {
    const { syncNavFromEntitiesTx } = await import("../../domain/nav/sync.js");
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  }

  const auditFile = path.join(auditDir, "audit.logl");
  const readAudit = (): Record<string, any>[] => {
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };

  return {
    tmpDir,
    prisma,
    app,
    gatedApp,
    uploadRoot,
    auditFile,
    upload,
    makeBase: async (name = "b") => {
      const base = await prisma.base.create({ data: { name, createdBy: OWNER_ID } });
      await prisma.member.create({ data: { baseId: base.id, userId: OWNER_ID, role: "owner" } });
      await syncNav();
      return base.id;
    },
    makeRecord: async (baseId: string, fieldsJson: string) => {
      const table = await prisma.table.create({
        data: { baseId, name: "T", primaryFieldId: "", createdBy: OWNER_ID },
      });
      await syncNav();
      const rec = await prisma.record.create({
        data: { tableId: table.id, fields: fieldsJson, createdBy: OWNER_ID, updatedBy: OWNER_ID },
      });
      return rec.id;
    },
    findStoredFile,
    readAudit,
    teardown: async () => {
      await prisma.$disconnect();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
