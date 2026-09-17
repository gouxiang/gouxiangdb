// scripts/acceptance/seed/canvas.mjs
// 构造 >=6 块画布的确定性 PlaitElement[] JSON。纯函数。
// 覆盖：矩形 / 箭头 / 连线 / 关联卡（含 3x2 网格 6+1）/ 脑图 / gxNote+gxDocRef+gxLinkRef / 负 viewBox。
//
// 说明（与 R8 裁决一致）：
//   - gxNote 是当前 @gx/canvas 唯一允许的 gx* 写入键；gxDocRef/gxLinkRef 是二期拒收键，
//     但旧 v0.1.0 库不经新校验（PUT content 接受 <=10MB 任意串），且升级只保字节、
//     分享闭包（collectRefDocIds）仍解析这两个键 —— 故深 3 闭包画布必须含它们。
//   - 元素数组顺序即 z 序（z-order）；id 批内唯一；几何坐标含负值（负 viewBox 文档）。

/**
 * 矩形几何元素。
 */
function rect(id, x, y, w, h, extra = {}) {
  return {
    id,
    type: "geometry",
    shape: "rectangle",
    angle: 0,
    points: [[{ x, y }]],
    ...extra,
  };
}

/** 箭头（带两端 marker）。 */
function arrow(id, x1, y1, x2, y2, extra = {}) {
  return {
    id,
    type: "drawnix",
    shape: "arrow",
    angle: 0,
    points: [
      [{ x: x1, y: y1 }],
      [{ x: x2, y: y2 }],
    ],
    markerStart: "arrow",
    markerEnd: "arrow",
    ...extra,
  };
}

/** 连线（无箭头折线）。 */
function line(id, pts, extra = {}) {
  return { id, type: "drawnix", shape: "line", angle: 0, points: pts, ...extra };
}

/** 关联卡（引用某文档的节点）。 */
function refCard(id, x, y, docId, label) {
  return rect(id, x, y, 200, 96, {
    shape: "rectangle",
    gxNote: label,
    gxDocRef: { docId },
  });
}

/**
 * 6 块，返回 [{key,title,content}]。
 *
 * 闭包关键事实（v0.1.0 public.ts collectRefDocIds/buildShareReferenceClosure）：
 *   分享闭包内画布中的 gxDocRef/gxLinkRef.docId 会被【拉入】匿名可读闭包；
 *   因此真正的越界 403 目标必须是"既不在分享子树内、也不被闭包内任何画布引用"的独立文档。
 *   本文件里：
 *     - 闭包画布 cv4 的 gxDocRef -> 第三层 grand（经引用进入闭包，可读）；gxLinkRef -> child（子树内）。
 *     - docOutOfScope 是同库独立顶层文档，不挂分享根、不被引用 -> 访问 /ref/docOutOfScope 必须 403。
 *
 * @param {object} refs
 * @param {string} refs.docRoot        深 3 树根 doc id
 * @param {string} refs.docChild       第二层（分享子树内）
 * @param {string} refs.docGrand       第三层（仅经 gxDocRef 进入闭包）
 * @param {string} refs.docOutOfScope  闭包外独立文档（403 目标，禁止被任何闭包画布引用）
 */
