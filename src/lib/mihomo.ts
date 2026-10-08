import type {
  BackendProfile,
  ConnectionsResponse,
  ConnectionsSnapshot,
  DnsResponse,
  JsonValue,
  MihomoConfig,
  MihomoConfigPatch,
  ProxiesResponse,
  ProxyNode,
  ProxyProvider,
  Rule,
  RuleProvider,
  UpgradeResponse,
  Version,
} from './types';

export type StreamStatus = 'connecting' | 'open' | 'closed';
export type StreamPath = 'traffic' | 'memory' | 'connections' | 'logs';

const DEFAULT_TIMEOUT = 12_000;
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

export class MihomoApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MihomoApiError';
    this.status = status;
  }
}

/** Preserve a reverse proxy's base path while rejecting non-HTTP controllers. */
export function normalizeBackendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new MihomoApiError('请输入完整的后端地址，例如 http://127.0.0.1:9090');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MihomoApiError('后端地址必须使用 http:// 或 https://');
  }
  if (url.username || url.password) {
    throw new MihomoApiError('请在密钥字段中填写 Secret，不要在后端地址中包含用户名或密码');
  }
  if (url.search || url.hash) {
    throw new MihomoApiError('后端地址不能包含查询参数或 # 片段');
  }
  return url.toString().replace(/\/+$/, '');
}

function errorDetail(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === 'object' && value !== null) {
      if ('message' in value && typeof value.message === 'string') return value.message;
      if ('error' in value && typeof value.error === 'string') return value.error;
    }
  } catch {
    // Some reverse proxies return plain text instead of a JSON error.
  }
  return body.trim().startsWith('<') ? '' : body.trim().slice(0, 200);
}

function responseError(status: number, body: string): MihomoApiError {
  if (status === 401 || status === 403) {
    return new MihomoApiError('后端拒绝访问，请检查 Secret 密钥是否正确', status);
  }
  const detail = errorDetail(body);
  const message =
    status === 404
      ? '接口不存在，请确认后端地址和 Mihomo 版本'
      : status === 408 || status === 504
        ? '后端请求超时，请稍后重试'
        : `Mihomo 请求失败（HTTP ${status}）`;
  return new MihomoApiError(detail ? `${message}：${detail}` : message, status);
}

