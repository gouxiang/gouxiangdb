// apps/web/src/features/sync/reasonCodes.ts
// 同步 reasonCode → 中文人读文案的唯一映射（冲突弹窗 / 同步中心隔离区共用）。
// 覆盖 apps/api/src/domain/sync 下全部 SYNC_* 原因码；未知码走兜底，绝不因新码崩 UI。

const REASON_TEXT: Record<string, string> = {
  // 版本 / 冲突
  SYNC_VERSION_CONFLICT: "记录已被他人修改，存在版本冲突",
  SYNC_TREE_VERSION_CONFLICT: "导航树已被他人修改，存在结构冲突",
  SYNC_STRUCTURE_VERSION_CONFLICT: "表结构版本已变化，需先更新结构",
  SYNC_SCHEMA_REPLAY_VALUE_CONFLICT: "按新结构重放后仍有值冲突",
  // 实体生命周期
  SYNC_ENTITY_DELETED: "目标记录或表已被删除",
  SYNC_ENTITY_NOT_FOUND: "目标对象不存在",
  SYNC_TABLE_DELETED: "数据表已被删除",
  // 权限 / 可见性 / 隔离
  SYNC_PERMISSION_REVOKED: "你对此内容的编辑权限已被收回",
  SYNC_QUARANTINED: "改动已被隔离，需重新授权后重试",
  SYNC_ROW_NO_LONGER_VISIBLE: "该记录已不在你的可见范围内",
  SYNC_FIELD_FORBIDDEN: "部分字段你已无权写入",
  // 数据校验
  SYNC_VALIDATION: "数据未通过校验",
  SYNC_NOT_UNIQUE: "存在重复值，不满足唯一性要求",
  SYNC_LINK_INVALID: "关联记录无效或已失效",
  SYNC_TYPE_CONVERSION_BLOCKED: "字段类型变更后，原值无法安全转换",
  SYNC_TYPE_CHANGE_UNSUPPORTED: "该字段类型不支持这样转换",
  SYNC_PRIMARY_FIELD_HAS_EMPTY: "主字段存在空值，无法变更结构",
  // 请求 / 结构
  SYNC_BAD_TABLE: "目标数据表无效",
  SYNC_OP_UNSUPPORTED: "不支持该操作类型",
  SYNC_MALFORMED_PAYLOAD: "操作数据格式不正确",
  SYNC_STRUCTURE_DEPENDENCY_CONFLICT: "结构改动存在依赖冲突",
  // 同步中心状态机
  SYNC_INCOMING_NOT_FOUND: "待处理项不存在或已处理",
  SYNC_INCOMING_INVALID_STATE: "待处理项状态已变化，请刷新后重试",
  // 裁决
  SYNC_RESOLVE_BAD_DECISION: "解决方式无效",
  SYNC_RESOLVE_NOT_CONFLICT: "该项已不是冲突状态",
  SYNC_RESOLVE_MALFORMED: "自定义解决需提供有效的合并值",
  SYNC_RESOLVE_STEPS_MALFORMED: "结构裁决步骤格式不正确",
  // 协议握手
  SYNC_PROTOCOL_TOO_OLD: "客户端版本过旧，请更新后再同步",
  SYNC_PROTOCOL_TOO_NEW: "服务器版本较旧，部分同步能力不可用",
  SYNC_PROTOCOL_BAD_REQUEST: "同步协议请求不合法",
  // 通用请求（incoming.ts / 路由 400）
  SYNC_BAD_REQUEST: "同步请求参数有误",
  SYNC_BAD_SCOPE: "同步范围无效",
  SYNC_BAD_CURSOR: "同步游标无效",
};

/** 未知 reasonCode 兜底文案（不泄露原始机器码到正文，原始码在调用处可作为 title 备查）。 */
export const UNKNOWN_REASON_TEXT = "该改动暂时无法同步，可重试或放弃后在数据表中手动处理";

/**
 * 纯函数：reasonCode → 中文文案。
 * @param reasonCode 后端原因码（可能为 null/空/未来新增码）。
 * @param reasonDetail 后端可选明细；当前不直接展示（可能含字段值），仅保留入参以备将来白名单展示。
 * 空码返空串（调用处据此隐藏原因行）；未知非空码返兜底文案，绝不抛错。
 */
export function reasonText(reasonCode: string | null | undefined, reasonDetail?: string | null): string {
  if (!reasonCode) return "";
  return REASON_TEXT[reasonCode] ?? UNKNOWN_REASON_TEXT;
}

/** 供测试/调试：当前已覆盖的原因码集合。 */
export const KNOWN_REASON_CODES: readonly string[] = Object.keys(REASON_TEXT);
