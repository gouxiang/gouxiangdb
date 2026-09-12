// packages/shared-types/src/relations.ts
// 关系系统（从 v1 Core/Models.swift GXRelationType 1:1 移植）
// 关系类型语义：mm / hm / bt + 反向映射
//
// 语义对照表（v1 Core 注释对齐）：
//   mm: 多对多 (Many-to-Many)
//   hm: 一对多 (Has-Many)        反向是 bt
//   bt: 多对一 (Belongs-To)      反向是 hm
//
// 重要：bt 的反向不是 bt，是 hm。这是 v1 修复过的 bug。

export type RelationKind = "mm" | "hm" | "bt";

export interface RelationTypeDef {
  readonly kind: RelationKind;
  readonly displayName: string;
  readonly multiple: boolean; // 此端是否多值
}

const DEFS: Record<RelationKind, RelationTypeDef> = {
  mm: { kind: "mm", displayName: "Many-to-Many", multiple: true },
  hm: { kind: "hm", displayName: "Has-Many", multiple: true },
  bt: { kind: "bt", displayName: "Belongs-To", multiple: false },
};

export function relationType(kind: RelationKind): RelationTypeDef {
  return DEFS[kind];
}

// 反向关系类型
export function reverseRelation(kind: RelationKind): RelationKind {
  switch (kind) {
    case "mm":
      return "mm";
    case "hm":
      return "bt";
    case "bt":
      return "hm"; // 注意 bt 反向是 hm，不是 bt
  }
}

// 反向端是否多值
export function reverseIsMultiple(kind: RelationKind): boolean {
  return DEFS[reverseRelation(kind)].multiple;
}

// 正向端是否多值（用于决定显示和编辑控件）
export function isMultiple(kind: RelationKind): boolean {
  return DEFS[kind].multiple;
}