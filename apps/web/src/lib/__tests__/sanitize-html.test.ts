// M7 门④ 台账缺口 C-5 / RC-26：URL 白名单纯函数 isSafeUrlAttr 的零依赖对抗单测。
//
// 被测：src/lib/sanitize-html.ts 的 isSafeUrlAttr(url) —— 纯字符串判定，不触碰 DOM。
// 它是富文本(richText)单元格存储型 XSS 防线：features/cells/CellRenderer.tsx 用
// sanitizeHtml 以 dangerouslySetInnerHTML 渲染用户可存入的任意 HTML，href/src 的
// 协议白名单全部收敛到本函数（javascript:/vbscript:/data:text/html 必须被拒）。
//
// 铁律（项目禁止新增依赖）：
//   - apps/web 无 jsdom/happy-dom，vitest 默认 node 环境；
//   - 本文件【只】import isSafeUrlAttr，绝不 import sanitizeHtml（其内部
//     document.createElement("template") 在 node 环境会直接抛 ReferenceError）；
//   - 不通过 environment docblock 切到 jsdom，不安装任何包（注释里也不得出现
//     "@vitest-environment <环境名>" 字面量，vitest 会从头注释解析该指令，
//     把整文件切到未安装的 jsdom 而收集到 0 个用例）；
//   - sanitizeHtml 的 DOM 标签剥离/属性过滤不在自动化范围，登记为手测。
//
// 实现要点（逐行读过 src/lib/sanitize-html.ts 且经实跑校准，断言固化真实返回，
// 绝不为凑预期改实现）：
//   1. 先 trim()，空串 → true；
//   2. 剔除 ASCII 控制字符 U+0000-001F / U+007F-009F（含 \t \n \r）后再判协议，
//      故 java\tscript: / java\nscript: 混淆被还原成 javascript: 后拦截（RC-26 核心，实跑 false）；
//   3. 以 "/" "#" "?" 开头 → true；
//   4. 命中【锚定起点】的 scheme 形态 ^[a-zA-Z][a-zA-Z0-9+.-]*: 时，仅 http(s)/mailto/tel
//      放行，其余 scheme 一律 false（fail-closed）；
//   5. 【实现与注释不符，已实跑确认】第 42 行的 data: 特判是【不可达死代码】：任何以
//      "data:" 开头的串都已在第 4 步命中 scheme 形态（"data" 是合法 scheme 字母串），
//      在第 39 行白名单（仅 http(s)/mailto/tel）处即返回 false，永远到不了第 42 行。
//      结果：【所有】 data: URI（含 data:image/png、data:text/plain）都被判 false，
//      比函数注释宣称的「仅拦 data:text/html、其余 data: 媒体放行」更严格。
//      方向是 fail-closed（安全，非 XSS 缺口），副作用是富文本里的 data: 内联图片会被
//      一律置为 "#"（功能性过拦）——此处只固化现状并上报，不改实现，是否放行图片 data:
//      留待安全/产品裁决（若放行需重排第 38 行与第 42 行判定顺序）。
//   6. 普通散文冒号：scheme 正则带 ^ 锚定且字母类不含空格，故只有「串首紧跟冒号的
//      scheme 形 token」才命中；"a b:c"（空格中断）、"1:2"（数字开头）不命中 → 放行。
//      而 "note: ..."、"a:b" 因串首即 scheme 形，fail-closed 判 false。
import { describe, expect, it } from "vitest";
import { isSafeUrlAttr } from "../sanitize-html";

describe("RC-26 isSafeUrlAttr：安全 URL 一律放行（白名单协议 / 相对 / 锚点 / 查询 / 空）", () => {
  it.each([
    ["空串", "", true],
    ["纯空白 trim 后为空串", "   ", true],
    ["根相对路径", "/relative", true],
    ["多级相对路径（带查询与锚点）", "/a/b/c?x=1#y", true],
    ["纯锚点", "#anchor", true],
    ["纯查询串", "?q=1", true],
    ["http 协议", "http://example.com", true],
    // 主机名是否 "evil" 不在白名单职责内：协议合法即放行，host 风险由调用方/浏览器上下文承担
    ["https 协议（白名单只看协议，不看主机名）", "https://evil.com", true],
    ["大写 HTTPS 协议（白名单正则带 i 标志）", "HTTPS://EXAMPLE.COM/x", true],
    ["mailto 协议", "mailto:a@b.com", true],
    ["tel 协议", "tel:123", true],
    ["无协议相对串放行", "relative/path/page.html", true],
    ["无协议带查询与锚点放行", "page?x=1#y", true],
    ["串内带冒号但非首部 scheme（路径段含端口样式）放行", "path/to/host:8080/x", true],
  ])("%s", (_label, url, expected) => {
    expect(isSafeUrlAttr(url)).toBe(expected);
  });
});

