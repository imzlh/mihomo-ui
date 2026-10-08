# Clash Verge Rev → Mihomo WebUI 迁移核查

核查依据是工作区中的 `clash-verge-rev-dev/` 源码、根目录的 [`api.md`](../api.md)，以及本项目页面的实际实现。这里区分三个对象：运行 Mihomo 的主机、打开 WebUI 的浏览器、Clash Verge 的本地配置管理器。三者不能互相冒充。

以下“初版缺口”记录初版页面，不代表当前状态。已完成的首页修正和后续迁移进度单列在文末；其他页面的缺口应以实际后续实现为准。

## 首页：逐卡片、逐控制核查

参考首页 `src/pages/home.tsx` 默认提供订阅、当前代理、网络设置、模式、流量、测试、IP、核心信息、系统信息九类卡片。

| 可见内容 / 控制               | 原版来源与行为                                                                                                                        | 标准 Mihomo / 浏览器的正确对应                                                                                                                              | 初版 WebUI 缺口                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 首页卡片显示设置              | `HomeSettingsDialog` 将 `home_cards` 写入 `patchVerge`                                                                                | 浏览器本地偏好；不需要内核 API                                                                                                                              | 未提供卡片显示开关                                                           |
| 轻量模式按钮                  | `entry_lightweight_mode()` 调整桌面应用运行状态                                                                                       | 没有等价桌面窗口/进程控制；页面可自行减少渲染                                                                                                               | 不应伪造同名桌面轻量模式                                                     |
| 当前代理：选择代理组          | `CurrentProxyCard` 读取 `proxyView`，规则模式提供组下拉，并按当前 profile UID 保存选择；全局固定 GLOBAL，直连使用 DIRECT              | `GET /proxies` 的组；规则模式只是在页面关注某个组，不存在唯一“当前代理”                                                                                     | 直接取第一个 Selector，遗漏组选择且暗示整个内核共用一个节点                  |
| 当前代理：选择组成员          | `handleProxyChange → useProxySelection → selectNodeForGroup`；还处理 fixed/pinned 状态与原版配置持久化                                | `PUT /proxies/{group}`，数据 `{name}`；URLTest/Fallback 可固定成员，`DELETE /proxies/{group}` 解除固定                                                      | 首页只有跳转按钮；代理页最初仅允许 Selector，自动组操作遗漏                  |
| 当前代理：多层组              | 原版 `findCurrentGroupMember / resolveMember / memberDetails` 区分组、provider 节点和未解析成员                                       | 逐层跟随 `now`，检测循环；LoadBalance 没有统一 `now`，实际出口看各连接 `chains` / `providerChains`                                                          | 只解析一层，组名被显示为节点名；直连模式仍可能显示其他组                     |
| 当前代理：延迟与信号          | `delayManager.getDelayFix`、`useGroupDelays`；区别未测、测试中、超时、错误、高低延迟                                                  | 展示内核 `history`，不要计量控制器 HTTP 往返时间；节点/provider 身份必须正确                                                                                | 首页仅显示一个 history 值，0 被当作“未测试”，所有正数都显示好延迟            |
| 当前代理：手动单节点测速      | `checkCurrentProxyDelay → delayManager.checkDelay`，遵循所选组 URL、超时                                                              | 普通节点 `GET /proxies/{name}/delay?url=&timeout=&expected=`；provider 节点 `GET /providers/proxies/{provider}/{name}/healthcheck?url=&timeout=`            | 首页没有测速操作；provider 节点不能一律走普通节点接口                        |
| 当前代理：全组测速            | `handleCheckDelay` 对可交互成员批量检查，排除 DIRECT/REJECT                                                                           | 可逐节点检查；`GET /group/{group}/delay` 也支持，但文档明确其会清除自动组的固定选择，交互必须体现这一副作用                                                 | 初版组测速没有说明自动组 pin 会被清除                                        |
| 当前代理：自动测速            | 原版 `enable_auto_delay_detection` 和间隔设置，默认间隔 5 分钟，首次延后 100ms                                                        | 页面可调度内核测速，但不是浏览器 ping，离开页面需停止，并遵守 provider 路由                                                                                 | 未实现                                                                       |
| 当前代理：排序与记忆          | 原版默认/延迟/名称排序；组偏好按 profile UID 保存                                                                                     | 排序属于 UI；WebUI 无原版 profile UID，应按控制器 URL 保存页面偏好                                                                                          | 首页未提供；代理页已有三种排序                                               |
| 当前订阅：名称与来源          | `HomeProfileCard` 接收 `useProfiles().current`，包含 uid/type/url/home/desc/file；标题可打开订阅主页                                  | 标准 API 没有 Clash Verge 的当前 profile、主页或源 URL 管理模型                                                                                             | 初版拿首个 proxy provider 冒充“当前订阅”；provider 不是完整配置              |
| 当前订阅：更新时间与刷新      | `updateProfile(current.uid,current.option)` 重新下载 profile，随后 `refreshAll`                                                       | provider 更新为 `PUT /providers/proxies/{name}`，只更新代理集合，不切换/重载完整订阅配置                                                                    | 首页缺更新操作，且应明确更新对象是代理集                                     |
| 当前订阅：用量与到期          | 原版 `current.extra.upload/download/total/expire`                                                                                     | provider 若返回 `subscriptionInfo.Upload/Download/Total/Expire` 可显示；未返回就明确未知                                                                    | 初版无到期信息；无配额仍绘制空进度条，容易被理解为剩余 100%                  |
| 当前订阅：导入空状态          | 点击导入进入 `/profile`，由 Tauri 下载并管理文件                                                                                      | 可另做浏览器文件上传 + `PUT /configs?force=true`，但不等于托管 profiles；需要独立产品定义                                                                   | 不能将“无 provider”解释为没有配置，更不能伪造订阅导入按钮                    |
| 网络：系统代理开关            | `ProxyTunCard → ProxyControlSwitches → useSystemProxyState`，`get_sys_proxy/get_auto_proxy` 读取 OS 实际状态，`patchVergeConfig` 修改 | 标准 API 不读写操作系统代理/PAC；浏览器也无法判断系统代理是否开启                                                                                           | 应省略这一桌面控制；`allow-lan`、mode、TUN 都不能当其替身                    |
| 网络：系统代理设置            | `SysproxyViewer`、本地 PAC server、proxy_host/bypass 等                                                                               | 没有对应标准 API                                                                                                                                            | 不移植为有效控制                                                             |
| 网络：TUN 开关                | 原版写 `enable_tun_mode`，并通过 Rust `RunState.tunCapable` 判定管理员/服务条件，必要时安装服务                                       | `PATCH /configs` 的 `tun.enable` 可修改内核配置；需要主机权限，但 API 不提供原版服务安装/管理员检测                                                         | 现有开关仅当 `tun` 存在时启用；不能据此声称 WebUI 已取得系统权限             |
| 网络：TUN 详情                | 原版 `TunViewer` 展示 stack 等参数                                                                                                    | 仅暴露内核支持的运行字段；读回配置确认，不能把任意 GET 字段原样写回                                                                                         | 初版仅显示开关/stack；其他设置未提供                                         |
| 模式：规则 / 全局 / 直连      | `ClashModeCard` 读 controller 配置，原版有本地保存状态回退；调用 `patchClashMode`，同步缓存与托盘                                     | `GET /configs`、`PATCH /configs {mode}`；WebUI 不应使用本地假状态冒充后端结果                                                                               | 三模式已有；“全局=所有请求经过代理”不严谨，GLOBAL 本身可以选择 DIRECT/REJECT |
| 流量：上下行速率              | `EnhancedTrafficStats → useTrafficData`                                                                                               | `/traffic` 的 up/down，单位 bytes/s                                                                                                                         | 已实现                                                                       |
| 流量：累计上下行              | 原版从 traffic.upTotal/downTotal 读取                                                                                                 | `/traffic` 的 upTotal/downTotal 或 `/connections` 的 uploadTotal/downloadTotal                                                                              | 初版从 connections 读取；应标为内核累计，不能用它推断 uptime                 |
| 流量：连接数                  | 原版 `useConnectionSummaryData` 的 activeConnectionCount                                                                              | `/connections` 快照 connections 数量；空列表可能为 null                                                                                                     | 已实现，并已处理 null                                                        |
| 流量：内存                    | 原版 `useMemoryData`，有隐藏内存偏好                                                                                                  | `/memory` 的 inuse；oslimit 文档注明始终 0，不能拿来算内存百分比                                                                                            | 内存值已实现；无显示开关                                                     |
| 流量：图表与样式              | 原版可点击图表切换样式，页面不可见时停渲染                                                                                            | 浏览器本地可实现，数据仍由内核流提供                                                                                                                        | 已有最近 60 秒图和悬浮值；未提供图表样式切换                                 |
| 核心信息：版本/端口/规则数    | `ClashInfoCard → useClash/useDisplayedMixedPort/useRulesData`                                                                         | `/version`、`/configs`、`/rules`                                                                                                                            | 版本与 mixed-port 已有，首页缺规则数量                                       |
| 核心信息：系统代理地址        | 原版 `useSystemData().systemProxyAddress` 来源为宿主系统                                                                              | 无标准接口；controller URL、bind-address、mixed-port 均不是 OS 系统代理地址                                                                                 | 不应显示猜测地址                                                             |
| 核心信息：运行时长            | 原版 `useAppUptime → getAppUptime → invoke('get_app_uptime')`，实为桌面 app uptime                                                    | 给定 API 没有该 app uptime；浏览器会话时长必须另命名                                                                                                        | 不应编造“内核运行时长”                                                       |
| 系统信息：操作系统            | `SystemInfoCard → getSystemInfo → invoke('get_system_info')`                                                                          | 没有标准 Mihomo 主机 OS 查询；navigator 只描述浏览器所在设备                                                                                                | 不用浏览器平台冒充远程内核主机                                               |
| 系统信息：自启动              | `patchVerge({enable_auto_launch})`                                                                                                    | 无标准 API；浏览器不能设置宿主系统启动项                                                                                                                    | 不移植为有效控制                                                             |
| 系统信息：服务/管理员状态     | `useSystemState` 读取 Rust RunState，点击可 `installServiceAndRestartCore`                                                            | 无等价服务管理接口；API 可重启内核，但不等于安装 OS 服务                                                                                                    | 不显示虚构的服务或管理员徽章                                                 |
| 系统信息：检查更新/App 版本   | `useUpdate` 检查 Clash Verge 桌面更新；package.json 是 GUI 版本                                                                       | WebUI 版本可显示自身构建版本；Mihomo `/upgrade`、`/upgrade/ui` 分别更新内核/面板，并非桌面 GUI updater                                                      | 初版无更新控制；不能把 WebUI 版本当 Mihomo 版本                              |
| 连通性测试：站点卡片/全部测试 | `TestCard → TestItem → cmdTestDelay(url) → Rust feat::test_delay`                                                                     | 原实现 HTTPS 测 TLS 握手，HTTP 测 HEAD 往返；开启系统代理/TUN 时经桌面本机 mixed-port，否则本机直连。标准节点 delay 可做“内核指定出口 URL 测试”，但含义不同 | 未实现；禁止浏览器 fetch 后标作“内核节点延迟”                                |
| 连通性测试：增删编辑/拖动排序 | `TestViewer` 与 `useVerge` 存储 test_list，图标缓存由 native 处理                                                                     | 测试目标偏好和排序可存浏览器；网络测试方法与 CORS 边界仍需明确                                                                                              | 未实现；并非所有细节都需要 native                                            |
| IP 信息：IP/地区/ASN/运营商   | `IpInfoCard → getIpInfo` 使用 Tauri HTTP 请求第三方 geo-IP 服务                                                                       | 标准 Mihomo API 没有返回代理出口公网 IP 的接口；`/dns/query` 仅 DNS。浏览器第三方 fetch 得到浏览器路径的 IP，不能代表远端内核/任意节点                      | 未实现；不能显示虚假的“内核出口 IP”                                          |
| IP 信息：隐藏/刷新/倒计时     | 原版默认隐藏 IP，手动刷新与 300 秒自动刷新，结合窗口可见性                                                                            | 这些 UI 能移植，但必须先明确测量对象及服务 CORS；不能把浏览器限制理解为内核离线                                                                             | 未实现                                                                       |

