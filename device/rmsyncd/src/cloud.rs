//! Cloud sync loop: mirror local pages to the hosted store and pull foreign
//! changes back. Conflicts resolve by writing cloud bytes locally and letting
//! xochitl CRDT-merge them; the merged file pushes back on its own change event.
//! Pairing config lives in cloud.json ({url, token}); no config = loop disabled.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

use crate::recovery::{self, AssetDigest, Checkpoint};
use crate::server::AppState;
use crate::store::{Store, WriteError};

const CLIENT_ID: &str = "rmsyncd";

/// Largest source file (PDF) the daemon reads + uploads. Must match the server
/// cap (PUT /api/documents/:doc/file, 128 MiB): a larger file is 413-rejected
/// and can never sync, and reading it into RAM would OOM the 1-2 GB tablet.
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;

/// WebSocket wake loop: route each /ws event to an immediate pull so inbound
/// web changes land in ~300ms instead of on the fallback poll.
///   - page.changed / ops.appended -> `wake_pages`
///   - doc.list.changed            -> `wake_docs`
/// The periodic poll remains as a safety net for events missed while the socket
/// was down, and as the outbound direction (no server event drives pushes).
/// Auth rides the x-device-token handshake header. Reconnects with capped
/// backoff; a WS failure never affects the poll path.
async fn ws_wake_loop(
    config: CloudConfig,
    wake_pages: Arc<Notify>,
    wake_docs: Arc<Notify>,
    wake_assets: Arc<Notify>,
) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let base = config.url.trim_end_matches('/');
    let ws_url = if let Some(rest) = base.strip_prefix("https") {
        format!("wss{rest}/ws")
    } else if let Some(rest) = base.strip_prefix("http") {
        format!("ws{rest}/ws")
    } else {
        format!("{base}/ws")
    };

    let mut backoff = 1u64;
    loop {
        let connect = async {
            let mut req = ws_url.as_str().into_client_request()?;
            req.headers_mut()
                .insert("x-device-token", config.token.parse()?);
            tokio_tungstenite::connect_async(req).await
        };
        // bound the connect: an unbounded handshake on half-up wifi wedges the
        // reconnect loop
        let connected = tokio::time::timeout(Duration::from_secs(30), connect).await;
        match connected {
            Err(_) => {
                eprintln!("cloud: ws connect timed out");
            }
            Ok(Ok((stream, _))) => {
                backoff = 1;
                eprintln!("cloud: ws connected -> {ws_url}");
                // A reconnect may mean the server restarted with new push logic.
                // Bust the doc-list digest so the next tick re-pushes once
                // (idempotent), otherwise a server-side fix waits for the tablet
                // tree to change before it sees a push.
                *LAST_DOC_PUSH.lock().expect("doc-push digest lock") = None;
                // Heartbeat: a wifi-sleep half-open TCP leaves next() blocking
                // forever with no Close/Err, killing the fast path for the whole
                // process life. Ping every PING; a Ping unanswered by the next
                // tick means the link is dead. Split so Pings and frame reads
                // don't alias the same &mut in the select.
                use futures_util::SinkExt;
                const PING: Duration = Duration::from_secs(20);
                let (mut write, mut read) = stream.split();
                let mut ping = tokio::time::interval(PING);
                let mut awaiting_pong = false;
                loop {
                    tokio::select! {
                        msg = read.next() => match msg {
                            Some(Ok(Message::Text(t))) => {
                                // Route by the exact `type` field, not a substring
                                // scan: frames echo a client-controlled
                                // originClientId that could otherwise misroute an
                                // edit. A spurious poke is harmless (pulls are
                                // idempotent).
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                    match v.get("type").and_then(|x| x.as_str()) {
                                        Some("doc.list.changed") => wake_docs.notify_one(),
                                        Some("page.asset.changed") => wake_assets.notify_one(),
                                        Some("page.changed") | Some("ops.appended") => {
                                            wake_pages.notify_one()
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            Some(Ok(Message::Pong(_))) => awaiting_pong = false,
                            Some(Ok(Message::Ping(_))) => {} // tungstenite auto-pongs
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            _ => {}
                        },
                        _ = ping.tick() => {
                            if awaiting_pong {
                                eprintln!("cloud: ws ping unanswered; reconnecting");
                                break;
                            }
                            if write.send(Message::Ping(Default::default())).await.is_err() {
                                break;
                            }
                            awaiting_pong = true;
                        }
                    }
                }
                eprintln!("cloud: ws disconnected; reconnecting");
            }
            Ok(Err(e)) => eprintln!("cloud: ws connect failed ({e})"),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

#[derive(Deserialize, Clone)]
pub struct CloudConfig {
    pub url: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Default)]
struct CloudState {
    /// Which cloud this state belongs to: hash of url+token. The maps below are
    /// dedup caches against that cloud; a mismatched identity on load resets the
    /// state so a repointed/wiped cloud gets a full re-push instead of silently
    /// suppressing every push as "already synced".
    #[serde(default)]
    cloud_identity: String,
    /// "doc/page" -> last cloud revision we are based on
    revisions: HashMap<String, String>,
    /// In-memory install path, derived from the configured relay identity.
    #[serde(skip)]
    recovery_root: Option<PathBuf>,
    #[serde(skip)]
    recovery_budget: Option<recovery::Budget>,
    #[serde(skip)]
    recovery_after: Option<String>,
    // Inspect a page at most once per process, even while relay I/O retries.
    #[serde(skip)]
    recovery_reclaim_checked: HashSet<String>,
    /// Last asset generation applied independently of native page revisions.
    #[serde(default)]
    pulled_asset_revisions: HashMap<String, String>,
    /// Durable recovery/asset generations observed this run; populated lazily.
    #[serde(skip)]
    protected: HashMap<String, (String, String)>,
    /// "doc/page" -> sha256 of the .rm content last successfully PUT. Op-mode
    /// dedup: an op-mode page's revision is an op-head marker ("ops:N") that
    /// never equals the local sha, so `base == local_rev` always misses and the
    /// daemon would re-PUT every tick. Compare the last-pushed content hash
    /// instead. Consulted only for op-mode (blob-mode short-circuits on
    /// `base == local_rev`); empty for pages never pushed.
    #[serde(default)]
    pushed: HashMap<String, String>,
    /// "doc/page" -> mtime (ms) of the last thumbnail we pushed (dedup)
    #[serde(default)]
    thumbnails: HashMap<String, u64>,
    /// "doc/page/name" -> mtime (ms) of the last asset file pushed (dedup).
    /// Separate from the page hash so reconcile_all can retry a failed asset PUT
    /// independently: otherwise a transient asset failure left the page deduped
    /// and the cloud stayed missing the image until the ink was re-edited.
    #[serde(default)]
    assets: HashMap<String, u64>,
    /// doc -> mtime (ms) of the last source file (PDF) we pushed (dedup)
    #[serde(default)]
    files: HashMap<String, u64>,
    /// template name -> mtime (ms) we pushed (dedup)
    #[serde(default)]
    templates: HashMap<String, u64>,
    /// "{doc}:name" / "{doc}:parent" / "{doc}:t:{page}" -> highest cloud field
    /// stamp already applied locally. Stamped registers (web renames, moves,
    /// template picks) apply by stamp, not whole-doc lastModified: a tablet
    /// content edit bumps local lm and would otherwise refuse a web move forever.
    #[serde(default)]
    applied_meta: HashMap<String, u64>,
    /// change-feed cursor
    since: u64,
    /// The exclusion set as of the last successful fetch. A doc present here but
    /// absent from a fresh fetch was re-included by the user and is pushed with
    /// top priority.
    #[serde(default)]
    exclusions: Vec<String>,
}

/// True for an op-mode page revision ("ops:N"), false for a blob-mode revision
/// (sha256 of the stored bytes). The empty revision (never pushed) is blob-mode.
fn is_op_mode(revision: &str) -> bool {
    revision.starts_with("ops:")
}

/// Whether push_page can skip a PUT because the cloud already holds this exact
/// content. Two regimes:
///  - blob mode (`base` not "ops:"): the cloud revision is the content sha, so
///    `base == local_rev` proves the cloud holds this file.
///  - op mode (`base` starts with "ops:"): the revision is an op-head marker
///    that never equals a content sha, so compare `local_rev` against the
///    last-pushed content hash; equal means byte-unchanged since our push.
/// Empty base (never pushed) is blob-mode, so the first push always fires.
fn should_skip_push(base: &str, last_pushed: Option<&str>, local_rev: &str) -> bool {
    if is_op_mode(base) {
        last_pushed == Some(local_rev)
    } else {
        base == local_rev
    }
}

fn mtime_ms(path: &std::path::Path) -> Option<u64> {
    crate::store::modified_since_epoch(path).map(|d| d.as_millis() as u64)
}

pub fn load_config(path: &PathBuf) -> Option<CloudConfig> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Identity of the cloud a state file was built against: hash(url|token).
/// Hashed so the token never sits in the state file in the clear.
fn cloud_identity(config: &CloudConfig) -> String {
    crate::store::sha256_hex(format!("{}|{}", config.url, config.token).as_bytes())
}

/// Dedup maps are only valid against the cloud they were built with. A different
/// url/token (repoint, re-pair, wiped server) must start from scratch, else
/// every push is silently suppressed as "already synced". Pre-identity state
/// files (empty identity) are also reset: the source cloud is unknown.
fn reconcile_state_identity(loaded: CloudState, identity: &str) -> CloudState {
    if loaded.cloud_identity == identity {
        return loaded;
    }
    if !loaded.revisions.is_empty() || !loaded.pushed.is_empty() {
        eprintln!("cloud: config identity changed; resetting sync state (full re-push)");
    }
    CloudState {
        cloud_identity: identity.to_string(),
        ..CloudState::default()
    }
}

pub fn spawn(state: AppState, config: CloudConfig, state_path: PathBuf) {
    tokio::spawn(async move {
        // Timeouts are load-bearing: suspend pauses CLOCK_MONOTONIC, so pooled
        // pre-suspend connections look fresh on wake; an untimed request into
        // that dead connection blocks the serial sync loop for the kernel TCP
        // timeout (15+ min) and nothing syncs until it expires.
        //  - read_timeout: any 60s stall kills the request (retried next tick)
        //  - connect_timeout: half-up wifi right after wake fails fast
        //  - pool_idle_timeout: shrink the stale-reuse window
        //  - timeout: absolute backstop, generous for big source uploads
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("reqwest client");
        let identity = cloud_identity(&config);
        let mut cloud: CloudState = match std::fs::read_to_string(&state_path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(state) => state,
                Err(e) => {
                    // A non-empty state file that fails to parse is corruption,
                    // not a fresh install. Defaulting silently would erase every
                    // causal base and re-push the library with empty
                    // x-base-revision, so back up the file and start fresh. The
                    // server's empty-base fail-safe (no absence-deletions without
                    // a causal claim) makes the fresh start safe.
                    eprintln!(
                        "cloud: cloud-state.json CORRUPT ({e}); backing up and starting fresh"
                    );
                    let _ = std::fs::copy(&state_path, state_path.with_extension("json.corrupt"));
                    CloudState::default()
                }
            },
            Err(_) => CloudState::default(), // genuinely absent: fresh install
        };
        cloud = reconcile_state_identity(cloud, &identity);
        if std::env::var("WEFT_TABLET_RECOVERY").as_deref() == Ok("1") {
            let root = state_path.with_file_name("recovery-v1");
            match recovery::Budget::open(&root) {
                Ok(budget) => {
                    cloud.recovery_budget = Some(budget);
                    cloud.recovery_root = Some(root.join(identity));
                    // Audit saved files before reusing their generation after restart.
                    cloud.pulled_asset_revisions.clear();
                }
                Err(e) => eprintln!("cloud: tablet recovery disabled: {e}"),
            }
        }
        let mut events = state.events.subscribe();
        // The WebSocket wake (below) is the primary web->tablet path (~300ms).
        // The periodic tick is a low-frequency fallback plus the routine
        // doc-list/recency reconcile; 15s keeps it cheap on a battery tablet.
        let pull_secs = std::env::var("CLOUD_PULL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(15);
        let mut tick = tokio::time::interval(Duration::from_secs(pull_secs));
        eprintln!("cloud: sync loop active -> {}", config.url);

        // WebSocket wake: a remote change pokes one of these to pull immediately
        // instead of waiting for the fallback tick.
        let wake_pages = Arc::new(Notify::new()); // page edits
        let wake_docs = Arc::new(Notify::new()); // renames/moves/templates/opens
        let wake_assets = Arc::new(Notify::new());
        tokio::spawn(ws_wake_loop(
            config.clone(),
            wake_pages.clone(),
            wake_docs.clone(),
            wake_assets.clone(),
        ));

        // Initial full sync: push the doc list, then every page/thumbnail the
        // cloud is missing. Existing notebooks emit no change event, so without
        // this they never reach the hosted store.
        let exclusions = refresh_exclusions(&state, &client, &config, &mut cloud).await;
        push_documents(&state, &client, &config, exclusions.as_ref()).await;
        let mut sweep_etag: Option<String> = None;
        reconcile_all(
            &state,
            &client,
            &config,
            &mut cloud,
            exclusions.as_ref(),
            &mut sweep_etag,
        )
        .await;
        save(&state_path, &cloud);

        let mut ticks: u64 = 0;
        loop {
            tokio::select! {
                event = events.recv() => {
                    let Ok(raw) = event else { continue };
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
                    if value.get("type").and_then(|t| t.as_str()) == Some("page.changed") {
                        let doc = value.get("doc").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        let page = value.get("page").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        // Skip a directly-excluded doc's edits: the server would
                        // 403 them anyway. Folder-excluded docs still fall through
                        // to the server's 403 backstop.
                        if !cloud.exclusions.iter().any(|e| e == &doc) {
                            push_page(&state, &client, &config, &mut cloud, &doc, &page).await;
                            save(&state_path, &cloud);
                        }
                    }
                }
                // Remote page edit over the WebSocket. Pull the first edit
                // immediately (network latency only, no fixed lead), then
                // coalesce a trailing burst: while edits keep arriving, pull at
                // most once per cooldown window instead of per-op. Keeps
                // pull-storm protection (continuous web drawing -> ~1 rewrite +
                // reload per window) without a fixed lead on every edit.
                _ = wake_pages.notified() => {
                    pull_changes(&state, &client, &config, &mut cloud).await;
                    save(&state_path, &cloud);
                    loop {
                        let mut more = false;
                        let cooldown = tokio::time::sleep(std::time::Duration::from_millis(700));
                        tokio::pin!(cooldown);
                        loop {
                            tokio::select! {
                                _ = &mut cooldown => break,
                                _ = wake_pages.notified() => { more = true; }
                            }
                        }
                        if !more {
                            break;
                        }
                        pull_changes(&state, &client, &config, &mut cloud).await;
                            save(&state_path, &cloud);
                    }
                }
                _ = wake_assets.notified() => {
                    // Assets can change without an .rm revision. Sweep their
                    // lightweight validators, never hash every local image.
                    reconcile_current_pulls(&state, &client, &config, &mut cloud, &mut sweep_etag).await;
                    save(&state_path, &cloud);
                }
                // Remote doc-list change (rename/move/template/open): apply it to
                // xochitl immediately instead of on the fallback tick.
                _ = wake_docs.notified() => {
                    pull_documents(&state, &client, &config, &mut cloud).await;
                    pull_last_opened(&state, &client, &config).await;
                }
                _ = tick.tick() => {
                    ticks += 1;
                    // Fallback change pull (WS wake is the fast path).
                    pull_changes(&state, &client, &config, &mut cloud).await;
                    // Pull cloud doc-list edits before pushing local state, so the
                    // push reflects the merged result and a concurrent web edit
                    // isn't clobbered by our whole-list push.
                    pull_documents(&state, &client, &config, &mut cloud).await;
                    // Fold web opens into .metadata (max-register) before the
                    // doc-list push so the pushed list carries the merged recency.
                    pull_last_opened(&state, &client, &config).await;
                    // Exclusions fetch filters the doc-list push and detects
                    // re-included docs (pushed with top priority).
                    let exclusions = refresh_exclusions(&state, &client, &config, &mut cloud).await;
                    push_documents(&state, &client, &config, exclusions.as_ref()).await;
                    // Periodic full reconcile catches anything a missed change
                    // event left behind. Cheap when in sync.
                    if ticks % 40 == 0 {
                        reconcile_all(&state, &client, &config, &mut cloud, exclusions.as_ref(), &mut sweep_etag).await;
                    } else if cloud.recovery_after.is_some() {
                        // Continue bounded recovery backfill only after the
                        // ordinary sync work for this tick has completed.
                        reconcile_current_pulls(&state, &client, &config, &mut cloud, &mut sweep_etag).await;
                    }
                    save(&state_path, &cloud);
                }
            }
        }
    });
}

/// Fetch the exclusion set, priority-push anything the user just re-included
/// (its source + pages jump the queue), and remember the set for the next diff.
/// Returns the fresh set, or None on fetch failure: callers then skip exclusion
/// filtering and the remembered set stays untouched, so a network blip can
/// neither drop docs from the push nor fake a mass re-include.
///
/// Re-inclusion is computed on the expanded sets (descendants included):
/// unticking a folder re-includes everything under it, each descendant getting
/// the same priority push, else they surface page-less in the web library until
/// the next full reconcile.
async fn refresh_exclusions(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
) -> Option<std::collections::HashSet<String>> {
    let fresh = fetch_exclusions(client, config).await?;
    let prev: std::collections::HashSet<String> = cloud.exclusions.iter().cloned().collect();
    if prev != fresh {
        let docs = state.store.list_documents();
        let prev_covered = expand_exclusions(&docs, &prev);
        let fresh_covered = expand_exclusions(&docs, &fresh);
        let mut budget = fetch_sources_budget(client, config).await;
        for doc in &docs {
            if doc.kind == "folder"
                || !prev_covered.contains(&doc.id)
                || fresh_covered.contains(&doc.id)
            {
                continue; // not a newly re-included document
            }
            eprintln!("cloud: re-included {}, pushing with priority", doc.id);
            for page in &doc.pages {
                push_page(state, client, config, cloud, &doc.id, &page.id).await;
                push_thumbnail(state, client, config, cloud, &doc.id, &page.id).await;
            }
            // drop the mtime dedup so the source re-uploads even if unchanged
            // since a pre-exclusion push. A budget refusal doesn't stop the
            // loop: the pages above still synced, and the promise is priority,
            // not budget override.
            cloud.files.remove(&doc.id);
            let _ = push_file(state, client, config, cloud, &doc.id, &mut budget).await;
        }
    }
    cloud.exclusions = fresh.iter().cloned().collect();
    Some(fresh)
}

/// GET /api/last-opened and fold every web open into the matching doc's
/// .metadata via the max-register merge (apply_last_opened). Idempotent and
/// self-healing: values already at/behind the local register write nothing.
async fn pull_last_opened(state: &AppState, client: &reqwest::Client, config: &CloudConfig) {
    let url = format!("{}/api/last-opened", config.url);
    let Ok(r) = client
        .get(&url)
        .header("x-device-token", &config.token)
        .send()
        .await
    else {
        return;
    };
    if !r.status().is_success() {
        return; // an old cloud without the route: nothing to fold
    }
    let Ok(body) = r.json::<serde_json::Value>().await else {
        return;
    };
    let Some(docs) = body.get("docs").and_then(|v| v.as_object()) else {
        return;
    };
    for (doc, v) in docs {
        let page = v.get("page").and_then(|p| p.as_str()).unwrap_or_default();
        let at = v.get("at").and_then(|a| a.as_u64()).unwrap_or(0);
        if state.store.apply_last_opened(doc, page, at) {
            eprintln!("cloud: folded web open into {doc} (lastOpened {at})");
            // Writing .metadata is inert until xochitl re-reads it, which it
            // only does on a documentFinished dbus signal carrying that doc's
            // .metadata path. The reload makes the web open surface in the home
            // screen's Last-opened sort.
            if let Some(conn) = &state.dbus {
                crate::dbus::trigger_reload(conn, doc, &[format!("{doc}.metadata")]).await;
            }
        }
    }
}

fn save(path: &PathBuf, cloud: &CloudState) {
    if let Ok(json) = serde_json::to_string(cloud) {
        // Atomic temp+rename+fsync, NOT a bare write: a crash/power-loss partway
        // through writing cloud-state.json would leave truncated JSON that fails
        // to parse on next boot -> unwrap_or_default() wipes every dedup map and
        // the `since` cursor -> a full re-PUT + re-pull of the whole tablet
        // (bandwidth + battery). rename() publishes all-or-nothing (#75a).
        let _ = crate::store::atomic_write(path, json.as_bytes());
    }
}

/// Send a request honoring ONE 429 Retry-After pause. The initial reconcile
/// of a large library issues hundreds of sequential PUTs and can trip the
/// server's per-user rate bucket; sleeping the advertised interval and
/// retrying once paces the WHOLE loop to the server's rate (each send gates
/// the next), so a first sync converges in a single pass instead of leaving
/// 429'd items for later passes. Anything else (non-429, network error)
/// returns unchanged for the caller's own handling.
async fn send_paced(req: reqwest::RequestBuilder) -> Result<reqwest::Response, reqwest::Error> {
    let retry = req.try_clone();
    let resp = req.send().await?;
    if resp.status().as_u16() != 429 {
        return Ok(resp);
    }
    let Some(retry_req) = retry else {
        return Ok(resp);
    };
    let wait = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(2)
        .clamp(1, 30);
    eprintln!("cloud: rate limited; pacing {wait}s before retrying");
    tokio::time::sleep(Duration::from_secs(wait)).await;
    retry_req.send().await
}

#[derive(Deserialize)]
struct PageUploadAck {
    revision: String,
    merged: Option<bool>,
}

impl PageUploadAck {
    fn is_valid_for(&self, local_revision: &str) -> bool {
        if let Some(marker) = self.revision.strip_prefix("ops:") {
            let is_seq = |value: &str| {
                !value.is_empty()
                    && value.bytes().all(|byte| byte.is_ascii_digit())
                    && value.parse::<u64>().is_ok()
            };
            let valid_marker = match marker.split_once('+') {
                Some((ops, snapshot)) => is_seq(ops) && is_seq(snapshot),
                None => is_seq(marker),
            };
            return self.merged.is_some() && valid_marker;
        }
        self.revision == local_revision && self.merged != Some(true)
    }
}

/// Returns true when the page is fully IN SYNC ON DISK after this call —
/// not merely "the PUT landed". A merged push whose pull-back failed used to
/// report success through the pushed-hash proxy, advancing the change-feed
/// cursor past a web edit that never reached the tablet (attack panel H8).
async fn push_page(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
) -> bool {
    let Some((bytes, local_rev)) = state.store.read_page(doc, page) else {
        return true; // no file: nothing to sync
    };
    let key = format!("{doc}/{page}");
    let base = cloud.revisions.get(&key).cloned().unwrap_or_default();
    let last_pushed = cloud.pushed.get(&key).map(String::as_str);
    if should_skip_push(&base, last_pushed, &local_rev) {
        return true; // already in sync (see should_skip_push for the two regimes)
    }
    let url = format!("{}/api/documents/{doc}/pages/{page}/rm", config.url);
    let response = send_paced(
        client
            .put(&url)
            .header("x-device-token", &config.token)
            .header("x-base-revision", &base)
            .header("x-client-id", CLIENT_ID)
            .body(bytes),
    )
    .await;
    match response {
        Ok(r) if r.status().as_u16() == 200 => {
            let ack = match r.json::<PageUploadAck>().await {
                Ok(ack) if ack.is_valid_for(&local_rev) => ack,
                _ => {
                    eprintln!("cloud: invalid acknowledgment for {doc}/{page}; retrying");
                    return false;
                }
            };
            let merged = ack.merged.unwrap_or(false);
            // Keep the old causal base when the server merged peer changes.
            // pull_page adopts the union only after writing it to the tablet.
            if !merged {
                cloud.revisions.insert(key.clone(), ack.revision);
            }
            cloud.pushed.insert(key, local_rev.clone());
            eprintln!("cloud: pushed {doc}/{page}");
            push_assets(state, client, config, cloud, doc, page).await;
            push_thumbnail(state, client, config, cloud, doc, page).await;
            // The server union-merged our bytes with concurrent web edits (or
            // holds web items this tablet never pulled): its stored state is a
            // superset of what we just pushed. Pull it right back so the
            // tablet converges NOW — without this the merged extras only
            // arrive on the next foreign change row, which may never come.
            // No loop: the pull records the pulled content hash in `pushed`,
            // so the write's own change event dedups, and re-pushing the
            // pulled union diffs to zero ops server-side. On a pull failure
            // the remembered revision stays behind, so both the change feed
            // and the sweep keep retrying it.
            if merged {
                eprintln!("cloud: {doc}/{page} was merged server-side; pulling union back");
                // propagate the pull-back's own success — the disk only holds
                // the union if this pull actually wrote it
                return pull_page_inner(
                    state,
                    client,
                    config,
                    cloud,
                    doc,
                    page,
                    PullMode::AfterUpload,
                )
                .await;
            }
            true
        }
        Ok(r) if r.status().as_u16() == 409 => {
            // The legacy relay cannot merge a stale CAS. We may adopt an
            // identical remote revision, but cannot replace an unpushed page
            // or recurse into another PUT using the same stale base.
            pull_page_inner(
                state,
                client,
                config,
                cloud,
                doc,
                page,
                PullMode::AfterUpload,
            )
            .await
        }
        Ok(r) => {
            eprintln!("cloud: push {doc}/{page} failed: HTTP {}", r.status());
            false
        }
        Err(e) => {
            eprintln!("cloud: unreachable ({e})");
            false
        }
    }
}

/// Image pages carry sibling asset files (E26: <doc>/<page>/<file>): the
/// page bytes reference them by filename, so they travel WITH the page.
async fn push_assets(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
) {
    let dir = state.store.xochitl_dir.join(doc).join(page);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return; // no asset dir: nothing to push
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !crate::store::valid_asset_filename(name) {
            continue;
        }
        // mtime dedup: skip an asset whose bytes we already PUT successfully.
        // A failed PUT does NOT record the mtime, so the next reconcile RETRIES
        // it — the independent catch-up that closes the #75b gap.
        let key = format!("{doc}/{page}/{name}");
        let mtime = mtime_ms(&entry.path());
        if let Some(m) = mtime {
            if cloud.assets.get(&key) == Some(&m) {
                continue;
            }
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let url = format!(
            "{}/api/documents/{doc}/pages/{page}/assets/{name}",
            config.url
        );
        match send_paced(
            client
                .put(&url)
                .header("x-device-token", &config.token)
                .body(bytes),
        )
        .await
        {
            Ok(r) if r.status().is_success() => {
                if let Some(m) = mtime {
                    cloud.assets.insert(key, m);
                }
            }
            Ok(r) => eprintln!("cloud: asset push {name} failed: HTTP {}", r.status()),
            Err(e) => eprintln!("cloud: asset push {name} unreachable ({e})"),
        }
    }
}

/// Push xochitl's own rendered page thumbnail (<doc>.thumbnails/<page>.png) so
/// the hosted library shows the same preview the tablet shows. Best-effort:
/// a missing thumbnail (page never opened) is simply skipped.
async fn push_thumbnail(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
) {
    let path = state
        .store
        .xochitl_dir
        .join(format!("{doc}.thumbnails"))
        .join(format!("{page}.png"));
    // Dedup by file mtime so we don't re-push unchanged thumbnails each
    // reconcile. Skip silently if there's no thumbnail yet (page never opened).
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key = format!("{doc}/{page}");
    if cloud.thumbnails.get(&key) == Some(&mtime) {
        return; // already pushed this version
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let url = format!("{}/api/documents/{doc}/pages/{page}/thumbnail", config.url);
    match send_paced(
        client
            .put(&url)
            .header("x-device-token", &config.token)
            .body(bytes),
    )
    .await
    {
        Ok(r) if r.status().is_success() => {
            cloud.thumbnails.insert(key, mtime);
        }
        Ok(r) => eprintln!(
            "cloud: thumbnail push {doc}/{page} failed: HTTP {}",
            r.status()
        ),
        Err(e) => eprintln!("cloud: thumbnail push {doc}/{page} unreachable ({e})"),
    }
}

/// Percent-encode a path segment (template names contain spaces). UTF-8 safe.
fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Outcome of a source push. TooBig means THIS file doesn't fit the free
/// budget (skip it, keep trying smaller/colder ones — an oversized hottest
/// source must never starve everything behind it); QuotaFull means the
/// server itself refused (our budget estimate was stale) — stop the source
/// phase gracefully and re-estimate next reconcile. Never an error loop.
#[derive(PartialEq, Debug)]
enum PushFileOutcome {
    /// Uploaded (or nothing to upload / already deduped / transient failure —
    /// none of which should stop the source phase).
    Done,
    /// Skipped locally: the file is larger than the remaining budget.
    TooBig,
    /// The server refused with a SOURCES-class quota 507: the budget is full.
    QuotaFull,
}

/// Would a file of `size` bytes fit the remaining sources budget?
/// None = unknown/unlimited (always attempt; the 507 stop backstops).
fn fits_sources_budget(size: u64, budget: &Option<u64>) -> bool {
    budget.map_or(true, |rem| size <= rem)
}

/// Free bytes left in the SOURCES budget (limit − usage), from /api/usage.
/// None = unlimited (limit 0) or unknown (old cloud / network error) —
/// pushes are then attempted unconditionally and the 507 stop backstops.
async fn fetch_sources_budget(client: &reqwest::Client, config: &CloudConfig) -> Option<u64> {
    let r = client
        .get(format!("{}/api/usage", config.url))
        .header("x-device-token", &config.token)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.json::<serde_json::Value>().await.ok()?;
    let sources = body.get("sources")?;
    let limit = sources.get("limit").and_then(|v| v.as_u64())?;
    if limit == 0 {
        return None; // explicitly unlimited
    }
    let bytes = sources.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(limit.saturating_sub(bytes))
}

/// The set of source docs the cloud currently has resident (GET /api/sources).
/// `None` on any error — callers keep their push dedup unchanged rather than
/// treating a network blip as "everything was evicted" (which would re-push all
/// sources). (#81)
async fn fetch_resident_sources(
    client: &reqwest::Client,
    config: &CloudConfig,
) -> Option<std::collections::HashSet<String>> {
    let r = client
        .get(format!("{}/api/sources", config.url))
        .header("x-device-token", &config.token)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.json::<serde_json::Value>().await.ok()?;
    let docs = body.get("docs")?.as_array()?;
    Some(
        docs.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
    )
}

/// A sources-class quota refusal: HTTP 507 whose body says class=sources.
/// A capacity 507 (reason=capacity) or a created 507 is NOT one — those
/// affect every write and the created loop already surfaces them. Pure for
/// unit tests.
fn is_sources_quota_full(status: u16, body: &serde_json::Value) -> bool {
    status == 507 && body.get("class").and_then(|v| v.as_str()) == Some("sources")
}

/// Push the document's source PDF (xochitl converts EPUBs to <doc>.pdf), the
/// underlay the editor renders behind the ink. Deduped by mtime; a quota
/// refusal records nothing, so the file retries once budget frees.
async fn push_file(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    budget: &mut Option<u64>,
) -> PushFileOutcome {
    let path = state.store.xochitl_dir.join(format!("{doc}.pdf"));
    let Some(mtime) = mtime_ms(&path) else {
        return PushFileOutcome::Done; // notebooks (no PDF) and unopened EPUBs have none
    };
    if cloud.files.get(doc) == Some(&mtime) {
        return PushFileOutcome::Done;
    }
    // Stat the size BEFORE reading the file into RAM. A big scanned-book PDF can
    // be larger than the tablet's total memory (1-2 GB); slurping it just to
    // discover it doesn't fit OOM-kills the daemon, which Restart=always
    // relaunches straight into reconcile_all -> the same file -> OOM again = a
    // crash loop that stalls ALL sync (#74). Stat is O(1); read only once we
    // KNOW the file both fits the server and fits the budget.
    let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) else {
        return PushFileOutcome::Done;
    };
    // Absolute ceiling, independent of cloud budget: the server rejects any
    // source upload over MAX_SOURCE_BYTES (413), so a larger file can NEVER
    // sync — reading it into RAM would only OOM the daemon for nothing. This is
    // the real crash-loop guard: fits_sources_budget() returns true for an
    // unlimited or unknown (fetch-failed) budget, so without this ceiling a
    // multi-GB PDF on the common free/unmetered cloud would still be slurped
    // whole and OOM. Capping here bounds the read below to <= MAX_SOURCE_BYTES.
    if size > MAX_SOURCE_BYTES {
        eprintln!(
            "cloud: {doc} ({size} B) exceeds the {MAX_SOURCE_BYTES} B server limit — tablet-only"
        );
        return PushFileOutcome::TooBig;
    }
    // Local budget pre-check: an oversized hottest source must NOT starve the
    // colder ones behind it (a 2 GB PDF with 500 MB free would 507 forever and
    // block a fitting 10 MB doc). TooBig skips only THIS file; the loop keeps
    // trying smaller/colder ones.
    if !fits_sources_budget(size, budget) {
        eprintln!("cloud: {doc} ({size} B) exceeds the free source budget — tablet-only for now");
        return PushFileOutcome::TooBig;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return PushFileOutcome::Done;
    };
    let url = format!("{}/api/documents/{doc}/file", config.url);
    match send_paced(
        client
            .put(&url)
            .header("x-device-token", &config.token)
            .header("content-type", "application/pdf")
            .body(bytes),
    )
    .await
    {
        Ok(r) if r.status().is_success() => {
            cloud.files.insert(doc.to_string(), mtime);
            // debit the local estimate so the next file in this pass is judged
            // against the remaining room (server usage lags our own writes)
            if let Some(rem) = budget {
                *rem = rem.saturating_sub(size);
            }
            PushFileOutcome::Done
        }
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.json::<serde_json::Value>().await.unwrap_or_default();
            if is_sources_quota_full(status, &body) {
                // our estimate was stale (another client filled the budget):
                // stop the source phase and re-estimate next reconcile.
                eprintln!("cloud: source budget full — {doc} stays tablet-only");
                *budget = Some(0);
                PushFileOutcome::QuotaFull
            } else {
                eprintln!("cloud: file push {doc} failed: HTTP {status}");
                PushFileOutcome::Done
            }
        }
        Err(e) => {
            eprintln!("cloud: file push {doc} unreachable ({e})");
            PushFileOutcome::Done
        }
    }
}

/// Push page templates (line/grid backgrounds) the notebooks may reference.
/// One file per template name (preferring the JSON DSL, then svg, then png),
/// deduped by mtime. Small firmware assets, pushed once.
async fn push_templates(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
) {
    let Ok(entries) = std::fs::read_dir(&state.templates_dir) else {
        return;
    };
    // best (lowest-priority-number) file per template stem
    let mut best: HashMap<String, (u8, std::path::PathBuf, &'static str)> = HashMap::new();
    for e in entries.flatten() {
        let p = e.path();
        let (Some(stem), Some(ext)) = (
            p.file_stem().and_then(|s| s.to_str()).map(String::from),
            p.extension().and_then(|s| s.to_str()),
        ) else {
            continue;
        };
        let (prio, mime): (u8, &str) = match ext {
            "template" => (0, "application/json"),
            "svg" => (1, "image/svg+xml"),
            "png" => (2, "image/png"),
            _ => continue,
        };
        match best.get(&stem) {
            Some((cur, _, _)) if *cur <= prio => {}
            _ => {
                best.insert(stem, (prio, p, mime));
            }
        }
    }
    for (name, (_, path, mime)) in best {
        let Some(mtime) = mtime_ms(&path) else {
            continue;
        };
        if cloud.templates.get(&name) == Some(&mtime) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let url = format!("{}/api/templates/{}", config.url, pct(&name));
        match send_paced(
            client
                .put(&url)
                .header("x-device-token", &config.token)
                .header("content-type", mime)
                .body(bytes),
        )
        .await
        {
            Ok(r) if r.status().is_success() => {
                cloud.templates.insert(name, mtime);
            }
            Ok(r) => eprintln!("cloud: template push {name} failed: HTTP {}", r.status()),
            Err(e) => eprintln!("cloud: template push {name} unreachable ({e})"),
        }
    }
}

/// Should the reconcile sweep re-pull a page? Yes when the cloud reports a
/// non-empty revision that differs from what the daemon remembers. Pure for
/// unit tests. An empty cloud revision (a blob row that never stored) or a
/// missing entry never pulls; an unknown page (nothing remembered) with real
/// cloud content DOES pull — that's a page the daemon lost track of.
fn needs_pull(remembered: Option<&str>, cloud_rev: &str) -> bool {
    !cloud_rev.is_empty() && remembered != Some(cloud_rev)
}

/// The self-healing pull sweep: fetch every page's CURRENT cloud revision in
/// one call (GET /api/revisions) and re-pull any page whose marker differs
/// from the one we remember. The change feed alone cannot recover a change
/// that was ever consumed-but-skipped (the weft-cal15 class: snapshot-only
/// text edits under the old op-head-only marker) — the cursor is already past
/// it and nothing replays it. This sweep compares ABSOLUTE state, so any such
/// divergence heals on the next reconcile.
///
/// Cost discipline (owner requirement): the request carries If-None-Match
/// with the ETag from the last sweep — an unchanged cloud answers 304 with an
/// EMPTY body, so the steady state is one header-only round trip, not a
/// re-download of every marker. `etag` is process-memory only, deliberately:
/// a daemon restart always does one full sweep (that boot sweep is what heals
/// divergence accumulated while it was down). Old clouds without the route:
/// skipped, the change feed still works.
async fn reconcile_pulls(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    docs: &[crate::store::DocEntry],
    etag: &mut Option<String>,
) {
    let recovery_enabled = cloud.recovery_root.is_some();
    let inventory = read_revisions(client, config, etag.as_deref(), recovery_enabled).await;
    let (fresh_etag, body) = match inventory {
        Some((tag, Some(body))) => (tag, body),
        Some((_, None)) => return, // unchanged
        None if recovery_enabled => {
            // Recovery index limits or faults must not disable the ordinary
            // divergence repair. Do not memoize this fallback for recovery.
            let Some((_, Some(body))) = read_revisions(client, config, None, false).await else {
                return;
            };
            (None, body)
        }
        None => return, // old relay without an inventory: change feed still works
    };
    let Some(pages) = body.get("pages").and_then(|v| v.as_object()) else {
        return;
    };
    let asset_markers = recovery_enabled
        .then(|| body.get("assets").and_then(|v| v.as_object()))
        .flatten();
    let mut all_ok = true;
    let mut capture = Vec::new();
    for doc in docs {
        for page in &doc.pages {
            let key = format!("{}/{}", doc.id, page.id);
            let Some(cloud_rev) = pages.get(&key).and_then(|v| v.as_str()) else {
                continue; // cloud has never seen this page: push-only territory
            };
            let asset_marker = asset_markers.map(|markers| {
                markers
                    .get(&key)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
            });
            if needs_pull(cloud.revisions.get(&key).map(String::as_str), cloud_rev)
                && !pull_page(state, client, config, cloud, &doc.id, &page.id).await
            {
                all_ok = false;
            }
            if needs_recovery(cloud, &key, cloud_rev, asset_marker) {
                capture.push((
                    key,
                    doc.id.as_str(),
                    page.id.as_str(),
                    cloud_rev,
                    asset_marker,
                ));
            }
        }
    }
    capture.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let start = cloud.recovery_after.as_ref().map_or(0, |after| {
        capture.partition_point(|(key, ..)| key <= after) % capture.len().max(1)
    });
    let deadline = tokio::time::Instant::now() + RECOVERY_TIMEOUT;
    cloud.recovery_after = None;
    for (i, (key, doc, page, cloud_rev, asset_marker)) in capture
        .iter()
        .cycle()
        .skip(start)
        .take(capture.len())
        .enumerate()
    {
        if i >= 8 || tokio::time::Instant::now() >= deadline {
            all_ok = false;
            break;
        }
        if !pull_page_inner(
            state,
            client,
            config,
            cloud,
            doc,
            page,
            PullMode::Recovery(deadline),
        )
        .await
            || needs_recovery(cloud, key, cloud_rev, *asset_marker)
        {
            all_ok = false;
        }
        cloud.recovery_after = Some(key.clone());
    }
    if all_ok {
        cloud.recovery_after = None;
    }
    // Commit the validator only after a fully-successful sweep: a partial
    // sweep behind a cached 304 would leave the failed pages unhealed until
    // some unrelated change moved the ETag.
    if all_ok {
        *etag = fresh_etag;
    }
}

async fn read_revisions(
    client: &reqwest::Client,
    config: &CloudConfig,
    etag: Option<&str>,
    capture: bool,
) -> Option<(Option<String>, Option<serde_json::Value>)> {
    let mut req = client
        .get(format!("{}/api/revisions", config.url))
        .header("x-device-token", &config.token);
    if capture {
        req = req.header("x-weft-recovery", "1").timeout(RECOVERY_TIMEOUT);
    }
    if let Some(tag) = etag {
        req = req.header("if-none-match", tag);
    }
    let response = req.send().await.ok()?;
    if response.status().as_u16() == 304 {
        return Some((None, None));
    }
    let response = response.error_for_status().ok()?;
    let tag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body: serde_json::Value = if capture {
        bounded_json(response, RECOVERY_RESPONSE_LIMIT).await?
    } else {
        response.json().await.ok()?
    };
    body.get("pages")?.as_object()?;
    Some((tag, Some(body)))
}

fn needs_recovery(
    cloud: &CloudState,
    key: &str,
    native_rev: &str,
    asset_rev: Option<&str>,
) -> bool {
    asset_rev.is_some_and(|asset| {
        cloud.pulled_asset_revisions.get(key).map(String::as_str) != Some(asset)
            || (cloud.recovery_root.is_some()
                && cloud
                    .protected
                    .get(key)
                    .map(|(rev, assets)| (rev.as_str(), assets.as_str()))
                    != Some((native_rev, asset)))
    })
}

async fn reconcile_current_pulls(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    etag: &mut Option<String>,
) {
    let mut docs = state.store.list_documents();
    let excluded = expand_exclusions(&docs, &cloud.exclusions.iter().cloned().collect());
    docs.retain(|d| !excluded.contains(&d.id));
    reconcile_pulls(state, client, config, cloud, &docs, etag).await;
}

/// Full reconcile: walk every local document/page and push anything the cloud
/// doesn't already have (each push is deduped, so this is cheap once synced).
/// Without this, existing notebooks never reach the cloud because they emit no
/// change event — only edits made after install would sync.
///
/// Push ORDER is the STORAGE-PLAN §4 contract:
///  1. created data first (pages + thumbnails, tens of MB): the library and
///     every page's ink are usable on the web within minutes, before any
///     potentially-huge source transfer starts;
///  2. sources by lastOpened, newest first, until done or the sources budget
///     507s — then STOP the source phase for this pass (quota-full is a
///     steady state: the remaining sources are tablet-only, the newest one
///     retries next reconcile in case budget freed). Never an error loop.
/// Exclusions (when the fetch succeeded) are filtered up front so an excluded
/// doc's bytes never leave the device; None (fetch failed) skips filtering —
/// the server's own 403 backstop still refuses anything truly excluded.
async fn reconcile_all(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    exclusions: Option<&std::collections::HashSet<String>>,
    sweep_etag: &mut Option<String>,
) {
    push_templates(state, client, config, cloud).await;
    let mut docs = state.store.list_documents();
    if let Some(raw) = exclusions {
        if !raw.is_empty() {
            let excluded = expand_exclusions(&docs, raw);
            docs.retain(|d| !excluded.contains(&d.id));
        }
    }
    // phase 1: created data (never goes cold, syncs unconditionally).
    // PUSH FIRST, then the pull sweep: an unpushed local edit must reach the
    // cloud (where applyDevicePut union-merges it) BEFORE any pull, or the
    // pull would overwrite it on disk with the cloud's older state. After the
    // pushes, the sweep re-pulls any page whose cloud revision we don't hold —
    // healing changes the feed cursor skipped (the weft-cal15 class).
    for doc in &docs {
        for page in &doc.pages {
            push_page(state, client, config, cloud, &doc.id, &page.id).await;
            // Push thumbnail AND assets independently: push_page is revision-
            // deduped and returns early once the .rm is in sync, but a thumbnail
            // or an image page's asset may still be missing on the cloud (a
            // transient earlier failure, or the cloud gained the route later).
            // Both self-dedup by mtime, so this retry is cheap once in sync and
            // is the ONLY thing that recovers a dropped asset without a re-edit
            // (#75b).
            push_thumbnail(state, client, config, cloud, &doc.id, &page.id).await;
            push_assets(state, client, config, cloud, &doc.id, &page.id).await;
        }
    }
    // phase 1b: the self-healing pull sweep (see reconcile_pulls). After the
    // pushes so a local unpushed edit is never clobbered by an older cloud
    // state — it has already been union-merged server-side by now.
    reconcile_pulls(state, client, config, cloud, &docs, sweep_etag).await;
    // Re-push sources the cloud EVICTED (#81 LRU). The server drops the coldest
    // resident sources to fit hotter ones; our push dedup (cloud.files) would
    // otherwise never re-push an evicted-but-now-hot doc (it thinks it's synced).
    // Forget the dedup entry for any pushed source the cloud no longer has, so
    // push_file re-attempts it — the server re-admits it if it's now hot enough
    // (evicting a colder one), or 507s it back to tablet-only if it's still cold.
    // On a fetch error we keep the dedup as-is (a blip must not trigger a mass
    // re-push).
    let resident = fetch_resident_sources(client, config).await;
    if let Some(ref res) = resident {
        cloud.files.retain(|doc, _| res.contains(doc));
    }
    // Coldest resident source's recency (min lastOpened among docs the cloud has
    // resident). A candidate HOTTER than this can displace it, so it must be
    // pushed even when the free budget is ~0. None = no residents / unknown ->
    // never force a push (pure free-budget, i.e. the initial-fill regime).
    let coldest_resident_lo: Option<u64> = resident.as_ref().and_then(|res| {
        docs.iter()
            .filter(|d| res.contains(&d.id))
            .map(|d| d.last_opened.unwrap_or(0))
            .min()
    });
    // phase 2: sources, hottest first (lastOpened now includes web opens).
    let order = source_push_order(&docs);
    let mut budget = fetch_sources_budget(client, config).await;
    for id in order {
        let lo = docs
            .iter()
            .find(|d| d.id == id)
            .and_then(|d| d.last_opened)
            .unwrap_or(0);
        // #81 daemon half: if this source is HOTTER than the coldest resident,
        // attempt it even when the free budget is ~0 — hand push_file an
        // unlimited budget so its local fit-gate passes and the SERVER decides
        // (evict a colder resident to make room, or 507 it back to tablet-only).
        // Without this the daemon judged every re-opened source TooBig once the
        // space was full and never sent the PUT that triggers eviction, so the
        // server-side LRU was dead code. A source colder than every resident
        // takes the real `budget` path -> TooBig skip, no wasted upload.
        let hotter_than_coldest = coldest_resident_lo.is_some_and(|c| lo > c);
        let outcome = if hotter_than_coldest {
            let mut unlimited: Option<u64> = None;
            push_file(state, client, config, cloud, id, &mut unlimited).await
        } else {
            push_file(state, client, config, cloud, id, &mut budget).await
        };
        if outcome == PushFileOutcome::QuotaFull {
            eprintln!("cloud: source budget full — remaining sources stay tablet-only this pass");
            break;
        }
    }
}

/// Source push order: non-folder docs by lastOpened descending (never-opened
/// last, ties by id for determinism). Pure for unit tests.
fn source_push_order(docs: &[crate::store::DocEntry]) -> Vec<&str> {
    let mut entries: Vec<&crate::store::DocEntry> =
        docs.iter().filter(|d| d.kind != "folder").collect();
    entries.sort_by(|a, b| {
        b.last_opened
            .unwrap_or(0)
            .cmp(&a.last_opened.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });
    entries.into_iter().map(|d| d.id.as_str()).collect()
}

/// Pull the page's assets BEFORE its bytes so xochitl never sees a .rm
/// referencing a missing resource.
const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;

fn recovery_dir(cloud: &CloudState, doc: &str, page: &str) -> Option<PathBuf> {
    recovery::page_dir(cloud.recovery_root.as_deref()?, doc, page)
}

fn asset_hash(path: &std::path::Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

fn read_asset_hash(path: &std::path::Path) -> Option<Option<String>> {
    match asset_hash(path) {
        Ok(hash) => Some(Some(hash)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

/// Ordinary sync installs missing assets. Recovery verifies the manifest and
/// writes only to its sidecar, never into the live notebook.
async fn pull_asset(
    store: &Store,
    client: &reqwest::Client,
    config: &CloudConfig,
    doc: &str,
    page: &str,
    name: &str,
    expected: Option<&str>,
    sidecar: Option<(&std::path::Path, &mut Vec<String>)>,
    budget: Option<&mut recovery::Budget>,
    deadline: Option<tokio::time::Instant>,
) -> Option<(bool, Option<u64>)> {
    if !crate::store::valid_asset_filename(name) {
        return None;
    }
    let local = store.xochitl_dir.join(doc).join(page).join(name);
    let mut sidecar = sidecar;
    let before = if let Some(hash) = expected {
        let (dir, staged) = sidecar.as_mut()?;
        if recovery::has_asset(dir, hash) {
            return Some((false, None));
        }
        // Live bytes are mutable. Reuse them as a source, never as the only
        // retained copy. Commit the exact verified bytes, not a hard link.
        let mut bytes = Vec::new();
        if std::fs::File::open(&local)
            .and_then(|file| {
                file.take(MAX_ASSET_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
            })
            .is_ok()
            && bytes.len() <= MAX_ASSET_BYTES
            && crate::store::sha256_hex(&bytes) == hash
        {
            staged.push(hash.to_owned());
            recovery::save_asset(dir, hash, &bytes, budget).ok()?;
            return Some((false, None));
        }
        None
    } else {
        let before = read_asset_hash(&local)?;
        if before.is_some() {
            // Ordinary sync retains its original filename-immutable behavior.
            return Some((false, mtime_ms(&local)));
        }
        before
    };
    let url = format!(
        "{}/api/documents/{doc}/pages/{page}/assets/{name}",
        config.url
    );
    let mut request = client.get(url).header("x-device-token", &config.token);
    if let Some(deadline) = deadline {
        request = request.timeout(deadline.checked_duration_since(tokio::time::Instant::now())?);
    }
    let response = request.send().await.ok()?;
    if response.status().as_u16() != 200
        || response
            .content_length()
            .is_some_and(|n| n > MAX_ASSET_BYTES as u64)
    {
        return None;
    }
    let advertised = response
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix('"')?.strip_suffix('"'))
        .filter(|digest| recovery::is_digest(digest))
        .map(String::from);
    let mut body = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = body.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > MAX_ASSET_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let digest = crate::store::sha256_hex(&bytes);
    if expected.is_some_and(|hash| hash != digest)
        || advertised.as_deref().is_some_and(|hash| hash != digest)
    {
        return None;
    }
    if let Some(hash) = expected {
        let (dir, staged) = sidecar?;
        staged.push(hash.to_owned());
        recovery::save_asset(dir, hash, &bytes, budget).ok()?;
        // Never acknowledge a sidecar fetch as a local device asset upload.
        return Some((false, None));
    }
    if read_asset_hash(&local)? != before {
        return None;
    }
    store.write_asset(doc, page, name, &bytes).ok()?;
    Some((true, mtime_ms(&local)))
}

async fn pull_assets(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
    manifest: Option<&[AssetDigest]>,
    mut sidecar: Option<(&std::path::Path, &mut Vec<String>)>,
    changed: &mut Vec<String>,
    deadline: Option<tokio::time::Instant>,
) -> Option<()> {
    let legacy;
    let entries = match manifest {
        Some(assets) => assets,
        None => {
            #[derive(Deserialize)]
            struct Names {
                files: Vec<String>,
            }
            let response = client
                .get(format!(
                    "{}/api/documents/{doc}/pages/{page}/assets",
                    config.url
                ))
                .header("x-device-token", &config.token)
                .send()
                .await
                .ok()?;
            if response.status().as_u16() == 404 {
                // Very old relay with no assets route.
                return Some(());
            }
            legacy = response
                .error_for_status()
                .ok()?
                .json::<Names>()
                .await
                .ok()?
                .files
                .into_iter()
                .filter(|name| crate::store::valid_asset_filename(name))
                .map(|name| AssetDigest {
                    name,
                    sha256: String::new(),
                })
                .collect::<Vec<_>>();
            &legacy
        }
    };
    let mut complete = true;
    for asset in entries {
        if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            return None;
        }
        let digest = (!asset.sha256.is_empty()).then_some(asset.sha256.as_str());
        let key = format!("{doc}/{page}/{}", asset.name);
        let Some((replaced, mtime)) = pull_asset(
            &state.store,
            client,
            config,
            doc,
            page,
            &asset.name,
            digest,
            sidecar.as_mut().map(|(dir, staged)| (*dir, &mut **staged)),
            cloud.recovery_budget.as_mut(),
            deadline,
        )
        .await
        else {
            complete = false;
            continue;
        };
        if let Some(mtime) = mtime.filter(|_| replaced) {
            // Do not echo newly installed ordinary sync assets upstream.
            cloud.assets.insert(key, mtime);
        }
        if replaced {
            changed.push(format!("{doc}/{page}/{}", asset.name));
        }
    }
    complete.then_some(())
}

/// Does the on-disk page hold content the cloud has never seen? True when
/// the local sha differs from the last content we recorded as pushed/pulled.
/// A pull that overwrites such a file DESTROYS the tablet edit (live
/// incident: an edit flushed while the cloud was unreachable, then the
/// recovered link's pull ran before the retry push and clobbered it). Pure
/// for unit tests.
fn has_unpushed_local(local_rev: &str, last_pushed: Option<&str>) -> bool {
    !local_rev.is_empty() && last_pushed != Some(local_rev)
}

/// Pull one page from the cloud onto the tablet. Returns `true` if the change
/// was durably applied OR intentionally skipped (already have the revision, or
/// a concurrent local edit is newer) — i.e. the caller may safely advance its
/// `since` cursor past it. Returns `false` on a transient failure (network,
/// non-200, body read, or local write IO error): the caller must NOT advance
/// the cursor, so the change is re-fetched next tick instead of being silently
/// lost (#73 — web->tablet data loss).
async fn pull_page(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
) -> bool {
    pull_page_inner(state, client, config, cloud, doc, page, PullMode::Reconcile).await
}

const RECOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const RECOVERY_RESPONSE_LIMIT: usize = 16 * 1024 * 1024;

async fn bounded_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
    limit: usize,
) -> Option<T> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

#[derive(Clone, Copy)]
enum PullMode {
    Reconcile,
    AfterUpload,
    Recovery(tokio::time::Instant),
}

async fn pull_page_inner(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
    doc: &str,
    page: &str,
    mode: PullMode,
) -> bool {
    let deadline = if let PullMode::Recovery(deadline) = mode {
        Some(deadline)
    } else {
        None
    };
    let capture = deadline.is_some();
    if !crate::store::safe_id(doc) || !crate::store::safe_id(page) {
        return false;
    }
    let key = format!("{doc}/{page}");
    let dir = capture.then(|| recovery_dir(cloud, doc, page)).flatten();
    // The pre-existing state directory contains recovery-v1/relay.
    let durable_parent = cloud
        .recovery_root
        .as_deref()
        .and_then(|root| Some(root.parent()?.parent()?.to_path_buf()));
    let saved = dir.as_deref().and_then(recovery::load);
    let (local_bytes, local_rev) = state.store.read_page(doc, page).unwrap_or_default();
    if saved.is_some() && cloud.recovery_reclaim_checked.insert(key.clone()) {
        if let (Some(dir), Some(boundary), Some(budget)) = (
            dir.as_deref(),
            durable_parent.as_deref(),
            cloud.recovery_budget.as_mut(),
        ) {
            if let Err(error) = recovery::reclaim_interrupted_page(dir, boundary, budget) {
                eprintln!("cloud: recovery reclaim for {doc}/{page} failed: {error}");
            }
        }
    }
    let verified = saved.as_ref().filter(|saved| {
        saved.head.native_sha256 == local_rev
            && dir
                .as_deref()
                .is_some_and(|dir| recovery::verify_files(dir, saved))
    });
    let url = format!("{}/api/documents/{doc}/pages/{page}/rm", config.url);
    let mut request = client.get(&url).header("x-device-token", &config.token);
    if let Some(deadline) = deadline {
        let Some(timeout) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
            return false;
        };
        request = request.header("x-weft-recovery", "1").timeout(timeout);
        if !local_rev.is_empty() {
            request = request.header("x-weft-native-sha256", &local_rev);
        }
        if let Some(saved) = verified {
            request = request.header("if-none-match", &saved.etag);
        }
    }
    let Ok(r) = request.send().await else {
        return false;
    };
    if r.status().as_u16() == 304 {
        let (Some(saved), Some(dir), Some(boundary)) =
            (verified, dir.as_deref(), durable_parent.as_deref())
        else {
            return false;
        };
        if cloud.revisions.get(&key) != Some(&saved.head.revision)
            || state
                .store
                .read_page(doc, page)
                .as_ref()
                .map(|(_, rev)| rev)
                != Some(&local_rev)
            || !recovery::verify_files(dir, saved)
        {
            return false;
        }
        let marker = (saved.head.revision.clone(), saved.asset_revision.clone());
        if let Err(error) = recovery::certify_checkpoint(dir, boundary) {
            eprintln!("cloud: recovery durability check for {doc}/{page} failed: {error}");
            return false;
        }
        cloud
            .pulled_asset_revisions
            .insert(key.clone(), saved.asset_revision.clone());
        cloud.protected.insert(key, marker);
        return true;
    }
    if r.status().as_u16() != 200 {
        return false;
    }
    let has_recovery = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next() == Some("application/json"));
    if capture != has_recovery {
        return false;
    }
    let (cloud_rev, fetched_rev, bytes, checkpoint, missing_assets) = if has_recovery {
        let Some(etag) = r
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(String::from)
        else {
            return false;
        };
        let Some(payload) = bounded_json::<recovery::Response>(r, RECOVERY_RESPONSE_LIMIT).await
        else {
            return false;
        };
        if !payload.head.valid() {
            return false;
        }
        let bytes = match payload.native_base64 {
            Some(base64) => match base64::engine::general_purpose::STANDARD.decode(base64) {
                Ok(bytes) => bytes,
                Err(_) => return false,
            },
            None if !local_rev.is_empty() && payload.head.native_sha256 == local_rev => local_bytes,
            None => return false,
        };
        if crate::store::sha256_hex(&bytes) != payload.head.native_sha256 {
            return false;
        }
        (
            payload.head.revision.clone(),
            payload.head.native_sha256.clone(),
            bytes,
            Some(Checkpoint {
                version: 1,
                etag,
                asset_revision: payload.asset_revision,
                head: payload.head,
            }),
            !payload.missing_assets.is_empty(),
        )
    } else {
        // Older relay: exact existing native protocol, with separate image
        // GETs and no recovery claim.
        let revision = r
            .headers()
            .get("x-rm-revision")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let Ok(bytes) = r.bytes().await else {
            return false;
        };
        (
            revision,
            crate::store::sha256_hex(&bytes),
            bytes.to_vec(),
            None,
            false,
        )
    };
    let native_changed = fetched_rev != local_rev;
    if let (Some(checkpoint), Some(dir), Some(boundary)) =
        (checkpoint, dir.as_deref(), durable_parent.as_deref())
    {
        // Recovery only protects an accepted native revision. Never write the
        // live page, advance the regular cursor, or acknowledge local assets.
        if native_changed || cloud.revisions.get(&key) != Some(&cloud_rev) || missing_assets {
            return false;
        }
        let mut staged = Vec::new();
        let complete = pull_assets(
            state,
            client,
            config,
            cloud,
            doc,
            page,
            Some(&checkpoint.head.assets),
            Some((dir, &mut staged)),
            &mut Vec::new(),
            deadline,
        )
        .await
        .is_some();
        let still_current = state
            .store
            .read_page(doc, page)
            .is_some_and(|(_, rev)| rev == fetched_rev);
        if complete && still_current {
            let marker = (
                checkpoint.head.revision.clone(),
                checkpoint.asset_revision.clone(),
            );
            match recovery::commit(
                dir,
                boundary,
                checkpoint,
                &bytes,
                cloud.recovery_budget.as_mut(),
            ) {
                Ok(()) => {
                    cloud
                        .pulled_asset_revisions
                        .insert(key.clone(), marker.1.clone());
                    cloud.protected.insert(key, marker);
                    return true;
                }
                Err(e) => eprintln!("cloud: recovery commit for {doc}/{page} failed: {e}"),
            }
        }
        recovery::discard_staged_assets(
            dir,
            saved.as_ref(),
            &staged,
            cloud.recovery_budget.as_mut(),
        );
        return false;
    }
    if capture {
        return false;
    }
    if !native_changed {
        cloud.revisions.insert(key.clone(), cloud_rev);
        cloud.pushed.insert(key, fetched_rev);
        return true;
    }

    // A differing page that the tablet has not pushed cannot be overwritten.
    // Push it using the existing causal base and let the relay merge first.
    if native_changed && has_unpushed_local(&local_rev, cloud.pushed.get(&key).map(String::as_str))
    {
        if matches!(mode, PullMode::AfterUpload) {
            // Both copies stay intact and the caller keeps this change pending.
            // Retrying on the sync scheduler keeps the task stack bounded.
            eprintln!("cloud: {doc}/{page} differs after upload; leaving both copies pending");
            return false;
        }
        eprintln!("cloud: {doc}/{page} has unpushed local edits; pushing before pull");
        return Box::pin(push_page(state, client, config, cloud, doc, page)).await;
    }
    let mut changed = Vec::new();
    let _ = pull_assets(
        state,
        client,
        config,
        cloud,
        doc,
        page,
        None,
        None,
        &mut changed,
        None,
    )
    .await;
    match state.store.write_page(doc, page, &local_rev, &bytes).await {
        Ok(_) => changed.push(format!("{doc}/{page}.rm")),
        Err(WriteError::StaleRevision { current }) => {
            eprintln!(
                "cloud: {doc}/{page} changed locally mid-pull (on-disk {}); will resync",
                &current[..current.len().min(12)]
            );
            return true;
        }
        Err(WriteError::Io(e)) => {
            eprintln!("cloud: local write of {doc}/{page} failed: {e}");
            return false;
        }
    }
    cloud.revisions.insert(key.clone(), cloud_rev);
    cloud.pushed.insert(key, fetched_rev);
    if let Some(conn) = &state.dbus {
        crate::dbus::trigger_reload(conn, doc, &changed).await;
    }

    true
}

async fn pull_changes(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
) {
    let url = format!("{}/api/changes?since={}", config.url, cloud.since);
    let Ok(r) = client
        .get(&url)
        .header("x-device-token", &config.token)
        .send()
        .await
    else {
        return;
    };
    let Ok(body) = r.json::<serde_json::Value>().await else {
        return;
    };
    let Some(changes) = body.get("changes").and_then(|v| v.as_array()) else {
        return;
    };
    // Keep the durable cursor before the earliest failed page. Later pages
    // in this response may still sync, since their acknowledged revisions
    // let a fetched-again row skip the write on the next tick.
    let mut failed_pages = std::collections::HashSet::new();
    for change in changes {
        let seq = change.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
        let doc = change
            .get("doc")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let page = change
            .get("page")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let key = format!("{doc}/{page}");
        if failed_pages.contains(&key) {
            continue;
        }
        let revision = change
            .get("revision")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if cloud.revisions.get(&key).map(String::as_str) == Some(revision)
            || pull_page(state, client, config, cloud, doc, page).await
        {
            if failed_pages.is_empty() {
                cloud.since = cloud.since.max(seq);
            }
        } else {
            eprintln!("cloud: pull of {key} (seq {seq}) failed; leaving cursor to retry");
            failed_pages.insert(key);
        }
    }
}

/// Mirror the document list (names, pages, templates) for the hosted browser.
///
/// This is a whole-list replace (the cloud PUT swaps the stored blob), so it is
/// coarse LWW: a concurrent web edit the daemon hasn't pulled yet within the
/// same window can be overwritten. Accepted under the whole-blob doc-tree LWW
/// (SYNC-ARCHITECTURE §10); the proper fix is the movable-tree CRDT follow-up
/// (per-doc merge / changed-only push). pull runs before push each tick to
/// shrink the window. Docs whose local lastModified is absent serialize without
/// it and are simply excluded from doc-list LWW (never renamed remotely).
async fn push_documents(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    exclusions: Option<&std::collections::HashSet<String>>,
) {
    let mut docs = state.store.list_documents();
    // Selective sync (#54 phase 1): drop excluded docs (and everything under
    // an excluded folder) from the authoritative list push — they vanish
    // from the web library, and the server's own 403 guard backstops any
    // page push a stale daemon still attempts. A failed exclusions fetch
    // (None) skips filtering — a network blip must never make docs vanish.
    //
    // #83: attach a names-only identity sidecar for the filtered docs so the
    // settings UI can label exclusions made before the name-capture fix (and
    // track tablet-side renames of excluded docs). Identity metadata only —
    // no content bytes leave the device for an excluded doc.
    let mut excluded_info: Vec<serde_json::Value> = Vec::new();
    if let Some(raw) = exclusions {
        if !raw.is_empty() {
            let excluded = expand_exclusions(&docs, raw);
            for d in docs.iter().filter(|d| excluded.contains(&d.id)) {
                excluded_info.push(serde_json::json!({
                    "id": d.id, "name": d.name, "type": d.kind, "parent": d.parent,
                }));
            }
            docs.retain(|d| !excluded.contains(&d.id));
        }
    }
    let body = serde_json::json!({ "documents": docs, "excludedInfo": excluded_info });
    // Dedup like every sibling pusher: the list only changes on metadata
    // edits, but this ran on EVERY 15s tick — a full doc-tree PUT each time.
    // Hash the serialized body and skip when nothing moved. In-memory only:
    // a daemon restart re-pushes once (harmless; the server merge is
    // idempotent), which also covers a repointed cloud.
    let payload = body.to_string();
    let digest = crate::store::sha256_hex(payload.as_bytes());
    if LAST_DOC_PUSH
        .lock()
        .expect("doc-push digest lock")
        .as_deref()
        == Some(digest.as_str())
    {
        return;
    }
    let ok = matches!(
        client
            .put(format!("{}/api/documents", config.url))
            .header("x-device-token", &config.token)
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await,
        Ok(r) if r.status().is_success()
    );
    // commit the digest only on success: a failed PUT must retry next tick
    if ok {
        *LAST_DOC_PUSH.lock().expect("doc-push digest lock") = Some(digest);
    }
}

/// Digest of the last doc-list body the server ACCEPTED (see push_documents).
/// Process-lifetime cache, deliberately not persisted: a restart re-pushes
/// once, which is idempotent and covers a repointed cloud.
static LAST_DOC_PUSH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// GET /api/sync-exclusions -> the raw excluded ids, or None on ANY error —
/// callers must treat None as "unknown", never as "empty": an empty set from
/// a network blip would both un-filter the doc-list push and fake a mass
/// re-include (every remembered exclusion would look freshly unticked).
async fn fetch_exclusions(
    client: &reqwest::Client,
    config: &CloudConfig,
) -> Option<std::collections::HashSet<String>> {
    let r = client
        .get(format!("{}/api/sync-exclusions", config.url))
        .header("x-device-token", &config.token)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.json::<serde_json::Value>().await.ok()?;
    Some(
        body.get("docs")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// Expand raw exclusions to cover DESCENDANTS: excluding a folder excludes
/// everything under it, transitively. Pure; cycle-safe (visited set).
fn expand_exclusions(
    docs: &[crate::store::DocEntry],
    raw: &std::collections::HashSet<String>,
) -> std::collections::HashSet<String> {
    let parents: std::collections::HashMap<&str, &str> = docs
        .iter()
        .map(|d| (d.id.as_str(), d.parent.as_str()))
        .collect();
    let mut out = std::collections::HashSet::new();
    for d in docs {
        if raw.contains(&d.id) {
            out.insert(d.id.clone());
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let mut p = d.parent.as_str();
        while !p.is_empty() && p != "trash" && seen.insert(p) {
            if raw.contains(p) {
                out.insert(d.id.clone());
                break;
            }
            p = parents.get(p).copied().unwrap_or("");
        }
    }
    out
}

/// Apply web-stamped registers independently of whole-document recency.
fn apply_stamped_metadata(
    store: &Store,
    cloud: &mut CloudState,
    document: &serde_json::Value,
    id: &str,
    name: &str,
    parent: &str,
) -> (bool, bool) {
    let Some(stamps) = document.get("fieldStamps").and_then(|v| v.as_object()) else {
        return (false, false);
    };
    let name_key = format!("{id}:name");
    let parent_key = format!("{id}:parent");
    let pending = |field: &str, key: &str| {
        stamps
            .get(field)
            .and_then(|stamp| stamp.as_u64())
            .filter(|stamp| *stamp > *cloud.applied_meta.get(key).unwrap_or(&0))
    };
    let name_stamp = pending("name", &name_key);
    let parent_stamp = pending("parent", &parent_key);
    let mut meta_changed = false;
    if name_stamp.is_some() || parent_stamp.is_some() {
        match store.apply_doc_fields_stamped(
            id,
            name_stamp.map(|_| name),
            parent_stamp.map(|_| parent),
        ) {
            Ok(changed) => {
                if let Some(stamp) = name_stamp {
                    cloud.applied_meta.insert(name_key, stamp);
                }
                if let Some(stamp) = parent_stamp {
                    cloud.applied_meta.insert(parent_key, stamp);
                }
                if changed {
                    eprintln!("cloud: applied stamped meta {id}");
                    meta_changed = true;
                }
            }
            Err(error) => eprintln!("cloud: stamped meta {id} deferred: {error}"),
        }
    }

    let mut content_changed = false;
    for (field, value) in stamps {
        let Some(page) = field.strip_prefix("t:") else {
            continue;
        };
        let Some(stamp) = value.as_u64() else {
            continue;
        };
        let key = format!("{id}:t:{page}");
        if stamp <= *cloud.applied_meta.get(&key).unwrap_or(&0) {
            continue;
        }
        let template = document
            .get("pages")
            .and_then(|v| v.as_array())
            .and_then(|pages| {
                pages
                    .iter()
                    .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(page))
            })
            .and_then(|p| p.get("template"))
            .and_then(|v| v.as_str())
            .filter(|template| !template.is_empty());
        let Some(template) = template else { continue };
        match store.apply_page_template(id, page, template, u64::MAX) {
            Ok(changed) => {
                cloud.applied_meta.insert(key, stamp);
                if changed {
                    eprintln!("cloud: applied stamped template {id}/{page} -> {template}");
                    content_changed = true;
                }
            }
            Err(error) => eprintln!("cloud: stamped template {id}/{page} deferred: {error}"),
        }
    }
    (meta_changed, content_changed)
}

/// Apply cloud doc-list edits (web renames/moves) back to the device metadata.
/// Per-doc last-writer-wins by lastModified; rename/move only — never creates
/// or deletes a local doc (delete-by-absence would risk data loss on a partial
/// list). xochitl refreshes its grid from its own metadata watch.
async fn pull_documents(
    state: &AppState,
    client: &reqwest::Client,
    config: &CloudConfig,
    cloud: &mut CloudState,
) {
    let url = format!("{}/api/documents", config.url);
    let Ok(r) = client
        .get(&url)
        .header("x-device-token", &config.token)
        .send()
        .await
    else {
        return;
    };
    let Ok(body) = r.json::<serde_json::Value>().await else {
        return;
    };
    let Some(docs) = body.get("documents").and_then(|v| v.as_array()) else {
        return;
    };
    for d in docs {
        let id = d.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let name = d.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        let parent = d.get("parent").and_then(|v| v.as_str()).unwrap_or("");
        // lastModified may arrive as a JSON number (daemon push) or string (web)
        let lm = d
            .get("lastModified")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0);
        // empty name = almost certainly a malformed record, not an intentional
        // rename to "" — never blank a local doc's title.
        if id.is_empty() || name.is_empty() || lm == 0 {
            continue;
        }
        // A metadata change (rename/move OR a page-template edit below) only
        // reflects on the tablet once xochitl re-reads the doc's .metadata,
        // which it does on a documentFinished signal carrying that path
        // (DEVICE-VERIFIED via the lastOpened work — a bare file write is
        // inert until the reload). Coalesce both applies into ONE reload per
        // doc at the end.
        let mut meta_changed = false;
        // MULTI-TABLET: a sibling device deleted this doc; the cloud carries
        // it as a tombstone (deleted:true). Move OUR copy to xochitl's trash
        // (recoverable, exactly the device's own delete flow) under LWW, and
        // never run the create/meta/template applies for a tombstone.
        if d.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false) {
            if state.store.apply_doc_trash(id, lm) {
                eprintln!("cloud: trashed {id} ({name}) - deleted on a sibling device");
                if let Some(conn) = &state.dbus {
                    crate::dbus::trigger_reload(conn, id, &[format!("{id}.metadata")]).await;
                }
            }
            continue;
        }
        // #54: materialize a doc the WEB created that isn't on the tablet yet.
        // The create endpoint stamps `create: true`; the daemon writes a valid
        // .metadata (+ .content for notebooks) once, then its own next push
        // re-serializes the doc WITHOUT the flag so this never re-fires.
        // create_notebook/create_folder are idempotent (no-op if it exists), so
        // a repeated `create: true` before that push is harmless.
        if d.get("create").and_then(|v| v.as_bool()).unwrap_or(false) {
            // doc "type" is the daemon's own kind field (serde-renamed): the web
            // create endpoint sets it to "folder" or "notebook".
            let kind = d.get("type").and_then(|v| v.as_str()).unwrap_or("notebook");
            let created = if kind == "folder" {
                state.store.create_folder(id, name, parent)
            } else {
                let page = d
                    .pointer("/pages/0/id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let tpl = d
                    .pointer("/pages/0/template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                !page.is_empty() && state.store.create_notebook(id, name, parent, page, tpl)
            };
            if created {
                eprintln!("cloud: created {kind} {id} ({name})");
                meta_changed = true;
            }
        }
        if state.store.apply_doc_meta(id, name, parent, lm) {
            eprintln!("cloud: applied doc meta {id} ({name})");
            meta_changed = true;
        }
        // Page templates (#60/C): the web picker PATCHes them into the cloud
        // doc list; apply device-ward under the same per-doc LWW. Empty =
        // untouched (the daemon's own pushes omit template for Blank pages).
        let mut content_changed = false;
        if let Some(pages) = d.get("pages").and_then(|v| v.as_array()) {
            for p in pages {
                let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let tpl = p
                    .get("template")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if pid.is_empty() || tpl.is_empty() {
                    continue;
                }
                // A stamped template follows its own acknowledgment path.
                let stamp = format!("t:{pid}");
                if d.get("fieldStamps")
                    .and_then(|stamps| stamps.get(&stamp))
                    .and_then(|stamp| stamp.as_u64())
                    .is_some_and(|stamp| stamp > 0)
                {
                    continue;
                }
                if matches!(state.store.apply_page_template(id, pid, tpl, lm), Ok(true)) {
                    eprintln!("cloud: applied page template {id}/{pid} -> {tpl}");
                    content_changed = true;
                }
            }
        }
        let (stamped_meta, stamped_content) =
            apply_stamped_metadata(&state.store, cloud, d, id, name, parent);
        meta_changed |= stamped_meta;
        content_changed |= stamped_content;
        if meta_changed || content_changed {
            if let Some(conn) = &state.dbus {
                // templates live in .content: naming only .metadata left a
                // web-side template pick inert until the doc was reopened
                let mut files = vec![format!("{id}.metadata")];
                if content_changed {
                    files.push(format!("{id}.content"));
                }
                crate::dbus::trigger_reload(conn, id, &files).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAMP_DOC: &str = "11111111-1111-4111-a111-111111111111";
    const STAMP_PAGE: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

    fn stamped_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(format!("{STAMP_DOC}.metadata")),
            br#"{"visibleName":"Original","parent":"","lastModified":"9000","version":3}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join(format!("{STAMP_DOC}.content")),
            serde_json::to_vec(&serde_json::json!({
                "cPages": {"pages": [{"id": STAMP_PAGE, "template": {"value": "Blank"}}]}
            }))
            .unwrap(),
        )
        .unwrap();
        let store = Store::new(dir.path().into());
        (dir, store)
    }

    #[test]
    fn stamped_metadata_retries_failed_publications_and_completes_equal_content() {
        let (dir, store) = stamped_store();
        let marker_temp = dir.path().join(format!(".weft-tmp-{STAMP_DOC}.metadata"));
        std::fs::create_dir(&marker_temp).unwrap();
        let document = serde_json::json!({
            "pages": [{"id": STAMP_PAGE, "template": "Grid"}],
            "fieldStamps": {"name": 1, "parent": 2, (format!("t:{STAMP_PAGE}")): 3}
        });
        let mut cloud = CloudState::default();
        let apply = |cloud: &mut CloudState| {
            apply_stamped_metadata(&store, cloud, &document, STAMP_DOC, "Title", "folder")
        };
        assert_eq!(apply(&mut cloud), (false, false));
        assert!(cloud.applied_meta.is_empty());
        let content = dir.path().join(format!("{STAMP_DOC}.content"));
        assert!(std::fs::read_to_string(&content).unwrap().contains("Grid"));

        std::fs::remove_dir(marker_temp).unwrap();
        assert_eq!(apply(&mut cloud), (true, true));
        assert_eq!(cloud.applied_meta[&format!("{STAMP_DOC}:name")], 1);
        assert_eq!(cloud.applied_meta[&format!("{STAMP_DOC}:parent")], 2);
        assert_eq!(
            cloud.applied_meta[&format!("{STAMP_DOC}:t:{STAMP_PAGE}")],
            3
        );
        let metadata = dir.path().join(format!("{STAMP_DOC}.metadata"));
        let published = std::fs::read(&metadata).unwrap();
        let fields: serde_json::Value = serde_json::from_slice(&published).unwrap();
        assert_eq!(fields["visibleName"], "Title");
        assert_eq!(fields["parent"], "folder");
        assert_eq!(fields["version"], 5);
        assert_eq!(fields["lastModified"], "9000");
        assert_eq!(apply(&mut cloud), (false, false));
        assert_eq!(std::fs::read(metadata).unwrap(), published);
    }

    #[test]
    fn successful_no_change_acknowledges_a_stamp_without_mutation() {
        let (dir, store) = stamped_store();
        let metadata = dir.path().join(format!("{STAMP_DOC}.metadata"));
        let before = std::fs::read(&metadata).unwrap();
        let document = serde_json::json!({"fieldStamps": {"name": 4, "parent": 5}});
        let mut cloud = CloudState::default();
        assert_eq!(
            apply_stamped_metadata(&store, &mut cloud, &document, STAMP_DOC, "Original", ""),
            (false, false)
        );
        assert_eq!(cloud.applied_meta[&format!("{STAMP_DOC}:name")], 4);
        assert_eq!(cloud.applied_meta[&format!("{STAMP_DOC}:parent")], 5);
        assert_eq!(std::fs::read(metadata).unwrap(), before);
    }

    #[tokio::test]
    async fn divergent_legacy_page_stays_pending_after_one_conflicted_upload() {
        use axum::{http::StatusCode, routing::put, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let gets = Arc::new(AtomicUsize::new(0));
        let puts = Arc::new(AtomicUsize::new(0));
        let get_count = gets.clone();
        let put_count = puts.clone();
        let local = b"synthetic local";
        let remote = b"synthetic remote";
        let remote_rev = crate::store::sha256_hex(remote);
        let local_rev = crate::store::sha256_hex(local);
        let remote_revision = remote_rev.clone();
        let converged_revision = local_rev.clone();
        let relay = Router::new().route(
            "/api/documents/{doc}/pages/{page}/rm",
            put(move || {
                put_count.fetch_add(1, Ordering::Relaxed);
                async { StatusCode::CONFLICT }
            })
            .get(move || {
                let attempt = get_count.fetch_add(1, Ordering::Relaxed);
                let (bytes, revision) = if attempt == 0 {
                    (remote.as_slice(), remote_revision.clone())
                } else {
                    (local.as_slice(), converged_revision.clone())
                };
                async move {
                    (
                        [
                            ("content-type", "application/octet-stream".to_owned()),
                            ("x-rm-revision", revision),
                        ],
                        bytes,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = CloudConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: String::new(),
        };
        let server = tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let doc = "11111111-1111-4111-a111-111111111111";
        let page = "22222222-2222-4222-a222-222222222222";
        std::fs::create_dir(dir.path().join(doc)).unwrap();
        let disk = dir.path().join(doc).join(format!("{page}.rm"));
        std::fs::write(&disk, local).unwrap();
        let state = AppState {
            store: Store::new(dir.path().to_path_buf()),
            dbus: None,
            events: tokio::sync::broadcast::channel(1).0,
            firmware: String::new(),
            model: String::new(),
            templates_dir: dir.path().to_path_buf(),
        };
        let client = reqwest::Client::new();
        let mut cloud = CloudState::default();
        let key = format!("{doc}/{page}");

        assert!(!push_page(&state, &client, &config, &mut cloud, doc, page).await);
        assert_eq!(puts.load(Ordering::Relaxed), 1);
        assert_eq!(gets.load(Ordering::Relaxed), 1);
        assert_eq!(std::fs::read(&disk).unwrap(), local);
        assert!(!cloud.revisions.contains_key(&key));
        assert!(!cloud.pushed.contains_key(&key));

        // A scheduled retry may acknowledge identical bytes without writing the file.
        assert!(push_page(&state, &client, &config, &mut cloud, doc, page).await);
        assert_eq!(puts.load(Ordering::Relaxed), 2);
        assert_eq!(gets.load(Ordering::Relaxed), 2);
        assert_eq!(cloud.revisions[&key], local_rev);
        assert_eq!(cloud.pushed[&key], local_rev);
        assert_eq!(std::fs::read(&disk).unwrap(), local);
        server.abort();
    }

    #[tokio::test]
    async fn missing_acknowledgment_leaves_page_pending_for_a_retry() {
        use axum::{extract::Request, response::IntoResponse, routing::put, Router};
        use std::sync::{Arc, Mutex};

        let captures = Arc::new(Mutex::new(Vec::new()));
        let uploads = captures.clone();
        let relay = Router::new().route(
            "/api/documents/{doc}/pages/{page}/rm",
            put(move |request: Request| {
                let uploads = uploads.clone();
                async move {
                    let base = request.headers()["x-base-revision"]
                        .to_str()
                        .unwrap()
                        .to_owned();
                    let body = axum::body::to_bytes(request.into_body(), 1024)
                        .await
                        .unwrap();
                    let mut received = uploads.lock().unwrap();
                    received.push((base, body.to_vec()));
                    if received.len() == 1 {
                        return r#"{"revision":"#.into_response();
                    }
                    axum::Json(serde_json::json!({ "revision": "ops:3+4", "merged": false }))
                        .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = CloudConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: String::new(),
        };
        let server = tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let doc = "11111111-1111-4111-a111-111111111111";
        let page = "22222222-2222-4222-a222-222222222222";
        std::fs::create_dir(dir.path().join(doc)).unwrap();
        let bytes = b"local drawing data";
        std::fs::write(dir.path().join(doc).join(format!("{page}.rm")), bytes).unwrap();
        let state = AppState {
            store: Store::new(dir.path().to_path_buf()),
            dbus: None,
            events: tokio::sync::broadcast::channel(1).0,
            firmware: String::new(),
            model: String::new(),
            templates_dir: dir.path().to_path_buf(),
        };
        let client = reqwest::Client::new();
        let mut cloud = CloudState::default();
        let key = format!("{doc}/{page}");
        cloud.revisions.insert(key.clone(), "ops:1+2".into());
        assert!(!push_page(&state, &client, &config, &mut cloud, doc, page).await);
        assert_eq!(cloud.revisions[&key], "ops:1+2");
        assert!(!cloud.pushed.contains_key(&key));
        assert!(push_page(&state, &client, &config, &mut cloud, doc, page).await);
        assert_eq!(cloud.revisions[&key], "ops:3+4");
        assert!(cloud.pushed.contains_key(&key));
        assert_eq!(
            *captures.lock().unwrap(),
            vec![("ops:1+2".into(), bytes.to_vec()); 2]
        );
        server.abort();
    }

    #[tokio::test]
    async fn failed_feed_page_does_not_block_an_unrelated_page_or_advance_the_cursor() {
        use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        };

        let doc = "11111111-1111-4111-a111-111111111111";
        let first = "22222222-2222-4222-a222-222222222222";
        let second = "33333333-3333-4333-a333-333333333333";
        let first_requests = Arc::new(AtomicUsize::new(0));
        let second_requests = Arc::new(AtomicUsize::new(0));
        let fail_first = Arc::new(AtomicBool::new(true));
        let first_hits = first_requests.clone();
        let second_hits = second_requests.clone();
        let fail = fail_first.clone();
        let relay = Router::new()
            .route(
                "/api/changes",
                get(move || async move {
                    axum::Json(serde_json::json!({ "changes": [
                    { "seq": 1, "doc": doc, "page": first, "revision": "ops:1+1" },
                    { "seq": 2, "doc": doc, "page": first, "revision": "ops:1+1" },
                    { "seq": 3, "doc": doc, "page": second, "revision": "ops:2+2" }
                ] }))
                }),
            )
            .route(
                &format!("/api/documents/{doc}/pages/{first}/rm"),
                get(move || {
                    let fail = fail.clone();
                    let hits = first_hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::Relaxed);
                        if fail.load(Ordering::Relaxed) {
                            return StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        ([("x-rm-revision", "ops:1+1")], "first drawing").into_response()
                    }
                }),
            )
            .route(
                &format!("/api/documents/{doc}/pages/{second}/rm"),
                get(move || {
                    let requests = second_hits.clone();
                    async move {
                        requests.fetch_add(1, Ordering::Relaxed);
                        ([("x-rm-revision", "ops:2+2")], "second drawing")
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = CloudConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: String::new(),
        };
        let server = tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            store: Store::new(dir.path().to_path_buf()),
            dbus: None,
            events: tokio::sync::broadcast::channel(1).0,
            firmware: String::new(),
            model: String::new(),
            templates_dir: dir.path().to_path_buf(),
        };
        let client = reqwest::Client::new();
        let mut cloud = CloudState::default();

        pull_changes(&state, &client, &config, &mut cloud).await;
        assert!(state.store.read_page(doc, first).is_none());
        assert_eq!(
            state
                .store
                .read_page(doc, second)
                .expect("later page must sync")
                .0,
            b"second drawing"
        );
        assert_eq!(cloud.since, 0);
        assert_eq!(first_requests.load(Ordering::Relaxed), 1);

        fail_first.store(false, Ordering::Relaxed);
        pull_changes(&state, &client, &config, &mut cloud).await;
        assert_eq!(
            state.store.read_page(doc, first).unwrap().0,
            b"first drawing"
        );
        assert_eq!(cloud.since, 3);
        assert_eq!(first_requests.load(Ordering::Relaxed), 2);
        assert_eq!(second_requests.load(Ordering::Relaxed), 1);
        server.abort();
    }

    #[tokio::test]
    async fn recovery_sweep_keeps_same_name_assets_in_sidecar_and_never_changes_local_bytes() {
        use axum::{
            http::{HeaderMap, StatusCode},
            response::IntoResponse,
            routing::get,
            Router,
        };
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let native = b"native page already on tablet";
        let native_sha = crate::store::sha256_hex(native);
        let old = b"first image";
        let new = b"replacement image";
        let fname = "resource.png";
        let variant = Arc::new(AtomicUsize::new(1));
        let stale_asset = Arc::new(AtomicBool::new(false));
        let revision_variant = variant.clone();
        let page_variant = variant.clone();
        let asset_variant = variant.clone();
        let asset_stale = stale_asset.clone();
        let advertised_native = native_sha.clone();
        let page_hits = Arc::new(AtomicUsize::new(0));
        let pages_seen = page_hits.clone();
        let page_not_modified = Arc::new(AtomicUsize::new(0));
        let page_not_modified_seen = page_not_modified.clone();
        let key = format!("{STAMP_DOC}/{STAMP_PAGE}");
        let revision_key = key.clone();
        let relay = Router::new()
            .route("/api/changes", get(|| async {
                axum::Json(serde_json::json!({ "changes": [{
                    "seq": 10, "doc": STAMP_DOC, "page": STAMP_PAGE, "revision": "ops:3+5"
                }] }))
            }))
            .route("/api/revisions", get(move |headers: HeaderMap| {
                let v = revision_variant.load(Ordering::Relaxed);
                let tag = format!(r#""inventory-{v}""#);
                let key = revision_key.clone();
                async move {
                    assert_eq!(headers["x-weft-recovery"], "1");
                    if headers.get("if-none-match").is_some_and(|h| h == &tag) {
                        return (StatusCode::NOT_MODIFIED, "").into_response();
                    }
                    ([("etag", tag)], axum::Json(serde_json::json!({
                        "pages": { (&key): "ops:3+4" },
                        "assets": { (&key): format!("assets-{v}") },
                    }))).into_response()
                }
            }))
            .route("/api/documents/{doc}/pages/{page}/rm", get(move |headers: HeaderMap| {
                let v = page_variant.load(Ordering::Relaxed);
                let sha = advertised_native.clone();
                let page_not_modified_seen = page_not_modified_seen.clone();
                pages_seen.fetch_add(1, Ordering::Relaxed);
                async move {
                    if !headers.contains_key("x-weft-recovery") {
                        return ([("x-rm-revision", "ops:3+5")], native.as_slice()).into_response();
                    }
                    assert_eq!(headers["x-weft-recovery"], "1");
                    assert_eq!(headers["x-weft-native-sha256"].to_str().unwrap(), sha);
                    let digest = crate::store::sha256_hex(if v == 1 { old } else { new });
                    let tag = format!(r#""checkpoint-{v}""#);
                    if headers.get("if-none-match").is_some_and(|h| h == &tag) {
                        page_not_modified_seen.fetch_add(1, Ordering::Relaxed);
                        return (StatusCode::NOT_MODIFIED, "").into_response();
                    }
                    ([("etag", tag)], axum::Json(serde_json::json!({
                        "revision": if v == 3 { "ops:3+5" } else { "ops:3+4" },
                        "snapshotSeq": if v == 3 { 5 } else { 4 }, "opSeq": 3,
                        "nativeSha256": sha, "nativeBase64": null,
                        "overlay": {"shapes": [{"props":{"weftArrowLinks":[{"toId":"shape:target"}]}}]},
                        "assetRevision": format!("assets-{v}"),
                        "assets": [{"name": fname, "sha256": digest}],
                        "missingAssets": if v == 3 { vec!["missing.png"] } else { vec![] },
                    }))).into_response()
                }
            }))
            .route("/api/documents/{doc}/pages/{page}/assets", get(move || async move {
                axum::Json(serde_json::json!({"files": [fname]}))
            }))
            .route("/api/documents/{doc}/pages/{page}/assets/{name}", get(move || {
                let v = asset_variant.load(Ordering::Relaxed);
                let stale = asset_stale.load(Ordering::Relaxed);
                async move {
                    let bytes: &[u8] = if v == 1 || stale { old } else { new };
                    let hash = crate::store::sha256_hex(bytes);
                    ([("etag", format!(r#""{hash}""#))], bytes)
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = CloudConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: "test-device".into(),
        };
        let server = tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
        let disk = tempfile::tempdir().unwrap();
        let state = AppState {
            store: Store::new(disk.path().to_path_buf()),
            dbus: None,
            events: tokio::sync::broadcast::channel(1).0,
            firmware: String::new(),
            model: String::new(),
            templates_dir: disk.path().to_path_buf(),
        };
        assert!(state
            .store
            .create_notebook(STAMP_DOC, "Recovery", "", STAMP_PAGE, ""));
        state
            .store
            .write_page(STAMP_DOC, STAMP_PAGE, "", native)
            .await
            .unwrap();
        let root = disk.path().join("recovery").join(cloud_identity(&config));
        let path = recovery::page_dir(&root, STAMP_DOC, STAMP_PAGE).unwrap();
        let native_asset = disk.path().join(STAMP_DOC).join(STAMP_PAGE).join(fname);
        let client = reqwest::Client::new();
        let mut cloud = CloudState {
            recovery_budget: Some(recovery::Budget::open(root.parent().unwrap()).unwrap()),
            recovery_root: Some(root),
            revisions: [(key.clone(), "ops:3+4".into())].into(),
            ..CloudState::default()
        };
        let docs = state.store.list_documents();
        // First backfill must capture the relay bytes without modifying or
        // acknowledging an unsent same-name local resource.
        state
            .store
            .write_asset(STAMP_DOC, STAMP_PAGE, fname, b"unsent local")
            .unwrap();
        let mut etag = None;
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        let fallback = path.join(format!("{}.asset", crate::store::sha256_hex(old)));
        assert_eq!(std::fs::read(&fallback).unwrap(), old);
        let protected = recovery::load(&path).unwrap();
        assert_eq!(protected.etag, "\"checkpoint-1\"");
        assert_eq!(
            protected.head.overlay["shapes"][0]["props"]["weftArrowLinks"][0]["toId"],
            "shape:target"
        );
        assert_eq!(
            std::fs::read(path.join(format!("{native_sha}.rm"))).unwrap(),
            native
        );
        assert_eq!(std::fs::read(&native_asset).unwrap(), b"unsent local");
        assert!(!cloud.assets.contains_key(&format!("{key}/{fname}")));

        // No new page fetch when only the sweep request revalidates.
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(page_hits.load(Ordering::Relaxed), 1);

        // Valid JSON can silently lose overlay data without affecting the
        // native/asset hashes or stored validator. Simulate a restart and
        // prove that the exact manifest checksum forces a full refetch.
        let manifest_path = path.join("checkpoint.json");
        let original = std::fs::read_to_string(&manifest_path).unwrap();
        let corrupt = original.replace("shape:target", "shape:changed");
        assert_ne!(original, corrupt);
        let parsed = serde_json::from_str::<serde_json::Value>(&corrupt).unwrap();
        assert_eq!(parsed["etag"], "\"checkpoint-1\"");
        std::fs::write(&manifest_path, corrupt).unwrap();
        assert!(recovery::load(&path).is_none());
        // Reuse matching live bytes as a source but retain an independent
        // copy, so deleting or editing that live file cannot break restore.
        std::fs::remove_file(&fallback).unwrap();
        state
            .store
            .write_asset(STAMP_DOC, STAMP_PAGE, fname, old)
            .unwrap();
        cloud.protected.clear();
        cloud.pulled_asset_revisions.clear();
        etag = None;
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(page_hits.load(Ordering::Relaxed), 2);
        assert_eq!(std::fs::read_to_string(&manifest_path).unwrap(), original);
        state
            .store
            .write_asset(STAMP_DOC, STAMP_PAGE, fname, b"another local edit")
            .unwrap();
        assert_eq!(std::fs::read(&fallback).unwrap(), old);
        assert!(recovery::verify_files(
            &path,
            &recovery::load(&path).unwrap()
        ));
        std::fs::remove_file(&native_asset).unwrap();
        assert!(recovery::verify_files(
            &path,
            &recovery::load(&path).unwrap()
        ));

        // Simulate recovery storage loss across a restart. A stale ETag cannot
        // mask a missing asset or a base file with the correct name but bad bytes.
        std::fs::write(&fallback, b"corrupt").unwrap();
        std::fs::write(path.join(format!("{native_sha}.rm")), b"corrupt").unwrap();
        cloud.protected.clear();
        cloud.pulled_asset_revisions.clear();
        etag = None;
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(page_hits.load(Ordering::Relaxed), 3);
        assert!(!native_asset.exists());
        assert_eq!(std::fs::read(&fallback).unwrap(), old);
        assert_eq!(
            std::fs::read(path.join(format!("{native_sha}.rm"))).unwrap(),
            native
        );
        assert_eq!(cloud.protected[&key].0, "ops:3+4");

        // Same native and semantic revisions, but independently changed asset.
        variant.store(2, Ordering::Relaxed);
        stale_asset.store(true, Ordering::Relaxed);
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert!(!native_asset.exists());
        assert_eq!(std::fs::read(&fallback).unwrap(), old);
        assert_eq!(recovery::load(&path).unwrap().etag, "\"checkpoint-1\"");

        // Fail manifest commit after staging the replacement. The old
        // manifest still reads its original verified sidecar blob.
        stale_asset.store(false, Ordering::Relaxed);
        let blocked = path.join(".weft-tmp-checkpoint.json");
        std::fs::create_dir(&blocked).unwrap();
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert!(!native_asset.exists());
        assert_eq!(recovery::load(&path).unwrap().etag, "\"checkpoint-1\"");
        assert_eq!(std::fs::read(&fallback).unwrap(), old);

        let new_sidecar = path.join(format!("{}.asset", crate::store::sha256_hex(new)));
        assert!(
            !new_sidecar.exists(),
            "failed capture must retire its new budget charge"
        );

        std::fs::remove_dir(blocked).unwrap();
        // Fail after the new manifest is visible, but before its directory
        // entry is confirmed durable. Until repair, only generation 1 is protected.
        recovery::fail_next_directory_sync(&path);
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(recovery::load(&path).unwrap().etag, "\"checkpoint-2\"");
        assert_eq!(cloud.protected[&key].1, "assets-1");
        assert_eq!(cloud.pulled_asset_revisions[&key], "assets-1");
        assert!(fallback.exists());
        let not_modified_before = page_not_modified.load(Ordering::Relaxed);
        // A real 304 must not acknowledge the renamed manifest if the
        // repairing fsync also fails. On the next 304 repair and acknowledge.
        recovery::fail_next_directory_sync(&path);
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(
            page_not_modified.load(Ordering::Relaxed),
            not_modified_before + 1
        );
        assert_eq!(cloud.protected[&key].1, "assets-1");
        assert_eq!(cloud.pulled_asset_revisions[&key], "assets-1");
        reconcile_pulls(&state, &client, &config, &mut cloud, &docs, &mut etag).await;
        assert_eq!(
            page_not_modified.load(Ordering::Relaxed),
            not_modified_before + 2
        );
        assert_eq!(cloud.protected[&key].1, "assets-2");
        assert_eq!(cloud.pulled_asset_revisions[&key], "assets-2");
        let replacement = path.join(format!("{}.asset", crate::store::sha256_hex(new)));
        assert_eq!(std::fs::read(replacement).unwrap(), new);
        assert!(!native_asset.exists());
        assert_eq!(
            state.store.read_page(STAMP_DOC, STAMP_PAGE).unwrap().0,
            native
        );
        // A snapshot with a permanently missing dependency is not protected,
        // but it must not strand the device's native change-feed cursor.
        variant.store(3, Ordering::Relaxed);
        pull_changes(&state, &client, &config, &mut cloud).await;
        assert_eq!(cloud.since, 10);
        assert_eq!(cloud.revisions[&key], "ops:3+5");
        assert_eq!(recovery::load(&path).unwrap().head.revision, "ops:3+4");
        assert_eq!(cloud.protected[&key].0, "ops:3+4");

        assert!(!cloud.assets.contains_key(&format!("{key}/{fname}")));
        // Ordinary sync still downloads a missing resource and acknowledges
        // only that live install; it does not replace a present filename.
        let mut changed = Vec::new();
        pull_assets(
            &state,
            &client,
            &config,
            &mut cloud,
            STAMP_DOC,
            STAMP_PAGE,
            None,
            None,
            &mut changed,
            None,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&native_asset).unwrap(), new);
        assert_eq!(changed.len(), 1);
        let ack = cloud.assets[&format!("{key}/{fname}")];
        state
            .store
            .write_asset(STAMP_DOC, STAMP_PAGE, fname, b"dirty")
            .unwrap();
        changed.clear();
        pull_assets(
            &state,
            &client,
            &config,
            &mut cloud,
            STAMP_DOC,
            STAMP_PAGE,
            None,
            None,
            &mut changed,
            None,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&native_asset).unwrap(), b"dirty");
        assert!(changed.is_empty());
        assert_eq!(cloud.assets[&format!("{key}/{fname}")], ack);
        server.abort();
    }

    // F5: op-mode dedup. The cloud's op-mode revision is "ops:N", never a
    // content sha, so the daemon must dedup by the content hash it last pushed.

    #[test]
    fn op_mode_skips_when_content_unchanged() {
        // base is an op-head marker; we already pushed this exact content hash.
        assert!(should_skip_push("ops:7", Some("abc123"), "abc123"));
    }

    #[test]
    fn op_mode_pushes_when_content_changed() {
        // the tablet edited the file: on-disk sha differs from last-pushed.
        assert!(!should_skip_push("ops:7", Some("abc123"), "def456"));
    }

    #[test]
    fn op_mode_pushes_when_never_pushed() {
        // op-mode page we've never pushed (no recorded content hash) -> push.
        assert!(!should_skip_push("ops:1", None, "abc123"));
    }

    #[test]
    fn op_mode_marker_never_equals_content_sha_so_blob_check_would_loop() {
        // Regression guard: the OLD dedup compared base==local_rev. An op-head
        // marker never equals a sha, so that check ALWAYS re-pushes. Prove the
        // old predicate would loop while the new one settles on unchanged bytes.
        let base = "ops:42";
        let local = "0000000000000000000000000000000000000000000000000000000000000000";
        assert_ne!(base, local); // old check: never skips -> re-PUT every tick
        assert!(should_skip_push(base, Some(local), local)); // new check: skips
    }

    #[test]
    fn blob_mode_skips_when_revision_matches_content() {
        // legacy blob page: cloud revision IS the content sha (unchanged path).
        assert!(should_skip_push("abc123", None, "abc123"));
        // last_pushed is ignored in blob mode.
        assert!(should_skip_push("abc123", Some("stale"), "abc123"));
    }

    #[test]
    fn blob_mode_pushes_when_revision_differs() {
        assert!(!should_skip_push("abc123", None, "def456"));
    }

    #[test]
    fn empty_base_always_pushes_first_time() {
        // a page we've never synced: base is "", so it can't equal any real sha.
        assert!(!should_skip_push("", None, "abc123"));
        assert!(!is_op_mode(""));
    }

    #[test]
    fn pulled_op_mode_page_is_not_repushed() {
        // Models the pull->push seam (F5, finding 1). After pull_page writes a
        // web-authored op-mode page, it records BOTH the opaque cloud revision
        // ("ops:N") in `revisions` and the CONTENT hash of the bytes it wrote in
        // `pushed`. The immediate push trigger (the write's own page.changed
        // event, or reconcile_all) then reads back the same on-disk bytes, so
        // local_rev == pushed[key], and should_skip_push must be true — no
        // re-PUT of a file we just received.
        let mut cloud = CloudState::default();
        let key = "doc/page".to_string();
        // sha256 of the reconstructed .rm the daemon just wrote to disk.
        let written_rev = "a".repeat(64);
        // pull_page records these two on a successful write_page:
        cloud.revisions.insert(key.clone(), "ops:5".to_string()); // opaque op-head
        cloud.pushed.insert(key.clone(), written_rev.clone()); // content hash

        // Next push: read_page returns the same content hash for the unchanged
        // file. should_skip_push must skip (op-mode: last_pushed == local_rev).
        let base = cloud.revisions.get(&key).unwrap();
        let last_pushed = cloud.pushed.get(&key).map(String::as_str);
        let local_rev = &written_rev; // file unchanged since the pull
        assert!(
            should_skip_push(base, last_pushed, local_rev),
            "a just-pulled op-mode page must not be re-PUT",
        );

        // Regression guard: if pull_page had NOT recorded the content hash
        // (the bug), pushed[key] would be absent and the push would fire.
        cloud.pushed.remove(&key);
        let last_pushed_missing = cloud.pushed.get(&key).map(String::as_str);
        assert!(
            !should_skip_push(base, last_pushed_missing, local_rev),
            "without the recorded hash the daemon would spuriously re-PUT",
        );
    }

    #[test]
    fn is_op_mode_only_for_ops_marker() {
        assert!(is_op_mode("ops:0"));
        assert!(is_op_mode("ops:12345"));
        // the snapshot-aware marker (ops:<opSeq>+<snapSeq>) is still op-mode
        assert!(is_op_mode("ops:0+7"));
        assert!(!is_op_mode(""));
        assert!(!is_op_mode("deadbeef"));
    }

    // The reconcile sweep's pull decision (weft-cal15 healing): absolute
    // cloud-state compare, independent of the change feed cursor.

    #[test]
    fn sweep_pulls_when_cloud_marker_differs() {
        assert!(needs_pull(Some("ops:0+1"), "ops:0+3"));
        assert!(needs_pull(Some("ops:2+1"), "ops:3+1"));
        // a blob page whose sha moved
        assert!(needs_pull(Some("aaa"), "bbb"));
    }

    #[test]
    fn sweep_skips_when_in_sync() {
        assert!(!needs_pull(Some("ops:0+3"), "ops:0+3"));
        assert!(!needs_pull(Some("abc"), "abc"));
    }

    #[test]
    fn sweep_pulls_pages_the_daemon_never_tracked() {
        // cloud has real content, daemon remembers nothing -> pull
        assert!(needs_pull(None, "ops:0+1"));
    }

    #[test]
    fn unpushed_local_guard_semantics() {
        // fresh file the daemon never synced: UNPUSHED (a fresh install's
        // existing notes must reach the cloud before any pull can write)
        assert!(has_unpushed_local("abc", None));
        // file differs from the last pushed/pulled content: UNPUSHED
        assert!(has_unpushed_local("abc", Some("def")));
        // file is exactly what we pushed/pulled: safe to overwrite
        assert!(!has_unpushed_local("abc", Some("abc")));
        // no file on disk: nothing to protect
        assert!(!has_unpushed_local("", None));
    }

    #[test]
    fn sweep_never_pulls_empty_cloud_revisions() {
        assert!(!needs_pull(None, ""));
        assert!(!needs_pull(Some("abc"), ""));
    }

    #[test]
    fn snapshot_only_edit_changes_the_marker() {
        // THE weft-cal15 regression, daemon side: a device-text web edit
        // publishes a snapshot with zero ops. Under the old op-head-only
        // marker both sides read "ops:0" and the change was skipped forever.
        // The snapshot-aware marker differs, so the daemon pulls.
        let remembered = "ops:0+85";
        let after_text_edit = "ops:0+91";
        assert!(needs_pull(Some(remembered), after_text_edit));
    }

    fn state_with_data(identity: &str) -> CloudState {
        let mut s = CloudState {
            cloud_identity: identity.to_string(),
            ..CloudState::default()
        };
        s.revisions.insert("d/p".into(), "rev1".into());
        s.pushed.insert("d/p".into(), "hash1".into());
        s.since = 42;
        s
    }

    #[test]
    fn same_identity_keeps_state() {
        let s = reconcile_state_identity(state_with_data("id-A"), "id-A");
        assert_eq!(s.revisions.len(), 1);
        assert_eq!(s.pushed.len(), 1);
        assert_eq!(s.since, 42);
    }

    #[test]
    fn changed_identity_resets_state_for_full_repush() {
        // the E29 field bug: repointing cloud.json must NOT keep the old
        // cloud's dedup maps (they suppress every push to the new cloud)
        let s = reconcile_state_identity(state_with_data("id-A"), "id-B");
        assert!(s.revisions.is_empty());
        assert!(s.pushed.is_empty());
        assert_eq!(s.since, 0);
        assert_eq!(s.cloud_identity, "id-B");
    }

    #[test]
    fn pre_identity_state_files_are_reset() {
        // old state files have no identity field (deserializes to ""): reset,
        // since we cannot know which cloud they were built against
        let s = reconcile_state_identity(state_with_data(""), "id-A");
        assert!(s.revisions.is_empty());
        assert_eq!(s.cloud_identity, "id-A");
    }

    #[test]
    fn identity_differs_per_url_and_token() {
        let a = cloud_identity(&CloudConfig {
            url: "http://a".into(),
            token: "t1".into(),
        });
        let b = cloud_identity(&CloudConfig {
            url: "http://b".into(),
            token: "t1".into(),
        });
        let c = cloud_identity(&CloudConfig {
            url: "http://a".into(),
            token: "t2".into(),
        });
        assert_ne!(a, b);
        assert_ne!(a, c);
        // and it is a hash, not the raw token
        assert!(!a.contains("t1"));
    }
}

#[cfg(test)]
mod exclusion_tests {
    use super::*;
    use crate::store::DocEntry;

    fn doc(id: &str, parent: &str, kind: &str) -> DocEntry {
        DocEntry {
            id: id.into(),
            name: id.into(),
            parent: parent.into(),
            kind: kind.into(),
            pages: vec![],
            last_modified: None,
            created_time: None,
            last_opened: None,
            last_opened_page: None,
            cover_page: None,
            zoom: None,
        }
    }

    #[test]
    fn folder_exclusion_covers_descendants_transitively() {
        let docs = vec![
            doc("F", "", "folder"),
            doc("sub", "F", "folder"),
            doc("deep", "sub", "notebook"),
            doc("top", "", "notebook"),
        ];
        let raw = ["F".to_string()].into_iter().collect();
        let ex = expand_exclusions(&docs, &raw);
        assert!(ex.contains("F") && ex.contains("sub") && ex.contains("deep"));
        assert!(!ex.contains("top"));
    }

    #[test]
    fn direct_doc_exclusion_touches_only_that_doc() {
        let docs = vec![doc("a", "", "notebook"), doc("b", "", "notebook")];
        let raw = ["a".to_string()].into_iter().collect();
        let ex = expand_exclusions(&docs, &raw);
        assert_eq!(ex.len(), 1);
        assert!(ex.contains("a"));
    }

    #[test]
    fn parent_cycles_terminate() {
        // corrupt tree: A -> B -> A; must not hang, and an exclusion inside
        // the cycle still catches both
        let docs = vec![doc("A", "B", "folder"), doc("B", "A", "folder")];
        let raw = ["A".to_string()].into_iter().collect();
        let ex = expand_exclusions(&docs, &raw);
        assert!(ex.contains("A") && ex.contains("B"));
    }

    fn opened(id: &str, at: Option<u64>) -> DocEntry {
        let mut d = doc(id, "", "pdf");
        d.last_opened = at;
        d
    }

    #[test]
    fn sources_push_hottest_first_never_opened_last_folders_skipped() {
        let docs = vec![
            opened("cold", Some(100)),
            opened("never", None),
            opened("hot", Some(9_000)),
            doc("shelf", "", "folder"),
            opened("warm", Some(5_000)),
        ];
        assert_eq!(
            source_push_order(&docs),
            vec!["hot", "warm", "cold", "never"]
        );
    }

    #[test]
    fn sources_order_is_deterministic_on_ties() {
        let docs = vec![opened("b", None), opened("a", None)];
        assert_eq!(source_push_order(&docs), vec!["a", "b"]);
    }

    #[test]
    fn budget_fit_check_treats_none_as_unlimited() {
        assert!(fits_sources_budget(1_000_000, &None)); // unknown/unlimited: attempt
        assert!(fits_sources_budget(500, &Some(500))); // exactly fits
        assert!(fits_sources_budget(499, &Some(500)));
        assert!(!fits_sources_budget(501, &Some(500))); // over the remaining room
        assert!(!fits_sources_budget(1, &Some(0))); // budget exhausted
    }

    #[test]
    fn sources_quota_detection_is_class_specific() {
        let sources = serde_json::json!({"error":"storage quota exceeded","reason":"quota","class":"sources"});
        let created = serde_json::json!({"error":"storage quota exceeded","reason":"quota","class":"created"});
        let capacity = serde_json::json!({"error":"at capacity","reason":"capacity"});
        assert!(is_sources_quota_full(507, &sources));
        assert!(!is_sources_quota_full(507, &created)); // created 507 ≠ stop sources
        assert!(!is_sources_quota_full(507, &capacity)); // capacity ≠ sources budget
        assert!(!is_sources_quota_full(403, &sources)); // exclusion backstop ≠ quota
        assert!(!is_sources_quota_full(507, &serde_json::Value::Null)); // unparsable body
    }
}
