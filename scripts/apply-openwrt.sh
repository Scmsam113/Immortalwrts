#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENWRT_DIR="${OPENWRT_DIR:-openwrt}"

if [ ! -d "$OPENWRT_DIR" ] && [ -d "$ROOT_DIR/$OPENWRT_DIR" ]; then
  OPENWRT_DIR="$ROOT_DIR/$OPENWRT_DIR"
fi

apply_system() {
  local config_generate="$OPENWRT_DIR/package/base-files/files/bin/config_generate"
  [ -f "$config_generate" ] || { echo "config_generate not found: $config_generate" >&2; exit 1; }
  sed -i 's/192.168.1.1/192.168.10.1/g' "$config_generate"
}

apply_feeds() {
  local feeds="$ROOT_DIR/feeds/feeds.conf.default"
  local target="$OPENWRT_DIR/feeds.conf.default"
  [ -f "$feeds" ] && [ -f "$target" ] || { echo "ImmortalWrt feed configuration is missing." >&2; exit 1; }
  local backup="$OPENWRT_DIR/base_feeds.conf.default"
  if [ ! -f "$backup" ]; then
    cp "$target" "$backup"
  fi
  cp "$feeds" "$target"
  printf '\n' >> "$target"
  cat "$backup" >> "$target"
  echo "Upstream feeds backed up to: $backup"
}

apply_packages() {
  (cd "$OPENWRT_DIR" && bash "$ROOT_DIR/packages/immortalwrt.sh")
}

for mode in "$@"; do
  case "$mode" in
    system) apply_system ;;
    feeds) apply_feeds ;;
    packages) apply_packages ;;
    all) apply_system; apply_feeds; apply_packages ;;
    *) echo "Usage: $0 [system|feeds|packages|all]..." >&2; exit 2 ;;
  esac
done
