# Tablet installer

The host-side `weft` CLI uses SSH to install, check, link, and uninstall the tablet daemon.

```sh
weft setup --host root@10.11.99.1
weft doctor --host root@10.11.99.1
weft uninstall --host root@10.11.99.1
```

Use the web setup page for the install command when you also want to link
the tablet to a relay. `weft setup` installs under `/home/root/weft`, checks
firmware compatibility, and sets up the service to take over tablet sync.
By default it installs a boot guard; use `--no-auto-reinstall` to opt out
of that boot-time restoration. The default editor store timeout is 500 ms.

`weft uninstall` removes the service and editor overrides and attempts to
restore stock sync. It leaves the files under `/home/root/weft` in place.
Check the tablet after uninstalling to confirm stock sync resumed.

## Where the executable comes from

The official installer downloads the stable tablet release from
[bxff/weft GitHub Releases](https://github.com/bxff/weft/releases).
It verifies the Ed25519 signature of the manifest using a public key pinned
in the installer and then checks the selected binary's length, SHA-256 and
ELF architecture. Your relay URL and device token are only used for sync.
The same verification runs on the tablet before an automatic update;
older or equal version numbers are ignored. No unsigned relay fallback is
used. A missing, invalid or incomplete release leaves the live daemon alone.

For a custom build, use `weft setup --from-source` from this checkout after
building the appropriate musl target. Custom builds are not enrolled in
automatic updates. To pause a published build's updates on a tablet, create
`/home/root/weft/disable-updates`. The daemon keeps its previous executable
as `/home/root/weft/rmsyncd.prev` after an automatic update. If you restore
that executable, pause updates first or it will pick up the newer release
again. This is separate from firmware updates: the existing boot guard
reinstalls the service around the executable already in `/home/root/weft`;
it does not download executables or change reMarkable's firmware channel.

### Existing tablets

After the first signed release and matching CLI are published, run the new
`weft setup --host root@10.11.99.1` once (preserving any existing
`--no-auto-reinstall` or experimental device choice). Leave out `--cloud`
and `--token` to keep the existing link. Do **not** serve an unsigned bridge
binary from the old relay endpoint. Disable the legacy
`WEFT_DAEMON_RELEASE` / `WEFT_DAEMON_RELEASE_ARMV7` settings in the relay.
Older installers need the newer CLI, not a new enrollment token.

### Publishing a release (maintainers)

1. Generate and securely back up an Ed25519 signing key offline. Place only
   the lowercase hex encoding of the raw 32-byte public key in
   `apps/cli/src/tablet-release-key.txt`. The file is pinned in both the
   installer and daemon. Never fetch the pin from GitHub's release assets.
2. Give the protected `tablet-release-signing` GitHub Actions environment
   the private PKCS#8 PEM as `WEFT_TABLET_SIGNING_KEY_PEM`. Restrict it to
   `main`, require approval, and do not share this key with the relay or
   put it in Git. The release workflow validates the key against the pin.
3. Dispatch **Release tablet daemon** from `main` with a number greater
   than all prior tablet releases. It builds both locked musl binaries and
   publishes a stable `tablet-vN` release with the two binaries and detached
   signed manifest. Keep the newest tablet release the repository's
   **Latest** release; unrelated release announcements must not take over
   that pointer. The matching CLI must be published separately via npm.
4. To replace or revoke the signing key, ship a fresh trusted CLI with the
   new pin and repeat the one-time SSH setup. Stop automatic updates for
   the affected tablets first if the old private key may have leaked. A
   compromised key cannot authenticate its own replacement.

The GitHub serving location is not the signing trust root. The public
key in the trusted CLI/firmware-independent daemon build is. An attacker
who only replaces the GitHub binary, checksum or manifest cannot make
that replacement pass verification.
