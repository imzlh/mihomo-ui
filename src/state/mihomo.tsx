import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MihomoClient, normalizeBackendUrl } from '../lib/mihomo';
import type {
  BackendProfile,
  ConnectionsResponse,
  ConnectionsSnapshot,
  LogEntry,
  Memory,
  MihomoConfigPatch,
  ProxyNode,
  Traffic,
  Version,
} from '../lib/types';
import {
  createDemoTraffic,
  demoConfig,
  demoLogs,
  demoProviders,
  demoProxies,
  demoRules,
  demoSnapshot,
} from '../lib/demo';
import type { Toast } from '../components/ui';

const storageKey = 'mihomo-verge.backend';
const emptySnapshot: ConnectionsSnapshot = { connections: [], uploadTotal: 0, downloadTotal: 0 };
function restoreProfile(): BackendProfile | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (
      raw &&
      typeof raw === 'object' &&
      'url' in raw &&
      'secret' in raw &&
      typeof raw.url === 'string' &&
      typeof raw.secret === 'string'
    )
      return { url: normalizeBackendUrl(raw.url), secret: raw.secret };
  } catch {
    /* An invalid saved controller should return to the connection form. */
  }
  return window.location.pathname.startsWith('/ui')
    ? { url: window.location.origin, secret: '' }
    : null;
}

