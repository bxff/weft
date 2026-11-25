#!/bin/bash
# Optional Cloudflare Pages deployment; configure your own Pages project.
# Use a locally authenticated Wrangler or CI-managed CLOUDFLARE_API_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
: "${PUBLIC_CLOUD_URL:?set PUBLIC_CLOUD_URL to your relay origin}"
export PUBLIC_CLOUD_URL
(cd apps/web && bun run build)
if [[ "${WEFT_BUILD_ONLY:-0}" == 1 ]]; then
    echo "Prepared frontend: apps/web/build"
    exit 0
fi
: "${CLOUDFLARE_ACCOUNT_ID:?set your Cloudflare account ID}"
: "${CLOUDFLARE_PAGES_PROJECT:?set your Cloudflare Pages project name}"
export CLOUDFLARE_ACCOUNT_ID
npx wrangler pages deploy apps/web/build --project-name "$CLOUDFLARE_PAGES_PROJECT" --commit-dirty=true
