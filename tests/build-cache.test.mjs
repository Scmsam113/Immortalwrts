import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bash = process.env.TEST_BASH || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");

function fixture(t, mode = "success", extra = {}) {
  const temp = mkdtempSync(join(tmpdir(), "immortalwrt-cache-test-"));
  t.after(() => {
    const target = realpathSync(temp);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith("immortalwrt-cache-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const source = join(temp, "openwrt");
  const bin = join(temp, "bin");
  const logs = join(temp, "logs");
  mkdirSync(join(source, "dl", "go-mod-cache"), { recursive: true });
  mkdirSync(bin);
  const calls = join(temp, "make-calls.txt");
  writeFileSync(calls, "");
  function executable(name, body) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  }
  executable("make", `printf '%s\\n' "$*" >> "$TEST_CALLS"
count=$(wc -l < "$TEST_CALLS")
# Model the upstream CCACHE prompt visibility dependency on DEVEL.
if [[ "$1" == defconfig ]] && ! grep -qx 'CONFIG_DEVEL=y' .config; then
  sed -i -e 's/^CONFIG_CCACHE=y/# CONFIG_CCACHE is not set/' -e '/^CONFIG_CCACHE_DIR=/d' .config
fi
case "$FAKE_MAKE_MODE" in
  source-error) echo 'source syntax error'; exit 7 ;;
  source-oom-text) printf '%s\\n' '  130 | printf("%s: out of memory\\n", progname);' 'upx: No such file or directory'; exit 2 ;;
  oom) if [[ "$1" == -j4 ]]; then echo 'cc1plus: fatal error: Killed signal terminated program cc1plus'; exit 2; fi ;;
  oom-always) echo 'cannot allocate memory'; exit 2 ;;
  download-flaky) if [[ "$count" == 1 ]]; then echo 'network timeout'; exit 3; fi ;;
  disable-cache) sed -i 's/^CONFIG_CCACHE=y/# CONFIG_CCACHE is not set/' .config ;;
esac
echo 'make completed'`);
  executable("ccache", "printf 'Hits: 10\\nMisses: 2\\n'");
  // Git Bash prepends its own tools to PATH on Windows. Prepend the fixture
  // again after shell startup so fault injection also replaces real tee.
  const shellPath = (path) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const startup = join(temp, "startup.sh");
  writeFileSync(startup, 'export PATH="$TEST_BIN:$PATH"\n');
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    OPENWRT_DIR: source.replaceAll("\\", "/"),
    CCACHE_DIR: join(temp, "ccache").replaceAll("\\", "/"),
    BUILD_LOG_DIR: logs.replaceAll("\\", "/"),
    GITHUB_STEP_SUMMARY: join(temp, "summary.md").replaceAll("\\", "/"),
    JOBS: "4", FALLBACK_JOBS: "2", FAKE_MAKE_MODE: mode,
    TEST_CALLS: calls.replaceAll("\\", "/"),
    BASH_ENV: shellPath(startup), TEST_BIN: shellPath(bin),
    ...extra,
  };
  return {
    temp, source, logs, env, executable,
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    run: (script, ...args) => spawnSync(bash, [join(root, "scripts", script).replaceAll("\\", "/"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 }),
    runAsync: (script, ...args) => new Promise((resolveResult, reject) => {
      const child = spawn(bash, [join(root, "scripts", script).replaceAll("\\", "/"), ...args], { cwd: root, env, timeout: 20000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolveResult({ status, stdout, stderr }));
    }),
  };
}

test("download preserves valid small source and module files", (t) => {
  const f = fixture(t);
  const files = [join(f.source, "dl", "small.tar.gz"), join(f.source, "dl", "go-mod-cache", "go.mod")];
  files.forEach((path) => writeFileSync(path, "valid small file\n"));
  const result = f.run("build.sh", "download");
  assert.equal(result.status, 0, result.stderr);
  files.forEach((path) => assert.ok(existsSync(path)));
  assert.equal(f.calls().length, 1);
});

test("source errors retain make exit status and are not retried", (t) => {
  const f = fixture(t, "source-error");
  const result = f.run("build.sh", "packages");
  assert.equal(result.status, 7, result.stderr);
  assert.equal(f.calls().length, 1);
  assert.match(readFileSync(join(f.logs, "packages-package-compile-1.log"), "utf8"), /source syntax error/);
  assert.match(readFileSync(join(f.logs, "phases.tsv"), "utf8"), /^packages\t\d+\t7\t4\t0/);
});

test("explicit OOM retries once with fewer workers", (t) => {
  const f = fixture(t, "oom");
  const result = f.run("build.sh", "packages");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ["-j4 package/compile V=s", "-j2 package/compile V=s"]);
  assert.match(readFileSync(join(f.logs, "phases.tsv"), "utf8"), /^packages\t\d+\t0\t4\t1/);
});

test("quoted source text about memory does not retry a missing-tool failure", (t) => {
  const f = fixture(t, "source-oom-text");
  assert.equal(f.run("build.sh", "packages").status, 2);
  assert.deepEqual(f.calls(), ["-j4 package/compile V=s"]);
});

test("persistent OOM stops after one retry", (t) => {
  const f = fixture(t, "oom-always");
  const result = f.run("build.sh", "target");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(f.calls().length, 2);
});

test("fallback cannot increase or repeat the original parallelism", (t) => {
  const f = fixture(t, "oom-always", { FALLBACK_JOBS: "4" });
  assert.equal(f.run("build.sh", "tools").status, 2);
  assert.equal(f.calls().length, 1);
});

test("download failure retries once", (t) => {
  const f = fixture(t, "download-flaky");
  assert.equal(f.run("build.sh", "download").status, 0);
  assert.equal(f.calls().length, 2);
});

test("a logger failure cannot produce a successful build", (t) => {
  const f = fixture(t);
  f.executable("tee", "cat > /dev/null; exit 23");
  assert.equal(f.run("build.sh", "packages").status, 23);
});

test("composition replaces conflicting cache options and verifies the final config", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "target.config");
  const app = join(f.temp, "app.config");
  writeFileSync(target, '# CONFIG_CCACHE is not set\nCONFIG_CCACHE_DIR="/old"\n');
  writeFileSync(app, 'CONFIG_CCACHE=n\nCONFIG_DEFAULT_luci=y\n');
  f.env.TARGET_CONFIG = target.replaceAll("\\", "/");
  f.env.APP_CONFIG = app.replaceAll("\\", "/");
  const result = f.run("compose-config.sh");
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(f.source, ".config"), "utf8");
  assert.equal(config.match(/^CONFIG_DEVEL=y$/gm)?.length, 1);
  assert.equal(config.match(/^CONFIG_CCACHE=y$/gm)?.length, 1);
  assert.ok(config.includes(`CONFIG_CCACHE_DIR="${f.env.CCACHE_DIR}"`));
  assert.match(config, /^# CONFIG_DEFAULT_luci is not set$/m);
  f.env.FAKE_MAKE_MODE = "disable-cache";
  assert.equal(f.run("compose-config.sh").status, 1);
});

