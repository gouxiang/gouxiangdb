//! R1 headless 集成测试（IMPL-0.2.5-beta §4-R1 六类 a/b/c/d/e/f 全在本文件）。
//!
//! 全部走**真实回环网络**：壳口用 `shell_server::router/serve` 绑 `127.0.0.1:0`，
//! 上游用本文件内的极简裸 TCP mock（http 与 ws 各一个），不引入 Tauri Builder/winit，
//! 也不新增任何 dev-dependency（WS 的 SHA1/Base64 在测试内手写，仅用于算握手 accept）。

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::commands::ShellState;
use crate::proxy::ensure_crypto_provider;
use crate::upstream::Shared;

/// mock 上游收到的一条请求（头部统一小写）。
#[derive(Debug, Default, Clone)]
struct MockRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl MockRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// 绑一个一次性 mock HTTP 上游（读完一条请求 → 按 path 决定响应），返回其回环 base 与请求捕获槽。
async fn mock_http_upstream() -> (String, Arc<Mutex<Option<MockRequest>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();

    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();

        // 读到请求头结束。
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        let head_end = loop {
            let n = sock.read(&mut tmp).await.unwrap();
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(p) = find_subslice(&buf, b"\r\n\r\n") {
                break p + 4;
            }
        };

        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let status_line = lines.next().unwrap_or("");
        let mut sp = status_line.split_whitespace();
        let method = sp.next().unwrap_or("").to_string();
        let raw_target = sp.next().unwrap_or("/").to_string();
        let mut headers = Vec::new();
        let mut content_length = 0usize;
        let mut chunked = false;
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                let k = k.trim().to_ascii_lowercase();
                let v = v.trim().to_string();
                if k == "content-length" {
                    content_length = v.parse().unwrap_or(0);
                }
                if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                    chunked = true;
                }
                headers.push((k, v));
            }
        }

        // 读完 body（head 里可能已 over-read 一部分）。流式 wrap_stream 无预知长度，
        // reqwest 会发 Transfer-Encoding: chunked；真实 Hono/node 两种都收，mock 亦然。
        let mut raw = buf[head_end..].to_vec();
        let body = if chunked {
            // 持续读到 chunked 终止块（0-length chunk + CRLF）出现，再解码。
            while parse_chunked(&raw).is_none() {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&tmp[..n]);
            }
            parse_chunked(&raw).expect("chunked 请求体必须可完整解码")
        } else {
            while raw.len() < content_length {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&tmp[..n]);
            }
            raw.truncate(content_length);
            raw
        };

        let path = raw_target.split('?').next().unwrap_or("/").to_string();
        let captured_req = MockRequest {
            method: method.clone(),
            path: raw_target.clone(),
            headers,
            body: body.clone(),
        };
        *cap.lock().await = Some(captured_req);

        // 响应路由（壳原样转发、不剥 /api 前缀，故大 body 用例打 /api/echo，这里两个都认）。
        if path == "/echo" || path == "/api/echo" {
            write_http(
                &mut sock,
                200,
                &[("content-type", "application/octet-stream")],
                &body,
            )
            .await;
        } else {
            // 默认 200 JSON 回显 method/path。
            let payload = format!(
                "{{\"method\":\"{method}\",\"path\":\"{}\"}}",
                raw_target.replace('"', "'")
            );
            write_http(
                &mut sock,
                200,
                &[("content-type", "application/json")],
                payload.as_bytes(),
            )
            .await;
        }
    });

    (format!("http://127.0.0.1:{port}"), captured)
}

