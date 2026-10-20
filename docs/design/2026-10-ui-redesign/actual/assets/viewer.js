/* 查看器：左侧页面清单 + 右侧 iframe 画布
   加页面 = 往 PAGES 里加一条 + 在 pages/ 下放同名 html */
window.GX_ACTUAL_PAGES = [
  {
    id: "table-grid",
    group: "数据表库",
    name: "数据表主界面（原版基准）",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    src: "pages/table-grid.html",
    note: "壳层 + 工具条三行 + 网格 + 聚合行 + 状态条",
  },
  {
    id: "table-grid-v2",
    group: "数据表库",
    name: "数据表主界面 ★拟物风 v2",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    src: "pages/table-grid-v2.html",
    note: "StreamEx 浅色拟物 + L1 悬浮框改造",
  },
  {
    id: "table-grid-v3",
    group: "数据表库",
    name: "数据表主界面 ★拟物风 v3（一级导航上顶栏）",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    src: "pages/table-grid-v3.html",
    note: "L1 横向并入顶栏凹槽轨道 / L2 留内容区左侧，无收起箭头",
  },
  {
    id: "table-grid-v4",
    group: "数据表库",
    name: "数据表主界面 ★拟物风 v4（顶栏两行）",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    src: "pages/table-grid-v4.html",
    note: "上排 品牌+搜索居中+用户（v2 布局）/ 下排一级导航轨道",
  },
  {
    id: "table-grid-v5",
    group: "数据表库",
    name: "数据表主界面 ★拟物风 v5（统一令牌体系 · 已封存）",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    src: "pages/table-grid-v5.html",
    note: "全页单一令牌表 + 产品 gx-* 桥接，破除局部手调（已封存）",
  },
  {
    id: "v6-data-table",
    group: "v6 企业工作台（新方向）",
    name: "数据表内容页 ★v6（入口已对齐真实功能）",
    route: "/base/:baseId/table/:tableId",
    src: "v6/data-table.html",
    note: "三行工具条（视图标签/新建记录+搜索+导入导出+更多/行高·字段·筛选·分组·排序·行颜色）+ 建库入口 + 表行「⋯」六项操作",
  },
];

(function () {
  var pages = window.GX_ACTUAL_PAGES || [];
  var state = { zoom: 0.75 };
  var railBody = document.getElementById("railBody");
  var stageName = document.getElementById("stageName");
  var stageRoute = document.getElementById("stageRoute");
  var frame = document.getElementById("frame");
  var fit = document.getElementById("fit");

  var groups = [];
  pages.forEach(function (p) { if (groups.indexOf(p.group) < 0) groups.push(p.group); });

  function render(id) {
    var page = pages.filter(function (p) { return p.id === id; })[0] || pages[0];

    railBody.innerHTML = "";
    groups.forEach(function (g) {
      var items = pages.filter(function (p) { return p.group === g; });
      if (!items.length) return;
      var h = document.createElement("div");
      h.className = "rail-group";
      h.textContent = g;
      railBody.appendChild(h);

      items.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rail-item" + (p.id === page.id ? " is-active" : "");
        var idx = document.createElement("span");
        idx.className = "rail-idx";
        idx.textContent = String(pages.indexOf(p) + 1).padStart(2, "0");
        var label = document.createElement("span");
        label.textContent = p.name;
        b.appendChild(idx);
        b.appendChild(label);
        b.addEventListener("click", function () { render(p.id); });
        railBody.appendChild(b);
      });
    });

    stageName.textContent = page.name;
    stageRoute.textContent = page.route;
    frame.src = page.src;
    applyZoom();
    document.title = page.name + " · 实际 UI 抽离";
  }

  function applyZoom() {
    frame.style.width = "1440px";
    frame.style.height = "900px";
    frame.style.transform = "scale(" + state.zoom + ")";
    fit.style.width = 1440 * state.zoom + "px";
    fit.style.height = 900 * state.zoom + "px";
  }

  document.getElementById("zoomSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    state.zoom = parseFloat(b.dataset.z);
    Array.prototype.forEach.call(this.children, function (c) {
      c.classList.toggle("is-on", c === b);
    });
    applyZoom();
  });

  render(pages[0].id);
})();
