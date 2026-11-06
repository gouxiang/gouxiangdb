// e2e-bugfix030：三个 P0/UI 修复的产物级无头回归（对 dist 同源托管实例，非 dev server）。
//
// 被测修复（版本 0.3.0+6860341）：
//   修复 A（P0 单人假 409）：useDocPersistence 用 inFlightRef 单在途串行化，同 docId 任意时刻
//     最多一个 PUT 在途；ConflictNotice 仅真 409 才出现。
//   修复 B（P0 内嵌画布/表格消失）：围栏 ```canvas-embed\n<docId>\n``` 渲染为原子卡
//     .kb-wy-canvas-embed[data-block][contenteditable=false]；移除二次确认；失效引用渲染失效/受限卡不崩溃。
//   修复 C（UI）：工作区外壳二级导航 doc/canvas 行尾恢复竖三点 RowMoreMenu
//     （重命名 / 图标与颜色 / 删除），viewer 无权限只渲染占位（本 E2E 由单测保底，见文末边界说明）。
//
// 选择器全部来自 VM15 封版树源码锚点 + 首轮真实 DOM 探针（非臆造）。
// 隔离：复用 helpers.ensureSeed 的一次性用户/KB；各用例自建 doc，afterAll 软删整库。
import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { ensureSeed, loginViaUi, cleanupSeed, API_ORIGIN, WEB_ORIGIN, type SeedState } from "./helpers";

test.afterAll(async () => {
  await cleanupSeed();
});

// ---- 纯 fetch API 助手（走真实同源实例，不经浏览器 mock） ----
function authHeaders(token: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

async function createDoc(token: string, kbId: string, kind: "doc" | "canvas", title?: string) {
  const r = await api("POST", `/api/kb/${kbId}/docs`, token, { kind, title });
  expect(r.status, `createDoc ${kind} 应 201，实际 ${r.status}: ${r.text}`).toBe(201);
  return r.json.doc as { id: string; title: string; content: string; contentVersion: number; kind: string };
}

async function getDoc(token: string, docId: string) {
  const r = await api("GET", `/api/kb/docs/${docId}`, token);
  expect(r.status, `getDoc 应 200，实际 ${r.status}`).toBe(200);
  return r.json.doc as { id: string; title: string; content: string; contentVersion: number };
}

/** 收集 console error 与未捕获 pageerror（白屏/崩溃证据）。 */
function collectErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return { consoleErrors, pageErrors };
}

/** 场景 C 探针：打印二级导航真实行结构（仅 E2E_PROBE=1 时输出，辅助固化选择器）。 */
async function probeL2(page: Page, tag: string) {
  if (process.env.E2E_PROBE !== "1") return;
  const snap = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".gx-l2-row")).map((r) => {
      const nm = r.querySelector(".nm")?.textContent ?? null;
      const more = r.querySelector(".gx-row-more button");
      const placeholder = r.querySelector('.gx-row-more span[aria-hidden], span[aria-hidden=""]');
      return {
        name: nm,
        moreAria: more?.getAttribute("aria-label") ?? null,
        hasPlaceholder: !!placeholder,
      };
    });
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    return { rows, tabs };
  });
  console.log(`[PROBE:L2:${tag}] ${JSON.stringify(snap)}`);
}

