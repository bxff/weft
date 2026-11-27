//! rmsyncd — the Weft tablet daemon. A pure sync agent (D-Bus rm-sync shim,
//! file watching, mirroring to the hosted store in cloud.rs); not an app/API
//! server. The only HTTP surface is a loopback health endpoint for `weft doctor`.

mod ab_survival;
mod cloud;
mod dbus;
mod recovery;
mod server;
mod store;
mod update;
mod watch;

use futures_util::TryStreamExt;
use std::path::PathBuf;
use tokio::sync::broadcast;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn flag(name: &str) -> bool {
    std::env::args().any(|a| a == name)
}

#[tokio::main]
async fn main() {
    // A panicked tokio task must never leave a half-alive daemon (e.g. WS
    // keepalive alive while the sync loop is dead = silently stops syncing).
    // Fail fast: log, exit, systemd relaunches, startup reconcile self-heals.
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_panic(info);
        eprintln!("rmsyncd: panic in a task; exiting for systemd relaunch");
        std::process::exit(101);
    }));
    let xochitl_dir = PathBuf::from(arg("--xochitl-dir").unwrap_or_else(|| {
        "/home/root/.local/share/remarkable/xochitl".to_string()
    }));
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(9000);
    let no_dbus = flag("--no-dbus");

    let firmware = std::fs::read_to_string("/etc/version")
        .unwrap_or_default()
        .trim()
        .to_string();
    let model = std::fs::read_to_string("/sys/devices/soc0/machine")
        .unwrap_or_default()
        .trim()
        .to_string();

    let dbus = if no_dbus {
        None
    } else {
        match dbus::start().await {
            Ok(conn) => Some(conn),
            Err(error) => {
                eprintln!("rmsyncd: cannot claim the editor D-Bus service: {error}");
                std::process::exit(1);
            }
        }
    };

    if let Some(conn) = &dbus {
        let mut messages = zbus::MessageStream::from(conn.as_ref());
        tokio::spawn(async move {
            loop {
                match messages.try_next().await {
                    Ok(Some(_)) => continue,
                    Ok(None) => eprintln!("dbus: connection closed; exiting for systemd relaunch"),
                    Err(error) => eprintln!("dbus: connection lost ({error}); exiting for systemd relaunch"),
                }
                std::process::exit(1);
            }
        });
    }

    let templates_dir = PathBuf::from(
        arg("--templates-dir").unwrap_or_else(|| "/usr/share/remarkable/templates".to_string()),
    );

    let (events, _) = broadcast::channel(256);
    let state = server::AppState {
        store: store::Store::new(xochitl_dir),
        dbus,
        events,
        firmware,
        model,
        templates_dir,
    };

    let _watcher = match watch::start(state.clone()) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("watch: failed to start ({e}); change events disabled");
            None
        }
    };

    // cloud sync (enabled by `weft link` writing cloud.json)
    let cloud_config_path = PathBuf::from(
        arg("--cloud-config").unwrap_or_else(|| "/home/root/weft/cloud.json".to_string()),
    );
    if let Some(config) = cloud::load_config(&cloud_config_path) {
        let state_path = cloud_config_path.with_file_name("cloud-state.json");
        cloud::spawn(state.clone(), config.clone(), state_path);
        // self-update: polls the cloud's release binary; a swap exits(0) and
        // systemd relaunches the new binary. Inert until the server sets
        // WEFT_DAEMON_RELEASE (404 = nothing to do).
        update::spawn(config);
    }

    // A/B firmware-update survival (opt-in, off until device-verified on a real
    // OTA). Injects weft's unit into a staged OTA's inactive slot before the
    // reboot switch, with fsck-abort safety. See ab_survival.rs.
    if flag("--ota-survival") {
        let install_dir = cloud_config_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("/home/root/weft"));
        ab_survival::spawn(install_dir);
    }

    // Loopback only: health endpoint for `weft doctor`.
    let app = server::health_router(state);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    eprintln!("rmsyncd health on http://{addr} (sync agent; no app/API server)");
    // The health endpoint must never kill the daemon: a bind failure (stale
    // instance holding the port) or serve error previously panicked the whole
    // process, taking the sync + watch tasks down with it. Log and keep running;
    // sync is the daemon's real job.
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("rmsyncd: health server exited ({e}); sync continues");
            }
        }
        Err(e) => eprintln!("rmsyncd: health bind {addr} failed ({e}); doctor probe off, sync continues"),
    }
    // Park so the process (and its background sync/watch tasks) stays alive if
    // the health server never bound or later exited.
    std::future::pending::<()>().await;
}