/** No native bridge or custom server is required; all calls use Mihomo's API. */
export class MihomoClient {
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(profile: BackendProfile) {
    this.baseUrl = normalizeBackendUrl(profile.url);
    this.secret = profile.secret;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal; timeout?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (options.signal?.aborted) {
      throw new DOMException('请求已取消', 'AbortError');
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeout ?? DEFAULT_TIMEOUT);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = await response.text();
      if (!response.ok) throw responseError(response.status, body);
      if (!body.trim()) return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new MihomoApiError(
          '后端未返回有效 JSON，请检查地址是否指向 Mihomo 控制接口',
          response.status,
        );
      }
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (timedOut)
        throw new MihomoApiError('连接后端超时，请检查地址、网络和 external-controller 配置');
      if (error instanceof MihomoApiError) throw error;
      throw new MihomoApiError(
        '无法连接后端，请检查服务是否运行、地址是否正确，以及后端 CORS 设置',
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  version(signal?: AbortSignal): Promise<Version> {
    return this.request('/version', { signal });
  }

  configs(signal?: AbortSignal): Promise<MihomoConfig> {
    return this.request('/configs', { signal });
  }

  proxies(signal?: AbortSignal): Promise<ProxiesResponse> {
    return this.request('/proxies', { signal });
  }

  proxy(name: string, signal?: AbortSignal): Promise<ProxyNode> {
    return this.request(`/proxies/${encodeURIComponent(name)}`, { signal });
  }

  async providers(signal?: AbortSignal): Promise<Record<string, ProxyProvider>> {
    const response = await this.request<{ providers: Record<string, ProxyProvider> }>(
      '/providers/proxies',
      { signal },
    );
    return response.providers;
  }

  async rules(signal?: AbortSignal): Promise<Rule[]> {
    const response = await this.request<{ rules: Rule[] }>('/rules', { signal });
    return response.rules;
  }

  async ruleProviders(signal?: AbortSignal): Promise<Record<string, RuleProvider>> {
    const response = await this.request<{ providers: Record<string, RuleProvider> }>(
      '/providers/rules',
      { signal },
    );
    return response.providers;
  }

  updateRuleProvider(name: string): Promise<void> {
    return this.request(`/providers/rules/${encodeURIComponent(name)}`, { method: 'PUT' });
  }

  disableRules(disabled: Record<string, boolean>): Promise<void> {
    return this.request('/rules/disable', { method: 'PATCH', body: disabled });
  }

  async connections(signal?: AbortSignal): Promise<ConnectionsSnapshot> {
    const response = await this.request<ConnectionsResponse>('/connections', { signal });
    return { ...response, connections: response.connections ?? [] };
  }

  patchConfigs(patch: MihomoConfigPatch): Promise<void> {
    return this.request('/configs', { method: 'PATCH', body: patch });
  }

  selectProxy(group: string, name: string): Promise<void> {
    return this.request(`/proxies/${encodeURIComponent(group)}`, { method: 'PUT', body: { name } });
  }

  clearProxySelection(group: string): Promise<void> {
    return this.request(`/proxies/${encodeURIComponent(group)}`, { method: 'DELETE' });
  }

  delay(
    name: string,
    url = DEFAULT_TEST_URL,
    timeout = 5_000,
    expected?: string,
    signal?: AbortSignal,
  ): Promise<{ delay: number }> {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    if (expected !== undefined) query.set('expected', expected);
    return this.request(`/proxies/${encodeURIComponent(name)}/delay?${query}`, {
      signal,
      timeout: Math.max(DEFAULT_TIMEOUT, timeout + 2_500),
    });
  }

  groupDelay(
    group: string,
    url = DEFAULT_TEST_URL,
    timeout = 5_000,
    expected?: string,
  ): Promise<Record<string, number>> {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    if (expected !== undefined) query.set('expected', expected);
    return this.request(`/group/${encodeURIComponent(group)}/delay?${query}`, {
      timeout: Math.max(DEFAULT_TIMEOUT, timeout + 2_500),
    });
  }

  updateProvider(name: string): Promise<void> {
    return this.request(`/providers/proxies/${encodeURIComponent(name)}`, { method: 'PUT' });
  }

  healthcheckProvider(name: string): Promise<void> {
    return this.request(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, {
      timeout: 30_000,
    });
  }

  providerProxyDelay(
    provider: string,
    name: string,
    url = DEFAULT_TEST_URL,
    timeout = 5_000,
    signal?: AbortSignal,
  ): Promise<{ delay: number }> {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    return this.request(
      `/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(name)}/healthcheck?${query}`,
      {
        signal,
        timeout: Math.max(DEFAULT_TIMEOUT, timeout + 2_500),
      },
    );
  }

  closeConnection(id: string): Promise<void> {
    return this.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  closeAllConnections(): Promise<void> {
    return this.request('/connections', { method: 'DELETE' });
  }

  reloadConfig(content: string): Promise<void> {
    return this.request('/configs?force=true', {
      method: 'PUT',
      body: { payload: content },
      timeout: 30_000,
    });
  }

  dnsQuery(name: string, type: string, signal?: AbortSignal): Promise<DnsResponse> {
    const query = new URLSearchParams({ name, type });
    return this.request(`/dns/query?${query}`, { signal });
  }

  flushDns(): Promise<void> {
    return this.request('/cache/dns/flush', { method: 'POST' });
  }

  flushFakeIp(): Promise<void> {
    return this.request('/cache/fakeip/flush', { method: 'POST' });
  }

  updateGeo(): Promise<void> {
    return this.request('/configs/geo', {
      method: 'POST',
      timeout: 120_000,
    });
  }

  restart(): Promise<void> {
    return this.request('/restart', {
      method: 'POST',
      timeout: 30_000,
    });
  }

  upgradeCore(channel?: string, force?: boolean): Promise<UpgradeResponse> {
    const query = new URLSearchParams();
    if (channel !== undefined) query.set('channel', channel);
    if (force !== undefined) query.set('force', String(force));
    return this.request(`/upgrade${query.size ? `?${query}` : ''}`, {
      method: 'POST',
      timeout: 120_000,
    });
  }

  upgradeUi(): Promise<UpgradeResponse> {
    return this.request('/upgrade/ui', { method: 'POST', timeout: 120_000 });
  }

  getStorage<T = JsonValue>(key: string, signal?: AbortSignal): Promise<T | null> {
    return this.request(`/storage/${encodeURIComponent(key)}`, { signal });
  }

  setStorage(key: string, value: JsonValue): Promise<void> {
    return this.request(`/storage/${encodeURIComponent(key)}`, { method: 'PUT', body: value });
  }

  deleteStorage(key: string): Promise<void> {
    return this.request(`/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  subscribe<T>(
    path: StreamPath,
    onData: (data: T) => void,
    onStatus?: (state: StreamStatus) => void,
    params: Record<string, string> = {},
    onInvalidFrame?: () => void,
  ): () => void {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Browser WebSockets cannot set Authorization; Mihomo supports this token parameter.
    if (this.secret) url.searchParams.set('token', this.secret);

    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const detach = (target: WebSocket) => {
      target.onopen = null;
      target.onmessage = null;
      target.onerror = null;
      target.onclose = null;
    };

    const reconnect = () => {
      if (stopped) return;
      onStatus?.('closed');
      const wait = Math.min(1_000 * 2 ** Math.min(retries++, 5), 30_000);
      reconnectTimer = setTimeout(connect, wait);
    };

    const connect = () => {
      if (stopped) return;
      onStatus?.('connecting');
      let current: WebSocket;
      try {
        current = new WebSocket(url.toString());
      } catch {
        reconnect();
        return;
      }
      socket = current;
      current.onopen = () => {
        if (stopped || socket !== current) return;
        retries = 0;
        onStatus?.('open');
      };
      current.onmessage = (event: MessageEvent<unknown>) => {
        if (stopped || socket !== current) return;
        if (typeof event.data !== 'string') {
          onInvalidFrame?.();
          return;
        }
        let data: T;
        try {
          data = JSON.parse(event.data) as T;
        } catch {
          onInvalidFrame?.();
          return;
        }
        onData(data);
      };
      current.onerror = () => {
        // A failed WebSocket emits close next; one handler owns the retry timer.
        current.close();
      };
      current.onclose = () => {
        detach(current);
        if (socket !== current) return;
        socket = undefined;
        reconnect();
      };
    };

    connect();
    return () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconnectTimer);
      if (socket) {
        detach(socket);
        socket.close();
        socket = undefined;
      }
      onStatus?.('closed');
    };
  }
}
