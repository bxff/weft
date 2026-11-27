//! One recovery generation per page, deliberately separate from the native
//! notebook and from the ordinary sync cursor.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{self, Read};
use std::os::unix::fs::DirBuilderExt;
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

const CHECKPOINT_LIMIT: usize = 16 * 1024 * 1024;
const CHECKPOINT_PREFIX: &[u8] = br#"{"checkpointSha256":""#;

fn encode_manifest(payload: &[u8]) -> io::Result<Vec<u8>> {
    let extra = CHECKPOINT_PREFIX.len() + 64 + 2;
    if payload.first() != Some(&b'{') || payload.len().saturating_add(extra - 1) > CHECKPOINT_LIMIT
    {
        return Err(io::Error::other("invalid or oversized checkpoint manifest"));
    }
    let digest = sha256_hex(payload);
    let mut manifest = Vec::with_capacity(payload.len() + extra - 1);
    manifest.extend_from_slice(CHECKPOINT_PREFIX);
    manifest.extend_from_slice(digest.as_bytes());
    manifest.extend_from_slice(b"\",");
    manifest.extend_from_slice(&payload[1..]);
    Ok(manifest)
}

fn verified_payload(manifest: &mut [u8]) -> Option<&[u8]> {
    // Serialize the checksum first, so validation hashes the exact UTF-8 bytes
    // rather than reserializing a parsed object in another language.
    if manifest.len() > CHECKPOINT_LIMIT || !manifest.starts_with(CHECKPOINT_PREFIX) {
        return None;
    }
    let checksum_end = CHECKPOINT_PREFIX.len() + 64;
    let (prefix, payload) = manifest.split_at_mut_checked(checksum_end + 1)?;
    let expected = std::str::from_utf8(prefix.get(CHECKPOINT_PREFIX.len()..checksum_end)?).ok()?;
    if !is_digest(expected) || prefix[checksum_end] != b'"' || payload.first() != Some(&b',') {
        return None;
    }
    payload[0] = b'{';
    (sha256_hex(payload) == expected).then_some(payload)
}

pub(crate) fn load(dir: &Path) -> Option<Checkpoint> {
    let mut file = std::fs::File::open(dir.join("checkpoint.json"))
        .ok()?
        .take(CHECKPOINT_LIMIT as u64 + 1);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let saved: Checkpoint = serde_json::from_slice(verified_payload(&mut bytes)?).ok()?;
    (saved.version == 1
        && saved.head.valid()
        && dir
            .join(format!("{}.rm", saved.head.native_sha256))
            .is_file())
    .then_some(saved)
}

const STORAGE_LIMIT: u64 = 256 * 1024 * 1024;

fn disk_bytes(path: &Path) -> io::Result<u64> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return Err(io::Error::other("symlink in recovery storage"));
    }
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    std::fs::read_dir(path)?.try_fold(0u64, |total, child| {
        Ok(total.saturating_add(disk_bytes(&child?.path())?))
    })
}

/// Budget across relay identities; startup scans only file metadata, then each
/// operation accounts for its one page directory. Never evict a backup.
pub(crate) struct Budget {
    used: u64,
    limit: u64,
}

impl Budget {
    pub(crate) fn open(root: &Path) -> io::Result<Self> {
        Ok(Self {
            used: disk_bytes(root)?,
            limit: STORAGE_LIMIT,
        })
    }

    fn write<T>(
        &mut self,
        dir: &Path,
        staged_bytes: u64,
        f: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        if self.used.saturating_add(staged_bytes) > self.limit {
            return Err(io::Error::other("tablet recovery storage budget exhausted"));
        }
        let before = disk_bytes(dir)?;
        let result = f();
        // Even an interrupted or partially failed commit might have written a
        // file. An accounting error disables additional writes, not backups.
        self.used = match disk_bytes(dir) {
            Ok(after) => self.used.saturating_sub(before).saturating_add(after),
            Err(_) => self.limit,
        };
        result
    }
}

fn file_has_digest(path: &Path, digest: &str) -> bool {
    use sha2::{Digest, Sha256};
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if !meta.is_file() || meta.len() > STORAGE_LIMIT {
        return false;
    }
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        match file.read(&mut buf) {
            Ok(0) => return hex::encode(hasher.finalize()) == digest,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
}

pub(crate) fn verify_files(dir: &Path, assets_dir: &Path, saved: &Checkpoint) -> bool {
    let head = &saved.head;
    file_has_digest(
        &dir.join(format!("{}.rm", head.native_sha256)),
        &head.native_sha256,
    ) && verify_assets(dir, assets_dir, saved)
}

pub(crate) fn verify_assets(dir: &Path, assets_dir: &Path, saved: &Checkpoint) -> bool {
    saved.head.assets.iter().all(|asset| {
        file_has_digest(&assets_dir.join(&asset.name), &asset.sha256)
            || file_has_digest(&dir.join(format!("{}.asset", asset.sha256)), &asset.sha256)
    })
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
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(e) => return Err(e),
    }
    std::fs::File::open(parent)?.sync_all()
}

