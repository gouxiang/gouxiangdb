/**
 * 开发信任根（仅开发/测试/非授权渠道）。
 * 私钥在授权中心项目本机 keys/license-ed25519-private.pem，绝不入本仓。
 * 非授权构建（vitest/tsx/0.2.7 等）经 keys.ts 默认 import ./keyring.dev.js 取到本文件。
 */
export const LICENSE_KEYRING_PROD = false as const;

export const RING_DECLARED: ReadonlyArray<{ kid: string; pem: string }> = [
  {
    kid: "da469cd3",
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt6uZnu9pde3XWPmkhFyN6q1SCvrPgyoMpHBTcvER5P4=
-----END PUBLIC KEY-----
`,
  },
];
