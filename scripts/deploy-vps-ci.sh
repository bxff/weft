#!/bin/bash
# GitHub Actions relay-only deployment. Does not touch tablet releases, relay
# data, systemd units, or the existing private runtime environment.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VPS_HOST:?Configure VPS_HOST in vps-production}"
: "${VPS_USER:?Configure VPS_USER in vps-production}"
: "${VPS_SSH_KEY:?Configure a dedicated deployment SSH key in vps-production}"
: "${VPS_KNOWN_HOSTS:?Configure a host key verified out of band in vps-production}"
: "${VPS_PORT:=22}"
: "${GITHUB_REPOSITORY:?Set by GitHub Actions}"
: "${GITHUB_SHA:?Set by GitHub Actions}"
[[ "${GITHUB_REF:-}" == refs/heads/main ]]
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ && "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
[[ "$VPS_HOST" =~ ^[[:alnum:]][[:alnum:].:-]*$ ]]
[[ "$VPS_USER" =~ ^[[:alnum:]_][[:alnum:]_.-]*$ ]]
[[ "$VPS_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( VPS_PORT < 65536 ))

umask 077
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$scratch/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$scratch/known_hosts"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS
cat > "$scratch/config" <<SSH
Host weft-ci-vps
    HostName $VPS_HOST
    User $VPS_USER
    Port $VPS_PORT
    IdentityFile "$scratch/key"
    UserKnownHostsFile "$scratch/known_hosts"
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    IdentityAgent none
    ForwardAgent no
    ClearAllForwardings yes
    BatchMode yes
    ConnectTimeout 10
SSH

# Never rsync the working tree. The exact tested commit is the only payload.
git archive --format=tar.gz "$GITHUB_SHA" > "$scratch/source.tgz"

# This body executes on the existing Linux relay. stdin is the tracked archive.
remote=$(cat <<'REMOTE'
set -euo pipefail
umask 077
sha=$1
base="$HOME/weft"
live="$base/src"
bun="$HOME/.bun/bin/bun"
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -x "$bun" && -d "$live" && -d "$base/releases" && -r "$base/env" ]] ||
    fail "Expected Bun, existing Weft source/releases, and the private runtime env."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
service=(systemctl --user)
health() {
    local response
    "${service[@]}" is-active --quiet weft-cloud || return 1
    response=$(curl --silent --show-error --fail --noproxy '*' --max-time 2 \
        http://127.0.0.1:8080/api/health) || return 1
    [[ "$response" =~ \"daemon\"[[:space:]]*:[[:space:]]*\"weft-cloud\" ]]
}
health || fail "The existing relay is not healthy; refusing to switch source."

# Determine the data path from the active process, not by sourcing the
# private env file or printing its contents. A relative DB outside source
# is also refused: its meaning must not change after restart.
pid=$("${service[@]}" show --property=MainPID --value weft-cloud)
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "No active Weft relay PID."
db=
backups=
static=
tablet_aarch64=
tablet_armv7=
got_env=0
while IFS= read -r -d '' entry; do
    got_env=1
    case "$entry" in
        CLOUD_DB=*) db=${entry#CLOUD_DB=} ;;
        WEFT_BACKUP_DIR=*) backups=${entry#WEFT_BACKUP_DIR=} ;;
        CLOUD_STATIC_DIR=*) static=${entry#CLOUD_STATIC_DIR=} ;;
        WEFT_DAEMON_RELEASE=*) tablet_aarch64=${entry#WEFT_DAEMON_RELEASE=} ;;
        WEFT_DAEMON_RELEASE_ARMV7=*) tablet_armv7=${entry#WEFT_DAEMON_RELEASE_ARMV7=} ;;
    esac
done < <(cat "/proc/$pid/environ")
(( got_env )) || fail "Cannot read the active Weft relay environment."
args=()
while IFS= read -r -d '' entry; do args+=("$entry"); done < <(cat "/proc/$pid/cmdline")
(( ${#args[@]} > 0 )) || fail "Cannot read the active Weft relay command."
# Match the server's first --db / --static-dir argument (when present).
db_arg=0
static_arg=0
for ((i=0; i+1<${#args[@]}; i++)); do
    if [[ "${args[i]}" == --db ]] && (( ! db_arg )); then
        db=${args[i+1]}
        db_arg=1
    fi
    if [[ "${args[i]}" == --static-dir ]] && (( ! static_arg )); then
        static=${args[i+1]}
        static_arg=1
    fi
done
check_data_path() {
    [[ "$1" == /* ]] || fail "Use an absolute $2 outside the relay source tree."
    local path source
    source=$(realpath -e -- "$live")
    for path in "$(realpath -m -- "$1")" "$(realpath -m -s -- "$1")"; do
        case "$path" in
            "$source"|"$source"/*|"$live"|"$live"/*)
                fail "Move $2 outside the relay source tree before enabling CI deploy."
                ;;
        esac
    done
}
check_data_path "$db" CLOUD_DB
[[ -f "$db" ]] || fail "The active relay database is not present at its configured path."
# Bun can load source-local env files implicitly. Do not silently drop them
# during a source switch; the systemd runtime environment is outside source.
for cwd in "$live" "$live/apps/cloud"; do
    for env_file in .env .env.local .env.development .env.production .env.test; do
        [[ ! -f "$cwd/$env_file" ]] || fail "Move source-local runtime settings to ~/weft/env first."
    done
done
check_data_path "$db-files" "the relay blob directory"
check_data_path "$db-wal" "the SQLite WAL"
check_data_path "$db-shm" "the SQLite shared-memory file"
if [[ -n "$backups" ]]; then check_data_path "$backups" WEFT_BACKUP_DIR; fi
if [[ -n "$static" ]]; then check_data_path "$static" CLOUD_STATIC_DIR; fi
if [[ -n "$tablet_aarch64" ]]; then check_data_path "$tablet_aarch64" WEFT_DAEMON_RELEASE; fi
if [[ -n "$tablet_armv7" ]]; then check_data_path "$tablet_armv7" WEFT_DAEMON_RELEASE_ARMV7; fi

# The local deployment workflow remains separate. Serialize CI deploys on the
# host as well, so another still-running CI process cannot race the switch.
exec 9>"$base/.relay-deploy.lock"
flock -n 9 || fail "Another relay deployment holds the host lock."
# Stage beside src so the swap stays on the same filesystem, not under the
# tablet release directory (which may be a separate mount).
work=$(mktemp -d "$base/.relay-$sha.XXXXXX")
prior="$work/prior"
stage="$work/stage"
committed=0
cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    set +e
    if (( ! committed )) && [[ -e "$prior" || -L "$prior" ]]; then
        if [[ -e "$live" || -L "$live" ]] && ! mv -T -- "$live" "$work/failed"; then
            echo "Cannot set aside failed deployment; previous source retained in $prior." >&2
            exit 1
        fi
        if ! mv -T -- "$prior" "$live" ||
            ! timeout 30 "${service[@]}" restart weft-cloud || ! wait_healthy; then
            echo "Rollback did not recover relay health; deployment files retained in $work." >&2
            exit 1
        fi
        # This restores code, not database migrations. Keep schema changes
        # compatible with restarting the previous version.
        echo "Rolled back to the previous relay source." >&2
    fi
    # An existing installation may contain operator-owned source-local files.
    # Keep the complete previous tree on success; mutate/remove nothing in it.
    if (( ! committed )); then rm -rf -- "$work"; fi
    exit "$status"
}
wait_healthy() {
    for i in {1..15}; do
        if health; then return 0; fi
        sleep 1
    done
    return 1
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -- "$stage"
tar -xzf - -C "$stage"
test -s "$stage/apps/cloud/src/server.ts"
(cd "$stage" && "$bun" install --frozen-lockfile --filter @weft/cloud)
mv -T -- "$live" "$prior"
mv -T -- "$stage" "$live"
timeout 30 "${service[@]}" restart weft-cloud
wait_healthy
committed=1
echo "Deployed relay $sha. Previous source retained in $prior."
REMOTE
)

# Run the freshness check after approval and packaging, immediately before
# the one SSH call (including before the first mutation on the VPS).
head_sha=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
[[ "$head_sha" == "$GITHUB_SHA" ]] || { echo "main has advanced; dispatch the current tested commit." >&2; exit 1; }
unset GH_TOKEN
# POSIX single-quote escaping (the account's login shell invokes bash).
quoted="'${remote//\'/\'\\\'\'}'"
ssh -T -F "$scratch/config" weft-ci-vps "bash -c $quoted bash $GITHUB_SHA" < "$scratch/source.tgz"
