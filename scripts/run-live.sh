#!/usr/bin/env bash
# Live x-combot supervisor — normal path (existing data/chat-keys.json; no CHAT_PIN/Juicebox).
#
# Start (from anywhere):
#   /workspace/x-combot/scripts/run-live.sh
#   # detached: nohup /workspace/x-combot/scripts/run-live.sh >/dev/null 2>&1 &
# Stop:
#   kill "$(cat /tmp/x-combot.pid)"    # stops supervisor; child gets SIGTERM
#   # ensure no stray bot: pgrep -af 'tsx src/index.ts'
#
# Behavior: cds to repo root, installs deps when node_modules is missing or
# the installed lock is stale (scripts/ensure-deps.sh), writes supervisor PID
# to /tmp/x-combot.pid, appends npm start output to logs/bot.log, and restarts
# on crash with short backoff. A failed install exits non-zero once (no retry
# loop); the backoff below applies after the bot process itself exits.
# Boot auto-start on this box: scripts/boot-start.sh via start-sand-box hook
# (install/refresh with: sudo ./scripts/install-box-boot-hook.sh).
# For Juicebox unlock use scripts/start-juicebox.sh instead (requires CHAT_PIN).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Boot env is minimal. Keep the caller's PATH so nvm/node stays visible.
export PATH="/usr/local/bin:/usr/bin:/bin:${ROOT}/node_modules/.bin${PATH:+:$PATH}"

PIDFILE="${X_COMBOT_PIDFILE:-/tmp/x-combot.pid}"
LOG="${X_COMBOT_LOG:-logs/bot.log}"
BACKOFF_SEC=5
MAX_BACKOFF_SEC=60
STABLE_SEC=120

mkdir -p "$(dirname "$LOG")"

if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old}" ]] && kill -0 "$old" 2>/dev/null; then
    echo "x-combot supervisor already running (pid $old). Stop first: kill $old" >&2
    exit 1
  fi
fi

# Refuse a second live bot even if pidfile is stale.
if pgrep -f -- 'tsx src/index\.ts' >/dev/null 2>&1; then
  echo "tsx src/index.ts already running; stop it before starting the supervisor." >&2
  pgrep -af -- 'tsx src/index\.ts' >&2 || true
  exit 1
fi

# Install only after the "already running" checks so npm ci cannot delete
# node_modules out from under a live bot.
if [[ "$LOG" = /* ]]; then
  export ENSURE_DEPS_BOT_LOG="$LOG"
else
  export ENSURE_DEPS_BOT_LOG="${ROOT}/${LOG}"
fi
export ENSURE_DEPS_BOOT_LOG="${X_COMBOT_BOOT_LOG:-/tmp/x-combot-boot.log}"
# shellcheck source=ensure-deps.sh
source "${ROOT}/scripts/ensure-deps.sh"
ensure_deps "${ROOT}"

echo $$ >"$PIDFILE"

child_pid=""
cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}
trap cleanup EXIT INT TERM

backoff=$BACKOFF_SEC

while true; do
  started_at=$(date +%s)
  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] INFO supervisor starting npm start (supervisor_pid=$$ backoff=${backoff}s)"
  } >>"$LOG"

  set +e
  npm start >>"$LOG" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  code=$?
  set -e
  child_pid=""

  ran=$(( $(date +%s) - started_at ))
  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] WARN supervisor: bot exited code=$code after ${ran}s; restart in ${backoff}s"
  } >>"$LOG"

  sleep "$backoff"

  if (( ran >= STABLE_SEC )); then
    backoff=$BACKOFF_SEC
  elif (( backoff < MAX_BACKOFF_SEC )); then
    backoff=$(( backoff + 5 ))
    if (( backoff > MAX_BACKOFF_SEC )); then
      backoff=$MAX_BACKOFF_SEC
    fi
  fi
done
