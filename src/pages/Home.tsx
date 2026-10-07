import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Box,
  Check,
  ChevronRight,
  CircuitBoard,
  Clock3,
  Code2,
  Cpu,
  Globe2,
  Layers3,
  Network,
  Play,
  PlugZap,
  Radio,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Wifi,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMihomo } from '../state/mihomo';
import { bytes, relativeDate } from '../lib/format';
import { Badge, PageHeader, Toggle } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';
import type { ProxyMode, ProxyNode } from '../lib/types';
import './home.css';

const modes: Array<{ key: ProxyMode; name: string; description: string; icon: LucideIcon }> = [
  { key: 'rule', name: '规则模式', description: '按匹配规则选择出口', icon: Route },
  { key: 'global', name: '全局模式', description: '遵循 GLOBAL 组选择', icon: Globe2 },
  { key: 'direct', name: '直连模式', description: '由内核直接连接目标', icon: ArrowUpRight },
];
const groupTypes = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
const defaultTestUrl = 'https://www.gstatic.com/generate_204';

function readGroupPreference(scope: string): string {
  try {
    return localStorage.getItem(`mihomo-verge.home-group:${scope}`) ?? '';
  } catch {
    return '';
  }
}

function resolveExit(
  proxies: Record<string, ProxyNode>,
  initial: string,
): { chain: ProxyNode[]; leaf?: ProxyNode; reason?: string } {
  const chain: ProxyNode[] = [];
  const visited = new Set<string>();
  let name = initial;
  while (name) {
    if (visited.has(name)) return { chain, reason: '代理组存在循环引用' };
    visited.add(name);
    const proxy = proxies[name];
    if (!proxy) return { chain, reason: `暂未获取到 ${name} 的信息` };
    chain.push(proxy);
    if (proxy.type === 'LoadBalance') return { chain, reason: '由内核为每条连接分配出口' };
    if (!proxy.all && !groupTypes.has(proxy.type)) return { chain, leaf: proxy };
    if (!proxy.now) return { chain, reason: '内核尚未返回当前组成员' };
    name = proxy.now;
  }
  return { chain, reason: '尚未选择代理组' };
}

function groupTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    Selector: '手动选择',
    URLTest: '延迟优选',
    Fallback: '故障转移',
    LoadBalance: '负载均衡',
  };
  return labels[type] ?? type;
}

function latencyLabel(delay: number | undefined): string {
  return delay === undefined ? '未测试' : delay <= 0 ? '超时' : `${delay} ms`;
}

