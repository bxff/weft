#!/bin/bash
# Execute the remote script against a scratch host, never a real SSH server.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export WEFT_TEST_LOG="$scratch/commands" WEFT_TEST_HOME="$scratch/remote"
export HOME="$scratch/local" PATH="$scratch/bin:$PATH" TMPDIR="$scratch/tmp"
mkdir -p "$scratch"/{bin,local,tmp,repo/scripts,repo/apps/cloud/src}
cp scripts/deploy-vps-ci.sh "$scratch/repo/scripts/"
cd "$scratch/repo"
git init -q
printf 'tested relay source\n' > apps/cloud/src/server.ts
printf 'lockfile\n' > bun.lock
git add .
git -c user.name=CI -c user.email=ci@example.invalid commit -qm fixture
export GITHUB_SHA=$(git rev-parse HEAD) GITHUB_REPOSITORY=owner/test
export GITHUB_REF=refs/heads/main VPS_HOST=vps.example.invalid VPS_USER=deploy
export VPS_SSH_KEY=fake VPS_KNOWN_HOSTS=fake GH_TOKEN=fake
export WEFT_TEST_HEAD=$GITHUB_SHA
# A dirty tracked file must not replace the tested version; private files and
# local stale release binaries must not be included.
printf 'untested modification\n' > apps/cloud/src/server.ts
printf 'untracked secret\n' > .env
mkdir -p device/target/test
printf 'local binary\n' > device/target/test/rmsyncd

cat > "$scratch/bin/gh" <<'MOCK'
#!/bin/bash
set -eu
[[ "$*" == 'api repos/owner/test/git/ref/heads/main --jq .object.sha' ]]
echo 'freshness check' >> "$WEFT_TEST_LOG"
printf '%s\n' "$WEFT_TEST_HEAD"
MOCK
cat > "$scratch/bin/ssh" <<'MOCK'
#!/bin/bash
set -eu
[[ -z "${GH_TOKEN:-}${VPS_SSH_KEY:-}${VPS_KNOWN_HOSTS:-}" ]]
[[ "$1" == -T && "$2" == -F && "$4" == weft-ci-vps ]]
grep -Fq 'StrictHostKeyChecking yes' "$3"
grep -Fq 'IdentitiesOnly yes' "$3"
grep -Fq 'IdentityAgent none' "$3"
grep -Fq 'GlobalKnownHostsFile /dev/null' "$3"
grep -Fq 'UserKnownHostsFile' "$3"
echo ssh >> "$WEFT_TEST_LOG"
HOME="$WEFT_TEST_HOME" exec bash -c "$5"
MOCK
cat > "$scratch/bin/cat" <<'MOCK'
#!/bin/bash
case "${1:-}" in
    /proc/999/environ)
        printf 'CLOUD_DB=%s\0WEFT_BACKUP_DIR=%s\0' "$WEFT_TEST_DB" "$HOME/weft/backups" ;;
    /proc/999/cmdline)
        printf '%s\0' bun src/server.ts ;;
    *) exec /bin/cat "$@" ;;
esac
MOCK
cat > "$scratch/bin/systemctl" <<'MOCK'
#!/bin/bash
case "$*" in
    '--user is-active --quiet weft-cloud') exit 0 ;;
    '--user show --property=MainPID --value weft-cloud') echo 999 ;;
    '--user restart weft-cloud')
        echo "restart: $(/bin/cat "$HOME/weft/src/apps/cloud/src/server.ts")" >> "$WEFT_TEST_LOG" ;;
    *) exit 1 ;;
esac
MOCK
cat > "$scratch/bin/curl" <<'MOCK'
#!/bin/bash
test "${*: -1}" = http://127.0.0.1:8080/api/health || exit 1
if [[ "${WEFT_TEST_FAIL_HEALTH:-}" == 1 ]] &&
        grep -Fq 'tested relay' "$HOME/weft/src/apps/cloud/src/server.ts"; then
    exit 1
fi
printf '{"daemon":"weft-cloud"}\n'
MOCK
cat > "$scratch/bin/timeout" <<'MOCK'
#!/bin/bash
shift
exec "$@"
MOCK
cat > "$scratch/bin/mv" <<'MOCK'
#!/bin/bash
# BSD mv on developer machines doesn't have GNU Linux's -T.
[[ "$1" == -T && "$2" == -- ]] || exit 1
if [[ "${WEFT_TEST_FAIL_MOVE:-}" == 1 && "$3" == */stage ]]; then exit 1; fi
test ! -e "$4" || exit 1
exec /bin/mv "$3" "$4"
MOCK
cat > "$scratch/bin/realpath" <<'MOCK'
#!/bin/bash
# Scratch paths contain no symlinks or relative segments.
printf '%s\n' "${*: -1}"
MOCK
for tool in flock sleep; do
    printf '#!/bin/bash\nexit 0\n' > "$scratch/bin/$tool"