## 其他页面与细节

| 页面 / 控制                  | 原版方法或组件                                                                                        | 标准 API 范围                                                                                            | 初版 WebUI 状态 / 缺口                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 代理组、折叠、搜索、排序     | `ProxyGroups`、`use-filter-sort`、`ProxyItem`                                                         | 组 `all/now/type/history`；UI 控制本地实现                                                               | 已有基础交互；hidden/icon、更多协议标志、自动组 pin 等细节缺失                             |
| Provider 节点身份            | 原版 `proxyView` 通过 recordId/provider 区分同名节点                                                  | provider-name 和 provider 专用节点接口；不能只按 name 盲目归并                                           | 根状态初版合并 Record 会覆盖同名节点；多 provider 同名需要谨慎解析，不明确时不发错测速请求 |
| 切换后关闭旧连接             | `useProxySelection.cleanupConnections` 按旧代理筛 connections.chains                                  | `GET /connections` + `DELETE /connections/{id}` 可实现；须为明确用户偏好                                 | 未实现                                                                                     |
| 代理链编辑                   | `proxy-chain` 与 `updateProxyChainConfigInRuntime` 修改原版生成的完整配置                             | API 能读取 dialer-proxy/连接链，但没有同名链编辑 CRUD；可基于完整配置重载另行实现                        | 未实现，不能把组选择当作任意代理链编辑                                                     |
| 代理集合弹窗                 | `components/proxy/provider-button.tsx`                                                                | `/providers/proxies`、更新、整集健康检查、单节点详情/测速                                                | 基础代理集管理已有；最初把所有非 Compatible（包括 File）都叫订阅                           |
| Profiles 新建/导入/拖放/删除 | `pages/profiles.tsx` 的 createProfile/importProfile/deleteProfile/reorderProfile，Tauri 文件和剪贴板  | 没有等价 profile CRUD；浏览器文件选择/剪贴板可实现，远端配置托管不由这些能力自动提供                     | 当前 providers 页不是原版 profiles 页的完整迁移                                            |
| Profiles 切换/合并/脚本/编辑 | `useProfiles`、enhanceProfiles、getRuntimeLogs、ConfigViewer                                          | `PUT /configs?force=true` 接受完整 payload/path；`GET /configs` 只读基本运行配置，不是完整原始 YAML 导出 | Settings 有完整 YAML 重载；无 profile 持久化、合并和脚本管理                               |
| 连接：活动/关闭标签          | `useConnectionData` 保存已消失连接的历史；`connections.tsx` 提供 active/closed 切换                   | API 仅返回当前连接；关闭历史可在浏览器会话内推导，无法恢复接入前历史                                     | 初版仅活动连接                                                                             |
| 连接：速度/总量/链路/进程    | 原版 connection-row-view、ConnectionDetail；速度通过快照差分计算                                      | `/connections` 提供累计量、metadata、chains/providerChains；速度需除以实际采样间隔，process 可能缺失     | 详情与总量已提供；初版每连接速度、provider 链不完整                                        |
| 连接：关闭单个/全部          | closeConnection/closeAllConnections                                                                   | DELETE 标准接口                                                                                          | 已实现，演示不触达真实后端                                                                 |
| 连接：表格/列表、列管理      | ConnectionTable、ConnectionRowItem、列选择弹窗                                                        | 全部为浏览器本地展示偏好                                                                                 | 初版只有表格和展开详情，无列管理                                                           |
| 规则：查找/显示匹配顺序      | RuleItem、BaseSearchBox、虚拟列表                                                                     | `GET /rules`；排序只能改变展示，不能改变内核实际规则顺序                                                 | 已有搜索/筛选/分页/排序，需保留原始索引语义                                                |
| 规则集：查看与更新           | `components/rule/provider-button.tsx`                                                                 | `GET /providers/rules`、`PUT /providers/rules/{name}`                                                    | 初版遗漏                                                                                   |
| 规则：停用与命中数据         | 给定 api.md 的新增能力                                                                                | `PATCH /rules/disable` 按索引操作，重启复位；extra 命中数据仅存在时展示                                  | 初版遗漏；不能声称规则只可查看                                                             |
| 日志：级别/暂停/清空/排序    | `pages/logs.tsx`、useLogData/useClashLog                                                              | `/logs` 实时流；客户端可筛选/暂停显示/清空本地缓存；无标准“删除内核日志文件”API                          | 已有搜索、级别、暂停与清空；需要明确暂停/清空对象                                          |
| 日志：历史文件               | `getClashLogs → invoke('get_clash_logs')` 读取桌面日志                                                | 实时 API 不等于磁盘历史查询                                                                              | 不声称已获取连接前历史                                                                     |
| 流媒体解锁测试               | `pages/unlock.tsx` 调 checkMediaUnlock/checkMediaUnlockItem/getUnlockItems，通过 Tauri Channel 推进度 | 给定 API 没有 Netflix/Disney/OpenAI 解锁检测协议；普通 URL delay 不等于解锁结果                          | 未提供，比返回猜测的地区/解锁状态正确                                                      |

