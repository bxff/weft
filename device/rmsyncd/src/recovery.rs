//! One recovery generation per page, deliberately separate from the native
//! notebook and from the ordinary sync cursor.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use crate::store::{atomic_write, safe_id, sha256_hex, valid_asset_filename};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AssetDigest {
    pub name: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Head {
    pub revision: String,
    pub snapshot_seq: u64,
    pub op_seq: u64,
    pub native_sha256: String,
    pub overlay: serde_json::Value,
    pub assets: Vec<AssetDigest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Response {
    #[serde(flatten)]
    pub head: Head,
    pub native_base64: Option<String>,
    pub asset_revision: String,
    #[serde(default)]
    pub missing_assets: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Checkpoint {
    pub version: u32,
    pub etag: String,
    pub asset_revision: String,
    #[serde(flatten)]
    pub head: Head,
}

pub(crate) fn is_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Head {
    pub(crate) fn valid(&self) -> bool {
        let mut seen = HashSet::with_capacity(self.assets.len());
        !self.revision.is_empty()
            && is_digest(&self.native_sha256)
            && self
                .overlay
                .get("shapes")
                .is_some_and(|shapes| shapes.is_array())
            && self.assets.iter().all(|a| {
                valid_asset_filename(&a.name) && is_digest(&a.sha256) && seen.insert(&a.name)
            })
    }
}

pub(crate) fn page_dir(root: &Path, doc: &str, page: &str) -> Option<PathBuf> {
    (safe_id(doc) && safe_id(page)).then(|| root.join(doc).join(page))
}

pub(crate) fn load(dir: &Path) -> Option<Checkpoint> {
    let saved: Checkpoint =
        serde_json::from_slice(&std::fs::read(dir.join("checkpoint.json")).ok()?).ok()?;
    (saved.version == 1 && saved.head.valid()).then_some(saved)
}

// Fsync parent directories as the new tree is created, since syncing only the
// leaf does not make a newly-created ancestor directory durable after a crash.
fn create_durable_dir(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("recovery path has no parent"))?;
    create_durable_dir(parent)?;
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(e) => return Err(e),
    }
    std::fs::File::open(parent)?.sync_all()
}

/// Keep an exact fallback only when normal sync is about to replace a
/// previously protected native resource under the same name. The old
/// checkpoint must survive if the new one cannot be committed afterwards.
pub(crate) fn preserve_asset(dir: &Path, hash: &str, path: &Path) -> io::Result<()> {
    if !is_digest(hash) {
        return Err(io::Error::other("invalid recovery asset digest"));
    }
    let bytes = std::fs::read(path)?;
    if sha256_hex(&bytes) != hash {
        return Err(io::Error::other("asset changed before replacement"));
    }
    create_durable_dir(dir)?;
    atomic_write(&dir.join(format!("{hash}.asset")), &bytes)?;
    std::fs::File::open(dir)?.sync_all()
}

pub(crate) fn commit(dir: &Path, checkpoint: Checkpoint, native: &[u8]) -> io::Result<()> {
    if checkpoint.version != 1
        || !checkpoint.head.valid()
        || sha256_hex(native) != checkpoint.head.native_sha256
    {
        return Err(io::Error::other("invalid recovery checkpoint"));
    }
    create_durable_dir(dir)?;
    let base = format!("{}.rm", checkpoint.head.native_sha256);
    let base_path = dir.join(&base);
    // A native page may change as soon as xochitl accepts another edit.
    // Keep the exact observed causal base, reusing it for overlay-only updates.
    if !std::fs::read(&base_path)
        .is_ok_and(|bytes| sha256_hex(&bytes) == checkpoint.head.native_sha256)
    {
        atomic_write(&base_path, native)?;
        std::fs::File::open(dir)?.sync_all()?;
    }
    atomic_write(
        &dir.join("checkpoint.json"),
        &serde_json::to_vec(&checkpoint)?,
    )?;
    std::fs::File::open(dir)?.sync_all()?;
    // Cleanup only after the new manifest is durable. Also tidies a base
    // staged before a previous interrupted commit.
    // Cleanup errors do not retroactively make the committed state invalid.
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let obsolete_base = name != base && name.strip_suffix(".rm").is_some_and(is_digest);
        let obsolete_asset = name.strip_suffix(".asset").is_some_and(|hash| {
            is_digest(hash)
                && !checkpoint
                    .head
                    .assets
                    .iter()
                    .any(|asset| asset.sha256 == hash)
        });
        if obsolete_base || obsolete_asset {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn checkpoint(bytes: &[u8], snapshot: u64) -> Checkpoint {
        Checkpoint {
            version: 1,
            asset_revision: "asset-test".into(),
            etag: format!("\"{snapshot}\""),
            head: Head {
                revision: format!("ops:3+{snapshot}"),
                snapshot_seq: snapshot,
                op_seq: 3,
                native_sha256: sha256_hex(bytes),
                overlay: json!({"shapes":[{"props":{"weftArrowLinks":[{"toId":"shape:target"}]}}]}),
                assets: Vec::new(),
            },
        }
    }

    #[test]
    fn overlay_only_checkpoint_preserves_unknown_arrow_props_and_reuses_base() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("doc").join("page");
        let native = b"native bytes";
        commit(&dir, checkpoint(native, 1), native).unwrap();
        commit(&dir, checkpoint(native, 2), native).unwrap();
        let saved = load(&dir).unwrap();
        assert_eq!(saved.head.op_seq, 3);
        assert_eq!(saved.head.snapshot_seq, 2);
        assert_eq!(
            saved.head.overlay["shapes"][0]["props"]["weftArrowLinks"][0]["toId"],
            "shape:target"
        );
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), 2);
    }

    #[test]
    fn invalid_new_base_does_not_supersede_last_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        commit(root.path(), checkpoint(b"good", 1), b"good").unwrap();
        assert!(commit(root.path(), checkpoint(b"new", 2), b"bad").is_err());
        assert_eq!(load(root.path()).unwrap().head.snapshot_seq, 1);
    }
}
