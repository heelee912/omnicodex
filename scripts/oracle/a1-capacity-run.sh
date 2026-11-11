#!/usr/bin/env bash
set -uo pipefail

: "${A1_PYTHON:?A1_PYTHON is required}"
: "${A1_SCRIPT:?A1_SCRIPT is required}"
: "${A1_CONFIG:?A1_CONFIG is required}"
: "${A1_PROFILE:?A1_PROFILE is required}"
: "${A1_SUBNET_NAME:?A1_SUBNET_NAME is required}"
: "${A1_DISPLAY_NAME:?A1_DISPLAY_NAME is required}"
: "${A1_SSH_PUBLIC_KEY_FILE:?A1_SSH_PUBLIC_KEY_FILE is required}"
: "${A1_STATE_FILE:?A1_STATE_FILE is required}"
: "${A1_STOP_FILE:?A1_STOP_FILE is required}"

if [[ -e "$A1_STOP_FILE" ]]; then
  stop_reason=$(head -n 1 "$A1_STOP_FILE")
  case "$stop_reason" in
    fatal:*)
      # Migrate the legacy failure latch. Keep its evidence, but do not let
      # a previous failed request masquerade as completion/operator intent.
      mv -- "$A1_STOP_FILE" "${A1_STOP_FILE}.legacy-$(date +%s%N)" || exit 1
      printf 'legacy failure latch archived; retrying this round\n' >&2
      ;;
    *) exit 0 ;;
  esac
fi

"$A1_PYTHON" "$A1_SCRIPT" \
  --config-file "$A1_CONFIG" \
  --profile "$A1_PROFILE" \
  --subnet-name "$A1_SUBNET_NAME" \
  --display-name "$A1_DISPLAY_NAME" \
  --ssh-public-key-file "$A1_SSH_PUBLIC_KEY_FILE" \
  --state-file "$A1_STATE_FILE" \
  --interval-seconds 60 \
  --jitter-seconds 10
exit_code=$?

case "$exit_code" in
  0)
    printf 'completed\n' >"$A1_STOP_FILE"
    exit 0
    ;;
  75|76)
    exit 0
    ;;
  *)
    # A failed round is not an operator stop. The timer retries, re-reading
    # inventory and enforcing quota/idempotency before any mutation.
    printf 'round failed (%s); next timer tick will retry\n' "$exit_code" >&2
    exit "$exit_code"
    ;;
esac