## Settings：已有、可补全与不可替代

核查时 `src/pages/Settings.tsx` 已有后端连接、主题、allow-lan、IPv6、日志级别、mixed-port、TUN 开关及完整 YAML 重载。它没有原版设置项的完整覆盖。

| 设置项                                                                    | 能力来源                                                 | 应有语义                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| HTTP/SOCKS/重定向/TProxy 端口、绑定地址、TCP 并发、进程匹配、嗅探等运行项 | 经版本确认的 `PATCH /configs` 字段                       | 保存后读回；GET 出现某字段不代表可直接 PATCH 任意字段                          |
| 修改完整运行配置                                                          | `PUT /configs?force=true` 的 payload/path                | 不是“保存 Clash Verge profile”；路径属于运行 Mihomo 的主机，受 SAFE_PATHS 限制 |
| 重启内核                                                                  | `POST /restart`                                          | 标准 API 确实支持；不同于桌面服务监督/安装                                     |
| 升级内核                                                                  | `POST /upgrade`，可选 channel/force                      | 标准 API 确实支持；不是原版原子替换二进制流程，也不能操作不存在的桌面核心列表  |
| 更新面板/地理库                                                           | `POST /upgrade/ui`、`POST /upgrade/geo` / `/configs/geo` | 使用内核的 external-ui/地理库配置；应反馈真实后端结果                          |
| 清理 DNS/Fake-IP 缓存                                                     | `POST /cache/dns/flush`、`POST /cache/fakeip/flush`      | 标准能力，应可提供明确操作                                                     |
| DNS 查询                                                                  | `GET /dns/query?name=&type=`                             | 核心 DNS 回答，不是公网 IP 查询/完整 DNS 配置编辑                              |
| 通用存储                                                                  | `/storage/{key}` GET/PUT/DELETE                          | 保存任意 JSON 的通用能力，不会自动提供 profile 导入、合并、计划更新等工作流    |
| 系统代理/PAC、服务安装、自启动、热键、托盘、桌面备份/WebDAV               | 原版 Tauri/插件/宿主服务                                 | 不由标准 Mihomo API 提供，不能显示为已实现的控制                               |

