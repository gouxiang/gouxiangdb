//! axum 壳口服务（IMPL-0.2.5-beta §2 / §4-R1）。
//!
//! 一个 SHELL_PORT 承担两件事：① 静态托管前端产物 + SPA history fallback；
//! ② 业务前缀（/api /health /healthz /readyz /uploads /ws /__gx/probe）反向代理到当前活动上游。
//!
//! 路由优先级（matchit 0.8 静态段优先于通配，业务前缀因此不会被静态吞掉）：
//! - 精确：/health /healthz /readyz
//! - 通配：/api、/api/{*rest}、/uploads、/uploads/{*rest}
//! - 隧道：/ws、/ws/{*rest}（协同真实路径 /ws/collab/<roomId>?t=）
//! - probe：/__gx/probe/{probe_id}/{*tail}
//! - 静态：/、/{*path}（未命中文件 → SPA index.html）
//!
//! 静态服务**手写**（不引 ServeDir/tower-http）：保留与 PoC `serve_one` 等价的目录穿越防护
//! （canonicalize 后必须仍在 root 内）与同一套 MIME 判定。
//!
//! 绑定由调用方（main.rs setup）先建 `tokio::net::TcpListener`（127.0.0.1:0，OS 分配随机口），
//! 拿到实际端口写入 ShellState 后再 spawn [`serve`]，SHELL_PORT 全程不变。
//
// TODO(R3): 对齐 tauri.conf frontendDist 壳静态根（R1 先用 resource_dir/server/public）。

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;

use crate::commands::ShellState;
use crate::proxy::{probe, proxy};
use crate::proxy_ws::ws_tunnel;

/// 构造壳口 Router（纯函数，便于复用/测试）。
pub fn router(state: Arc<ShellState>) -> Router {
    // 业务前缀：方法不限（GET/POST/PUT/PATCH/DELETE/OPTIONS 等都转发；OPTIONS 204 在 proxy 内兜底）。
    let business = any(proxy);

    Router::new()
        // 精确健康/就绪前缀。
        .route("/health", business.clone())
        .route("/healthz", business.clone())
        .route("/readyz", business.clone())
        // 业务通配（{*rest} 捕获含前导 '/' 的剩余段）。
        .route("/api", business.clone())
        .route("/api/{*rest}", business.clone())
        .route("/uploads", business.clone())
        .route("/uploads/{*rest}", business)
        // WS 隧道：仅 GET（升级请求）。
        .route("/ws", get(ws_tunnel))
        .route("/ws/{*rest}", get(ws_tunnel))
        // 添加节点握手 probe 显式目标（probeId 后必须带子路径，如 /api/auth/login）。
        .route("/__gx/probe/{probe_id}/{*tail}", any(probe))
        // 静态资源（GET/HEAD；未命中文件由 handler 内部回退 index.html）。
        .route("/", get(static_or_spa))
        .route("/{*path}", get(static_or_spa))
        // 兜底：非 GET / 未匹配路径回 index.html（history 深链刷新）；非 GET 返回 405。
        .fallback(get(spa_index))
        .with_state(state)
}

/// 在给定（已绑定随机回环口的）listener 上运行壳口服务。调用方负责 spawn 并自行保活。
pub async fn serve(listener: tokio::net::TcpListener, state: Arc<ShellState>) {
    let app = router(state);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[desktop shell] 壳口服务退出: {e}");
    }
}

/// GET 静态资源；文件不存在时回退 SPA index.html。
async fn static_or_spa(State(state): State<Arc<ShellState>>, uri: Uri) -> Response {
    let Some(root) = state.web_root() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "shell web root not configured",
        )
            .into_response();
    };
    match serve_file(root, uri.path()) {
        Some(resp) => resp,
        None => spa_index(State(state)).await,
    }
}

/// SPA history fallback：返回 web_root/index.html（缺失则 500 文本，绝不 panic）。
async fn spa_index(State(state): State<Arc<ShellState>>) -> Response {
    let Some(root) = state.web_root() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "shell web root not configured",
        )
            .into_response();
    };
    match serve_file(root, "/index.html") {
        Some(resp) => resp,
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "shell web root missing index.html",
        )
            .into_response(),
    }
}

/// 读取并返回一个静态文件；目录穿越/非文件/缺失均返回 None（交由 SPA fallback）。
fn serve_file(root: &std::path::Path, url_path: &str) -> Option<Response> {
    // 去掉前导 '/' 得相对路径；根路径映射 index.html。
    let rel = url_path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let candidate = root.join(rel);
    let root_canon = root.canonicalize().ok()?;
    // 目录穿越防护：规范化后必须仍在 root 内（等价 PoC serve_one；canonicalize 顺带解析 symlink）。
    let safe = candidate
        .canonicalize()
        .map(|c| c.starts_with(&root_canon) && c.is_file())
        .unwrap_or(false);
    if !safe {
        return None;
    }

    let data = std::fs::read(&candidate).ok()?;
    let mime = mime_for(&candidate.to_string_lossy());
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime)
        // 壳口同源承载 SPA：不做强缓存，避免发版后卡在旧 bundle（静态 hash 资源后续可再细分）。
        .header(axum::http::header::CACHE_CONTROL, "no-cache")
        .body(Body::from(data))
        .ok()
}

/// MIME 判定（沿用 main.rs PoC `mime_for` 并略补字体/wasm）。
fn mime_for(path: &str) -> &'static str {
    if path.ends_with(".html") || path.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
}
