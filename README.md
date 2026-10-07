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

浏览器测试使用 Playwright；没有可用的 Chrome 时先执行 `pnpm exec playwright install chromium`，也可通过 `PLAYWRIGHT_CHROME_PATH` 指定 Chrome 路径。

## 功能与结构

- 首页：实时上下行流量、连接数、内存、模式、可选择的代理组出口和代理集详情；规则模式不假定存在唯一出口。
- 代理：节点选择与测速、搜索排序、隐藏组、URLTest/Fallback 固定节点与恢复自动。
- 资源：代理集和规则集列表、更新、健康检查；代理集节点详情支持排序和单节点测速。
- 连接：表头排序、搜索、冻结显示、实际速率、详细代理链和关闭连接。
- 规则：保留真实优先级的视图排序、筛选、分页、命中统计；内核返回状态时支持临时启停，重启后重置。
- 日志：实时接收、级别筛选、搜索、暂停显示和本地清空。
- 网络诊断：内核 DNS 查询、DNS 记录排序、DNS/Fake-IP 缓存清理。
- 设置：管理控制器连接、外观和 Mihomo 支持的运行参数。

`src/lib/` 定义 TypeScript 数据类型、API 客户端、格式化函数及演示数据；`src/hooks/` 处理稳定排序与采样速率，React 页面通过统一数据边界访问控制器。TanStack Query 管理服务端查询缓存，Context 管理连接状态与 WebSocket 实时数据。哈希路由支持静态服务器，Vite 使用相对资源路径，支持部署在 `/ui/` 等子目录。

接口依据用户提供的 [api.md](api.md)，细节见 [API 能力核对](docs/API-CAPABILITIES.md) 和 [Clash Verge 迁移对照](docs/MIGRATION.md)。表格排序、主题、暂停显示是浏览器功能；`PATCH /configs` 后会读取实际配置确认效果，不能仅凭 204 就认定 TUN 或端口已启动成功。

Secret 默认仅保存在当前页面会话的内存中。只有主动开启记住连接信息时才写入浏览器 `localStorage`；应仅在信任的设备上启用。

## 标准 API

| 功能               | 接口                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| 版本、配置、模式   | `GET /version`、`GET /configs`、`PATCH /configs`                      |
| 重新加载 YAML 配置 | `PUT /configs?force=true`                                             |
| 节点与代理组       | `GET /proxies`、`PUT /proxies/{name}`                                 |
| 恢复自动组选择     | `DELETE /proxies/{name}`                                              |
| 节点、组测速       | `GET /proxies/{name}/delay`、`GET /group/{name}/delay`                |
| 代理订阅提供者     | `GET /providers/proxies`、`PUT /providers/proxies/{name}`             |
| 提供者健康检查     | `GET /providers/proxies/{name}/healthcheck`                           |
| 集合内单节点测速   | `GET /providers/proxies/{provider}/{node}/healthcheck`                |
| 规则集             | `GET /providers/rules`、`PUT /providers/rules/{name}`                 |
| 规则               | `GET /rules`                                                          |
| 规则临时启停       | `PATCH /rules/disable`                                                |
| 连接管理           | `GET /connections`、`DELETE /connections/{id}`、`DELETE /connections` |
| 实时数据           | WebSocket `/traffic`、`/memory`、`/connections`、`/logs?level=debug`  |
| DNS 查询与缓存     | `GET /dns/query`、`POST /cache/dns/flush`、`POST /cache/fakeip/flush` |

HTTP 请求使用 `Authorization: Bearer <secret>`。浏览器 WebSocket 不能自定义该请求头，因此通过 `token` 查询参数认证。

资源页管理的是 Mihomo 已加载的 providers，不提供 Clash Verge 的订阅配置切换、本地配置文件或增强脚本管理。代理集选择仅切换正在查看的数据；更新刷新对应来源。系统代理、托盘、自启动和系统服务安装属于桌面应用能力，不由标准 Mihomo API 提供。TUN 设置需要运行 Mihomo 的主机具备相应权限。

标准 API 的重启、内核升级、托管 UI 升级和通用 JSON 存储已封装为客户端方法，目前没有对应页面入口；它们不等同于 Verge 原生的服务管理或配置库。公网 IP、系统资源、内核 uptime 等没有用浏览器数据代替。不同内核版本和嵌入模式可能缺少部分写接口，页面保留实际错误反馈。

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
