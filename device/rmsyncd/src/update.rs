//! Test-only coverage for the old relay downloader and atomic update swap.
//! No production caller: a relay-provided checksum does not authorize code.
//!
//! Sends If-None-Match = sha256 of the running binary. 304 = current, 404 = no
//! release configured, 200 = new binary (sha verified before use). Swap is
//! atomic: stage and fsync the download, hard-link the running binary as
//! `rmsyncd.prev` (rollback artifact), rename the download into place, exit(0);
//! systemd's Restart=always relaunches the new binary at the same path.
//! Never calls systemctl.
//!

use std::path::Path;

use crate::cloud::CloudConfig;

/// One update check. Ok(true) = a new binary is in place (caller exits).
async fn check_once(
    client: &reqwest::Client,
    config: &CloudConfig,
    exe: &Path,
) -> Result<bool, String> {
    let own = std::fs::read(exe).map_err(|e| format!("read self: {e}"))?;
    let own_sha = crate::store::sha256_hex(&own);
    drop(own);

    // fleet spans aarch64 (Paper Pro) and armv7 (rM1/rM2); wrong ELF crash-loops the unit
    let arch = if cfg!(target_arch = "arm") {
        "armv7"
    } else {
        "aarch64"
    };
    let r = client
        .get(format!("{}/api/daemon/release?arch={arch}", config.url))
        .header("x-device-token", &config.token)
        .header("if-none-match", format!("\"{own_sha}\""))
        .send()
        .await
        .map_err(|e| format!("release fetch: {e}"))?;
    match r.status().as_u16() {
        304 => return Ok(false),
        404 => return Ok(false),
        200 => {}
        s => return Err(format!("release endpoint HTTP {s}")),
    }
    let declared = r
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_matches('"').to_string())
        .ok_or("release response missing ETag")?;
    let bytes = r.bytes().await.map_err(|e| format!("release body: {e}"))?;
    let got_sha = crate::store::sha256_hex(&bytes);
    if got_sha != declared {
        return Err(format!(
            "download sha {got_sha} != declared {declared}; discarding"
        ));
    }
    if got_sha == own_sha {
        return Ok(false); // racy 200: server serves exactly what we run
    }

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

    #[tokio::test]
    async fn installed_update_requests_restart_even_if_final_sync_fails() {
        use axum::{routing::get, Router};

        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("rmsyncd");
        let prev = exe.with_extension("prev");
        fs::write(&exe, b"installed").unwrap();
        let installed_inode = fs::metadata(&exe).unwrap().ino();

        let download = b"download";
        let app = Router::new().route(
            "/api/daemon/release",
            get(move || async move {
                let sha = crate::store::sha256_hex(download);
                ([("etag", format!("\"{sha}\""))], download.as_slice())
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = CloudConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: "fixture".into(),
        };
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        FAULT.set(Some(Fault::FinalSync));
        assert!(check_once(&reqwest::Client::new(), &config, &exe)
            .await
            .unwrap());
        assert!(FAULT.get().is_none());
        assert_eq!(fs::read(&exe).unwrap(), download);
        assert_eq!(fs::read(&prev).unwrap(), b"installed");
        assert_eq!(fs::metadata(&prev).unwrap().ino(), installed_inode);
        server.abort();
    }
}
