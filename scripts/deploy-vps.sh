#!/bin/bash
# Deploy the relay and tablet binaries to your configured userspace VPS.
# Requires a local SSH alias or user@host and a weft-cloud user service.
#   usage: WEFT_VPS=dex@host scripts/deploy-vps.sh
set -euo pipefail
: "${WEFT_VPS:?set WEFT_VPS=user@host}"
cd "$(dirname "$0")/.."
if [[ "${WEFT_VPS_PREBUILT:-0}" != 1 ]]; then
    (cd device && cargo zigbuild --locked --release --target aarch64-unknown-linux-musl)
    (cd device && cargo zigbuild --locked --release --target armv7-unknown-linux-musleabihf)
fi
for target in aarch64-unknown-linux-musl armv7-unknown-linux-musleabihf; do
    test -s "device/target/$target/release/rmsyncd"
done
ssh_args=()
if [[ -n "${WEFT_SSH_CONFIG:-}" ]]; then
    ssh_args=(-F "$WEFT_SSH_CONFIG")
    printf -v RSYNC_RSH 'ssh -F %q' "$WEFT_SSH_CONFIG"
    export RSYNC_RSH
fi
rsync -az --delete \
    --exclude .git --exclude node_modules --exclude 'device/target' --exclude target \
    --exclude '*.private.*' --exclude 'docs/render-overlays.private' \
    --exclude '*.db' --exclude '*.db-*' --exclude '*.db-files' --exclude '.env' --exclude '.env.*' \
    --exclude test-results --exclude 'apps/web/build' --exclude '.svelte-kit' \
    . "$WEFT_VPS:~/weft/src/"
scp -q "${ssh_args[@]}" device/target/aarch64-unknown-linux-musl/release/rmsyncd "$WEFT_VPS:~/weft/releases/rmsyncd"
scp -q "${ssh_args[@]}" device/target/armv7-unknown-linux-musleabihf/release/rmsyncd "$WEFT_VPS:~/weft/releases/rmsyncd-armv7"
ssh "${ssh_args[@]}" "$WEFT_VPS" 'cd ~/weft/src \
  && ~/.bun/bin/bun install --frozen-lockfile --filter @weft/cloud \
  && export XDG_RUNTIME_DIR=/run/user/$(id -u) \
  && systemctl --user restart weft-cloud \
  && curl -fsS --retry 8 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/api/health >/dev/null'
echo "Deployed relay to $WEFT_VPS. Use your configured relay domain."