done
chmod +x "$scratch/bin/"*

prepare() {
    rm -rf -- "$WEFT_TEST_HOME"
    mkdir -p "$WEFT_TEST_HOME"/{.bun/bin,weft/src/apps/cloud/src,weft/releases,weft/backups}
    printf 'old relay source\n' > "$WEFT_TEST_HOME/weft/src/apps/cloud/src/server.ts"
    printf 'owner runtime secrets\n' > "$WEFT_TEST_HOME/weft/env"
    printf 'existing database\n' > "$WEFT_TEST_HOME/weft/production.db"
    printf 'existing tablet binary\n' > "$WEFT_TEST_HOME/weft/releases/rmsyncd"
    printf 'existing tablet binary armv7\n' > "$WEFT_TEST_HOME/weft/releases/rmsyncd-armv7"
    export WEFT_TEST_DB="$WEFT_TEST_HOME/weft/production.db"
    : > "$WEFT_TEST_LOG"
    /bin/cat > "$WEFT_TEST_HOME/.bun/bin/bun" <<'MOCK'
#!/bin/bash
set -eu
[[ "$*" == 'install --frozen-lockfile --filter @weft/cloud' ]]
[[ "$PWD" == */weft/.relay-*/stage ]]
grep -Fqx 'tested relay source' apps/cloud/src/server.ts
test ! -e .env
test ! -e device/target/test/rmsyncd
echo 'installed from tracked commit' >> "$WEFT_TEST_LOG"
test "${WEFT_TEST_FAIL_INSTALL:-}" != 1
MOCK
    chmod +x "$WEFT_TEST_HOME/.bun/bin/bun"
}

prepare
WEFT_TEST_HEAD=0000000000000000000000000000000000000000     bash scripts/deploy-vps-ci.sh && exit 1
if grep -qx ssh "$WEFT_TEST_LOG"; then exit 1; fi
[[ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print)" ]]

prepare
export WEFT_TEST_DB="$WEFT_TEST_HOME/weft/src/local.db"
touch "$WEFT_TEST_DB"
bash scripts/deploy-vps-ci.sh && exit 1
if grep -E -q '^installed|^restart:' "$WEFT_TEST_LOG"; then exit 1; fi

prepare
WEFT_TEST_FAIL_INSTALL=1 bash scripts/deploy-vps-ci.sh && exit 1
grep -Fqx 'old relay source' "$WEFT_TEST_HOME/weft/src/apps/cloud/src/server.ts"
if grep -q '^restart:' "$WEFT_TEST_LOG"; then exit 1; fi

prepare
WEFT_TEST_FAIL_MOVE=1 bash scripts/deploy-vps-ci.sh && exit 1
grep -Fqx 'old relay source' "$WEFT_TEST_HOME/weft/src/apps/cloud/src/server.ts"
grep -Fqx 'restart: old relay source' "$WEFT_TEST_LOG"

prepare
WEFT_TEST_FAIL_HEALTH=1 bash scripts/deploy-vps-ci.sh && exit 1
grep -Fqx 'old relay source' "$WEFT_TEST_HOME/weft/src/apps/cloud/src/server.ts"
grep -Fqx 'restart: tested relay source' "$WEFT_TEST_LOG"
grep -Fqx 'restart: old relay source' "$WEFT_TEST_LOG"

prepare
bash scripts/deploy-vps-ci.sh
grep -Fqx 'tested relay source' "$WEFT_TEST_HOME/weft/src/apps/cloud/src/server.ts"
grep -Fqx 'owner runtime secrets' "$WEFT_TEST_HOME/weft/env"
grep -Fqx 'existing database' "$WEFT_TEST_HOME/weft/production.db"
grep -Fqx 'existing tablet binary' "$WEFT_TEST_HOME/weft/releases/rmsyncd"
grep -Fqx 'existing tablet binary armv7' "$WEFT_TEST_HOME/weft/releases/rmsyncd-armv7"
grep -Fqx 'old relay source' "$WEFT_TEST_HOME"/weft/.relay-*/prior/apps/cloud/src/server.ts
test "$(sed -n '1p' "$WEFT_TEST_LOG")" = "freshness check"
test "$(sed -n '2p' "$WEFT_TEST_LOG")" = "ssh"
[[ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print)" ]]
echo 'Relay deployment script checks passed.'
