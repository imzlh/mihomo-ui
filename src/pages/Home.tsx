import { useEffect, useMemo, useState } from 'react';
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
  SlidersHorizontal,
  Sparkles,
  Wifi,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMihomo } from '../state/mihomo';
import { bytes, relativeDate } from '../lib/format';
import { Badge, Modal, PageHeader, Toggle } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';
import type { ProxyMode } from '../lib/types';
import {
  DEFAULT_HOME_PREFERENCES,
  HOME_CARD_OPTIONS,
  readHomePreferences,
  writeHomePreferences,
  type HomePreferences,
  type HomeMemberSort,
} from '../lib/preferences';
import { resolveHomeExit, resolveHomeProvider, sortHomeMembers } from '../lib/home-proxies';
import { useHomeDelay } from '../hooks/use-home-delay';
import { usePageVisible } from '../hooks/use-page-visible';
import { PREFERENCES_CHANGED } from '../lib/preference-events';
import './home.css';

const modes: Array<{ key: ProxyMode; name: string; description: string; icon: LucideIcon }> = [
  { key: 'rule', name: '规则模式', description: '按匹配规则选择出口', icon: Route },
  { key: 'global', name: '全局模式', description: '遵循 GLOBAL 组选择', icon: Globe2 },
  { key: 'direct', name: '直连模式', description: '由内核直接连接目标', icon: ArrowUpRight },
];
const defaultTestUrl = 'https://www.gstatic.com/generate_204';

function readGroupPreference(scope: string): string {
  try {
    return localStorage.getItem(`mihomo-verge.home-group:${scope}`) ?? '';
  } catch {
    return '';
  }
}

