import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.mjs";

const BASE = "https://packages.example.com/immortalwrt/";
const PACKAGE = "snapshots/packages/x86_64/base/example-1-r1.apk";

function fixture({ response, fetchError, matchError, putError } = {}) {
  const calls = [];
  const puts = [];
  const entries = new Map();
  const pending = [];
  let matches = 0;
  const cache = {
    async match(key) {
      matches++;
      if (matchError) throw new Error("Cache unavailable");
      return entries.get(key.url)?.clone();
    },
    async put(key, value) {
      if (putError) throw new Error("Cache full");
      puts.push({ key: key.url, headers: new Headers(value.headers) });
      entries.set(key.url, new Response(await value.arrayBuffer(), { headers: value.headers }));
    },
  };
  const handle = createHandler({
    getCache: () => cache,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (fetchError) throw new Error("Origin unavailable");
      return response ? response() : new Response(new Uint8Array([0, 128, 255]), {
        headers: { "content-length": "3", "etag": '"v1"' },
      });
    },
  });
  return {
    calls, puts, get matches() { return matches; },
    async request(path = PACKAGE, init = {}, env = {}) {
      const result = await handle(new Request(BASE + path, init), env, { waitUntil: p => pending.push(p) });
      await Promise.all(pending.splice(0));
      return result;
    },
  };
}

test("official path mapping, byte integrity and repeat-request cache hit", async () => {
  const f = fixture();
  const first = await f.request();
  assert.equal(f.calls[0].url, "https://downloads.immortalwrt.org/" + PACKAGE);
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.equal(first.headers.get("X-Mirror-Cache"), "MISS");
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0, 128, 255]);
  assert.equal(f.puts[0].headers.get("Cache-Control"), "public, max-age=3600");
  const second = await f.request();
  assert.equal(second.headers.get("X-Mirror-Cache"), "HIT");
  assert.equal(second.headers.get("Cache-Control"), "no-store");
  assert.equal(second.headers.get("etag"), '"v1"');
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [0, 128, 255]);
  assert.equal(f.calls.length, 1);
});

test("release package TTL is finite and differs from snapshots", async () => {
  const f = fixture();
  await f.request("releases/24.10.6/packages/x86_64/base/example_1_x86_64.ipk");
  assert.equal(f.puts[0].headers.get("Cache-Control"), "public, max-age=86400");
});

test("NJU or VPS base paths are retained and origin changes isolate cache", async () => {
  const f = fixture();
  await f.request();
  await f.request(PACKAGE, {}, { UPSTREAM_BASE_URL: "https://mirrors.nju.edu.cn/immortalwrt/" });
  assert.equal(f.calls[1].url, "https://mirrors.nju.edu.cn/immortalwrt/" + PACKAGE);
  assert.notEqual(f.puts[0].key, f.puts[1].key);
});

test("every supported index and detached signature bypasses read and write cache", async () => {
  const f = fixture();
  for (const file of ["Packages", "Packages.gz", "Packages.sig", "Packages.manifest", "packages.adb", "packages.adb.sig", "packages.adb.asc", "APKINDEX.tar.gz"]) {
    const path = "snapshots/packages/x86_64/base/" + file;
    for (let i = 0; i < 2; i++) {
      const result = await f.request(path);
      assert.equal(result.headers.get("X-Mirror-Cache"), "BYPASS");
    }
  }
  assert.equal(f.matches, 0);
  assert.equal(f.puts.length, 0);
  assert.equal(f.calls.length, 16);
});

test("HEAD does not cache an empty body", async () => {
  const f = fixture();
  const result = await f.request(PACKAGE, { method: "HEAD" });
  assert.equal(result.body, null);
  assert.equal(f.calls[0].init.method, "HEAD");
  assert.equal(f.matches, 0);
  assert.equal(f.puts.length, 0);
});

