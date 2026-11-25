//! Xochitl document store: enumeration, page reads, CAS page writes,
//! image-asset writes, and .tree hash maintenance.
//! Page content is opaque bytes; a revision is sha256(bytes), the same hash
//! xochitl stores in .tree, so revision identity == Merkle identity.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Store {
    pub xochitl_dir: PathBuf,
    /// Per-page write locks keyed by "doc/page".
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Serializes the shared .tree/.metadata read-modify-write (.tree is one
    /// global file). Without it, two concurrent page writes both read the same
    /// .tree and the second clobbers the first's hash patch. Always taken AFTER
    /// the page lock (order page -> tree, no deadlock).
    tree_lock: Arc<Mutex<()>>,
}

#[derive(Serialize, Clone)]
pub struct PageEntry {
    pub id: String,
    #[serde(rename = "lastModified", skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<u64>,
    /// reMarkable template name (e.g. "P Lines small"), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// For pdf/epub docs: index into the underlying file's pages.
    #[serde(rename = "fileIndex", skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct DocEntry {
    pub id: String,
    pub name: String,
    pub parent: String,
    #[serde(rename = "type")]
    pub kind: String, // "notebook" | "pdf" | "epub" | "folder"
    pub pages: Vec<PageEntry>,
    #[serde(rename = "lastModified", skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<u64>,
    /// .metadata createdTime (epoch ms).
    #[serde(rename = "createdTime", skip_serializing_if = "Option::is_none")]
    pub created_time: Option<u64>,
    /// .metadata lastOpened (epoch ms), "last opened anywhere" once
    /// apply_last_opened folds cloud opens in.
    #[serde(rename = "lastOpened", skip_serializing_if = "Option::is_none")]
    pub last_opened: Option<u64>,
    /// Page id xochitl last had open (cPages.lastOpened.value).
    #[serde(rename = "lastOpenedPage", skip_serializing_if = "Option::is_none")]
    pub last_opened_page: Option<String>,
    /// Page id xochitl shows as the doc cover, resolved from .content
    /// `coverPageNumber`: -1 = follow the last-visited page, N>=0 = fixed page
    /// index. Resolved to a page id so the web shows the same cover as the device.
    #[serde(rename = "coverPage", skip_serializing_if = "Option::is_none")]
    pub cover_page: Option<String>,
    /// PDF/EPUB page rect in ink space (customZoom* fields, present even in
    /// bestFit mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<ZoomInfo>,
}

#[derive(Serialize, Clone)]
pub struct ZoomInfo {
    pub mode: String,
    pub scale: f64,
    #[serde(rename = "centerX")]
    pub center_x: f64,
    #[serde(rename = "centerY")]
    pub center_y: f64,
    #[serde(rename = "pageWidth")]
    pub page_width: f64,
    #[serde(rename = "pageHeight")]
    pub page_height: f64,
}

#[derive(Debug)]
pub enum WriteError {
    StaleRevision { current: String },
    Io(std::io::Error),
}

