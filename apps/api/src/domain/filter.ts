// apps/api/src/domain/filter.ts
// 过滤引擎实现已上移到 packages/shared-types/src/filter.ts，
// 这里仅 re-export，保持现有 `import { evalFilter } from "./filter.js"` 调用不变。

export {
  evalFilter,
  toComparableText,
  isEmptyValue,
  matchesSearch,
  type RawValue,
} from "@gx/shared-types";
