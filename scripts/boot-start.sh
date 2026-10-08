#!/usr/bin/env bash
# Idempotent boot launcher for live x-combot (normal chat-keys path; no CHAT_PIN).
#
# Called from the box boot hook in /usr/local/bin/start-sand-box after desktop
# comes up. Safe to run anytime: exits without starting a second instance when
# /tmp/x-combot.pid is alive or tsx src/index.ts is already running.
#
# Install/refresh the hook: sudo ./scripts/install-box-boot-hook.sh
# Manual: ./scripts/boot-start.sh
# Stop bot: kill "$(cat /tmp/x-combot.pid)"

set -euo pipefail

ROOT="${X_COMBOT_ROOT:-/workspace/x-combot}"
PIDFILE="${X_COMBOT_PIDFILE:-/tmp/x-combot.pid}"
BOOT_LOG="${X_COMBOT_BOOT_LOG:-/tmp/x-combot-boot.log}"
BOT_LOG="${ROOT}/logs/bot.log"

mkdir -p "${ROOT}/logs" "$(dirname "${BOOT_LOG}")"
# Keep boot diagnostics out of bot.log noise unless we need an operator-visible warn.
exec >>"${BOOT_LOG}" 2>&1

ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# Image refresh can restore the repo and wipe /usr/local/bin/start-sand-box.
# Log the reinstall command only. Do not run sudo from boot.
warn_missing_boot_hook() {
  local target="${START_SAND_BOX:-/usr/local/bin/start-sand-box}"
  local marker="# >>> x-combot-boot-hook >>>"
  if [[ -f "${target}" ]] && grep -qF "${marker}" "${target}" 2>/dev/null; then
    return 0
  fi
  local msg="start-sand-box hook marker missing; reinstall with: sudo ./scripts/install-box-boot-hook.sh"
  echo "[$(ts)] WARN boot-start: ${msg}"
  if [[ -n "${BOT_LOG:-}" ]]; then
    echo "[$(ts)] WARN boot-start: ${msg}" >>"${BOT_LOG}" || true
  fi
}

echo "[$(ts)] INFO boot-start begin root=${ROOT}"
warn_missing_boot_hook

if [[ ! -d "${ROOT}" ]]; then
  echo "[$(ts)] WARN boot-start: missing ${ROOT}; skip"
  exit 0
fi

# Full paths matter: boot env is minimal (no interactive profile).
export PATH="/usr/local/bin:/usr/bin:/bin:${ROOT}/node_modules/.bin:${PATH:-}"

if [[ -f "${PIDFILE}" ]]; then
  old="$(tr -dc '0-9' <"${PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${old}" ]] && kill -0 "${old}" 2>/dev/null; then
    echo "[$(ts)] INFO boot-start: supervisor already running pid=${old}; noop"
    exit 0
  fi
fi

if pgrep -f -- 'tsx src/index\.ts' >/dev/null 2>&1; then
  echo "[$(ts)] INFO boot-start: tsx src/index.ts already running; noop"
  exit 0
fi

if [[ ! -x "${ROOT}/scripts/run-live.sh" ]]; then
  echo "[$(ts)] WARN boot-start: missing ${ROOT}/scripts/run-live.sh; skip"
  exit 0
fi

if [[ ! -f "${ROOT}/scripts/ensure-deps.sh" ]]; then
  echo "[$(ts)] ERROR boot-start: missing ${ROOT}/scripts/ensure-deps.sh"
  exit 1
fi

# stderr is the boot log. Do not also append there (that would duplicate lines).
export ENSURE_DEPS_BOT_LOG="${BOT_LOG}"
unset ENSURE_DEPS_BOOT_LOG || true
# shellcheck source=ensure-deps.sh
source "${ROOT}/scripts/ensure-deps.sh"
ensure_deps "${ROOT}"

cd "${ROOT}"
# Detach fully from start-sand-box / caller. run-live.sh writes pidfile + bot.log.
setsid nohup "${ROOT}/scripts/run-live.sh" >/dev/null 2>&1 &
echo "[$(ts)] INFO boot-start: launched run-live.sh spawn_pid=$!"
