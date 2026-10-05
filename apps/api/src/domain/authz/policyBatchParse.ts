// P1-S8b-1 从 policyAdmin.parsePolicyBatch 抽出的【单条 upsert 解析】helper。
//
// 仅做形状/粗校：主体类型、动作白名单、fieldMask 形状、行级 conditions 经 parseRowConditions
// fail-closed 校验。语义/存在性仍在 policyAdmin.validateBatch 查库。这里不 import policyAdmin
// （仅 type 引用其输入类型，编译期擦除），避免运行时循环依赖。
//
// 关键：@gx/shared-types 的 PolicyValidationError 与 policyAdmin 自己的同名类是两个不同的类。
// 本文件只通过 err.name 识别 shared-types 的异常，绝不 import 其同名类，再转换成本域 BatchItemError，
// 由 policyAdmin 统一收口为自己的 PolicyValidationError。

import {
  RESOURCE_ACTIONS,
  parseRowConditions,
  type FieldMask,
  type RowConditions,
} from "@gx/shared-types";
import type { PolicyUpsertInput, PolicySubjectType } from "./policyAdmin.js";

export const SUBJECT_TYPES: readonly PolicySubjectType[] = ["user", "dept", "role"];

/** 单条解析可产出的错误码（policyAdmin PolicyValidationError 码的子集）。 */
type ItemCode =
  | "POLICY_SUBJECT_INVALID"
  | "POLICY_ACTION_INVALID"
  | "POLICY_FIELD_INVALID"
  | "POLICY_BAD_INPUT";

interface ItemDetail {
  index?: number;
  subject?: string;
  message: string;
}

/** 单条 upsert 解析失败（携带策略域码与单条明细，供 policyAdmin 收口）。 */
export class BatchItemError extends Error {
  constructor(
    readonly code: ItemCode,
    readonly detail: ItemDetail,
  ) {
    super(detail.message);
    this.name = "BatchItemError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析行级 conditions：缺省/null -> null；非对象 -> BAD_INPUT；非法结构 fail-closed。 */
function parseConditions(raw: unknown, index: number, subject: string): RowConditions | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    throw new BatchItemError("POLICY_BAD_INPUT", { index, subject, message: "conditions 必须是对象" });
  }
  try {
    return parseRowConditions(JSON.stringify(raw));
  } catch (err) {
    if ((err as Error | null)?.name === "PolicyValidationError") {
      throw new BatchItemError("POLICY_BAD_INPUT", {
        index,
        subject,
        message: `行级条件不合法：${(err as Error).message}`,
      });
    }
    throw err;
  }
}

/** 解析并粗校单条 upsert（原 policyAdmin 逐 upsert 循环体）。 */
export function parseUpsert(index: number, u: unknown): PolicyUpsertInput {
  if (!isObject(u)) {
    throw new BatchItemError("POLICY_BAD_INPUT", { index, message: "upserts 每项须为对象" });
  }
  const subjectType = u.subjectType;
  if (typeof subjectType !== "string" || !(SUBJECT_TYPES as readonly string[]).includes(subjectType)) {
    throw new BatchItemError("POLICY_SUBJECT_INVALID", {
      index,
      message: "subjectType 只能是 user/dept/role",
    });
  }
  if (typeof u.subjectId !== "string" || !u.subjectId.trim()) {
    throw new BatchItemError("POLICY_SUBJECT_INVALID", { index, message: "缺少 subjectId" });
  }
  const subjectId = u.subjectId.trim();
  if (!Array.isArray(u.actions) || u.actions.length === 0) {
    throw new BatchItemError("POLICY_ACTION_INVALID", {
      index,
      subject: subjectId,
      message: "actions 必须是非空数组",
    });
  }
  for (const a of u.actions) {
    if (typeof a !== "string" || !(RESOURCE_ACTIONS as readonly string[]).includes(a)) {
      throw new BatchItemError("POLICY_ACTION_INVALID", {
        index,
        subject: subjectId,
        message: `非法资源动作: ${String(a)}`,
      });
    }
  }
  let fieldMask: FieldMask | null = null;
  if (u.fieldMask !== undefined && u.fieldMask !== null) {
    if (!isObject(u.fieldMask)) {
      throw new BatchItemError("POLICY_FIELD_INVALID", {
        index,
        subject: subjectId,
        message: "fieldMask 必须是对象",
      });
    }
    fieldMask = u.fieldMask as FieldMask;
  }
  const conditions = parseConditions(u.conditions, index, subjectId);
  return {
    subjectType: subjectType as PolicySubjectType,
    subjectId,
    actions: u.actions as string[],
    fieldMask,
    conditions,
  };
}
