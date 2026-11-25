#!/bin/bash
# Simulate SSH calls without connecting to a remote service.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/home" "$scratch/repo/scripts"
cp scripts/{deploy-vps,deploy-vps-ci}.sh "$scratch/repo/scripts/"
for arch in aarch64-unknown-linux-musl armv7-unknown-linux-musleabihf; do
    p="$scratch/repo/device/target/$arch/release/rmsyncd"
    mkdir -p "$(dirname "$p")"
    echo 'test binary' > "$p"
done
export HOME="$scratch/home" PATH="$scratch/bin:$PATH" WEFT_TEST_LOG="$scratch/commands"
for tool in ssh scp rsync; do
    cat > "$scratch/bin/$tool" <<'MOCK'
#!/bin/bash
printf '%s %s\n' "${0##*/}" "$*" >> "$WEFT_TEST_LOG"
if [[ "${0##*/}" = ssh && "$1" = -F ]]; then
    grep -Fq 'StrictHostKeyChecking yes' "$2"
    grep -Fq 'IdentitiesOnly yes' "$2"
    grep -Fq 'UserKnownHostsFile' "$2"
fi
MOCK
done
chmod +x "$scratch/bin/"*
cd "$scratch/repo"
VPS_HOST=vps.example.invalid VPS_USER=deploy VPS_SSH_KEY=fake VPS_KNOWN_HOSTS=fake bash scripts/deploy-vps-ci.sh
grep -Fq 'systemctl --user is-active --quiet weft-cloud' "$WEFT_TEST_LOG"
grep -Fq 'rsync -az --delete' "$WEFT_TEST_LOG"
grep -Fq -- '--exclude .env' "$WEFT_TEST_LOG"
test "$(grep -c '^scp ' "$WEFT_TEST_LOG")" = 2
test -z "$(find "$HOME" -name '.weft-ci-ssh.*' -print)"
echo 'Deployment script checks passed.'
