# rmsyncd

The Rust daemon runs on the reMarkable tablet. It watches the tablet's
notebook store, syncs changes and templates to the Weft relay, applies relay
updates locally, and notifies the editor. The browser talks to the relay, not
to the daemon.

In tablet mode the daemon claims the `no.remarkable.sync` D-Bus service. If
that connection is lost, the process exits so systemd can relaunch it.
The daemon exposes only a loopback HTTP health endpoint for `weft doctor`.
Use `--no-dbus` with a disposable store in local development.

From `device/`, the release targets used by the VPS deploy script are:

```sh
cargo zigbuild --release --target aarch64-unknown-linux-musl
cargo zigbuild --release --target armv7-unknown-linux-musleabihf
```

See the [installer guide](../installer/README.md) for tablet setup.
