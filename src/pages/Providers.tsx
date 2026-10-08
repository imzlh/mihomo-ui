import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowDownUp,
  Box,
  CalendarClock,
  Check,
  CloudDownload,
  List,
  RefreshCw,
  ScrollText,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Modal, PageHeader, SearchInput, Spinner } from '../components/ui';
import { bytes, relativeDate } from '../lib/format';
import type { ProxyNode, RuleProvider } from '../lib/types';
import type { MihomoClient } from '../lib/mihomo';
import { describeProxyDelay } from '../lib/proxy-delay';
import { createProxyDelayStore, proxyDelayKey } from '../lib/proxy-delay-store';
import { useTableSort, type SortAccessor } from '../hooks/use-table-sort';
import { useMihomo } from '../state/mihomo';
import './resources.css';
import './providers.css';

type RuleSort = 'name' | 'behavior' | 'count' | 'updated';
const ruleAccessors: Record<RuleSort, SortAccessor<RuleProvider>> = {
  name: (provider) => provider.name,
  behavior: (provider) => provider.behavior,
  count: (provider) => provider.ruleCount,
  updated: (provider) => (provider.updatedAt ? Date.parse(provider.updatedAt) : undefined),
};
// Provider-scoped identities must not share the proxy page's name-only pending keys.
const providerDelayStores = new WeakMap<MihomoClient, ReturnType<typeof createProxyDelayStore>>();
function providerDelayStore(client: MihomoClient) {
  let store = providerDelayStores.get(client);
  if (!store) {
    store = createProxyDelayStore();
    providerDelayStores.set(client, store);
  }
  return store;
}

function nodeHistoryKey(node: ProxyNode): string {
  const last = node.history.at(-1);
  return last ? `${last.time}:${last.delay}` : '';
}

