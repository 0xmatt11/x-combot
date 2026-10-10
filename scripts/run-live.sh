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
# Exit 75 means the X login expired (data/reauth-needed). The supervisor does
# not restart on that code. It checks every REAUTH_POLL_SEC (default 60s) and
# starts again only after data/tokens.json changes or the marker is removed.
# A heartbeat file older than HANG_STALE_SEC (default 10 min), after a
# HANG_GRACE_SEC (default 5 min) grace, is SIGTERM, then SIGKILL after
# TERM_GRACE_SEC (default 15s) so an in-flight token refresh can finish
# writing. The same grace is used when the supervisor itself stops. That
# shares the HANG_RESTART_STAMP 30 min cap with the in-process watchdog.
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
# Distinct from crash exits. src/x/token-file.ts REAUTH_EXIT_CODE must match.
REAUTH_EXIT_CODE=75
REAUTH_POLL_SEC="${X_COMBOT_REAUTH_POLL_SEC:-60}"
TOKEN_FILE="${X_COMBOT_TOKEN_FILE:-${ROOT}/data/tokens.json}"
# Beside tokens.json, so the default is data/reauth-needed.
REAUTH_MARKER="${X_COMBOT_REAUTH_MARKER:-$(dirname "$TOKEN_FILE")/reauth-needed}"
TERM_GRACE_SEC="${X_COMBOT_TERM_GRACE_SEC:-15}"
if [[ ! "$REAUTH_POLL_SEC" =~ ^[0-9]+$ ]] || (( REAUTH_POLL_SEC < 1 )); then
  REAUTH_POLL_SEC=60
fi

mkdir -p "$(dirname "$LOG")"

if [[ "${X_COMBOT_SUPERVISOR_TEST:-}" != "wait-for-reauth" ]]; then
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
fi

token_fingerprint() {
  if [[ ! -f "$TOKEN_FILE" ]]; then
    printf 'missing\n'
    return 0
  fi
  local mtime hash
  mtime="$(stat -c %Y -- "$TOKEN_FILE" 2>/dev/null || printf '0')"
  hash="$(sha256sum -- "$TOKEN_FILE" 2>/dev/null | awk 'NR==1 { print $1 }')"
  if [[ -z "$hash" ]]; then
    hash="unreadable"
  fi
  printf '%s %s\n' "$mtime" "$hash"
}

# Exit 75: do not crash-loop. Sleep and look for a re-auth (new tokens or a cleared marker).
wait_for_reauth() {
  local baseline now saw=0
  baseline="$(token_fingerprint)"
  if [[ -f "$REAUTH_MARKER" ]]; then
    saw=1
  fi
  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] ERROR supervisor: X login expired (exit ${REAUTH_EXIT_CODE}); not restarting. Waiting for re-auth (npm run oauth). Checking every ${REAUTH_POLL_SEC}s."
  } >>"$LOG"
  while true; do
    sleep "$REAUTH_POLL_SEC" || true
    now="$(token_fingerprint)"
    if [[ "$now" != "$baseline" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] INFO supervisor: tokens.json changed; resuming" >>"$LOG"
      return 0
    fi
    if (( saw == 1 )) && [[ ! -f "$REAUTH_MARKER" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] INFO supervisor: reauth marker removed; resuming" >>"$LOG"
      return 0
    fi
    if [[ -f "$REAUTH_MARKER" ]]; then
      saw=1
    fi
  done
}

if [[ "${X_COMBOT_SUPERVISOR_TEST:-}" == "wait-for-reauth" ]]; then
  wait_for_reauth
  exit 0
fi

echo $$ >"$PIDFILE"

child_pid=""
watch_pid=""

# Same files the in-process watchdog writes. Override with HANG_* in the environment.
HEARTBEAT_FILE="${HANG_HEARTBEAT_FILE:-/tmp/x-combot.heartbeat}"
RESTART_STAMP="${HANG_RESTART_STAMP:-/tmp/x-combot.last-restart}"
HANG_CHECK_SEC="${HANG_CHECK_SEC:-60}"
HANG_STALE_SEC="${HANG_STALE_SEC:-600}"
HANG_GRACE_SEC="${HANG_GRACE_SEC:-300}"
if [[ -n "${HANG_RESTART_COOLDOWN_MS:-}" ]]; then
  HANG_RESTART_COOLDOWN_SEC=$(( HANG_RESTART_COOLDOWN_MS / 1000 ))
fi
HANG_RESTART_COOLDOWN_SEC="${HANG_RESTART_COOLDOWN_SEC:-1800}"

hang_num() {
  local value="$1" fallback="$2" min="$3"
  if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= min )); then
    printf '%s\n' "$value"
    return 0
  fi
  printf '%s\n' "$fallback"
}

