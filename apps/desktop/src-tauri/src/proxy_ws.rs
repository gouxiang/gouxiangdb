//! `/ws` WebSocket 裸字节隧道（IMPL-0.2.5-beta §4-R1「WS 隧道」）。
//!
//! ## 为什么不用 tokio-tungstenite 建客户端连接
//! 规格要求「在 raw TCP/TLS 字节流层双向透传，不解读 WS 帧」（协同 4403 二进制帧、坏票
//! 4401 close 都原样往返）。tungstenite 0.24 的 `WebSocketStream` 只暴露 `get_ref/get_mut`，
//! **拿不回**底层裸流（无 `into_inner`），且其内部做帧解析与缓冲，无法退化成纯字节中继。
//! 因此这里作为 TCP/TLS 客户端**手写一次 HTTP/1.1 Upgrade 握手**，握手一完成，两侧都是
//! 裸 `AsyncRead+AsyncWrite`，直接 `tokio::io::copy_bidirectional` 透传，永不触碰 WS 帧。
//!
//! ## 「裸中继」的边界：101 握手头重建，握手后帧才裸透传
//! 「裸字节中继」只针对**升级完成之后的 WS 帧**（两侧裸 IO `copy_bidirectional`，不解读帧）。
//! 浏览器侧的 101 响应是**有意经 hyper/axum 重建**的，而非逐字节转发上游响应头：必须借 hyper
//! 的 101 + `OnUpgrade` 才能拿回浏览器侧裸流（自行写裸 101 则 hyper 不会让出连接）。重建时
//! `Sec-WebSocket-Accept` 取上游对**浏览器原始 key** 的回值、`Sec-WebSocket-Protocol` 透传，
//! Connection/Upgrade 固定，故浏览器校验通过；hyper 会把头名规范化为小写并补 `date`，均合法。
//! 代价：上游 101 里除 accept/protocol 外的自定义头不透传——协同只依赖二者，可接受。
//!
//! ## 关键：浏览器的 Sec-WebSocket-Key 必须原样转发给上游
//! 浏览器持 key KB，期望回 `Sec-WebSocket-Accept = sha1_b64(KB + GUID)`。代理是盲中继：
//! 若自己另造 key KC，上游回的是 accept(KC)，浏览器校验必败。故把浏览器握手头（Key、
//! Version、Protocol）透传，上游自然回 accept(KB)，我们再把上游的 101 响应头转回浏览器。
//! 同时**故意不透传** Sec-WebSocket-Extensions（permessage-deflate）：裸字节中继无法解压
//! 帧，不协商压缩可保证双方看到的都是明文帧、协商一致。
//!
//! ## 上游寻址
//! Local → `ws://127.0.0.1:<KERNEL_PORT>`；Remote → base 的 http→ws / https→wss 换算
//! （wss 用 rustls ClientConfig + macOS 系统钥匙串校验 rustls-platform-verifier，进程默认
//! ring provider，SNI=目标 host；登录钥匙串里受信的内网自签 CA 直接生效）。
//! 完整 path 与 query（协同为 `/ws/collab/<roomId>?t=<ticket>`）原样透传。
//!
//! ## ATS
//! 与 proxy.rs 相同：rustls / 裸 TCP 不经过 Apple ATS；wss 直连无 ATS 问题，明文 ws 走裸 socket。

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::commands::ShellState;
use crate::proxy::ensure_crypto_provider;
// with_platform_verifier() 由该扩展 trait 提供（rustls-platform-verifier）。
use rustls_platform_verifier::ConfigVerifierExt;

/// 上游连接统一形态：裸 TCP 或 TLS 都需同时可读可写。
///
/// Rust 不允许两个非 auto trait 直接并列成一个 trait object（`dyn AsyncRead + AsyncWrite`
/// 非法，E0225），故用一个组合 trait 收口，再对所有满足二者的具体类型做空白 blanket impl。
trait UpstreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> UpstreamIo for T {}

/// 上游连接：明文 TCP 或 TLS，统一装箱成裸 IO。
type UpIo = Box<dyn UpstreamIo>;