function ProviderNodes({ name, onClose }: { name: string; onClose: () => void }) {
  const { providers, client, connected, demo, runAction, notify } = useMihomo();
  const [query, setQuery] = useState('');
  const store = useMemo(
    () => (client ? providerDelayStore(client) : createProxyDelayStore()),
    [client],
  );
  const delayState = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const provider = providers[name];
  const busy = (provider?.proxies ?? []).some((node) =>
    delayState.nodes.has(proxyDelayKey(name, node.name)),
  );
  const nodeDelays = useMemo(
    () =>
      new Map(
        (provider?.proxies ?? []).map((node) => {
          const identity = proxyDelayKey(name, node.name);
          const result = delayState.results.get(proxyDelayKey(name, identity));
          const currentResult = result?.historyKey === nodeHistoryKey(node) ? result : undefined;
          return [
            node.name,
            describeProxyDelay(currentResult ? currentResult.delay : node.history.at(-1)?.delay, {
              failed: Boolean(currentResult && currentResult.delay === undefined),
              testing: delayState.nodes.has(identity),
            }),
          ];
        }),
      ),
    [delayState, name, provider],
  );
  const nodeAccessors: Record<'name' | 'type' | 'delay', SortAccessor<ProxyNode>> = useMemo(
    () => ({
      name: (node) => node.name,
      type: (node) => node.type,
      delay: (node) => {
        const result = nodeDelays.get(node.name);
        return result?.state === 'measured' ? result.value : undefined;
      },
    }),
    [nodeDelays],
  );
  const nodes = useMemo(
    () =>
      (provider?.proxies ?? []).filter((node) =>
        `${node.name} ${node.type}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [provider, query],
  );
  const { sortedRows, toggleSort, ariaSort } = useTableSort<ProxyNode, 'name' | 'type' | 'delay'>(
    nodes,
    nodeAccessors,
    { key: 'name', direction: 'asc' },
  );
  async function testNode(node: ProxyNode) {
    if (demo) return notify('演示模式展示示例延迟', 'info');
    const identity = proxyDelayKey(name, node.name);
    if (!client || !connected || busy || !store.beginNode(identity)) return;
    let settled = false;
    try {
      await runAction(async () => {
        const result =
          provider?.vehicleType.toLowerCase() === 'compatible'
            ? await client.delay(node.name)
            : await client.providerProxyDelay(name, node.name);
        store.finishNode(name, identity, {
          delay: result.delay,
          historyKey: nodeHistoryKey(node),
        });
        settled = true;
      }, '节点延迟测试完成');
    } finally {
      if (!settled)
        store.finishNode(name, identity, { delay: undefined, historyKey: nodeHistoryKey(node) });
    }
  }
  return (
    <Modal
      title={name}
      description={`${provider?.proxies.length ?? 0} 个节点 · 点击表头排序`}
      onClose={onClose}
      wide
    >
      <div className="provider-nodes-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="搜索节点或协议" />
      </div>
      <div className="table-wrap provider-nodes-table">
        <table className="data-table">
          <thead>
            <tr>
              {(
                [
                  ['name', '节点'],
                  ['type', '协议'],
                  ['delay', '延迟'],
                ] as const
              ).map(([key, label]) => (
                <th key={key} aria-sort={ariaSort(key)}>
                  <button className="table-sort-button" onClick={() => toggleSort(key)}>
                    {label}
                    <ArrowDownUp size={14} />
                  </button>
                </th>
              ))}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((node) => {
              const delay = nodeDelays.get(node.name) ?? describeProxyDelay(undefined);
              return (
                <tr key={node.name}>
                  <td>{node.name}</td>
                  <td>
                    <Badge>{node.type}</Badge>
                    {node.udp && <span className="provider-udp">UDP</span>}
                  </td>
                  <td>
                    <span
                      className={delay.state === 'measured' ? 'provider-node-latency' : 'muted'}
                      title={delay.label}
                      style={delay.tone === 'red' ? { color: 'var(--red)' } : undefined}
                    >
                      {delay.state === 'testing'
                        ? '测试中'
                        : delay.state === 'untested'
                          ? '未测试'
                          : delay.state === 'measured'
                            ? `${delay.text} ms`
                            : delay.text}
                    </span>
                  </td>
                  <td>
                    <button
                      className="button small"
                      disabled={busy || (!connected && !demo)}
                      onClick={() => void testNode(node)}
                    >
                      {delay.state === 'testing' ? <Spinner /> : <Activity size={14} />}测速
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!nodes.length && <EmptyState title="没有匹配的节点" description="试试其他名称或协议。" />}
    </Modal>
  );
}

export default function Providers() {
  const { connected, demo, client, providers, ruleProviders, runAction, refresh, notify } =
    useMihomo();
  const [tab, setTab] = useState<'proxies' | 'rules'>('proxies');
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState('name');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      Object.entries(providers)
        .filter(([name]) => name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort(([a, left], [b, right]) =>
          order === 'nodes'
            ? right.proxies.length - left.proxies.length || a.localeCompare(b)
            : order === 'updated'
              ? (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0)
              : a.localeCompare(b, 'zh-CN', { numeric: true }),
        ),
    [providers, query, order],
  );
  const filteredRules = useMemo(
    () =>
      Object.values(ruleProviders).filter((provider) =>
        `${provider.name} ${provider.behavior}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [ruleProviders, query],
  );
  const { sortedRows, toggleSort, ariaSort } = useTableSort<RuleProvider, RuleSort>(
    filteredRules,
    ruleAccessors,
    { key: 'name', direction: 'asc' },
  );
  const totalNodes = Object.values(providers).reduce(
    (total, provider) => total + provider.proxies.length,
    0,
  );

  async function providerAction(name: string, action: 'update' | 'health' | 'rule') {
    if (demo) return notify('演示模式下不会修改实际内核', 'info');
    if (!client || !connected || busy[name]) return;
    setBusy((current) => ({ ...current, [name]: action }));
    try {
      await runAction(
        () =>
          action === 'update'
            ? client.updateProvider(name)
            : action === 'health'
              ? client.healthcheckProvider(name)
              : client.updateRuleProvider(name),
        action === 'health' ? `${name} 健康检查已完成` : `${name} 已更新`,
      );
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
  }
  async function refreshProviders() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="page-stack">
      <PageHeader title="资源" description="查看与更新内核已加载的代理集和规则集。">
        <button
          className="button"
          onClick={() => void refreshProviders()}
          disabled={refreshing || !connected}
        >
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          刷新列表
        </button>
      </PageHeader>
      {!connected ? (
        <div className="panel">
          <EmptyState
            icon={CloudDownload}
            title="连接内核后管理资源"
            description="配置中的代理集与规则集将在这里显示。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="provider-page-controls">
            <div className="segmented" role="tablist" aria-label="资源类型">
              <button
                role="tab"
                aria-selected={tab === 'proxies'}
                className={tab === 'proxies' ? 'active' : ''}
                onClick={() => {
                  setTab('proxies');
                  setQuery('');
                }}
              >
                <Box size={16} />
                代理集 <span>{Object.keys(providers).length}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === 'rules'}
                className={tab === 'rules' ? 'active' : ''}
                onClick={() => {
                  setTab('rules');
                  setQuery('');
                }}
              >
                <ScrollText size={16} />
                规则集 <span>{Object.keys(ruleProviders).length}</span>
              </button>
            </div>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={tab === 'proxies' ? '搜索代理集…' : '搜索规则集…'}
            />
          </div>
          {tab === 'proxies' ? (
            <>
              <div className="toolbar">
                <span className="muted">
                  {Object.keys(providers).length} 个代理集，共 {totalNodes} 个节点
                </span>
                <label className="provider-order">
                  排序
                  <select
                    aria-label="代理集排序"
                    value={order}
                    onChange={(event) => setOrder(event.target.value)}
                  >
                    <option value="name">名称</option>
                    <option value="nodes">节点数量</option>
                    <option value="updated">更新时间</option>
                  </select>
                </label>
              </div>
              {!entries.length ? (
                <div className="panel">
                  <EmptyState
                    icon={Box}
                    title={query ? '没有匹配的代理集' : '配置中暂无代理集'}
                    description={
                      query ? '试试其他名称。' : '代理集随内核配置加载，支持刷新已有来源。'
                    }
                  />
                </div>
              ) : (
                <div className="provider-grid">
                  {entries.map(([name, provider]) => {
                    const subscription = provider.subscriptionInfo;
                    const used = subscription ? subscription.Download + subscription.Upload : 0;
                    const hasQuota = subscription && subscription.Total > 0;
                    const percent = hasQuota
                      ? Math.min(100, Math.max(0, (used / subscription.Total) * 100))
                      : 0;
                    const expired = Boolean(
                      subscription?.Expire && subscription.Expire * 1000 < Date.now(),
                    );
                    const healthy = provider.proxies.filter(
                      (proxy) =>
                        proxy.alive === true ||
                        (proxy.alive !== false && (proxy.history.at(-1)?.delay ?? 0) > 0),
                    ).length;
                    const compatible = provider.vehicleType.toLowerCase() === 'compatible';
                    const working = busy[name];
                    return (
                      <article className="panel provider-card" key={name}>
                        <div className="provider-card-heading">
                          <span className="provider-icon">
                            <CloudDownload size={23} />
                          </span>
                          <div className="provider-heading-text">
                            <h3 title={name}>{name}</h3>
                            <span className="muted">
                              {provider.vehicleType || provider.type} · {provider.proxies.length}{' '}
                              个节点
                            </span>
                          </div>
                          <Badge tone={expired ? 'red' : 'purple'}>
                            {expired ? '已到期' : compatible ? '内置' : provider.vehicleType}
                          </Badge>
                        </div>
                        {subscription ? (
                          <>
                            <div className="provider-quota">
                              <div>
                                <span className="muted">已用流量</span>
                                <strong>
                                  {bytes(used)}
                                  {hasQuota && <small> / {bytes(subscription.Total)}</small>}
                                </strong>
                              </div>
                              {hasQuota && (
                                <span
                                  className={percent >= 90 ? 'provider-quota-warning' : 'muted'}
                                >
                                  {percent.toFixed(1)}%
                                </span>
                              )}
                            </div>
                            {hasQuota && (
                              <div
                                className={`progress-track provider-progress${percent >= 90 ? ' is-warning' : ''}`}
                                role="progressbar"
                                aria-label={`${name} 已用流量`}
                                aria-valuenow={Math.round(percent)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              >
                                <div className="progress-fill" style={{ width: `${percent}%` }} />
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="provider-no-quota muted">此来源未提供流量用量</p>
                        )}
                        <div className="provider-info">
                          <span>
                            <CalendarClock size={14} />
                            {subscription?.Expire
                              ? `${new Date(subscription.Expire * 1000).toLocaleDateString('zh-CN')} 到期`
                              : '未提供到期时间'}
                          </span>
                          <span title="最近一次健康检查的可用节点">
                            <Check size={14} />
                            {healthy} / {provider.proxies.length} 可用
                          </span>
                        </div>
                        <button className="button provider-browse" onClick={() => setDetails(name)}>
                          <List size={16} />
                          查看节点<Badge>{provider.proxies.length}</Badge>
                        </button>
                        <div className="provider-card-footer">
                          <span className="resource-subline">
                            {compatible ? '随主配置更新' : relativeDate(provider.updatedAt)}
                          </span>
                          <div className="provider-actions">
                            <button
                              className="icon-button"
                              aria-label={`检查 ${name} 的节点健康状态`}
                              disabled={!!working}
                              onClick={() => void providerAction(name, 'health')}
                            >
                              <Activity size={17} className={working === 'health' ? 'spin' : ''} />
                            </button>
                            <button
                              className="button small"
                              disabled={!!working || compatible}
                              title={compatible ? '内置代理集随主配置更新' : '刷新该来源的节点'}
                              onClick={() => void providerAction(name, 'update')}
                            >
                              <ArrowDownToLine
                                size={14}
                                className={working === 'update' ? 'spin' : ''}
                              />
                              {working ? '处理中…' : '更新'}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <section className="panel">
              {!sortedRows.length ? (
                <EmptyState
                  icon={ScrollText}
                  title={query ? '没有匹配的规则集' : '配置中暂无规则集'}
                  description="在内核配置中加载 rule-providers 后显示。"
                />
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {(
                          [
                            ['name', '规则集'],
                            ['behavior', '匹配类型'],
                            ['count', '规则数量'],
                            ['updated', '更新时间'],
                          ] as const
                        ).map(([key, label]) => (
                          <th key={key} aria-sort={ariaSort(key)}>
                            <button className="table-sort-button" onClick={() => toggleSort(key)}>
                              {label}
                              <ArrowDownUp size={14} />
                            </button>
                          </th>
                        ))}
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((provider) => (
                        <tr key={provider.name}>
                          <td>
                            <strong>{provider.name}</strong>
                            <span className="resource-subline">
                              {provider.vehicleType} · {provider.format}
                            </span>
                          </td>
                          <td>
                            <Badge>{provider.behavior}</Badge>
                          </td>
                          <td>{provider.ruleCount.toLocaleString()}</td>
                          <td>{relativeDate(provider.updatedAt)}</td>
                          <td>
                            <button
                              className="button small"
                              disabled={
                                !!busy[provider.name] ||
                                provider.vehicleType.toLowerCase() === 'inline'
                              }
                              onClick={() => void providerAction(provider.name, 'rule')}
                            >
                              <RefreshCw size={14} className={busy[provider.name] ? 'spin' : ''} />
                              更新
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          <p className="resource-hint">
            <Box size={15} />
            更新只刷新所选资源的内容；运行配置由内核加载。
          </p>
        </>
      )}
      {details && <ProviderNodes name={details} onClose={() => setDetails(null)} />}
    </div>
  );
}