impl From<std::io::Error> for WriteError {
    fn from(e: std::io::Error) -> Self {
        WriteError::Io(e)
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Image asset filenames: tight allow-list, no traversal.
pub fn valid_asset_filename(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if !matches!(ext, "png" | "jpg" | "jpeg") {
        return false;
    }
    !stem.is_empty()
        && stem.len() <= 64
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A doc/page id that cannot escape its store directory (defense-in-depth
/// behind the route guards: never let a traversable segment reach the fs).
pub fn safe_id(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && !s.contains("..")
}

impl Store {
    pub fn new(xochitl_dir: PathBuf) -> Self {
        Self {
            xochitl_dir,
            locks: Arc::new(Mutex::new(HashMap::new())),
            tree_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn page_path(&self, doc: &str, page: &str) -> PathBuf {
        self.xochitl_dir.join(doc).join(format!("{page}.rm"))
    }

    fn tree_path(&self) -> PathBuf {
        self.xochitl_dir.join(".tree")
    }

    async fn page_lock(&self, doc: &str, page: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(format!("{doc}/{page}"))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Enumerate all documents and folders from .metadata/.content files.
    pub fn list_documents(&self) -> Vec<DocEntry> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.xochitl_dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("metadata") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            let Ok(meta_raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) else {
                continue;
            };
            if meta.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false) {
                continue;
            }
            let name = meta
                .get("visibleName")
                .and_then(|v| v.as_str())
                .unwrap_or("(unnamed)")
                .to_string();
            let parent = meta
                .get("parent")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if parent == "trash" {
                continue;
            }
            let last_modified = meta
                .get("lastModified")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());
            let last_opened = meta
                .get("lastOpened")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());
            let created_time = meta
                .get("createdTime")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());

            let is_collection = meta.get("type").and_then(|v| v.as_str()) == Some("CollectionType");
            if is_collection {
                out.push(DocEntry {
                    id,
                    name,
                    parent,
                    kind: "folder".into(),
                    pages: vec![],
                    last_modified,
                    created_time,
                    last_opened: None,
                    last_opened_page: None,
                    cover_page: None,
                    zoom: None,
                });
                continue;
            }

            let content_path = self.xochitl_dir.join(format!("{id}.content"));
            let content: serde_json::Value = std::fs::read_to_string(&content_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);

            let kind = match content.get("fileType").and_then(|v| v.as_str()) {
                Some("pdf") => "pdf",
                Some("epub") => "epub",
                _ => "notebook",
            }
            .to_string();

            let pages = list_pages(&content, &self.xochitl_dir, &id);
            let last_opened_page = content
                .pointer("/cPages/lastOpened/value")
                .and_then(|v| v.as_str())
                .map(String::from);
            // coverPageNumber -1/absent = last-visited page, N>=0 = fixed index
            // into visible pages.
            let cover_page = match content.get("coverPageNumber").and_then(|v| v.as_i64()) {
                Some(n) if n >= 0 => pages.get(n as usize).map(|p| p.id.clone()),
                _ => last_opened_page.clone(),
            };
            let zoom = content.get("customZoomPageWidth").map(|_| ZoomInfo {
                mode: content
                    .get("zoomMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("bestFit")
                    .to_string(),
                scale: content
                    .get("customZoomScale")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1.0),
                center_x: content
                    .get("customZoomCenterX")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                center_y: content
                    .get("customZoomCenterY")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(936.0),
                page_width: content
                    .get("customZoomPageWidth")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1404.0),
                page_height: content
                    .get("customZoomPageHeight")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1872.0),
            });
            out.push(DocEntry {
                id,
                name,
                parent,
                kind,
                pages,
                last_modified,
                created_time,
                last_opened,
                last_opened_page,
                cover_page,
                zoom,
            });
        }
        out
    }

    /// Read a page's bytes + revision. Returns None if the page file is absent.
    pub fn read_page(&self, doc: &str, page: &str) -> Option<(Vec<u8>, String)> {
        if !safe_id(doc) || !safe_id(page) {
            return None;
        }
        let bytes = std::fs::read(self.page_path(doc, page)).ok()?;
        let rev = sha256_hex(&bytes);
        Some((bytes, rev))
    }

    /// CAS write: succeeds only if the on-disk revision equals `base_revision`
    /// (or the page does not exist yet and `base_revision` is empty).
    /// Returns the new revision.
    pub async fn write_page(
        &self,
        doc: &str,
        page: &str,
        base_revision: &str,
        bytes: &[u8],
    ) -> Result<String, WriteError> {
        if !safe_id(doc) || !safe_id(page) {
            return Err(WriteError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "unsafe path segment",
            )))
        }
        let lock = self.page_lock(doc, page).await;
        let _guard = lock.lock().await;

        let path = self.page_path(doc, page);
        let current = std::fs::read(&path).ok();
        let current_rev = current.as_deref().map(sha256_hex).unwrap_or_default();
        if current_rev != base_revision {
            return Err(WriteError::StaleRevision { current: current_rev });
        }

        let old_hash: Option<[u8; 32]> = current.as_deref().map(|c| Sha256::digest(c).into());
        // First write to an un-annotated page: the doc directory may not exist.
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write(&path, bytes)?;

        let new_hash: [u8; 32] = Sha256::digest(bytes).into();
        {
            let _tree_guard = self.tree_lock.lock().await;
            if let Err(e) = self.patch_tree(doc, page, old_hash.as_ref(), &new_hash) {
                eprintln!("store: .tree patch skipped: {e}");
            }
            self.touch_metadata(doc);
        }
        Ok(hex::encode(new_hash))
    }

    /// Write an image asset into the page's resource dir.
    pub fn write_asset(
        &self,
        doc: &str,
        page: &str,
        file: &str,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        // Traversal guard: doc/page/file come from cloud JSON and are joined
        // into a root-owned path, so `..` ids could write outside the store as root.
        if !safe_id(doc) || !safe_id(page) || file.contains('/') || file.contains("..") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "unsafe asset path",
            ));
        }
        let dir = self.xochitl_dir.join(doc).join(page);
        std::fs::create_dir_all(&dir)?;
        atomic_write(&dir.join(file), bytes)
    }

    /// Materialize a new empty notebook: write `<doc>.metadata` + `<doc>.content`
    /// so xochitl lists and opens it. First page's `.rm` bytes arrive via the
    /// normal page pull. Idempotent: returns false if `<doc>.metadata` already
    /// exists. Only ever writes new files under `doc`, never the shared `.tree`.
    pub fn create_notebook(
        &self,
        doc: &str,
        name: &str,
        parent: &str,
        page: &str,
        template: &str,
    ) -> bool {
        if !safe_id(doc) || !safe_id(page) {
            return false;
        }
        let meta_path = self.xochitl_dir.join(format!("{doc}.metadata"));
        if meta_path.exists() {
            return false; // already materialized
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            .to_string();
        let tpl = if template.is_empty() { "Blank" } else { template };

        // Exact field set of a real on-device notebook: xochitl won't list a doc
        // whose .metadata carries pending-sync flags (deleted/synced/modified/
        // metadatamodified/version) or is missing new/source.
        let metadata = serde_json::json!({
            "createdTime": now,
            "lastModified": now,
            "lastOpened": now,
            "lastOpenedPage": 0,
            "new": false,
            "parent": parent,
            "pinned": false,
            "source": "",
            "type": "DocumentType",
            "visibleName": name,
        });
        let content = serde_json::json!({
            "fileType": "notebook",
            "formatVersion": 2,
            "coverPageNumber": 0,
            "pageCount": 1,
            "orientation": "portrait",
            "textAlignment": "justify",
            "textScale": 1,
            "lineHeight": -1,
            "margins": 125,
            "sizeInBytes": "0",
            "tags": [],
            "extraMetadata": {},
            "cPages": {
                "lastOpened": { "timestamp": "1:1", "value": page },
                "original": { "timestamp": "0:0", "value": -1 },
                "pages": [
                    {
                        "id": page,
                        "idx": { "timestamp": "1:2", "value": "ba" },
                        "template": { "timestamp": "1:1", "value": tpl }
                    }
                ],
                "uuids": [ { "first": page, "second": 1 } ]
            }
        });

        let Ok(meta_json) = serde_json::to_string(&metadata) else {
            return false;
        };
        // .metadata written LAST: xochitl keys off it, so it never sees a doc
        // whose .content isn't ready.
        let _ = std::fs::create_dir_all(self.xochitl_dir.join(doc));
        if let Ok(content_json) = serde_json::to_string(&content) {
            let _ = atomic_write(
                &self.xochitl_dir.join(format!("{doc}.content")),
                content_json.as_bytes(),
            );
        }
        atomic_write(&meta_path, meta_json.as_bytes()).is_ok()
    }

    /// Materialize a new folder: a `CollectionType` `.metadata`, no `.content`,
    /// pages, or `.tree`. Idempotent: false if `<doc>.metadata` already exists.
    pub fn create_folder(&self, doc: &str, name: &str, parent: &str) -> bool {
        if !safe_id(doc) {
            return false;
        }
        let meta_path = self.xochitl_dir.join(format!("{doc}.metadata"));
        if meta_path.exists() {
            return false;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            .to_string();
        // Exact field set of a real on-device folder (same rule as create_notebook).
        let metadata = serde_json::json!({
            "createdTime": now,
            "lastModified": now,
            "new": false,
            "parent": parent,
            "pinned": false,
            "source": "",
            "type": "CollectionType",
            "visibleName": name,
        });
        let Ok(meta_json) = serde_json::to_string(&metadata) else {
            return false;
        };
        atomic_write(&meta_path, meta_json.as_bytes()).is_ok()
    }

    /// Apply a cloud rename/move to `.metadata` by per-doc LWW: only when the
    /// cloud lastModified is strictly newer than local. Adopts the cloud
    /// lastModified (so it doesn't bounce back) and bumps `version` (xochitl's
    /// live re-read signal). Never creates or deletes a doc (delete-by-absence
    /// would risk data loss on a partial/stale cloud list).
    pub fn apply_doc_meta(&self, doc: &str, name: &str, parent: &str, last_modified: u64) -> bool {
        if !safe_id(doc) {
            return false;
        }
        let path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return false; // unknown doc: never create
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return false;
        };
        if !value.is_object() {
            return false; // truncated write parsed to null: indexing would panic
        }
        // Unknown local freshness (absent/garbage lastModified): refuse rather
        // than default to 0, which would let any cloud edit win.
        let Some(local_lm) = value
            .get("lastModified")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
        else {
            return false;
        };
        // LWW granularity caveat: lastModified also bumps on content edits
        // (touch_metadata), so a recent local page edit can out-rank an older
        // web rename. Accepted under the coarse whole-doc LWW.
        if last_modified <= local_lm {
            return false; // local is at least as new: keep it
        }
        let cur_name = value.get("visibleName").and_then(|v| v.as_str()).unwrap_or("");
        let cur_parent = value.get("parent").and_then(|v| v.as_str()).unwrap_or("");
        if cur_name == name && cur_parent == parent {
            return false; // newer timestamp but no rename/move: nothing to do
        }
        value["visibleName"] = serde_json::Value::String(name.to_string());
        value["parent"] = serde_json::Value::String(parent.to_string());
        value["lastModified"] = serde_json::Value::String(last_modified.to_string());
        let ver = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        value["version"] = serde_json::Value::from(ver + 1);
        match serde_json::to_string(&value) {
            Ok(json) => atomic_write(&path, json.as_bytes()).is_ok(),
            Err(_) => false,
        }
    }

    /// Apply a cloud-side page-template pick. Sets
    /// `cPages.pages[<page>].template.value` in `<doc>.content`, preserving the
    /// template object's other keys (xochitl keeps a generation "timestamp"
    /// there, never clobber it), then bumps `.metadata` so xochitl reloads.
    /// LWW: only a strictly newer cloud lastModified wins. Never creates docs or
    /// pages. Format v2 only (v1 has no per-page templates).
    pub fn apply_page_template(
        &self,
        doc: &str,
        page: &str,
        template: &str,
        last_modified: u64,
    ) -> std::io::Result<bool> {
        if !safe_id(doc) || !safe_id(page) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsafe document or page ID"));
        }
        // freshness guard on .metadata (same rules as apply_doc_meta)
        let meta_path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta_path)?)?;
        if !meta.is_object() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata is not an object"));
        }
        let stamped = last_modified == u64::MAX;
        if !stamped {
            let local_lm = meta.get("lastModified").and_then(|v| v.as_str())
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid metadata lastModified"))?;
            if last_modified <= local_lm {
                return Ok(false);
            }
        }
        let content_path = self.xochitl_dir.join(format!("{doc}.content"));
        let mut value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&content_path)?)?;
        let Some(pages) = value
            .pointer_mut("/cPages/pages")
            .and_then(|v| v.as_array_mut())
        else {
            return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "page templates require cPages"));
        };
        let Some(entry) = pages.iter_mut().find(|p| {
            p.get("id").and_then(|v| v.as_str()) == Some(page) && p.get("deleted").is_none()
        }) else {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "live page not found"));
        };
        let cur = entry
            .pointer("/template/value")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if cur != template {
            match entry.get_mut("template") {
                Some(serde_json::Value::Object(obj)) => {
                    obj.insert(
                        "value".to_string(),
                        serde_json::Value::String(template.to_string()),
                    );
                }
                _ => {
                    entry["template"] = serde_json::json!({ "value": template });
                }
            }
            atomic_write(&content_path, &serde_json::to_vec(&value)?)?;
        } else if !stamped {
            return Ok(false);
        }
        if stamped {
            // The content may already match because a previous attempt wrote
            // it but failed to publish the reload marker. Complete publication
            // before acknowledging this stamp, without changing recency.
            let mut latest: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&meta_path)?)?;
            if !latest.is_object() {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata is not an object"));
            }
            let version = latest.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
            latest["version"] = serde_json::Value::from(version.checked_add(1).ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata version overflow")
            })?);
            atomic_write(&meta_path, &serde_json::to_vec(&latest)?)?;
        } else {
            self.touch_metadata(doc);
        }
        Ok(true)
    }

    /// Fold a web open into the doc's metadata. lastOpened is a max-register
    /// CRDT (the value is its own timestamp, merge = max): writes only when the
    /// cloud open is strictly newer than local, so a newer tablet-side open is
    /// never lost, and re-applying each tick self-heals xochitl's in-memory
    /// clobber.
    ///
    /// Also points the doc at the web-opened page: metadata lastOpenedPage
    /// (index) and .content cPages.lastOpened.value (page uuid, other keys
    /// preserved), both only when the page exists locally and isn't deleted.
    ///
    /// Does NOT touch lastModified (an open is a read, must not surface under
    /// the default "Last modified" sort) but DOES bump `version`: xochitl only
    /// re-reads metadata live on a version bump. Never creates a doc.
    pub fn apply_last_opened(&self, doc: &str, page: &str, at_ms: u64) -> bool {
        if !safe_id(doc) || at_ms == 0 {
            return false;
        }
        let meta_path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let Ok(meta_raw) = std::fs::read_to_string(&meta_path) else {
            return false; // unknown doc: never create
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) else {
            return false;
        };
        // max-register merge: absent/garbage local lastOpened = 0, so any real
        // web open wins; otherwise strictly-newer only (equal keeps local).
        let local = meta
            .get("lastOpened")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        if at_ms <= local {
            return false;
        }
        // Page pointer, best-effort, only when the page exists in .content.
        // Written before the metadata register so a crash between the two leaves
        // lastOpened old and the update retries next tick.
        let mut last_opened_page: Option<u64> = None;
        if safe_id(page) {
            let content_path = self.xochitl_dir.join(format!("{doc}.content"));
            if let Some(mut content) = std::fs::read_to_string(&content_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            {
                let index = page_index(&content, page);
                if let Some(idx) = index {
                    let mut changed = false;
                    if let Some(cpages) =
                        content.pointer_mut("/cPages").and_then(|v| v.as_object_mut())
                    {
                        // preserve sibling keys (xochitl keeps a CRDT-style
                        // timestamp there, same rule as apply_page_template)
                        match cpages.get_mut("lastOpened") {
                            Some(serde_json::Value::Object(obj)) => {
                                if obj.get("value").and_then(|v| v.as_str()) != Some(page) {
                                    obj.insert(
                                        "value".to_string(),
                                        serde_json::Value::String(page.to_string()),
                                    );
                                    changed = true;
                                }
                            }
                            _ => {
                                cpages.insert(
                                    "lastOpened".to_string(),
                                    serde_json::json!({ "value": page }),
                                );
                                changed = true;
                            }
                        }
                    }
                    if changed {
                        if let Ok(json) = serde_json::to_string(&content) {
                            let _ = atomic_write(&content_path, json.as_bytes());
                        }
                    }
                    last_opened_page = Some(idx);
                }
            }
        }
        // Re-read .metadata immediately before writing and merge only our two
        // fields, shrinking the read->write window so a concurrent xochitl save
        // of lastModified/version isn't reverted by our whole-file rewrite. If
        // xochitl advanced lastOpened past our value meanwhile, yield (max-register).
        let Ok(fresh_raw) = std::fs::read_to_string(&meta_path) else {
            return false;
        };
        let Ok(mut fresh) = serde_json::from_str::<serde_json::Value>(&fresh_raw) else {
            return false;
        };
        if !fresh.is_object() {
            return false; // non-object metadata: indexing would panic
        }
        let fresh_local = fresh
            .get("lastOpened")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        if at_ms <= fresh_local {
            return false; // a newer open (device or a racing write) landed
        }
        if let Some(idx) = last_opened_page {
            fresh["lastOpenedPage"] = serde_json::Value::from(idx);
        }
        fresh["lastOpened"] = serde_json::Value::String(at_ms.to_string());
        // Bump `version`: without it the value lands on disk but xochitl never
        // re-reads it live (the version bump is the notify, no dbus signal).
        // lastModified untouched (an open is a read, not an edit).
        let ver = fresh.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        fresh["version"] = serde_json::Value::from(ver + 1);
        match serde_json::to_string(&fresh) {
            Ok(json) => atomic_write(&meta_path, json.as_bytes()).is_ok(),
            Err(_) => false,
        }
    }

    /// Apply web-stamped name/parent registers regardless of local whole-doc
    /// lastModified (the stamp already won the cloud register; a local content
    /// edit must not veto a rename/move forever). Values only + version bump for
    /// xochitl's live re-read; lastModified NOT touched (applying a register is
    /// not a local edit, must not claim LWW recency on the next push).
    pub fn apply_doc_fields_stamped(
        &self,
        doc: &str,
        name: Option<&str>,
        parent: Option<&str>,
    ) -> std::io::Result<bool> {
        if !safe_id(doc) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsafe document ID"));
        }
        let path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let mut value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        if !value.is_object() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata is not an object"));
        }
        let mut changed = false;
        if let Some(n) = name {
            if !n.is_empty() && value.get("visibleName").and_then(|v| v.as_str()) != Some(n) {
                value["visibleName"] = serde_json::Value::String(n.to_string());
                changed = true;
            }
        }
        if let Some(p) = parent {
            if value.get("parent").and_then(|v| v.as_str()) != Some(p) {
                value["parent"] = serde_json::Value::String(p.to_string());
                changed = true;
            }
        }
        if !changed {
            return Ok(false);
        }
        let ver = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        value["version"] = serde_json::Value::from(ver.checked_add(1).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata version overflow")
        })?);
        atomic_write(&path, &serde_json::to_vec(&value)?)?;
        Ok(true)
    }

    /// Move a locally-present doc to trash because a sibling device deleted it
    /// (cloud tombstone). LWW: only when the tombstone is newer than local
    /// lastModified, so a local edit after the delete revives the doc (edit
    /// beats delete, data-preserving). Trash (parent="trash"), not a hard
    /// delete: recoverable, matches xochitl's own delete flow. Unknown local
    /// freshness refuses.
    pub fn apply_doc_trash(&self, doc: &str, last_modified: u64) -> bool {
        let path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let Ok(raw) = std::fs::read_to_string(&path) else { return false };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return false;
        };
        if !value.is_object() {
            return false;
        }
        if value.get("parent").and_then(|v| v.as_str()) == Some("trash") {
            return false; // already trashed
        }
        let local_lm: u64 = value
            .get("lastModified")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(u64::MAX);
        if last_modified <= local_lm {
            return false; // local is at least as new: keep it (edit wins)
        }
        value["parent"] = serde_json::Value::String("trash".to_string());
        value["lastModified"] = serde_json::Value::String(last_modified.to_string());
        let ver = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        value["version"] = serde_json::Value::from(ver + 1);
        match serde_json::to_string(&value) {
            Ok(json) => atomic_write(&path, json.as_bytes()).is_ok(),
            Err(_) => false,
        }
    }

    fn touch_metadata(&self, doc: &str) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.touch_metadata_at(doc, now_ms);
    }

    fn touch_metadata_at(&self, doc: &str, now_ms: u64) {
        let path = self.xochitl_dir.join(format!("{doc}.metadata"));
        let Ok(raw) = std::fs::read_to_string(&path) else { return };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
        if !value.is_object() {
            return; // non-object metadata: indexing would panic
        }
        let previous = &value["lastModified"];
        let previous_ms = previous
            .as_u64()
            .or_else(|| previous.as_str()?.parse().ok());
        let next_ms = previous_ms.map_or(now_ms, |previous_ms| {
            now_ms.max(previous_ms.saturating_add(1))
        });
        value["lastModified"] = serde_json::Value::String(next_ms.to_string());
        // The version bump is xochitl's live re-read signal: a bare field write
        // is inert until reload.
        let ver = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        value["version"] = serde_json::Value::from(ver + 1);
        if let Ok(json) = serde_json::to_string(&value) {
            let _ = atomic_write(&path, json.as_bytes());
        }
    }

    /// Update this page's hash entry in xochitl's .tree file so an open document
    /// detects the change on documentFinished. Byte-scan: the 32 replaced bytes
    /// should equal sha256 of the previous content (else log and still patch,
    /// xochitl may have raced us).
    fn patch_tree(
        &self,
        doc: &str,
        page: &str,
        old_hash: Option<&[u8; 32]>,
        new_hash: &[u8; 32],
    ) -> std::io::Result<()> {
        let tree_path = self.tree_path();
        let mut tree = std::fs::read(&tree_path)?;
        let needle = format!("{doc}/{page}.rm");
        let needle = needle.as_bytes();

        let Some(idx) = find(&tree, needle) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "page path not in .tree",
            ));
        };
        let end = idx + needle.len();
        let mut hash_offset = None;
        for skip in 1..8 {
            let pos = end + skip;
            if pos + 1 < tree.len() && tree[pos] == 0x00 && tree[pos + 1] == 0x20 {
                hash_offset = Some(pos + 2);
                break;
            }
        }
        let Some(off) = hash_offset else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "hash marker not found after page path",
            ));
        };
        if off + 32 > tree.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                ".tree truncated at hash",
            ));
        }
        if let Some(old) = old_hash {
            let stored = &tree[off..off + 32];
            if stored == new_hash.as_slice() {
                return Ok(()); // already current (a prior patch or xochitl's own save)
            }
            if stored != old.as_slice() {
                // xochitl raced us (its save rewrote .tree). Aborting here would
                // permanently stall web->tablet delivery: the stored hash never
                // matches our expected old hash again, so every later pull skips
                // the patch. The entry is located by this page's own path in a
                // fresh .tree read, so replacing its 32 hash bytes is safe: log
                // and patch anyway.
                eprintln!(
                    "store: .tree hash for {doc}/{page} unexpected (xochitl raced); patching anyway"
                );
            }
        }
        tree[off..off + 32].copy_from_slice(new_hash);
        atomic_write(&tree_path, &tree)
    }
}