HANG_CHECK_SEC="$(hang_num "$HANG_CHECK_SEC" 60 1)"
HANG_STALE_SEC="$(hang_num "$HANG_STALE_SEC" 600 1)"
HANG_GRACE_SEC="$(hang_num "$HANG_GRACE_SEC" 300 0)"
HANG_RESTART_COOLDOWN_SEC="$(hang_num "$HANG_RESTART_COOLDOWN_SEC" 1800 1)"
# Longer than the bot's 5s in-flight refresh wait. Was 10 one-second checks.
TERM_GRACE_SEC="$(hang_num "$TERM_GRACE_SEC" 15 5)"

signal_child() {
  local sig="$1"
  local pid="$2"
  if [[ -z "$pid" ]]; then
    return 0
  fi
  # setsid makes the child a process-group leader, so the bot (tsx) dies with npm.
  kill "-${sig}" -- "-${pid}" 2>/dev/null || kill "-${sig}" "$pid" 2>/dev/null || true
}

hang_restart_blocked() {
  [[ -f "$RESTART_STAMP" ]] || return 1
  local last now last_sec
  last="$(tr -dc '0-9' <"$RESTART_STAMP" 2>/dev/null || true)"
  [[ -n "$last" ]] || return 1
  now="$(date +%s)"
  last_sec=$(( last / 1000 ))
  if (( now - last_sec < HANG_RESTART_COOLDOWN_SEC )); then
    return 0
  fi
  return 1
}

hang_write_stamp() {
  local now_ms
  now_ms="$(date +%s%3N)"
  mkdir -p -- "$(dirname "$RESTART_STAMP")"
  printf '%s\n' "$now_ms" >"${RESTART_STAMP}.tmp"
  mv -f "${RESTART_STAMP}.tmp" "$RESTART_STAMP"
}

# Backstop for a frozen event loop. The bot touches HEARTBEAT_FILE every minute.
hang_watch() {
  local pid="$1"
  local started now mtime elapsed=0 announced=0 stale
  started="$(date +%s)"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1 || return 0
    kill -0 "$pid" 2>/dev/null || return 0
    elapsed=$(( elapsed + 1 ))
    if (( elapsed < HANG_CHECK_SEC )); then
      continue
    fi
    elapsed=0
    now="$(date +%s)"
    if (( now - started < HANG_GRACE_SEC )); then
      continue
    fi
    stale=0
    if [[ ! -f "$HEARTBEAT_FILE" ]]; then
      stale=1
    else
      mtime="$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)"
      if (( now - mtime > HANG_STALE_SEC )); then
        stale=1
      fi
    fi
    if (( stale == 0 )); then
      announced=0
      continue
    fi
    if hang_restart_blocked; then
      if (( announced == 0 )); then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] WARN supervisor: heartbeat stale; restart suppressed by ${HANG_RESTART_COOLDOWN_SEC}s cap" >>"$LOG"
        announced=1
      fi
      continue
    fi
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] WARN supervisor: heartbeat older than ${HANG_STALE_SEC}s; stopping pid ${pid} for restart" >>"$LOG"
    hang_write_stamp || true
    signal_child TERM "$pid"
    local i=0
    while (( i < TERM_GRACE_SEC )); do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 1 || return 0
      i=$(( i + 1 ))
    done
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] WARN supervisor: pid ${pid} ignored SIGTERM for ${TERM_GRACE_SEC}s; sending SIGKILL" >>"$LOG"
    signal_child KILL "$pid"
    return 0
  done
}

cleanup() {
  if [[ -n "${watch_pid}" ]] && kill -0 "$watch_pid" 2>/dev/null; then
    kill -TERM "$watch_pid" 2>/dev/null || true
    wait "$watch_pid" 2>/dev/null || true
  fi
  watch_pid=""
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    signal_child TERM "$child_pid"
    local i=0
    while (( i < TERM_GRACE_SEC )); do
      kill -0 "$child_pid" 2>/dev/null || break
      sleep 1
      i=$(( i + 1 ))
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] WARN supervisor: pid ${child_pid} ignored SIGTERM for ${TERM_GRACE_SEC}s; sending SIGKILL" >>"$LOG"
      signal_child KILL "$child_pid"
    fi
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
  setsid npm start >>"$LOG" 2>&1 &
  child_pid=$!
  hang_watch "$child_pid" &
  watch_pid=$!
  wait "$child_pid"
  code=$?
  set -e
  if [[ -n "$watch_pid" ]]; then
    kill -TERM "$watch_pid" 2>/dev/null || true
    wait "$watch_pid" 2>/dev/null || true
  fi
  child_pid=""
  watch_pid=""

  ran=$(( $(date +%s) - started_at ))
  if [[ "$code" -eq "$REAUTH_EXIT_CODE" ]]; then
    {
      echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] ERROR supervisor: bot exited code=${code} after ${ran}s; X login expired; not restarting"
    } >>"$LOG"
    wait_for_reauth
    backoff=$BACKOFF_SEC
    continue
  fi
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
