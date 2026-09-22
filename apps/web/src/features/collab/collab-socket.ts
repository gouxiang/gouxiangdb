// apps/web/src/features/collab/collab-socket.ts
// 承接服务端的 **WebSocket 文本帧**控制消息（DESIGN.md §4.3：`{"type":"revoked",...}`
// 主动踢线、`flushed`、`peer_left`）。
//
// 为什么必须绕开 y-websocket 自己的接收路径：它的 `websocket.onmessage` 把 event.data
// 直接当二进制解析（`new Uint8Array(event.data)`），文本帧会被解成一串零值字节，
// 轻则解出非法消息、重则污染同步通道。
//
// 做法：给 provider 注入一个 WebSocket 子类，构造时额外挂一个 addEventListener
// （与库后续赋值的 `onmessage` 并存、互不覆盖），只截获 string 载荷。
// 基类在**调用时**才读 globalThis.WebSocket —— 单测可用假 socket 替换。

/**
 * y-websocket 的 `WebSocketPolyfill` 选项类型不是单纯的构造签名，而是要求**整个类对象**
 * （.d.ts：`{ new (url, protocols): WebSocket; prototype: WebSocket; readonly OPEN: number; ... }`），
 * 所以这里直接取 `typeof WebSocket`，返回子类即满足。
 */
export type CollabSocketCtor = typeof WebSocket;

export function createCollabSocketClass(onText: (raw: string) => void): CollabSocketCtor {
  const BaseWebSocket: typeof WebSocket = globalThis.WebSocket;
  return class CollabSocket extends BaseWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (ev: MessageEvent) => {
        if (typeof ev.data === "string") onText(ev.data);
      });
    }
  };
}