fn list_pages(content: &serde_json::Value, dir: &Path, doc_id: &str) -> Vec<PageEntry> {
    let mut pages = Vec::new();
    // Format v2: cPages.pages = [{id, template: {value}, redir: {value}, deleted?}]
    if let Some(arr) = content
        .pointer("/cPages/pages")
        .and_then(|v| v.as_array())
    {
        for p in arr {
            if p.get("deleted").is_some() {
                continue;
            }
            if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                let template = p
                    .pointer("/template/value")
                    .and_then(|v| v.as_str())
                    .filter(|t| !t.is_empty() && *t != "Blank")
                    .map(String::from);
                let file_index = p.pointer("/redir/value").and_then(|v| v.as_u64());
                pages.push(PageEntry {
                    id: id.to_string(),
                    last_modified: modified_since_epoch(&dir.join(doc_id).join(format!("{id}.rm")))
                        .map(|d| d.as_secs()),
                    template,
                    file_index,
                });
            }
        }
        return pages;
    }
    // Format v1: pages = ["uuid", ...]
    if let Some(arr) = content.get("pages").and_then(|v| v.as_array()) {
        for (i, p) in arr.iter().enumerate() {
            if let Some(id) = p.as_str() {
                pages.push(PageEntry {
                    id: id.to_string(),
                    last_modified: modified_since_epoch(&dir.join(doc_id).join(format!("{id}.rm")))
                        .map(|d| d.as_secs()),
                    template: None,
                    file_index: Some(i as u64),
                });
            }
        }
    }
    pages
}