function useMihomoState() {
  const queryCache = useQueryClient();
  const [session, setSession] = useState(() => ({ profile: restoreProfile(), id: 0 }));
  const [demo, setDemo] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [configDemo, setConfigDemo] = useState(demoConfig);
  const [proxiesDemo, setProxiesDemo] = useState(demoProxies);
  const [traffic, setTraffic] = useState<Traffic>({ up: 0, down: 0 });
  const [history, setHistory] = useState<Traffic[]>([]);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [memory, setMemory] = useState(0);
  const [logs, setLogs] = useState<Array<LogEntry & { id: number; time: string }>>([]);
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const connectAttempt = useRef(0);
  const connectionAbort = useRef<AbortController | null>(null);
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
  const notify = useCallback((text: string, type: Toast['type'] = 'success') => {
    const id = ++counter.current;
    setToasts((items) => [...items.slice(-3), { id, text, type }]);
    const timer = setTimeout(
      () => {
        setToasts((items) => items.filter((item) => item.id !== id));
        toastTimers.current.delete(timer);
      },
      type === 'error' ? 7000 : 3500,
    );
    toastTimers.current.add(timer);
  }, []);
  const dismissToast = (id: number) => setToasts((items) => items.filter((item) => item.id !== id));
  const client = useMemo(
    () => (session.profile && !demo ? new MihomoClient(session.profile) : null),
    [session.profile, demo],
  );
  const key = ['mihomo', session.id];
  const versionQuery = useQuery({
    queryKey: [...key, 'version'],
    queryFn: ({ signal }) => client!.version(signal),
    enabled: !!client,
    refetchInterval: 15_000,
    retry: false,
  });
  const connected = demo || (!!client && versionQuery.isSuccess);
  const enabled = !!client && connected;
  const configQuery = useQuery({
    queryKey: [...key, 'config'],
    queryFn: ({ signal }) => client!.configs(signal),
    enabled,
    refetchInterval: 15_000,
  });
  const proxiesQuery = useQuery({
    queryKey: [...key, 'proxies'],
    queryFn: ({ signal }) => client!.proxies(signal),
    enabled,
    refetchInterval: 15_000,
  });
  const providersQuery = useQuery({
    queryKey: [...key, 'providers'],
    queryFn: ({ signal }) => client!.providers(signal),
    enabled,
    refetchInterval: 60_000,
  });
  const ruleProvidersQuery = useQuery({
    queryKey: [...key, 'rule-providers'],
    queryFn: ({ signal }) => client!.ruleProviders(signal),
    enabled,
    refetchInterval: 60_000,
  });
  const rulesQuery = useQuery({
    queryKey: [...key, 'rules'],
    queryFn: ({ signal }) => client!.rules(signal),
    enabled,
    staleTime: 60_000,
  });
  const proxies = useMemo<Record<string, ProxyNode>>(() => {
    if (demo) return proxiesDemo;
    const nodes = Object.values(providersQuery.data ?? {}).flatMap((provider) =>
      provider.proxies.map((node) => [node.name, node] as const),
    );
    return { ...Object.fromEntries(nodes), ...proxiesQuery.data?.proxies };
  }, [demo, proxiesDemo, providersQuery.data, proxiesQuery.data]);

  useEffect(() => {
    setTraffic({ up: 0, down: 0 });
    setHistory([]);
    setSnapshot(emptySnapshot);
    setMemory(0);
    setLogs([]);
    setLive(false);
    if (demo) {
      setSnapshot(demoSnapshot);
      setMemory(86_432_100);
      setLogs(demoLogs);
      setLive(true);
      setHistory(Array.from({ length: 60 }, (_, index) => createDemoTraffic(index)));
      let tick = 60;
      const timer = setInterval(() => {
        const next = createDemoTraffic(tick++);
        setTraffic(next);
        setHistory((items) => [...items.slice(-59), next]);
        setSnapshot((current) => ({
          ...current,
          uploadTotal: current.uploadTotal + next.up,
          downloadTotal: current.downloadTotal + next.down,
        }));
      }, 1000);
      return () => clearInterval(timer);
    }
    if (!client || !connected) return;
    const dispose = [
      client.subscribe<Traffic>(
        'traffic',
        (data) => {
          setTraffic(data);
          setHistory((items) => [...items.slice(-59), data]);
          if (data.upTotal !== undefined || data.downTotal !== undefined)
            setSnapshot((current) => ({
              ...current,
              uploadTotal: data.upTotal ?? current.uploadTotal,
              downloadTotal: data.downTotal ?? current.downloadTotal,
            }));
        },
        (status) => {
          setLive(status === 'open');
          if (status !== 'open') setTraffic({ up: 0, down: 0 });
        },
      ),
      client.subscribe<Memory>('memory', (data) => setMemory(data.inuse)),
      client.subscribe<ConnectionsResponse>('connections', (data) => {
        setSnapshot({ ...data, connections: data.connections ?? [] });
        if (data.memory !== undefined) setMemory(data.memory);
      }),
      client.subscribe<LogEntry>(
        'logs',
        (data) =>
          setLogs((items) => [
            ...items.slice(-999),
            { ...data, id: ++counter.current, time: new Date().toISOString() },
          ]),
        undefined,
        { level: 'debug' },
      ),
    ];
    return () => dispose.forEach((unsubscribe) => unsubscribe());
  }, [client, connected, demo]);

  const refresh = async () => {
    await queryCache.invalidateQueries({ queryKey: key });
  };
  const runAction = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await action();
      await refresh();
      if (success) notify(success);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败，请重试', 'error');
      return false;
    }
  };
  const connect = async (profile: BackendProfile, remember: boolean): Promise<boolean> => {
    const attempt = ++connectAttempt.current;
    connectionAbort.current?.abort();
    const controller = new AbortController();
    connectionAbort.current = controller;
    setTesting(true);
    setConnectError(null);
    try {
      const normalized = { ...profile, url: normalizeBackendUrl(profile.url) };
      const version = await new MihomoClient(normalized).version(controller.signal);
      if (attempt !== connectAttempt.current) return false;
      const id = session.id + 1;
      queryCache.setQueryData<Version>(['mihomo', id, 'version'], version);
      setDemo(false);
      setSession({ profile: normalized, id });
      try {
        if (remember) localStorage.setItem(storageKey, JSON.stringify(normalized));
        else localStorage.removeItem(storageKey);
      } catch {
        notify('已连接，但浏览器未允许保存连接信息', 'info');
      }
      notify('已连接到 Mihomo 内核');
      return true;
    } catch (error) {
      if (attempt === connectAttempt.current)
        setConnectError(error instanceof Error ? error.message : '连接失败');
      return false;
    } finally {
      if (attempt === connectAttempt.current) {
        setTesting(false);
        connectionAbort.current = null;
      }
    }
  };
  const cancelConnect = useCallback(() => {
    connectAttempt.current++;
    connectionAbort.current?.abort();
    connectionAbort.current = null;
    setTesting(false);
    setConnectError(null);
  }, []);
  const disconnect = () => {
    cancelConnect();
    setDemo(false);
    setSession((current) => ({ profile: null, id: current.id + 1 }));
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Connection state remains in memory when storage is unavailable. */
    }
    void queryCache.cancelQueries({ queryKey: key });
    queryCache.removeQueries({ queryKey: key });
  };
  const startDemo = () => {
    cancelConnect();
    setDemo(true);
    setConfigDemo(demoConfig);
    setProxiesDemo(demoProxies);
  };
  const patchConfig = async (patch: MihomoConfigPatch) => {
    if (demo) {
      setConfigDemo((current) => ({ ...current, ...patch }));
      notify('已更新演示配置', 'info');
      return;
    }
    if (client)
      await runAction(async () => {
        await client.patchConfigs(patch);
        const actual = await client.configs();
        queryCache.setQueryData([...key, 'config'], actual);
        const compare = (expected: Record<string, unknown>, received: object): string[] =>
          Object.entries(expected).flatMap(([field, value]) => {
            const real = (received as Record<string, unknown>)[field];
            if (value && typeof value === 'object' && !Array.isArray(value))
              return real && typeof real === 'object'
                ? compare(value as Record<string, unknown>, real).map(
                    (child) => `${field}.${child}`,
                  )
                : [field];
            return JSON.stringify(value) === JSON.stringify(real) ? [] : [field];
          });
        const mismatches = compare(patch as Record<string, unknown>, actual);
        if (mismatches.length)
          throw new Error(
            `配置未生效：${mismatches.join('、')}。请检查内核日志中的端口占用或权限错误。`,
          );
      }, '内核配置已应用');
  };
  const selectProxy = async (group: string, name: string) => {
    if (demo) {
      setProxiesDemo((current) => {
        const node = current[group];
        return node
          ? {
              ...current,
              [group]: {
                ...node,
                now: name,
                ...(['URLTest', 'Fallback'].includes(node.type) ? { fixed: name } : {}),
              },
            }
          : current;
      });
      notify('已切换演示节点', 'info');
      return;
    }
    if (client) await runAction(() => client.selectProxy(group, name), `已切换到 ${name}`);
  };
  const testDelay = async (group: string) => {
    if (demo) {
      setProxiesDemo((current) => {
        const node = current[group];
        return node ? { ...current, [group]: { ...node, fixed: undefined } } : current;
      });
      notify('演示模式展示的是示例延迟', 'info');
      return;
    }
    if (client)
      await runAction(async () => {
        const node = proxies[group];
        const delays = await client.groupDelay(
          group,
          node?.testUrl || undefined,
          5_000,
          node?.expectedStatus || undefined,
        );
        queryCache.setQueryData<{ proxies: Record<string, ProxyNode> }>(
          [...key, 'proxies'],
          (current) =>
            current
              ? {
                  proxies: Object.fromEntries(
                    Object.entries(current.proxies).map(([name, node]) => [
                      name,
                      delays[name] === undefined
                        ? node
                        : {
                            ...node,
                            history: [
                              ...node.history,
                              { time: new Date().toISOString(), delay: delays[name] ?? 0 },
                            ],
                          },
                    ]),
                  ),
                }
              : current,
        );
      }, '延迟测试完成');
  };
  const clearProxySelection = async (group: string) => {
    if (demo) {
      setProxiesDemo((current) => {
        const node = current[group];
        return node ? { ...current, [group]: { ...node, fixed: undefined } } : current;
      });
      notify('演示组已恢复自动选择', 'info');
      return;
    }
    if (client) await runAction(() => client.clearProxySelection(group), '已恢复自动选择');
  };
  const testNodeDelay = async (name: string): Promise<number | undefined> => {
    if (demo) {
      notify('演示模式展示的是示例延迟', 'info');
      return proxies[name]?.history.at(-1)?.delay;
    }
    if (!client) return;
    let measured: number | undefined;
    const candidates = Object.entries(providersQuery.data ?? {}).filter(([, item]) =>
      item.proxies.some((node) => node.name === name),
    );
    const declaredProvider = proxies[name]?.['provider-name'];
    const provider = declaredProvider
      ? candidates.find(([providerName]) => providerName === declaredProvider)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!proxiesQuery.data?.proxies[name] && candidates.length > 1 && !provider) {
      notify('多个代理集包含同名节点，请在资源页选择具体代理集后测速。', 'info');
      return;
    }
    await runAction(async () => {
      const result =
        provider && !proxiesQuery.data?.proxies[name]
          ? await client.providerProxyDelay(provider[0], name)
          : await client.delay(name);
      measured = result.delay;
    }, '节点延迟测试完成');
    return measured;
  };
  const resourceError = [
    configQuery.error,
    proxiesQuery.error,
    providersQuery.error,
    ruleProvidersQuery.error,
    rulesQuery.error,
  ].find(Boolean)?.message;
  return {
    client,
    profile: session.profile,
    demo,
    testing,
    connected,
    live,
    connectError,
    status: (demo || connected
      ? 'connected'
      : client
        ? versionQuery.isError
          ? 'error'
          : 'connecting'
        : 'disconnected') as 'connected' | 'error' | 'connecting' | 'disconnected',
    error: versionQuery.error?.message ?? null,
    resourceError,
    config: demo ? configDemo : configQuery.data,
    proxies,
    providers: demo ? demoProviders : (providersQuery.data ?? {}),
    ruleProviders: demo
      ? {
          private: {
            name: 'private',
            type: 'Rule',
            vehicleType: 'HTTP',
            behavior: 'classical',
            format: 'yaml',
            ruleCount: 145,
            updatedAt: new Date().toISOString(),
          },
          reject: {
            name: 'reject',
            type: 'Rule',
            vehicleType: 'HTTP',
            behavior: 'domain',
            format: 'mrs',
            ruleCount: 12540,
            updatedAt: new Date().toISOString(),
          },
        }
      : (ruleProvidersQuery.data ?? {}),
    rules: demo ? demoRules : (rulesQuery.data ?? []),
    version: demo ? 'v1.19.12' : (versionQuery.data?.version ?? '—'),
    traffic,
    history,
    snapshot,
    memory,
    logs,
    toasts,
    dismissToast,
    notify,
    refresh,
    runAction,
    connect,
    cancelConnect,
    disconnect,
    startDemo,
    patchConfig,
    selectProxy,
    clearProxySelection,
    testDelay,
    testNodeDelay,
    clearLogs: () => setLogs([]),
  };
}

const MihomoContext = createContext<ReturnType<typeof useMihomoState> | null>(null);
export function MihomoProvider({ children }: { children: ReactNode }) {
  const state = useMihomoState();
  return <MihomoContext.Provider value={state}>{children}</MihomoContext.Provider>;
}
export function useMihomo() {
  const context = useContext(MihomoContext);
  if (!context) throw new Error('MihomoProvider is missing');
  return context;
}