/// Keep an exact fallback only when normal sync is about to replace a
/// previously protected native resource under the same name. The old
/// checkpoint must survive if the new one cannot be committed afterwards.
pub(crate) fn preserve_asset(
    dir: &Path,
    hash: &str,
    path: &Path,
    budget: Option<&mut Budget>,
) -> io::Result<()> {
    if !is_digest(hash) {
        return Err(io::Error::other("invalid recovery asset digest"));
    }
    let bytes = std::fs::read(path)?;
    if sha256_hex(&bytes) != hash {
        return Err(io::Error::other("asset changed before replacement"));
    }
    let destination = dir.join(format!("{hash}.asset"));
    if file_has_digest(&destination, hash) {
        return Ok(());
    }
    let write = || {
        create_durable_dir(dir)?;
        atomic_write(&destination, &bytes)?;
        std::fs::File::open(dir)?.sync_all()
    };
    match budget {
        Some(budget) => budget.write(dir, bytes.len() as u64, write),
        None => write(),
    }
}

pub(crate) fn commit(
    dir: &Path,
    checkpoint: Checkpoint,
    native: &[u8],
    budget: Option<&mut Budget>,
) -> io::Result<()> {
    if checkpoint.version != 1
        || !checkpoint.head.valid()
        || sha256_hex(native) != checkpoint.head.native_sha256
    {
        return Err(io::Error::other("invalid recovery checkpoint"));
    }
    let base = format!("{}.rm", checkpoint.head.native_sha256);
    let base_path = dir.join(&base);
    let needs_base = !file_has_digest(&base_path, &checkpoint.head.native_sha256);
    let manifest = encode_manifest(&serde_json::to_vec(&checkpoint)?)?;
    let staged_bytes = manifest.len() as u64 + if needs_base { native.len() as u64 } else { 0 };
    let write = || {
        create_durable_dir(dir)?;
        // A native page may change as soon as xochitl accepts another edit.
        // Keep the exact observed causal base, reusing it for overlay-only updates.
        if needs_base {
            atomic_write(&base_path, native)?;
            std::fs::File::open(dir)?.sync_all()?;
        }
        atomic_write(&dir.join("checkpoint.json"), &manifest)?;
        std::fs::File::open(dir)?.sync_all()?;
        remove_obsolete(dir, &checkpoint, &base);
        Ok(())
    };
    match budget {
        Some(budget) => budget.write(dir, staged_bytes, write),
        None => write(),
    }
}

fn remove_obsolete(dir: &Path, checkpoint: &Checkpoint, base: &str) {
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
        commit(&dir, checkpoint(native, 1), native, None).unwrap();
        commit(&dir, checkpoint(native, 2), native, None).unwrap();
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
        commit(root.path(), checkpoint(b"good", 1), b"good", None).unwrap();
        assert!(commit(root.path(), checkpoint(b"new", 2), b"bad", None).is_err());
        assert_eq!(load(root.path()).unwrap().head.snapshot_seq, 1);
    }

    #[test]
    fn budget_counts_other_link_bytes_and_leaves_previous_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let previous_link = root.path().join("previous");
        std::fs::write(&previous_link, b"previous link data").unwrap();
        let mut budget = Budget::open(root.path()).unwrap();
        assert_eq!(budget.used, 18);
        let dir = root.path().join("link").join("doc").join("page");
        commit(&dir, checkpoint(b"good", 1), b"good", Some(&mut budget)).unwrap();
        assert_eq!(budget.used, disk_bytes(root.path()).unwrap());
        budget.limit = budget.used;
        assert!(commit(&dir, checkpoint(b"new", 2), b"new", Some(&mut budget)).is_err());
        assert_eq!(load(&dir).unwrap().head.snapshot_seq, 1);
        assert_eq!(
            std::fs::read(&previous_link).unwrap(),
            b"previous link data"
        );
    }

    #[test]
    fn checkpoint_checksum_hashes_exact_utf8_bytes() {
        let payload = r#"{"overlay":{"shapes":["é🙂"]}}"#.as_bytes();
        let mut manifest = encode_manifest(payload).unwrap();
        assert_eq!(
            std::str::from_utf8(&manifest).unwrap(),
            r#"{"checkpointSha256":"71f0ea1f417157863a3c5dabeef871029a2b8f068862df1a52f28cbb12469e11","overlay":{"shapes":["é🙂"]}}"#
        );
        assert_eq!(verified_payload(&mut manifest), Some(payload));
        assert!(verified_payload(&mut payload.to_vec()).is_none());
        assert!(verified_payload(&mut b"{\"checkpointSha256\":\"".to_vec()).is_none());
        assert!(encode_manifest(&vec![b'{'; CHECKPOINT_LIMIT]).is_err());
    }
}
