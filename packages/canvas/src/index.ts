// @gx/canvas —— 画布数据层规则（M6/S6b）：纯函数、零 IO、零 plait/浏览器依赖。
// 当前唯一消费者 = apps/api 的 canvas.commit_elements；前端 canvas-ops 本片不改（见 validate.ts 头注）。
export * from "./validate";
