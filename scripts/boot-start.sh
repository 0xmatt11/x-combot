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

echo "[$(ts)] INFO boot-start begin root=${ROOT}"

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

if [[ ! -x "${ROOT}/node_modules/.bin/tsx" ]]; then
  msg="missing ${ROOT}/node_modules/.bin/tsx — run: cd ${ROOT} && npm install"
  echo "[$(ts)] WARN boot-start: ${msg}"
  echo "[$(ts)] WARN boot-start: ${msg}" >>"${BOT_LOG}"
  exit 0
fi

cd "${ROOT}"
# Detach fully from start-sand-box / caller. run-live.sh writes pidfile + bot.log.
setsid nohup "${ROOT}/scripts/run-live.sh" >/dev/null 2>&1 &
echo "[$(ts)] INFO boot-start: launched run-live.sh spawn_pid=$!"
