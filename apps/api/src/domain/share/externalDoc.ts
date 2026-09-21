// apps/api/src/domain/share/externalDoc.ts
// 外部访问者（无登录态）经分享链接改写【文档 / 画布正文】的事务体。
//
// 与数据表侧（externalRecords.ts）同构：只在当次能力为 edit 时放行；档位不足落审计后拒；
// 成功后落审计（share_external_write）。actor 一律记【分享人】——外部访问者没有系统身份，
// 「借谁的链接改的」只能记分享人（口径见 shareCaps.ts 头注释）。
//
// ★乐观锁是本体（本工单核心）：分享出去的可编辑文档，可能被多个匿名外部人 + 分享人自己
//   同时编辑，而保存是【整篇 cover 式覆盖】。若不校验版本，A 打开页面、B 改完保存、A 再保存，
//   A 的旧内容会把 B 的改动【静默抹掉】且无从发现——不可逆的数据丢失。故：
//     - baseUpdatedAt 必填（缺则由路由层 400，本文件不接受 undefined）；
//     - 写入前比对库中当前 updatedAt，不一致即抛 DocContentConflictError（409，携带库中最新
//       content/updatedAt 供前端刷新），绝不覆盖。
//   版本令牌选 updatedAt 而非 contentVersion：公开读取侧只回传 updatedAt，无旧客户端兼容包袱。
//
// 本文件不含任何路由 / HTTP 类型：入参出参都是纯数据，便于单测。

import type { ShareWriteAction } from "@gx/shared-types";
import { withWriteTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import { buildSearchText } from "../kb.js";
import { saveDocContentTx } from "../kbDocWrite.js";
import { auditWrite } from "./externalRecords.js";
import type { ShareCaps } from "./shareCaps.js";

export interface ExternalDocWriteInput {
  docId: string;
  content: string;
  /** 客户端读取时拿到的 updatedAt（乐观锁基准），必填。 */
  baseUpdatedAt: Date;
  /** 外部访问者的来源 IP（审计用，不参与判定）。 */
  ip: string;
  /** 触发本次访问的分享令牌（审计用；writeAudit 会脱敏，绝不落明文）。 */
  token: string;
}

/**
 * 乐观锁冲突：库中内容已被他人改动。
 * 携带库中最新 content / updatedAt，让路由层回 409 时能直接给前端刷新，而不是让用户
 * 对着一个已经过期的编辑器继续改（那样下一次保存仍会覆盖别人的改动）。
 */
export class DocContentConflictError extends HttpError {
  constructor(public content: string, public updatedAt: string) {
    super(409, "内容已被其他人修改，请刷新后再编辑", "CONFLICT");
  }
}

/** 档位不足 / 缺分享人：落审计后 403。与 externalRecords.deny 同口径。 */
function deny(caps: ShareCaps, input: ExternalDocWriteInput, reason: string): never {
  auditWrite({
    event: "share_external_denied",
    status: 403,
    sharerId: caps.sharerId,
    ip: input.ip,
    detail: { action: "update" satisfies ShareWriteAction, objectType: "kb_doc", objectId: input.docId, reason },
  });
  throw new HttpError(403, reason);
}

/** 写前统一校验：当次能力（分享人此刻是否仍有内容改权）+ 分享人存在性。 */
function assertDocWritable(caps: ShareCaps, input: ExternalDocWriteInput): string {
  if (!caps.canEdit || caps.mode !== "edit") {
    deny(caps, input, "该分享链接为只读");
  }
  if (!caps.sharerId) {
    deny(caps, input, "分享链接缺少分享人，不可编辑");
  }
  return caps.sharerId as string;
}

/**
 * 外部保存文档正文（含乐观锁）。成功返回写入后的 updatedAt（ISO）。
 * 冲突抛 DocContentConflictError（事务回滚，库中内容零改动）。
 */
export async function externalSaveDocContent(
  input: ExternalDocWriteInput,
  caps: ShareCaps,
): Promise<{ updatedAt: string }> {
  const sharerId = assertDocWritable(caps, input);

  const result = await withWriteTx("share.doc.content.save", async (tx) => {
    // 读当前行（同事务内，写队列并发度恒 1，读与随后的写之间无插队）。
    const cur = await tx.kbDoc.findUnique({
      where: { id: input.docId },
      select: { content: true, updatedAt: true, contentVersion: true, kind: true },
    });
    if (!cur) throw new HttpError(404, "文档不存在或已被删除");

    if (cur.updatedAt.getTime() !== input.baseUpdatedAt.getTime()) {
      // 版本不一致：不写，把库中最新内容交回前端。
      throw new DocContentConflictError(cur.content, cur.updatedAt.toISOString());
    }

    // 复用登录态同一写实现（条件更新 + 自动快照 + 检索 outbox + nav 同步），
    // 只是裁决主体换成分享人、乐观锁基准用刚校验过的当前版本，避免语义漂移。
    await saveDocContentTx(tx, {
      docId: input.docId,
      kind: cur.kind,
      currentVersion: cur.contentVersion,
      content: input.content,
      searchText: buildSearchText(cur.kind, input.content),
      userId: sharerId,
      baseVersion: cur.contentVersion,
    });

    const after = await tx.kbDoc.findUnique({ where: { id: input.docId }, select: { updatedAt: true } });
    return { updatedAt: (after?.updatedAt ?? new Date()).toISOString() };
  });

  auditWrite({
    event: "share_external_write",
    status: 200,
    sharerId,
    ip: input.ip,
    detail: {
      action: "update",
      objectType: "kb_doc",
      objectId: input.docId,
      actorId: sharerId,
      viaToken: input.token,
    },
  });
  return result;
}
