#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: install-backhaul-user.sh <ed25519-public-key-file> <loopback-listen-port>" >&2
  exit 64
fi

readonly public_key_file="$1"
readonly listen_port="$2"
readonly account=omnicodex-backhaul
readonly sshd_fragment=/etc/ssh/sshd_config.d/90-omnicodex-backhaul.conf

python3 - "$public_key_file" "$listen_port" <<'PY'
from pathlib import Path
import sys

key = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
parts = key.split()
if len(parts) < 2 or parts[0] != "ssh-ed25519" or "\n" in key or "\r" in key:
    raise SystemExit("public key must be exactly one OpenSSH Ed25519 key")
port = int(sys.argv[2])
if not 1024 <= port <= 65535:
    raise SystemExit("loopback-listen-port must be between 1024 and 65535")
PY

if ! id "$account" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "OmniCodex reverse SSH backhaul" "$account"
fi
passwd --lock "$account" >/dev/null

home_directory="$(getent passwd "$account" | cut -d: -f6)"
test -n "$home_directory"
install -d -o "$account" -g "$account" -m 0700 "$home_directory/.ssh"

public_key="$(tr -d '\r\n' <"$public_key_file")"
authorized_keys="$(mktemp)"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s",command="/usr/bin/false" %s\n' \
  "$listen_port" "$public_key" >"$authorized_keys"
install -o "$account" -g "$account" -m 0600 "$authorized_keys" "$home_directory/.ssh/authorized_keys"
rm -f "$authorized_keys"

sshd_candidate="$(mktemp /etc/ssh/sshd_config.d/90-omnicodex-backhaul.XXXXXX)"
cat >"$sshd_candidate" <<SSHD
Match User $account
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    GatewayPorts no
    PermitOpen none
    PermitListen 127.0.0.1:$listen_port
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /usr/bin/false
SSHD
install -o root -g root -m 0644 "$sshd_candidate" "$sshd_fragment"
rm -f "$sshd_candidate"

sshd -t
systemctl reload ssh.service

test "$(id -u "$account")" -ge 1000
test "$(stat -c '%U:%G:%a' "$home_directory/.ssh/authorized_keys")" = "$account:$account:600"
printf 'backhaul_user=%s listen=127.0.0.1:%s\n' "$account" "$listen_port"