/// Index of a live page id in the doc's content (v2 cPages or v1 pages array),
/// counting only non-deleted pages — the value xochitl stores in metadata
/// lastOpenedPage. None when the page is absent or deleted.
fn page_index(content: &serde_json::Value, page: &str) -> Option<u64> {
    if let Some(arr) = content.pointer("/cPages/pages").and_then(|v| v.as_array()) {
        let mut idx: u64 = 0;
        for p in arr {
            if p.get("deleted").is_some() {
                continue;
            }
            if p.get("id").and_then(|v| v.as_str()) == Some(page) {
                return Some(idx);
            }
            idx += 1;
        }
        return None;
    }
    if let Some(arr) = content.get("pages").and_then(|v| v.as_array()) {
        return arr
            .iter()
            .position(|p| p.as_str() == Some(page))
            .map(|i| i as u64);
    }
    None
}

pub(crate) fn modified_since_epoch(path: &Path) -> Option<std::time::Duration> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Write via temp file + fsync + atomic rename in the target directory.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;
    let tmp = dir.join(format!(
        ".weft-tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_metadata_advances_recency_even_when_the_clock_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path().to_path_buf());
        let metadata = tmp.path().join(format!("{DOC}.metadata"));
        let mut observed = Vec::new();
        for (previous, clock) in [
            (serde_json::json!("100"), 100),
            (serde_json::json!(200), 100),
            (serde_json::json!("100"), 300),
        ] {
            let before = serde_json::json!({
                "lastModified": previous, "version": 8, "visibleName": "Notebook"
            });
            std::fs::write(&metadata, serde_json::to_vec(&before).unwrap()).unwrap();
            store.touch_metadata_at(DOC, clock);
            let after: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
            observed.push(after["lastModified"].as_str().unwrap().to_owned());
            assert_eq!(after["version"], 9);
            assert_eq!(after["visibleName"], "Notebook");
        }
        assert_eq!(observed, ["101", "201", "300"]);
    }


    use tempfile::TempDir;

    const DOC: &str = "11111111-1111-4111-a111-111111111111";
    const PAGE: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

    fn store() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let xochitl = dir.path().join("xochitl");
        std::fs::create_dir_all(&xochitl).unwrap();
        let s = Store::new(xochitl);
        (dir, s)
    }

    #[tokio::test]
    async fn cas_create_update_stale() {
        let (_tmp, store) = store();

        // create: empty base on a missing page, doc dir auto-created
        let rev1 = store.write_page(DOC, PAGE, "", b"v1").await.unwrap();
        assert_eq!(rev1, sha256_hex(b"v1"));
        let (bytes, rev) = store.read_page(DOC, PAGE).unwrap();
        assert_eq!(bytes, b"v1");
        assert_eq!(rev, rev1);

        // update with the correct base
        let rev2 = store.write_page(DOC, PAGE, &rev1, b"v2").await.unwrap();
        assert_eq!(rev2, sha256_hex(b"v2"));

        // stale base -> StaleRevision carrying the CURRENT revision
        match store.write_page(DOC, PAGE, &rev1, b"v3").await {
            Err(WriteError::StaleRevision { current }) => assert_eq!(current, rev2),
            other => panic!("expected StaleRevision, got {other:?}"),
        }
        // and the losing write must not have landed
        assert_eq!(store.read_page(DOC, PAGE).unwrap().0, b"v2");

        // empty base on an EXISTING page is also stale (create-only semantics)
        assert!(matches!(
            store.write_page(DOC, PAGE, "", b"v3").await,
            Err(WriteError::StaleRevision { .. })
        ));
    }

    #[tokio::test]
    async fn write_page_patches_tree_and_touches_metadata() {
        let (_tmp, store) = store();
        std::fs::write(
            store.xochitl_dir.join(format!("{DOC}.metadata")),
            r#"{"visibleName":"T","parent":"","type":"DocumentType","lastModified":"1000","deleted":false}"#,
        )
        .unwrap();

        // seed page v1 (no .tree yet: patch is skipped, write still succeeds)
        let rev1 = store.write_page(DOC, PAGE, "", b"v1").await.unwrap();

        // synthetic .tree: <path> <junk> 0x00 0x20 <32-byte hash of v1>
        let mut tree = Vec::new();
        tree.extend_from_slice(b"HEADER");
        tree.extend_from_slice(format!("{DOC}/{PAGE}.rm").as_bytes());
        tree.extend_from_slice(&[0x01, 0x00, 0x20]);
        tree.extend_from_slice(&Sha256::digest(b"v1"));
        tree.extend_from_slice(b"TRAILER");
        std::fs::write(store.xochitl_dir.join(".tree"), &tree).unwrap();

        store.write_page(DOC, PAGE, &rev1, b"v2").await.unwrap();

        let patched = std::fs::read(store.xochitl_dir.join(".tree")).unwrap();
        let expect: [u8; 32] = Sha256::digest(b"v2").into();
        let off = tree.len() - 32 - b"TRAILER".len();
        assert_eq!(&patched[off..off + 32], &expect);
        // everything around the hash untouched
        assert_eq!(&patched[..off], &tree[..off]);
        assert_eq!(&patched[off + 32..], b"TRAILER");

        // lastModified bumped past the seed value
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(store.xochitl_dir.join(format!("{DOC}.metadata"))).unwrap(),
        )
        .unwrap();
        let last: u64 = meta["lastModified"].as_str().unwrap().parse().unwrap();
        assert!(last > 1000);

        // no temp files left behind
        let leftovers: Vec<_> = std::fs::read_dir(store.xochitl_dir.join(DOC))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".weft-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn apply_doc_meta_lww_rename_and_move() {
        let (_tmp, store) = store();
        let mpath = store.xochitl_dir.join(format!("{DOC}.metadata"));
        std::fs::write(
            &mpath,
            r#"{"visibleName":"Old","parent":"","type":"DocumentType","lastModified":"1000","deleted":false,"version":2}"#,
        )
        .unwrap();
        let read = || -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap()
        };

        // newer cloud edit: rename + move applies, lastModified adopted, version bumped
        assert!(store.apply_doc_meta(DOC, "New", "folder1", 2000));
        let m = read();
        assert_eq!(m["visibleName"], "New");
        assert_eq!(m["parent"], "folder1");
        assert_eq!(m["lastModified"], "2000");
        assert_eq!(m["version"], 3);

        // older cloud edit: ignored (LWW keeps local)
        assert!(!store.apply_doc_meta(DOC, "Stale", "x", 1500));
        assert_eq!(read()["visibleName"], "New");

        // newer timestamp but identical name/parent: no churn
        assert!(!store.apply_doc_meta(DOC, "New", "folder1", 9999));
        assert_eq!(read()["lastModified"], "2000");

        // move-only (name unchanged, parent changes) applies
        assert!(store.apply_doc_meta(DOC, "New", "folder2", 3000));
        assert_eq!(read()["parent"], "folder2");
        assert_eq!(read()["visibleName"], "New");

        // unknown doc is never created
        assert!(!store.apply_doc_meta("ffffffff-ffff-4fff-afff-ffffffffffff", "Ghost", "", 5000));
        assert!(!store
            .xochitl_dir
            .join("ffffffff-ffff-4fff-afff-ffffffffffff.metadata")
            .exists());
    }

    #[test]
    fn apply_last_opened_is_a_max_register_bumps_version_keeps_last_modified() {
        let (_tmp, store) = store();
        let mpath = store.xochitl_dir.join(format!("{DOC}.metadata"));
        std::fs::write(
            &mpath,
            r#"{"visibleName":"T","parent":"","type":"DocumentType","lastModified":"1000","lastOpened":"5000","lastOpenedPage":0,"version":2,"deleted":false}"#,
        )
        .unwrap();
        std::fs::write(
            store.xochitl_dir.join(format!("{DOC}.content")),
            format!(
                r#"{{"formatVersion":2,"cPages":{{"lastOpened":{{"timestamp":"1:7","value":"p1"}},"pages":[
                    {{"id":"p1"}},
                    {{"id":"dead","deleted":{{"value":1}}}},
                    {{"id":"{PAGE}"}}
                ]}}}}"#
            ),
        )
        .unwrap();
        let read = |name: &str| -> serde_json::Value {
            serde_json::from_str(
                &std::fs::read_to_string(store.xochitl_dir.join(name)).unwrap(),
            )
            .unwrap()
        };

        // older or equal web open: local wins (max-register)
        assert!(!store.apply_last_opened(DOC, PAGE, 4000));
        assert!(!store.apply_last_opened(DOC, PAGE, 5000));
        assert_eq!(read(&format!("{DOC}.metadata"))["lastOpened"], "5000");

        // newer web open: applied; page pointer follows; version BUMPED (so
        // xochitl reflects it under "Last opened" sort — device-verified); but
        // lastModified UNTOUCHED (an open is a read, not an edit, so it must
        // not surface under the default "Last modified" sort)
        assert!(store.apply_last_opened(DOC, PAGE, 9000));
        let m = read(&format!("{DOC}.metadata"));
        assert_eq!(m["lastOpened"], "9000");
        assert_eq!(m["lastOpenedPage"], 1); // deleted page not counted
        assert_eq!(m["version"], 3); // was 2, bumped
        assert_eq!(m["lastModified"], "1000"); // NOT touched
        let c = read(&format!("{DOC}.content"));
        assert_eq!(c["cPages"]["lastOpened"]["value"], PAGE);
        // xochitl's sibling timestamp survives the value swap
        assert_eq!(c["cPages"]["lastOpened"]["timestamp"], "1:7");

        // self-healing convergence: xochitl clobbers the register back; the
        // next tick re-applies the same cloud value
        let mut clobbered = read(&format!("{DOC}.metadata"));
        clobbered["lastOpened"] = serde_json::Value::String("5000".into());
        std::fs::write(&mpath, serde_json::to_string(&clobbered).unwrap()).unwrap();
        assert!(store.apply_last_opened(DOC, PAGE, 9000));
        assert_eq!(read(&format!("{DOC}.metadata"))["lastOpened"], "9000");

        // absent local lastOpened = never opened locally: any real open wins;
        // a doc with no version field gets one (unwrap_or(1)+1 = 2)
        std::fs::write(
            &mpath,
            r#"{"visibleName":"T","parent":"","type":"DocumentType","lastModified":"1000","deleted":false}"#,
        )
        .unwrap();
        assert!(store.apply_last_opened(DOC, PAGE, 100));
        assert_eq!(read(&format!("{DOC}.metadata"))["version"], 2);

        // unknown page: the register still moves, pointers stay put
        let before = read(&format!("{DOC}.content"));
        assert!(store.apply_last_opened(DOC, "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb", 9500));
        assert_eq!(read(&format!("{DOC}.metadata"))["lastOpened"], "9500");
        assert_eq!(read(&format!("{DOC}.content")), before);

        // unknown doc is never created
        assert!(!store.apply_last_opened("ffffffff-ffff-4fff-afff-ffffffffffff", PAGE, 9999));
        assert!(!store
            .xochitl_dir
            .join("ffffffff-ffff-4fff-afff-ffffffffffff.metadata")
            .exists());
    }

    #[test]
    fn list_documents_reads_last_opened() {
        let (_tmp, store) = store();
        std::fs::write(
            store.xochitl_dir.join("d1.metadata"),
            r#"{"visibleName":"N","parent":"","type":"DocumentType","lastModified":"5","lastOpened":"777","deleted":false}"#,
        )
        .unwrap();
        std::fs::write(store.xochitl_dir.join("d1.content"), r#"{"pages":["a"]}"#).unwrap();
        let docs = store.list_documents();
        assert_eq!(docs[0].last_opened, Some(777));
    }

    #[test]
    fn apply_doc_meta_refuses_when_local_lastmodified_unknown() {
        let (_tmp, store) = store();
        let mpath = store.xochitl_dir.join(format!("{DOC}.metadata"));
        // a doc with no parseable lastModified: freshness unknown -> never apply
        std::fs::write(
            &mpath,
            r#"{"visibleName":"Old","parent":"","type":"DocumentType","deleted":false}"#,
        )
        .unwrap();
        assert!(!store.apply_doc_meta(DOC, "New", "f", 9_999_999_999_999));
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        assert_eq!(m["visibleName"], "Old");
    }

    #[tokio::test]
    async fn tree_patch_self_heals_on_hash_mismatch() {
        let (_tmp, store) = store();
        let rev1 = store.write_page(DOC, PAGE, "", b"v1").await.unwrap();

        // .tree claims a DIFFERENT previous hash (xochitl raced us once):
        // patch must still self-heal, else delivery stalls forever.
        let mut tree = Vec::new();
        tree.extend_from_slice(format!("{DOC}/{PAGE}.rm").as_bytes());
        tree.extend_from_slice(&[0x01, 0x00, 0x20]);
        tree.extend_from_slice(&Sha256::digest(b"something-else"));
        std::fs::write(store.xochitl_dir.join(".tree"), &tree).unwrap();

        store.write_page(DOC, PAGE, &rev1, b"v2").await.unwrap();
        assert_eq!(store.read_page(DOC, PAGE).unwrap().0, b"v2");
        // the index SELF-HEALS: the entry now carries sha256(v2)
        let patched = std::fs::read(store.xochitl_dir.join(".tree")).unwrap();
        let off = patched.len() - 32;
        assert_eq!(&patched[off..], Sha256::digest(b"v2").as_slice());
    }

    #[test]
    fn list_documents_v2_content() {
        let (_tmp, store) = store();
        let meta = |name: &str, parent: &str, kind: &str, deleted: bool| {
            format!(
                r#"{{"visibleName":"{name}","parent":"{parent}","type":"{kind}","lastModified":"5","deleted":{deleted}}}"#
            )
        };
        let x = &store.xochitl_dir;
        std::fs::write(x.join("f1.metadata"), meta("Folder", "", "CollectionType", false)).unwrap();
        std::fs::write(x.join("d1.metadata"), meta("Notes", "f1", "DocumentType", false)).unwrap();
        std::fs::write(
            x.join("d1.content"),
            r#"{"formatVersion":2,"cPages":{"lastOpened":{"value":"p2"},"pages":[
                {"id":"p1","template":{"value":"P Lines small"}},
                {"id":"p2","template":{"value":"Blank"}},
                {"id":"gone","deleted":{"value":1}}
            ]}}"#,
        )
        .unwrap();
        std::fs::write(x.join("trashed.metadata"), meta("Gone", "trash", "DocumentType", false)).unwrap();
        std::fs::write(x.join("deleted.metadata"), meta("Del", "", "DocumentType", true)).unwrap();
        std::fs::write(x.join("pdf1.metadata"), meta("Paper", "", "DocumentType", false)).unwrap();
        std::fs::write(
            x.join("pdf1.content"),
            r#"{"fileType":"pdf","formatVersion":2,"cPages":{"pages":[{"id":"q1","redir":{"value":3}}]}}"#,
        )
        .unwrap();

        let mut docs = store.list_documents();
        docs.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = docs.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["d1", "f1", "pdf1"]); // trash + deleted excluded

        let d1 = &docs[0];
        assert_eq!(d1.kind, "notebook");
        assert_eq!(d1.parent, "f1");
        assert_eq!(d1.last_opened_page.as_deref(), Some("p2"));
        let page_ids: Vec<_> = d1.pages.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(page_ids, vec!["p1", "p2"]); // deleted page excluded
        assert_eq!(d1.pages[0].template.as_deref(), Some("P Lines small"));
        assert_eq!(d1.pages[1].template, None); // "Blank" filtered

        assert_eq!(docs[1].kind, "folder");

        let pdf = &docs[2];
        assert_eq!(pdf.kind, "pdf");
        assert_eq!(pdf.pages[0].file_index, Some(3));
    }

    #[test]
    fn rejects_path_traversal_segments() {
        let (_tmp, store) = store();
        for bad in ["..", "../etc", "a/b", "a\\b", "..%2f", ""] {
            // the literal "/" and ".." are what we must reject in fs segments
            assert!(store.read_page(bad, "p").is_none(), "read_page allowed {bad}");
            assert!(store.read_page("d", bad).is_none(), "read_page allowed {bad}");
        }
    }

    #[tokio::test]
    async fn write_page_rejects_traversal() {
        let (_tmp, store) = store();
        assert!(store.write_page("../../tmp/pwned", "evil", "", b"x").await.is_err());
    }

    #[test]
    fn asset_filename_allowlist() {
        assert!(valid_asset_filename("5f80365d-972e-415d-8030-6f4dee13ac92.png"));
        assert!(valid_asset_filename("photo_1.jpg"));
        assert!(valid_asset_filename("a.jpeg"));
        assert!(!valid_asset_filename("../../etc/passwd.png"));
        assert!(!valid_asset_filename("a/b.png"));
        assert!(!valid_asset_filename("x.svg"));
        assert!(!valid_asset_filename(".png"));
        assert!(!valid_asset_filename("noext"));
        assert!(!valid_asset_filename(&format!("{}.png", "a".repeat(65))));
    }

    #[test]
    fn list_documents_v1_pages_array() {
        let (_tmp, store) = store();
        std::fs::write(
            store.xochitl_dir.join("old.metadata"),
            r#"{"visibleName":"Old","parent":"","type":"DocumentType","deleted":false}"#,
        )
        .unwrap();
        std::fs::write(store.xochitl_dir.join("old.content"), r#"{"pages":["a","b"]}"#).unwrap();

        let docs = store.list_documents();
        assert_eq!(docs.len(), 1);
        let pages = &docs[0].pages;
        assert_eq!(pages.len(), 2);
        // v1: fileIndex is the position in the array
        assert_eq!(pages[0].file_index, Some(0));
        assert_eq!(pages[1].file_index, Some(1));
    }
}