test("composition enables the ccache development dependency despite conflicting input", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "target.config");
  const app = join(f.temp, "app.config");
  f.env.TARGET_CONFIG = target.replaceAll("\\", "/");
  f.env.APP_CONFIG = app.replaceAll("\\", "/");
  for (const devel of ["", "CONFIG_DEVEL=n\n", "# CONFIG_DEVEL is not set\n"]) {
    writeFileSync(target, devel);
    writeFileSync(app, "CONFIG_DEVEL=n\nCONFIG_CCACHE=y\n");
    const result = f.run("compose-config.sh");
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(join(f.source, ".config"), "utf8");
    assert.equal(config.match(/^CONFIG_DEVEL=y$/gm)?.length, 1);
    assert.equal(config.match(/^CONFIG_CCACHE=y$/gm)?.length, 1);
    assert.doesNotMatch(config, /^(CONFIG_DEVEL=n|# CONFIG_DEVEL is not set)$/m);
    assert.ok(config.includes(`CONFIG_CCACHE_DIR="${f.env.CCACHE_DIR}"`));
  }
});

test("composition copies the first-boot mirror script", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "target.config");
  writeFileSync(target, "CONFIG_TARGET_x86_64=y\n");
  f.env.TARGET_CONFIG = target.replaceAll("\\", "/");
  f.env.APP_CONFIG = "configs/apps/default.config";
  const result = f.run("compose-config.sh");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.source, "files/etc/uci-defaults/99-zz-package-mirror")));
});