test.describe("bugfix-030 三修复产物级回归", () => {
  let seed: SeedState;

  test.beforeAll(async () => {
    seed = await ensureSeed();
  });

  // VM15 5.8G 单进程串行 + 多次 goto/reload/防抖等待，全局 60s 不够，逐用例放宽到 180s。
  test.beforeEach(async () => {
    test.setTimeout(180_000);
  });

  // ============================ 场景 C：二级导航竖三点菜单 ============================
  test("C：doc/canvas 行尾竖三点菜单（三项齐全 / 重命名落库 / 图标弹窗 / 软删消失）", async ({ page }) => {
    const { consoleErrors, pageErrors } = collectErrors(page);
    const docTitle = `E2E三点文档 ${Date.now()}`;
    const doc = await createDoc(seed.token, seed.kbId, "doc", docTitle);

    await loginViaUi(page, seed);
    await page.goto(`${WEB_ORIGIN}/kb/${seed.kbId}`);
    // 新工作区外壳（enterpriseNav 默认 on）：L2 渲染该 KB 的 doc/canvas 行。
    await page.locator(".gx-l2-row .nm", { hasText: docTitle }).waitFor({ timeout: 20_000 });
    await probeL2(page, "doc-tab");

    // —— doc 行：hover 显三点，aria-label 为「<名> 文档操作菜单」 ——
    const docRow = page.locator(".gx-l2-row", { has: page.locator(".nm", { hasText: docTitle }) });
    await docRow.hover();
    const docMore = docRow.getByRole("button", { name: `${docTitle} 文档操作菜单` });
    await expect(docMore).toBeVisible();
    await docMore.click();

    // 三项齐全（MenuItem 渲染为原生 button，可读名即标签）。
    await expect(page.getByRole("button", { name: "重命名" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "图标与颜色" }).first()).toBeVisible();
    const deleteItem = page.getByRole("button", { name: "删除" }).first();
    await expect(deleteItem).toBeVisible();
    await page.keyboard.press("Escape");

    // —— 图标与颜色弹窗可挂载（标题「文档图标与颜色」），完成关闭 ——
    await docRow.hover();
    await docMore.click();
    await page.getByRole("button", { name: "图标与颜色" }).first().click();
    const iconModal = page.getByRole("dialog").filter({ hasText: "文档图标与颜色" });
    await expect(iconModal).toBeVisible();
    await iconModal.getByRole("button", { name: "完成" }).click();
    await expect(iconModal).toHaveCount(0);

    // —— 重命名：Modal「重命名文档」→ Input → 保存 → L2 与 API 标题同步变更 ——
    const renamed = `${docTitle}-改名`;
    await docRow.hover();
    await docMore.click();
    await page.getByRole("button", { name: "重命名" }).first().click();
    const renameModal = page.getByRole("dialog").filter({ hasText: "重命名文档" });
    await expect(renameModal).toBeVisible();
    await renameModal.locator("input").fill(renamed);
    await renameModal.getByRole("button", { name: "保存" }).click();
    await expect(renameModal).toHaveCount(0);
    // L2 行名即时更新
    await expect(page.locator(".gx-l2-row .nm", { hasText: renamed })).toBeVisible();
    // API 落库（轮询防抖外的 PATCH 已完成）
    await expect
      .poll(async () => (await getDoc(seed.token, doc.id)).title, { timeout: 10_000 })
      .toBe(renamed);

    // —— canvas tab：种子画布行也有三点，aria-label 为「<名> 画布操作菜单」 ——
    await page.getByRole("tab", { name: "画布" }).click();
    await probeL2(page, "canvas-tab");
    // 该 KB 当前仅 helpers 种子的一个画布，取首个画布行
    const canvasRow = page.locator(".gx-l2-row").first();
    const canvasMore = canvasRow.locator(".gx-row-more button[aria-haspopup='menu']");
    await canvasMore.waitFor();
    await canvasRow.hover();
    await canvasMore.click();
    // aria-label 后缀为「画布操作菜单」
    await expect(canvasMore).toHaveAttribute("aria-label", /画布操作菜单$/);
    await expect(page.getByRole("button", { name: "重命名" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "图标与颜色" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "删除" }).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // —— 删除（软删进回收站）：confirmSoftDelete 主按钮「删除并移入回收站」 ——
    await page.getByRole("tab", { name: "文档" }).click();
    const renamedRow = page.locator(".gx-l2-row", { has: page.locator(".nm", { hasText: renamed }) });
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: `${renamed} 文档操作菜单` }).click();
    await page.getByRole("button", { name: "删除" }).first().click();
    const confirm = page.getByRole("dialog").filter({ hasText: "删除并移入回收站" });
    await expect(confirm).toBeVisible();
    // 二次确认确实存在：先取消，行还在
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(renamedRow).toBeVisible();
    // 再走确认删除
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: `${renamed} 文档操作菜单` }).click();
    await page.getByRole("button", { name: "删除" }).first().click();
    await page.getByRole("dialog").filter({ hasText: "删除并移入回收站" }).getByRole("button", {
      name: "删除并移入回收站",
    }).click();

    // 行从 L2 消失，且列表 API 不再含该 doc（deletedAt 软删）
    await expect(page.locator(".gx-l2-row .nm", { hasText: renamed })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const r = await api("GET", `/api/kb/${seed.kbId}/docs?kind=doc`, seed.token);
          return (r.json.docs as Array<{ id: string }>).some((d) => d.id === doc.id);
        },
        { timeout: 10_000 },
      )
      .toBe(false);

    expect(pageErrors, `未捕获异常: ${pageErrors.join(" | ")}`).toEqual([]);
    console.log(`[C] consoleErrors(仅记录，404 类资源错误不算崩溃): ${JSON.stringify(consoleErrors)}`);
  });

  // ============================ 场景 A：高频编辑无假 409 + 真 409 反证 ============================
  test("A：单人高频编辑串行落库无假 409，冲突条不出现；绕过前端同 baseVersion 连发得真 409", async ({ page }) => {
    const { consoleErrors, pageErrors } = collectErrors(page);
    const doc = await createDoc(seed.token, seed.kbId, "doc", `E2E假409 ${Date.now()}`);
    const docUrl = `${WEB_ORIGIN}/kb/${seed.kbId}/doc/${doc.id}`;

    const putStatuses: number[] = [];
    page.on("response", (res) => {
      if (res.request().method() === "PUT" && res.url().includes(`/api/kb/docs/${doc.id}/content`)) {
        putStatuses.push(res.status());
      }
    });

    await loginViaUi(page, seed);
    await page.goto(docUrl);
    const editable = page.locator("[data-editable]").first();
    await editable.waitFor({ timeout: 20_000 });
    await editable.click();

    // 12 段快速输入，间隔远小于 1200ms 防抖窗口 → 单在途串行链应塌缩为若干 2xx，绝不并发同版本 PUT。
    const marker = `E2E高频${Date.now()}`;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.type(`${marker}-${i} `, { delay: 14 });
      await page.keyboard.press("Enter");
    }

    // 至少触发一次落库，再留足时间让防抖链排空
    await expect.poll(() => putStatuses.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(7_000);

    expect(putStatuses.length, "应有多次/至少一次串行 PUT").toBeGreaterThan(0);
    // 全部 2xx（单在途串行链），且明确无 409
    const non2xx = putStatuses.filter((s) => s < 200 || s >= 300);
    expect(non2xx, `出现非 2xx 状态: ${JSON.stringify(putStatuses)}`).toEqual([]);
    expect(putStatuses).not.toContain(409);
    // 冲突条与二选一按钮均不出现
    expect(await page.locator('[data-gx-conflict="true"]').count()).toBe(0);
    expect(await page.getByText("查看最新版本").count()).toBe(0);
    expect(await page.getByText("保留我的版本").count()).toBe(0);

    // reload 后文本仍在（真实落库，非仅内存）
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.locator("[data-editable]").first()).toContainText(marker);

    // —— 409 反证：绕过前端，用同一过期 baseVersion 连发两个 PUT，第二个必须真 409 ——
    const cur = await getDoc(seed.token, doc.id);
    const baseVersion = cur.contentVersion;
    const p1 = await api("PUT", `/api/kb/docs/${doc.id}/content`, seed.token, {
      content: `# 反证1 ${Date.now()}`,
      baseVersion,
    });
    expect([200, 201], `首个 PUT 应成功，实际 ${p1.status}: ${p1.text}`).toContain(p1.status);
    const p2 = await api("PUT", `/api/kb/docs/${doc.id}/content`, seed.token, {
      content: `# 反证2 ${Date.now()}`,
      baseVersion, // 仍是旧版本号 → 服务端条件更新不匹配
    });
    expect(p2.status, `同旧 baseVersion 第二个 PUT 应 409，实际 ${p2.status}`).toBe(409);
    expect(p2.json.code).toBe("VERSION_CONFLICT");
    expect(typeof p2.json.currentVersion).toBe("number");

    expect(pageErrors, `未捕获异常: ${pageErrors.join(" | ")}`).toEqual([]);
    console.log(`[A] PUT 状态序列=${JSON.stringify(putStatuses)} consoleErrors=${JSON.stringify(consoleErrors)}`);
  });

  // ============================ 场景 B：内嵌画布围栏持久化 / 移除确认 / 失效卡 ============================
  test("B：canvas-embed 围栏渲染原子卡并持久化，移除二次确认，失效/受限引用不崩溃", async ({ page }) => {
    const { consoleErrors, pageErrors } = collectErrors(page);
    const canvasId = seed.docId; // helpers 种子画布（content "[]"，存在且可访问）
    const fence = (id: string) => "```canvas-embed\n" + id + "\n```";

    // —— B1：有效围栏 → 恰好 1 张原子卡，reload 仍在、API 正文仍含围栏 ——
    const host = await createDoc(seed.token, seed.kbId, "doc", `E2E嵌块宿主 ${Date.now()}`);
    const v0 = (await getDoc(seed.token, host.id)).contentVersion;
    const put0 = await api("PUT", `/api/kb/docs/${host.id}/content`, seed.token, {
      content: `${fence(canvasId)}\n`,
      baseVersion: v0,
    });
    expect([200, 201], `写入围栏应成功，实际 ${put0.status}: ${put0.text}`).toContain(put0.status);

    await loginViaUi(page, seed);
    await page.goto(`${WEB_ORIGIN}/kb/${seed.kbId}/doc/${host.id}`);
    const card = page.locator(".kb-wy-canvas-embed[data-block]");
    await card.first().waitFor({ timeout: 20_000 });
    expect(await card.count()).toBe(1);
    // 原子卡 contentEditable=false
    expect(await card.first().getAttribute("contenteditable")).toBe("false");
    // 有效画布不是失效卡
    expect(await page.getByText("失效的画布引用").count()).toBe(0);
    // 移除按钮存在且不可编辑穿透
    const delBtn = page.locator(".kb-wy-embed-del[title='移除画布引用']");
    await expect(delBtn).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.locator(".kb-wy-canvas-embed[data-block]")).toHaveCount(1);
    expect((await getDoc(seed.token, host.id)).content).toContain("canvas-embed");

    // —— B2：移除二次确认：先取消（卡保留），再确认（卡删除并自动落库） ——
    await delBtn.click();
    const removeDialog = page.getByRole("dialog").filter({ hasText: "移除画布引用" });
    await expect(removeDialog).toBeVisible();
    await removeDialog.getByRole("button", { name: "取消" }).click();
    await expect(removeDialog).toHaveCount(0);
    await expect(page.locator(".kb-wy-canvas-embed[data-block]")).toHaveCount(1);

    await page.locator(".kb-wy-embed-del[title='移除画布引用']").click();
    await page.getByRole("dialog").filter({ hasText: "移除画布引用" }).getByRole("button", {
      name: "移除画布引用",
    }).click();
    await expect(page.locator(".kb-wy-canvas-embed[data-block]")).toHaveCount(0);
    // 防抖自动保存后，服务端正文不再含围栏
    await expect
      .poll(
        async () => (await getDoc(seed.token, host.id)).content.includes("canvas-embed"),
        { timeout: 12_000 },
      )
      .toBe(false);
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    expect(await page.locator(".kb-wy-canvas-embed[data-block]").count()).toBe(0);

    // —— B3a：空体围栏（id 缺失/损坏）→ 失效卡，含直删「移除」，无崩溃 ——
    const broken = await createDoc(seed.token, seed.kbId, "doc", `E2E失效引用 ${Date.now()}`);
    const bv = (await getDoc(seed.token, broken.id)).contentVersion;
    await api("PUT", `/api/kb/docs/${broken.id}/content`, seed.token, {
      content: "```canvas-embed\n\n```\n",
      baseVersion: bv,
    });
    await page.goto(`${WEB_ORIGIN}/kb/${seed.kbId}/doc/${broken.id}`);
    const brokenCard = page.locator(".kb-wy-canvas-embed[data-block]").first();
    await brokenCard.waitFor({ timeout: 20_000 });
    await expect(brokenCard).toContainText("失效的画布引用");
    await expect(brokenCard).toContainText("画布 id 缺失或已损坏");
    await expect(brokenCard.getByRole("button", { name: "移除" })).toBeVisible();

    // —— B3b：不存在的画布 id → CanvasEmbed 受限占位，不崩溃 ——
    const ghost = await createDoc(seed.token, seed.kbId, "doc", `E2E幽灵画布 ${Date.now()}`);
    const gv = (await getDoc(seed.token, ghost.id)).contentVersion;
    const ghostId = "c" + "0".repeat(23); // 24 字符、库中不存在
    await api("PUT", `/api/kb/docs/${ghost.id}/content`, seed.token, {
      content: `${fence(ghostId)}\n`,
      baseVersion: gv,
    });
    await page.goto(`${WEB_ORIGIN}/kb/${seed.kbId}/doc/${ghost.id}`);
    const ghostCard = page.locator(".kb-wy-canvas-embed[data-block]").first();
    await ghostCard.waitFor({ timeout: 20_000 });
    await expect(ghostCard).toContainText("该画布未包含在可访问范围内，或已被删除。");

    expect(pageErrors, `失效引用不应产生未捕获异常: ${pageErrors.join(" | ")}`).toEqual([]);
    console.log(`[B] pageErrors=0 consoleErrors=${JSON.stringify(consoleErrors)}`);
  });
});

// 边界说明（无法在本产物 E2E 端到端覆盖，由既有单测保底）：
//  1) 修复 C 的 viewer 收敛：rowMenuItems 在 canCreate=false 时返回 []，RowMoreMenu 渲染 span[aria-hidden]
//     占位。构造 viewer 需第二账号 + 分享/成员授权链，超出单实例单账号夹具范围；该分支由
//     SecondaryNavSections / SecondaryNavKbOps 的 vitest 单测断言（items.length===0 占位）。
//  2) 修复 B 的协同深层 reconcileRemoteBlocks：VITE_COLLAB 默认关（collabActive=false → 走 REST 整篇 PUT），
//     产物实例无 CRDT 通道，远端结构回放兜底由 embed-reconcile.test.ts 纯函数单测保底。
