# ImmortalWrt 云编译固件

[ImmortalWrt](https://github.com/immortalwrt/immortalwrt) 构建下列设备：

| 设备 ID | 目标 | 手动构建状态 | 定时发布状态 |
| --- | --- | --- | --- |
| `x86_64` | x86-64 generic，生成 ISO、VMDK 与 EXT4 镜像 | [![手动构建状态](https://github.com/bigbugcc/Immortalwrts/actions/workflows/manual-build.yml/badge.svg?branch=main)](https://github.com/bigbugcc/Immortalwrts/actions/workflows/manual-build.yml?query=branch%3Amain) | [![定时发布状态](https://github.com/bigbugcc/Immortalwrts/actions/workflows/schedule-release.yml/badge.svg?branch=main)](https://github.com/bigbugcc/Immortalwrts/actions/workflows/schedule-release.yml?query=branch%3Amain) |
| `nn6000-v2` | Link NN6000 v2，`qualcommax/ipq60xx` | [![手动构建状态](https://github.com/bigbugcc/Immortalwrts/actions/workflows/manual-build.yml/badge.svg?branch=main)](https://github.com/bigbugcc/Immortalwrts/actions/workflows/manual-build.yml?query=branch%3Amain) | [![定时发布状态](https://github.com/bigbugcc/Immortalwrts/actions/workflows/schedule-release.yml/badge.svg?branch=main)](https://github.com/bigbugcc/Immortalwrts/actions/workflows/schedule-release.yml?query=branch%3Amain) |

徽章显示本仓库 `main` 分支对应工作流的整体执行状态。两个设备共用工作流，因此显示相同徽章；点击徽章进入运行记录后，可查看各设备构建 job 的结果。


## ActionInfo

- 手动构建与每周定时发布
- 由 `manifests/builds.json` 驱动的构建矩阵和工作流一致性检查
- 显式启用 ccache，按上游来源、分支、runner、设备隔离并持续更新快照
- 分阶段编译，内存不足时降低并行度重试；保存诊断 Artifact 和可选 GitHub Release
- 默认管理地址 `192.168.10.1`

## 使用

在 GitHub Actions 中运行：

- `Manual ImmortalWrt Build`：选择 `x86_64`、`nn6000-v2` 或 `all`；可临时覆盖上游分支。
- `Scheduled ImmortalWrt Release`：默认每周构建两个设备并创建 Release；手动触发时可以用逗号分隔设备 ID。

固件上传到 Release 前会同时作为 Action Artifact 保存。不要将 x86 与 NN6000 v2 的镜像交叉刷写。

## 软件源

首次启动在上游中文默认设置之后，将 APK/OPKG 软件源切换到 `https://mirrors.nju.edu.cn/immortalwrt`，保留原来的版本、架构和内核 ABI 路径，并保存对应的 UCI 镜像设置。南京大学提供 master 所需的 snapshots；中科大仅同步 releases，不适用于本仓库默认的 master 构建。镜像不提供本仓库全部第三方包。

已刷入旧固件时，可在 SSH 中执行以下命令切换软件源（会备份现有源文件）：

```sh
mirror='https://mirrors.nju.edu.cn/immortalwrt'
uci -q get 'system.@imm_init[0]' >/dev/null || uci -q add system imm_init >/dev/null
for feeds in /etc/opkg/distfeeds.conf /etc/apk/repositories.d/distfeeds.list; do
  [ -f "$feeds" ] || continue
  sed -i.old \
    -e "s|https\?://downloads\.immortalwrt\.org/|$mirror/|g" \
    -e "s|https\?://mirrors\.vsean\.net/openwrt/|$mirror/|g" "$feeds"
  case "$feeds" in
    /etc/opkg/*) uci set "system.@imm_init[0].opkg_mirror=$mirror" ;;
    /etc/apk/*) uci set "system.@imm_init[0].apk_mirror=$mirror" ;;
  esac
done
uci commit system
if command -v apk >/dev/null 2>&1; then apk update; else opkg update; fi
```

保留旧设置升级后如果仍显示原来的软件源，也可执行以上命令。自编译 master 固件的内核 ABI 可能与官方 snapshots 不同，安装额外 kmod 时仍需使用匹配本次编译的包；更换镜像不会解决 ABI 不匹配。

## 编译缓存与故障诊断

两个入口工作流均可选择 `cache_mode`：

| 模式 | 恢复 | 保存 | 用途 |
| --- | --- | --- | --- |
| `readwrite` | 优先同配置，再恢复同设备快照 | 编译镜像成功后保存新快照 | 默认构建与定时发布 |
| `fresh` | 不恢复 | 编译镜像成功后保存新快照 | 排除旧缓存问题，并替换缓存 |
| `off` | 不恢复；ccache 包装器禁用缓存 | 不保存 | 测量无缓存基线 |

仅缓存 `/mnt/workdir/cache/ccache`，暂不缓存源码下载目录 `dl`、Go 模块目录、`build_dir` 或 `staging_dir`。下载后不再按文件大小删除文件，避免破坏合法源码和 Go 模块。源码下载每次重新执行，后续以实测净收益决定是否增加独立归档缓存。

每个设备的 ccache 初始容量上限为 1.5 GiB，编译器按内容检查，避免重新生成的工具链仅因时间戳变化而失效。缓存 key 包含配置哈希及运行编号，每次成功构建均可积累新的编译结果；前缀恢复时 `cache-hit=false` 是正常情况，实际恢复结果看 Summary 的 `Matched key`。

保存位于固件上传前，上传失败不会丢失成功编译的快照。确认新快照已出现在缓存 API 后，在当前 Git ref、上游来源、runner、分支和设备范围内仅保留本次最新一份快照，删除同范围的其他快照，并清理同分支同设备的旧 `v2` 合并缓存。API 不可用或新快照未确认时保留旧缓存。先保存再清理，期间可能短暂存在多份；清理失败时也可能留下旧快照。清理所需的 `actions: write` 权限仅授予构建 job。

恢复异常时丢弃本次解压出的部分 ccache，退回空缓存编译；单纯未命中不视为错误。编译失败和取消不保存新快照。仓库默认缓存限额为 10 GB，两个设备各保留一份快照，约占最多 3 GiB 的本地条目预算；实际归档大小以 GitHub 为准。多个上游分支或 Git refs 会增加总占用，超过七天未访问也可能被淘汰，因此每周构建仍可能冷启动。

每次构建上传 `build-logs-设备-运行编号-重试编号`，保留 14 天，包含：

- 上游与 feeds commit、最终配置、CPU、内存和磁盘信息；
- 每个 make 目标的完整日志、退出码、耗时和重试次数；
- ccache 恢复结果、有效配置及每个阶段的累计命中统计。

初始编译线程数默认取 `nproc`，可通过 `JOBS` 覆盖。仅日志出现明确的内存耗尽信息时减半重试一次；`FALLBACK_JOBS` 可覆盖，但必须少于初始线程数才会重试。下载失败最多重试一次。源码、补丁及普通依赖错误保留原始错误并终止，查看失败阶段日志定位具体包。

验证提速时，使用相同上游和 feeds commits、最终配置，先运行 `fresh` 生成缓存，再运行 `readwrite` 验证命中，并用 `off` 对照。比较各编译阶段及完整 job 耗时，包含恢复、保存和整理缓存开销；同时记录 CPU 和线程数，避免把 runner 性能差异当作缓存收益。ccache 主要加速可缓存的 C/C++ 编译，Go/Rust 编译、链接和镜像制作仍需执行。

## 本地校验

```powershell
node scripts/openwrts.mjs validate-manifest
node scripts/openwrts.mjs generate-workflows --check
node scripts/openwrts.mjs resolve-matrix --device nn6000-v2
node --test tests/*.test.mjs
```

改动 `manifests/builds.json` 后运行 `node scripts/openwrts.mjs generate-workflows`，再提交生成的两个入口工作流。

两个入口工作流在解析构建矩阵前自动执行缓存、编译与软件源设置的行为测试。Windows 测试默认使用 `C:/Program Files/Git/bin/bash.exe`，其他安装位置可通过 `TEST_BASH` 指定；Linux 使用 PATH 中的 Bash。

缓存统一由 `scripts/cache.sh` 管理，提供 `metadata`、`init`、`stats [phase]`、`prepare` 和 `prune` 子命令。本地 ccache 操作使用 Bash；`prune` 使用脚本内嵌的 Node.js 代码访问 GitHub API，仅在 CI 保存新快照后调用。

## 目录

```text
.github/workflows/  手动、定时与复用构建工作流
configs/targets/    两个硬件目标配置
configs/apps/       共用的 LuCI 与功能包选择
feeds/              ImmortalWrt 专用第三方 feeds
packages/           ImmortalWrt 专用第三方包克隆
manifests/          唯一上游和设备构建矩阵
scripts/            环境、源码、配置与编译脚本
```
