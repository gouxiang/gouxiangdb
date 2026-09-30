// @gx/canvas —— 画布数据层规则：纯函数、零 IO、零 plait/浏览器依赖。
//  - validate.ts：element.create 最小集（向后兼容的 validateCreateOps）
//  - mutate.ts：commitElements（create/update/move/delete/connect 混批，#622 起主入口）
//  - shared.ts：类型/字节/id/content/禁键/矩形几何 共享真源
// 主要消费者 = apps/api 的 canvas.commit_elements；前端 canvas-ops 不改（见各文件头注）。
export * from "./shared";
export * from "./validate";
export * from "./mutate";
