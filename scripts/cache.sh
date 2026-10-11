#!/usr/bin/env bash
set -euo pipefail

OPENWRT_DIR="${OPENWRT_DIR:-openwrt}"
CCACHE_DIR="${CCACHE_DIR:-$(realpath -m "$OPENWRT_DIR/.ccache")}"
BUILD_LOG_DIR="${BUILD_LOG_DIR:-$(realpath -m build-logs)}"
export CCACHE_DIR

cache_binary() {
  if [ -x "$OPENWRT_DIR/staging_dir/host/bin/ccache" ]; then
    printf '%s\n' "$OPENWRT_DIR/staging_dir/host/bin/ccache"
  else
    command -v ccache
  fi
}

case "${1:-}" in
  metadata)
    : "${GITHUB_OUTPUT:?}" "${CACHE_SCOPE:?}" "${UPSTREAM_BRANCH:?}" "${CACHE_PLATFORM:?}" "${CACHE_SCHEMA:?}"
    case "${CACHE_MODE:-readwrite}" in
      readwrite|fresh) ;;
      off) echo 'CCACHE_DISABLE=1' >> "${GITHUB_ENV:?}" ;;
      *) echo "Unknown cache mode: $CACHE_MODE" >&2; exit 1 ;;
    esac
    mkdir -p "$BUILD_LOG_DIR"
    source_id="$(git -C "$OPENWRT_DIR" remote get-url origin | sha256sum | cut -c1-12)"
    branch_id="$(printf '%s' "$UPSTREAM_BRANCH" | sha256sum | cut -c1-12)"
    config_hash="$(sha256sum "$OPENWRT_DIR/.config" | cut -d' ' -f1)"
    prefix="immortalwrt-ccache-$CACHE_SCHEMA-$CACHE_PLATFORM-${RUNNER_ARCH:-$(uname -m)}-$source_id-$branch_id-$CACHE_SCOPE-"
    printf 'prefix=%s\nconfig_hash=%s\n' "$prefix" "$config_hash" >> "$GITHUB_OUTPUT"
    cp "$OPENWRT_DIR/.config" "$BUILD_LOG_DIR/openwrt.config"
    {
      printf 'Source: '; git -C "$OPENWRT_DIR" remote get-url origin
      printf 'Commit: '; git -C "$OPENWRT_DIR" rev-parse HEAD
      printf 'Upstream branch: %s\nCache mode: %s\nCache prefix: %s\nConfig hash: %s\n' "$UPSTREAM_BRANCH" "${CACHE_MODE:-readwrite}" "$prefix" "$config_hash"
      for feed in "$OPENWRT_DIR"/feeds/*; do
        [ -d "$feed/.git" ] || [ -f "$feed/.git" ] || continue
        printf 'Feed %s: ' "$(basename "$feed")"; git -C "$feed" rev-parse HEAD
      done
      lscpu
      free -h
      df -hT "$OPENWRT_DIR"
      printf 'Available workers: '; nproc
    } | tee "$BUILD_LOG_DIR/build-metadata.txt"
    ;;
  init)
    mkdir -p "$BUILD_LOG_DIR"
    if [ "${CACHE_RESTORE_OUTCOME:-skipped}" == failure ] ||
       { [ "${CACHE_MODE:-local}" == readwrite ] && [ -z "${CACHE_MATCHED_KEY:-}" ] && [ -e "$CCACHE_DIR" ]; }; then
      # The action can report success after warning about a partial extraction.
      # Only a matched key confirms completed restoration. Reset only the
      # dedicated CI cache path owned by this workflow.
      [ "$CCACHE_DIR" == /mnt/workdir/cache/ccache ] && [ ! -L "$CCACHE_DIR" ] || { echo "Refusing to reset unexpected cache path." >&2; exit 1; }
      rm -rf -- "$CCACHE_DIR"
      echo 'Restore was not confirmed; compiling with an empty ccache.'
    fi
    mkdir -p "$CCACHE_DIR"
    cache_bin="$(cache_binary)"
    "$cache_bin" -M "${CCACHE_MAXSIZE:-1.5GiB}"
    "$cache_bin" -z
    {
      printf 'Restore outcome: %s\nExact hit: %s\nMatched key: %s\n' "${CACHE_RESTORE_OUTCOME:-skipped}" "${CACHE_EXACT_HIT:-}" "${CACHE_MATCHED_KEY:-none}"
      "$cache_bin" --version
      "$cache_bin" -p
    } | tee "$BUILD_LOG_DIR/cache-restore.txt"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf '\n**ccache restore**\n\n- Mode: `%s`\n- Outcome: `%s`\n- Matched key: `%s`\n' "${CACHE_MODE:-readwrite}" "${CACHE_RESTORE_OUTCOME:-skipped}" "${CACHE_MATCHED_KEY:-none}" >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  stats)
    mkdir -p "$BUILD_LOG_DIR"
    cache_bin="$(cache_binary)" || exit 0
    "$cache_bin" -s -v | tee "$BUILD_LOG_DIR/ccache-${2:-final}.txt"
    ;;
  prepare)
    cache_bin="$(cache_binary)"
    "$cache_bin" -M "${CCACHE_MAXSIZE:-1.5GiB}"
    "$cache_bin" -c
    "$cache_bin" -s -v | tee "$BUILD_LOG_DIR/ccache-final.txt"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        printf '\n**Final ccache statistics**\n\n```text\n'
        cat "$BUILD_LOG_DIR/ccache-final.txt"
        printf '```\n'
      } >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  prune)
    # Keep GitHub API cleanup in this file; local operations remain Bash.
    node --input-type=module <<'CACHE_PRUNE_JS'
import { appendFileSync } from "node:fs";

// Preserve only the newly published snapshot across all
// configurations in this exact source/runner/branch/device scope.
function planCleanup(caches, { ref, prefix, currentKey, legacyPrefix }) {
  if (!/^immortalwrt-ccache-v[0-9]+-/.test(prefix) || !prefix.endsWith("-") || !currentKey.startsWith(prefix)) {
    throw new Error("Unexpected cache namespace.");
  }
  const scoped = caches.filter((cache) => cache.ref === ref && cache.key.startsWith(prefix));
  const current = scoped.find((cache) => cache.key === currentKey);
  // Save actions can warn and report success without uploading anything.
  // Never delete a known-good snapshot unless the new one actually exists.
  if (!current) return null;
  return caches.filter((cache) => cache.ref === ref && (
    (cache.key.startsWith(prefix) && cache.id !== current.id) ||
    (legacyPrefix && cache.key.startsWith(legacyPrefix))
  ));
}

async function main() {
  const required = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_REF", "CACHE_PREFIX", "CACHE_CURRENT_KEY", "UPSTREAM_BRANCH", "CACHE_SCOPE"];
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}.`);
  const { GITHUB_REPOSITORY: repo, GITHUB_REF: ref, CACHE_PREFIX: prefix, CACHE_CURRENT_KEY: currentKey } = process.env;
  const base = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repo}/actions/caches`;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function request(url, method = "GET") {
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(30000) });
    // Another scope's upload can trigger eviction after our listing.
    if (method === "DELETE" && response.status === 404) return null;
    if (!response.ok) throw new Error(`Cache API ${method} failed: HTTP ${response.status}.`);
    return method === "DELETE" ? null : response.json();
  }
  const caches = [];
  for (let page = 1; ; page++) {
    if (page > 50) throw new Error("Cache listing exceeded pagination limit; cleanup skipped.");
    const url = new URL(base);
    url.search = new URLSearchParams({ ref, per_page: "100", page: String(page) }).toString();
    const result = await request(url);
    caches.push(...result.actions_caches);
    if (result.actions_caches.length < 100) break;
  }
  const deletions = planCleanup(caches, {
    ref, prefix, currentKey,
    legacyPrefix: `immortalwrt-v2-${process.env.UPSTREAM_BRANCH}-${process.env.CACHE_SCOPE}-`,
  });
  if (deletions === null) {
    console.log("New snapshot not found in cache API; preserving all existing caches.");
    return;
  }
  for (const cache of deletions) {
    await request(`${base}/${cache.id}`, "DELETE");
    console.log(`Removed cache ${cache.id}: ${cache.key}`);
  }
  const total = caches.filter((cache) => !deletions.some((deleted) => deleted.id === cache.id))
    .reduce((sum, cache) => sum + cache.size_in_bytes, 0);
  const message = `Retained only the newly published snapshot in this cache scope; removed ${deletions.length} old entries. Listed cache storage on ${ref}: ${(total / 1e9).toFixed(2)} GB.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
CACHE_PRUNE_JS
    ;;
  *) echo "Usage: $0 [metadata|init|stats [phase]|prepare|prune]" >&2; exit 1 ;;
esac
