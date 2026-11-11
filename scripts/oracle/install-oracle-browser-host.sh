#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 && $# -ne 1 && $# -ne 4 && $# -ne 5 ]]; then
  echo "usage: install-oracle-browser-host.sh [browser-executable|auto] [instance-name profile-path cdp-port [display-number]]" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-oracle-browser-host.sh must run as root" >&2
  exit 77
fi

readonly script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly requested_browser="${1:-auto}"
readonly install_root=/opt/omnicodex-oracle-browser
readonly lab_root=/home/ubuntu/omnicodex-lab
readonly instance_name="${2:-}"
readonly requested_profile="${3:-}"
readonly browser_cdp_port="${4:-19222}"
readonly requested_display="${5:-}"
environment_file=/etc/omnicodex-oracle-browser.env
browser_service=omnicodex-oracle-browser.service
xvfb_service=omnicodex-oracle-xvfb.service
display_number=177
preserve_legacy_shared_display=false
if [[ -n "$instance_name" ]]; then
  if [[ ! "$instance_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    echo "browser instance name must contain only letters, digits, underscores, or hyphens" >&2
    exit 64
  fi
  if [[ ! "$requested_profile" =~ ^/[A-Za-z0-9._/+:-]+$ ]]; then
    echo "browser profile must be an absolute path without environment-file special characters" >&2
    exit 64
  fi
  environment_file="/etc/omnicodex-oracle-browser-${instance_name}.env"
  browser_service="omnicodex-oracle-browser@${instance_name}.service"
  if [[ -f "$environment_file" ]]; then
    while IFS='=' read -r key value; do
      if [[ "$key" == DISPLAY && "$value" =~ ^:([0-9]+)$ ]]; then
        display_number="${BASH_REMATCH[1]}"
      fi
    done <"$environment_file"
    if [[ -z "$requested_display" && "$display_number" == 177 ]]; then
      preserve_legacy_shared_display=true
    fi
  fi
  if [[ -n "$requested_display" ]]; then
    display_number="$requested_display"
  fi
  if [[ ! "$display_number" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "browser display number must be a non-negative decimal integer" >&2
    exit 64
  fi
  if [[ "$display_number" != 177 ]]; then
    xvfb_service="omnicodex-oracle-xvfb@${instance_name}.service"
  fi
fi
if [[ ! "$browser_cdp_port" =~ ^[1-9][0-9]{0,4}$ ]] || ((10#$browser_cdp_port > 65535)); then
  echo "browser CDP port must be between 1 and 65535" >&2
  exit 64
fi

if ! id ubuntu >/dev/null 2>&1; then
  echo "required account is missing: ubuntu" >&2
  exit 69
fi

missing_packages=()
command -v Xvfb >/dev/null 2>&1 || missing_packages+=(xvfb)
command -v x11vnc >/dev/null 2>&1 || missing_packages+=(x11vnc)
command -v python3 >/dev/null 2>&1 || missing_packages+=(python3)
command -v file >/dev/null 2>&1 || missing_packages+=(file)
if ((${#missing_packages[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

browser_executable="$requested_browser"
if [[ "$requested_browser" == auto ]]; then
  for candidate in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
    if [[ -x "$candidate" ]]; then
      browser_executable="$candidate"
      break
    fi
  done
  if [[ "$browser_executable" == auto ]]; then
    if ! command -v snap >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends snapd
    fi
    systemctl enable --now snapd.socket
    snap wait system seed.loaded
    snap install chromium
    browser_executable=/snap/bin/chromium
  fi
fi

if [[ "$browser_executable" != /* || ! -x "$browser_executable" ]]; then
  printf 'browser executable must be an executable absolute path: %s\n' "$browser_executable" >&2
  exit 66
fi
if [[ ! "$browser_executable" =~ ^/[A-Za-z0-9._/+:-]+$ ]]; then
  printf 'browser executable contains unsupported environment-file characters: %s\n' "$browser_executable" >&2
  exit 65
fi

machine="$(uname -m)"
browser_file="$(file -Lb "$browser_executable" 2>/dev/null || true)"
if [[ "$machine" == aarch64 && "$browser_file" == *x86-64* ]]; then
  printf 'refusing x86-64 browser on A1 aarch64: %s\n' "$browser_executable" >&2
  exit 78
fi

if [[ "$browser_executable" == /snap/bin/chromium ]]; then
  browser_home=/home/ubuntu
  profile_root=/home/ubuntu/snap/chromium/common/omnicodex-profile
else
  browser_home="$lab_root/home"
  profile_root="$lab_root/home/.oracle/browser-profile"
fi
if [[ -n "$instance_name" ]]; then
  profile_root="$(realpath -m -- "$requested_profile")"
  if [[ "$profile_root" == / ]]; then
    echo "browser profile cannot be the filesystem root" >&2
    exit 64
  fi
  # Each browser keeps its own account data, CDP listener, and login display.
  for other_environment in /etc/omnicodex-oracle-browser.env /etc/omnicodex-oracle-browser-*.env; do
    [[ -f "$other_environment" && "$other_environment" != "$environment_file" ]] || continue
    other_profile=""
    other_port=19222
    other_display=177
    while IFS='=' read -r key value; do
      case "$key" in
        ORACLE_BROWSER_PROFILE) other_profile="$value" ;;
        ORACLE_BROWSER_CDP_PORT) other_port="$value" ;;
        DISPLAY) other_display="${value#:}" ;;
      esac
    done <"$other_environment"
    if [[ "$other_port" == "$browser_cdp_port" ||
          ( "$other_display" == "$display_number" && "$preserve_legacy_shared_display" != true ) ||
          ( -n "$other_profile" && "$(realpath -m -- "$other_profile")" == "$profile_root" ) ]]; then
      printf 'browser profile, CDP port, or display is already assigned by %s\n' "$other_environment" >&2
      exit 78
    fi
  done
fi

install -d -o root -g root -m 0755 "$install_root"
install -d -o ubuntu -g ubuntu -m 0750 "$lab_root" "$lab_root/home" "$lab_root/home/.oracle"
install -d -o ubuntu -g ubuntu -m 0700 "$browser_home/.config" "$browser_home/.config/google-chrome"
install -d -o ubuntu -g ubuntu -m 0700 "$browser_home/.config/google-chrome/Crash Reports"
if [[ "$browser_executable" == /snap/bin/chromium ]]; then
  install -d -o ubuntu -g ubuntu -m 0755 \
    /home/ubuntu/snap \
    /home/ubuntu/snap/chromium \
    /home/ubuntu/snap/chromium/common
fi
install -d -o ubuntu -g ubuntu -m 0700 "$profile_root"
install -o root -g root -m 0755 "$script_root/oracle-browser-profile.py" "$install_root/oracle-browser-profile.py"
install -o root -g root -m 0755 "$script_root/oracle-browser-run.sh" "$install_root/oracle-browser-run.sh"

environment_candidate="$(mktemp "${environment_file}.XXXXXX")"
printf 'HOME=%s\nORACLE_BROWSER_EXECUTABLE=%s\nORACLE_BROWSER_PROFILE=%s\nORACLE_BROWSER_CDP_PORT=%s\nDISPLAY=:%s\n' \
  "$browser_home" "$browser_executable" "$profile_root" "$browser_cdp_port" "$display_number" >"$environment_candidate"
restart_required=false
if [[ -f "$environment_file" ]] && ! cmp -s "$environment_candidate" "$environment_file" &&
   systemctl is-active --quiet "$browser_service"; then
  restart_required=true
fi
install -o root -g root -m 0644 "$environment_candidate" "$environment_file"
rm -f "$environment_candidate"

if [[ "$xvfb_service" == omnicodex-oracle-xvfb.service &&
      ( -z "$instance_name" || ! -f /etc/systemd/system/omnicodex-oracle-xvfb.service ) ]]; then
  install -o root -g root -m 0644 \
    "$script_root/omnicodex-oracle-xvfb.service" \
    /etc/systemd/system/omnicodex-oracle-xvfb.service
fi
if [[ -z "$instance_name" ]]; then
  install -o root -g root -m 0644 \
    "$script_root/omnicodex-oracle-browser.service" \
    /etc/systemd/system/omnicodex-oracle-browser.service
else
  install -o root -g root -m 0644 \
    "$script_root/omnicodex-oracle-xvfb@.service" \
    /etc/systemd/system/omnicodex-oracle-xvfb@.service
  install -o root -g root -m 0644 \
    "$script_root/omnicodex-oracle-browser@.service" \
    /etc/systemd/system/omnicodex-oracle-browser@.service
  override_root="/etc/systemd/system/${browser_service}.d"
  install -d -o root -g root -m 0755 "$override_root"
  printf '[Unit]\nRequires=%s\nAfter=%s\n\n[Service]\nReadWritePaths=%s\n' \
    "$xvfb_service" "$xvfb_service" "$profile_root" >"$override_root/profile.conf"
  chmod 0644 "$override_root/profile.conf"
fi

systemctl daemon-reload
systemctl enable --now "$xvfb_service" "$browser_service"
systemctl is-active --quiet "$xvfb_service"
systemctl is-active --quiet "$browser_service"

version="$($browser_executable --version | head -n 1)"
printf 'oracle_browser=configured architecture=%s executable=%s version=%q cdp=127.0.0.1:%s service=%s display_requested=:%s restart_required=%s\n' \
  "$machine" "$browser_executable" "$version" "$browser_cdp_port" "$browser_service" "$display_number" "$restart_required"
