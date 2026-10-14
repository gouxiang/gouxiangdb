// apps/api/src/routes/attachments.ts
// 服务端附件上传（R2 附件外置，ARCH-production.md §5.1）。挂在 /api/attachments。
//
// 边界（本次刻意不越）：
//   · 不动 records / fields 任何既有结构；
//   · 不迁移、不改写存量 base64 dataURL 附件（老附件保持原样，前端照旧渲染）；
//   · AttachmentDTO 形状与 shared-types 一致，url 恒为相对路径（前端 withBase() 拼前缀）。
//
// 端点：
//   POST   /            multipart（字段名 file，可重复）→ { files: AttachmentDTO[] }
//   GET    /:id/content 鉴权后回文件内容（只看库里的 storagePath，防路径穿越）
//   DELETE /:id         软删；仍被记录引用或仍有其它行共用同一文件时保留物理文件

import { Hono } from "hono";
import { z } from "zod";
import fs from "node:fs";
import { prisma, withWriteTx } from "../db.js";
import { requireCanEditData, requireCanView, requireCanComment, resolveBaseIdByRecord, HttpError } from "../guards.js";
import { audit as recordAudit } from "../audit/emit.js";
import type { AttachmentDTO } from "@gx/shared-types";
import {
  ALLOWED_EXTENSION_LABEL,
  ATTACHMENT_MAX_FILES,
  FORCE_DOWNLOAD_MIMES,
  attachmentMaxBytes,
  attachmentMaxBytesLabel,
  buildStoragePath,
  contentDisposition,
  removeStoredFile,
  resolveFileType,
  resolveStoredFile,
  sha256Of,
  writeStoredFile,
} from "../domain/attachmentStore.js";

export const attachments = new Hono();

const uploadMetaSchema = z.object({
  baseId: z.string().min(1, "缺少 baseId"),
  tableId: z.string().min(1).optional(),
  fieldId: z.string().min(1).optional(),
  recordId: z.string().min(1).optional(),
  // record=数据格附件（默认，需编辑数据权）；comment=记录评论附件（仅需评论权）。
  purpose: z.enum(["record", "comment"]).default("record"),
});

/** 文件名只取 basename 并限长，去掉路径分隔符（防脏名落进展示层）。 */
function safeName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() || "file";
  // 去掉控制字符（不用正则，避免 no-control-regex 告警）后限长 255。
  const cleaned = Array.from(base)
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
    .join("");
  return cleaned.slice(0, 255) || "file";
}

function toDto(row: {
  id: string;
  name: string;
  size: number;
  mime: string;
}): AttachmentDTO {
  return { id: row.id, name: row.name, size: row.size, mime: row.mime, url: `/api/attachments/${row.id}/content` };
}

/** 从 parseBody({all:true}) 的结果里取出全部 File（字段名 file，可重复 → 数组）。 */
function collectFiles(body: Record<string, string | string[] | File | File[]>): File[] {
  const out: File[] = [];
  for (const value of Object.values(body)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v instanceof File) out.push(v);
    }
  }
  return out;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

// ============ POST /api/attachments（multipart，支持一次多文件）============

attachments.post("/", async (c) => {
  const body = await c.req.parseBody({ all: true }).catch(() => null);
  if (!body) return c.json({ error: "需要 multipart/form-data 请求体" }, 400);

  const parsed = uploadMetaSchema.safeParse({
    baseId: firstString(body.baseId as string | string[] | undefined),
    tableId: firstString(body.tableId as string | string[] | undefined),
    fieldId: firstString(body.fieldId as string | string[] | undefined),
    recordId: firstString(body.recordId as string | string[] | undefined),
    purpose: firstString(body.purpose as string | string[] | undefined),
  });
  if (!parsed.success) {
    return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);
  }
  const meta = parsed.data;

  // 权限分流（先鉴权再读文件，避免匿名大文件写盘）：
  //   comment 通道：评论附件必须绑定记录、且该记录确实属于此 base，只需评论权（无编辑数据权亦可）；
  //   record 通道（默认）：维持需编辑数据权不变。
  let userId: string;
  if (meta.purpose === "comment") {
    if (!meta.recordId) return c.json({ error: "评论附件必须绑定记录" }, 400);
    const recordBaseId = await resolveBaseIdByRecord(meta.recordId);
    if (!recordBaseId || recordBaseId !== meta.baseId) {
      return c.json({ error: "评论附件必须绑定记录" }, 400);
    }
    ({ userId } = await requireCanComment(c, meta.baseId));
  } else {
    ({ userId } = await requireCanEditData(c, meta.baseId));
  }

  const files = collectFiles(body as Record<string, string | string[] | File | File[]>);
  if (files.length === 0) {
    return c.json({ error: "需要至少一个 file 字段（multipart form-data）" }, 400);
  }
  if (files.length > ATTACHMENT_MAX_FILES) {
    return c.json({ error: `单次最多上传 ${ATTACHMENT_MAX_FILES} 个文件` }, 400);
  }

  // 先全量校验再落盘：任一个不合法直接 400，不留半个写入。
  const prepared: { name: string; mime: string; ext: string; buf: Buffer; sha256: string }[] = [];
  for (const file of files) {
    const name = safeName(file.name || "file");
    const type = resolveFileType(name, file.type ?? "");
    if (!type) {
      return c.json({ error: `不支持的文件格式：${name}，仅支持 ${ALLOWED_EXTENSION_LABEL}` }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > attachmentMaxBytes()) {
      return c.json({ error: `文件 ${name} 超过 ${attachmentMaxBytesLabel()} 上限` }, 400);
    }
    if (buf.length === 0) {
      return c.json({ error: `文件 ${name} 内容为空` }, 400);
    }
    prepared.push({ name, mime: type.mime, ext: type.ext, buf, sha256: sha256Of(buf) });
  }

  // 落盘（同内容文件已存在则跳过写入）+ 落库（同 base 同 sha256 复用同一行）。
  const out: AttachmentDTO[] = [];
  for (const item of prepared) {
    const storagePath = buildStoragePath(item.sha256, item.ext);
    writeStoredFile(storagePath, item.buf);
    const row = await withWriteTx("attachments.upload", async (tx) => {
      const existing = await tx.attachment.findFirst({
        where: { baseId: meta.baseId, sha256: item.sha256, deletedAt: null },
      });
      if (existing) return existing;
      return tx.attachment.create({
        data: {
          baseId: meta.baseId,
          tableId: meta.tableId ?? null,
          fieldId: meta.fieldId ?? null,
          recordId: meta.recordId ?? null,
          name: item.name,
          mime: item.mime,
          size: item.buf.length,
          sha256: item.sha256,
          storagePath,
          uploaderId: userId,
        },
      });
    });
    out.push(toDto(row));
    recordAudit(c, {
      event: "attachment_upload",
      status: 200,
      actorId: userId,
      // 只落元数据：绝不落文件内容/字节。
      detail: { id: row.id, bytes: row.size, mime: row.mime, baseId: meta.baseId },
    });
  }

  return c.json({ files: out }, 201);
});

