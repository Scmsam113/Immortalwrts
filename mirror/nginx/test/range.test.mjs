import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const nginx = process.env.NGINX_BIN || "nginx";
const templates = fileURLToPath(new URL("../", import.meta.url));
const body = "0123456789";
const etag = '"v1"';
const nginxPath = path => path.replaceAll("\\", "/");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function fixture(t) {
  const version = spawnSync(nginx, ["-v"], { encoding: "utf8", windowsHide: true });
  assert.equal(version.status, 0, `Install Nginx or set NGINX_BIN. ${version.error || version.stderr}`);
  const temp = mkdtempSync(join(tmpdir(), "immortalwrt-nginx-range-test-"));
  const prefix = `${nginxPath(temp)}/`;
  const calls = [];
  const origin = createServer((request, response) => {
    calls.push({ path: request.url, range: request.headers.range, ifRange: request.headers["if-range"] });
    response.setHeader("ETag", etag);
    response.setHeader("Accept-Ranges", "bytes");
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range && (!request.headers["if-range"] || request.headers["if-range"] === etag)) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || end < start) {
        response.writeHead(416, { "Content-Range": `bytes */${body.length}`, "Content-Length": "0" }).end();
      } else {
        const part = body.slice(start, end + 1);
        response.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": String(part.length),
        }).end(part);
      }
    } else {
      response.writeHead(200, { "Content-Length": String(body.length) }).end(body);
    }
  });
  let child;
  let childExit;
  t.after(async () => {
    try {
      if (child && child.exitCode === null) {
        spawnSync(nginx, ["-p", prefix, "-c", "nginx.conf", "-s", "quit"], { windowsHide: true });
        const stopped = await Promise.race([childExit.then(() => true), delay(5000, undefined, { ref: false }).then(() => false)]);
        assert.ok(stopped, "Test Nginx did not stop; preserving its temporary directory.");
      }
    } finally {
      origin.closeAllConnections();
      if (origin.listening) await new Promise(done => origin.close(done));
    }
    const target = realpathSync(temp);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith("immortalwrt-nginx-range-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const originPort = await listen(origin);
  const portReservation = createServer();
  const proxyPort = await listen(portReservation);
  await new Promise(done => portReservation.close(done));
  mkdirSync(join(temp, "logs"));
  mkdirSync(join(temp, "cache"));
  mkdirSync(join(temp, "temp"));

  // Reuse the actual templates. Only deployment addresses, paths and TLS are
  // adapted to local HTTP so the test needs no DNS, root access or certificates.
  const common = readFileSync(join(templates, "proxy-common.conf"), "utf8")
    .replace("proxy_pass https://", "proxy_pass http://")
    .replace(/^proxy_ssl_.*;\r?\n/gm, "");
  writeFileSync(join(temp, "proxy-common.conf"), common);
  const config = readFileSync(join(templates, "immortalwrt.conf"), "utf8")
    .replace(/server \{\s*listen 80;[\s\S]*?\n\}/, "")
    .replace("listen 443 ssl;", `listen 127.0.0.1:${proxyPort};`)
    .replaceAll("mirror.example.com", "127.0.0.1")
    .replace(/^\s*ssl_.*;\r?\n/gm, "")
    .replace("/var/cache/nginx/immortalwrt", `"${prefix}cache"`)
    .replace("/var/log/nginx/immortalwrt-access.log", `"${prefix}logs/access.log"`)
    .replace("/var/log/nginx/immortalwrt-error.log", `"${prefix}logs/error.log"`)
    .replace("set $mirror_origin_host downloads.immortalwrt.org;", `set $mirror_origin_host 127.0.0.1:${originPort};`)
    .replaceAll("/etc/nginx/snippets/immortalwrt-proxy.conf", `"${prefix}proxy-common.conf"`);
  writeFileSync(join(temp, "nginx.conf"), `daemon off;\nworker_processes 1;\npid logs/nginx.pid;\nevents { worker_connections 128; }\nhttp {\n${config}\n}\n`);
  const syntax = spawnSync(nginx, ["-p", prefix, "-c", "nginx.conf", "-t"], { encoding: "utf8", windowsHide: true });
  assert.equal(syntax.status, 0, syntax.stderr);
  child = spawn(nginx, ["-p", prefix, "-c", "nginx.conf"], { windowsHide: true, stdio: "ignore" });
  childExit = once(child, "exit");
  const base = `http://127.0.0.1:${proxyPort}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) });
      break;
    } catch (error) {
      if (attempt >= 50 || child.exitCode !== null) throw error;
      await delay(100);
    }
  }
  return {
    calls,
    async get(path, headers = {}) {
      const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) });
      return { status: response.status, headers: response.headers, body: await response.text() };
    },
  };
}

test("Nginx forwards ranges to the origin and keeps partial downloads out of the full cache", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  for (const repo of ["releases/24.10.6", "snapshots"]) {
    await t.test(repo, async () => {
      const path = `/immortalwrt/${repo}/packages/x86_64/base/example.apk`;
      const rangeHeaders = { Range: "bytes=2-5", "If-Range": etag };
      const expectRange = async () => {
        const count = f.calls.length;
        const result = await f.get(path, rangeHeaders);
        assert.equal(result.status, 206);
        assert.equal(result.headers.get("Content-Range"), "bytes 2-5/10");
        assert.equal(result.headers.get("Content-Length"), "4");
        assert.equal(result.body, "2345");
        assert.equal(result.headers.get("X-Mirror-Cache"), "BYPASS");
        assert.equal(f.calls.length, count + 1);
        assert.deepEqual(f.calls.at(-1), { path: path.slice("/immortalwrt".length), range: "bytes=2-5", ifRange: etag });
      };
      await expectRange();
      await expectRange();
      const full = await f.get(path);
      assert.equal(full.status, 200);
      assert.equal(full.body, body);
      assert.equal(full.headers.get("X-Mirror-Cache"), "MISS");
      const count = f.calls.length;
      assert.equal((await f.get(path)).headers.get("X-Mirror-Cache"), "HIT");
      assert.equal(f.calls.length, count);
      await expectRange();
      assert.equal((await f.get(path)).headers.get("X-Mirror-Cache"), "HIT");

      // A stale If-Range returns a complete 200; this must also remain uncached.
      const stalePath = path.replace("example.apk", "stale.apk");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.get(stalePath, { Range: "bytes=2-5", "If-Range": '"old"' });
        assert.equal(result.status, 200);
        assert.equal(result.body, body);
        assert.equal(result.headers.get("X-Mirror-Cache"), "BYPASS");
        assert.equal(f.calls.at(-1).ifRange, '"old"');
        assert.equal(f.calls.at(-1).range, "bytes=2-5");
      }
      assert.equal((await f.get(stalePath)).headers.get("X-Mirror-Cache"), "MISS");
      const invalid = await f.get(path, { Range: "bytes=20-", "If-Range": etag });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get("Content-Range"), "bytes */10");
      assert.equal(invalid.body, "");
    });
  }
});
