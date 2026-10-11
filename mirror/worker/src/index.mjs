const PREFIX = "/immortalwrt/";
const PACKAGE = /\.(ipk|apk)$/;
const INDEX = /^(Packages(\.(gz|sig|manifest))?|packages\.adb(\.(sig|asc))?|APKINDEX\.tar\.gz)$/;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const FORWARD_HEADERS = ["range", "if-range", "if-none-match", "if-modified-since"];

function failure(status, message, headers = {}) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function clientResponse(response, method, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("expires");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Mirror-Cache", cacheStatus);
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Dependencies are injectable for offline behavior tests; production uses the
// Workers fetch and Cache API. No buffers or package parsing are needed.
export function createHandler({ fetchImpl = (...args) => fetch(...args), getCache = () => caches.default } = {}) {
  return async function handle(request, env, ctx) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return failure(405, "GET and HEAD only", { Allow: "GET, HEAD" });
    }
    const url = new URL(request.url);
    if (url.search || /%|\/\/|\/\.{1,2}(\/|$)/.test(url.pathname)) {
      return failure(400, "Non-canonical path or query string");
    }
    if (!/^\/immortalwrt\/(releases|snapshots)\/[A-Za-z0-9._+~/-]+$/.test(url.pathname)) {
      return failure(404, "Not a package repository path");
    }
    const isPackage = PACKAGE.test(url.pathname);
    if (!isPackage && !INDEX.test(url.pathname.split("/").at(-1))) {
      return failure(404, "Only packages, indexes and signatures are proxied");
    }

    let origin;
    try {
      const base = new URL(env.UPSTREAM_BASE_URL || "https://downloads.immortalwrt.org/");
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
          !base.pathname.endsWith("/") || base.host === url.host) {
        throw new Error("Invalid upstream");
      }
      // Base is trusted deployment configuration. Client supplies only a path.
      origin = new URL(url.pathname.slice(PREFIX.length), base);
    } catch {
      return failure(500, "Invalid UPSTREAM_BASE_URL configuration");
    }

    const hasConditions = FORWARD_HEADERS.some(name => request.headers.has(name));
    const eligible = isPackage && request.method === "GET" && !hasConditions;
    // Changing origin automatically isolates existing cache entries.
    const keyURL = new URL(url);
    keyURL.searchParams.set("origin", origin.href);
    keyURL.searchParams.set("version", env.CACHE_VERSION || "v1");
    const key = new Request(keyURL, { method: "GET" });
    let cache;
    if (eligible) {
      try {
        cache = getCache();
        const hit = await cache.match(key);
        if (hit) return clientResponse(hit, request.method, "HIT");
      } catch {
        // Cache outages must not prevent a valid download from the origin.
        cache = undefined;
      }
    }

    const headers = new Headers({ "Accept-Encoding": "identity" });
    for (const name of FORWARD_HEADERS) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    let response;
    try {
      response = await fetchImpl(origin.href, {
        method: request.method,
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: request.signal,
      });
    } catch {
      return failure(502, "Upstream request failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      return failure(502, "Upstream redirected; configure its final HTTPS base URL");
    }

    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    let cacheStatus = "BYPASS";
    if (eligible && cache && response.status === 200 && !response.headers.has("set-cookie") &&
        Number.isSafeInteger(length) && length >= 0 && length <= MAX_CACHE_BYTES) {
      const ttl = url.pathname.startsWith(`${PREFIX}releases/`) ? 86400 : 3600;
      const cached = response.clone();
      const cacheHeaders = new Headers(cached.headers);
      cacheHeaders.delete("expires");
      cacheHeaders.delete("age");
      cacheHeaders.set("Date", new Date().toUTCString());
      cacheHeaders.set("Cache-Control", `public, max-age=${ttl}`);
      const stored = new Response(cached.body, { status: 200, headers: cacheHeaders });
      ctx.waitUntil(cache.put(key, stored).catch(() => {
        console.warn("Package cache write failed");
      }));
      cacheStatus = "MISS";
    }
    return clientResponse(response, request.method, cacheStatus);
  };
}

export default { fetch: createHandler() };