/// `/ws`（实际承接 `/ws/collab/<room>` 等，路由按前缀）入口。
///
/// 仅当是 GET 且含 `Upgrade: websocket` 才走隧道；无活动上游 → 503；非升级请求 → 400。
pub async fn ws_tunnel(State(state): State<Arc<ShellState>>, req: Request) -> Response {
    let (parts, _body) = req.into_parts();

    if parts.method != axum::http::Method::GET || !is_websocket_upgrade(&parts.headers) {
        return (StatusCode::BAD_REQUEST, "expected WebSocket upgrade").into_response();
    }

    let Some(base) = state.shared.get_upstream().await.http_base() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            crate::proxy::NODE_NOT_ACTIVE_BODY,
        )
            .into_response();
    };

    // hyper 识别到升级请求时往扩展里插 OnUpgrade；clone 出来（不 await），稍后在 spawn 里 await。
    let Some(on_upgrade) = parts.extensions.get::<hyper::upgrade::OnUpgrade>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    // 目标：scheme 换算 + host/port + 原始 path/query（路由非 nest，parts.uri 即完整 URI）。
    let target = match build_ws_target(&base, &parts.uri) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[desktop ws] 目标地址无效: {e}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    // 先与上游完成 TCP/TLS 连接与 Upgrade 握手（浏览器此刻仍在等 101）。
    let handshake = match connect_and_handshake(&target, &parts.headers).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[desktop ws] 上游握手失败 {}: {e}", target.authority);
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    if !handshake.status_is_101 {
        // 上游拒绝升级：回 502 兜底。
        // 协同坏票（4401）是在 101 之后以 WS close 帧表达，会正常走字节透传，不落这里。
        return StatusCode::BAD_GATEWAY.into_response();
    }

    // 构造给浏览器的 101：Connection/Upgrade 固定，Accept/Protocol 取上游回值（accept(KB)）。
    let mut builder = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(axum::http::header::CONNECTION, "upgrade")
        .header(axum::http::header::UPGRADE, "websocket");
    if let Some(accept) = handshake.sec_websocket_accept.as_ref() {
        builder = builder.header(axum::http::header::SEC_WEBSOCKET_ACCEPT, accept.as_str());
    }
    if let Some(proto) = handshake.sec_websocket_protocol.as_ref() {
        builder = builder.header(axum::http::header::SEC_WEBSOCKET_PROTOCOL, proto.as_str());
    }

    let mut upstream: UpIo = handshake.io;
    // 读上游握手头时可能 over-read 到紧随其后的 WS 帧字节，双向拷贝前必须先补发给浏览器。
    let prebuf = handshake.leftover;

    // 本 handler 返回 101 后 hyper 写出响应并完成升级，on_upgrade 才 resolve，任务据此拿到
    // 浏览器侧裸 IO，开始字节透传。
    tokio::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(io) => io,
            Err(e) => {
                eprintln!("[desktop ws] 浏览器侧升级失败: {e}");
                return;
            }
        };
        let mut browser = hyper_util::rt::TokioIo::new(upgraded);

        if !prebuf.is_empty() && browser.write_all(&prebuf).await.is_err() {
            return;
        }

        // 任一方向结束即收尾；copy_bidirectional 内部双向转发直到 EOF/错误，不解读 WS 帧。
        let _ = tokio::io::copy_bidirectional(&mut browser, &mut upstream).await;
        let _ = browser.shutdown().await;
        let _ = upstream.shutdown().await;
    });

    builder
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 判断是否 WebSocket 升级请求（Connection 含 upgrade 且 Upgrade: websocket）。
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let conn_ok = headers
        .get(axum::http::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false);
    let up_ok = headers
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    conn_ok && up_ok
}

/// 换算后的上游 WS 目标。
struct WsTarget {
    #[allow(dead_code)]
    use_tls: bool,
    host: String,
    port: u16,
    /// 请求行用的 path?query（以 '/' 开头）。
    request_target: String,
    authority: String,
}

/// 由 HTTP(S) base 与壳口原始 URI 换算 WS 目标。
fn build_ws_target(base: &str, original_uri: &axum::http::Uri) -> Result<WsTarget, String> {
    let base_url = url::Url::parse(base).map_err(|e| e.to_string())?;
    let use_tls = match base_url.scheme() {
        "http" => false,
        "https" => true,
        other => return Err(format!("不支持的上游 scheme: {other}")),
    };
    let host = base_url
        .host_str()
        .ok_or_else(|| "上游缺少 host".to_string())?
        .to_string();
    let port = base_url
        .port_or_known_default()
        .ok_or_else(|| "上游缺少端口".to_string())?;

    let path = original_uri.path();
    let request_target = match original_uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_string(),
    };
    let authority = match base_url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    Ok(WsTarget {
        use_tls,
        host,
        port,
        request_target,
        authority,
    })
}

