//! Verified public releases. The sync relay never selects or serves updates
//! to this daemon, and the updater does not use the tablet's credentials.
use std::path::Path;
use std::time::Duration;

const FIRST_CHECK: Duration = Duration::from_secs(2 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
const LIMIT: usize = 64 * 1024 * 1024;
const PIN: &str = include_str!("../../../apps/cli/src/tablet-release-key.txt");
const LATEST: &str = "https://api.github.com/repos/bxff/weft/releases/latest";
const DOWNLOAD: &str = "https://github.com/bxff/weft/releases/download";

pub fn spawn() {
    // Local/custom builds must explicitly opt into the public release track.
    let Some(current) = option_env!("WEFT_RELEASE_SEQUENCE").and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    let Ok(key) = hex::decode(PIN.trim()) else {
        return;
    };
    let Ok(key) = <[u8; 32]>::try_from(key) else {
        return;
    };
    let arch = match std::env::consts::ARCH {
        "arm" => "armv7",
        "aarch64" => "aarch64",
        _ => return,
    };
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .user_agent("weft-tablet-updater")
            .timeout(Duration::from_secs(120))
            .https_only(true)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("update: HTTP setup failed: {e}");
                return;
            }
        };
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let result = match std::env::current_exe() {
                Ok(exe) if !exe.with_file_name("disable-updates").exists() => {
                    check_once(&client, LATEST, DOWNLOAD, &key, current, arch, &exe).await
                }
                Ok(_) => Ok(false),
                Err(e) => Err(format!("current_exe: {e}")),
            };
            match result {
                Ok(true) => {
                    eprintln!("update: binary swapped; exiting for systemd relaunch");
                    std::process::exit(0);
                }
                Ok(false) => {}
                Err(e) => eprintln!("update: check failed ({e}); will retry"),
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

fn sequence(tag: &str) -> Option<u64> {
    let v = tag.strip_prefix("tablet-v")?;
    if v.is_empty() || v.len() > 15 || v.starts_with('0') || !v.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    v.parse().ok()
}

struct Asset<'a> {
    name: &'a str,
    size: usize,
    sha: &'a str,
}

fn manifest<'a>(
    raw: &'a [u8],
    signature: &[u8],
    key: &[u8; 32],
    tag: &str,
    arch: &str,
) -> Result<Asset<'a>, String> {
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(raw, signature)
        .map_err(|_| "invalid tablet release signature")?;
    let body = std::str::from_utf8(raw).map_err(|_| "invalid tablet release manifest encoding")?;
    let lines: Vec<_> = body.split('\n').collect();
    if lines.len() != 5
        || lines[0] != "weft-tablet-release-v1"
        || lines[1] != tag
        || lines[4] != ""
        || sequence(tag).is_none()
    {
        return Err("invalid tablet release manifest".into());
    }
    let mut selected = None;
    for (line, arch_name) in lines[2..4].iter().zip(["aarch64", "armv7"]) {
        let parts: Vec<_> = line.split(' ').collect();
        if parts.len() != 3
            || parts[0].len() != 64
            || !parts[0]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || parts[1].is_empty()
            || parts[1].starts_with('0')
            || !parts[1].bytes().all(|b| b.is_ascii_digit())
            || parts[2] != format!("rmsyncd-{arch_name}")
        {
            return Err("invalid tablet release asset".into());
        }
        let size = parts[1]
            .parse::<usize>()
            .map_err(|_| "invalid tablet release asset size")?;
        if size > LIMIT {
            return Err("tablet release asset exceeds size limit".into());
        }
        if arch_name == arch {
            selected = Some(Asset {
                name: parts[2],
                size,
                sha: parts[0],
            });
        }
    }
    selected.ok_or_else(|| "missing tablet architecture".into())
}

fn verify_binary(bytes: &[u8], asset: &Asset<'_>, arch: &str) -> Result<(), String> {
    if bytes.len() != asset.size || crate::store::sha256_hex(bytes) != asset.sha {
        return Err("tablet binary does not match the signed release".into());
    }
    let arm = arch == "armv7";
    if bytes.len() < if arm { 52 } else { 64 }
        || !bytes.starts_with(b"\x7fELF")
        || bytes[4..7] != if arm { [1, 1, 1] } else { [2, 1, 1] }
        || bytes[18..20] != if arm { [40, 0] } else { [183, 0] }
        || (arm && (bytes[37] & 4 == 0 || bytes[39] != 5))
    {
        return Err("wrong tablet binary architecture".into());
    }
    Ok(())
}