## 前一轮首页已实现的修正

`src/pages/Home.tsx` 已将“当前代理”修正为“代理组出口”，补上按后端保存的组选择、组成员控制、自动组固定/恢复、递归出口解析及内核测速。规则模式明确一个组只影响匹配到它的请求；全局模式使用 GLOBAL；直连模式显示 DIRECT；LoadBalance、循环引用、未解析节点显示真实未知状态。Provider 身份明确时使用对应专用测速接口；没有声明来源且多个集合存在同名节点时不猜测测速对象。

“订阅概况”已修正为“代理集”，选择只切换正在查看的集合，不切换内核订阅。显示集合类型、节点数量、已提供的用量/到期/更新时间，并执行集合更新。没有数据时不绘制虚假的配额或订阅状态。

核心信息已补上规则与代理组数量，并保持 TUN 是运行内核主机配置的含义。UI 不虚构系统代理、服务状态、主机 OS、公网出口 IP 或 uptime。没有标准对应的能力保留为明确迁移边界；有标准接口但尚未实现的功能记作缺口，不能归为“不支持”。

## 2026-10-08：继续迁移首页与代理切换体验

- 首页新增卡片显示设置和独立内存开关，流量图支持面积/折线样式。隐藏卡片后可以从首页设置恢复。偏好按控制器 URL 保存在浏览器，演示模式单独保存；不包含 Secret。
- 首页代理组成员新增默认、延迟、名称排序；延迟排序将未测、超时放在有效延迟之后，保留原始成员顺序作为同延迟的排序依据。
- 当前出口自动测速默认关闭、间隔默认 5 分钟。开启后首次延后约 100ms，后续在上一轮完成后计时，手动与自动测试共用进行中的请求。离开首页、隐藏出口卡片、切到后台、断线或切换目标时取消旧请求并丢弃旧结果。演示模式不请求真实后端；不使用会清除自动组固定选择的组测速接口。
- 代理页新增默认关闭的“切换后关闭旧连接”，首页手动切换同样遵循该偏好。开启后，先读取该组当前成员及连接快照，切换成功才关闭旧快照中 `chains` 包含相邻 `[旧成员, 该组]` 的连接。不会关闭其他组共用节点的连接、切换后新建连接，或因重复固定同一成员而关闭连接。读取失败仍允许切换，清理失败单独提示；恢复自动和整组测速不触发这项清理。
- 根状态只补入名称唯一的 provider 节点，保留 `/proxies` 返回的节点身份；多个 provider 的同名节点不再按列表顺序覆盖。资源页仍可选择具体代理集查看和测速。
- 代理页节点改为接近原版的 56px 紧凑布局，延迟使用 14px 纯数字和三点等待动画，恢复原版颜色阈值、`Timeout` / `Error` 状态。单节点与整组测速期间都显示等待，预设 DIRECT/REJECT 等不显示测速按钮；单节点测试遵循所在组的目标 URL 和预期状态码。
- 延迟排序按有效数值、超时、错误、测试中、未测试分层，同状态保留原始顺序。选中标记仅在未测时占用延迟位置，测试中和有结果时让位给等待动画与数值。测速进行状态与结果按控制器会话保存，离页返回继续展示，不重复发起同一节点的测试。