export function buildCanvases(refs) {
  const out = [];

  // 1) 矩形 + 箭头 + 连线基础板
  out.push({
    key: "shapes",
    title: "画布1-矩形箭头连线",
    content: JSON.stringify([
      rect("cv1_e1", 40, 40, 160, 100, { gxNote: "矩形A" }),
      rect("cv1_e2", 300, 60, 120, 80, { fill: "#E8F0FE", gxNote: "矩形B" }),
      arrow("cv1_e3", 200, 90, 300, 100),
      line("cv1_e4", [[[{ x: 60, y: 200 }], [{ x: 180, y: 260 }], [{ x: 320, y: 220 }]]]),
    ]),
  });

  // 2) 关联卡 3x2 网格（6 张卡 + 1 张额外卡 = 7 元素）。只引用分享树内 docRoot，
  //    绝不引用 docOutOfScope（那会把它拉入闭包，破坏 403 用例）。
  const grid = [];
  const cols = 3;
  const cw = 180;
  const ch = 90;
  const gap = 24;
  let gi = 0;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      grid.push(refCard(`cv2_card_${gi}`, 40 + c * (cw + gap), 40 + r * (ch + gap), refs.docRoot, `关联卡 ${gi + 1}`));
      gi++;
    }
  }
  grid.push(refCard("cv2_card_extra", 40, 40 + 2 * (ch + gap), refs.docChild, "额外卡(子树内)"));
  out.push({ key: "cards", title: "画布2-关联卡3x2网格", content: JSON.stringify(grid) });

  // 3) 脑图（中心节点 + 辐射分支）
  const mind = [
    rect("cv3_root", 360, 260, 140, 60, { shape: "mindmap", gxNote: "中心主题" }),
  ];
  for (let i = 0; i < 5; i++) {
    const ang = (Math.PI * 2 * i) / 5;
    const x = 360 + 140 + Math.round(Math.cos(ang) * 220);
    const y = 260 + 30 + Math.round(Math.sin(ang) * 160);
    mind.push(rect(`cv3_b${i}`, x, y, 120, 44, { shape: "mindmap", gxNote: `分支${i + 1}` }));
    mind.push(line(`cv3_l${i}`, [[[{ x: 430, y: 290 }], [{ x: x + 60, y: y + 22 }]]]));
  }
  out.push({ key: "mindmap", title: "画布3-脑图", content: JSON.stringify(mind) });

  // 4) gxNote + gxDocRef + gxLinkRef 自定义键（深 3 闭包的关键画布，挂在分享子树第二层）。
  //    gxDocRef 把第三层 grand 拉入闭包（可读）；gxLinkRef 指向子树内 child；
  //    绝不引用 docOutOfScope（否则它会被拉入闭包，403 用例失效）。
  out.push({
    key: "closure",
    title: "画布4-自定义键引用闭包",
    closureRefs: { inClosure: refs.docGrand, inSubtree: refs.docChild },
    content: JSON.stringify([
      rect("cv4_e1", 40, 40, 220, 100, { gxNote: "合法备注键 gxNote" }),
      rect("cv4_e2", 40, 180, 220, 100, {
        gxNote: "引用闭包内第三层文档（经 gxDocRef 拉入，可读）",
        gxDocRef: { docId: refs.docGrand },
      }),
      rect("cv4_e3", 40, 320, 220, 100, {
        gxNote: "链接子树内第二层（本就在 shareIncludeChildren 闭包）",
        gxLinkRef: { docId: refs.docChild },
      }),
    ]),
  });

  // 5) 负 viewBox 文档（所有坐标为负，验证越界坐标系保真）
  out.push({
    key: "negviewbox",
    title: "画布5-负viewBox",
    content: JSON.stringify([
      rect("cv5_e1", -640, -480, 180, 100, { gxNote: "负坐标矩形" }),
      rect("cv5_e2", -420, -360, 120, 80, { gxNote: "负坐标二" }),
      arrow("cv5_e3", -460, -430, -420, -360),
      line("cv5_e4", [[[{ x: -640, y: -380 }], [{ x: -520, y: -280 }], [{ x: -300, y: -340 }]]]),
    ]),
  });

  // 6) 含 gxNote 的便签密集板（z 序验证：元素多、顺序关键）
  const notes = [];
  for (let i = 0; i < 12; i++) {
    notes.push(
      rect(`cv6_n${i}`, 30 + (i % 4) * 210, 30 + Math.floor(i / 4) * 150, 190, 120, {
        fill: i % 2 ? "#FFF8E1" : "#E3F2FD",
        gxNote: `便签 ${i + 1}：z 序第 ${i} 层`,
      }),
    );
  }
  out.push({ key: "stickers", title: "画布6-便签z序", content: JSON.stringify(notes) });

  return out;
}
