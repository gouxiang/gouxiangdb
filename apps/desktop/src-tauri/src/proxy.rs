//! HTTP 反向代理处理器（IMPL-0.2.5-beta §4-R1「代理规格」）。
//!
//! ## ATS 结论（文件头登记，勿改 Info.plist）
//! Rust 侧对外连接走 reqwest + rustls / 明文 hyper 客户端，**不经过 Apple ATS**
//! （ATS 只约束 URLSession / WKWebView；rustls 自握 TLS，明文 http 是裸 socket）。
//! 因此代理对局域网明文 http 远端、对 https 远端都可直连，无需在 Info.plist 增加
//! `NSAllowsArbitraryLoads`。Info.plist 维持仅 `NSAllowsArbitraryLoadsInWebContent=true`
//! （放开的是 WebView，业务握手仍由 WebView 发出；Rust 只盲转发）。
//!
//! ## 行为要点
//! - 业务前缀（/api /health /healthz /readyz /uploads）先取当前活动上游；None → 503
//!   JSON `{"code":503,"message":"NODE_NOT_ACTIVE"}`。
//! - 转发剥除 Origin/Referer（对端把请求当服务端调用，硬配 CORS 的节点也无从拦起），
//!   Host 由 reqwest 按目标 URL 自动设置；白名单透传业务头；**请求体流式**（multipart 不全量缓冲）。
//! - 显式 `Accept-Encoding: identity`：reqwest 本特性集未开压缩，但仍显式声明，避免上游返回
//!   压缩字节导致 Content-Length/编码语义失真，上游回未压缩原文由我们原样透传。
//! - 响应状态码透传；只转发安全响应头白名单，不转发任何 `Access-Control-Allow-*`（已同源）；
//!   不转发 Set-Cookie（我方 Bearer-only，等价于抹除域）；Location 指回上游 origin 时改写为壳同源。

use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::commands::ShellState;

/// 无活动上游时的固定响应体（§4：前端据此回启动器）。
pub const NODE_NOT_ACTIVE_BODY: &str = r#"{"code":503,"message":"NODE_NOT_ACTIVE"}"#;

/// 请求头透传白名单（Bearer-only 模型；Origin/Referer/Host/Accept-Encoding 不在其中）。
/// 用小写静态字符串而非 `const HeaderName`：`HeaderName::from_static` 的常量结果带内部可变性，
/// 不能在 const 数组里做提升期借用（E0492）；HeaderMap/reqwest 按名取值均大小写不敏感。
const FORWARD_REQUEST_HEADERS: &[&str] = &["x-gx-token", "authorization", "content-type", "accept"];

/// 响应头透传白名单（安全、与缓存/下载相关；CORS 头一律不转，Set-Cookie 不转）。
const FORWARD_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
    "vary",
    "x-request-id",
];

/// 幂等安装 rustls ring 加密提供者（进程级，壳启动早期调用一次）。
///
/// reqwest 0.13 用 `rustls-no-provider`、rustls 也只选 ring feature，二者都不自带已安装的
/// crypto provider（且全树无 aws-lc-rs）；首次 https/wss 握手前必须安装，否则运行时报
/// "no process-level CryptoProvider available"。写法逐字对齐 tauri-plugin-updater
/// updater.rs:585-587：仅当尚无默认 provider 时安装，install 失败（已存在）忽略。
pub fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // This can only fail if there is already a default provider which we checked for already.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// 进程级共享 reqwest client（懒初始化一次，复用连接池）：
/// 不跟随重定向（Location 由我们自己改写）、不启用压缩。
/// TLS 用 reqwest 的 rustls 后端 + 平台证书校验（rustls-platform-verifier），provider 用 ring。
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        ensure_crypto_provider();
        reqwest::Client::builder()
            // 我们在响应层自行判断/改写 Location，禁止 reqwest 自动跟随，避免跨源跳转。
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client 构造为静态配置，不会失败")
    })
}

/// 503 无活动上游（精确 JSON 体）。
fn node_not_active() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        NODE_NOT_ACTIVE_BODY,
    )
        .into_response()
}

/// 502 上游不可达/转发失败（不向前端泄漏内部细节）。
fn bad_gateway() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"code":502,"message":"UPSTREAM_UNREACHABLE"}"#,
    )
        .into_response()
}

/// 业务前缀反代：/api/* /health /healthz /readyz /uploads/*（路由见 shell_server.rs）。
///
/// 任意业务路径的 OPTIONS 直接 204（浏览器同源不发预检，这里仅兜底；R1 不挂 WS 以外的跨源面）。
pub async fn proxy(State(state): State<Arc<ShellState>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();

    if parts.method == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }

    let Some(base) = state.shared.get_upstream().await.http_base() else {
        return node_not_active();
    };

    let url = join_forward_url(&base, &parts.uri);
    forward_upstream(state.port(), &url, parts.method, &parts.headers, Some(body)).await
}

