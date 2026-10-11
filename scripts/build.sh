#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENWRT_DIR="${OPENWRT_DIR:-openwrt}"
PHASE="${1:-all}"
JOBS="${JOBS:-$(nproc)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "JOBS must be a positive integer." >&2; exit 1; }
FALLBACK_JOBS="${FALLBACK_JOBS:-$((JOBS > 1 ? JOBS / 2 : 1))}"
[[ "$FALLBACK_JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "FALLBACK_JOBS must be a positive integer." >&2; exit 1; }
BUILD_LOG_DIR="${BUILD_LOG_DIR:-$ROOT_DIR/build-logs}"
mkdir -p "$BUILD_LOG_DIR"
BUILD_LOG_DIR="$(cd "$BUILD_LOG_DIR" && pwd)"
cd "$OPENWRT_DIR"
OPENWRT_DIR="$PWD"
export OPENWRT_DIR BUILD_LOG_DIR
START_SECONDS=$SECONDS
RETRIES=0

finish() {
  local status=$? elapsed=$((SECONDS - START_SECONDS))
  trap - EXIT
  printf '%s\t%s\t%s\t%s\t%s\n' "$PHASE" "$elapsed" "$status" "$JOBS" "$RETRIES" >> "$BUILD_LOG_DIR/phases.tsv" || true
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '\n**Build phase: %s** — %ss, exit %s, jobs %s, retries %s\n' "$PHASE" "$elapsed" "$status" "$JOBS" "$RETRIES" >> "$GITHUB_STEP_SUMMARY" || true
  fi
  bash "$ROOT_DIR/scripts/cache.sh" stats "$PHASE" || true
  exit "$status"
}
trap finish EXIT

run_logged() {
  local workers="$1" attempt="$2" label="${3:-world}"
  shift 2
  local log="$BUILD_LOG_DIR/$PHASE-${label//\//-}-$attempt.log"
  local -a codes
  echo "$workers thread compile: $label (attempt $attempt)"
  if make -j"$workers" "$@" V=s 2>&1 | tee "$log"; then
    return 0
  else
    codes=("${PIPESTATUS[@]}")
  fi
  # A failed logger must never turn a failed pipeline into a successful build.
  if [ "${codes[1]}" -ne 0 ]; then return "${codes[1]}"; fi
  return "${codes[0]}"
}

download_sources() {
  local status
  if run_logged "$JOBS" 1 download; then return; else status=$?; fi
  echo "Download failed (exit $status); retrying once without deleting source files."
  RETRIES=$((RETRIES + 1))
  run_logged "$JOBS" 2 download
}

run_make() {
  local status label="${1:-world}"
  if run_logged "$JOBS" 1 "$@"; then return; else status=$?; fi
  # Retry only explicit memory exhaustion, with fewer workers. Source and patch
  # errors need diagnosis, not another full pass over the same build target.
  if [ "$FALLBACK_JOBS" -lt "$JOBS" ] &&
     grep -Eiq 'out of memory|cannot allocate memory|fatal error: Killed|Killed signal terminated program' "$BUILD_LOG_DIR/$PHASE-${label//\//-}-1.log"; then
    RETRIES=$((RETRIES + 1))
    echo "Memory exhaustion detected; retrying with $FALLBACK_JOBS workers."
    run_logged "$FALLBACK_JOBS" 2 "$@"
  else
    echo "Build failed (exit $status); see $BUILD_LOG_DIR/$PHASE-${label//\//-}-1.log" >&2
    return "$status"
  fi
}

case "$PHASE" in
  download)
    download_sources
    ;;
  tools)
    run_make tools/install
    ;;
  toolchain)
    run_make toolchain/install
    ;;
  target)
    run_make target/compile
    ;;
  packages)
    run_make package/compile
    ;;
  images)
    run_make package/install
    run_make target/install
    run_make package/index
    ;;
  all)
    download_sources
    run_make
    ;;
  *)
    echo "Unknown build phase: $PHASE" >&2
    echo "Usage: $0 [download|tools|toolchain|target|packages|images|all]" >&2
    exit 1
    ;;
esac