describe("RC-26 isSafeUrlAttr：危险协议与对抗混淆一律拒绝（存储型 XSS 核心向量）", () => {
  it.each([
    ["javascript: 协议", "javascript:alert(1)", false],
    // 大小写/混排：scheme 形态正则本身不限大小写，白名单匹配亦带 i；javascript 永不在白名单
    ["大小写混排 JaVaScRiPt:", "JaVaScRiPt:alert(1)", false],
    // 控制字符混淆（RC-26 安全核心）：剔除 \t \n \r 后被还原为 javascript: 再拦截
    ["内嵌制表符 java<TAB>script:（U+0009）", "java\tscript:alert(1)", false],
    ["内嵌换行 java<LF>script:（U+000A）", "java\nscript:alert(1)", false],
    ["内嵌回车 java<CR>script:（U+000D）", "java\rscript:alert(1)", false],
    // 前导空格：函数先 trim()，再识别出 javascript:
    ["单个前导空格（trim 后 javascript:）", " javascript:alert(1)", false],
    ["多个前导空格（trim 后 javascript:）", "   javascript:alert(1)", false],
    // 组合对抗向量：前导空格 + 大小写混排 + 内嵌制表符，三重归一后仍须拒绝
    ["前导空格+大小写混排+内嵌制表符组合", "  JaVa\tScRiPt:alert(1)", false],
    ["vbscript: 协议", "vbscript:msgbox", false],
    ["data:text/html;base64 脚本载荷", "data:text/html;base64,PHNjcmlwdD4=", false],
    ["data:text/html 逗号脚本", "data:text/html,<script>alert(1)</script>", false],
    ["data:text/html 带 charset 参数", "data:text/html;charset=utf-8,<script>alert(1)</script>", false],
    ["大写 DATA:TEXT/HTML（scheme 分支白名单拒绝）", "DATA:TEXT/HTML,x", false],
    ["data:text/html 前后空白（trim 后仍拒绝）", "  data:text/html,x  ", false],
  ])("%s", (_label, url, expected) => {
    expect(isSafeUrlAttr(url)).toBe(expected);
  });
});

describe("RC-26 isSafeUrlAttr：实跑校准——所有 data: URI 当前均 fail-closed 拒绝（第42行为死代码）", () => {
  // 上报项：函数头注释声称「data: 媒体资源放行，仅拦 data:text/html」，但实现上
  // data: 在 scheme 白名单步即被拒，第 42 行特判不可达。下列「图片/纯文本」data URI
  // 按真实返回锁定为 false（安全方向，非漏洞；功能上会过拦内联图片），不改实现。
  it.each([
    ["data:image/png;base64 当前也被拒（非 text/html，但走不到 data 特判）", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", false],
    ["data:image/png 逗号形式当前被拒", "data:image/png,foo", false],
    ["data:text/plain 当前被拒", "data:text/plain,hello", false],
    ["data:image/gif 当前被拒", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", false],
  ])("%s", (_label, url, expected) => {
    expect(isSafeUrlAttr(url)).toBe(expected);
  });
});

describe("RC-26 isSafeUrlAttr：普通文本里的冒号不被协议正则误伤（锚定 + 字符类）", () => {
  it.each([
    // 命中条件是「串首 scheme 形字母串紧跟冒号」。下列串首不满足该形态 → 不当作协议 → 放行。
    ["字母后先空格才到冒号（scheme 类不含空格，锚定失败）→ 放行", "a b:c", true],
    ["以数字开头不满足 ^[a-zA-Z] → 放行", "1:2", true],
    // 反例（反映真实实现，均 fail-closed，非安全缺陷）：串首本身就是「合法 scheme 字母串+冒号」，
    // 但 scheme 不在 http(s)/mailto/tel 白名单 → false。单字母 "a" 也是合法 scheme 字符。
    ["单字母伪 scheme 'a:b' 命中 scheme 形态，非白名单 → false", "a:b", false],
    ["散文 'note: ...' 串首即 note: scheme 形 → fail-closed false", "note: see doc", false],
  ])("%s", (_label, url, expected) => {
    expect(isSafeUrlAttr(url)).toBe(expected);
  });
});
