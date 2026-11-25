use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const TIMEOUT: Duration = Duration::from_secs(5);

async fn private_bus(address: &str) -> Child {
    let mut bus = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1", "--address"])
        .arg(address)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start private dbus-daemon");
    let mut ready = String::new();
    tokio::time::timeout(
        TIMEOUT,
        BufReader::new(bus.stdout.take().unwrap()).read_line(&mut ready),
    )
    .await
    .expect("private dbus-daemon must announce its address")
    .unwrap();
    assert!(
        !ready.trim().is_empty(),
        "private bus closed its address pipe"
    );
    bus
}

fn daemon(dir: &Path, address: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rmsyncd"));
    command
        .env("DBUS_SYSTEM_BUS_ADDRESS", address)
        .args(["--port", "0", "--xochitl-dir"])
        .arg(dir.join("xochitl"))
        .arg("--cloud-config")
        .arg(dir.join("absent.json"))
        .kill_on_drop(true);
    command
}

async fn wait_for_service(address: &str) {
    let connection = zbus::connection::Builder::address(address)
        .unwrap()
        .build()
        .await
        .unwrap();
    let bus = zbus::fdo::DBusProxy::new(&connection).await.unwrap();
    tokio::time::timeout(TIMEOUT, async {
        loop {
            if bus
                .name_has_owner("no.remarkable.sync".try_into().unwrap())
                .await
                .unwrap()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("daemon must claim its D-Bus service");

    // Ordinary incoming method calls must leave the monitor running.
    let introspector = zbus::fdo::IntrospectableProxy::builder(&connection)
        .destination("no.remarkable.sync")
        .unwrap()
        .path("/Synchronizer")
        .unwrap()
        .build()
        .await
        .unwrap();
    assert!(introspector
        .introspect()
        .await
        .unwrap()
        .contains("releaseEntryLock"));
}

#[tokio::test]
#[ignore = "requires dbus-daemon to start a private message bus"]
async fn daemon_exits_when_its_bus_dies_and_can_claim_the_service_again() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("xochitl")).unwrap();
    let socket = dir.path().join("dbus");
    let address = format!("unix:path={}", socket.display());
    let mut bus = private_bus(&address).await;
    let mut running = daemon(dir.path(), &address).spawn().unwrap();
    wait_for_service(&address).await;
    assert!(running.try_wait().unwrap().is_none());
    bus.kill().await.unwrap();
    assert_failure(&mut running, "daemon must exit after a terminal disconnect").await;

    // Systemd may restart the daemon before D-Bus is back.
    let mut too_early = daemon(dir.path(), &address).spawn().unwrap();
    assert_failure(
        &mut too_early,
        "daemon must retry startup while the bus is down",
    )
    .await;

    // Reproduce relaunch once the bus listens on the same address again.
    if socket.exists() {
        std::fs::remove_file(socket).unwrap();
    }
    let mut new_bus = private_bus(&address).await;
    let mut restarted = daemon(dir.path(), &address).spawn().unwrap();
    wait_for_service(&address).await;
    assert!(restarted.try_wait().unwrap().is_none());
    restarted.kill().await.unwrap();
    new_bus.kill().await.unwrap();
}

async fn assert_failure(daemon: &mut Child, failure: &str) {
    let status = tokio::time::timeout(TIMEOUT, daemon.wait())
        .await
        .expect(failure)
        .unwrap();
    assert_eq!(status.code(), Some(1));
}

#[tokio::test]
async fn explicit_no_dbus_starts_without_a_bus() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("xochitl")).unwrap();
    let address = format!("unix:path={}", dir.path().join("absent-bus").display());
    let mut headless = daemon(dir.path(), &address)
        .arg("--no-dbus")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut logs = BufReader::new(headless.stderr.take().unwrap()).lines();
    tokio::time::timeout(TIMEOUT, async {
        while let Some(line) = logs.next_line().await.unwrap() {
            if line.starts_with("rmsyncd health on ") {
                return;
            }
        }
        panic!("daemon must start when D-Bus is disabled");
    })
    .await
    .unwrap();
    assert!(headless.try_wait().unwrap().is_none());
    headless.kill().await.unwrap();
}
