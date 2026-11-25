//! Loopback health endpoint + shared daemon state. The single HTTP surface,
//! bound to loopback for `weft doctor`; never exposed off-device.

use axum::{extract::State, routing::get, Json, Router};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::store::{Store};

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub dbus: Option<Arc<zbus::Connection>>,
    /// Page-change events from the watcher; consumed by the cloud sync loop.
    pub events: broadcast::Sender<String>,
    pub firmware: String,
    pub model: String,
    pub templates_dir: std::path::PathBuf,
}

/// The daemon's only HTTP route: a health probe for `weft doctor`.
pub fn health_router(state: AppState) -> Router {
    Router::new().route("/api/health", get(health)).with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "daemon": "rmsyncd",
        "version": env!("CARGO_PKG_VERSION"),
        "firmware": state.firmware,
        "model": state.model,
        "dbus": state.dbus.is_some(),
    }))
}
