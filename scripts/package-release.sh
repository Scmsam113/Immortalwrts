#!/usr/bin/env bash
set -euo pipefail
cd "${OPENWRT_DIR:-openwrt}"
OPENWRT_DIR="$PWD"
export OPENWRT_DIR
DEVICE="${DEVICE:?Device id is required}"
[[ "$DEVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "Invalid device id." >&2; exit 1; }
board="$(sed -n 's/^CONFIG_TARGET_BOARD="\([a-zA-Z0-9_-]*\)"$/\1/p' .config)"
subtarget="$(sed -n 's/^CONFIG_TARGET_SUBTARGET="\([a-zA-Z0-9_-]*\)"$/\1/p' .config)"
[ -n "$board" ] && [ -n "$subtarget" ] || { echo "Cannot resolve target board/subtarget from final .config." >&2; exit 1; }
firmware="bin/targets/$board/$subtarget"
[ -d "$firmware" ] || { echo "Firmware directory not found: $firmware" >&2; exit 1; }
stamp="$(date +%Y%m%d%H%M%S)"
release_dir="${RELEASE_DIR:-$OPENWRT_DIR/bin/releases/$DEVICE-$stamp}"
mkdir -p "$(dirname "$release_dir")"
# A fresh staging directory avoids publishing leftovers from earlier builds.
mkdir "$release_dir"
release_dir="$(cd "$release_dir" && pwd)"
[ -d bin/packages ] || { echo "Package directory not found: bin/packages" >&2; exit 1; }
package_dirs=(bin/packages)
if [ -d "$firmware/packages" ]; then package_dirs+=("$firmware/packages"); fi

# Copy the whole firmware directory except packages, which are archived below.
# pipefail propagates failures from either side of this directory transfer.
tar -C "$firmware" --exclude='./packages' -cf - . | tar -C "$release_dir" -xf -
archive="luci-apps-$DEVICE-$stamp.tar.gz"
# Archive complete package directories directly, without a per-file staging copy.
# Dereference generated package symlinks to keep the archive self-contained.
tar --dereference --transform='s|^\.config$|build.config|' -czf "$release_dir/$archive" -- "${package_dirs[@]}" .config
(
  cd "$release_dir"
  sha256sum "$archive" > "$archive.sha256"
)
if [ -n "${GITHUB_ENV:-}" ]; then printf 'FIRMWARE=%s\n' "$release_dir" >> "$GITHUB_ENV"; fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'file_date=%s\n' "$stamp" >> "$GITHUB_OUTPUT"; fi
echo "Release files: $release_dir (complete package directories archived in $archive)"