## 2026-10-08：运行设置、维护、连接与日志

- 设置页按监听与网络、连接行为、虚拟网卡分组，提供 HTTP/SOCKS/混合/Redirect/TProxy 端口、监听地址、出站接口、TCP 并发、进程匹配、嗅探及 TUN 参数。编辑弹窗保留草稿，仅提交实际改动，TUN 更新显式保留 `enable`；读回不一致时保留编辑内容并提示未生效。未返回字段显示“未提供”，不推定为关闭。
- 内核维护新增 GEO 更新、重启、内核升级和后端托管面板更新，使用无请求体的标准 POST。升级通道为跟随当前、`release`、`alpha`，强制升级需明确选择。所有写操作显示目标并经确认；同一控制器的维护请求跨页面保留锁，配置编辑/重载与维护互斥。重启和升级反馈“请求已接受”，网络中断未收到响应时保留不确定状态，不自动重发。
- 连接页新增活动/最近关闭标签、列管理和完整元数据详情。根状态只从同一有效连接流的相邻快照推导关闭记录，最多保留 500 条；断流、非法帧或重连首帧重新建立基线。记录保留最后观察到的计数与确认消失时间，不宣称知道精确关闭时刻或接入前历史。切换控制器清空会话历史，清理历史不发 DELETE。
- 日志页新增接收时间顺序、单条/选中复制和筛选结果导出。页面展示最近 500 条匹配记录，导出使用当前冻结/实时缓冲中的全部匹配记录；顺序按控制器记忆。滚离最新边缘后停止自动跟随，暂时断线仍可查看和导出缓存，切换控制器重置日志。
- 统一弹窗现在尊重调用方的关闭限制，保存期间 Esc 不会直接关闭原生 dialog；异步写操作的反馈按控制器会话隔离。

