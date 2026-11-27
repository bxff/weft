#!/bin/bash
# Deploy the relay and tablet binaries to your configured userspace VPS.
# Requires a local SSH alias or user@host and a weft-cloud user service.
#   usage: WEFT_VPS=dex@host scripts/deploy-vps.sh
set -euo pipefail
: "${WEFT_VPS:?set WEFT_VPS=user@host}"
cd "$(dirname "$0")/.."
(cd device && cargo zigbuild --release --target aarch64-unknown-linux-musl)
(cd device && cargo zigbuild --release --target armv7-unknown-linux-musleabihf)
rsync -az --delete \
    --exclude .git --exclude node_modules --exclude 'device/target' --exclude target \
    --exclude '*.private.*' --exclude 'docs/render-overlays.private' \
    --exclude crosshatch.db --exclude '.env' \
    --exclude test-results --exclude 'apps/web/build' --exclude '.svelte-kit' \
    . "$WEFT_VPS:~/weft/src/"
scp -q device/target/aarch64-unknown-linux-musl/release/rmsyncd "$WEFT_VPS:~/weft/releases/rmsyncd"
scp -q device/target/armv7-unknown-linux-musleabihf/release/rmsyncd "$WEFT_VPS:~/weft/releases/rmsyncd-armv7"
ssh "$WEFT_VPS" 'cd ~/weft/src \
  && ~/.bun/bin/bun install --frozen-lockfile --filter @weft/cloud \
  && export XDG_RUNTIME_DIR=/run/user/$(id -u) \
  && systemctl --user restart weft-cloud \
  && sleep 2 && curl -sf http://127.0.0.1:8080/api/health >/dev/null'
echo "Deployed relay to $WEFT_VPS. Use your configured relay domain."