function readProviderPreference(scope: string): string {
  try {
    return localStorage.getItem(`mihomo-verge.home-provider:${scope}`) ?? '';
  } catch {
    return '';
  }
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

function ProxyExitCard({
  preferences,
  onSortChange,
  visible,
}: {
  preferences: HomePreferences;
  onSortChange: (sort: HomeMemberSort) => void;
  visible: boolean;
}) {
  const state = useMihomo();
  const scope = state.demo ? 'demo' : (state.profile?.url ?? 'offline');
  const storedGroup = useMemo(() => readGroupPreference(scope), [scope]);
  const [preference, setPreference] = useState({ scope: '', name: '' });
  useEffect(() => {
    const sync = () => setPreference({ scope, name: readGroupPreference(scope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);
  const [pending, setPending] = useState(false);
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
  const route = resolveHomeExit(state.proxies, isDirect ? 'DIRECT' : (group?.name ?? ''));
  const leaf = route.leaf;
  const automatic = group?.type === 'URLTest' || group?.type === 'Fallback';
  const selectable = group?.type === 'Selector' || automatic;
  const source = resolveHomeProvider(leaf, state.providers, state.coreProxies);
  const providerName = source.providerName;
  const testUrl = group?.testUrl || defaultTestUrl;
  const measurementKey = JSON.stringify([
    scope,
    state.config?.mode,
    route.chain.map((node) => node.name),
    providerName,
    testUrl,
    group?.expectedStatus,
  ]);
  const testable =
    state.connected && !!leaf && !/^(reject|pass)$/i.test(leaf.type) && !source.reason;
  const { measurement, run: runDelay } = useHomeDelay({
    client: state.client,
    active: testable && visible && !state.demo && !pending,
    autoDelay: preferences.autoDelay,
    intervalMinutes: preferences.autoDelayMinutes,
    identity: measurementKey,
    name: leaf?.name,
    providerName,
    testUrl,
    expectedStatus: group?.expectedStatus,
    onError: state.notify,
  });
  const testing = measurement?.status === 'testing';
  const failed = measurement?.status === 'error';
  const delay =
    measurement?.status === 'success' ? measurement.delay : source.node?.history.at(-1)?.delay;
  const delayTone =
    delay === undefined
      ? 'neutral'
      : delay <= 0 || delay >= 500
        ? 'red'
        : delay >= 200
          ? 'orange'
          : 'green';
  const canTest = testable && visible && !pending && !testing;
  const memberDelay = (name: string) => {
    const member = resolveHomeExit(state.proxies, name).leaf;
    const resolved = resolveHomeProvider(member, state.providers, state.coreProxies);
    if (resolved.reason) return undefined;
    return member?.name === leaf?.name && measurement?.status === 'success'
      ? measurement.delay
      : resolved.node?.history.at(-1)?.delay;
  };
  const members = sortHomeMembers(group?.all ?? [], preferences.memberSort, memberDelay);

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
    setPending(true);
    try {
      if (!name && automatic) await state.clearProxySelection(group.name);
      else if (group.all?.includes(name)) await state.selectProxy(group.name, name);
    } finally {
      setPending(false);
    }
  }

  function testExit() {
    if (!canTest || !leaf) return;
    if (state.demo) return state.notify('演示模式展示的是示例延迟', 'info');
    void runDelay();
  }

  return (
    <section className="panel home-section current-proxy-panel home-detail-card">
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
                {members.map((name) => (
                  <option key={name} value={name} disabled={!state.proxies[name]}>
                    {automatic ? '固定 · ' : ''}
                    {name}
                    {preferences.memberSort === 'delay' && ` · ${latencyLabel(memberDelay(name))}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {group && (
            <label className="home-sort-field">
              <span>成员排序</span>
              <select
                className="field"
                aria-label="首页成员排序"
                value={preferences.memberSort}
                onChange={(event) => onSortChange(event.target.value as HomeMemberSort)}
              >
                <option value="default">默认顺序</option>
                <option value="delay">延迟优先</option>
                <option value="name">名称顺序</option>
              </select>
            </label>
          )}
          <div className="home-exit-summary">
            <div className="home-exit-identity">
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
                {source.reason ??
                  (leaf ? [leaf.type, providerName].filter(Boolean).join(' · ') : route.reason)}
              </span>
            </div>
            <div className="home-exit-delay">
              <span className="home-field-caption">内核延迟</span>
              <div className="home-row-actions">
                <Badge tone={failed ? 'red' : delayTone}>
                  {testing ? '测试中' : failed ? '测试失败' : latencyLabel(delay)}
                </Badge>
                <button
                  className="icon-button"
                  title={source.reason ?? `测试当前出口 · ${testUrl}`}
                  aria-label="测试当前出口延迟"
                  disabled={!canTest}
                  onClick={() => void testExit()}
                >
                  <RefreshCw size={15} className={testing ? 'spin' : ''} />
                </button>
              </div>
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
          {preferences.autoDelay && (
            <span className="home-auto-delay-note">
              {state.demo
                ? '演示模式使用示例延迟'
                : testable
                  ? `自动测速 · 每 ${preferences.autoDelayMinutes} 分钟`
                  : '自动测速暂停 · 暂无可测试的出口'}
            </span>
          )}
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
  const storedProvider = useMemo(() => readProviderPreference(scope), [scope]);
  const [selection, setSelection] = useState({ scope: '', name: '' });
  const preferredProvider = selection.scope === scope ? selection.name : storedProvider;
  useEffect(() => {
    const sync = () => setSelection({ scope, name: readProviderPreference(scope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);
  const [updating, setUpdating] = useState(false);
  const provider =
    providers.find((item) => item.name === preferredProvider) ??
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
    <section className="panel home-section subscription-panel home-detail-card">
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
            <span>查看代理集</span>
            <select
              className="field"
              aria-label="首页代理集"
              value={provider.name}
              disabled={updating}
              onChange={(event) => {
                const name = event.target.value;
                setSelection({ scope, name });
                try {
                  localStorage.setItem(`mihomo-verge.home-provider:${scope}`, name);
                } catch {
                  state.notify('代理集选择仅在当前页面生效，浏览器未允许保存', 'info');
                }
              }}
            >
              {providers.map((item) => (
                <option value={item.name} key={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="home-provider-summary">
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

function HomeSettings({
  value,
  onChange,
  onClose,
}: {
  value: HomePreferences;
  onChange: (value: HomePreferences) => void;
  onClose: () => void;
}) {
  const [intervalText, setIntervalText] = useState(String(value.autoDelayMinutes));
  const interval = Number(intervalText);
  const validInterval = Number.isInteger(interval) && interval >= 1 && interval <= 60;
  return (
    <Modal
      title="首页设置"
      description="自动保存到此浏览器，按控制器地址分别记忆。"
      onClose={onClose}
    >
      <div className="home-settings-content">
        <div className="home-settings-cards">
          {HOME_CARD_OPTIONS.map(({ key, label }) => (
            <div className="home-settings-row" key={key}>
              <span>{label}</span>
              <Toggle
                label={`显示${label}`}
                checked={value.cards[key]}
                disabled={key === 'memory' && !value.cards.stats}
                onChange={(checked) =>
                  onChange({ ...value, cards: { ...value.cards, [key]: checked } })
                }
              />
            </div>
          ))}
        </div>
        <label className="home-settings-row">
          <span>流量图表样式</span>
          <select
            className="field"
            aria-label="流量图表样式"
            value={value.chartStyle}
            onChange={(event) =>
              onChange({ ...value, chartStyle: event.target.value === 'line' ? 'line' : 'area' })
            }
          >
            <option value="area">面积图</option>
            <option value="line">折线图</option>
          </select>
        </label>
        <div className="home-settings-row">
          <span>自动测试当前出口延迟</span>
          <Toggle
            label="自动测试当前出口延迟"
            checked={value.autoDelay}
            onChange={(autoDelay) => onChange({ ...value, autoDelay })}
          />
        </div>
        <label className="home-settings-row">
          <span>测速间隔</span>
          <span className="home-interval-field">
            <input
              className="field"
              type="number"
              aria-label="自动测速间隔（分钟）"
              min={1}
              max={60}
              step={1}
              value={intervalText}
              aria-invalid={!validInterval}
              onChange={(event) => {
                setIntervalText(event.target.value);
                const minutes = event.target.valueAsNumber;
                if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60) {
                  onChange({ ...value, autoDelayMinutes: minutes });
                }
              }}
              onBlur={() => setIntervalText(String(value.autoDelayMinutes))}
            />
            分钟
          </span>
        </label>
        <p className="home-settings-note">
          {validInterval
            ? '仅在首页可见且显示代理组出口卡片时自动测速。演示模式使用示例延迟。'
            : '请输入 1 至 60 的整数，当前继续使用已保存的间隔。'}
        </p>
        <div className="home-settings-actions">
          <button
            className="button"
            onClick={() => {
              onChange({
                ...DEFAULT_HOME_PREFERENCES,
                cards: { ...DEFAULT_HOME_PREFERENCES.cards },
              });
              setIntervalText(String(DEFAULT_HOME_PREFERENCES.autoDelayMinutes));
            }}
          >
            恢复默认
          </button>
          <button className="button primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function Home({ onConnect }: { onConnect: () => void }) {
  const state = useMihomo();
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scope = state.demo ? 'demo' : (state.profile?.url ?? 'offline');
  const storedPreferences = useMemo(() => readHomePreferences(scope), [scope]);
  const [localPreferences, setLocalPreferences] = useState<{
    scope: string;
    value: HomePreferences;
  } | null>(null);
  useEffect(() => {
    const sync = () => setLocalPreferences({ scope, value: readHomePreferences(scope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);
  const preferences =
    localPreferences?.scope === scope ? localPreferences.value : storedPreferences;
  const cards = preferences.cards;
  const visible = usePageVisible();
  function savePreferences(value: HomePreferences) {
    setLocalPreferences({ scope, value });
    writeHomePreferences(scope, value);
  }
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
        <button className="button small" onClick={() => setSettingsOpen(true)}>
          <SlidersHorizontal size={15} />
          首页设置
        </button>
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
      {cards.stats && (
        <section
          className={`stats-grid${cards.memory ? '' : ' without-memory'}`}
          aria-label="实时网络指标"
        >
          {stats
            .filter((stat) => cards.memory || stat.icon !== Cpu)
            .map((stat) => (
              <article className="stat-card" key={stat.label}>
                <div className="stat-header">
                  <span className={`stat-icon ${stat.color}`}>
                    <stat.icon size={15} />
                  </span>
                  <span>{stat.label}</span>
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
      )}
      {(cards.traffic || cards.mode) && (
        <div className="overview-main-grid">
          {cards.traffic && (
            <section className="panel home-section traffic-panel">
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
                  <button
                    className="button small chart-style-button"
                    aria-label="切换流量图表样式"
                    title={`切换为${preferences.chartStyle === 'area' ? '折线图' : '面积图'}`}
                    onClick={() =>
                      savePreferences({
                        ...preferences,
                        chartStyle: preferences.chartStyle === 'area' ? 'line' : 'area',
                      })
                    }
                  >
                    {preferences.chartStyle === 'area' ? '面积图' : '折线图'}
                  </button>
                </div>
              </div>
              <TrafficChart data={state.history} style={preferences.chartStyle} paused={!visible} />
              {!cards.stats && (
                <div className="traffic-summary">
                  <span>
                    <ArrowDown size={13} />
                    下载总量{' '}
                    <strong>{state.connected ? bytes(state.snapshot.downloadTotal) : '—'}</strong>
                  </span>
                  <span>
                    <ArrowUp size={13} />
                    上传总量{' '}
                    <strong>{state.connected ? bytes(state.snapshot.uploadTotal) : '—'}</strong>
                  </span>
                  <span className="muted">内核累计</span>
                </div>
              )}
            </section>
          )}
          {cards.mode && (
            <section className="panel home-section mode-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Route size={18} />
                  <h2>出站模式</h2>
                </div>
                <Badge tone="purple">{state.config?.mode.toUpperCase() ?? 'OFFLINE'}</Badge>
              </div>
              <div className="mode-options" role="group" aria-label="出站模式">
                {modes.map(({ key, name, description, icon: Icon }) => (
                  <button
                    key={key}
                    className={`mode-option ${state.config?.mode === key ? 'selected' : ''}`}
                    aria-pressed={state.config?.mode === key}
                    title={description}
                    disabled={coreDisabled}
                    onClick={() => void changeMode(key)}
                  >
                    <span className="mode-icon">
                      <Icon size={17} />
                    </span>
                    <strong>{name}</strong>
                    <span className="mode-check">
                      {state.config?.mode === key && <Check size={12} strokeWidth={3} />}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mode-description">
                {modes.find((mode) => mode.key === state.config?.mode)?.description ??
                  '连接内核后选择请求的出站方式'}
              </p>
              <div className="mode-footnote">
                <ShieldCheck size={14} />
                {state.demo ? '仅影响演示配置' : '运行配置实时生效'}
              </div>
            </section>
          )}
        </div>
      )}
      {(cards.proxy || cards.providers || cards.core) && (
        <div className="overview-bottom-grid">
          {cards.proxy && (
            <ProxyExitCard
              key={`proxy:${scope}`}
              preferences={preferences}
              visible={visible}
              onSortChange={(memberSort) => savePreferences({ ...preferences, memberSort })}
            />
          )}
          {cards.providers && <ProviderSummaryCard key={`providers:${scope}`} />}
          {cards.core && (
            <section className="panel home-section quick-panel home-detail-card">
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
          )}
        </div>
      )}
      {!cards.stats &&
        !cards.traffic &&
        !cards.mode &&
        !cards.proxy &&
        !cards.providers &&
        !cards.core && (
          <div className="panel compact-empty">
            <SlidersHorizontal size={26} strokeWidth={1.3} />
            <p>首页卡片已隐藏</p>
            <button className="button small" onClick={() => setSettingsOpen(true)}>
              设置显示卡片
            </button>
          </div>
        )}
      {settingsOpen && (
        <HomeSettings
          key={scope}
          value={preferences}
          onChange={savePreferences}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