#[cfg(test)]
mod template_tests {
    use super::*;
    use tempfile::TempDir;

    const DOC: &str = "11111111-1111-4111-a111-111111111111";
    const PAGE: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

    fn empty_store() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let xochitl = dir.path().join("xochitl");
        std::fs::create_dir_all(&xochitl).unwrap();
        let s = Store::new(xochitl);
        (dir, s)
    }

    fn store_with_doc(local_lm: u64) -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let xochitl = dir.path().join("xochitl");
        std::fs::create_dir_all(&xochitl).unwrap();
        std::fs::write(
            xochitl.join(format!("{DOC}.metadata")),
            format!(r#"{{"visibleName":"Doc","parent":"","lastModified":"{local_lm}","version":3}}"#),
        )
        .unwrap();
        // v2 content: one live page with an existing template object carrying
        // a generation timestamp (xochitl's shape) + one deleted page.
        std::fs::write(
            xochitl.join(format!("{DOC}.content")),
            format!(
                r#"{{"formatVersion":2,"cPages":{{"pages":[
                    {{"id":"{PAGE}","template":{{"timestamp":"1:2","value":"Blank"}}}},
                    {{"id":"dead-page","deleted":{{"value":1}},"template":{{"value":"Blank"}}}}
                ]}}}}"#
            ),
        )
        .unwrap();
        (dir, Store::new(xochitl))
    }

    fn read_json(dir: &TempDir, name: &str) -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("xochitl").join(name)).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn newer_cloud_edit_applies_and_preserves_the_timestamp() {
        let (dir, s) = store_with_doc(1000);
        assert!(s.apply_page_template(DOC, PAGE, "P Grid large", 2000).unwrap());
        let content = read_json(&dir, &format!("{DOC}.content"));
        let entry = &content["cPages"]["pages"][0];
        assert_eq!(entry["template"]["value"], "P Grid large");
        // xochitl's generation marker survives the edit
        assert_eq!(entry["template"]["timestamp"], "1:2");
        // metadata bumped so xochitl reloads + the next push carries fresh LWW
        let meta = read_json(&dir, &format!("{DOC}.metadata"));
        let lm: u64 = meta["lastModified"].as_str().unwrap().parse().unwrap();
        assert!(lm > 1000);
    }

    #[test]
    fn stale_or_equal_cloud_edit_is_refused() {
        let (dir, s) = store_with_doc(5000);
        assert!(!s.apply_page_template(DOC, PAGE, "P Grid large", 5000).unwrap());
        assert!(!s.apply_page_template(DOC, PAGE, "P Grid large", 4000).unwrap());
        let content = read_json(&dir, &format!("{DOC}.content"));
        assert_eq!(content["cPages"]["pages"][0]["template"]["value"], "Blank");
    }

    #[test]
    fn same_value_is_a_noop_without_metadata_bump() {
        let (dir, s) = store_with_doc(1000);
        assert!(!s.apply_page_template(DOC, PAGE, "Blank", 2000).unwrap());
        let meta = read_json(&dir, &format!("{DOC}.metadata"));
        assert_eq!(meta["lastModified"], "1000");
    }

    #[test]
    fn unknown_doc_page_and_deleted_pages_are_never_touched() {
        let (dir, s) = store_with_doc(1000);
        assert!(s.apply_page_template("22222222-2222-4222-a222-222222222222", PAGE, "X", 2000).is_err());
        assert!(s.apply_page_template(DOC, "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb", "X", 2000).is_err());
        assert!(s.apply_page_template(DOC, "dead-page", "X", 2000).is_err());
        let content = read_json(&dir, &format!("{DOC}.content"));
        assert_eq!(content["cPages"]["pages"][1]["template"]["value"], "Blank");
    }

    #[test]
    fn v1_content_without_cpages_is_refused() {
        let (dir, s) = store_with_doc(1000);
        std::fs::write(
            dir.path().join("xochitl").join(format!("{DOC}.content")),
            format!(r#"{{"pages":["{PAGE}"]}}"#),
        )
        .unwrap();
        assert!(s.apply_page_template(DOC, PAGE, "P Grid large", 2000).is_err());
    }

    #[test]
    fn page_without_a_template_object_gets_one() {
        let (dir, s) = store_with_doc(1000);
        std::fs::write(
            dir.path().join("xochitl").join(format!("{DOC}.content")),
            format!(r#"{{"formatVersion":2,"cPages":{{"pages":[{{"id":"{PAGE}"}}]}}}}"#),
        )
        .unwrap();
        assert!(s.apply_page_template(DOC, PAGE, "P Lines small", 2000).unwrap());
        let content = read_json(&dir, &format!("{DOC}.content"));
        assert_eq!(content["cPages"]["pages"][0]["template"]["value"], "P Lines small");
    }

    #[test]
    fn create_notebook_round_trips_through_list_documents() {
        let (_dir, s) = empty_store();
        assert!(s.create_notebook(DOC, "My Notes", "", PAGE, "Blank"));
        // idempotent: a second create is a no-op (doc already exists)
        assert!(!s.create_notebook(DOC, "My Notes", "", PAGE, "Blank"));
        let docs = s.list_documents();
        let d = docs.iter().find(|d| d.id == DOC).expect("notebook listed");
        assert_eq!(d.name, "My Notes");
        assert_eq!(d.kind, "notebook");
        assert_eq!(d.parent, "");
        assert_eq!(d.pages.len(), 1);
        assert_eq!(d.pages[0].id, PAGE);
        // the daemon's own parser resolves the cover to the first page
        assert_eq!(d.cover_page.as_deref(), Some(PAGE));
        // a Blank template surfaces as None (not the literal "Blank")
        assert_eq!(d.pages[0].template, None);
    }

    #[test]
    fn create_notebook_with_template_surfaces_it() {
        let (_dir, s) = empty_store();
        assert!(s.create_notebook(DOC, "Grid", "folder1", PAGE, "P Grid large"));
        let docs = s.list_documents();
        let d = docs.iter().find(|d| d.id == DOC).unwrap();
        assert_eq!(d.parent, "folder1");
        assert_eq!(d.pages[0].template.as_deref(), Some("P Grid large"));
    }

    #[test]
    fn create_folder_round_trips_as_a_collection() {
        let (_dir, s) = empty_store();
        assert!(s.create_folder(DOC, "Projects", ""));
        assert!(!s.create_folder(DOC, "Projects", "")); // idempotent
        let docs = s.list_documents();
        let d = docs.iter().find(|d| d.id == DOC).expect("folder listed");
        assert_eq!(d.name, "Projects");
        assert_eq!(d.kind, "folder");
        assert!(d.pages.is_empty());
    }

    #[test]
    fn created_metadata_matches_real_device_schema() {
        // xochitl only LISTS a doc whose .metadata is the exact real shape:
        // has new/source, and NONE of the pending-sync flags (device-verified).
        let (dir, s) = empty_store();
        assert!(s.create_folder(DOC, "F", ""));
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("xochitl").join(format!("{DOC}.metadata"))).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["type"], "CollectionType");
        assert_eq!(meta["new"], false);
        assert_eq!(meta["source"], "");
        for junk in ["deleted", "synced", "modified", "metadatamodified", "version"] {
            assert!(meta.get(junk).is_none(), "folder .metadata must NOT carry {junk}");
        }
        let page = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
        assert!(s.create_notebook("22222222-2222-4222-a222-222222222222", "N", "", page, "Blank"));
        let nm: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("xochitl").join("22222222-2222-4222-a222-222222222222.metadata")).unwrap(),
        )
        .unwrap();
        assert_eq!(nm["type"], "DocumentType");
        assert_eq!(nm["new"], false);
        assert_eq!(nm["source"], "");
        for junk in ["deleted", "synced", "modified", "metadatamodified", "version"] {
            assert!(nm.get(junk).is_none(), "notebook .metadata must NOT carry {junk}");
        }
    }

    #[test]
    fn create_refuses_unsafe_ids_and_never_clobbers() {
        let (_dir, s) = empty_store();
        assert!(!s.create_notebook("../evil", "x", "", PAGE, "Blank"));
        assert!(!s.create_folder("a/b", "x", ""));
        // an existing doc is never overwritten by create_*
        assert!(s.create_folder(DOC, "First", ""));
        assert!(!s.create_notebook(DOC, "Second", "", PAGE, "Blank"));
        let docs = s.list_documents();
        assert_eq!(docs.iter().find(|d| d.id == DOC).unwrap().name, "First");
    }
}
