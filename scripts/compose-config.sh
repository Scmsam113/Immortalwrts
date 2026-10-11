#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENWRT_DIR="${OPENWRT_DIR:-openwrt}"
TARGET_CONFIG="${TARGET_CONFIG:-}"
APP_CONFIG="${APP_CONFIG:-}"

resolve_config() {
  local path="$1"
  [ -n "$path" ] || { echo "A configuration path is required." >&2; exit 1; }
  if [ -f "$path" ]; then printf '%s\n' "$path"; return; fi
  if [ -f "$ROOT_DIR/$path" ]; then printf '%s\n' "$ROOT_DIR/$path"; return; fi
  echo "Configuration file not found: $path" >&2
  exit 1
}

if [ ! -d "$OPENWRT_DIR" ] && [ -d "$ROOT_DIR/$OPENWRT_DIR" ]; then
  OPENWRT_DIR="$ROOT_DIR/$OPENWRT_DIR"
fi

TARGET_CONFIG_PATH="$(resolve_config "$TARGET_CONFIG")"
APP_CONFIG_PATH="$(resolve_config "$APP_CONFIG")"

if [ -d "$ROOT_DIR/files" ]; then
  mkdir -p "$OPENWRT_DIR/files"
  cp -R "$ROOT_DIR/files/." "$OPENWRT_DIR/files/"
  chmod +x "$OPENWRT_DIR/files/etc/uci-defaults/99-zz-package-mirror"
fi

cat "$TARGET_CONFIG_PATH" "$APP_CONFIG_PATH" > "$OPENWRT_DIR/.config"
cd "$OPENWRT_DIR"
# OpenWrt only accepts the CCACHE options when DEVEL is enabled.
# The CI cache directory and OpenWrt's compiler wrapper must agree.
CCACHE_DIR="${CCACHE_DIR:-$PWD/.ccache}"
sed -i -E '/^(CONFIG_DEVEL=|# CONFIG_DEVEL is not set|CONFIG_CCACHE(=|_DIR=)|# CONFIG_CCACHE(_DIR)? is not set)/d' .config
printf '\nCONFIG_DEVEL=y\nCONFIG_CCACHE=y\nCONFIG_CCACHE_DIR="%s"\n' "$CCACHE_DIR" >> .config
make defconfig

# Do not let upstream's LuCI default selections re-enable apps explicitly disabled here.
awk '
  /^CONFIG_DEFAULT_luci[^=]*=/ { sub(/=.*/, "", $0); print "# " $0 " is not set"; next }
  { print }
' .config > .config.tmp
mv .config.tmp .config
make defconfig
grep -qx 'CONFIG_DEVEL=y' .config || { echo "ccache requires CONFIG_DEVEL=y." >&2; exit 1; }
grep -qx 'CONFIG_CCACHE=y' .config || { echo "ccache was disabled by defconfig." >&2; exit 1; }
grep -Fxq "CONFIG_CCACHE_DIR=\"$CCACHE_DIR\"" .config || { echo "Unexpected ccache directory." >&2; exit 1; }
cat .config
