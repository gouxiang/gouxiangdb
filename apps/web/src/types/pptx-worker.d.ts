// apps/web/src/types/pptx-worker.d.ts
// Vite 的 ?worker 后缀导入没有包内类型（包只导出了 "./worker/pptx.worker.js" 本体），
// 这里补一个最小声明，避免 `import Ctor from "...?worker"` 落到隐式 any。
//
// Vite 编译该导入的产物：默认导出一个 Worker 构造器（`new Ctor()` 得到 Worker），
// 并把 worker 代码编成独立的 chunk（不进主 chunk）。

declare module "@file-viewer/pptx/worker/pptx.worker.js?worker" {
  const PptxWorker: new () => Worker;
  export default PptxWorker;
}
