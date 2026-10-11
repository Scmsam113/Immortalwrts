# ImmortalWrt 运行时软件包代理

本目录提供 Nginx 和 Cloudflare Worker 两套部署模板，服务 APK/OPKG 在固件运行时请求的包、索引和签名。默认回源 `https://downloads.immortalwrt.org/`；客户端统一使用 `https://你的域名/immortalwrt`，保留 releases/snapshots、架构、target 和内核 ABI 后缀。

本目录是独立部署文件，不会自动改变仓库的固件源地址。当前首次启动脚本仍使用南京大学镜像，选定并验证入口后再接入。

## 拓扑与选择

| 方案 | 请求链路 | 适用情况 |
| --- | --- | --- |
| Nginx | 路由器 → VPS Nginx → 官方源 | VPS 到路由器线路好；希望掌握磁盘缓存、日志和限速 |
| Worker | 路由器 → Cloudflare Worker → 官方源 | 希望使用边缘入口、托管 TLS，无需维护 VPS |
| Worker + Nginx | 路由器 → Worker → VPS Nginx → 官方源 | 官方回源不稳定，希望利用 VPS 的持久缓存；链路更长，需实测 |

建议先分别测试前两种，后者按需要使用。海外 VPS 不意味着国内访问更快，Cloudflare 的国内访问效果也由运营商和地区决定。包请求量较小时，命中率可能不高；收益主要来自线路改善及重复下载。Worker 使用自有域名，Nginx 的 VPS 入口另用域名，不能配置成互相回源。

## 缓存和兼容性

| 内容 | Nginx | Worker |
| --- | --- | --- |
| `Packages`、`Packages.gz`、`Packages.sig`、`Packages.manifest` | 实时回源 | 实时回源 |
| `packages.adb`、其 `.sig` / `.asc`、`APKINDEX.tar.gz` | 实时回源 | 实时回源 |
| releases 下 `.ipk` / `.apk`，完整 200 响应 | 24 小时 | 24 小时，且声明的长度不超过 32 MiB |
| snapshots 下 `.ipk` / `.apk`，完整 200 响应 | 1 小时 | 1 小时，同样有长度限制 |
| Range 下载 | 绕过缓存，保留 Range/If-Range | 绕过缓存，保留 Range/If-Range |
| HEAD / 条件请求 | Nginx 原生处理 | 回源，保留验证头；HEAD 不写缓存 |
| 404 / 429 / 5xx | 返回原状态，不缓存 | 返回原状态，不缓存 |
| 上游重定向 | 转成 502，需核实最终源站地址 | 同样转成 502，不自动跟随 |

实时回源避免代理把索引与独立签名分别冻结在不同版本。仍不能消除源站同步过程中产生的不一致；此时等待同步并重新 update，不能关闭签名校验。所有文件保持字节内容，不解压、重签名或改写包。

包缓存使用有限 TTL，因为 releases 软件包也可能更新，同名包可能被重新发布。若出现哈希/签名不一致，清除对应包缓存并重新 update；不启用过期缓存、后台 stale 返回，也不混用不同镜像的索引与包。当前 snapshots 源可能删除旧包，缓存不是完整历史镜像；它不能解决旧固件的 ABI 不兼容，也不能补齐本仓库第三方 feeds 中未发布到官方源的包。

两套配置只允许 GET/HEAD、releases/snapshots 下的包或已知索引文件，不接受查询参数、任意源 URL、目录浏览、固件镜像。它们是固定上游代理，但默认允许公众下载这些包。仅自己使用时，Nginx 加 `allow 你的出口IP; deny all;`，Worker 自有域名通过 Cloudflare WAF/限速规则控制入口；APK/OPKG 不能完成交互式登录，不适合给入口套浏览器挑战。Nginx 从客户端移除 Authorization/Cookie；Worker 使用请求头白名单。

## Nginx 部署

文件：`nginx/immortalwrt.conf` 和 `nginx/proxy-common.conf`。模板面向 Linux Nginx，`immortalwrt.conf` 放在 `http {}` 中 include 的目录，例如 `/etc/nginx/conf.d/`，不要再套一层 `http {}`。