test("restore failure refuses to delete an unexpected directory", (t) => {
  const f = fixture(t, "success", { CACHE_RESTORE_OUTCOME: "failure" });
  mkdirSync(f.env.CCACHE_DIR);
  const sentinel = join(f.env.CCACHE_DIR, "keep");
  writeFileSync(sentinel, "keep");
  assert.equal(f.run("cache.sh", "init").status, 1);
  assert.ok(existsSync(sentinel));
});

test("a warning-only restore without a matched key is treated as unconfirmed", (t) => {
  const f = fixture(t, "success", { CACHE_RESTORE_OUTCOME: "success", CACHE_MODE: "readwrite", CACHE_MATCHED_KEY: "" });
  mkdirSync(f.env.CCACHE_DIR);
  writeFileSync(join(f.env.CCACHE_DIR, "partial"), "partial archive");
  const result = f.run("cache.sh", "init");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to reset unexpected cache path/);
});

test("metadata namespaces source and branch and off mode disables ccache", (t) => {
  const f = fixture(t);
  f.executable("git", `case "$*" in
    *"remote get-url origin") echo 'https://github.com/example/source.git' ;;
    *"rev-parse HEAD") echo '0123456789abcdef' ;;
    *) exit 1 ;;
  esac`);
  f.executable("lscpu", "echo 'CPU fixture'");
  f.executable("free", "echo 'Memory fixture'");
  writeFileSync(join(f.source, ".config"), "CONFIG_CCACHE=y\n");
  const output = join(f.temp, "outputs.txt");
  const githubEnv = join(f.temp, "env.txt");
  Object.assign(f.env, {
    GITHUB_OUTPUT: output.replaceAll("\\", "/"), GITHUB_ENV: githubEnv.replaceAll("\\", "/"),
    CACHE_SCOPE: "x86_64", UPSTREAM_BRANCH: "feature/cache", CACHE_PLATFORM: "ubuntu2204", CACHE_SCHEMA: "v3", CACHE_MODE: "off", RUNNER_ARCH: "X64",
  });
  const result = f.run("cache.sh", "metadata");
  assert.equal(result.status, 0, result.stderr);
  const metadata = readFileSync(output, "utf8");
  assert.match(metadata, /prefix=immortalwrt-ccache-v3-ubuntu2204-X64-[a-f0-9]{12}-[a-f0-9]{12}-x86_64-/);
  assert.match(metadata, /config_hash=[a-f0-9]{64}/);
  assert.equal(readFileSync(githubEnv, "utf8"), "CCACHE_DISABLE=1\n");
  assert.ok(existsSync(join(f.logs, "openwrt.config")));
  f.env.CACHE_MODE = "invalid";
  assert.equal(f.run("cache.sh", "metadata").status, 1);
});

test("a confirmed prefix restore is retained and initializes per-run statistics", (t) => {
  const f = fixture(t, "success", { CACHE_RESTORE_OUTCOME: "success", CACHE_MODE: "readwrite", CACHE_MATCHED_KEY: "previous-config-snapshot", CACHE_EXACT_HIT: "false" });
  mkdirSync(f.env.CCACHE_DIR);
  const sentinel = join(f.env.CCACHE_DIR, "valid");
  writeFileSync(sentinel, "valid cached result");
  const result = f.run("cache.sh", "init");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(sentinel));
  assert.match(readFileSync(join(f.logs, "cache-restore.txt"), "utf8"), /Matched key: previous-config-snapshot/);
});

