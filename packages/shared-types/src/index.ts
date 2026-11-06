// packages/shared-types/src/index.ts
// 共享类型总入口
//
// 分层约定：
//   ids.ts          — 品牌类型（BaseIdT/TableIdT/FieldIdT...）
//   fields.ts       — 字段类型系统（28 种）
//   relations.ts    — 关联语义（mm/hm/bt 及反向映射）
//   links.ts        — 结构化 LinkRef
//   filters.ts      — 过滤引擎类型
//   views.ts        — 视图配置 / 排序 / 分组 / 聚合
//   permissions.ts  — RBAC 角色与权限位
//   api.ts          — 前后端 HTTP 契约（唯一真源）
//   layoutVersion.ts — 表单设计器布局版本信封（前后端共用的唯一真源）
//   sync.ts         — 离线同步协议握手契约（探针版本协商 + 写端点协议错误码）

export * from "./ids.js";
export * from "./fields.js";
export * from "./type-groups.js";
export * from "./relations.js";
export * from "./links.js";
export * from "./filters.js";
export * from "./filter.js";
export * from "./views.js";
export * from "./viewAdmin.js";
export * from "./viewUserPrefs.js";
export * from "./permissions.js";
export * from "./formula-functions.js";
export * from "./defaults.js";
export * from "./api.js";
export * from "./embeddingMultimodal.js";
export * from "./org.js";
export * from "./roleLibraryScope.js";
export * from "./nav.js";
export * from "./authz.js";
export * from "./policy.js";
export * from "./share.js";
export * from "./collab.js";
export * from "./layoutVersion.js";
export * from "./sync.js";
export * from "./update.js";
export * from "./branding.js";
export * from "./license.js";