1. 将全部 `mirror.example.com` 替换为你的 VPS 域名，DNS 指向 VPS，准备有效 TLS 证书。
2. 确认 CA 文件 `/etc/ssl/certs/ca-certificates.crt` 存在；非 Debian/Ubuntu 系统按实际路径修改。配置显式开启回源 TLS 校验，设置正确 Host 和 SNI。
3. 把公共片段放到 `/etc/nginx/snippets/immortalwrt-proxy.conf`，主配置放到 `/etc/nginx/conf.d/immortalwrt.conf`。片段不能放入被直接 include 的 conf.d 中，因为它只能在 location 内使用。
4. 创建 `/var/cache/nginx/immortalwrt`，让 Nginx worker 用户可写；缓存上限为 10 GiB，需预留临时写入及系统空间。修改 worker 用户与权限时以服务器的实际配置为准。
5. 执行 `nginx -t`，通过后 reload。模板只声明指定域名，服务器自己的默认虚拟主机应拒绝未知 Host，避免额外访问入口。

官方源映射：客户端 `/immortalwrt/snapshots/...` → 官方 `/snapshots/...`。公共片段先去掉 `/immortalwrt`，再添加上游前缀。

若实测南京大学回源更好，主配置只需改：

```nginx
set $mirror_origin_host mirrors.nju.edu.cn;
set $mirror_origin_prefix /immortalwrt;
```

此时 `/immortalwrt/snapshots/...` → 南京大学 `/immortalwrt/snapshots/...`。不要重复添加前缀。DNS 使用模板中的 resolver 定期刷新；如服务器只能使用内网 DNS，替换 resolver。更换上游会改变缓存 key，避免混用旧内容。

Nginx 通过 `proxy_cache_lock` 合并相同文件的并发回源，Range 请求绕过缓存；索引完全关闭缓存。只对公开包文件忽略上游 Cache-Control/Expires，按本地 TTL 缓存；Set-Cookie 响应仍不缓存。返回给客户端 `Cache-Control: no-store`，防止其他中间层二次缓存索引或包。`X-Mirror-Cache` 用于观察包的 MISS/HIT/BYPASS，索引无值时可能不出现该头。

公共片段显式转发 `Range` 和 `If-Range`。仅设置 `proxy_cache_bypass` / `proxy_no_cache` 不足以保留它们，Nginx 的缓存请求头规则会默认移除这两个头。范围请求同时绕过缓存读取和写入，即使过期的 `If-Range` 让源站返回完整 200，也不会写入包缓存。

## Cloudflare Worker 部署

文件：`worker/src/index.mjs`、`worker/wrangler.jsonc`。Worker 不需要 KV、R2 或数据库。安装 Wrangler 4 CLI，进入 `mirror/worker`，使用自己的 Cloudflare 账号部署：

```sh
npx wrangler@4 login
npx wrangler@4 deploy --dry-run --outdir .wrangler/dry-run
npx wrangler@4 deploy
```

这些命令用于服务器/开发机的手动部署；本仓库没有自动发布工作流。正式环境应确定 Wrangler 版本并锁定工具版本。配置中的 `compatibility_date` 固定 Worker 行为。

生产环境在 Wrangler routes 中启用自己的 Custom Domain（或在控制台添加），例如：

```json
"routes": [{ "pattern": "packages.example.com", "custom_domain": true }]
```

可在验证后设置 `workers_dev: false`，仅开放自有域名。官方明确支持自有域名下的 Cache API；控制台编辑器和 Playground 预览中的缓存操作无效，Cloudflare Access 前置场景也不可用。正式缓存命中测试应在自有域名上进行，不从预览或 workers.dev 测试推断生产效果。

`UPSTREAM_BASE_URL` 必须是 HTTPS，不能包含凭据、查询或片段，必须以 `/` 结尾。它是管理员配置，客户端不能覆盖：

| 回源 | 值 |
| --- | --- |
| 官方源，默认 | `https://downloads.immortalwrt.org/` |
| 南京大学 | `https://mirrors.nju.edu.cn/immortalwrt/` |
| 本目录部署的 VPS Nginx | `https://mirror.example.com/immortalwrt/` |

Worker 的 fetch 使用 `cache: no-store`，避免意外使用子请求默认缓存；包缓存由自有域名下的 `caches.default` 管理，key 包含源地址。索引、签名、Range、条件请求及 HEAD 不读写 Cache API。返回流不解析内容；只有成功、无 Set-Cookie、有可靠 Content-Length 且 ≤32 MiB 的包才通过 clone 和 waitUntil 写缓存，大包/未知长度直接流式传输。写失败不影响本次下载。32 MiB 是本实现的保守阈值，不是 Cloudflare 平台的响应大小上限。