## 2026-10-08：配置库、连通性测试与偏好备份

- 新增独立配置页，浏览器库支持完整 YAML 的本地文件/URL 导入、粘贴新建、命名与说明、编辑、复制、搜索、下载和删除。解析器校验单文档映射、重复键和别名展开限制，但保存和下载均保留原文。存储失败保留草稿并明确反馈；其他标签页的新条目不会被旧列表覆盖，同一条目的编辑冲突需重新检查。
- 来源更新由用户手动发起，浏览器遵循来源站点的 CORS 限制，读取完成先进入编辑区审阅。应用保存的完整配置前显示目标控制器并确认，与运行设置和维护共用写锁。最近应用标记保存在当前连接会话中，只记录由配置库提交过的原文，不推定为内核当前配置，也不提供虚构的服务端订阅管理。
- 网络诊断新增连通性测试卡片与目标管理，可选内核节点、代理组解析出口或具体代理集节点。目标名称、HTTP(S) URL、超时和顺序按控制器保存；单项和批量测试调用对应节点接口，最多 3 项并发。取消、离页、切换出口/控制器或恢复偏好会取消请求并丢弃旧响应。测试不调用会清除固定选择的组测速接口，不代表桌面系统代理路径或流媒体解锁结果。
- 偏好备份支持本地 JSON 下载与导入，以及固定命名空间 `mihomo-verge.preferences.v1` 的后端保存、读取、删除。导入和后端读取先预览来源、目标和类别，明确恢复后才修改当前浏览器偏好。严格白名单包含主题、首页布局/组/代理集、旧连接清理开关、连接表格、日志顺序和连通性目标，不包含 Secret、YAML、连接或日志缓存。失败尽量回滚已写字段，恢复成功立即同步已挂载页面。
- 配置重载集中到统一状态方法，保留真实错误、原控制器锁和会话隔离；偏好备份通过通用 JSON 存储实现，不冒充完整配置的后端托管。演示库与实际浏览器库分离，演示操作不请求真实内核。

