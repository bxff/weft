//! D-Bus interface for the tablet synchronization service
//! 3.26+ on Paper Pro. Wire signatures are exact: Qt silently drops mismatched
//! signals.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use zbus::{connection::Builder, interface};

pub struct Synchronizer {
    conn: Option<Arc<zbus::Connection>>,
    pending_doc_id: Arc<Mutex<Option<String>>>,
    pending_paths: Arc<Mutex<Vec<String>>>,
}

fn uuid_to_bytes(uuid: &str) -> Vec<u8> {
    uuid.as_bytes().to_vec()
}

#[interface(name = "no.remarkable.sync.Synchronizer")]
impl Synchronizer {
    #[zbus(name = "setProtocolFlag")]
    fn set_protocol_flag(&mut self, flag: u32) {
        eprintln!("dbus <- setProtocolFlag({flag})");
    }

    #[zbus(name = "releaseEntryLock")]
    fn release_entry_lock(&mut self, id: &str) {
        eprintln!("dbus <- releaseEntryLock({id})");
    }

    #[zbus(name = "requestAbortAndCleanup")]
    fn request_abort_and_cleanup(&mut self) {
        eprintln!("dbus <- requestAbortAndCleanup()");
    }

    #[zbus(name = "clearConnectionCache")]
    fn clear_connection_cache(&mut self) {
        eprintln!("dbus <- clearConnectionCache()");
    }

    #[zbus(name = "setAvailableDiskSpace")]
    fn set_available_disk_space(&mut self, available: i64) {
        eprintln!("dbus <- setAvailableDiskSpace({available})");
    }