async fn write_http(
    sock: &mut tokio::net::TcpStream,
    status: u16,
    headers: &[(&str, &str)],
    body: &[u8],
) {
    let reason = if status == 200 { "OK" } else { "ERR" };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
    out.push_str(&format!("content-length: {}\r\n", body.len()));
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("connection: close\r\n\r\n");
    sock.write_all(out.as_bytes()).await.unwrap();
    sock.write_all(body).await.unwrap();
    sock.flush().await.unwrap();
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 解析 `Transfer-Encoding: chunked` 请求体；未读到终止块（`0\r\n\r\n`）时返回 None。
/// 支持 chunk 行带 `;` 扩展参数，不处理 trailer（reqwest 不发 trailer）。
fn parse_chunked(raw: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    let mut out = Vec::new();
    loop {
        let line_end = find_subslice(&raw[pos..], b"\r\n")? + pos;
        let size_line = &raw[pos..line_end];
        let size_str = String::from_utf8_lossy(size_line);
        let hex = size_str.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(hex, 16).ok()?;
        let data_start = line_end + 2;
        if size == 0 {
            // 终止块：0\r\n 后接空 trailer + CRLF。
            let term_end = find_subslice(&raw[data_start..], b"\r\n")? + data_start + 2;
            if raw.len() >= term_end {
                return Some(out);
            }
            return None;
        }
        let data_end = data_start.checked_add(size)?;
        // 每个 chunk 后还有 CRLF；数据未到齐则整段尚未收完。
        if raw.len() < data_end + 2 {
            return None;
        }
        out.extend_from_slice(&raw[data_start..data_end]);
        pos = data_end + 2;
    }
}

/// 起一个壳口服务（可选静态根），返回 (base_url, state)。
async fn start_shell(shared: Arc<Shared>) -> (String, Arc<ShellState>) {
    ensure_crypto_provider();
    let state = Arc::new(ShellState::new(shared));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve_state = state.clone();
    tokio::spawn(async move {
        crate::shell_server::serve(listener, serve_state).await;
    });
    (format!("http://127.0.0.1:{port}"), state)
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

// (a) 转发请求不带 Origin/Referer（白名单外一律剥除），白名单业务头仍透传。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_strips_origin_and_referer() {
    let (upstream, captured) = mock_http_upstream().await;
    let shared = Arc::new(Shared::new());
    shared
        .set_upstream(crate::upstream::Upstream::Remote {
            base: upstream.clone(),
        })
        .await;
    let (shell, _state) = start_shell(shared).await;

    let body = b"hello";
    let resp = http_client()
        .post(format!("{shell}/api/v1/records"))
        .header("Origin", "http://127.0.0.1:9999")
        .header("Referer", "http://127.0.0.1:9999/some/page")
        .header("x-gx-token", "tok-ABC")
        .header("content-type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // 等待 mock 处理完成。
    let mut got = None;
    for _ in 0..100 {
        {
            let g = captured.lock().await;
            if g.is_some() {
                got = g.clone();
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let req = got.expect("mock 应已收到请求");
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/api/v1/records");
    assert!(
        req.header("origin").is_none(),
        "Origin 必须被剥除，实际: {:?}",
        req.headers
    );
    assert!(req.header("referer").is_none(), "Referer 必须被剥除");
    assert_eq!(req.header("x-gx-token"), Some("tok-ABC"));
    assert_eq!(req.header("content-type"), Some("application/json"));
    assert_eq!(req.body, body);
}

// (b) 无活动上游时 /api 回 503，body 精确为 NODE_NOT_ACTIVE 信封。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_upstream_returns_503_exact_body() {
    let shared = Arc::new(Shared::new()); // 默认 None
    let (shell, _state) = start_shell(shared).await;

    let resp = http_client()
        .get(format!("{shell}/api/v1/anything"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 503);
    let text = resp.text().await.unwrap();
    assert_eq!(text, r#"{"code":503,"message":"NODE_NOT_ACTIVE"}"#);
}

// (c) probe：未知 id→404；过期→404；命中→转发到注册 base（且与当前活动上游无关）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_unknown_expired_miss_and_hit_forwards() {
    let (upstream, captured) = mock_http_upstream().await;

    // 命中场景：当前上游保持 None，仅靠 probeId 也应转发。
    let shared = Arc::new(Shared::new());
    let (shell, _state) = start_shell(shared.clone()).await;
    let probe_id = shared.begin_probe(upstream.clone());

    // 未知 id → 404。
    let resp404 = http_client()
        .get(format!(
            "{shell}/__gx/probe/deadbeefdeadbeef/api/auth/login"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp404.status(), 404);
    assert_eq!(
        resp404.text().await.unwrap(),
        r#"{"code":404,"message":"PROBE_NOT_FOUND"}"#
    );

    // 命中：path 与 query 原样拼到注册 base 之后（当前上游是 None 也照转）。
    let resp = http_client()
        .get(format!(
            "{shell}/__gx/probe/{probe_id}/api/auth/login?foo=1&bar=2"
        ))
        .header("x-gx-token", "probe-tok")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let mut got = None;
    for _ in 0..100 {
        {
            let g = captured.lock().await;
            if g.is_some() {
                got = g.clone();
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let req = got.expect("命中 probe 应转发到注册 base");
    assert_eq!(req.path, "/api/auth/login?foo=1&bar=2");
    assert_eq!(req.header("x-gx-token"), Some("probe-tok"));

    // end_probe 后再打 → 404。
    assert!(shared.end_probe(&probe_id));
    let resp_after = http_client()
        .get(format!("{shell}/__gx/probe/{probe_id}/api/x"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_after.status(), 404);

    // 过期 → 404：用 1ms TTL 的独立 state。
    let exp_shared = Arc::new(Shared::with_ttl(Duration::from_millis(1)));
    let (exp_shell, _) = start_shell(exp_shared.clone()).await;
    let exp_id = exp_shared.begin_probe(upstream);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let resp_exp = http_client()
        .get(format!("{exp_shell}/__gx/probe/{exp_id}/api/x"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_exp.status(), 404);
}

// (d) 大 body 流式往返：8 MiB 确定性负载经壳口 echo 回，逐字节一致（请求/响应均不缓冲失败）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_body_streams_roundtrip() {
    let (upstream, _captured) = mock_http_upstream().await;
    let shared = Arc::new(Shared::new());
    shared
        .set_upstream(crate::upstream::Upstream::Remote { base: upstream })
        .await;
    let (shell, _state) = start_shell(shared).await;

    // 8 MiB 确定性伪随机负载（远超任何单次读写缓冲）。
    let len = 8 * 1024 * 1024;
    let mut payload = Vec::with_capacity(len);
    let mut x: u64 = 0x1234_5678_9abc_def0;
    while payload.len() < len {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let v = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
        payload.extend_from_slice(&v.to_le_bytes());
    }
    payload.truncate(len);

    let resp = http_client()
        .post(format!("{shell}/api/echo"))
        .header("content-type", "application/octet-stream")
        .body(payload.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let got = resp.bytes().await.unwrap();
    assert_eq!(got.len(), len, "大 body 长度必须守恒（流式不截断）");
    assert_eq!(got.as_ref(), payload.as_slice(), "大 body 必须逐字节一致");
}

// (f) 裸 ws echo：Sec-WebSocket-Key 原样转发、101 回正确 accept、二进制帧双向透传。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_tunnel_forwards_key_accept_and_binary_frames() {
    // 裸 TCP mock WS 上游：用浏览器发来的 key 算 accept，再做一次二进制帧 echo。
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();

        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let head_end = loop {
            let n = sock.read(&mut tmp).await.unwrap();
            buf.extend_from_slice(&tmp[..n]);
            if let Some(p) = find_subslice(&buf, b"\r\n\r\n") {
                break p + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        // 取出壳口转发上来的（即浏览器原始）key。
        let key = head
            .split("\r\n")
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .starts_with("sec-websocket-key:")
                    .then(|| l.split_once(':').map(|(_, v)| v.trim().to_string()))
                    .flatten()
            })
            .expect("上游必须收到 Sec-WebSocket-Key");

        let accept = ws_accept(&key);
        let resp = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
        sock.flush().await.unwrap();

        // 读一个客户端（经壳口透传来的）掩码二进制帧并回 echo（服务端帧不掩码）。
        // 帧头: FIN+opcode(2B), 掩码位+长度..., 4B mask, payload。
        sock.read_exact(&mut tmp[..2]).await.unwrap();
        let b1 = tmp[1];
        assert_eq!(b1 & 0x80, 0x80, "客户端帧必须带掩码");
        let len7 = (b1 & 0x7f) as usize;
        let plen = if len7 < 126 {
            len7
        } else if len7 == 126 {
            sock.read_exact(&mut tmp[..2]).await.unwrap();
            u16::from_be_bytes([tmp[0], tmp[1]]) as usize
        } else {
            sock.read_exact(&mut tmp[..8]).await.unwrap();
            let mut a = [0u8; 8];
            a.copy_from_slice(&tmp[..8]);
            u64::from_be_bytes(a) as usize
        };
        let mut mask = [0u8; 4];
        sock.read_exact(&mut mask).await.unwrap();
        let mut payload = vec![0u8; plen];
        sock.read_exact(&mut payload).await.unwrap();
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }

        // 服务端→客户端：不掩码二进制帧。
        let mut out = Vec::new();
        out.push(0x82u8); // FIN + binary
        if plen < 126 {
            out.push(plen as u8);
        } else if plen <= u16::MAX as usize {
            out.push(126);
            out.extend_from_slice(&(plen as u16).to_be_bytes());
        } else {
            out.push(127);
            out.extend_from_slice(&(plen as u64).to_be_bytes());
        }
        out.extend_from_slice(&payload);
        sock.write_all(&out).await.unwrap();
        sock.flush().await.unwrap();
    });

    // 起壳口并把上游指到 mock ws。
    let shared = Arc::new(Shared::new());
    shared
        .set_upstream(crate::upstream::Upstream::Remote {
            base: format!("http://127.0.0.1:{upstream_port}"),
        })
        .await;
    let (shell, _state) = start_shell(shared).await;
    let shell_port = shell.rsplit(':').next().unwrap().parse::<u16>().unwrap();

    // 浏览器视角：直连壳口 /ws 发升级。
    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", shell_port))
        .await
        .unwrap();
    let key = "dGhlIHNhbXBsZSBub25jZQ=="; // RFC 6455 经典测试 key
    let req = format!(
        "GET /ws/collab/room-1?t=ticket-9 HTTP/1.1\r\n\
         Host: 127.0.0.1:{shell_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    client.write_all(req.as_bytes()).await.unwrap();
    client.flush().await.unwrap();

    // 读 101 响应头。
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = client.read(&mut tmp).await.unwrap();
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = find_subslice(&buf, b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    assert!(head.starts_with("HTTP/1.1 101"), "应回 101: {head}");
    let expected_accept = ws_accept(key);
    // 精确提取响应头里的 accept 值比对（头名按 HTTP 规范大小写不敏感；
    // 101 由 hyper/axum 重建，头名会被规范化为小写，故不能对整段做大小写敏感子串匹配）。
    let actual_accept = head
        .split("\r\n")
        .find_map(|l| {
            l.to_ascii_lowercase()
                .starts_with("sec-websocket-accept:")
                .then(|| l.split_once(':').map(|(_, v)| v.trim().to_string()))
                .flatten()
        })
        .expect("101 必须带 Sec-WebSocket-Accept 响应头");
    assert_eq!(
        actual_accept, expected_accept,
        "accept 必须对浏览器原始 key 算出，实际响应: {head}"
    );

    // 发一个掩码二进制帧（内容 GX-RAW-WS），期望原样 echo 回来。
    let payload = b"GX-RAW-WS-4403";
    let mask = [0x12u8, 0x34, 0x56, 0x78];
    let mut frame = vec![0x82u8, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    for (i, b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i % 4]);
    }
    client.write_all(&frame).await.unwrap();
    client.flush().await.unwrap();

    // 读回服务端（不掩码）二进制帧头 2 字节 + payload。
    client.read_exact(&mut tmp[..2]).await.unwrap();
    assert_eq!(tmp[0] & 0x0f, 0x02, "echo 必须是 binary opcode");
    assert_eq!(tmp[1] & 0x80, 0, "服务端帧不得掩码");
    let rlen = (tmp[1] & 0x7f) as usize;
    assert_eq!(rlen, payload.len());
    let mut echoed = vec![0u8; rlen];
    client.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, payload, "二进制帧必须经裸隧道双向透传");
}

// (e) 静态托管：真实文件 200、未知深链 SPA 回退、目录穿越/编码穿越/符号链接逃逸一律挡在根内。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn static_serves_files_spa_fallback_and_blocks_traversal() {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 唯一临时根（纳秒 + 进程 id 防并发撞名），结束 best-effort 清理。
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base_tmp = std::env::temp_dir().join(format!("gx-r1-e-{}-{nanos}", std::process::id()));
    let root = base_tmp.join("www");
    let outside = base_tmp.join("outside");
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::create_dir_all(&outside).unwrap();

    // 根内：index.html（SPA 入口，放唯一标记）+ 一个真实静态资源。
    let index = "<html><body>GX-SPA-INDEX-MARKER</body></html>";
    let asset = "console.log('gx-asset-ok');";
    fs::write(root.join("index.html"), index).unwrap();
    fs::write(root.join("assets").join("app.js"), asset).unwrap();
    // 根外机密：任何穿越手段都不得读到它。
    let secret = "GX-OUTSIDE-SECRET-777";
    fs::write(outside.join("secret.txt"), secret).unwrap();
    // 根内符号链接指到根外目录（canonicalize 会解析出真实路径）。
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("evil-link")).unwrap();

    // 先 set_web_root 再起服务，避免 handler 早读到未设置根。
    let shared = Arc::new(Shared::new());
    let state = Arc::new(ShellState::new(shared));
    state.set_web_root(root.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve_state = state.clone();
    tokio::spawn(async move {
        crate::shell_server::serve(listener, serve_state).await;
    });

    // 1) 真实静态资源 200 且逐字节一致、带 JS MIME。
    let (st, hdrs, body) = raw_get(port, "/assets/app.js").await;
    assert_eq!(st, 200, "真实资源应 200");
    assert_eq!(body, asset.as_bytes(), "静态资源必须逐字节返回");
    assert!(
        hdrs.to_ascii_lowercase().contains("text/javascript"),
        "JS 资源 MIME 不正确: {hdrs}"
    );

    // 2) 根路径与未知深链都回退 SPA index.html（history 路由刷新可用）。
    let (st_root, _, body_root) = raw_get(port, "/").await;
    assert_eq!(st_root, 200);
    assert_eq!(body_root, index.as_bytes(), "根路径应回 index.html");
    let (st_spa, _, body_spa) = raw_get(port, "/workspace/base123/table/t9?v=3").await;
    assert_eq!(st_spa, 200, "未知深链应回退而非 404");
    assert_eq!(body_spa, index.as_bytes(), "未知深链必须回退 index.html");

    // 3) 裸 `..` 穿越：reqwest 会自行规范化 URL，故用裸 TCP 发原始请求行。
    //    期望绝不返回机密内容（canonicalize 后落在根外 → 回退 index.html）。
    let (_, _, body_dot) = raw_get(port, "/../../outside/secret.txt").await;
    assert_ne!(body_dot, secret.as_bytes(), "裸 ../ 穿越必须被挡在根内");
    assert!(
        !body_dot
            .windows(secret.len())
            .any(|w| w == secret.as_bytes()),
        "响应中不得泄漏根外机密"
    );

    // 4) 百分号编码穿越（%2e%2e = '..'）：同样不得泄漏。
    let (_, _, body_enc) = raw_get(port, "/%2e%2e/%2e%2e/outside/secret.txt").await;
    assert_ne!(body_enc, secret.as_bytes(), "编码穿越必须被挡在根内");

    // 5) 符号链接逃逸（canonicalize 强项）：跟随链接会到根外，必须拒。
    #[cfg(unix)]
    {
        let (_, _, body_link) = raw_get(port, "/evil-link/secret.txt").await;
        assert_ne!(body_link, secret.as_bytes(), "符号链接逃逸必须被挡在根内");
    }

    let _ = fs::remove_dir_all(&base_tmp);
}

/// 裸 TCP 发一条 HTTP/1.1 GET（保留未规范化的 request target，用于真实复现 `..` 穿越），
/// 读到连接关闭，返回 (status, 原始响应头字符串, body)。
async fn raw_get(port: u16, target: &str) -> (u16, String, Vec<u8>) {
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let req =
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    sock.write_all(req.as_bytes()).await.unwrap();
    sock.flush().await.unwrap();

    let mut all = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = sock.read(&mut tmp).await.unwrap();
        if n == 0 {
            break;
        }
        all.extend_from_slice(&tmp[..n]);
    }
    let sep = find_subslice(&all, b"\r\n\r\n").expect("响应必须有头/体分隔");
    let head_end = sep + 4;
    let head = String::from_utf8_lossy(&all[..head_end]).to_string();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (status, head, all[head_end..].to_vec())
}

// ── 测试内自包含的 WS accept 计算（SHA1 + Base64），避免新增 dev-dependency ──────────

/// Sec-WebSocket-Accept = base64(sha1(key + GUID))。
fn ws_accept(key: &str) -> String {
    const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let mut input = String::with_capacity(key.len() + GUID.len());
    input.push_str(key);
    input.push_str(GUID);
    base64_encode(&sha1(input.as_bytes()))
}

fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TBL[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TBL[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TBL[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 极简 SHA1（FIPS 180-4），仅用于测试算 WS accept。
fn sha1(msg: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (msg.len() as u64).wrapping_mul(8);
    let mut padded = msg.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = if i < 20 {
                ((b & c) | ((!b) & d), 0x5A827999u32)
            } else if i < 40 {
                (b ^ c ^ d, 0x6ED9EBA1)
            } else if i < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
            } else {
                (b ^ c ^ d, 0xCA62C1D6)
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    let hs = [h0, h1, h2, h3, h4];
    for (i, h) in hs.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&h.to_be_bytes());
    }
    out
}

#[test]
fn sha1_known_vector_and_accept_rfc() {
    // SHA1("abc") 标准向量。
    assert_eq!(
        hex_lower(&sha1(b"abc")),
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    // RFC 6455 §4.2.2 经典 accept。
    assert_eq!(
        ws_accept("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

fn hex_lower(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
