import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bash = process.env.TEST_BASH || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const shellPath = (path) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const required = ["luci-app-passwall2", "luci-app-passwall2_Basic_Core_Xray", "xray-core"];

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "immortalwrt-passwall-test-"));
  t.after(() => {
    const target = realpathSync(temp);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith("immortalwrt-passwall-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const put = (path, body) => {
    const target = join(temp, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    return target;
  };
  const make = put("bin/make", "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(make, 0o755);
  const startup = put("startup.sh", 'export PATH="$TEST_BIN:$PATH"\n');
  const run = (script, args = [], env = {}) => spawnSync(bash, [shellPath(join(root, "scripts", script)), ...args], {
    cwd: root,
    env: {
      ...process.env, OPENWRT_DIR: shellPath(temp),
      BASH_ENV: shellPath(startup), TEST_BIN: shellPath(join(temp, "bin")),
      CCACHE_DIR: shellPath(join(temp, "ccache")), ...env,
    },
    encoding: "utf8", timeout: 15000,
  });
  return { temp, put, run };
}

test("project feeds precede upstream feeds and the original configuration is backed up", (t) => {
  const f = fixture(t);
  const upstream = "# upstream feeds\nsrc-git packages https://example.org/packages.git\nsrc-git luci https://example.org/luci.git\n";
  const path = f.put("feeds.conf.default", upstream);
  const result = f.run("apply-openwrt.sh", ["feeds"]);
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(path, "utf8");
  const names = config.split(/\r?\n/).filter((line) => line.startsWith("src-git ")).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual(names, ["passwall_packages", "passwall2", "helloworld", "istore", "packages", "luci"]);
  const custom = readFileSync(join(root, "feeds/feeds.conf.default"), "utf8");
  assert.equal(config, custom + "\n" + upstream);
  assert.equal(readFileSync(join(f.temp, "base_feeds.conf.default"), "utf8"), upstream);
});

test("reapplying feeds preserves the original fixed backup without duplicating feeds", (t) => {
  const f = fixture(t);
  const original = "src-git packages https://example.org/packages.git\n";
  const path = f.put("feeds.conf.default", original);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run("apply-openwrt.sh", ["feeds"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.temp, "base_feeds.conf.default"), "utf8"), original);
    const custom = readFileSync(join(root, "feeds/feeds.conf.default"), "utf8");
    assert.equal(readFileSync(path, "utf8"), custom + "\n" + original);
  }
});

test("missing upstream feed configuration fails before creating a backup or replacement", (t) => {
  const f = fixture(t);
  const result = f.run("apply-openwrt.sh", ["feeds"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /feed configuration is missing/);
  assert.ok(!readdirSync(f.temp).some((name) => name === "feeds.conf.default" || name === "base_feeds.conf.default"));
});

for (const device of ["x86_64", "nn6000-v2"]) {
  test(`${device} default composition includes Passwall2 and Xray in the firmware`, (t) => {
    const f = fixture(t);
    const result = f.run("compose-config.sh", [], {
      TARGET_CONFIG: `configs/targets/${device}.config`,
      APP_CONFIG: "configs/apps/default.config",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const lines = readFileSync(join(f.temp, ".config"), "utf8").split(/\r?\n/);
    for (const pkg of required) assert.ok(lines.includes(`CONFIG_PACKAGE_${pkg}=y`), pkg);
  });
}

