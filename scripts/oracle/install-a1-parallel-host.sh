#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: install-a1-parallel-host.sh <public-ipv4> <backhaul-public-key-file> [browser-executable|auto]" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-a1-parallel-host.sh must run as root" >&2
  exit 77
fi

readonly public_ip="$1"
readonly backhaul_public_key_file="$2"
readonly browser_executable="${3:-auto}"
readonly script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly backhaul_port=18766

python3 - "$public_ip" <<'PY'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if address.version != 4 or not address.is_global:
    raise SystemExit("public-ipv4 must be a globally routable IPv4 address")
PY

for required in \
  "$script_root/install-backhaul-user.sh" \
  "$script_root/install-ip-ingress.sh" \
  "$script_root/install-managed-caddy.py" \
  "$script_root/install-oracle-browser-host.sh" \
  "$script_root/oracle-browser-profile.py" \
  "$script_root/oracle-browser-run.sh" \
  "$script_root/omnicodex-oracle-xvfb.service" \
  "$script_root/omnicodex-oracle-browser.service" \
  "$backhaul_public_key_file"; do
  if [[ ! -f "$required" ]]; then
    printf 'required deployment input is missing: %s\n' "$required" >&2
    exit 66
  fi
done

if [[ "$(uname -m)" != aarch64 ]]; then
  printf 'refusing non-A1 architecture: %s\n' "$(uname -m)" >&2
  exit 78
fi

if ! command -v caddy >/dev/null 2>&1 || \
   ! dpkg-query -W -f='${Status}' python3-venv 2>/dev/null | grep -Fqx 'install ok installed'; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends caddy python3-venv
fi

bash "$script_root/install-backhaul-user.sh" "$backhaul_public_key_file" "$backhaul_port"
bash "$script_root/install-ip-ingress.sh" "$public_ip" "$backhaul_port"
bash "$script_root/install-oracle-browser-host.sh" "$browser_executable"

systemctl is-active --quiet caddy
systemctl is-active --quiet omnicodex-oracle-xvfb.service
systemctl is-active --quiet omnicodex-oracle-browser.service
ss -ltn | grep -Fq '127.0.0.1:19222'

printf 'a1_parallel_host=ready public_url=https://%s/mcp/full backhaul=127.0.0.1:%s cdp=127.0.0.1:19222\n' \
  "$public_ip" "$backhaul_port"