    /// Called by xochitl when it wants a sync pass.
    #[zbus(name = "execute")]
    fn execute(&mut self, base_path: &str, _request: (Vec<String>, Vec<String>, Vec<String>, bool)) {
        eprintln!("dbus <- execute({base_path})");
        if let Some(conn) = &self.conn {
            let conn = conn.clone();
            let pending = self.pending_doc_id.clone();
            let paths_arc = self.pending_paths.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let doc_id = pending.lock().await.take();
                if let Some(doc_id) = doc_id {
                    let paths = paths_arc.lock().await.clone();
                    if let Err(e) = emit_full_sync_sequence(&conn, &doc_id, &paths).await {
                        eprintln!("dbus x execute emit error: {e}");
                    }
                } else {
                    let _ = emit_empty_sync(&conn).await;
                }
            });
        }
    }

    /// External reload trigger from the cloud pull-apply paths (cloud.rs).
    #[zbus(name = "triggerReload")]
    fn trigger_reload(&mut self, doc_id: &str, changed_paths: Vec<String>) {
        eprintln!("dbus <- triggerReload({doc_id}, {changed_paths:?})");
        {
            let pending = self.pending_doc_id.clone();
            let paths_arc = self.pending_paths.clone();
            let doc = doc_id.to_string();
            let paths = changed_paths.clone();
            tokio::spawn(async move {
                *pending.lock().await = Some(doc);
                *paths_arc.lock().await = paths;
            });
        }
        if let Some(conn) = &self.conn {
            let conn = conn.clone();
            let doc_id = doc_id.to_string();
            tokio::spawn(async move {
                if let Err(e) = emit_full_sync_sequence(&conn, &doc_id, &changed_paths).await {
                    eprintln!("dbus x triggerReload emit error: {e}");
                }
            });
        }
    }

    // Signal declarations: required for Qt introspection-based signal wiring.

    #[zbus(signal, name = "failed")]
    async fn failed(ctxt: &zbus::SignalContext<'_>, message: &str) -> zbus::Result<()>;

    #[zbus(signal, name = "unauthorized")]
    async fn unauthorized(ctxt: &zbus::SignalContext<'_>) -> zbus::Result<()>;

    #[zbus(signal, name = "updateRequired")]
    async fn update_required(ctxt: &zbus::SignalContext<'_>) -> zbus::Result<()>;

    #[zbus(signal, name = "finished")]
    async fn finished(ctxt: &zbus::SignalContext<'_>, info: (bool, bool)) -> zbus::Result<()>;

    #[zbus(signal, name = "isSyncingChanged")]
    async fn is_syncing_changed(ctxt: &zbus::SignalContext<'_>, syncing: bool) -> zbus::Result<()>;

    #[zbus(signal, name = "documentProgress")]
    async fn document_progress(
        ctxt: &zbus::SignalContext<'_>,
        id: &str,
        progress: f64,
        upload: i32,
    ) -> zbus::Result<()>;

    /// Wire signature: (ay)(aay)(aay); do not change.
    #[zbus(signal, name = "documentFinished")]
    async fn document_finished(
        ctxt: &zbus::SignalContext<'_>,
        id: (Vec<u8>,),
        paths: (Vec<Vec<u8>>,),
        deleted_paths: (Vec<Vec<u8>>,),
    ) -> zbus::Result<()>;

    #[zbus(signal, name = "pathsDeleted")]
    async fn paths_deleted(ctxt: &zbus::SignalContext<'_>, paths: (Vec<Vec<u8>>,)) -> zbus::Result<()>;

    #[zbus(signal, name = "syncProgressChanged")]
    async fn sync_progress_changed(
        ctxt: &zbus::SignalContext<'_>,
        stats: (i32, i32, f64, i32, i32, i32),
    ) -> zbus::Result<()>;

    #[zbus(signal, name = "entryFailed")]
    async fn entry_failed(ctxt: &zbus::SignalContext<'_>, entry_id: &str) -> zbus::Result<()>;

    #[zbus(signal, name = "inactiveEntriesChanged")]
    async fn inactive_entries_changed(
        ctxt: &zbus::SignalContext<'_>,
        inactive_entries: Vec<String>,
    ) -> zbus::Result<()>;
}

/// Claim `no.remarkable.sync` and serve the interface. Returns the connection
/// for use by the HTTP server's reload trigger.
pub async fn start() -> zbus::Result<Arc<zbus::Connection>> {
    let sync = Synchronizer {
        conn: None,
        pending_doc_id: Arc::new(Mutex::new(None)),
        pending_paths: Arc::new(Mutex::new(vec![])),
    };
    let conn = Builder::system()?
        .name("no.remarkable.sync")?
        .serve_at("/Synchronizer", sync)?
        .build()
        .await?;
    let conn = Arc::new(conn);
    {
        let iface = conn
            .object_server()
            .interface::<_, Synchronizer>("/Synchronizer")
            .await?;
        iface.get_mut().await.conn = Some(conn.clone());
    }
    eprintln!("dbus: claimed no.remarkable.sync");
    Ok(conn)
}

/// Trigger a document reload (called by the cloud loop after it writes
/// pulled pages / metadata so an open doc repaints).
pub async fn trigger_reload(conn: &zbus::Connection, doc_id: &str, changed_paths: &[String]) {
    if let Err(e) = emit_full_sync_sequence(conn, doc_id, changed_paths).await {
        eprintln!("dbus x reload emit error: {e}");
    }
}

/// The exact signal choreography of the real rm-sync.
async fn emit_full_sync_sequence(
    conn: &zbus::Connection,
    doc_id: &str,
    changed_paths: &[String],
) -> zbus::Result<()> {
    let iface = conn
        .object_server()
        .interface::<_, Synchronizer>("/Synchronizer")
        .await?;
    let ctxt = iface.signal_context();

    Synchronizer::is_syncing_changed(ctxt, true).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 0.0, 0, 0, 1)).await?;
    Synchronizer::is_syncing_changed(ctxt, true).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 0.0, 0, 0, 2)).await?;
    Synchronizer::is_syncing_changed(ctxt, true).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 0.0, 0, 0, 3)).await?;
    Synchronizer::is_syncing_changed(ctxt, true).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 0.0, 0, 0, 4)).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 1.0, 1, 0, 4)).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let id_bytes: (Vec<u8>,) = (uuid_to_bytes(doc_id),);
    let mut path_list: Vec<Vec<u8>> = vec![uuid_to_bytes(doc_id)];
    for p in changed_paths {
        path_list.push(p.as_bytes().to_vec());
    }
    let paths_arg: (Vec<Vec<u8>>,) = (path_list,);
    let empty: (Vec<Vec<u8>>,) = (vec![],);

    Synchronizer::document_finished(ctxt, id_bytes, paths_arg, empty.clone()).await?;
    eprintln!("dbus -> documentFinished({doc_id}, {changed_paths:?})");

    Synchronizer::sync_progress_changed(ctxt, (1, 0, 1.0, 1, 1, 4)).await?;
    Synchronizer::is_syncing_changed(ctxt, true).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    Synchronizer::is_syncing_changed(ctxt, false).await?;
    Synchronizer::sync_progress_changed(ctxt, (1, 0, 1.0, 1, 1, 0)).await?;
    Synchronizer::finished(ctxt, (true, false)).await?;
    Synchronizer::is_syncing_changed(ctxt, false).await?;
    Synchronizer::paths_deleted(ctxt, empty).await?;
    Ok(())
}

async fn emit_empty_sync(conn: &zbus::Connection) -> zbus::Result<()> {
    let iface = conn
        .object_server()
        .interface::<_, Synchronizer>("/Synchronizer")
        .await?;
    let ctxt = iface.signal_context();
    let empty: (Vec<Vec<u8>>,) = (vec![],);
    Synchronizer::is_syncing_changed(ctxt, true).await?;
    Synchronizer::is_syncing_changed(ctxt, false).await?;
    Synchronizer::finished(ctxt, (true, false)).await?;
    Synchronizer::paths_deleted(ctxt, empty).await?;
    Ok(())
}
