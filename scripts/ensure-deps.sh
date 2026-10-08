#!/usr/bin/env bash
# Install node_modules before the live bot starts.
#
# Called by scripts/run-live.sh and scripts/boot-start.sh (source this file,
# then call ensure_deps <repo-root>). Also runnable directly:
#   scripts/ensure-deps.sh /path/to/repo
#
# Runs npm ci when node_modules/.bin/tsx is missing, or when
# node_modules/.package-lock.json is older than package-lock.json or its
# installed packages differ from that lockfile. npm's hidden lockfile omits
# the root packages[""] entry, so the compare ignores that key.
#
# npm ci is tried once. On failure, npm install is tried once. If that fails
# the process exits non-zero. There is no retry loop.
#
# A flock on /tmp/x-combot-npm-ci.lock keeps two launchers from installing
# together. This script does not read or print the env file or process secrets.

ensure_deps_log() {
  local level="$1"
  shift
  local line
  line="[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] ${level} ensure-deps: $*"
  printf '%s\n' "$line" >&2
  local f seen=" "
  for f in "${ENSURE_DEPS_BOT_LOG:-}" "${ENSURE_DEPS_BOOT_LOG:-}"; do
    [[ -n "$f" ]] || continue
    case "$seen" in
      *" $f "*) continue ;;
    esac
    seen="${seen}${f} "
    mkdir -p -- "$(dirname "$f")"
    printf '%s\n' "$line" >>"$f"
  done
}

ensure_deps_append_output() {
  local src="$1"
  [[ -s "$src" ]] || return 0
  cat "$src" >&2
  local f seen=" "
  for f in "${ENSURE_DEPS_BOT_LOG:-}" "${ENSURE_DEPS_BOOT_LOG:-}"; do
    [[ -n "$f" ]] || continue
    case "$seen" in
      *" $f "*) continue ;;
    esac
    seen="${seen}${f} "
    mkdir -p -- "$(dirname "$f")"
    cat "$src" >>"$f"
  done
}

