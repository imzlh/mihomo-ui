# Mihomo Verge WebUI

采用 Vite、React 和严格 TypeScript 构建的浏览器控制面板，界面设计参考 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)。应用直接调用标准 Mihomo REST / WebSocket API，无需自建服务端；没有复制参考项目的源码或图片资源。

## 本地开发

需要 Node.js 22.12+ 和 pnpm 12.3.4。

```sh
pnpm install
pnpm dev
```

访问 `http://localhost:5173`，填写 Mihomo 控制器地址与 Secret。也可以进入明确标记的演示模式：演示数据在浏览器内生成，操作不会请求真实后端。

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm preview
```

构建产物位于 `dist/`。

浏览器测试使用 Playwright，自动构建并在独立的 `5179` 端口启动生产预览，不复用开发服务器；没有可用的 Chrome 时先执行 `pnpm exec playwright install chromium`，也可通过 `PLAYWRIGHT_CHROME_PATH` 指定 Chrome 路径。

## 功能与结构

- 首页：实时上下行流量、连接数、内存、模式、代理组出口和代理集详情；支持卡片显隐、面积/折线图、成员排序和当前出口自动测速，偏好按控制器保存。
- 代理：节点选择与测速、搜索排序、隐藏组、代理组图标、间距与列数偏好、URLTest/Fallback 固定节点与恢复自动；延迟采用 14px 数字和三点等待动画，可选择在手动切换后关闭该组旧成员的已有连接。
- 资源：代理集和规则集列表、更新、健康检查；代理集节点详情支持排序和单节点测速。
- 配置：浏览器配置库，支持完整 YAML 的文件/URL 导入、编辑、复制、下载、删除和确认应用；支持多文件预览、批量删除、完整归档导入导出和手动排序，保留原文与来源。
- 配置增强：全局和单配置 Merge/Script、规则/代理/代理组序列补丁，手动预览最终 YAML、阶段改动和脚本日志；保存增强不覆盖原文，应用前生成并确认结果。
- 连接：表格/列表视图、活动/最近关闭、列设置、搜索排序、冻结显示、实际速率、完整元数据与代理链；关闭历史保留在本次浏览器会话中。
- 规则：保留真实优先级的视图排序、筛选、分页、命中统计；内核返回状态时支持临时启停，重启后重置。
- 日志：实时接收、筛选、接收时间排序、暂停显示、滚动跟随、复制和导出匹配日志；暂时断线保留本地缓存。
- 网络诊断：可管理的连通性测试目标、指定内核出口的单项/批量测速、取消；另有内核 DNS 查询、DNS 记录排序、DNS/Fake-IP 缓存清理。
- 设置：控制器连接、外观、代理端口、监听/出站接口、TCP 并发、进程匹配、嗅探与 TUN 参数；修改后读回核对。
- 内核维护：GEO 更新、重启、内核升级和后端托管面板更新，执行前确认目标，保留真实结果与错误。
- 偏好备份：本地 JSON 导入导出，以及后端命名空间内的手动保存、读取和删除；恢复前预览来源、目标和类别。

`src/lib/` 定义 TypeScript 数据类型、API 客户端、格式化函数及演示数据；`src/hooks/` 处理稳定排序与采样速率，React 页面通过统一数据边界访问控制器。TanStack Query 管理服务端查询缓存，Context 管理连接状态与 WebSocket 实时数据。哈希路由支持静态服务器，Vite 使用相对资源路径，支持部署在 `/ui/` 等子目录。

接口依据用户提供的 [api.md](api.md)，细节见 [API 能力核对](docs/API-CAPABILITIES.md) 和 [Clash Verge 迁移对照](docs/MIGRATION.md)。表格排序、主题、暂停显示是浏览器功能；`PATCH /configs` 后会读取实际配置确认效果，不能仅凭 204 就认定 TUN 或端口已启动成功。

Secret 默认仅保存在当前页面会话的内存中。只有主动开启记住连接信息时才写入浏览器 `localStorage`；应仅在信任的设备上启用。

首页自动测速默认关闭，开启后默认每 5 分钟测一次当前出口，仅在首页与代理组出口卡片可见时执行；离开首页、切到后台或断线会停止。测速使用内核节点接口，不会解除自动组的固定选择。规则模式关注的组只影响匹配到它的请求。

代理页的“切换后关闭旧连接”默认关闭，开启后也适用于首页手动切换成员。它仅处理切换前经过该组旧成员的连接；切换失败不关闭连接，读取或关闭失败会单独提示。首页和代理切换偏好保存在浏览器，按控制器 URL 区分，演示模式使用独立偏好。

## 标准 API

| 功能               | 接口                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| 版本、配置、模式   | `GET /version`、`GET /configs`、`PATCH /configs`                          |
| 重新加载 YAML 配置 | `PUT /configs?force=true`                                                 |
| 节点与代理组       | `GET /proxies`、`PUT /proxies/{name}`                                     |
| 恢复自动组选择     | `DELETE /proxies/{name}`                                                  |
| 节点、组测速       | `GET /proxies/{name}/delay`、`GET /group/{name}/delay`                    |
| 代理订阅提供者     | `GET /providers/proxies`、`PUT /providers/proxies/{name}`                 |
| 提供者健康检查     | `GET /providers/proxies/{name}/healthcheck`                               |
| 集合内单节点测速   | `GET /providers/proxies/{provider}/{node}/healthcheck`                    |
| 规则集             | `GET /providers/rules`、`PUT /providers/rules/{name}`                     |
| 规则               | `GET /rules`                                                              |
| 规则临时启停       | `PATCH /rules/disable`                                                    |
| 连接管理           | `GET /connections`、`DELETE /connections/{id}`、`DELETE /connections`     |
| 实时数据           | WebSocket `/traffic`、`/memory`、`/connections`、`/logs?level=debug`      |
| DNS 查询与缓存     | `GET /dns/query`、`POST /cache/dns/flush`、`POST /cache/fakeip/flush`     |
| 内核与数据维护     | `POST /restart`、`POST /upgrade`、`POST /configs/geo`、`POST /upgrade/ui` |
| 偏好远端备份       | `GET/PUT/DELETE /storage/mihomo-verge.preferences.v1`                     |

HTTP 请求使用 `Authorization: Bearer <secret>`。浏览器 WebSocket 不能自定义该请求头，因此通过 `token` 查询参数认证。

资源页管理的是 Mihomo 已加载的 providers，不提供 Clash Verge 的订阅配置切换、本地配置文件或增强脚本管理。代理集选择仅切换正在查看的数据；更新刷新对应来源。系统代理、托盘、自启动和系统服务安装属于桌面应用能力，不由标准 Mihomo API 提供。TUN 设置需要运行 Mihomo 的主机具备相应权限。

设置页的“内核维护”提供标准 API 的重启、内核升级、GEO 更新和托管面板更新。重启/升级成功响应表示内核已接受请求，需重新连接后核对状态；更新托管面板使用后端 `external-ui` 的更新来源，可能替换当前 WebUI。公网 IP、系统资源、内核 uptime 等没有用浏览器数据代替。不同内核版本和嵌入模式可能缺少部分写接口，页面保留实际错误反馈。

配置库保存在当前浏览器中，演示模式使用独立库；URL 导入由浏览器访问来源，受来源站点 CORS 限制。应用完整配置通过 `PUT /configs?force=true`，会与设置修改、维护操作互斥；“最近应用”记录本次连接中由配置库提交的版本，不表示已获取内核当前的完整配置。`GET /configs` 不能用于完整 YAML 导出。

配置归档包含 YAML 原文、来源地址与配置增强，也可携带全局增强，与偏好备份分开。导入先逐项预览与校验，确认后创建新的浏览器副本，不执行脚本或自动应用到内核；恢复全局增强需要在预览中单独勾选。来源更新同样先进入编辑区审阅。保存失败保留导入预览，可下载草稿归档。

增强执行顺序为规则、代理、代理组序列补丁 → 全局 Merge → 全局 Script → 配置 Merge → 配置 Script → 代理组引用清理。Merge 中普通对象递归合并，数组和标量替换；顶层 `dns` 浅合并、`hosts` 整体替换，`null` 不表示删除。序列补丁使用 `prepend`、`append`、`delete` 三个数组。Script 入口为同步的 `main(config, profileName)`，在独立 QuickJS 环境执行，支持 `console` 日志，不提供浏览器存储、网络或文件接口，也不注入 WebUI 连接密钥。脚本执行限时 5 秒、内存上限 64 MiB，可取消；异常会阻止本次生成和应用。

偏好备份仅包含明确列出的界面偏好，默认导出当前控制器的设置和全局主题，包含代理显示偏好与连接视图；不包含连接 Secret、YAML 配置、日志或连接缓存。恢复会将所含类别写入当前控制器的偏好，未包含类别保留原值。旧版备份缺失连接视图时使用表格。后端备份固定使用 `mihomo-verge.preferences.v1` 存储键，所有远端操作均由用户手动触发，不自动同步。

## 部署到 Mihomo

将 `dist/` 中的内容放入 Mihomo 工作目录下的 `ui/` 文件夹，并配置：

```yaml
external-controller: 127.0.0.1:9090
secret: replace-with-your-secret
external-ui: ./ui
external-controller-cors:
  allow-origins:
    - http://localhost:5173
  allow-private-network: true
```

重启 Mihomo 后访问 `http://127.0.0.1:9090/ui/`。开发服务器与控制器跨源时，需要将页面的实际 Origin 加入 `allow-origins`；例如开发页面使用 `http://127.0.0.1:5173`，也需要单独添加该地址。`allow-private-network` 用于允许受支持浏览器的私有网络访问预检，不会绕过浏览器的本地网络权限。

示例控制器仅监听本机。若从其他设备访问，应使用可访问的控制器地址，并相应配置监听地址、访问限制和 Secret。HTTPS 页面应连接 HTTPS / WSS 控制器，例如通过支持 WebSocket 转发的反向代理提供同源地址；HTTPS 页面直接请求 HTTP / WS 控制器可能被浏览器以混合内容拦截。
