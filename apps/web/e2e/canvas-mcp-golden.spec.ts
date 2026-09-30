// M6/S6b 第三步：canvas.commit_elements 服务端写入 → 前端真实 PlaitBoard 加载 golden。
//
// 这是 AC-M6-3 画布部分的最终证据：服务端静态只能校验 4/6 不变量，plait 的 normalize
// 行为无法静态论证。本用例在真实 chromium + webkit 里证明：
//   1) 经真 MCP 协议（POST /mcp + Bearer PAT，JSON-RPC tools/call）尾插 3 矩形回执正确；
//   2) 浏览器真实打开画布页（真实登录态，无 mock）渲染出「原有 1 + 新 3」共 4 个矩形，
//      无 console error、无白屏崩溃；
//   3) normalize 不吞键：fill/strokeColor/strokeWidth/gxNote 在保存后的板上仍在；
//   4) 可再保存：UI 形状工具拖拽加 1 个矩形，触发防抖 PUT 成功，contentVersion 再 +1；
//   5) 往返一致：再经 MCP get_board 读回，3 个服务端矩形仍在、id 未被 plait 改写、
//      普通键/gxNote 未剥离、尾插顺序保持、UI 编辑也落库（双向兼容，非只读能看一存就丢）。
//
// DOM 选择器均来自真实结构探针（非臆造）：
//   - 矩形几何节点：.kb-canvas-wrap g[plait-geometry="true"]，属性 plait-data-id === 元素 id；
//     drawnix 圆角矩形用 <path> 绘制（不是 <rect>），plait-data-id 是可靠锚点。
//   - 形状工具：工具栏 button[title="形状"]，默认矩形；拖拽区 .viewport-container。
//   - 保存：PUT /api/kb/docs/:id/content（防抖自动上云）。
import { test, expect, type Page } from "@playwright/test";
import {
  ensureSeed,
  loginViaUi,
  canvasUrl,
  commitElements,
  getBoard,
  cleanupSeed,
  rect,
  type BoardElement,
} from "./helpers";

test.afterAll(async () => {
  await cleanupSeed();
});

const GEOM = ".kb-canvas-wrap g[plait-geometry='true']";

