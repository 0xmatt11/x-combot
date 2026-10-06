#!/usr/bin/env bash
# Install (or refresh) the x-combot boot hook into /usr/local/bin/start-sand-box.
#
# This box has no systemd user units and no crontab. PID 1 is tini/pod-daemon.
# start-sand-box is image-owned (box-script sync will not overlay it), so a
# small hook there is the durable way to launch after host reboot.
#
# Usage: sudo /workspace/x-combot/scripts/install-box-boot-hook.sh
# Idempotent. Does not start or restart the live bot.

set -euo pipefail

TARGET="${START_SAND_BOX:-/usr/local/bin/start-sand-box}"
MARKER_BEGIN="# >>> x-combot-boot-hook >>>"
MARKER_END="# <<< x-combot-boot-hook <<<"
BOOT_SCRIPT="/workspace/x-combot/scripts/boot-start.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root (sudo $0)" >&2
  exit 1
fi

if [[ ! -f "${TARGET}" ]]; then
  echo "missing ${TARGET}" >&2
  exit 1
fi

if [[ ! -x "${BOOT_SCRIPT}" ]]; then
  echo "missing executable ${BOOT_SCRIPT}" >&2
  exit 1
fi

HOOK_FN=$(cat <<'HOOK'
# >>> x-combot-boot-hook >>>
# Launches /workspace/x-combot/scripts/boot-start.sh after desktop (idempotent).
# Installed by scripts/install-box-boot-hook.sh. Safe if bot already running.
start_x_combot() {
	local boot="/workspace/x-combot/scripts/boot-start.sh"
	[ -x "${boot}" ] || return 0
	/usr/bin/setsid /usr/bin/nohup "${AS_BOX[@]}" "${boot}" \
		>>/tmp/x-combot-boot.log 2>&1 &
}
# <<< x-combot-boot-hook <<<
HOOK
)

# Backup once per install run
bak="${TARGET}.bak-pre-xcombot-$(date +%Y%m%d%H%M%S)"
cp -a "${TARGET}" "${bak}"
echo "backup: ${bak}"

# Strip previous hook function block if present
tmp="$(mktemp)"
if grep -qF "${MARKER_BEGIN}" "${TARGET}"; then
  awk -v b="${MARKER_BEGIN}" -v e="${MARKER_END}" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    !skip {print}
  ' "${TARGET}" >"${tmp}"
else
  cp "${TARGET}" "${tmp}"
fi

# Insert function definition before start_desktop() if possible, else before call site
if grep -qF 'start_desktop() {' "${tmp}"; then
  # Place function just before start_desktop definition
  awk -v hook="${HOOK_FN}" '
    /start_desktop\(\) \{/ && !done {
      print hook
      print ""
      done=1
    }
    {print}
  ' "${tmp}" >"${tmp}.2"
  mv "${tmp}.2" "${tmp}"
else
  echo "warn: start_desktop() not found; appending hook function at EOF"
  printf '\n%s\n' "${HOOK_FN}" >>"${tmp}"
fi

# Ensure start_x_combot is invoked once after start_desktop in the boot sequence
if grep -qE '^start_x_combot$' "${tmp}"; then
  echo "call site already present"
else
  if grep -qE '^start_desktop$' "${tmp}"; then
    # Insert immediately after the start_desktop call line
    awk '
      /^start_desktop$/ && !done {
        print
        print "start_x_combot"
        done=1
        next
      }
      {print}
    ' "${tmp}" >"${tmp}.2"
    mv "${tmp}.2" "${tmp}"
  else
    echo "error: could not find start_desktop call site to attach start_x_combot" >&2
    rm -f "${tmp}"
    exit 1
  fi
fi

# Syntax check before replacing
if ! bash -n "${tmp}"; then
  echo "error: patched script failed bash -n; leaving ${TARGET} unchanged" >&2
  rm -f "${tmp}"
  exit 1
fi

chmod --reference="${TARGET}" "${tmp}" 2>/dev/null || chmod 755 "${tmp}"
mv "${tmp}" "${TARGET}"
echo "installed hook into ${TARGET}"
echo "verify:"
grep -n 'x-combot-boot-hook\|start_x_combot' "${TARGET}" | head -20
