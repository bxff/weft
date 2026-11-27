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
        self.account_write(dir, f)
    }

    fn account_write<T>(&mut self, dir: &Path, f: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
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

pub(crate) fn verify_files(dir: &Path, saved: &Checkpoint) -> bool {
    let head = &saved.head;
    file_has_digest(
        &dir.join(format!("{}.rm", head.native_sha256)),
        &head.native_sha256,
    ) && verify_assets(dir, saved)
}

fn verify_assets(dir: &Path, saved: &Checkpoint) -> bool {
    saved
        .head
        .assets
        .iter()
        .all(|asset| has_asset(dir, &asset.sha256))
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

pub(crate) fn has_asset(dir: &Path, hash: &str) -> bool {
    is_digest(hash) && file_has_digest(&dir.join(format!("{hash}.asset")), hash)
}

/// Stage a verified asset in the existing recovery bundle format. The live
/// notebook is never the destination of a recovery fetch.
pub(crate) fn save_asset(
    dir: &Path,
    hash: &str,
    bytes: &[u8],
    budget: Option<&mut Budget>,
) -> io::Result<()> {
    if !is_digest(hash) || sha256_hex(bytes) != hash {
        return Err(io::Error::other("invalid recovery asset digest"));
    }
    let name = format!("{hash}.asset");
    if has_asset(dir, hash) {
        return Ok(());
    }
    let write = || {
        create_durable_dir(dir)?;
        write_recovery_file(dir, &name, bytes)?;
        std::fs::File::open(dir)?.sync_all()
    };
    match budget {
        Some(budget) => budget.write(dir, bytes.len() as u64, write),
        None => write(),
    }
}

/// Discard only this attempt's new assets that neither the old manifest nor
/// any manifest currently on disk references. A late commit fsync failure may
/// already have renamed the new manifest, so re-read before deleting anything.
pub(crate) fn discard_staged_assets(
    dir: &Path,
    old: Option<&Checkpoint>,
    staged: &[String],
    budget: Option<&mut Budget>,
) {
    let current = load(dir);
    if current.is_none()
        && !matches!(dir.join("checkpoint.json").symlink_metadata(),
        Err(e) if e.kind() == io::ErrorKind::NotFound)
    {
        // An unreadable manifest might be the newly renamed one.
        return;
    }
    let discard = || {
        for hash in staged {
            if !is_digest(hash)
                || old.into_iter().chain(current.as_ref()).any(|checkpoint| {
                    checkpoint
                        .head
                        .assets
                        .iter()
                        .any(|asset| asset.sha256 == *hash)
                })
            {
                continue;
            }
            let _ = std::fs::remove_file(dir.join(format!("{hash}.asset")));
        }
        Ok(())
    };
    let _ = match budget {
        Some(budget) => budget.account_write(dir, discard),
        None => discard(),
    };
}

/// Lazily reclaim completed files left by a stopped process. Never walk
/// outside this page, remove unknown or temporary names, or guess what an
/// absent, invalid or incomplete manifest might have protected.
pub(crate) fn reclaim_interrupted_page(dir: &Path, budget: &mut Budget) -> io::Result<()> {
    const MAX_ENTRIES: usize = 512;
    const MAX_HASH_BYTES: u64 = 32 * 1024 * 1024;
    let manifest = dir.join("checkpoint.json");
    if !dir.symlink_metadata()?.is_dir() || !manifest.symlink_metadata()?.is_file() {
        return Ok(());
    }
    let Some(saved) = load(dir) else {
        return Ok(());
    };
    // Include the retained generation in this pass's byte cap. The caller
    // serializes captures and reclaims for this page under one daemon; none of
    // these files are in the live editor's tree.
    let retained_bytes = std::iter::once(format!("{}.rm", saved.head.native_sha256))
        .chain(
            saved
                .head
                .assets
                .iter()
                .map(|asset| format!("{}.asset", asset.sha256)),
        )
        .try_fold(0_u64, |total, name| {
            let meta = dir.join(name).symlink_metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let total = total.saturating_add(meta.len());
            (total <= MAX_HASH_BYTES).then_some(total)
        });
    let Some(retained_bytes) = retained_bytes else {
        return Ok(());
    };
    let mut left_to_hash = MAX_HASH_BYTES - retained_bytes;
    let mut candidates = Vec::new();
    for (i, entry) in std::fs::read_dir(dir)?.enumerate() {
        if i >= MAX_ENTRIES {
            return Ok(());
        }
        let entry = entry?;
        let file = entry.file_name();
        let Some(file) = file.to_str() else { continue };
        let orphan = file
            .strip_suffix(".rm")
            .filter(|hash| *hash != saved.head.native_sha256)
            .or_else(|| {
                file.strip_suffix(".asset")
                    .filter(|hash| !saved.head.assets.iter().any(|asset| asset.sha256 == *hash))
            });
        if let Some(hash) = orphan.filter(|hash| is_digest(hash)) {
            let path = entry.path();
            let meta = path.symlink_metadata()?;
            if meta.is_file() && meta.len() <= left_to_hash {
                left_to_hash -= meta.len();
                if file_has_digest(&path, hash) {
                    candidates.push((path, meta.len()));
                }
            }
        }
    }
    if candidates.is_empty() || !verify_files(dir, &saved) {
        return Ok(());
    }
    // If the prior process failed after rename, force the still-visible
    // manifest to be durable before removing files an earlier one may need.
    let folder = std::fs::File::open(dir)?;
    folder.sync_all()?;
    let mut removed_bytes = 0_u64;
    for (path, len) in candidates {
        std::fs::remove_file(path)?;
        removed_bytes += len;
    }
    folder.sync_all()?;
    // Credit only successfully unlinked, durably absent files. Failure
    // overcounts until restart rather than risking extra writes, and does
    // not require a recursive rescan of unknown children.
    budget.used = budget.used.saturating_sub(removed_bytes);
    Ok(())
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
        || !verify_assets(dir, &checkpoint)
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
        // Only retire a base created by this attempt, never a pre-existing
        // file or the base referenced by the last successfully read manifest.
        let new_base = matches!(base_path.symlink_metadata(), Err(e) if e.kind() == io::ErrorKind::NotFound)
            && load(dir).is_none_or(|old| old.head.native_sha256 != checkpoint.head.native_sha256);
        let mut base_installed = false;
        let mut manifest_renamed = false;
        let publish = (|| {
            // Keep the exact observed causal base, reusing it for overlay-only updates.
            if needs_base {
                write_recovery_file(dir, &base, native)?;
                base_installed = true;
                std::fs::File::open(dir)?.sync_all()?;
            }
            write_recovery_file(dir, "checkpoint.json", &manifest)?;
            manifest_renamed = true;
            std::fs::File::open(dir)?.sync_all()?;
            remove_obsolete(dir, &checkpoint, &base);
            Ok(())
        })();
        // If the manifest was renamed, keep both generations even if the
        // final fsync failed: either manifest can survive a power loss.
        if publish.is_err() && new_base && base_installed && !manifest_renamed {
            let _ = std::fs::remove_file(&base_path);
        }
        publish
    };
    match budget {
        Some(budget) => budget.write(dir, staged_bytes, write),
        None => write(),
    }
}

fn write_recovery_file(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    if let Err(error) = atomic_write(&dir.join(name), bytes) {
        let _ = std::fs::remove_file(dir.join(format!(".weft-tmp-{name}")));
        return Err(error);
    }
    Ok(())
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
    fn failed_asset_attempt_reclaims_budget_without_touching_the_committed_generation() {
        let disk = tempfile::tempdir().unwrap();
        let dir = disk.path().join("page");
        let old = b"old";
        let old_hash = sha256_hex(old);
        let mut saved = checkpoint(b"base", 1);
        saved.head.assets.push(AssetDigest {
            name: "image.png".into(),
            sha256: old_hash.clone(),
        });
        let mut budget = Budget::open(disk.path()).unwrap();
        save_asset(&dir, &old_hash, old, Some(&mut budget)).unwrap();
        commit(&dir, saved, b"base", Some(&mut budget)).unwrap();
        let baseline = budget.used;
        let new = b"new";
        let new_hash = sha256_hex(new);
        let other = b"other";
        let other_hash = sha256_hex(other);
        budget.limit = budget.used + new.len() as u64;
        save_asset(&dir, &new_hash, new, Some(&mut budget)).unwrap();
        assert!(save_asset(&dir, &other_hash, other, Some(&mut budget)).is_err());
        discard_staged_assets(
            &dir,
            None,
            &[old_hash.clone(), new_hash.clone(), other_hash],
            Some(&mut budget),
        );
        assert!(verify_files(&dir, &load(&dir).unwrap()));
        assert!(has_asset(&dir, &old_hash));
        assert!(!has_asset(&dir, &new_hash));
        assert_eq!(budget.used, baseline);
        save_asset(&dir, &new_hash, new, Some(&mut budget)).unwrap();
    }

    #[test]
    fn failed_manifest_reclaims_new_native_and_asset_at_exact_budget() {
        let disk = tempfile::tempdir().unwrap();
        let dir = disk.path().join("page");
        let mut budget = Budget::open(disk.path()).unwrap();
        commit(
            &dir,
            checkpoint(b"old native", 1),
            b"old native",
            Some(&mut budget),
        )
        .unwrap();
        let old = load(&dir).unwrap();
        let baseline = budget.used;
        let new_native = b"new native";
        let new_asset = b"new asset";
        let asset_hash = sha256_hex(new_asset);
        let next = || {
            let mut value = checkpoint(new_native, 2);
            value.head.assets.push(AssetDigest {
                name: "image.png".into(),
                sha256: asset_hash.clone(),
            });
            value
        };
        let manifest_len = encode_manifest(&serde_json::to_vec(&next()).unwrap())
            .unwrap()
            .len();
        budget.limit = baseline + (new_native.len() + new_asset.len() + manifest_len) as u64;
        let blocked = dir.join(".weft-tmp-checkpoint.json");
        std::fs::create_dir(&blocked).unwrap();
        save_asset(&dir, &asset_hash, new_asset, Some(&mut budget)).unwrap();
        assert!(commit(&dir, next(), new_native, Some(&mut budget)).is_err());
        discard_staged_assets(&dir, Some(&old), &[asset_hash.clone()], Some(&mut budget));
        assert_eq!(budget.used, baseline);
        assert_eq!(load(&dir).unwrap().etag, old.etag);
        assert!(verify_files(&dir, &old));
        assert!(!dir.join(format!("{}.rm", sha256_hex(new_native))).exists());
        assert!(!has_asset(&dir, &asset_hash));
        std::fs::remove_dir(&blocked).unwrap();
        save_asset(&dir, &asset_hash, new_asset, Some(&mut budget)).unwrap();
        commit(&dir, next(), new_native, Some(&mut budget)).unwrap();
        assert!(verify_files(&dir, &load(&dir).unwrap()));
    }

    #[test]
    fn restart_reclaims_quota_without_touching_saved_or_unknown_files() {
        let disk = tempfile::tempdir().unwrap();
        let dir = disk.path().join("page-a");
        let page_b = disk.path().join("page-b");
        let old_hash = sha256_hex(b"old image");
        let mut saved = checkpoint(b"old native", 1);
        saved.head.assets.push(AssetDigest {
            name: "image.png".into(),
            sha256: old_hash.clone(),
        });
        save_asset(&dir, &old_hash, b"old image", None).unwrap();
        commit(&dir, saved, b"old native", None).unwrap();
        let abandoned_hash = sha256_hex(b"orphan image");
        save_asset(&dir, &abandoned_hash, b"orphan image", None).unwrap();
        let abandoned_native = vec![7; 1024];
        let orphan_native = dir.join(format!("{}.rm", sha256_hex(&abandoned_native)));
        write_recovery_file(
            &dir,
            orphan_native.file_name().unwrap().to_str().unwrap(),
            &abandoned_native,
        )
        .unwrap();
        let unknown = dir.join(format!("{}.asset", sha256_hex(b"other data")));
        std::fs::write(&unknown, b"not a matching digest").unwrap();
        let mut budget = Budget::open(disk.path()).unwrap();
        budget.limit = budget.used;
        let unused_hash = sha256_hex(b"next image");
        assert!(save_asset(&page_b, &unused_hash, b"next image", Some(&mut budget)).is_err());
        let saved = load(&dir).unwrap();
        let manifest = dir.join("checkpoint.json");
        let good_manifest = std::fs::read(&manifest).unwrap();
        std::fs::write(&manifest, b"unreadable checkpoint").unwrap();
        reclaim_interrupted_page(&dir, &mut budget).unwrap();
        assert!(orphan_native.exists());
        assert!(has_asset(&dir, &abandoned_hash));
        std::fs::write(&manifest, good_manifest).unwrap();
        reclaim_interrupted_page(&dir, &mut budget).unwrap();
        assert!(verify_files(&dir, &saved));
        assert!(!orphan_native.exists());
        assert!(!has_asset(&dir, &abandoned_hash));
        assert!(unknown.exists());
        save_asset(&page_b, &unused_hash, b"next image", Some(&mut budget)).unwrap();
        let mut next = checkpoint(b"next native", 2);
        next.head.assets.push(AssetDigest {
            name: "next.png".into(),
            sha256: unused_hash,
        });
        commit(&page_b, next, b"next native", Some(&mut budget)).unwrap();
        assert!(verify_files(&page_b, &load(&page_b).unwrap()));
        assert!(verify_files(&dir, &saved));
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
