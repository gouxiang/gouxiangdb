// apps/web/src/node/unauthorizedBridge.ts
// 节点模式 S2：远端数据源 401 的分流桥接（DESIGN §8.5 单活会话）。
//
// 背景：api/client.ts 的 handleUnauthorized 默认做「清本地 gx-auth + 跳本地 /login」。
// 多节点下，当前活动数据源若是**远端节点**，它的 401 只代表那条远端会话失效——
// 绝不能清掉本地登录态、也不能把用户踢去本地登录页；正确动作是清该远端节点会话并回到
// 启动器的「连接/登录该节点」界面（由启动器 UI/S3 层注册处理器实现）。
//
// 本模块只提供一个可注册的处理器槽位，node 域保持纯逻辑、不依赖 react/router/client：
//   - client.ts 在 401 时按 dataSourceResolver.current().kind 分流；
//   - remote → notifyRemoteUnauthorized(nodeId)（启动器注册后才有实际动作）；
//   - 未注册（浏览器/fnOS 恒 local 永不进此分支；纯逻辑测试）→ no-op，绝不动本地凭据。

export type RemoteUnauthorizedHandler = (nodeId: string) => void;

let handler: RemoteUnauthorizedHandler | null = null;

/** 启动器层注册「远端会话失效」处理器（清该节点会话、回连接界面）。幂等替换。 */
export function registerRemoteUnauthorizedHandler(h: RemoteUnauthorizedHandler | null): void {
  handler = h;
}

/** 当前数据源是远端且 401 时调用；无注册处理器则 no-op（不清本地凭据、不跳转）。 */
export function notifyRemoteUnauthorized(nodeId: string): void {
  handler?.(nodeId);
}

/** 测试用：复位已注册处理器。 */
export function __resetUnauthorizedBridgeForTest(): void {
  handler = null;
}