// ============ GET /api/attachments/:id/content（鉴权下载/预览）============

attachments.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row || row.deletedAt) throw new HttpError(404, "附件不存在");

  // 能看该库即可看附件（读档位比写档位宽，评论者/只读成员也应能预览）。
  await requireCanView(c, row.baseId);

  const abs = resolveStoredFile(row.storagePath);
  if (!abs || !fs.existsSync(abs)) throw new HttpError(404, "附件文件不存在");

  const buf = await fs.promises.readFile(abs);
  // SVG 内联渲染可带脚本 → 强制下载 + 沙箱 CSP，堵住存储型 XSS。
  const forceDownload = FORCE_DOWNLOAD_MIMES.includes(row.mime);
  const headers: Record<string, string> = {
    "Content-Type": row.mime,
    "Content-Length": String(buf.length),
    "Content-Disposition": contentDisposition(forceDownload ? "attachment" : "inline", row.name),
    // 内容带鉴权语义：只允许私有短缓存，不进共享缓存。
    "Cache-Control": "private, max-age=60",
  };
  if (forceDownload) {
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    headers["X-Content-Type-Options"] = "nosniff";
  }
  return new Response(new Uint8Array(buf), { headers });
});

// ============ DELETE /api/attachments/:id（软删；仍被引用则拒绝）============

attachments.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row || row.deletedAt) throw new HttpError(404, "附件不存在");

  const { userId } = await requireCanEditData(c, row.baseId);

  // 仍被引用判据：该 base 下任意记录（含回收站内的）fields JSON 里还出现这个附件 id。
  // 命中即 409 且绝不删物理文件——否则会让还在展示的单元格变成死链。
  const stillUsed = await prisma.record.findFirst({
    where: { table: { baseId: row.baseId }, fields: { contains: row.id } },
    select: { id: true },
  });
  if (stillUsed) {
    recordAudit(c, {
      event: "attachment_delete",
      status: 409,
      actorId: userId,
      detail: { id: row.id, baseId: row.baseId, reason: "in_use" },
    });
    return c.json(
      { error: "该附件仍被记录引用，请先从记录中移除后再删除", code: "ATTACHMENT_IN_USE" },
      409,
    );
  }

  // 评论引用判据：任一评论的 attachments JSON（attachmentId 数组串）里出现带双引号的该 id。
  // id 为 cuid 全局唯一，JSON 子串 '"<id>"' 精确命中，无需 base 过滤。命中即 409 且不删物理文件。
  const usedByComment = await prisma.comment.findFirst({
    where: { attachments: { contains: `"${row.id}"` } },
    select: { id: true },
  });
  if (usedByComment) {
    recordAudit(c, {
      event: "attachment_delete",
      status: 409,
      actorId: userId,
      detail: { id: row.id, baseId: row.baseId, reason: "in_use_by_comment" },
    });
    return c.json(
      { error: "该附件仍被评论引用，请先删除对应评论", code: "ATTACHMENT_IN_USE" },
      409,
    );
  }

  // 同内容文件可能被同 base 的其它行（或去重前已存在的行）共用：还有活行就只软删不删文件。
  const removed = await withWriteTx("attachments.delete", async (tx) => {
    await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
    const others = await tx.attachment.count({
      where: { storagePath: row.storagePath, deletedAt: null, id: { not: id } },
    });
    if (others > 0) return false;
    return removeStoredFile(row.storagePath);
  });

  recordAudit(c, {
    event: "attachment_delete",
    status: 200,
    actorId: userId,
    detail: { id: row.id, baseId: row.baseId, fileRemoved: removed },
  });
  return c.json({ ok: true, fileRemoved: removed });
});
