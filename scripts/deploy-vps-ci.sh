#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VPS_HOST:?Set the deployment host}"
: "${VPS_USER:?Set the deployment account}"
: "${VPS_SSH_KEY:?Set a dedicated deployment SSH key}"
: "${VPS_KNOWN_HOSTS:?Set the VPS host key verified out of band}"
: "${VPS_PORT:=22}"
[[ "$VPS_HOST" =~ ^[[:alnum:]][[:alnum:].:-]*$ ]]
[[ "$VPS_USER" =~ ^[[:alnum:]_][[:alnum:]_.-]*$ ]]
[[ "$VPS_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( VPS_PORT < 65536 ))
ssh_dir=$(mktemp -d "$HOME/.weft-ci-ssh.XXXXXXXX")
trap 'rm -rf "$ssh_dir"' EXIT
umask 077
printf '%s\n' "$VPS_SSH_KEY" > "$ssh_dir/deploy_key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS
export WEFT_SSH_CONFIG="$ssh_dir/config"
cat > "$WEFT_SSH_CONFIG" <<SSH
Host weft-ci-vps
    HostName $VPS_HOST
    User $VPS_USER
    Port $VPS_PORT
    IdentityFile $ssh_dir/deploy_key
    UserKnownHostsFile $ssh_dir/known_hosts
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    BatchMode yes
    ConnectTimeout 10
SSH
ssh -F "$WEFT_SSH_CONFIG" weft-ci-vps 'test -x ~/.bun/bin/bun && test -d ~/weft/src && test -d ~/weft/releases && test -r ~/weft/env && systemctl --user is-active --quiet weft-cloud'
WEFT_VPS=weft-ci-vps WEFT_VPS_PREBUILT=1 bash scripts/deploy-vps.sh