async fn fetch(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if response.status() != 200 {
        return Err(format!(
            "GitHub release endpoint HTTP {}",
            response.status()
        ));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("GitHub release exceeded size limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("GitHub release exceeded size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn check_once(
    client: &reqwest::Client,
    latest: &str,
    download: &str,
    key: &[u8; 32],
    current: u64,
    arch: &str,
    exe: &Path,
) -> Result<bool, String> {
    #[derive(serde::Deserialize)]
    struct Release {
        tag_name: String,
    }
    let release: Release = serde_json::from_slice(&fetch(client, latest, 512 * 1024).await?)
        .map_err(|_| "invalid GitHub release response")?;
    let tag = &release.tag_name;
    if sequence(tag).is_none_or(|v| v <= current) {
        return Ok(false);
    }
    let base = format!("{download}/{tag}");
    let manifest_url = format!("{base}/tablet-release.txt");
    let signature_url = format!("{base}/tablet-release.sig");
    let (raw, signature) = tokio::try_join!(
        fetch(client, &manifest_url, 1024),
        fetch(client, &signature_url, 64),
    )?;
    let asset = manifest(&raw, &signature, key, tag, arch)?;
    let bytes = fetch(client, &format!("{base}/{}", asset.name), asset.size).await?;
    verify_binary(&bytes, &asset, arch)?;
    swap_binary(exe, &bytes)?;
    Ok(true)
}

/// Stage on the same filesystem so the final rename replaces the live path atomically.
fn swap_binary(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::fs::{self, File, Permissions};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let dir = exe.parent().ok_or("daemon executable has no parent")?;
    let parent = File::open(dir).map_err(|e| format!("open executable directory: {e}"))?;
    let mut staged =
        tempfile::NamedTempFile::new_in(dir).map_err(|e| format!("stage update: {e}"))?;
    staged
        .write_all(bytes)
        .map_err(|e| format!("write update: {e}"))?;
    staged
        .as_file()
        .set_permissions(Permissions::from_mode(0o755))
        .map_err(|e| format!("chmod update: {e}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|e| format!("fsync update: {e}"))?;

    // Publish the rollback inode while the live path still points to it.
    let backup = tempfile::tempdir_in(dir).map_err(|e| format!("stage rollback link: {e}"))?;
    let link = backup.path().join("previous");
    fs::hard_link(exe, &link).map_err(|e| format!("link running executable: {e}"))?;
    fs::rename(link, exe.with_extension("prev")).map_err(|e| format!("publish rollback: {e}"))?;
    parent
        .sync_all()
        .map_err(|e| format!("fsync rollback directory: {e}"))?;

    #[cfg(test)]
    tests::fail_at(tests::Fault::Install).map_err(|e| format!("rename update into place: {e}"))?;
    staged
        .into_temp_path()
        .persist(exe)
        .map_err(|e| format!("rename update into place: {e}"))?;

    // Once the live path changes, the caller must restart even if durability
    // confirmation fails. Another check in the old process would read the new file.
    let sync_directory = || {
        #[cfg(test)]
        tests::fail_at(tests::Fault::FinalSync)?;
        parent.sync_all()
    };
    if let Err(error) = sync_directory() {
        eprintln!("update: binary installed but directory sync failed: {error}; restarting");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::io;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[derive(Clone, Copy, PartialEq)]
    pub(super) enum Fault {
        Install,
        FinalSync,
    }

    thread_local! { static FAULT: Cell<Option<Fault>> = const { Cell::new(None) }; }

    pub(super) fn fail_at(point: Fault) -> io::Result<()> {
        if FAULT.get() == Some(point) {
            FAULT.set(None);
            return Err(io::Error::other("injected update failure"));
        }
        Ok(())
    }

    #[test]
    fn replacement_preserves_previous_inode_and_sets_executable_mode() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("rmsyncd");
        let prev = exe.with_extension("prev");
        fs::write(&exe, b"installed").unwrap();
        fs::write(&prev, b"older rollback").unwrap();
        let installed_inode = fs::metadata(&exe).unwrap().ino();

        swap_binary(&exe, b"download").unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"download");
        let installed = fs::metadata(&exe).unwrap();
        assert_eq!(installed.permissions().mode() & 0o777, 0o755);
        assert_ne!(installed.ino(), installed_inode);
        assert_eq!(fs::read(&prev).unwrap(), b"installed");
        assert_eq!(fs::metadata(&prev).unwrap().ino(), installed_inode);
        assert_eq!(dir.path().read_dir().unwrap().count(), 2);
    }

    #[test]
    fn failed_install_keeps_live_executable_and_rollback_inode() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("rmsyncd");
        let prev = exe.with_extension("prev");
        fs::write(&exe, b"installed").unwrap();
        let installed_inode = fs::metadata(&exe).unwrap().ino();

        FAULT.set(Some(Fault::Install));
        let error = swap_binary(&exe, b"download").unwrap_err();

        assert!(error.contains("rename update into place"));
        assert_eq!(fs::read(&exe).unwrap(), b"installed");
        assert_eq!(fs::metadata(&exe).unwrap().ino(), installed_inode);
        assert_eq!(fs::read(&prev).unwrap(), b"installed");
        assert_eq!(fs::metadata(&prev).unwrap().ino(), installed_inode);
        assert_eq!(dir.path().read_dir().unwrap().count(), 2);
    }

    fn elf() -> Vec<u8> {
        let mut v = vec![0; 64];
        v[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        v[18] = 183;
        v
    }

    #[test]
    fn rejects_changed_bytes_and_architecture() {
        let bytes = elf();
        let sha = crate::store::sha256_hex(&bytes);
        let asset = Asset {
            name: "rmsyncd-aarch64",
            size: bytes.len(),
            sha: &sha,
        };
        assert!(verify_binary(&bytes, &asset, "aarch64").is_ok());
        assert!(verify_binary(&bytes, &asset, "armv7").is_err());
        let mut changed = bytes;
        changed[63] = 1;
        assert!(verify_binary(&changed, &asset, "aarch64").is_err());
    }

    #[tokio::test]
    async fn installed_update_requests_restart_even_if_final_sync_fails() {
        use axum::{routing::get, Router};

        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("rmsyncd");
        let prev = exe.with_extension("prev");
        fs::write(&exe, b"installed").unwrap();
        let installed_inode = fs::metadata(&exe).unwrap().ino();

        use ring::signature::{Ed25519KeyPair, KeyPair};
        let seed = [123; 32];
        let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let download = elf();
        let raw = format!(
            "weft-tablet-release-v1\ntablet-v2\n{} {} rmsyncd-aarch64\n{} 52 rmsyncd-armv7\n",
            crate::store::sha256_hex(&download),
            download.len(),
            "0".repeat(64),
        );
        let signature = key.sign(raw.as_bytes()).as_ref().to_vec();
        let asset = download.clone();
        let app = Router::new()
            .route("/latest", get(|| async { r#"{"tag_name":"tablet-v2"}"# }))
            .route(
                "/tablet-v2/tablet-release.txt",
                get(move || async move { raw }),
            )
            .route(
                "/tablet-v2/tablet-release.sig",
                get(move || async move { signature }),
            )
            .route(
                "/tablet-v2/rmsyncd-aarch64",
                get(move || async move { asset }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let public = key.public_key().as_ref().try_into().unwrap();
        let client = reqwest::Client::new();

        assert!(!check_once(
            &client,
            &format!("{base}/latest"),
            &base,
            &public,
            2,
            "aarch64",
            &exe
        )
        .await
        .unwrap());
        assert!(check_once(
            &client,
            &format!("{base}/latest"),
            &base,
            &[0; 32],
            1,
            "aarch64",
            &exe
        )
        .await
        .is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"installed");

        FAULT.set(Some(Fault::FinalSync));
        assert!(check_once(
            &client,
            &format!("{base}/latest"),
            &base,
            &public,
            1,
            "aarch64",
            &exe
        )
        .await
        .unwrap());
        assert!(FAULT.get().is_none());
        assert_eq!(fs::read(&exe).unwrap(), download);
        assert_eq!(fs::read(&prev).unwrap(), b"installed");
        assert_eq!(fs::metadata(&prev).unwrap().ino(), installed_inode);
        server.abort();
    }
}