async function openCanvas(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe("canvas.commit_elements 真实 PlaitBoard 加载 golden", () => {
  test("MCP 尾插三矩形→浏览器渲染 4 个→不吞键→UI 可再编辑保存→get_board 往返一致", async ({ page }) => {
    const seed = await ensureSeed();

    // —— 第 1 步：先放 1 个「原有」种子矩形（朴素） ——
    const seedCommit = await commitElements(seed.pat, seed.docId, [
      { op: "element.create", element: rect({ points: [[0, 0], [60, 40]] }) },
    ]);
    expect(seedCommit.ok).toBe(true);
    expect(seedCommit.contentVersion).toBe(1);
    expect(seedCommit.createdIds).toHaveLength(1);
    const seedId = seedCommit.createdIds[0]!;

    // —— 第 2 步：经真 MCP 尾插 3 个矩形（朴素 / 普通样式键 / gxNote） ——
    const commit = await commitElements(seed.pat, seed.docId, [
      { op: "element.create", element: rect() },
      {
        op: "element.create",
        element: rect({
          points: [
            [120, 10],
            [220, 90],
          ],
          fill: "#ff0000",
          strokeColor: "#00aa00",
          strokeWidth: 3,
        }),
      },
      {
        op: "element.create",
        element: rect({
          points: [
            [240, 10],
            [340, 90],
          ],
          gxNote: "E2E注释",
        }),
      },
    ]);
    expect(commit.ok, `commit 回执应成功`).toBe(true);
    expect(commit.contentVersion).toBe(2);
    expect(commit.createdIds).toHaveLength(3);
    expect(new Set(commit.createdIds).size).toBe(3);
    const [plainId, styledId, notedId] = commit.createdIds as [string, string, string];
    expect([plainId, styledId, notedId]).not.toContain(seedId);

    // —— 第 3 步：真实登录 + 真实打开画布页 ——
    const errors = await openCanvas(page);
    await loginViaUi(page, seed);
    await page.goto(canvasUrl(seed));

    // 画布容器与 4 个几何矩形（无白屏：wrap 存在 + 4 个 g[plait-geometry]）
    await page.locator(".kb-canvas-wrap").waitFor({ state: "visible" });
    await expect(page.locator(GEOM)).toHaveCount(4, { timeout: 30_000 });

    // 服务端 id 原样成为 DOM plait-data-id（plait 未改写 id）
    for (const id of [seedId, plainId, styledId, notedId]) {
      await expect(page.locator(`g[plait-data-id="${id}"]`)).toHaveCount(1);
    }

    // 无控制台 error / pageerror（plait normalize 不抛、React 不崩）
    await page.waitForTimeout(1500); // 给异步增强 overlay/观察者一点时间
    expect(errors, `不应有控制台错误：${errors.join(" | ")}`).toEqual([]);

    // —— 第 4 步：normalize 不吞键（在页面内核对几何节点的 SVG 呈现 + 数据） ——
    // fill/strokeColor 经 drawnix 样式落到 path 属性；gxNote 由数据层承载（见 get_board）。
    const styledRendered = await page.evaluate((id) => {
      const g = document.querySelector(`.kb-canvas-wrap g[plait-data-id="${id}"]`);
      if (!g) return { found: false };
      const paths = Array.from(g.querySelectorAll("path")).map((p) => ({
        fill: p.getAttribute("fill"),
        stroke: p.getAttribute("stroke"),
        sw: p.getAttribute("stroke-width"),
      }));
      return { found: true, paths };
    }, styledId);
    expect(styledRendered.found).toBe(true);
    // 至少有一个 path 体现 fill/stroke（drawnix 用 fill-path 与 stroke-path 分离）
    const allAttrs = JSON.stringify(styledRendered.paths);
    expect(allAttrs).toContain("#ff0000");
    expect(allAttrs).toContain("#00aa00");

    // —— 第 5 步：UI 真实编辑——形状工具拖拽加 1 个矩形，触发防抖保存 ——
    const putUrls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PUT" && req.url().includes(`/api/kb/docs/${seed.docId}/content`)) {
        putUrls.push(req.url());
      }
    });

    await page.locator('[title="形状"], [aria-label="形状"]').first().click();
    await page.waitForTimeout(400);
    // 形状工具默认即矩形；在视口空白区拖出一个新矩形
    const host = page.locator(".viewport-container").first();
    const box = await host.boundingBox();
    expect(box).not.toBeNull();
    const b = box!;
    const x1 = b.x + b.width * 0.55;
    const y1 = b.y + b.height * 0.55;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x1 + 180, y1 + 130, { steps: 10 });
    await page.mouse.up();

    // 板上矩形数 4 → 5
    await expect(page.locator(GEOM)).toHaveCount(5, { timeout: 15_000 });

    // 防抖 PUT 自动上云（drawnix 默认约 1s 防抖 + 网络）
    await expect
      .poll(() => putUrls.length, { timeout: 30_000, message: "UI 编辑应触发 content PUT" })
      .toBeGreaterThan(0);
    // 等防抖落库稳定
    await page.waitForTimeout(2500);

    // —— 第 6 步：MCP get_board 往返一致 ——
    const board = await getBoard(seed.pat, seed.docId);
    // contentVersion 已在第 2 步 =2；UI 保存后应再增加（至少 3）
    expect(board.contentVersion).toBeGreaterThanOrEqual(3);
    expect(board.elements.length).toBeGreaterThanOrEqual(5);

    const byId = new Map<string, BoardElement>(board.elements.map((e) => [String(e.id), e]));

    // 3 个服务端写入矩形仍在
    for (const id of [plainId, styledId, notedId]) {
      expect(byId.has(id), `服务端矩形 ${id} 在 UI 保存后仍应存在`).toBe(true);
    }
    // 普通样式键未被 plait normalize 剥离
    const styled = byId.get(styledId)!;
    expect(styled.fill).toBe("#ff0000");
    expect(styled.strokeColor).toBe("#00aa00");
    expect(styled.strokeWidth).toBe(3);
    // gxNote 未丢
    const noted = byId.get(notedId)!;
    expect(noted.gxNote).toBe("E2E注释");
    // 朴素矩形仍是 geometry/rectangle 且两点正宽高
    const plain = byId.get(plainId)!;
    expect(plain.type).toBe("geometry");
    expect(plain.shape).toBe("rectangle");
    expect(Array.isArray(plain.points) && plain.points.length === 2).toBe(true);

    // 尾插顺序：朴素/样式/注释三矩形在数组中的相对顺序保持（种子矩形在最前）
    const orderIds = board.elements.map((e) => String(e.id));
    const iSeed = orderIds.indexOf(seedId);
    const iPlain = orderIds.indexOf(plainId);
    const iStyled = orderIds.indexOf(styledId);
    const iNoted = orderIds.indexOf(notedId);
    expect(iSeed).toBeLessThan(iPlain);
    expect(iPlain).toBeLessThan(iStyled);
    expect(iStyled).toBeLessThan(iNoted);

    // UI 新拖的矩形也落库（板元素总数 = 5；证明双向兼容：UI 保存没有冲掉服务端写入，
    // 也没有只在本地）。UI 矩形 id 非服务端三 id 之一。
    expect(board.elements).toHaveLength(5);
    const uiAdded = orderIds.filter(
      (id) => ![seedId, plainId, styledId, notedId].includes(id),
    );
    expect(uiAdded).toHaveLength(1);
    const uiEl = byId.get(uiAdded[0]!)!;
    expect(uiEl.type).toBe("geometry");

    // 收尾再确认一次：整段流程没有控制台错误
    expect(errors, `流程结束仍不应有控制台错误：${errors.join(" | ")}`).toEqual([]);
  });
});