Cache API 是数据中心本地、可被淘汰的临时缓存，不支持 Tiered Cache，也没有 Nginx 的跨请求缓存锁。同一文件的并发首次请求可能分别回源。大规模或长期保存历史包应另外设计持久镜像。

需要整体绕过旧包缓存时，将 `CACHE_VERSION` 从 `v1` 改为新的值后重新部署；旧条目自然淘汰。缓存 key 含内部查询参数，直接按客户端无查询的 URL 清除缓存可能不匹配；不要添加客户端可调用的公开清理入口。

截至 2026-10-05，Workers Free 为每天 100,000 次请求、每请求 10 ms CPU、128 MB 内存；网络等待不计 CPU，但大量下载/克隆缓存仍需观察内存与错误指标。平台 CDN 对 Free/Pro/Business 单对象缓存上限为 512 MB，本实现采用更低阈值。用控制台请求量与日志观察额度，不把 Worker 当作无限流量服务。

## 验证与固件接入

本地逻辑测试无需 Cloudflare 账号或第三方依赖：

```sh
node --test mirror/worker/test/index.test.mjs
```

Nginx 行为测试需要本机安装 Nginx，在仓库根目录执行：

```sh
node --test mirror/nginx/test/range.test.mjs
```

Windows 或 Nginx 不在 PATH 中时，用 `NGINX_BIN` 指定可执行文件，例如 PowerShell：

```powershell
$env:NGINX_BIN = 'C:/tools/nginx/nginx.exe'
node --test mirror/nginx/test/range.test.mjs
```

测试启动仅监听 `127.0.0.1` 的临时源站和真实 Nginx，结束后关闭进程并清理临时文件。它直接加载仓库模板，仅替换本机端口、路径和 TLS 设置，检查 releases/snapshots 下的冷缓存与热缓存范围请求、源站实际收到的 Range/If-Range、206 的字节内容、过期 If-Range 的 200、不合法范围的 416，以及完整包的 MISS/HIT。缺少 Nginx 会明确失败。此测试需单独执行，现有固件入口工作流不自动运行它；本机 HTTP 测试不代表生产 TLS、DNS 或路由器下载性能验证。

部署后，从实际路由器出口检查索引；示例适用于 x86_64 master，其他设备按实际源文件取路径：

```sh
curl -fsS -D - -o /dev/null https://你的域名/immortalwrt/snapshots/packages/x86_64/base/packages.adb
```

从当前索引或源站目录选一个真实存在的包，用 GET 下载两次，比较 `X-Mirror-Cache`、完整文件哈希、总耗时和下载速度。HEAD 只能检查状态，不能证明实际下载吞吐量或 Worker 缓存命中。Range 请求应返回 206 及 Content-Range；不存在的包应保持 404，不能变成 HTML 的 200。索引应每次回源且保持签名验证。

接入当前固件时，在 `/etc/opkg/distfeeds.conf` 或 `/etc/apk/repositories.d/distfeeds.list` 中，只把南京大学基址 `https://mirrors.nju.edu.cn/immortalwrt` 替换为 `https://你的域名/immortalwrt`，其余路径保持原样；按实际包管理器保存 UCI 的 `opkg_mirror` 或 `apk_mirror`，备份源文件，再运行 `opkg update` / `apk update`。若失败，恢复源文件和 UCI 原值。

后续固件默认入口在仓库 `files/etc/uci-defaults/99-zz-package-mirror` 的 `mirror` 变量配置。正式接入时应同时更新 README 与现有镜像测试。这里没有自动修改它，因为域名、实际回源和入口方案仍待确定。

比较相同包的当前南京大学直连、Nginx 首次/命中、Worker 首次/命中结果后再选择；串联时不能只看某一层 HIT，还应测完整路径。串联两级包缓存的总陈旧窗口可能叠加：snapshots 最坏约 2 小时、releases 约 48 小时；若使用串联，可将 Nginx 包缓存关闭，让 Worker 独立管理 TTL。

## 官方参考

- [Nginx proxy 模块：URI、缓存锁、Range 与 TLS 校验](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Workers Request：cache 模式及重定向](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Workers Cache API：部署环境、响应头和缓存限制](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Workers 缓存工作方式：数据中心本地缓存和 Tiered Cache](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers 平台额度](https://developers.cloudflare.com/workers/platform/limits/)
