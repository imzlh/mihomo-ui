import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MihomoClient, normalizeBackendUrl } from '../lib/mihomo';
import { maintenanceStore } from '../lib/core-maintenance';
import { connectionsForProxySwitch, switchProxyWithCleanup } from '../lib/proxy-switch';
import { mergeProxyNodes } from '../lib/proxy-nodes';
import { PREFERENCES_CHANGED } from '../lib/preference-events';
import {
  createConnectionHistory,
  isConnectionsResponse,
  reduceConnectionHistory,
} from '../lib/connection-history';
import type {
  BackendProfile,
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
function readCloseOnSwitch(scope: string): boolean {
  try {
    return localStorage.getItem(`mihomo-verge.close-on-switch:${scope}`) === 'true';
  } catch {
    return false;
  }
}

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
  const preferenceScope = demo ? 'demo' : (session.profile?.url ?? 'offline');
  const storedCloseOnSwitch = useMemo(() => readCloseOnSwitch(preferenceScope), [preferenceScope]);
  const [closePreference, setClosePreference] = useState({ scope: '', enabled: false });
  const closeOnSwitch =
    closePreference.scope === preferenceScope ? closePreference.enabled : storedCloseOnSwitch;
  useEffect(() => {
    const sync = () =>
      setClosePreference({ scope: preferenceScope, enabled: readCloseOnSwitch(preferenceScope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [preferenceScope]);
  const [testing, setTesting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [configDemo, setConfigDemo] = useState(demoConfig);
  const [proxiesDemo, setProxiesDemo] = useState(demoProxies);
  const [traffic, setTraffic] = useState<Traffic>({ up: 0, down: 0 });
  const [history, setHistory] = useState<Traffic[]>([]);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [connectionHistoryState, dispatchConnectionHistory] = useReducer(
    reduceConnectionHistory,
    undefined,
    createConnectionHistory,
  );
  const [connectionsStream, setConnectionsStream] = useState<{
    status: 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'demo';
    lastSnapshotAt: number | null;
  }>({ status: 'idle', lastSnapshotAt: null });
  const [memory, setMemory] = useState(0);
  const [logs, setLogs] = useState<Array<LogEntry & { id: number; time: string }>>([]);
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const connectAttempt = useRef(0);
  const connectionAbort = useRef<AbortController | null>(null);
  const activeSelections = useRef(new Set<string>());
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
  const actionSession = useMemo(() => ({ client, demo }), [client, demo]);
  const currentActionSession = useRef<typeof actionSession | null>(actionSession);
  useEffect(() => {
    currentActionSession.current = actionSession;
    return () => {
      currentActionSession.current = null;
    };
  }, [actionSession]);
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
    return mergeProxyNodes(proxiesQuery.data?.proxies ?? {}, providersQuery.data ?? {});
  }, [demo, proxiesDemo, providersQuery.data, proxiesQuery.data]);

  useEffect(() => {
    setTraffic({ up: 0, down: 0 });
    setHistory([]);
    setMemory(0);
    setLive(false);
    if (demo) {
      setMemory(86_432_100);
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

  // A controller change starts a new local observation session. Transient disconnects do not.
  useEffect(() => {
    setSnapshot(demo ? demoSnapshot : emptySnapshot);
    setLogs(demo ? demoLogs : []);
    dispatchConnectionHistory({ type: 'reset' });
    setConnectionsStream({ status: demo ? 'demo' : 'idle', lastSnapshotAt: null });
  }, [client, demo]);

  useEffect(() => {
    if (demo) return;
    if (!client || !connected) {
      dispatchConnectionHistory({ type: 'interrupt' });
      setConnectionsStream((current) => ({ ...current, status: client ? 'closed' : 'idle' }));
      return;
    }
    const interruptInvalidFrame = () => {
      dispatchConnectionHistory({ type: 'interrupt' });
      setConnectionsStream((current) => ({ ...current, status: 'error' }));
    };
    return client.subscribe<unknown>(
      'connections',
      (data) => {
        if (!isConnectionsResponse(data)) {
          interruptInvalidFrame();
          return;
        }
        const observedAt = Date.now();
        const connections = data.connections ?? [];
        setSnapshot({ ...data, connections });
        dispatchConnectionHistory({ type: 'snapshot', connections, observedAt });
        setConnectionsStream({ status: 'open', lastSnapshotAt: observedAt });
        if (data.memory !== undefined) setMemory(data.memory);
      },
      (status) => {
        dispatchConnectionHistory({ type: 'interrupt' });
        setConnectionsStream((current) => ({
          ...current,
          // The list becomes live only after the new socket delivers a valid snapshot.
          status: status === 'open' ? 'connecting' : status,
        }));
      },
      {},
      interruptInvalidFrame,
    );
  }, [client, connected, demo]);

  const refresh = async () => {
    await queryCache.invalidateQueries({ queryKey: key });
  };
  const runAction = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await action();
      if (currentActionSession.current !== actionSession) return false;
      await refresh();
      if (currentActionSession.current !== actionSession) return false;
      if (success) notify(success);
      return true;
    } catch (error) {
      if (currentActionSession.current === actionSession)
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
  const patchConfig = async (patch: MihomoConfigPatch): Promise<boolean> => {
    if (demo) {
      setConfigDemo((current) => ({
        ...current,
        ...patch,
        ...(patch.tun ? { tun: { ...current.tun, ...patch.tun } } : {}),
      }));
      notify('已更新演示配置', 'info');
      return true;
    }
    if (!client) return false;
    const maintenance = maintenanceStore(client);
    if (!maintenance.beginConfigWrite()) {
      notify('内核正在应用配置或执行维护，请稍后重试。', 'info');
      return false;
    }
    try {
      return await runAction(async () => {
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
    } finally {
      maintenance.endConfigWrite();
    }
  };
  const reloadConfig = async (
    content: string,
    onError?: (message: string) => void,
  ): Promise<boolean> => {
    if (!client || demo || !connected || !content.trim()) return false;
    const maintenance = maintenanceStore(client);
    if (!maintenance.beginConfigWrite()) {
      const message = '内核正在应用配置或执行维护，请稍后重试。';
      onError?.(message);
      notify(message, 'info');
      return false;
    }
    try {
      return await runAction(async () => {
        try {
          await client.reloadConfig(content);
        } catch (error) {
          if (currentActionSession.current === actionSession)
            onError?.(error instanceof Error ? error.message : '重新加载失败，请检查配置内容');
          throw error;
        }
      }, '配置已重新加载');
    } finally {
      maintenance.endConfigWrite();
    }
  };
  const setCloseOnSwitch = (enabled: boolean) => {
    setClosePreference({ scope: preferenceScope, enabled });
    try {
      localStorage.setItem(`mihomo-verge.close-on-switch:${preferenceScope}`, String(enabled));
    } catch {
      notify('此偏好仅在当前页面会话中生效，浏览器未允许保存', 'info');
    }
  };
  const selectProxy = async (group: string, name: string) => {
    const actionKey = JSON.stringify([session.id, demo, group]);
    if (!connected || activeSelections.current.has(actionKey)) return;
    if (demo) {
      const previous = proxiesDemo[group]?.now;
      if (closeOnSwitch && previous && previous !== name) {
        setSnapshot((current) => {
          const closing = new Set(
            connectionsForProxySwitch(current.connections, group, previous).map((item) => item.id),
          );
          return {
            ...current,
            connections: current.connections.filter((item) => !closing.has(item.id)),
          };
        });
      }
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
    if (!client) return;
    activeSelections.current.add(actionKey);
    try {
      if (!closeOnSwitch) {
        await runAction(() => client.selectProxy(group, name), `已切换到 ${name}`);
        return;
      }
      const result = await switchProxyWithCleanup(client, group, name);
      if (currentActionSession.current !== actionSession) return;
      if (result.error || result.failed) {
        notify(
          `已切换到 ${name}，旧连接清理未完成：${result.error ?? `${result.failed} 条关闭失败`}。已关闭 ${result.closed} 条。`,
          'error',
        );
      } else {
        notify(`已切换到 ${name}${result.closed ? `，已关闭 ${result.closed} 条旧连接` : ''}`);
      }
      await refresh();
    } catch (error) {
      if (currentActionSession.current === actionSession)
        notify(error instanceof Error ? error.message : '切换失败，请重试', 'error');
    } finally {
      activeSelections.current.delete(actionKey);
    }
  };
  const testDelay = async (group: string): Promise<Record<string, number> | undefined> => {
    if (demo) {
      setProxiesDemo((current) => {
        const node = current[group];
        return node ? { ...current, [group]: { ...node, fixed: undefined } } : current;
      });
      notify('演示模式展示的是示例延迟', 'info');
      return Object.fromEntries(
        (proxies[group]?.all ?? []).flatMap((name) => {
          const delay = proxies[name]?.history.at(-1)?.delay;
          return delay === undefined ? [] : [[name, delay]];
        }),
      );
    }
    if (client) {
      let measured: Record<string, number> | undefined;
      const success = await runAction(async () => {
        const node = proxies[group];
        measured = await client.groupDelay(
          group,
          node?.testUrl || undefined,
          5_000,
          node?.expectedStatus || undefined,
        );
      }, '延迟测试完成');
      return success ? measured : undefined;
    }
    return undefined;
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
  const testNodeDelay = async (name: string, group?: string): Promise<number | undefined> => {
    if (demo) {
      notify('演示模式展示的是示例延迟', 'info');
      return proxies[name]?.history.at(-1)?.delay;
    }
    if (!client) return;
    let measured: number | undefined;
    const candidates = Object.entries(providersQuery.data ?? {}).filter(([, item]) =>
      item.proxies.some((node) => node.name === name),
    );
    const coreNode = proxiesQuery.data?.proxies[name];
    const declaredProvider = proxies[name]?.['provider-name'];
    const provider = declaredProvider
      ? candidates.find(([providerName]) => providerName === declaredProvider)
      : !coreNode && candidates.length === 1
        ? candidates[0]
        : undefined;
    if (declaredProvider && !provider) {
      notify('暂未确认节点所属代理集，请刷新资源后重试。', 'info');
      return;
    }
    if (!coreNode && candidates.length > 1 && !provider) {
      notify('多个代理集包含同名节点，请在资源页选择具体代理集后测速。', 'info');
      return;
    }
    const targetGroup = group ? proxies[group] : undefined;
    await runAction(async () => {
      const result =
        provider && provider[1].vehicleType !== 'Compatible'
          ? await client.providerProxyDelay(provider[0], name, targetGroup?.testUrl || undefined)
          : await client.delay(
              name,
              targetGroup?.testUrl || undefined,
              5000,
              targetGroup?.expectedStatus,
            );
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
    coreProxies: demo ? proxiesDemo : (proxiesQuery.data?.proxies ?? {}),
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
    connectionHistory: connectionHistoryState.closed,
    connectionsStream,
    clearConnectionHistory: () => dispatchConnectionHistory({ type: 'clear' }),
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
    reloadConfig,
    selectProxy,
    closeOnSwitch,
    setCloseOnSwitch,
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
