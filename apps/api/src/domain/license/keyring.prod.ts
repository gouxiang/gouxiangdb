/**
 * 生产信任根（仅 GX_LICENSE_PROD=1 的授权成品构建）。
 *
 * 生产公钥 ff02db72，正式授权中心 https://gouxiang.hn.takin.cc 的 Ed25519 签名钥。
 * 三方交叉印证一致：公网 /v1/public-key 实时返回、授权中心项目工作日志、用户提供的后台截图。
 * SPKI-SHA256 = ff02db723a21a4a7196a6464468ecaad5610745d6450211a69fb93d750e9391e。
 *
 * 本文件只在生产授权构建经 esbuild 别名换源进入 bundle；开发环（含开发公钥 da469cd3）
 * 在该构建中根本不进入模块图，故生产产物物理不含任何开发钥——开发私钥泄露也无法成为生产旁路。
 */
export const LICENSE_KEYRING_PROD = true as const;

export const RING_DECLARED: ReadonlyArray<{ kid: string; pem: string }> = [
  {
    kid: "ff02db72",
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3H50rDLJ72deqZxzrkq01i3aGAac7qKVVdoNMQmQtqQ=
-----END PUBLIC KEY-----
`,
  },
];
