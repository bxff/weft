//! A/B firmware-update survival (opt-in, `--ota-survival`).
//!
//! reMarkable OTAs flash the inactive rootfs slot and switch to it on reboot.
//! The flashed slot is stock and won't relaunch weft, so the daemon (living on
//! /home, which survives OTA) injects its own systemd unit into the flashed slot
//! before the switch.
//!
//! Safety (never brick):
//!  - Act only when swu_status==1 (flashed, staged, not yet applied), never 7
//!    (in-progress). Re-check right before mounting.
//!  - Refuse unless the target is genuinely the inactive slot and a complete
//!    rootfs (has /lib/systemd/system and /usr/bin).
//!  - Additive writes only (one unit + one wants symlink); never modify or
//!    delete stock files.
//!  - After writing, e2fsck -n the slot; if not clean, set swu_status off 1 so
//!    rm-apply-ota won't switch. Corruption self-aborts instead of bricking.
//!  - Never touch the active slot, kernel, bootloader, or /home.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

const SWU_STATUS: &str = "/sys/devices/platform/lpgpr/swu_status";
const STAGED: &str = "1"; // flashed into the inactive slot, pending reboot-apply
const POLL: Duration = Duration::from_secs(30);
const MNT: &str = "/tmp/weft-ab-mnt";

/// Spawn the staged-update poller. `install_dir` is the persistent /home/root/weft
/// path (survives OTA); the injected unit's ExecStart points there.
pub fn spawn(install_dir: std::path::PathBuf) {
    tokio::spawn(async move {
        eprintln!("ab-survival: enabled; watching {SWU_STATUS} for staged OTAs");
        // A status already at 1 on startup was handled by a prior run; act only
        // on a fresh 0->1 transition.
        let mut last = read_status();
        loop {
            tokio::time::sleep(POLL).await;
            let now = read_status();
            if now.as_deref() == Some(STAGED) && last.as_deref() != Some(STAGED) {
                eprintln!("ab-survival: OTA staged (swu_status=1) — injecting into inactive slot");
                match inject(&install_dir) {
                    Ok(()) => eprintln!("ab-survival: injected + slot verified clean; will boot with weft"),
                    Err(e) => eprintln!("ab-survival: NOT injected: {e}"),
                }
            }
            last = now;
        }
    });
}

fn read_status() -> Option<String> {
    std::fs::read_to_string(SWU_STATUS)
        .ok()
        .map(|s| s.trim().to_string())
}

fn rootdev(which: &str) -> Result<String, String> {
    let out = Command::new("rootdev")
        .arg(which)
        .output()
        .map_err(|e| format!("rootdev {which}: {e}"))?;
    if !out.status.success() {
        return Err(format!("rootdev {which} exited {}", out.status));
    }
    let dev = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dev.is_empty() {
        return Err(format!("rootdev {which} returned empty"));
    }
    Ok(dev)
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let st = Command::new(cmd)
        .args(args)
        .status()
        .map_err(|e| format!("{cmd}: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("{cmd} {args:?} exited {st}"))
    }
}

fn inject(install_dir: &Path) -> Result<(), String> {
    let inactive = rootdev("--inactive")?;
    let active = rootdev("--active")?;
    // Never write to the running system; if inactive == active something is wrong.
    if inactive == active {
        return Err(format!("inactive ({inactive}) == active ({active}); refusing"));
    }

    // Re-check the signal right before acting; never touch a mid-write slot.
    if read_status().as_deref() != Some(STAGED) {
        return Err("swu_status no longer 1; skipping".into());
    }

    std::fs::create_dir_all(MNT).map_err(|e| format!("mkdir {MNT}: {e}"))?;
    run("mount", &[inactive.as_str(), MNT])?;

    // Always unmount, success or not.
    let wrote = write_unit(Path::new(MNT), install_dir);
    let _ = run("sync", &[]);
    let unmounted = run("umount", &[MNT]);
    wrote?;
    unmounted?;

    // If the slot's filesystem isn't clean, abort the pending switch so the
    // device stays on the current good slot.
    let fsck = Command::new("e2fsck")
        .args(["-n", inactive.as_str()])
        .status()
        .map_err(|e| format!("e2fsck: {e}"))?;
    if !fsck.success() {
        eprintln!(
            "ab-survival: e2fsck NOT clean on {inactive} after inject, aborting pending switch"
        );
        // Any value other than 1 makes rm-apply-ota skip the switch. This is the
        // safety write; a failure must be loud (otherwise the dirty slot switches
        // with only the bootloader boot-count as backstop).
        if let Err(e) = std::fs::write(SWU_STATUS, "3\n") {
            eprintln!(
                "ab-survival: CRITICAL: could not write abort to {SWU_STATUS} ({e}); \
                 dirty slot may still switch, bootloader boot-count is the only backstop"
            );
        }
        return Err("inactive slot fsck dirty; switch aborted, stayed on good slot".into());
    }
    Ok(())
}

fn write_unit(mnt: &Path, install_dir: &Path) -> Result<(), String> {
    // Refuse unless this is a complete rootfs. Check real dirs on the mounted
    // slot: the slot's /lib -> /usr/lib symlink is absolute and would resolve
    // against the host root, validating the running system instead of the slot.
    if !mnt.join("usr/lib/systemd/system").is_dir() || !mnt.join("usr/bin").is_dir() {
        return Err("target is not a complete rootfs; refusing to write".into());
    }
    let systemd = mnt.join("usr/lib/systemd/system");
    std::fs::create_dir_all(&systemd).map_err(|e| format!("mkdir usr/lib/systemd/system: {e}"))?;
    std::fs::write(systemd.join("weft.service"), unit_contents(install_dir))
        .map_err(|e| format!("write weft.service: {e}"))?;
    let wants = systemd.join("multi-user.target.wants");
    std::fs::create_dir_all(&wants).map_err(|e| format!("mkdir wants: {e}"))?;
    let link = wants.join("weft.service");
    let _ = std::fs::remove_file(&link); // idempotent
    std::os::unix::fs::symlink("../weft.service", &link).map_err(|e| format!("symlink: {e}"))?;
    Ok(())
}

/// The injected unit. Mirrors the one `weft setup` installs, pointing at the
/// persistent /home payload. On first boot the ExecStartPre boot-guard re-creates
/// the xochitl drop-in + firmware self-check.
fn unit_contents(install_dir: &Path) -> String {
    let d = install_dir.display();
    format!(
        "[Unit]\n\
         Description=Weft tablet daemon\n\
         Before=xochitl.service\n\
         After=dbus.service home.mount\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStartPre={d}/boot-guard.sh\n\
         ExecStart={d}/rmsyncd --cloud-config {d}/cloud.json --ota-survival\n\
         Restart=always\n\
         RestartSec=3\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n"
    )
}