# Echo the npm binary path, or return 1. Caller PATH wins so a test can stub npm.
ensure_deps_resolve_npm() {
  local c=""
  if c="$(command -v npm 2>/dev/null)" && [[ -n "$c" && -x "$c" ]]; then
    printf '%s\n' "$c"
    return 0
  fi
  local fixed node_bin sibling
  for fixed in /usr/local/bin/npm /usr/bin/npm; do
    if [[ -x "$fixed" ]]; then
      printf '%s\n' "$fixed"
      return 0
    fi
  done
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "$node_bin" ]]; then
    sibling="$(dirname "$node_bin")/npm"
    if [[ -x "$sibling" ]]; then
      printf '%s\n' "$sibling"
      return 0
    fi
  fi
  local base="${NVM_DIR:-${HOME:-}/.nvm}/versions/node"
  local d newest=""
  local -a found=()
  if [[ -d "$base" ]]; then
    for d in "$base"/*/bin/npm; do
      [[ -x "$d" ]] || continue
      found+=("$d")
    done
  fi
  if [[ ${#found[@]} -gt 0 ]]; then
    newest="$(printf '%s\n' "${found[@]}" | sort -V | tail -n 1)"
    if [[ -n "$newest" && -x "$newest" ]]; then
      printf '%s\n' "$newest"
      return 0
    fi
  fi
  return 1
}

# Return 0 when the installed package set matches package-lock.json.
# npm writes node_modules/.package-lock.json without packages[""].
ensure_deps_locks_match() {
  local src="$1"
  local installed="$2"
  if cmp -s "$src" "$installed"; then
    return 0
  fi
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_bin" ]]; then
    ensure_deps_log WARN "node not found; skipping lockfile content compare"
    return 0
  fi
  "$node_bin" - "$src" "$installed" <<'NODE'
const fs = require("fs");
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
function packagesOf(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const packages = { ...(data.packages || {}) };
  delete packages[""];
  return JSON.stringify(sortValue(packages));
}
try {
  const same = packagesOf(process.argv[2]) === packagesOf(process.argv[3]);
  process.exit(same ? 0 : 1);
} catch {
  process.stderr.write("ensure-deps: could not parse lockfile\n");
  process.exit(1);
}
NODE
}

# Print a one-line reason to install, or nothing when node_modules is usable.
ensure_deps_install_reason() {
  local root="$1"
  local tsx="${root}/node_modules/.bin/tsx"
  local src="${root}/package-lock.json"
  local installed="${root}/node_modules/.package-lock.json"

  if [[ ! -x "$tsx" ]]; then
    printf 'missing %s\n' "$tsx"
    return 0
  fi
  if [[ ! -f "$src" ]]; then
    return 0
  fi
  if [[ ! -f "$installed" ]]; then
    printf 'missing %s\n' "$installed"
    return 0
  fi
  if [[ "$src" -nt "$installed" ]]; then
    printf '%s older than %s\n' "$installed" "$src"
    return 0
  fi
  if ! ensure_deps_locks_match "$src" "$installed"; then
    printf '%s inconsistent with %s\n' "$installed" "$src"
    return 0
  fi
}

# Caller must be in set +e so a non-zero npm status is returned, not fatal.
# Do not toggle set -e here: it leaks out of the function and skips the fallback.
ensure_deps_run_npm() {
  local root="$1"
  local npm_bin="$2"
  local outfile="$3"
  shift 3
  local code=0
  (
    cd "$root" || exit 1
    "$npm_bin" "$@" >"$outfile" 2>&1
  )
  code=$?
  ensure_deps_append_output "$outfile" || true
  return "$code"
}

# Runs inside the flock subshell. exit (do not return) so the lock drops.
ensure_deps_install() {
  local root="$1"
  local npm_bin="$2"
  local reason=""
  reason="$(ensure_deps_install_reason "$root")"
  if [[ -z "$reason" ]]; then
    ensure_deps_log INFO "node_modules ok"
    exit 0
  fi
  if [[ -z "$npm_bin" || ! -x "$npm_bin" ]]; then
    ensure_deps_log ERROR "npm not found; not starting (${reason})"
    exit 1
  fi

  local outfile code=0
  outfile="$(mktemp /tmp/x-combot-npm-out.XXXXXX)"
  ensure_deps_log INFO "node_modules need install (${reason}); running npm ci --no-audit --no-fund"
  set +e
  ensure_deps_run_npm "$root" "$npm_bin" "$outfile" ci --no-audit --no-fund
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    ensure_deps_log WARN "npm ci failed exit=${code}; falling back to npm install --no-audit --no-fund"
    : >"$outfile"
    set +e
    ensure_deps_run_npm "$root" "$npm_bin" "$outfile" install --no-audit --no-fund
    code=$?
    set -e
    if [[ "$code" -ne 0 ]]; then
      rm -f "$outfile"
      ensure_deps_log ERROR "npm install failed exit=${code}"
      if [[ "$code" -ge 1 && "$code" -le 255 ]]; then
        exit "$code"
      fi
      exit 1
    fi
    ensure_deps_log INFO "npm install succeeded exit=0"
  else
    ensure_deps_log INFO "npm ci succeeded exit=${code}"
  fi
  rm -f "$outfile"
  if [[ ! -x "${root}/node_modules/.bin/tsx" ]]; then
    ensure_deps_log ERROR "install finished but ${root}/node_modules/.bin/tsx is still missing"
    exit 1
  fi
  exit 0
}

ensure_deps() {
  local root="${1:-}"
  if [[ -z "$root" || ! -d "$root" ]]; then
    printf 'ensure-deps: repo root missing\n' >&2
    return 2
  fi
  root="$(cd "$root" && pwd)"

  if [[ -z "${ENSURE_DEPS_BOT_LOG:-}" ]]; then
    ENSURE_DEPS_BOT_LOG="${root}/logs/bot.log"
  fi
  export ENSURE_DEPS_BOT_LOG

  if [[ -z "${PATH:-}" ]]; then
    PATH="/usr/local/bin:/usr/bin:/bin"
  else
    PATH="${PATH}:/usr/local/bin:/usr/bin:/bin"
  fi
  case ":${PATH}:" in
    *":${root}/node_modules/.bin:"*) ;;
    *) PATH="${root}/node_modules/.bin:${PATH}" ;;
  esac
  export PATH

  if ! command -v flock >/dev/null 2>&1; then
    ensure_deps_log ERROR "flock not found; cannot guard npm install"
    return 1
  fi

  local npm_bin=""
  if npm_bin="$(ensure_deps_resolve_npm)"; then
    PATH="$(dirname "$npm_bin"):${PATH}"
    export PATH
  else
    npm_bin=""
  fi
  hash -r || true

  local lock="${X_COMBOT_NPM_LOCK:-/tmp/x-combot-npm-ci.lock}"
  local wait_sec="${X_COMBOT_NPM_LOCK_WAIT:-600}"
  if [[ ! "$wait_sec" =~ ^[0-9]+$ ]]; then
    wait_sec=600
  fi
  mkdir -p -- "$(dirname "$lock")"

  local errexit=0 status=0
  case $- in
    *e*) errexit=1 ;;
  esac
  set +e
  (
    set -euo pipefail
    exec 9>"$lock"
    if ! flock -w "$wait_sec" 9; then
      ensure_deps_log ERROR "could not acquire npm lock ${lock} within ${wait_sec}s"
      exit 1
    fi
    ensure_deps_install "$root" "$npm_bin"
  )
  status=$?
  if [[ "$errexit" -eq 1 ]]; then
    set -e
  fi
  return "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  ensure_deps "${1:-}"
fi
