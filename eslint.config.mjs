// ESLint 9 flat config（M0 S7：把"假绿 lint"变成真门禁）。
// - 非类型感知 recommended（避免全量类型检查的海量告警），覆盖 apps/*/src、packages/*/src。
// - 潜在 bug 为 error；风格/整洁类降为 warn，用 --max-warnings 卡在当前基线上：
//   现有树可退出 0，但任何新增告警都会让门禁变红（见 scripts/ci-quality.sh）。
// - 类型检查仍由各包 tsc --noEmit 负责，lint 不做重复的类型感知分析。

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/build/**",
      "**/*.config.{js,cjs,mjs,ts}",
      "**/prisma/**",
      "apps/api/scripts/**",
      "apps/web/scripts/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // —— 现有代码基线：把高噪声风格/整洁规则降为 warn（不阻断，计数被 max-warnings 卡住）——
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-wrapper-object-types": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
      // —— 以下 5 条在 web 历史代码中为有意/稳定写法，M0 降 warn 纳入基线（见 docs/runbooks/ci.md 技术债）——
      // no-unused-expressions：el && (el.x = v) 短路赋值惯用法（MarkdownEditor 上传按钮）。
      "@typescript-eslint/no-unused-expressions": "warn",
      // no-control-regex：blocks/markdown 占位符 \u0000 与 sanitize-html 剥控制字符均为有意为之。
      "no-control-regex": "warn",
      // no-case-declarations：blocks 序列化 switch 内的 let（缺块级包裹，语义正确）。
      "no-case-declarations": "warn",
      // no-constant-binary-expression：DefaultValueEditor 的 (x ?? "") ?? "" 冗余空合取，行为等价。
      "no-constant-binary-expression": "warn",
      // —— 潜在 bug 保持 error（recommended 默认即 error，此处显式声明关键项）——
      "no-undef": "off", // TS 接管，未定义变量由 tsc 报
      "no-cond-assign": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "use-isnan": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // @gx/blocks 序列化/反序列化器：\u0000 占位符正则与 switch 内 let 是有意且稳定的写法
    // （见上 no-control-regex / no-case-declarations 基线注释）。该包 lint 阈值 --max-warnings 0，
    // 故在包级显式关掉这两条已背书的风格规则；潜在 bug 类规则仍全部保持 error。
    files: ["packages/blocks/src/**/*.{ts,tsx}"],
    rules: {
      "no-control-regex": "off",
      "no-case-declarations": "off",
    },
  },
  {
    // React Hooks 规则仅对 web 包生效（api/shared 无 React）。
    // rules-of-hooks 违反几乎必是真 bug，保持 error；
    // exhaustive-deps 历史代码有意 disable/省略，降为 warn 纳入基线计数。
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 测试文件允许非空断言、any 等
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
