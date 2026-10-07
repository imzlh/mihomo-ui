# Mihomo WebUI 能力边界与迁移核对

核对日期：2026-10-07。接口清单以用户提供的根目录 [api.md](../api.md) 为依据，并核对 Mihomo `Meta` 分支提交 [`88dcbf7f1614a67c3b36b848ee3592dfa92ada36`](https://github.com/MetaCubeX/mihomo/commit/88dcbf7f1614a67c3b36b848ee3592dfa92ada36)（2026-09-30）的路由、处理函数和实际状态实现。以下结论不代表所有旧版或嵌入式 Mihomo 都具有这些能力。本次核对没有操作用户正在运行的内核。

文档与源码的具体差异：`api.md` 为 GEO 更新、restart、upgrade 列出的 `{path,payload}` 请求体未被这些处理函数读取；该结构实际用于 `PUT /configs`。`api.md` 将 restart 响应记为 204，本次源码返回 `{status:"ok"}` 后重启。DNS `Question` 直接序列化 `miekg/dns.Question`，字段是 `Name/Qtype/Qclass`，与 Answer 记录的 `name/type/TTL/data` 不同。客户端应允许无内容成功响应，也正确消费实际返回 JSON，避免依靠文档示例推导不存在的配置导入语义。

## 迁移原则

界面可以借鉴 Clash Verge，但数据与操作必须遵守三个边界：

| 边界 | 可以提供的功能 | 不能暗示的能力 |
| --- | --- | --- |
| 标准 Mihomo API | 运行模式、代理选择与测速、provider 更新、连接关闭、流量与日志、支持的运行参数 | 自动等同于持久配置文件编辑或操作浏览器所在设备 |
| 浏览器本地功能 | 主题、搜索排序、页面布局、观察到的连接历史、日志导出、本地配置库 | 后端历史日志、后端文件备份、页面关闭后的后台定时任务 |
| 原生或额外服务 | 系统代理、系统服务安装、提权、开机启动、托盘、全局快捷键、Verge 配置文件管理 | 不能用一个看似可用的普通 Mihomo API 开关代替 |

现有初版的 TUN、IPv6、端口、允许局域网、日志级别都有真实 API。应修正的是文案、状态确认和类型约束；不能把所有桌面设置都认定为可迁移，也不能把这些真实内核能力误删。

## 初版界面操作核对

此表记录能力核对的起点，具体实现进度以代码为准。

| 页面与操作 | 实际能力 | 核对结论与实现要求 |
| --- | --- | --- |
| 连接控制器、填写 Secret | `GET /version`，HTTP Bearer 认证；WebSocket 使用 `token` | 标准能力。连接地址是浏览器目标；不修改后端 `external-controller`。[路由与认证][server] |
| 记住连接、断开控制面板、体验演示 | 浏览器状态与存储 | 不停止内核，不关闭代理连接。演示必须明确标记，不能假冒后端操作成功。 |
| 首页流量、内存、连接数 | WS `/traffic`、`/memory`、`/connections` | 标准能力。空连接可能为 `null`，需要归一化；实时状态必须来自流是否可用。[流与连接][server] [连接实现][connections] |
| 刷新首页／代理／provider／规则 | 再次执行相应 GET | 只是重读状态，不是重载配置、更新订阅或清空数据。 |
| 规则／全局／直连模式 | `PATCH /configs`，`{"mode":"rule"}` 等 | 是内核路由模式，不是系统代理状态，也不表示已接管设备全部流量。[配置处理][configs] |
| Selector 节点选择 | `PUT /proxies/{group}`，`{"name":"节点名"}` | 标准能力。`now` 是组的当前节点；组可嵌套，不能将任意首个组称为设备唯一“当前代理”。[代理处理][proxies] |
| URLTest／Fallback 手动选择 | 同上；`DELETE /proxies/{group}` 恢复自动 | 初版只开放 Selector，遗漏了已存在的能力。`fixed` 表示手动指定，`now` 是内核当前采用的节点；故障时二者不一定相同。LoadBalance 没有这项承诺。[代理处理][proxies] [URLTest][urltest] [Fallback][fallback] |
| 组延迟测试 | `GET /group/{group}/delay?url=…&timeout=5000` | 标准能力。自动组的此接口会清除手动指定；URLTest 实现使用组配置的测试 URL。应正确说明副作用，不能称作纯只读刷新。[组处理][groups] [URLTest][urltest] |
| 节点搜索、排序、代理组折叠 | 浏览器呈现 | 不需要 Mihomo 为每个 UI 操作提供接口。 |
| 初版“订阅”列表、用量、更新时间 | `GET /providers/proxies` | 实际是**代理提供者／代理集合**；包含 HTTP、File、Inline、Compatible 等，不全是付费订阅，配额可缺失。不能等同于 Verge 配置订阅列表。[provider 路由][providers] [provider 数据][proxy-provider] |
| provider 更新 | `PUT /providers/proxies/{name}`，无请求体 | 更新已声明的 provider，不新增、不删除、不更改订阅地址。Inline 更新只是更新时间；Compatible 没有远程订阅更新。[provider 路由][providers] [provider 数据][proxy-provider] |
| provider 健康检查 | `GET /providers/proxies/{name}/healthcheck` | 标准能力；使用内核 provider 健康检查配置，结果从节点状态重读。[provider 路由][providers] |
| 连接详情、关闭单条、关闭全部 | `GET/WS /connections`；`DELETE /connections/{id}`；`DELETE /connections` | 标准能力。关闭针对内核正在跟踪的连接，不是删除历史记录。[连接实现][connections] |
| 规则列表、类型筛选、分页 | `GET /rules` + 浏览器筛选 | 标准能力；`size: -1` 表示无子规则计数，不应显示为负数。新版 `extra` 可描述禁用与命中信息。[规则处理][rules] |
| 日志级别筛选、暂停显示、清空、跟随最新 | WS `/logs?level=debug` + 浏览器缓冲 | 当前清空与暂停只是页面行为。API 流从订阅时开始，不提供历史文件读取或删除后端日志的能力。[日志处理][server] |
| 外观主题与跟随系统 | 浏览器偏好 | 属于 WebUI，不属于内核设置。 |
| 允许局域网、混合端口 | `PATCH /configs`，`{"allow-lan":true}`、`{"mixed-port":7890}` | 作用于运行内核的主机监听器，不替用户开放防火墙，也不设置系统代理。[配置处理][configs] |
| IPv6 | `PATCH /configs`，`{"ipv6":true}` | 确实实现为 `resolver.DisableIPv6 = !value`；作用于内核解析／出站决策，不修改操作系统网卡 IPv6，也不等同于整个 `dns` 配置编辑。[配置处理][configs] [解析器][resolver] |
| 日志级别 | `PATCH /configs`，`{"log-level":"info"}` | 支持 `debug/info/warning/error/silent`，与日志页面的显示过滤分开。[配置处理][configs] |
| TUN | `PATCH /configs`，`{"tun":{"enable":true}}` | 标准运行设置。内核需要已有权限与有效 TUN 配置；WebUI 不能安装服务或提权。修改其他 TUN 字段时也需显式保留 `enable`，因为该字段在 PATCH schema 中不是可选指针。[配置处理][configs] |
| 粘贴 YAML 后“重新加载” | `PUT /configs?force=true`，`{"payload":"完整 YAML"}` | 是**加载完整运行配置**，不是持久保存文件、订阅导入或增量合并。`GET /configs` 无法导出等价完整 YAML。应明确可能改变监听与路由。[配置处理][configs] [配置应用][executor] |

代理元数据必须同时消费 `/proxies` 与 `/providers/proxies`：provider 内节点通常不出现在前者的顶层映射里。否则正常的 `use: [provider]` 组会显示“未知协议／未测试”，测速排序也无法工作。[配置解析][config] [provider 路由][providers]

## 配置接口的真实范围

`GET /configs` 返回 `executor.GetGeneral()` 的运行配置摘要，含 `mode`、端口、TUN、LAN 参数、IPv6、日志级别、`tcp-concurrent`、`find-process-mode`、`sniffing`、`interface-name`、`routing-mark`、`unified-delay`、geodata 与 keep-alive 等字段。它不返回完整 `proxies`、`proxy-groups`、`rules`、`dns`、原始 YAML 或控制器 Secret；`external-controller` 也不是这里的 `General` 字段。[类型定义][config] [读取实现][executor]

读取类型与修改类型应分开，例如 `MihomoConfig` 和 `MihomoConfigPatch`。不应使用 `Partial<MihomoConfig>` 声称所有读回字段都能 PATCH。

| 字段 | GET /configs | PATCH /configs | 备注 |
| --- | --- | --- | --- |
| `mode`、`log-level`、`ipv6`、`allow-lan`、`bind-address` | 支持 | 支持 | 已有初版基础设置可保留 |
| `port`、`socks-port`、`mixed-port`、`redir-port`、`tproxy-port` | 支持 | 支持 | 后两者的平台支持不同，不能在所有后端上暗示可用 |
| `tun`、`tuic-server`、`ss-config`、`vmess-config` | 支持 | 支持 | 基础迁移优先 TUN；不必一次暴露所有服务监听器 |
| `tcp-concurrent`、`find-process-mode`、`interface-name`、`sniffing` | 支持 | 支持 | 可补齐为内核运行设置；`find-process-mode` 使用 `always/strict/off` |
| `skip-auth-prefixes`、`lan-allowed-ips`、`lan-disallowed-ips` | 支持 | 支持 | 有明确网络访问语义，属于高级设置 |
| `unified-delay`、`routing-mark`、geodata 调度/URL、keep-alive、`global-ua`、`etag-support`、`authentication` | 支持 | **本基准 PATCH 不应用** | 不能因 GET 中出现就加可写开关 |
| 完整 `dns`、`proxies`、`proxy-providers`、`rules` | 不通过此摘要返回 | 不支持这些字段的 PATCH | 需要完整配置管理；不要从摘要拼出覆盖整个配置的 YAML |
| `external-controller`、`secret`、系统代理、开机启动 | 不通过此摘要返回 | 不支持 | 浏览器连接表单只是客户端目标配置 |

`PATCH /configs` 的 204 不保证监听器已经启动成功：TUN 权限不足、端口占用等错误由 `ReCreateTun`／`ReCreateMixed` 记录日志，处理函数仍返回 204。应重读 GET，至少核对本次提交的 `tun.enable`、端口及标量设置；只在确认实际状态后显示成功。TUN 启动失败会将实际配置的 `enable` 复位为 false。[配置处理][configs] [监听器实现][listener]

`PUT /configs` 还支持 `{"path":"后端允许访问的绝对路径"}`，以及 `{}` 重新读取启动配置路径。路径属于内核主机，受 safe-path 限制；浏览器选择的本地文件路径不能直接作为该参数。此操作没有写配置文件的步骤。[配置处理][configs]

## 优先补齐的标准能力

| 建议顺序 | 功能 | 精确接口与数据 | 限制与状态处理 |
| --- | --- | --- | --- |
| 1 | 规则提供者列表与更新 | `GET /providers/rules` → `{providers:{[name]:{name,type,vehicleType,behavior,format?,ruleCount,updatedAt,payload?}}}`；`PUT /providers/rules/{name}`，无请求体 | 更新已有 rule provider；不提供规则文件通用 CRUD。HTTP/File 有实际载入源，Inline 没有远程更新。[路由][providers] [数据结构][rule-provider] |
| 1 | URLTest／Fallback 手动选择与恢复自动 | `PUT /proxies/{group}`，`{"name":"成员名"}`；`DELETE /proxies/{group}`，无请求体 | 返回 `now/fixed` 后再呈现；不要向不支持的组承诺这项能力。[代理处理][proxies] |
| 1 | 独立节点测速 | 顶层节点：`GET /proxies/{name}/delay?url=…&timeout=5000`；provider 节点：`GET /providers/proxies/{provider}/{name}/healthcheck?url=…&timeout=5000`；可加 `expected=204` | 都返回 `{delay:number}`；provider 路径不可简写成顶层 `/proxies/{name}`。该实现单节点 timeout 解析为有符号 16 位整数，UI 应采用合理正数，如 5000。[节点路由][proxies] [provider 路由][providers] |
| 2 | DNS 查询 | `GET /dns/query?name=example.com&type=A`，无请求体；type 默认 A，可选 AAAA/CNAME 等大写类型 | 返回 `Status/Question` 与可选 `Answer/Authority/Additional`。DNS 未启用时返回 500 和明确错误；不能解释成控制器离线。[DNS][dns] |
| 2 | 清理 DNS 缓存 | `POST /cache/dns/flush`，无请求体，204 | 清理内核解析器缓存，不是操作系统 DNS 缓存。[缓存][cache] |
| 2 | 清理 Fake-IP 映射 | `POST /cache/fakeip/flush`，无请求体；成功 204，失败 400 | 属于维护动作，UI 应明确会清理内核映射，并呈现真实错误。[缓存][cache] |
| 2 | Geodata 更新 | `POST /configs/geo`，无请求体；`POST /upgrade/geo` 是同一处理函数的入口 | 下载／更新内核配置使用的数据文件，可能耗时；不能叫“更新订阅”，也不是任意 provider 更新。[配置路由][configs] [更新路由][upgrade] |
| 3 | 规则命中统计与临时启停 | `GET /rules` 的 `index/extra`；`PATCH /rules/disable`，`{"0":true,"3":false}` | true 表示禁用，索引从 0 开始；只对 RuleWrapper 生效。应以返回 `extra` 能力为前提，不能对普通规则一律加开关；重载后索引可能改变。[规则处理][rules] |

以下标准 API 确实存在，但不应为了“补齐”而默认加入初版常用操作：

| 能力 | 接口 | 边界 |
| --- | --- | --- |
| 重启内核进程 | `POST /restart`，无请求体 | 响应 `{status:"ok"}` 后重启进程，控制面板会短暂失联；不能承诺重新安装／修复系统服务。[重启实现][restart] |
| 升级内核 | `POST /upgrade?channel=…&force=true`，无请求体 | 由后端 updater 下载替换可执行文件并重启；涉及当前部署和权限，属于显式高级维护，不是 Verge 桌面应用更新。[升级实现][upgrade] |
| 更新后端托管 UI | `POST /upgrade/ui`，无请求体 | 使用后端已有 UI updater 配置；可能替换当前托管的 WebUI，不应默认解释为升级本项目。[升级实现][upgrade] |
| 后端通用 JSON 存储 | `GET/PUT/DELETE /storage/{key}`；PUT body 为任意有效 JSON，最大 1 MiB；未保存 GET 返回 `null` | 可用于有命名空间的 UI 数据，但不是后端 profile、YAML 文件或订阅管理 API，没有列出全部 key 的路由。旧内核可能没有此接口。[存储实现][storage] |

当前源码的 embed mode 不注册配置 PATCH/PUT、Geodata 更新、规则禁用、restart、core upgrade 等部分写接口。不能用 `meta: true` 推定全部可写功能都可用；新增可选能力必须能处理 404/405 和明确的后端错误，不能通过试改设置来探测支持情况。[主路由][server] [配置路由][configs] [规则路由][rules] [更新路由][upgrade]

## Verge 基础体验的浏览器迁移范围

| 功能 | WebUI 可做的部分 | 原生／额外服务边界 | 参考代码 |
| --- | --- | --- | --- |
| 配置订阅管理 | 浏览器本地配置库、用户选择 YAML 文件、下载浏览器保存的原始内容、加载所选完整配置；直接抓取 URL 受 CORS 限制 | Verge 等价的后端 profile CRUD、文件写入、独立后台更新计划不由 provider API 提供 | [Verge commands](../clash-verge-rev-dev/src/services/cmds.ts)、[profile backend](../clash-verge-rev-dev/src-tauri/src/cmd/profile.rs) |
| 最近关闭的连接 | 对 WS 快照差分，保留本次监控中消失的连接；可限 500 条 | 无标准 API 回溯连接前的历史；不能把断线时整批消失的快照直接称为已确认关闭 | [Verge connection state](../clash-verge-rev-dev/src/hooks/use-connection-data.ts) |
| 单连接速率、排序与列设置 | 根据累计 upload/download 与采样时间差计算速率；浏览器排序、列宽与显隐偏好 | 进程名/IP 等来自内核实际提供的数据，不保证每个平台都有进程详情 | [Verge connection table](../clash-verge-rev-dev/src/components/connection/connection-table.tsx) |
| 日志体验 | 保留已接收日志、过滤、暂停、导出本地缓冲 | Verge 的 `get_clash_logs` 读取原生 service/sidecar 日志，不是 Mihomo 历史日志 API | [Verge log state](../clash-verge-rev-dev/src/hooks/use-log-data.ts)、[commands](../clash-verge-rev-dev/src/services/cmds.ts) |
| 外观与布局 | 主题、语言、字体、密度、图表／列显示、页面内快捷键 | 原生窗口透明度、标题栏、系统级窗口控制不属于浏览器界面 | [Verge basic preferences](../clash-verge-rev-dev/src/components/setting/setting-verge-basic.tsx) |
| 备份与恢复 | 明确范围的浏览器偏好和浏览器保存的配置导入导出 | Verge 全目录 ZIP、服务端文件恢复、后台 WebDAV 定时备份需要对应服务 | [Verge backup](../clash-verge-rev-dev/src-tauri/src/core/backup.rs) |
| 系统代理、开机启动、系统服务、托盘、全局快捷键 | 可给用户说明或提供外部配置链接 | 普通 WebUI 不能修改 OS 系统代理、安装驱动／服务、申请提权、管理托盘或注册全局快捷键 | [system proxy](../clash-verge-rev-dev/src-tauri/src/core/sysopt.rs)、[autostart](../clash-verge-rev-dev/src-tauri/src/core/autostart.rs)、[service installer](../clash-verge-rev-dev/src/hooks/use-service-installer.ts)、[hotkeys](../clash-verge-rev-dev/src-tauri/src/core/hotkey.rs) |

基础迁移应先做到名称与真实作用一致，再补规则提供者、完整节点操作、连接历史／速率和实用内核设置。原生能力不要保留失效的仿制按钮；浏览器能力则可以直接实现，不需要虚构内核接口。

[server]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/server.go
[configs]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/configs.go
[config]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/config/config.go
[executor]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/executor/executor.go
[listener]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/listener/listener.go
[resolver]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/component/resolver/resolver.go
[proxies]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/proxies.go
[groups]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/groups.go
[urltest]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outboundgroup/urltest.go
[fallback]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outboundgroup/fallback.go
[providers]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/provider.go
[proxy-provider]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/provider/provider.go
[rule-provider]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/rules/provider/provider.go
[connections]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/connections.go
[rules]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/rules.go
[dns]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/dns.go
[cache]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/cache.go
[restart]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/restart.go
[upgrade]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/upgrade.go
[storage]: https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/hub/route/storage.go
