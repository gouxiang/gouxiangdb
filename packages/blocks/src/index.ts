// @gx/blocks —— 文档块模型与 Markdown 双向转换（**从 apps/web/src/features/kb 原样搬出**）
//
// 为什么下沉为共享包（M6/S5）：AI 经 MCP 写文档需要**与网页端同一套**块/Markdown 规则
// （blocksToMd 是唯一写出口），否则两端语义必然漂移。搬运为纯移动，web 侧行为零变化。
export * from "./blocks";
export * from "./markdown";
// 行内 Markdown ↔ 渲染 HTML 的偏移映射（协同阶段 2 用：光标在源码偏移与 DOM 偏移之间互转）
export * from "./inlineOffsets";