## 2026-10-08：显示偏好与跨页面恢复

- 连接页新增表格/列表切换，列表同时显示目标、协议、进程、速率、总量、规则与代理链。两种视图共用筛选、排序、冻结快照、历史和关闭逻辑；列表可键盘展开完整详情，窄屏自动换行。视图按控制器保存，旧存储和缺失字段默认使用表格。
- 代理组支持后端图标，HTTP(S)、图片 data URL 和原始 SVG 均通过图片元素显示，加载失败回退默认图标。新增紧凑/宽松留白与自动/2/3/4列，窄屏减少列数；保留原版 56px 节点高度、14px 延迟数字和三点等待。排序、隐藏组、展开状态和图标开关一并按控制器记忆。
- 偏好备份加入代理显示类别与连接视图，沿用版本 1 的可选类别兼容旧文件。恢复时把偏好映射到当前控制器，并立即通知页面读取；严格校验未知字段、列数、组展开值等，不改变节点选择或发送内核写请求。
- 配置库新增多文件逐项校验和导入预览、筛选结果批量选择、确认删除、完整 JSON 归档导入导出和上下移动排序。归档保留 YAML 原文及来源地址，导入生成新 ID，不复制最近应用状态或自动重载内核。写入前读取最新库，保留其他标签页新增条目；配额失败保留导入预览，并可下载选中的归档。
- 资源页单节点测速现在直接显示响应中的延迟，后续 provider history 尚未更新时不会覆盖它；进行中、失败和结果跨弹窗及页面保留，并按控制器和 provider/节点身份隔离。规则临时启停只在 `extra.disabled` 为布尔值时开放，提交后核对原索引、内容和实际状态，不再把无效 204 报成成功。托管面板更新只确认远端更新完成，不承诺刷新独立部署的当前页面会切换面板。

