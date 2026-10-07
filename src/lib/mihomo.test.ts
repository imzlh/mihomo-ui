import { afterEach, describe, expect, it, vi } from 'vitest';
import { MihomoApiError, MihomoClient, normalizeBackendUrl } from './mihomo';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Mihomo controller requests', () => {
  it('preserves reverse-proxy paths and rejects unsupported or ambiguous URLs', () => {
    expect(normalizeBackendUrl(' https://example.com/controller/// ')).toBe(
      'https://example.com/controller',
    );
    expect(() => normalizeBackendUrl('localhost:9090')).toThrow(MihomoApiError);
    expect(() => normalizeBackendUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => normalizeBackendUrl('http://user:pass@localhost:9090')).toThrow(/Secret/);
    expect(() => normalizeBackendUrl('http://localhost:9090?token=secret')).toThrow(/查询参数/);
  });

  it('authenticates requests and safely encodes proxy group names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({
      url: 'https://example.com/controller/',
      secret: 'test-secret',
    });

    await client.selectProxy('香港 / #1', '节点 & 2');

    expect(fetchMock).toHaveBeenCalledWith(
      `https://example.com/controller/proxies/${encodeURIComponent('香港 / #1')}`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
        body: JSON.stringify({ name: '节点 & 2' }),
      }),
    );
  });

  it('omits authentication when the backend has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"version":"1.19.0"}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MihomoClient({ url: 'http://localhost:9090', secret: '' }).version(),
    ).resolves.toEqual({ version: '1.19.0' });
    expect(fetchMock.mock.calls[0]?.[1].headers).not.toHaveProperty('Authorization');
  });

  it('explains authentication errors without displaying the secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 })),
    );
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: 'private-secret' });
    await expect(client.configs()).rejects.toMatchObject({
      name: 'MihomoApiError',
      status: 401,
      message: '后端拒绝访问，请检查 Secret 密钥是否正确',
    });
  });

  it('normalizes an idle core null connections list while preserving its totals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            downloadTotal: 42_000,
            uploadTotal: 12_000,
            memory: 86_400,
            connections: null,
          }),
        ),
      ),
    );
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });
    await expect(client.connections()).resolves.toEqual({
      downloadTotal: 42_000,
      uploadTotal: 12_000,
      memory: 86_400,
      connections: [],
    });
  });

  it('identifies an HTML page accidentally entered as the API endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<!doctype html><title>Dashboard</title>')),
    );
    const client = new MihomoClient({ url: 'http://localhost:9090/ui', secret: '' });
    await expect(client.version()).rejects.toThrow(/有效 JSON/);
  });

  it('keeps deliberate cancellation distinct from network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const abort = new AbortController();
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });
    const request = client.proxies(abort.signal);
    abort.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out unresponsive requests and aborts their fetch', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init.signal;
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });
    const result = expect(client.version()).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(12_000);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('documented Mihomo API contracts', () => {
  it('looks up a proxy and clears a group pin through its encoded proxy resource', async () => {
    const node = { name: '自动 / #1', type: 'URLTest', fixed: '香港', history: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(node)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });

    await expect(client.proxy(node.name)).resolves.toEqual(node);
    await client.clearProxySelection(node.name);

    const endpoint = `http://localhost:9090/proxies/${encodeURIComponent(node.name)}`;
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      endpoint,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      endpoint,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });

  it('passes expected status ranges to both proxy and group delay requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"delay":42}'))
      .mockResolvedValueOnce(new Response('{"香港":42}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'https://example.com/api', secret: '' });
    const testUrl = 'https://probe.example/check?a=1&b=2';

    await expect(client.delay('香港 / 01', testUrl, 8_000, '200/204')).resolves.toEqual({
      delay: 42,
    });
    await expect(client.groupDelay('自动 / #1', testUrl, 9_000, '200-299')).resolves.toEqual({
      香港: 42,
    });

    const proxyUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(proxyUrl.pathname).toBe(`/api/proxies/${encodeURIComponent('香港 / 01')}/delay`);
    expect(Object.fromEntries(proxyUrl.searchParams)).toEqual({
      url: testUrl,
      timeout: '8000',
      expected: '200/204',
    });
    const groupUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(groupUrl.pathname).toBe(`/api/group/${encodeURIComponent('自动 / #1')}/delay`);
    expect(Object.fromEntries(groupUrl.searchParams)).toEqual({
      url: testUrl,
      timeout: '9000',
      expected: '200-299',
    });
  });

  it('tests a provider node through its provider endpoint with both names separately encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"delay":76}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });

    await expect(
      client.providerProxyDelay('机场 / &1', '日本 #2/东京', 'https://probe.example/204', 6_000),
    ).resolves.toEqual({ delay: 76 });

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe(
      `/providers/proxies/${encodeURIComponent('机场 / &1')}/${encodeURIComponent('日本 #2/东京')}/healthcheck`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      url: 'https://probe.example/204',
      timeout: '6000',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('unwraps rule providers, updates the named provider, and patches rule disabled flags', async () => {
    const providers = {
      国内: {
        name: '国内',
        type: 'Rule',
        vehicleType: 'HTTP',
        behavior: 'domain',
        format: 'mrs',
        ruleCount: 128,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ providers })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });

    await expect(client.ruleProviders()).resolves.toEqual(providers);
    await client.updateRuleProvider('国内 / #1');
    await client.disableRules({ '0': false, '2': true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:9090/providers/rules',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://localhost:9090/providers/rules/${encodeURIComponent('国内 / #1')}`,
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:9090/rules/disable',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ '0': false, '2': true }),
      }),
    );
  });

  it('encodes DNS query values and retains the documented response record fields', async () => {
    const response = {
      Status: 0,
      Question: [{ Name: 'example.com.', Qtype: 1, Qclass: 1 }],
      RD: true,
      Answer: [{ name: 'example.com.', type: 1, TTL: 120, data: '192.0.2.1' }],
      Authority: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });

    await expect(client.dnsQuery('example.com&name=other.example', 'A')).resolves.toEqual(response);

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/dns/query');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'example.com&name=other.example',
      type: 'A',
    });
  });

  it('uses POST for cache and maintenance operations with the documented bodies and upgrade flags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}'))
      .mockResolvedValueOnce(new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });

    await client.flushDns();
    await client.flushFakeIp();
    await client.updateGeo();
    await client.restart({ path: 'config.yaml' });
    await expect(client.upgradeCore('alpha', true)).resolves.toEqual({ status: 'ok' });
    await expect(client.upgradeUi()).resolves.toEqual({ status: 'ok' });

    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        new URL(url as string).pathname,
        (init as RequestInit).method,
      ]),
    ).toEqual([
      ['/cache/dns/flush', 'POST'],
      ['/cache/fakeip/flush', 'POST'],
      ['/configs/geo', 'POST'],
      ['/restart', 'POST'],
      ['/upgrade', 'POST'],
      ['/upgrade/ui', 'POST'],
    ]);
    expect(fetchMock.mock.calls[2]?.[1].body).toBe(JSON.stringify({ path: '', payload: '' }));
    expect(fetchMock.mock.calls[3]?.[1].body).toBe(
      JSON.stringify({ path: 'config.yaml', payload: '' }),
    );
    expect(
      Object.fromEntries(new URL(fetchMock.mock.calls[4]?.[0] as string).searchParams),
    ).toEqual({ channel: 'alpha', force: 'true' });
    expect(fetchMock.mock.calls[5]?.[1]).not.toHaveProperty('body');
  });

  it('handles null storage values and preserves JSON primitives without adding an envelope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });
    const key = 'dashboard / #设置';

    await expect(client.getStorage(key)).resolves.toBeNull();
    await client.setStorage(key, false);
    await client.deleteStorage(key);

    const endpoint = `http://localhost:9090/storage/${encodeURIComponent(key)}`;
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      endpoint,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      endpoint,
      expect.objectContaining({ method: 'PUT', body: 'false' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      endpoint,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

function mockWebSockets(): void {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
}

describe('Mihomo WebSocket subscriptions', () => {
  it('uses secure token-authenticated URLs, ignores malformed data, and detaches on cleanup', () => {
    mockWebSockets();
    const client = new MihomoClient({ url: 'https://example.com/api', secret: 'a &/?=密钥' });
    const onData = vi.fn();
    const onStatus = vi.fn();
    const stop = client.subscribe('logs', onData, onStatus, { level: 'debug' });
    const socket = MockWebSocket.instances[0]!;
    const url = new URL(socket.url);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/api/logs');
    expect(url.searchParams.get('token')).toBe('a &/?=密钥');
    expect(url.searchParams.get('level')).toBe('debug');

    socket.onopen?.();
    socket.onmessage?.(
      new MessageEvent('message', { data: '{"type":"info","payload":"connected"}' }),
    );
    socket.onmessage?.(new MessageEvent('message', { data: 'invalid json' }));
    expect(onData).toHaveBeenCalledExactlyOnceWith({ type: 'info', payload: 'connected' });
    expect(onStatus).toHaveBeenLastCalledWith('open');

    const lateMessage = socket.onmessage;
    stop();
    stop();
    lateMessage?.(new MessageEvent('message', { data: '{"type":"info","payload":"late"}' }));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onclose).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off after failures and cancels scheduled reconnections when stopped', () => {
    mockWebSockets();
    const client = new MihomoClient({ url: 'http://localhost:9090', secret: '' });
    const stop = client.subscribe('traffic', vi.fn());
    MockWebSocket.instances[0]!.onclose?.();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1]!.onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
