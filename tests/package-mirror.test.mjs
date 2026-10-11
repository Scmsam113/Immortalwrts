import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bash = process.env.TEST_BASH || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const shellPath = (path) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "immortalwrt-mirror-test-"));
  t.after(() => {
    const target = realpathSync(temp);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith("immortalwrt-mirror-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const put = (path, body) => {
    const dest = join(temp, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    return dest;
  };
  const run = (script, env = {}) => spawnSync(bash, [shellPath(script)], {
    cwd: root, env: { ...process.env, OPENWRT_DIR: shellPath(temp), ...env }, encoding: "utf8", timeout: 15000,
  });
  return { temp, put, run };
}

test("first boot rewrites APK and OPKG paths and preserves custom sources", (t) => {
  const f = fixture(t);
  const opkg = f.put("etc/opkg/distfeeds.conf", "src/gz core https://downloads.immortalwrt.org/releases/24.10.6/targets/x86/64/packages\nsrc/gz custom https://example.org/packages\n");
  const apk = f.put("etc/apk/repositories.d/distfeeds.list", "https://mirrors.vsean.net/openwrt/snapshots/packages/aarch64_cortex-a53/base/packages.adb\nhttps://downloads.immortalwrt.org/snapshots/targets/qualcommax/ipq60xx/kmods/6.18-hash/packages.adb\n");
  const calls = f.put("uci-calls", "");
  const uci = f.put("bin/uci", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UCI_CALLS"\n[ "$*" != "-q get system.@imm_init[0]" ]\n');
  chmodSync(uci, 0o755);
  const startup = f.put("startup.sh", 'export PATH="$TEST_BIN:$PATH"\n');
  const script = f.put("mirror.sh", readFileSync(join(root, "files/etc/uci-defaults/99-zz-package-mirror"), "utf8").replaceAll("/etc/", `${shellPath(f.temp)}/etc/`));
  const env = { BASH_ENV: shellPath(startup), TEST_BIN: shellPath(join(f.temp, "bin")), UCI_CALLS: shellPath(calls) };
  for (let run = 0; run < 2; run++) {
    const result = f.run(script, env);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(opkg, "utf8"), "src/gz core https://mirrors.nju.edu.cn/immortalwrt/releases/24.10.6/targets/x86/64/packages\nsrc/gz custom https://example.org/packages\n");
  assert.equal(readFileSync(apk, "utf8"), "https://mirrors.nju.edu.cn/immortalwrt/snapshots/packages/aarch64_cortex-a53/base/packages.adb\nhttps://mirrors.nju.edu.cn/immortalwrt/snapshots/targets/qualcommax/ipq60xx/kmods/6.18-hash/packages.adb\n");
  const uciCalls = readFileSync(calls, "utf8");
  assert.match(uciCalls, /opkg_mirror=https:\/\/mirrors.nju.edu.cn\/immortalwrt/);
  assert.match(uciCalls, /apk_mirror=https:\/\/mirrors.nju.edu.cn\/immortalwrt/);
});