test("Range preserves 206 and Content-Range and bypasses existing full cache", async () => {
  const f = fixture({ response: () => new Response("b", {
    status: 206, headers: { "Content-Range": "bytes 1-1/3", "Content-Length": "1" },
  }) });
  const result = await f.request(PACKAGE, { headers: { Range: "bytes=1-1", "If-Range": '"v1"' } });
  assert.equal(result.status, 206);
  assert.equal(result.headers.get("Content-Range"), "bytes 1-1/3");
  assert.equal(f.calls[0].init.headers.get("Range"), "bytes=1-1");
  assert.equal(f.calls[0].init.headers.get("If-Range"), '"v1"');
  assert.equal(f.matches, 0);
  assert.equal(f.puts.length, 0);
});

test("conditional requests preserve 304 and validators", async () => {
  const f = fixture({ response: () => new Response(null, { status: 304 }) });
  const result = await f.request(PACKAGE, { headers: { "If-None-Match": '"v1"' } });
  assert.equal(result.status, 304);
  assert.equal(f.calls[0].init.headers.get("If-None-Match"), '"v1"');
  assert.equal(f.matches, 0);
  assert.equal(f.puts.length, 0);
});

test("client credentials, cookies and host overrides never reach upstream", async () => {
  const f = fixture();
  await f.request(PACKAGE, { headers: { Authorization: "secret", Cookie: "token=secret", Host: "attacker.example", "X-Forwarded-Host": "attacker.example" } });
  const headers = f.calls[0].init.headers;
  for (const name of ["authorization", "cookie", "host", "x-forwarded-host"]) assert.equal(headers.has(name), false);
});

test("query strings, encoded paths and arbitrary downloads never reach origin", async () => {
  const f = fixture();
  for (const [path, status] of [[PACKAGE + "?url=https://example.com", 400], ["snapshots/%2fetc/Packages.gz", 400], ["snapshots//base/Packages.gz", 400], ["snapshots/targets/x86/64/firmware.bin", 404], ["snapshots/packages/x86_64/base/", 404], ["https://example.com/test.apk", 400]]) {
    assert.equal((await f.request(path)).status, status);
  }
  assert.equal((await f.request(PACKAGE, { method: "POST" })).status, 405);
  assert.equal(f.calls.length, 0);
});

test("invalid or recursive upstream configuration fails before fetch", async () => {
  const f = fixture();
  for (const base of ["http://downloads.immortalwrt.org/", "https://user:pass@example.com/", "https://example.com/no-trailing-slash", "https://example.com/?url=x", "https://packages.example.com/immortalwrt/"]) {
    assert.equal((await f.request(PACKAGE, {}, { UPSTREAM_BASE_URL: base })).status, 500);
  }
  assert.equal(f.calls.length, 0);
});

test("redirects are not followed and do not send clients back to origin", async () => {
  const f = fixture({ response: () => new Response("redirect", { status: 302, headers: { Location: "https://attacker.example/file.apk" } }) });
  const result = await f.request();
  assert.equal(result.status, 502);
  assert.equal(result.headers.has("Location"), false);
  assert.equal(f.calls[0].init.redirect, "manual");
  assert.equal(f.puts.length, 0);
});

test("origin errors stay errors and are never cached", async () => {
  for (const status of [404, 429, 500, 503]) {
    const f = fixture({ response: () => new Response("error", { status }) });
    assert.equal((await f.request()).status, status);
    assert.equal(f.puts.length, 0);
  }
  const f = fixture({ fetchError: true });
  assert.equal((await f.request()).status, 502);
});

test("unknown size, large packages and cookie responses stream without caching", async () => {
  for (const headers of [{}, { "Content-Length": String(33 * 1024 * 1024) }, { "Content-Length": "3", "Set-Cookie": "a=b" }]) {
    const f = fixture({ response: () => new Response("abc", { headers }) });
    const result = await f.request();
    assert.equal(await result.text(), "abc");
    assert.equal(result.headers.has("Set-Cookie"), false);
    assert.equal(result.headers.get("X-Mirror-Cache"), "BYPASS");
    assert.equal(f.puts.length, 0);
  }
});

test("cache read and write failures do not break downloads", async () => {
  for (const options of [{ matchError: true }, { putError: true }]) {
    const f = fixture(options);
    const result = await f.request();
    assert.equal(result.status, 200);
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [0, 128, 255]);
  }
});