/// 上游握手结果。
struct Handshake {
    status_is_101: bool,
    sec_websocket_accept: Option<String>,
    sec_websocket_protocol: Option<String>,
    /// 握手头之后 over-read 的裸字节（首批 WS 帧）。
    leftover: Vec<u8>,
    io: UpIo,
}

/// 建立 TCP（必要时包 TLS）并发送/读取一次 WS Upgrade 握手。
async fn connect_and_handshake(
    target: &WsTarget,
    browser_headers: &HeaderMap,
) -> Result<Handshake, String> {
    let tcp = tokio::net::TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| format!("TCP 连接失败: {e}"))?;
    tcp.set_nodelay(true).ok();

    let mut io: UpIo = if target.use_tls {
        let config = rustls_client_config()?;
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        // SNI = 目标 host；try_from(String) 对域名/IP 分别产出 DnsName/IpAddress。
        let server_name = rustls::pki_types::ServerName::try_from(target.host.clone())
            .map_err(|e| format!("TLS SNI 无效: {e}"))?;
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("TLS 握手失败: {e}"))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };

    // 浏览器握手工件原样透传（这是盲中继成立的关键）。
    let key = browser_headers
        .get(axum::http::header::SEC_WEBSOCKET_KEY)
        .ok_or("缺少 Sec-WebSocket-Key")?
        .to_str()
        .map_err(|_| "Sec-WebSocket-Key 非 ASCII")?;

    let mut req = String::new();
    req.push_str(&format!("GET {} HTTP/1.1\r\n", target.request_target));
    req.push_str(&format!("Host: {}\r\n", target.authority));
    req.push_str("Upgrade: websocket\r\n");
    req.push_str("Connection: Upgrade\r\n");
    req.push_str(&format!("Sec-WebSocket-Key: {key}\r\n"));
    req.push_str("Sec-WebSocket-Version: 13\r\n");
    if let Some(proto) = browser_headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
    {
        req.push_str(&format!("Sec-WebSocket-Protocol: {proto}\r\n"));
    }
    // 故意不转发 Sec-WebSocket-Extensions：裸字节中继不做 deflate 解压（见文件头）。
    req.push_str("\r\n");

    io.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("写握手请求失败: {e}"))?;
    io.flush().await.map_err(|e| format!("flush 失败: {e}"))?;

    // 读到响应头结束标记；累积 over-read 的字节（首批帧）。
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = io
            .read(&mut tmp)
            .await
            .map_err(|e| format!("读握手响应失败: {e}"))?;
        if n == 0 {
            return Err("上游在握手阶段关闭连接".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return Err("上游握手响应头过大".into());
        }
    };

    let header_block = &buf[..header_end];
    let leftover = buf[header_end..].to_vec();
    let text = std::str::from_utf8(header_block).map_err(|_| "握手响应头非 UTF-8")?;
    let (status_is_101, accept, proto) = parse_handshake_response(text)?;

    Ok(Handshake {
        status_is_101,
        sec_websocket_accept: accept,
        sec_websocket_protocol: proto,
        leftover,
        io,
    })
}

/// 构造 rustls 客户端配置：macOS 系统钥匙串校验（platform-verifier）+ 进程默认 ring provider。
///
/// 与 HTTP 通道（reqwest rustls-no-provider + platform-verifier）同一套信任根：内网自签/私有
/// CA 装进登录钥匙串即被信任。`ClientConfig::builder()` 取进程默认 CryptoProvider，故先确保 ring
/// 已幂等安装；不在这里 `builder_with_provider` 另起 provider，避免与进程级默认不一致。
fn rustls_client_config() -> Result<rustls::ClientConfig, String> {
    ensure_crypto_provider();
    rustls::ClientConfig::with_platform_verifier()
        .map_err(|e| format!("rustls 平台校验配置失败: {e}"))
}

/// 在字节流中定位响应头结束 `\r\n\r\n`，返回其后的偏移。
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// 解析上游 101 响应：返回 (是否 101, Sec-WebSocket-Accept, Sec-WebSocket-Protocol)。
fn parse_handshake_response(text: &str) -> Result<(bool, Option<String>, Option<String>), String> {
    let mut lines = text.split("\r\n");
    let status_line = lines.next().ok_or("空响应")?;
    // 形如 "HTTP/1.1 101 Switching Protocols"。
    let code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or("无法解析状态码")?;

    let mut accept = None;
    let mut protocol = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "sec-websocket-accept" => accept = Some(value.trim().to_string()),
                "sec-websocket-protocol" => protocol = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    Ok((code == 101, accept, protocol))
}