/// probe 显式目标转发：`/__gx/probe/<probeId>/<api 路径...>`。
///
/// 命中 probeId → 把方法/头/体原样转发到 `baseURL/<api 路径>`；未知或过期 probeId → 404。
/// 不读取/不改变当前活动上游（仅供「添加节点握手」短期使用，TTL≤120s、仅 loopback 可达）。
pub async fn probe(
    State(state): State<Arc<ShellState>>,
    Path((probe_id, tail)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();

    if parts.method == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }

    let Some(base) = state.shared.lookup_probe(&probe_id) else {
        return (
            StatusCode::NOT_FOUND,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            r#"{"code":404,"message":"PROBE_NOT_FOUND"}"#,
        )
            .into_response();
    };

    // tail 为 matchit 通配捕获（含前导 '/'，不含 query）。probe 转发只看 probeId 之后的子路径，
    // 不能用 uri.path()（那是 /__gx/probe/... 壳路径）；query 从 parts.uri 单独取。
    let url = join_probe_url(&base, &tail, parts.uri.query());
    // probe 是对「尚非活动上游」的目标握手，Location 仍改写回壳口同源。
    forward_upstream(state.port(), &url, parts.method, &parts.headers, Some(body)).await
}

/// 拼接业务转发 URL：base(origin) + 原始 path + 原始 query。
fn join_forward_url(base: &str, uri: &Uri) -> String {
    match uri.query() {
        Some(q) => format!("{base}{}?{q}", uri.path()),
        None => format!("{base}{}", uri.path()),
    }
}

/// 拼接 probe 转发 URL：base(origin) + 通配 tail（含前导 '/'）+ 原 query。
fn join_probe_url(base: &str, tail: &str, query: Option<&str>) -> String {
    // tail 已含前导 '/'（matchit `{*tail}` 语义）；归一掉重复斜杠。
    let tail = if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    match query {
        Some(q) => format!("{base}{tail}?{q}"),
        None => format!("{base}{tail}"),
    }
}

/// 执行到上游的转发并把响应映射回 axum 响应。`body` 为请求体（流式，见文件头）。
pub(crate) async fn forward_upstream(
    shell_port: u16,
    url: &str,
    method: Method,
    in_headers: &HeaderMap,
    body: Option<Body>,
) -> Response {
    let Ok(parsed_url) = reqwest::Url::parse(url) else {
        return bad_gateway();
    };
    let upstream_origin = format!(
        "{}://{}{}",
        parsed_url.scheme(),
        parsed_url.host_str().unwrap_or(""),
        match parsed_url.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        }
    );

    let mut builder = http_client().request(method, parsed_url);

    // 白名单透传业务头；Content-Type 里携带 multipart boundary，必须原样。
    for name in FORWARD_REQUEST_HEADERS {
        if let Some(value) = in_headers.get(*name) {
            builder = builder.header(*name, value.clone());
        }
    }
    // 显式 identity：上游回未压缩字节，避免 Content-Length/编码失真（见文件头）。
    builder = builder.header(
        axum::http::header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );

    // body 流式：axum BodyDataStream（TryStream<Ok=Bytes>）直接 wrap 给 reqwest，
    // 绝不经 to_bytes 全量缓冲（multipart 大文件上传不能炸壳内存）。
    if let Some(body) = body {
        let stream = body.into_data_stream();
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    }

    let upstream_resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[desktop proxy] 上游请求失败 {url}: {e}");
            return bad_gateway();
        }
    };

    let status =
        StatusCode::from_u16(upstream_resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream_resp.headers().clone();

    // 响应体流式回传：上游 bytes_stream → axum Body::from_stream，同样不全量缓冲（下载大文件）。
    let mut out_builder = Response::builder().status(status);
    let headers_out = out_builder
        .headers_mut()
        .expect("response builder headers 在设置 body 前始终可用");

    for name in FORWARD_RESPONSE_HEADERS {
        if let Ok(hname) = HeaderName::from_bytes(name.as_bytes()) {
            for value in upstream_headers.get_all(&hname).iter() {
                if let Ok(v) = HeaderValue::from_bytes(value.as_bytes()) {
                    headers_out.append(hname.clone(), v);
                }
            }
        }
    }
    // 明确不转发：任何 Access-Control-Allow-*（已同源无需 CORS）、Set-Cookie（Bearer-only）。

    // Location 若指回上游 origin（登录跳转/3xx 等），改写为壳口同源，防浏览器被导去跨源地址。
    if let Some(loc) = upstream_headers.get(axum::http::header::LOCATION) {
        if let Ok(loc_str) = loc.to_str() {
            if let Some(rewritten) = rewrite_location(loc_str, &upstream_origin, shell_port) {
                headers_out.insert(
                    axum::http::header::LOCATION,
                    HeaderValue::from_str(&rewritten).unwrap_or(HeaderValue::from_static("/")),
                );
            }
        }
    }

    let stream = upstream_resp.bytes_stream();
    match out_builder.body(Body::from_stream(stream)) {
        Ok(r) => r,
        Err(_) => bad_gateway(),
    }
}

/// 把指向上游 origin 的绝对 Location 改写为壳同源；相对 Location 或指向别处的绝对 URL 原样保留。
fn rewrite_location(location: &str, upstream_origin: &str, shell_port: u16) -> Option<String> {
    // 相对路径（/foo、./foo）天然同源，无需改写。
    if location.starts_with('/') || location.starts_with('.') {
        return None;
    }
    let parsed = reqwest::Url::parse(location).ok()?;
    let loc_origin = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str()?,
        match parsed.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        }
    );
    if !loc_origin.eq_ignore_ascii_case(upstream_origin) {
        return None;
    }
    // 指回上游：换成壳口固定地址，保留 path/query/fragment。
    let mut suffix = parsed.path().to_string();
    if let Some(q) = parsed.query() {
        suffix.push('?');
        suffix.push_str(q);
    }
    if let Some(f) = parsed.fragment() {
        suffix.push('#');
        suffix.push_str(f);
    }
    Some(format!("http://127.0.0.1:{shell_port}{suffix}"))
}
