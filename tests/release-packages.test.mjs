import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bash = process.env.TEST_BASH || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const shellPath = (path) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "immortalwrt-release-test-"));
  t.after(() => {
    const target = realpathSync(temp);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith("immortalwrt-release-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const put = (path, body) => {
    const target = join(temp, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    return target;
  };
  put(".config", 'CONFIG_TARGET_BOARD="x86"\nCONFIG_TARGET_SUBTARGET="64"\n');
  put("bin/targets/x86/64/firmware.manifest", "luci-app-ttyd - 1.0-r1\nlibc - 1.0-r1\n");
  const run = (env = {}) => spawnSync(bash, [shellPath(join(root, "scripts/package-release.sh"))], {
    cwd: root, env: { ...process.env, OPENWRT_DIR: shellPath(temp), ...env }, encoding: "utf8", timeout: 20000,
  });
  return { temp, put, run };
}

for (const format of ["apk", "ipk"]) {
  test(`release archive contains ${format} LuCI apps, dependencies, target packages, metadata and valid hashes`, (t) => {
    const f = fixture(t);
    const filename = (pkg) => format === "apk" ? `${pkg}-1.0-r1.apk` : `${pkg}_1.0-1_x86_64.ipk`;
    const app = f.put(`bin/packages/x86_64/luci/${filename("luci-app-ttyd")}`, "application package");
    f.put(`bin/packages/x86_64/base/${filename("libc")}`, "dependency");
    f.put(`bin/targets/x86/64/packages/${filename("kmod-nft-tproxy")}`, "kernel dependency");
    f.put("bin/packages/x86_64/base/Packages.gz", "index");
    f.put("bin/targets/x86/64/firmware.img.gz", "firmware image");
    const output = join(f.temp, "release"), envFile = f.put("github.env", "");
    const result = f.run({ DEVICE: "x86_64", RELEASE_DIR: shellPath(output), GITHUB_ENV: shellPath(envFile), GITHUB_OUTPUT: "" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(app), "source packages are preserved");
    assert.ok(existsSync(join(output, "firmware.img.gz")));
    assert.ok(existsSync(join(output, "firmware.manifest")));
    assert.equal(existsSync(join(output, "packages")), false);
    assert.match(readFileSync(envFile, "utf8"), /FIRMWARE=.*release/);
    const archive = readdirSync(output).find((name) => name.endsWith(".tar.gz"));
    assert.ok(archive);
    const extraction = join(f.temp, "extracted"); mkdirSync(extraction);
    const check = f.put("check.sh", `set -e\ncd "$RELEASE_DIR"\nsha256sum -c "$ARCHIVE.sha256"\ntar -xzf "$ARCHIVE" -C "$EXTRACTION"\n`);
    const verification = spawnSync(bash, [shellPath(check)], { env: { ...process.env, RELEASE_DIR: shellPath(output), ARCHIVE: archive, EXTRACTION: shellPath(extraction) }, encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr);
    for (const path of [`bin/packages/x86_64/luci/${filename("luci-app-ttyd")}`, `bin/packages/x86_64/base/${filename("libc")}`,
      `bin/targets/x86/64/packages/${filename("kmod-nft-tproxy")}`, "bin/packages/x86_64/base/Packages.gz", "build.config"]) {
      assert.ok(existsSync(join(extraction, path)), path);
    }
  });
}

test("release packaging fails when the package directory is missing", (t) => {
  const f = fixture(t);
  const result = f.run({ DEVICE: "nn6000-v2" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Package directory not found/);
});

for (const failure of ["firmware", "archive"]) {
  test(`${failure} directory transfer failure prevents publishing release outputs`, (t) => {
    const f = fixture(t);
    f.put("bin/packages/x86_64/luci/luci-app-ttyd-1.0-r1.apk", "application package");
    const fakeTar = f.put("fake/tar", `#!/usr/bin/env bash
case " $* " in
  *" -cf - "*) [ "$FAIL_PHASE" != firmware ] || { echo 'simulated firmware transfer failure' >&2; exit 74; } ;;
  *" -czf "*) [ "$FAIL_PHASE" != archive ] || { echo 'simulated archive failure' >&2; exit 74; } ;;
esac
exec /usr/bin/tar "$@"
`);
    chmodSync(fakeTar, 0o755);
    const startup = f.put("startup.sh", 'export PATH="$TEST_BIN:$PATH"\n');
    const envFile = f.put("github.env", "");
    const result = f.run({ DEVICE: "x86_64", BASH_ENV: shellPath(startup), TEST_BIN: shellPath(join(f.temp, "fake")),
      FAIL_PHASE: failure, GITHUB_ENV: shellPath(envFile), GITHUB_OUTPUT: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /simulated .* failure/);
    assert.equal(readFileSync(envFile, "utf8"), "");
  });
}
