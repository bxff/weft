//! Filesystem watcher: detect xochitl writes to .rm files and broadcast
//! page.changed events. xochitl writes temp-then-rename, so react to
//! create/modify and debounce per page (a save touches the file several times).

use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::server::AppState;

const DEBOUNCE: Duration = Duration::from_millis(250);

pub fn start(state: AppState) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
        ) {
            return;
        }
        for path in event.paths {
            match path.extension().and_then(|e| e.to_str()) {
                Some("rm") | Some("metadata") | Some("content") => {
                    let _ = tx.send(path);
                }
                _ => {}
            }
        }
    })?;
    watcher.watch(&state.store.xochitl_dir, RecursiveMode::Recursive)?;

    let pending: Arc<Mutex<HashMap<PathBuf, Instant>>> = Arc::new(Mutex::new(HashMap::new()));

    // Debounce + emit. Do not remove entries up front (read-after-remove race
    // loses a write landing between collection and read): drop an entry after
    // emit only if its timestamp is unchanged, so a concurrent re-insert re-emits.
    let emit_state = state.clone();
    let emit_pending = pending.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let due: Vec<(PathBuf, Instant)> = {
                let map = emit_pending.lock().await;
                let now = Instant::now();
                map.iter()
                    .filter(|(_, t)| now.duration_since(**t) >= DEBOUNCE)
                    .map(|(p, t)| (p.clone(), *t))
                    .collect()
            };
            for (path, stamp) in due {
                let done = emit_change(&emit_state, &path).await;
                let mut map = emit_pending.lock().await;
                if map.get(&path) == Some(&stamp) {
                    if done {
                        map.remove(&path);
                    } else {
                        // transient read failure (xochitl mid-rename): retry
                        map.insert(path.clone(), Instant::now());
                    }
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(path) = rx.recv().await {
            pending.lock().await.insert(path, Instant::now());
        }
    });

    Ok(watcher)
}

/// Returns true when the event is fully handled (or permanently skippable);
/// false means a transient failure the debounce loop should retry.
async fn emit_change(state: &AppState, path: &Path) -> bool {
    // metadata/content change (rename/create/move): refresh the doc list
    if matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("metadata") | Some("content")
    ) {
        let _ = state
            .events
            .send(serde_json::json!({ "type": "doc.list.changed" }).to_string());
        return true;
    }
    let Some((doc, page)) = doc_page_of(&state.store.xochitl_dir, path) else {
        return true;
    };
    // existence probe only: the consumer (cloud.rs push loop) re-hashes the
    // file itself, so don't hash here.
    match std::fs::metadata(path) {
        Ok(_) => {}
        // page deleted: nothing to emit
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        // mid-rename / transient: retry
        Err(_) => return false,
    }
    let _ = state.events.send(
        serde_json::json!({
            "type": "page.changed",
            "doc": doc,
            "page": page,
        })
        .to_string(),
    );
    true
}

fn doc_page_of(root: &Path, path: &Path) -> Option<(String, String)> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components();
    let doc = parts.next()?.as_os_str().to_str()?.to_string();
    let file = parts.next()?.as_os_str().to_str()?;
    if parts.next().is_some() {
        return None;
    }
    let page = file.strip_suffix(".rm")?.to_string();
    // real xochitl page files only: both ids must be UUIDs (rejects temp files)
    if !is_uuid(&doc) || !is_uuid(&page) {
        return None;
    }
    Some((doc, page))
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/store";

    fn dp(rel: &str) -> Option<(String, String)> {
        doc_page_of(Path::new(ROOT), &Path::new(ROOT).join(rel))
    }

    #[test]
    fn doc_page_of_accepts_only_uuid_pairs() {
        let doc = "11111111-1111-4111-a111-111111111111";
        let page = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        assert_eq!(
            dp(&format!("{doc}/{page}.rm")),
            Some((doc.into(), page.into()))
        );

        // temp files and non-uuid names
        assert_eq!(dp(&format!("{doc}/.weft-tmp-{page}.rm")), None);
        assert_eq!(dp(&format!(".tmp/{page}.rm")), None);
        assert_eq!(dp(&format!("{doc}/notes.rm")), None);
        assert_eq!(dp(&format!("{doc}/{page}X.rm")), None); // 37 chars
        assert_eq!(dp("not-a-uuid/also-not.rm"), None);
        // wrong nesting / extension
        assert_eq!(dp(&format!("{doc}/sub/{page}.rm")), None);
        assert_eq!(dp(&format!("{doc}/{page}.json")), None);
        assert_eq!(dp(&format!("{page}.rm")), None);
    }
}