const prefix = "immortalwrt-ccache-v3-ubuntu2204-X64-source-branch-x86_64-";
const options = { ref: "refs/heads/main", prefix, currentKey: `${prefix}config-3-1`, legacyPrefix: "immortalwrt-v2-master-x86_64-" };
const entry = (id, key, ref = options.ref) => ({ id, key, ref, created_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`, size_in_bytes: 10 });

async function pruneFixture(t, caches, { prefixOverride = prefix, listingStatus = 200, deleteStatus = 204 } = {}) {
  const f = fixture(t);
  const requests = [], deleted = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, url, authorization: request.headers.authorization });
    if (request.method === "DELETE") {
      deleted.push(Number(url.pathname.split("/").at(-1)));
      response.writeHead(deleteStatus).end();
    } else {
      const page = Number(url.searchParams.get("page"));
      response.writeHead(listingStatus, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ actions_caches: caches.slice((page - 1) * 100, page * 100) }));
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((done) => server.close(done)));
  Object.assign(f.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/firmware", GITHUB_REF: options.ref,
    CACHE_PREFIX: prefixOverride, CACHE_CURRENT_KEY: options.currentKey,
    UPSTREAM_BRANCH: "master", CACHE_SCOPE: "x86_64",
  });
  const result = await f.runAsync("cache.sh", "prune");
  return { ...result, requests, deleted, f };
}

test("cleanup is disabled when the save only warned or the API has not confirmed it", async (t) => {
  const result = await pruneFixture(t, [entry(1, `${prefix}config-1-1`)]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.deleted, []);
  assert.match(result.stdout, /preserving all existing caches/);
});

test("cleanup rejects an unrelated namespace", async (t) => {
  const result = await pruneFixture(t, [], { prefixOverride: "unrelated-" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected cache namespace/);
  assert.deepEqual(result.deleted, []);
});

test("cleanup preserves only the current snapshot and isolates refs and devices", async (t) => {
  const caches = [
    entry(1, `${prefix}config-1-1`), entry(2, `${prefix}other-config-2-1`), entry(3, options.currentKey),
    entry(4, `${prefix}config-4-1`, "refs/heads/feature"),
    entry(5, "immortalwrt-v2-master-x86_64-old"),
    entry(6, "immortalwrt-v2-master-nn6000-v2-old"),
    entry(7, "immortalwrt-ccache-v3-ubuntu2204-X64-source-branch-nn6000-v2-config-7-1"),
  ];
  const result = await pruneFixture(t, caches);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.deleted, [1, 2, 5]);
  assert.equal(result.requests[0].url.searchParams.get("ref"), options.ref);
  assert.equal(result.requests[0].authorization, "Bearer test-token");
  assert.match(readFileSync(join(result.f.temp, "summary.md"), "utf8"), /removed 3 old entries/);
});

test("cleanup preserves caches when listing fails", async (t) => {
  const result = await pruneFixture(t, [entry(1, options.currentKey)], { listingStatus: 403 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cache API GET failed: HTTP 403/);
  assert.deepEqual(result.deleted, []);
});

test("cleanup paginates and tolerates caches already evicted", async (t) => {
  const caches = Array.from({ length: 100 }, (_, index) => entry(index + 10, `unrelated-${index}`));
  caches.push(entry(1, `${prefix}config-1-1`), entry(3, options.currentKey));
  const result = await pruneFixture(t, caches, { deleteStatus: 404 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.filter((request) => request.method === "GET").map((request) => request.url.searchParams.get("page")), ["1", "2"]);
  assert.deepEqual(result.deleted, [1]);
});