function ProxyExitCard() {
  const state = useMihomo();
  const scope = state.demo ? 'demo' : (state.profile?.url ?? 'offline');
  const storedGroup = useMemo(() => readGroupPreference(scope), [scope]);
  const [preference, setPreference] = useState({ scope: '', name: '' });
  const [pending, setPending] = useState<'select' | 'test' | null>(null);
  const [measurement, setMeasurement] = useState<{
    key: string;
    delay?: number;
    failed?: boolean;
  } | null>(null);
  const groups = Object.values(state.proxies).filter(
    (proxy) => proxy.all && !proxy.hidden && proxy.name !== 'GLOBAL',
  );
  const preferred = preference.scope === scope ? preference.name : storedGroup;
  const isGlobal = state.config?.mode === 'global';
  const isDirect = state.config?.mode === 'direct';
  const group = isGlobal
    ? state.proxies.GLOBAL
    : isDirect
      ? undefined
      : (groups.find((item) => item.name === preferred) ??
        groups.find((item) => item.type === 'Selector') ??
        groups[0]);
  const route = resolveExit(state.proxies, isDirect ? 'DIRECT' : (group?.name ?? ''));
  const leaf = route.leaf;
  const automatic = group?.type === 'URLTest' || group?.type === 'Fallback';
  const selectable = group?.type === 'Selector' || automatic;
  const containingProviders = Object.entries(state.providers).filter(
    ([, provider]) =>
      provider.vehicleType !== 'Compatible' &&
      provider.proxies.some((node) => node.name === leaf?.name),
  );
  const declaredProvider = leaf?.['provider-name'];
  const providerName =
    declaredProvider && state.providers[declaredProvider]?.vehicleType !== 'Compatible'
      ? declaredProvider
      : containingProviders.length === 1
        ? containingProviders[0]?.[0]
        : undefined;
  const ambiguousProvider = !declaredProvider && containingProviders.length > 1;
  const testUrl = group?.testUrl || defaultTestUrl;
  const measurementKey = JSON.stringify([scope, leaf?.name, providerName, testUrl]);
  const currentMeasurement = measurement?.key === measurementKey ? measurement : null;
  const delay = currentMeasurement ? currentMeasurement.delay : leaf?.history.at(-1)?.delay;
  const delayTone =
    delay === undefined
      ? 'neutral'
      : delay <= 0 || delay >= 500
        ? 'red'
        : delay >= 200
          ? 'orange'
          : 'green';
  const canTest =
    state.connected &&
    !!leaf &&
    !/^(reject|pass)$/i.test(leaf.type) &&
    !ambiguousProvider &&
    !pending;

  function chooseGroup(name: string) {
    setPreference({ scope, name });
    try {
      localStorage.setItem(`mihomo-verge.home-group:${scope}`, name);
    } catch {
      /* The selected group remains available for this page session. */
    }
  }

  async function chooseMember(name: string) {
    if (!state.connected || !group || !selectable || pending) return;
    if (group.type === 'Selector' && (!name || name === group.now)) return;
    setPending('select');
    try {
      if (!name && automatic) await state.clearProxySelection(group.name);
      else if (group.all?.includes(name)) await state.selectProxy(group.name, name);
    } finally {
      setPending(null);
    }
  }

  async function testExit() {
    if (!canTest || !leaf) return;
    if (state.demo) return state.notify('演示模式展示的是示例延迟', 'info');
    const client = state.client;
    if (!client) return;
    setPending('test');
    try {
      const success = await state.runAction(async () => {
        const result = providerName
          ? await client.providerProxyDelay(providerName, leaf.name, testUrl, 5000)
          : await client.delay(leaf.name, testUrl, 5000, group?.expectedStatus);
        setMeasurement({ key: measurementKey, delay: result.delay });
      });
      if (!success) setMeasurement({ key: measurementKey, failed: true });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel current-proxy-panel home-detail-card">
      <div className="panel-header">
        <div className="panel-title">
          <Wifi size={18} />
          <h2>代理组出口</h2>
        </div>
        <Link className="icon-button" to="/proxies" aria-label="管理代理组">
          <ChevronRight size={18} />
        </Link>
      </div>
      {!state.connected ? (
        <div className="compact-empty">
          <Wifi size={26} strokeWidth={1.3} />
          <p>连接内核后查看代理组与出口</p>
          <Link className="button small" to="/settings">
            连接内核
          </Link>
        </div>
      ) : (
        <div className="home-card-content">
          <label className="home-select-field">
            <span>关注的代理组</span>
            <select
              className="field"
              aria-label="首页代理组"
              value={isDirect ? 'DIRECT' : (group?.name ?? '')}
              disabled={isGlobal || isDirect || !groups.length || !!pending}
              onChange={(event) => chooseGroup(event.target.value)}
            >
              {isDirect ? (
                <option value="DIRECT">DIRECT · 直连模式</option>
              ) : isGlobal ? (
                <option value="GLOBAL">GLOBAL · 全局模式</option>
              ) : groups.length ? (
                groups.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))
              ) : (
                <option value="">暂无代理组</option>
              )}
            </select>
          </label>
          {group && (
            <label className="home-select-field">
              <span>
                {automatic ? '自动策略' : '当前成员'}
                <small>{groupTypeLabel(group.type)}</small>
              </span>
              <select
                className="field"
                aria-label="首页代理组成员"
                value={automatic ? (group.fixed ?? '') : (group.now ?? '')}
                disabled={!selectable || !!pending}
                onChange={(event) => void chooseMember(event.target.value)}
              >
                {automatic && (
                  <option value="">跟随自动选择{group.now ? ` · ${group.now}` : ''}</option>
                )}
                {!automatic && !group.now && (
                  <option value="">
                    {group.type === 'LoadBalance' ? '按连接分配' : '尚未选择'}
                  </option>
                )}
                {(group.all ?? []).map((name) => (
                  <option key={name} value={name} disabled={!state.proxies[name]}>
                    {automatic ? '固定 · ' : ''}
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="home-exit-summary">
            <span className="proxy-avatar">
              <Zap size={21} />
            </span>
            <div>
              <span className="home-field-caption">{isDirect ? '当前出站' : '最终出口'}</span>
              <strong title={leaf?.name ?? route.reason}>
                {leaf?.name ??
                  (isDirect
                    ? 'DIRECT'
                    : group?.type === 'LoadBalance'
                      ? '负载均衡'
                      : '出口暂不可用')}
              </strong>
              <span className="home-exit-meta">
                {leaf ? [leaf.type, providerName].filter(Boolean).join(' · ') : route.reason}
              </span>
            </div>
          </div>
          {route.chain.length > 2 && (
            <div
              className="home-proxy-path"
              title={route.chain.map((node) => node.name).join(' → ')}
            >
              {route.chain.map((node, index) => (
                <span key={`${index}:${node.name}`}>
                  {index > 0 && <ChevronRight size={12} />}
                  {node.name}
                </span>
              ))}
            </div>
          )}
          <div className="home-card-row">
            <span>内核延迟</span>
            <div className="home-row-actions">
              <Badge tone={currentMeasurement?.failed ? 'red' : delayTone}>
                {pending === 'test'
                  ? '测试中'
                  : currentMeasurement?.failed
                    ? '测试失败'
                    : latencyLabel(delay)}
              </Badge>
              <button
                className="icon-button"
                title={
                  ambiguousProvider
                    ? '多个代理集包含同名节点，暂无法确定测试对象'
                    : `测试当前出口 · ${testUrl}`
                }
                aria-label="测试当前出口延迟"
                disabled={!canTest}
                onClick={() => void testExit()}
              >
                <RefreshCw size={15} className={pending === 'test' ? 'spin' : ''} />
              </button>
            </div>
          </div>
          <p className="home-card-note">
            {isDirect
              ? '直连模式由内核直接发起请求。'
              : isGlobal
                ? '全局请求遵循 GLOBAL 的选择。'
                : '仅影响匹配到该组的请求；各连接可以使用不同出口。'}
          </p>
        </div>
      )}
    </section>
  );
}

function ProviderSummaryCard() {
  const state = useMihomo();
  const scope = state.demo ? 'demo' : (state.profile?.url ?? 'offline');
  const providers = Object.values(state.providers);
  const [selection, setSelection] = useState({ scope: '', name: '' });
  const [updating, setUpdating] = useState(false);
  const provider =
    providers.find((item) => selection.scope === scope && item.name === selection.name) ??
    providers.find((item) => item.vehicleType === 'HTTP') ??
    providers[0];
  const usage = provider?.subscriptionInfo;
  const used = usage ? usage.Download + usage.Upload : undefined;
  const hasQuota = !!usage && Number.isFinite(usage.Total) && usage.Total > 0;
  const percent =
    hasQuota && used !== undefined ? Math.max(0, Math.min(100, (used / usage.Total) * 100)) : 0;
  const compatible = provider?.vehicleType === 'Compatible';
  const providerKind =
    provider?.vehicleType === 'HTTP'
      ? '远程集合'
      : provider?.vehicleType === 'File'
        ? '本地文件'
        : compatible
          ? '内置集合'
          : provider?.vehicleType;
  const expire = usage && usage.Expire > 0 ? new Date(usage.Expire * 1000) : null;
  const expired = expire && Number.isFinite(expire.getTime()) && expire.getTime() < Date.now();
  const alive =
    provider?.proxies.filter(
      (node) =>
        node.alive === true || (node.alive === undefined && (node.history.at(-1)?.delay ?? 0) > 0),
    ).length ?? 0;

  async function updateProvider() {
    if (!state.connected || !provider || compatible || updating) return;
    if (state.demo) return state.notify('演示模式不会更新真实代理集', 'info');
    const client = state.client;
    if (!client) return;
    setUpdating(true);
    try {
      await state.runAction(
        () => client.updateProvider(provider.name),
        `已更新代理集 ${provider.name}`,
      );
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section className="panel subscription-panel home-detail-card">
      <div className="panel-header">
        <div className="panel-title">
          <Box size={18} />
          <h2>代理集</h2>
          <Badge>{providers.length}</Badge>
        </div>
        <Link className="icon-button" to="/providers" aria-label="管理代理集">
          <ChevronRight size={18} />
        </Link>
      </div>
      {state.connected && provider ? (
        <div className="home-card-content">
          <label className="home-select-field">
            <span>
              查看代理集<small>共 {providers.length} 个</small>
            </span>
            <select
              className="field"
              aria-label="首页代理集"
              value={provider.name}
              disabled={updating}
              onChange={(event) => setSelection({ scope, name: event.target.value })}
            >
              {providers.map((item) => (
                <option value={item.name} key={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="home-provider-summary">
            <span className="subscription-avatar">
              <Layers3 size={21} />
            </span>
            <div>
              <strong>{provider.proxies.length} 个节点</strong>
              <span>
                {providerKind} · 最近可用 {alive} 个
              </span>
            </div>
            <Badge tone={expired ? 'red' : 'neutral'}>
              {expired ? '已到期' : provider.vehicleType}
            </Badge>
          </div>
          <div className="home-card-row">
            <span>已用流量</span>
            <strong>
              {used === undefined
                ? '未提供'
                : hasQuota
                  ? `${bytes(used)} / ${bytes(usage.Total)}`
                  : bytes(used)}
            </strong>
          </div>
          {hasQuota && (
            <div
              className="progress-track home-quota-progress"
              role="progressbar"
              aria-label={`${provider.name} 已用流量`}
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
          <div className="home-card-row">
            <span>到期时间</span>
            <span className={expired ? 'home-expired' : ''}>
              {expire && Number.isFinite(expire.getTime())
                ? expire.toLocaleDateString('zh-CN')
                : '未提供'}
            </span>
          </div>
          <div className="home-card-row">
            <span>最近更新</span>
            <span title={provider.updatedAt}>
              {provider.updatedAt
                ? relativeDate(provider.updatedAt)
                : compatible
                  ? '随主配置加载'
                  : '未提供'}
            </span>
          </div>
          <div className="home-card-footer">
            <span>{compatible ? '内置节点随主配置更新' : '从集合来源重新加载节点'}</span>
            <button
              className="button small"
              disabled={updating || compatible}
              onClick={() => void updateProvider()}
            >
              <RefreshCw size={14} className={updating ? 'spin' : ''} />
              {updating ? '更新中' : '更新'}
            </button>
          </div>
        </div>
      ) : (
        <div className="compact-empty">
          <Box size={26} strokeWidth={1.3} />
          <p>{state.connected ? '当前配置没有代理集' : '连接后查看代理集与用量'}</p>
          <span className="muted">配置中的内置节点仍可直接使用</span>
        </div>
      )}
    </section>
  );
}

export default function Home({ onConnect }: { onConnect: () => void }) {
  const state = useMihomo();
  const [pending, setPending] = useState(false);
  const groupCount = Object.values(state.proxies).filter(
    (proxy) => proxy.all && proxy.name !== 'GLOBAL',
  ).length;
  const coreDisabled = !state.connected || !state.config || pending;
  async function changeMode(mode: ProxyMode) {
    if (coreDisabled || mode === state.config?.mode) return;
    setPending(true);
    try {
      await state.patchConfig({ mode });
    } finally {
      setPending(false);
    }
  }
  async function refresh() {
    if (!state.connected || pending) return;
    setPending(true);
    try {
      await state.refresh();
    } catch (error) {
      state.notify(error instanceof Error ? error.message : '刷新失败', 'error');
    } finally {
      setPending(false);
    }
  }
  const stats = [
    {
      label: '下载速率',
      value: state.connected ? bytes(state.traffic.down) : '—',
      unit: '/s',
      icon: ArrowDownLeft,
      color: 'purple',
      sub: '累计下载',
      total: state.connected ? bytes(state.snapshot.downloadTotal) : '—',
    },
    {
      label: '上传速率',
      value: state.connected ? bytes(state.traffic.up) : '—',
      unit: '/s',
      icon: ArrowUpRight,
      color: 'green',
      sub: '累计上传',
      total: state.connected ? bytes(state.snapshot.uploadTotal) : '—',
    },
    {
      label: '活跃连接',
      value: state.connected ? String(state.snapshot.connections.length) : '—',
      unit: '个',
      icon: Network,
      color: 'blue',
      sub: '实时连接',
      total: state.connected ? '持续监测中' : '等待内核连接',
    },
    {
      label: '内存占用',
      value: state.connected ? bytes(state.memory) : '—',
      unit: '',
      icon: Cpu,
      color: 'orange',
      sub: 'Mihomo 内核',
      total: state.connected ? state.version : '尚未连接',
    },
  ];
  return (
    <div className="page-stack home-page">
      <PageHeader title="概览" description="网络状态，一目了然。">
        <span className="date-label">
          <Clock3 size={14} />
          {new Date().toLocaleDateString('zh-CN', {
            month: 'long',
            day: 'numeric',
            weekday: 'long',
          })}
        </span>
        <button
          className="button small"
          onClick={() => void refresh()}
          disabled={!state.connected || pending}
        >
          <RefreshCw size={15} className={pending ? 'spin' : ''} />
          刷新
        </button>
      </PageHeader>
      {!state.connected && (
        <section className="welcome-panel">
          <div className="welcome-copy">
            <Badge tone="purple">
              <Sparkles size={12} /> 你的网络控制中心
            </Badge>
            <h2>好的连接，从这里开始。</h2>
            <p>
              熟悉的 Verge 体验，轻盈的 Web 界面。
              <br />
              连接 Mihomo 内核，让网络尽在掌握。
            </p>
            <div className="welcome-actions">
              <button className="button primary" onClick={onConnect}>
                <PlugZap size={17} />
                连接内核
                <ArrowRight size={16} />
              </button>
              <button className="button text" onClick={state.startDemo}>
                <Play size={15} />
                体验演示
              </button>
            </div>
          </div>
          <div className="network-art" aria-hidden="true">
            <div className="orbit orbit-outer" />
            <div className="orbit orbit-inner" />
            <div className="network-hub">
              <img src="./favicon.svg" alt="" />
            </div>
            <span className="orbit-node node-a">
              <Globe2 size={23} />
            </span>
            <span className="orbit-node node-b">
              <ShieldCheck size={22} />
            </span>
            <span className="orbit-node node-c">
              <Wifi size={22} />
            </span>
            <span className="orbit-node node-d">
              <Code2 size={20} />
            </span>
            <span className="orbit-spark spark-a" />
            <span className="orbit-spark spark-b" />
          </div>
        </section>
      )}
      <section className="stats-grid" aria-label="实时网络指标">
        {stats.map((stat) => (
          <article className="stat-card" key={stat.label}>
            <div className="stat-header">
              <span>{stat.label}</span>
              <span className={`stat-icon ${stat.color}`}>
                <stat.icon size={19} />
              </span>
            </div>
            <div className="stat-value">
              {stat.value}
              <small>{stat.unit}</small>
            </div>
            <div className="stat-footer">
              <span>{stat.sub}</span>
              <span>{stat.total}</span>
            </div>
          </article>
        ))}
      </section>
      <div className="overview-main-grid">
        <section className="panel traffic-panel">
          <div className="panel-header">
            <div className="panel-title">
              <Activity size={18} />
              <h2>流量趋势</h2>
              <span className={`live-label ${state.live ? '' : 'inactive'}`}>
                <span className={`status-dot ${state.live ? '' : 'offline'}`} />
                {state.live ? '实时' : state.connected ? '重连中' : '未连接'}
              </span>
            </div>
            <div className="chart-legend">
              <span>
                <i className="legend-dot download" />
                下载
              </span>
              <span>
                <i className="legend-dot upload" />
                上传
              </span>
              <span className="chart-period">最近 60 秒</span>
            </div>
          </div>
          <TrafficChart data={state.history} />
          <div className="traffic-summary">
            <span>
              <ArrowDown size={13} />
              下载总量{' '}
              <strong>{state.connected ? bytes(state.snapshot.downloadTotal) : '—'}</strong>
            </span>
            <span>
              <ArrowUp size={13} />
              上传总量 <strong>{state.connected ? bytes(state.snapshot.uploadTotal) : '—'}</strong>
            </span>
            <span className="muted">内核累计</span>
          </div>
        </section>
        <section className="panel mode-panel">
          <div className="panel-header">
            <div className="panel-title">
              <Route size={18} />
              <h2>出站模式</h2>
            </div>
            <Badge tone="purple">{state.config?.mode.toUpperCase() ?? 'OFFLINE'}</Badge>
          </div>
          <div className="mode-options">
            {modes.map(({ key, name, description, icon: Icon }) => (
              <button
                key={key}
                className={`mode-option ${state.config?.mode === key ? 'selected' : ''}`}
                disabled={coreDisabled}
                onClick={() => void changeMode(key)}
              >
                <span className="mode-icon">
                  <Icon size={20} />
                </span>
                <span>
                  <strong>{name}</strong>
                  <small>{description}</small>
                </span>
                <span className="mode-check">
                  {state.config?.mode === key && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            ))}
          </div>
          <div className="mode-footnote">
            <ShieldCheck size={14} />
            {state.demo ? '仅影响演示配置' : '运行配置实时生效'}
          </div>
        </section>
      </div>
      <div className="overview-bottom-grid">
        <ProxyExitCard />
        <ProviderSummaryCard />
        <section className="panel quick-panel home-detail-card">
          <div className="panel-header">
            <div className="panel-title">
              <CircuitBoard size={18} />
              <h2>内核配置</h2>
            </div>
            <Link className="icon-button" to="/settings" aria-label="更多内核设置">
              <ChevronRight size={18} />
            </Link>
          </div>
          <div className="quick-setting">
            <span>
              <Radio size={16} />
              TUN 模式
            </span>
            <Toggle
              label="TUN 模式"
              checked={state.config?.tun?.enable ?? false}
              disabled={coreDisabled || !state.config?.tun}
              onChange={(enable) => {
                setPending(true);
                void state.patchConfig({ tun: { enable } }).finally(() => setPending(false));
              }}
            />
          </div>
          <div className="quick-setting">
            <span>
              <Globe2 size={16} />
              允许局域网
            </span>
            <Toggle
              label="允许局域网"
              checked={state.config?.['allow-lan'] ?? false}
              disabled={coreDisabled}
              onChange={(value) => {
                setPending(true);
                void state.patchConfig({ 'allow-lan': value }).finally(() => setPending(false));
              }}
            />
          </div>
          <div className="quick-setting">
            <span>
              <Network size={16} />
              混合端口
            </span>
            <code>{state.config?.['mixed-port'] ?? '—'}</code>
          </div>
          <div className="quick-setting">
            <span>
              <Route size={16} />
              路由规则
            </span>
            <Link to="/rules" className="home-count-link">
              {state.connected ? `${state.rules.length} 条` : '—'}
              <ChevronRight size={14} />
            </Link>
          </div>
          <div className="quick-setting">
            <span>
              <Layers3 size={16} />
              代理组
            </span>
            <Link to="/proxies" className="home-count-link">
              {state.connected ? `${groupCount} 个` : '—'}
              <ChevronRight size={14} />
            </Link>
          </div>
          <div className="core-footer">
            <span className={`status-dot ${state.connected ? '' : 'offline'}`} />
            <span>{state.connected ? `Mihomo ${state.version}` : '等待连接 Mihomo'}</span>
            <Badge>{state.demo ? 'DEMO' : 'CORE'}</Badge>
          </div>
        </section>
      </div>
    </div>
  );
}
