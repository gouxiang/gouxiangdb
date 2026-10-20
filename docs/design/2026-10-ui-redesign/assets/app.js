/* ============================================================
   骨架渲染器（纯静态，无依赖，file:// 直接可开）
   ============================================================ */

(function () {
  var pages = window.GX_PAGES || [];
  var groups = window.GX_GROUPS || [];
  var state = { zoom: 0.75, annot: true };

  var railBody = document.getElementById("railBody");
  var stageName = document.getElementById("stageName");
  var stageRoute = document.getElementById("stageRoute");
  var stageStage = document.getElementById("stageStage");
  var canvasFit = document.getElementById("canvasFit");
  var canvas = document.getElementById("canvas");

  /* ---------- 左侧清单 ---------- */
  function renderRail(activeId) {
    railBody.innerHTML = "";
    groups.forEach(function (g) {
      var items = pages.filter(function (p) { return p.group === g; });
      if (!items.length) return;

      var h = document.createElement("div");
      h.className = "rail-group";
      h.textContent = g;
      railBody.appendChild(h);

      items.forEach(function (p) {
        /* 用 button 而不是 <a href="#...">：不产生任何导航，
           避免预览面板 / iframe sandbox 拦截同文档跳转导致"点不动" */
        var a = document.createElement("button");
        a.type = "button";
        a.className = "rail-item" + (p.id === activeId ? " is-active" : "");
        a.dataset.pageId = p.id;

        var idx = document.createElement("span");
        idx.className = "rail-idx";
        idx.textContent = String(pages.indexOf(p) + 1).padStart(2, "0");

        var label = document.createElement("span");
        label.textContent = p.name;

        a.appendChild(idx);
        a.appendChild(label);
        a.addEventListener("click", function (e) {
          e.preventDefault();
          go(p.id);
        });
        railBody.appendChild(a);
      });
    });
  }

  /* ---------- 骨架块 ---------- */
  function blockEl(b, parentFlex) {
    if (b.row) {
      var row = document.createElement("div");
      row.className = "node node-row";
      row.style.height = (b.h || 0) + "px";
      if (b.flex) row.style.flex = b.flex + " 1 0";
      b.row.forEach(function (child) {
        var c = blockEl(child, true);
        if (!c) return;
        if (child.flex) { c.style.flex = child.flex + " 1 0"; c.style.height = "auto"; }
        row.appendChild(c);
      });
      return row;
    }

    if (!b.h && !b.flex && !b.w) return null; // h:0 = 条件出现，不占位

    var el = document.createElement("div");
    el.className = "node" + (b.solid ? " is-solid" : "");

    if (b.w) {
      el.style.flex = "none";
      el.style.width = b.w + "px";
      el.style.height = "auto";
    } else if (b.flex) {
      el.style.flex = b.flex + " 1 0";
      el.style.height = "auto";
    } else {
      el.style.flex = "none";
      el.style.height = b.h + "px";
    }

    var n = document.createElement("div");
    n.className = "node-name";
    n.textContent = b.name;
    el.appendChild(n);

    if (b.note) {
      var note = document.createElement("div");
      note.className = "node-note";
      note.textContent = b.note;
      el.appendChild(note);
    }
    return el;
  }

  function fillBlocks(container, blocks) {
    (blocks || []).forEach(function (b) {
      var el = blockEl(b);
      if (el) container.appendChild(el);
    });
  }

  /* ---------- 壳层 ---------- */
  var L1_UP = [
    { id: "portal", label: "个人门户" },
    { id: "tables", label: "工作区数据库" },
    { id: "kb", label: "知识库" },
  ];
  var L1_DOWN = [
    { id: "contacts", label: "通讯录" },
    { id: "authz", label: "权限管理" },
    { id: "nav", label: "导航编排" },
    { id: "settings", label: "工作区设置" },
  ];

  function navItem(label, active) {
    var d = document.createElement("div");
    d.className = "gx-nav-item" + (active ? " is-active" : "");
    var dot = document.createElement("span");
    dot.className = "gx-nav-dot";
    var t = document.createElement("span");
    t.textContent = label;
    d.appendChild(dot);
    d.appendChild(t);
    return d;
  }

  function buildTopBar() {
    var bar = document.createElement("div");
    bar.className = "gx-topbar";
    bar.innerHTML =
      '<div class="gx-brand"><span class="gx-brand-mark"></span><span>构想工作台</span></div>' +
      '<div class="gx-searchpill"><span>搜索表、文档、成员</span><span class="kbd">⌘K</span></div>' +
      '<div style="flex:1"></div>' +
      '<div class="gx-searchpill" style="width:auto;background:transparent;padding:0 8px">帮助</div>' +
      '<div class="gx-avatar"></div>';
    return bar;
  }

  function buildL1(active) {
    var l1 = document.createElement("div");
    l1.className = "gx-l1";

    var scroll = document.createElement("div");
    scroll.className = "gx-l1-scroll";
    L1_UP.forEach(function (i) { scroll.appendChild(navItem(i.label, active === i.id)); });
    l1.appendChild(scroll);

    var foot = document.createElement("div");
    foot.className = "gx-l1-foot";
    L1_DOWN.forEach(function (i) { foot.appendChild(navItem(i.label, active === i.id)); });
    var card = document.createElement("div");
    card.className = "gx-usercard";
    card.innerHTML = '<span class="gx-avatar" style="width:20px;height:20px"></span><span>戴 · 工作区所有人</span>';
    foot.appendChild(card);
    l1.appendChild(foot);
    return l1;
  }

  function l2Item(label, active, indent) {
    var d = document.createElement("div");
    d.className = "gx-l2-item" + (active ? " is-active" : "");
    if (indent) d.style.paddingLeft = 8 + indent * 12 + "px";
    d.textContent = label;
    return d;
  }

  function buildL2(kind, pageName) {
    var l2 = document.createElement("div");
    l2.className = "gx-l2";

    var head = document.createElement("div");
    head.className = "gx-l2-head";
    head.innerHTML = '<span class="gx-nav-dot" style="background:var(--gx-ink)"></span><span class="gx-l2-title">产品中心</span>';
    l2.appendChild(head);

    var scroll = document.createElement("div");
    scroll.className = "gx-l2-scroll";

    if (kind === "tables") {
      scroll.appendChild(l2Item("＋ 新建数据表", false));
      ["需求池", "迭代计划", "缺陷跟踪", "客户档案", "内容排期", "供应商", "指标口径"].forEach(function (t, i) {
        scroll.appendChild(l2Item(t, pageName.indexOf("数据表主界面") > -1 && i === 0));
      });
    } else if (kind === "docs") {
      scroll.appendChild(l2Item("＋ 新建文档", false));
      scroll.appendChild(l2Item("产品", false));
      scroll.appendChild(l2Item("需求说明", true, 1));
      scroll.appendChild(l2Item("竞品调研", false, 1));
      scroll.appendChild(l2Item("研发", false));
      scroll.appendChild(l2Item("接口约定", false, 1));
      scroll.appendChild(l2Item("运维手册", false, 1));
      scroll.appendChild(l2Item("会议纪要", false));
    } else if (kind === "settings") {
      scroll.appendChild(l2Item("概览", true));
      scroll.appendChild(l2Item("数据表", false));
      scroll.appendChild(l2Item("成员与权限", false));
      scroll.appendChild(l2Item("回收站", false));
      scroll.appendChild(l2Item("危险操作", false));
    }
    l2.appendChild(scroll);
    return l2;
  }

  function buildViewTabs(tabs) {
    var bar = document.createElement("div");
    bar.className = "gx-viewtabs";
    tabs.forEach(function (t, i) {
      var el = document.createElement("span");
      el.className = "gx-tab" + (i === 0 ? " is-active" : "");
      el.textContent = t;
      bar.appendChild(el);
    });
    return bar;
  }

  function buildShell(page) {
    var app = document.createElement("div");
    app.className = "app";
    app.appendChild(buildTopBar());

    var body = document.createElement("div");
    body.className = "gx-body";
    body.appendChild(buildL1(page.l1));
    if (page.l2) body.appendChild(buildL2(page.l2, page.name));

    var content = document.createElement("div");
    content.className = "gx-content";
    if (page.tabs) content.appendChild(buildViewTabs(page.tabs));

    var area = document.createElement("div");
    area.className = "gx-canvas-area";
    fillBlocks(area, page.blocks);
    content.appendChild(area);

    body.appendChild(content);
    app.appendChild(body);
    return app;
  }

  /* ---------- 浮层 ---------- */
  function applyOverlay(app, ov) {
    var content = app.querySelector(".gx-content");
    var overlay = document.createElement("div");
    overlay.className = "gx-overlay";

    var scrim = document.createElement("div");
    scrim.className = "gx-scrim";
    if (ov.type === "popover") scrim.style.background = "transparent";
    overlay.appendChild(scrim);

    var sheet = document.createElement("div");
    sheet.className = "gx-sheet " + (ov.type === "drawer" ? "is-drawer" : "is-modal");
    if (ov.type === "popover") {
      sheet.style.top = "16px";
      sheet.style.left = "50%";
      sheet.style.transform = "translateX(-50%)";
      sheet.style.width = "520px";
      sheet.style.maxHeight = "none";
    }

    var title = document.createElement("div");
    title.className = "gx-sheet-title";
    title.textContent = ov.type === "drawer" ? "记录详情" : (ov.type === "modal" ? "对话框" : "浮层");
    sheet.appendChild(title);

    var box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:8px;flex:1;min-height:0";
    fillBlocks(box, ov.blocks);
    sheet.appendChild(box);

    overlay.appendChild(sheet);
    content.appendChild(overlay);
  }

  function buildStandalone(page) {
    var wrap = document.createElement("div");
    wrap.className = "standalone";
    var card = document.createElement("div");
    card.className = "standalone-card";
    fillBlocks(card, page.blocks);
    wrap.appendChild(card);
    return wrap;
  }

  /* ---------- 舞台 ---------- */
  function applyZoom() {
    canvas.style.transform = "scale(" + state.zoom + ")";
    canvasFit.style.width = 1440 * state.zoom + "px";
    canvasFit.style.height = 900 * state.zoom + "px";
  }

  function render(id) {
    var page = pageById(id);

    currentPageId = page.id;
    renderRail(page.id);
    stageName.textContent = page.name;
    stageRoute.textContent = page.route;

    canvas.innerHTML = "";
    canvas.classList.toggle("annot-off", !state.annot);

    if (page.kind === "standalone") {
      canvas.appendChild(buildStandalone(page));
    } else {
      var basePage = page;
      if (page.kind === "overlay" && page.base) {
        basePage = pages.filter(function (p) { return p.id === page.base; })[0] || page;
      }
      var app = buildShell(basePage);
      if (page.kind === "overlay" && page.overlay) applyOverlay(app, page.overlay);
      canvas.appendChild(app);
    }

    applyZoom();
    document.title = page.name + " · UI v2 骨架";
  }

  var currentPageId = null;

  function pageById(id) {
    return pages.filter(function (p) { return p.id === id; })[0] || pages[0];
  }

  function currentId() {
    var h = "";
    try { h = location.hash.replace(/^#\/?/, ""); } catch (e) { h = ""; }
    return h || pages[0].id;
  }

  /* 切换页面：直接渲染，不依赖任何导航行为 */
  function go(id) {
    var page = pageById(id);
    render(page.id);
    try {
      if (location.hash !== "#/" + page.id) {
        history.replaceState(null, "", "#/" + page.id);
      }
    } catch (e) { /* 受限环境（sandbox / file://）写不了 hash 也不影响使用 */ }
  }

  function step(delta) {
    var i = pages.indexOf(pageById(currentPageId || currentId()));
    go(pages[(i + delta + pages.length) % pages.length].id);
  }

  window.addEventListener("hashchange", function () {
    var id = currentId();
    if (id !== currentPageId) render(id);
  });

  document.getElementById("zoomSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    state.zoom = parseFloat(b.dataset.z);
    Array.prototype.forEach.call(this.children, function (c) {
      c.classList.toggle("is-on", c === b);
    });
    applyZoom();
  });

  document.getElementById("annotBtn").addEventListener("click", function () {
    state.annot = !state.annot;
    this.classList.toggle("is-on", state.annot);
    canvas.classList.toggle("annot-off", !state.annot);
  });

  document.getElementById("prevBtn").addEventListener("click", function () { step(-1); });
  document.getElementById("nextBtn").addEventListener("click", function () { step(1); });

  /* 键盘翻页：多一条不依赖鼠标的路径 */
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
  });

  go(currentId());

  /* 脚本成功跑完 → 收起"未执行"提示 */
  document.body.classList.remove("booting");
})();
