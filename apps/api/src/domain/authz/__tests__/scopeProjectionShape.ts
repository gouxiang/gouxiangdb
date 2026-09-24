// P1/S2 scopeProjection 对拍共用的活 schema 形状夹具。
// 单独成文件（不放在 .test.ts 内）：vitest 下跨测试文件 import 另一个 .test 文件会把其
// describe/it 重复注册；夹具独立导出，scopeProjection.test.ts 与 scopeProjection-sparse.test.ts 共用。

import type { LiveSchemaShape } from "../scopeProjection.js";

export const SHAPE: LiveSchemaShape = {
  tableIds: ["t1", "t2"],
  fieldIdsByTable: new Map([
    ["t1", ["f1", "f2", "f3"]],
    ["t2", ["fa", "fb"]],
  ]),
};
