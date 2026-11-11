#!/usr/bin/env bash
set -euo pipefail

: "${ORACLE_BROWSER_EXECUTABLE:?ORACLE_BROWSER_EXECUTABLE is required}"
: "${ORACLE_BROWSER_PROFILE:?ORACLE_BROWSER_PROFILE is required}"
browser_cdp_port="${ORACLE_BROWSER_CDP_PORT:-19222}"
if [[ ! "$browser_cdp_port" =~ ^[1-9][0-9]{0,4}$ ]] || ((10#$browser_cdp_port > 65535)); then
  printf 'browser CDP port must be between 1 and 65535: %s\n' "$browser_cdp_port" >&2
  exit 64
fi

if [[ ! -x "$ORACLE_BROWSER_EXECUTABLE" ]]; then
  printf 'browser executable is missing or not executable: %s\n' "$ORACLE_BROWSER_EXECUTABLE" >&2
  exit 66
fi

exec "$ORACLE_BROWSER_EXECUTABLE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$browser_cdp_port" \
  --user-data-dir="$ORACLE_BROWSER_PROFILE" \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --window-size=1920,1080 \
  https://chatgpt.com/
