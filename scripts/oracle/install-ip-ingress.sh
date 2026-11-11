#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: install-ip-ingress.sh <public-ipv4> <loopback-upstream-port>" >&2
  exit 64
fi

public_ip="$1"
upstream_port="$2"

python3 - "$public_ip" "$upstream_port" <<'PY'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if address.version != 4 or not address.is_global:
    raise SystemExit("public-ipv4 must be a globally routable IPv4 address")
port = int(sys.argv[2])
if not 1024 <= port <= 65535:
    raise SystemExit("loopback-upstream-port must be between 1024 and 65535")
PY

readonly install_root=/opt/omnicodex-ingress
readonly certbot_root="$install_root/certbot"
readonly webroot=/var/lib/omnicodex-ingress/acme
readonly config_root=/etc/omnicodex-ingress
readonly tls_root="$config_root/tls"
readonly caddy_fragment=/etc/caddy/omnicodex-ingress.caddy
readonly caddy_config=/etc/caddy/Caddyfile
readonly certificate_name=omnicodex-ip
readonly certificate_live_dir="/etc/letsencrypt/live/$certificate_name"

missing_packages=()
command -v caddy >/dev/null 2>&1 || missing_packages+=(caddy)
if ! dpkg-query -W -f='${Status}' python3-venv 2>/dev/null | grep -Fqx 'install ok installed'; then
  missing_packages+=(python3-venv)
fi
if (( ${#missing_packages[@]} > 0 )); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

# Ubuntu's older Caddy closes POST bodies on a failed upstream connection.
# The owned managed release preserves them without imposing a body buffer cap.
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
managed_caddy="$(python3 "$script_root/install-managed-caddy.py")"
caddy() { "$managed_caddy" "$@"; }

install -d -m 0755 "$install_root" "$webroot/.well-known/acme-challenge" "$config_root"
install -d -o root -g caddy -m 0750 "$tls_root"

# OCI Ubuntu images ship with an INPUT reject after the SSH rule.  Open only
# the two public ingress ports owned by this dedicated host, before that
# reject, and restore them on every boot without touching any other rule.
firewall_script="$install_root/ensure-firewall.sh"
cat >"$firewall_script" <<'FIREWALL'
#!/usr/bin/env bash
set -euo pipefail

for port in 80 443; do
  if /usr/sbin/iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    continue
  fi
  reject_line="$(/usr/sbin/iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
  if [[ -n "$reject_line" ]]; then
    /usr/sbin/iptables -I INPUT "$reject_line" -p tcp --dport "$port" -j ACCEPT
  else
    /usr/sbin/iptables -A INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
FIREWALL
chmod 0750 "$firewall_script"

cat >/etc/systemd/system/omnicodex-ingress-firewall.service <<UNIT
[Unit]
Description=Open the dedicated OmniCodex HTTPS ingress ports
DefaultDependencies=no
After=network-pre.target
Before=network.target caddy.service

[Service]
Type=oneshot
ExecStart=$firewall_script
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now omnicodex-ingress-firewall.service

if [[ ! -x "$certbot_root/bin/certbot" ]]; then
  python3 -m venv "$certbot_root"
  "$certbot_root/bin/python" -m pip install --disable-pip-version-check --upgrade pip
  "$certbot_root/bin/python" -m pip install --disable-pip-version-check 'certbot==5.4.0'
fi

if ! grep -Fqx 'import /etc/caddy/omnicodex-ingress.caddy' "$caddy_config"; then
  cp -a "$caddy_config" "$config_root/Caddyfile.before-omnicodex"
  printf '\nimport /etc/caddy/omnicodex-ingress.caddy\n' >>"$caddy_config"
fi

bootstrap_fragment="$(mktemp "$config_root/caddy.bootstrap.XXXXXX")"
cat >"$bootstrap_fragment" <<CADDY
http://$public_ip {
	handle /.well-known/acme-challenge/* {
		root * $webroot
		file_server
	}
	respond 404
}
CADDY
install -m 0644 "$bootstrap_fragment" "$caddy_fragment"
rm -f "$bootstrap_fragment"
caddy validate --config "$caddy_config" --adapter caddyfile
timeout 30s "$managed_caddy" reload --config "$caddy_config" --adapter caddyfile --force

"$certbot_root/bin/certbot" certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path "$webroot" \
  --ip-address "$public_ip" \
  --cert-name "$certificate_name" \
  --keep-until-expiring

test -s "$certificate_live_dir/fullchain.pem"
test -s "$certificate_live_dir/privkey.pem"

certificate_deployer="$install_root/install-certificate.sh"
cat >"$certificate_deployer" <<DEPLOY
#!/usr/bin/env bash
set -euo pipefail
install -o root -g caddy -m 0640 "$certificate_live_dir/fullchain.pem" "$tls_root/.fullchain.pem.new"
install -o root -g caddy -m 0640 "$certificate_live_dir/privkey.pem" "$tls_root/.privkey.pem.new"
mv -f "$tls_root/.fullchain.pem.new" "$tls_root/fullchain.pem"
mv -f "$tls_root/.privkey.pem.new" "$tls_root/privkey.pem"
"$managed_caddy" validate --config "$caddy_config" --adapter caddyfile
timeout 30s "$managed_caddy" reload --config "$caddy_config" --adapter caddyfile --force
DEPLOY
chmod 0750 "$certificate_deployer"
install -o root -g caddy -m 0640 "$certificate_live_dir/fullchain.pem" "$tls_root/fullchain.pem"
install -o root -g caddy -m 0640 "$certificate_live_dir/privkey.pem" "$tls_root/privkey.pem"

final_fragment="$(mktemp "$config_root/caddy.final.XXXXXX")"
cat >"$final_fragment" <<CADDY
http://$public_ip {
	handle /.well-known/acme-challenge/* {
		root * $webroot
		file_server
	}
	handle {
		redir https://$public_ip{uri} permanent
	}
}

https:// {
	tls $tls_root/fullchain.pem $tls_root/privkey.pem
	@omnicodex_ip host $public_ip
	handle @omnicodex_ip {
		encode zstd gzip
		reverse_proxy 127.0.0.1:$upstream_port {
			flush_interval -1
			# Node closes idle upstream sockets after 5s. Expire Caddy's
			# pooled connection first so a POST never uses a stale socket.
			transport http {
				keepalive 2s
			}
			# Retain requests while the owned backhaul is reconnecting. Keep
			# Caddy's default retry matcher: an already-dispatched POST whose
			# response was lost must not be replayed.
			lb_try_duration 90s
			lb_try_interval 250ms
		}
	}
	respond 421
}
CADDY
install -m 0644 "$final_fragment" "$caddy_fragment"
rm -f "$final_fragment"
caddy validate --config "$caddy_config" --adapter caddyfile
timeout 30s "$managed_caddy" reload --config "$caddy_config" --adapter caddyfile --force

cat >/etc/systemd/system/omnicodex-ingress-certificate.service <<UNIT
[Unit]
Description=Renew OmniCodex public IP TLS certificate
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$certbot_root/bin/certbot renew --cert-name $certificate_name --quiet --deploy-hook $certificate_deployer
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt $tls_root
UNIT

cat >/etc/systemd/system/omnicodex-ingress-certificate.timer <<'UNIT'
[Unit]
Description=Schedule OmniCodex public IP TLS certificate renewal

[Timer]
OnBootSec=15min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now omnicodex-ingress-certificate.timer

openssl x509 -in "$tls_root/fullchain.pem" -noout -checkip "$public_ip"
systemctl is-active --quiet caddy
systemctl is-active --quiet omnicodex-ingress-certificate.timer