## 2026-10-08：配置增强与代理页布局精修

- 配置库现已支持全局和单配置 Merge/Script，以及规则、代理、代理组三类序列补丁。默认全部关闭。执行顺序对照原版 `enhance/mod.rs`、`merge.rs`、`seq.rs`：三类 Seq → 全局 Merge/Script → 配置 Merge/Script → 组引用清理。没有浏览器对应控制权的桌面 GUI 端口、TUN、DNS 覆盖阶段不隐式迁移。
- Merge 普通映射递归合并，数组、标量和 null 替换；dns 仅合并第一层、hosts 整体替换。顶层 ASCII 键名规则对齐原实现。`prepend-rules` 等不是 Merge 的特殊指令，序列修改使用独立的 prepend/append/delete 数组。代理补丁清理旧引用，新代理进入第一个 Selector；无新增时不额外去重或补造代理列表。
- 新增增强编辑器，提供各阶段开关、YAML/JavaScript 编辑、格式模板、手动预览、最终 YAML 下载、顶层改动及日志。编辑和保存不会执行脚本或写入内核；编辑内容或外部预览输入变化会使旧预览失效，取消、离页及切换控制器终止旧脚本。
- Script 在专用 Worker 中的 QuickJS 虚拟机执行，入口为 main(config, profileName)，返回 JSON 配置映射。无宿主网络、存储、DOM 或文件能力；保留有界 console 日志，执行限时 5 秒、内存 64 MiB，拒绝无效返回、循环和序列化钩子。与原版异常回退不同，本界面会明确阻止失败结果应用，保留日志供用户修正。
- 应用配置先生成最终内容，再确认目标控制器和 YAML；确认时重新核对配置名称、原文、全局及单配置增强，避免应用过期预览。原文及来源始终保留，最近应用标记在编译输入改变后失效，列表与详情保持一致。
- 归档增加可选的配置增强与全局增强，兼容旧版本 1 文件。导入不执行脚本，全局增强默认不覆盖，需单独勾选；双写失败回滚新增配置，回滚也失败时要求重新读取并检查，不允许重复提交同一预览。
- 代理组标题改为原版的名称和类型/出口两行信息块，右侧保留紧凑工具。390px 下组头约从 137px 降至 68px，工具栏从 137px 降至 74px；768px 同样保持紧凑排列，长名称、固定组和隐藏组不挤出视口。56px 节点卡片、14px 延迟及三点等待维持不变。

规则、代理和代理组的逐项可视化表单，以及代理链专用编辑仍可继续迁移；目前已提供对应序列 YAML 和 Merge/Script 的完整生成流程。系统代理、服务安装等原生能力仍不由标准 API 提供。
