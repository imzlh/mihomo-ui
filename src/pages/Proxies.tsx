import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  CircleHelp,
  EyeOff,
  Gauge,
  LoaderCircle,
  Network,
  Pin,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  Settings2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Modal, PageHeader, SearchInput, Toggle } from '../components/ui';
import { GroupIcon } from '../components/GroupIcon';
import type { ProxyMode, ProxyNode } from '../lib/types';
import { compareProxyDelays, describeProxyDelay } from '../lib/proxy-delay';
import {
  createProxyDelayStore,
  isProxyDelayPending,
  proxyDelayKey,
  proxyDelayStore,
} from '../lib/proxy-delay-store';
import { useMihomo } from '../state/mihomo';
import { PREFERENCES_CHANGED } from '../lib/preference-events';
import {
  defaultProxyPreferences,
  readProxyPreferences,
  writeProxyPreferences,
  type ProxyPreferences,
  type ProxySortOrder,
} from '../lib/proxy-preferences';
import './proxies.css';

type PendingAction = 'select' | 'test' | 'reset';

const presetNodes = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

const modes: { value: ProxyMode; label: string }[] = [
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
  { value: 'direct', label: '直连' },
];

function lastDelay(node: ProxyNode | undefined): number | undefined {
  return node?.history?.at(-1)?.delay;
}

function historyKey(node: ProxyNode | undefined): string {
  const last = node?.history.at(-1);
  return last ? `${last.time}:${last.delay}` : '';
}

function typeLabel(type: string) {
  const names: Record<string, string> = {
    Selector: '手动选择',
    URLTest: '自动选择',
    Fallback: '故障转移',
    LoadBalance: '负载均衡',
  };
  return names[type] ?? type;
}

function canPin(group: ProxyNode): boolean {
  return group.type === 'URLTest' || group.type === 'Fallback';
}

function groupNote(group: ProxyNode): string {
  if (group.type === 'LoadBalance') return '此代理组按负载均衡策略分配请求，不支持固定单个节点。';
  if (canPin(group))
    return group.fixed
      ? `已固定使用 ${group.fixed}。恢复自动或测试整个代理组，将清除固定选择。`
      : '内核会自动选择节点，也可以点击节点将其固定。';
  return '此代理组由内核管理。';
}

export default function Proxies() {
  const {
    client,
    profile,
    connected,
    demo,
    config,
    proxies,
    patchConfig,
    selectProxy,
    closeOnSwitch,
    setCloseOnSwitch,
    clearProxySelection,
    testDelay,
    testNodeDelay,
    refresh,
    notify,
  } = useMihomo();
  const [search, setSearch] = useState('');
  const scope = demo ? 'demo' : (profile?.url ?? 'offline');
  const storedPreferences = useMemo(() => readProxyPreferences(scope), [scope]);
  const [preferenceState, setPreferenceState] = useState<{
    scope: string;
    value: ProxyPreferences;
  } | null>(null);
  const preferences = preferenceState?.scope === scope ? preferenceState.value : storedPreferences;
  const { sortOrder, showHidden } = preferences;
  const expandedGroups = useMemo(
    () => new Map(Object.entries(preferences.expandedGroups)),
    [preferences.expandedGroups],
  );
  const [preferenceError, setPreferenceError] = useState('');
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [pending, setPending] = useState(() => new Map<string, PendingAction>());
  const delayStore = useMemo(
    () => (client && !demo ? proxyDelayStore(client) : createProxyDelayStore()),
    [client, demo],
  );
  const delayState = useSyncExternalStore(
    delayStore.subscribe,
    delayStore.getSnapshot,
    delayStore.getSnapshot,
  );
  const [modePending, setModePending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const activeActions = useRef(new Set<string>());
  const actionSession = useMemo(() => ({ client, demo }), [client, demo]);
  const currentSession = useRef(actionSession);
  useEffect(() => {
    const sync = () => {
      setPreferenceError('');
      setPreferenceState({ scope, value: readProxyPreferences(scope, setPreferenceError) });
    };
    sync();
    setDisplaySettingsOpen(false);
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);

  function updatePreferences(patch: Partial<ProxyPreferences>) {
    const value = { ...preferences, ...patch };
    setPreferenceState({ scope, value });
    try {
      writeProxyPreferences(scope, value);
      setPreferenceError('');
    } catch (error) {
      setPreferenceError(
        `显示偏好仅在当前页面生效：${error instanceof Error ? error.message : '浏览器未允许保存'}`,
      );
    }
  }
  useEffect(() => {
    currentSession.current = actionSession;
    activeActions.current.clear();
    setPending(new Map());
    return () => {
      currentSession.current = { client: null, demo: false };
    };
  }, [actionSession]);
  const allGroups = useMemo(
    () => Object.values(proxies).filter((node) => Array.isArray(node.all)),
    [proxies],
  );
  const modeGroups = useMemo(
    () =>
      allGroups.filter((group) =>
        config?.mode === 'global' ? group.name === 'GLOBAL' : group.name !== 'GLOBAL',
      ),
    [allGroups, config?.mode],
  );
  const hiddenCount = modeGroups.filter((group) => group.hidden).length;
  const availableGroups = useMemo(
    () => modeGroups.filter((group) => showHidden || !group.hidden),
    [modeGroups, showHidden],
  );
  const nodeDelays = useMemo(
    () =>
      new Map(
        allGroups.flatMap((group) =>
          (group.all ?? []).map((name) => {
            const node = proxies[name];
            const key = proxyDelayKey(group.name, name);
            const result = delayState.results.get(key);
            const currentResult = result?.historyKey === historyKey(node) ? result : undefined;
            return [
              key,
              describeProxyDelay(currentResult ? currentResult.delay : lastDelay(node), {
                failed: Boolean(currentResult && currentResult.delay === undefined),
                testing:
                  Boolean(node) && !presetNodes.has(name) && isProxyDelayPending(delayState, name),
              }),
            ] as const;
          }),
        ),
      ),
    [allGroups, delayState, proxies],
  );
  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return availableGroups
      .map((group) => {
        const groupMatches =
          !query ||
          `${group.name} ${group.type} ${typeLabel(group.type)}`.toLowerCase().includes(query);
        const nodes = (group.all ?? []).filter(
          (name) =>
            groupMatches ||
            `${name} ${proxies[name]?.type ?? ''} ${proxies[name]?.['provider-name'] ?? ''}`
              .toLowerCase()
              .includes(query),
        );
        if (sortOrder !== 'original')
          nodes.sort((left, right) =>
            sortOrder === 'name'
              ? left.localeCompare(right, 'zh-CN')
              : compareProxyDelays(
                  nodeDelays.get(proxyDelayKey(group.name, left)) ?? describeProxyDelay(undefined),
                  nodeDelays.get(proxyDelayKey(group.name, right)) ?? describeProxyDelay(undefined),
                ),
          );
        return { group, nodes, matched: groupMatches || nodes.length > 0 };
      })
      .filter((item) => item.matched);
  }, [availableGroups, nodeDelays, proxies, search, sortOrder]);
  const allExpanded =
    visibleGroups.length > 0 &&
    visibleGroups.every(
      ({ group }, index) =>
        expandedGroups.get(group.name) ?? (Boolean(search.trim()) || index === 0),
    );

  async function setMode(mode: ProxyMode) {
    if (!connected || modePending || mode === config?.mode) return;
    setModePending(true);
    try {
      await patchConfig({ mode });
    } finally {
      setModePending(false);
    }
  }

  async function groupAction(group: ProxyNode, action: PendingAction, name?: string) {
    if (
      !connected ||
      activeActions.current.has(group.name) ||
      delayStore.getSnapshot().groups.has(group.name)
    )
      return;
    if (action === 'test') {
      const members = (group.all ?? []).filter(
        (member) => Boolean(proxies[member]) && !presetNodes.has(member),
      );
      if (!delayStore.beginGroup(group.name, members)) return;
      const historyKeys = new Map(members.map((member) => [member, historyKey(proxies[member])]));
      let delays: Record<string, number> | undefined;
      try {
        delays = await testDelay(group.name);
      } finally {
        delayStore.finishGroup(group.name, delays, historyKeys);
      }
      return;
    }
    if (action === 'select') {
      if (!name || (group.type !== 'Selector' && !canPin(group))) return;
      if (group.type === 'Selector' ? group.now === name : group.fixed === name) return;
    }
    if (action === 'reset' && (!canPin(group) || !group.fixed)) return;
    activeActions.current.add(group.name);
    setPending((current) => new Map(current).set(group.name, action));
    try {
      if (action === 'reset') await clearProxySelection(group.name);
      else if (name) await selectProxy(group.name, name);
    } finally {
      if (currentSession.current === actionSession) {
        activeActions.current.delete(group.name);
        setPending((current) => {
          const next = new Map(current);
          next.delete(group.name);
          return next;
        });
      }
    }
  }

  async function testNode(name: string, group: ProxyNode) {
    if (!connected || !delayStore.beginNode(name)) return;
    const previousHistoryKey = historyKey(proxies[name]);
    let delay: number | undefined;
    try {
      delay = await testNodeDelay(name, group.name);
    } finally {
      delayStore.finishNode(group.name, name, { delay, historyKey: previousHistoryKey });
    }
  }

  async function reload() {
    if (demo) return notify('正在浏览演示数据', 'info');
    if (!connected || refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '刷新失败，请重试', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div
      className={`page-stack proxies-page proxy-density-${preferences.density} proxy-columns-${preferences.columns}`}
    >
      <PageHeader title="代理" description="管理代理组与节点，选择适合你的连接方式。">
        <div className="segmented proxy-mode-control" role="group" aria-label="代理模式">
          {modes.map((mode) => (
            <button
              key={mode.value}
              className={config?.mode === mode.value ? 'active' : ''}
              aria-pressed={config?.mode === mode.value}
              disabled={!connected || !config || modePending}
              onClick={() => void setMode(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {!connected && !demo ? (
        <div className="panel">
          <EmptyState
            icon={Network}
            title="连接内核，开始管理代理"
            description="接入 Mihomo 后，你的代理组、节点和延迟会显示在这里。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="proxy-page-toolbar">
            <div className="proxy-search-area">
              <SearchInput value={search} onChange={setSearch} placeholder="搜索代理组或节点…" />
              <span className="proxy-group-count">{availableGroups.length} 个代理组</span>
              {demo && <Badge tone="orange">演示数据</Badge>}
            </div>
            <div className="proxy-toolbar-actions">
              <div className="proxy-filter-options">
                <label
                  className="proxy-hidden-filter"
                  title="手动切换成员成功后，仅关闭经过该组旧成员的已有连接；首页切换也生效"
                >
                  <input
                    type="checkbox"
                    aria-label="切换后关闭旧连接"
                    checked={closeOnSwitch}
                    onChange={(event) => setCloseOnSwitch(event.target.checked)}
                  />
                  <span className="proxy-filter-full-label">切换后关闭旧连接</span>
                  <span className="proxy-filter-short-label">关闭旧连接</span>
                </label>
                <label className="proxy-hidden-filter">
                  <input
                    type="checkbox"
                    aria-label="显示隐藏代理组"
                    checked={showHidden}
                    onChange={(event) => updatePreferences({ showHidden: event.target.checked })}
                  />
                  <span className="proxy-filter-full-label">显示隐藏代理组</span>
                  <span className="proxy-filter-short-label">显示隐藏</span>
                  {hiddenCount > 0 && <span>({hiddenCount})</span>}
                </label>
                <label className="proxy-sort">
                  <ArrowDownWideNarrow size={16} />
                  <select
                    aria-label="节点排序"
                    value={sortOrder}
                    onChange={(event) =>
                      updatePreferences({ sortOrder: event.target.value as ProxySortOrder })
                    }
                  >
                    <option value="original">默认排序</option>
                    <option value="name">名称排序</option>
                    <option value="latency">延迟排序</option>
                  </select>
                </label>
              </div>
              <div className="proxy-view-tools">
                <button
                  className="icon-button"
                  aria-label="代理显示设置"
                  title="代理显示设置"
                  onClick={() => setDisplaySettingsOpen(true)}
                >
                  <Settings2 size={17} />
                </button>
                <button
                  className="icon-button"
                  title={allExpanded ? '收起全部代理组' : '展开全部代理组'}
                  aria-label={allExpanded ? '收起全部代理组' : '展开全部代理组'}
                  disabled={visibleGroups.length === 0}
                  onClick={() =>
                    updatePreferences({
                      expandedGroups: Object.fromEntries([
                        ...expandedGroups,
                        ...visibleGroups.map(({ group }) => [group.name, !allExpanded] as const),
                      ]),
                    })
                  }
                >
                  {allExpanded ? <ChevronsDownUp size={17} /> : <ChevronsUpDown size={17} />}
                </button>
                <button
                  className="icon-button"
                  aria-label="刷新代理列表"
                  title="刷新代理列表"
                  disabled={refreshing}
                  onClick={() => void reload()}
                >
                  <RefreshCw size={16} className={refreshing ? 'proxy-spinning' : ''} />
                </button>
              </div>
            </div>
          </div>
          {preferenceError && (
            <p className="proxy-preference-note" role="status">
              {preferenceError}
            </p>
          )}
          {config?.mode === 'direct' && (
            <div className="proxy-mode-notice">
              <Route size={16} />
              <span>直连模式已开启，所有流量直接连接；代理组选择会保留。</span>
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <div className="panel">
              <EmptyState
                icon={search ? Search : Network}
                title={
                  search
                    ? '没有匹配的代理组或节点'
                    : hiddenCount > 0 && !showHidden
                      ? '当前代理组已隐藏'
                      : '当前没有代理组'
                }
                description={
                  search
                    ? '尝试其他节点名称、地区或协议。'
                    : hiddenCount > 0 && !showHidden
                      ? '开启“显示隐藏代理组”后，可查看和管理这些代理组。'
                      : '加载包含代理组的 Mihomo 配置后，即可选择节点。'
                }
              />
            </div>
          ) : (
            <div className="proxy-groups">
              {visibleGroups.map(({ group, nodes }, index) => {
                const expanded =
                  expandedGroups.get(group.name) ?? (Boolean(search.trim()) || index === 0);
                const pinnable = canPin(group);
                const selectable = group.type === 'Selector' || pinnable;
                const busy = delayState.groups.has(group.name) ? 'test' : pending.get(group.name);
                const hasNodeTest =
                  group.all?.some((name) => isProxyDelayPending(delayState, name)) ?? false;
                return (
                  <section
                    className={`panel proxy-group${expanded ? ' is-open' : ''}`}
                    key={group.name}
                    aria-label={`${group.name} 代理组`}
                  >
                    <div className="group-header">
                      <button
                        className="group-toggle"
                        aria-label={`${expanded ? '收起' : '展开'} ${group.name}`}
                        aria-expanded={expanded}
                        onClick={() =>
                          updatePreferences({
                            expandedGroups: Object.fromEntries(
                              new Map(expandedGroups).set(group.name, !expanded),
                            ),
                          })
                        }
                      >
                        <ChevronDown size={16} className={expanded ? '' : 'is-collapsed'} />
                        {preferences.showGroupIcons && <GroupIcon icon={group.icon} />}
                        <span className="proxy-group-identity">
                          <span className="proxy-group-name" title={group.name}>
                            {group.name}
                          </span>
                          <span className="proxy-group-subtitle">
                            <span className="proxy-group-type">{typeLabel(group.type)}</span>
                            <span
                              className="group-summary"
                              title={
                                group.now ||
                                (group.type === 'LoadBalance'
                                  ? '请求按负载均衡策略分配'
                                  : '内核未提供当前节点')
                              }
                            >
                              {group.now ||
                                (group.type === 'LoadBalance' ? '负载均衡' : '尚未选择')}
                            </span>
                          </span>
                        </span>
                      </button>
                      {group.hidden && (
                        <span className="proxy-hidden-badge" title="此代理组设置为隐藏">
                          <EyeOff size={14} />
                          <span className="proxy-status-label">隐藏</span>
                        </span>
                      )}
                      {pinnable && group.fixed && (
                        <span className="proxy-fixed-badge" title="已固定节点">
                          <Pin size={12} />
                          <span className="proxy-status-label">已固定</span>
                        </span>
                      )}
                      <div className="proxy-group-actions">
                        {pinnable && group.fixed && (
                          <button
                            className="button small proxy-reset-button"
                            aria-label={busy === 'reset' ? '正在恢复自动' : '恢复自动'}
                            title="恢复自动"
                            disabled={Boolean(busy)}
                            onClick={() => void groupAction(group, 'reset')}
                          >
                            {busy === 'reset' ? (
                              <LoaderCircle size={14} className="proxy-spinning" />
                            ) : (
                              <RotateCcw size={14} />
                            )}
                            <span className="proxy-action-label">恢复自动</span>
                          </button>
                        )}
                        <button
                          className="button small proxy-test-button"
                          aria-label={
                            busy === 'test'
                              ? '测试中…'
                              : pinnable && group.fixed
                                ? '测速并恢复自动'
                                : '延迟测试'
                          }
                          disabled={Boolean(busy) || hasNodeTest}
                          title={
                            group.testUrl
                              ? `测试地址：${group.testUrl}${group.expectedStatus ? ` · 预期状态：${group.expectedStatus}` : ''}`
                              : '测试此代理组内的节点'
                          }
                          onClick={() => void groupAction(group, 'test')}
                        >
                          {busy === 'test' ? (
                            <LoaderCircle size={14} className="proxy-spinning" />
                          ) : (
                            <Gauge size={14} />
                          )}
                          <span className="proxy-action-label">
                            {busy === 'test'
                              ? '测试中…'
                              : pinnable && group.fixed
                                ? '测速并恢复自动'
                                : '延迟测试'}
                          </span>
                        </button>
                        <span
                          className="proxy-member-count"
                          title={`${group.all?.length ?? 0} 个节点`}
                        >
                          {group.all?.length ?? 0}
                        </span>
                      </div>
                    </div>
                    {expanded && (
                      <div className="proxy-group-content">
                        {group.type !== 'Selector' && (
                          <div className="proxy-auto-note">
                            <CircleHelp size={14} />
                            <span>{groupNote(group)}</span>
                          </div>
                        )}
                        {nodes.length === 0 ? (
                          <p className="proxy-empty-group">这个代理组暂时没有节点。</p>
                        ) : (
                          <div className="proxy-grid">
                            {nodes.map((name) => {
                              const node = proxies[name];
                              const selected = group.now === name;
                              const pinned = pinnable && group.fixed === name;
                              const testingNode = delayState.nodes.has(name);
                              const testable = Boolean(node) && !presetNodes.has(name);
                              const latency =
                                nodeDelays.get(proxyDelayKey(group.name, name)) ??
                                describeProxyDelay(undefined);
                              const testing = latency.state === 'testing';
                              const delayLabel = testing
                                ? testingNode
                                  ? '测试中'
                                  : '等待测速结果'
                                : latency.label;
                              const provider = node?.['provider-name'];
                              const capabilities = [
                                node?.udp === true
                                  ? 'UDP'
                                  : node?.udp === false
                                    ? '不支持 UDP'
                                    : '',
                                node?.uot ? 'UDP over TCP' : '',
                                node?.smux ? '连接复用' : '',
                                node?.tfo ? 'TCP Fast Open' : '',
                                node?.mptcp ? '多路径 TCP' : '',
                              ]
                                .filter(Boolean)
                                .join(' · ');
                              return (
                                <article
                                  key={name}
                                  className={`proxy-node${selected ? ' selected' : ''}${!selectable ? ' is-automatic' : ''}${busy ? ' is-busy' : ''}`}
                                  data-node-name={name}
                                  aria-label={`${name} 节点`}
                                  title={
                                    [provider && `来自 ${provider}`, capabilities]
                                      .filter(Boolean)
                                      .join(' · ') || undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    className="proxy-node-select"
                                    disabled={!selectable || Boolean(busy)}
                                    aria-pressed={selected}
                                    aria-label={`${name}，${delayLabel}${selected ? '，当前选择' : ''}`}
                                    title={
                                      pinnable
                                        ? `${name} · ${pinned ? '已固定' : '点击固定此节点'}`
                                        : name
                                    }
                                    onClick={() => void groupAction(group, 'select', name)}
                                  >
                                    <span className="proxy-node-main">
                                      <span className="proxy-node-name">{name}</span>
                                      {pinned && (
                                        <span className="proxy-selection-mark is-selected">
                                          <Pin size={11} strokeWidth={2.5} />
                                        </span>
                                      )}
                                    </span>
                                    <span className="proxy-node-details">
                                      <span className="proxy-node-protocol" title={capabilities}>
                                        {node?.now && (
                                          <span className="proxy-node-current">{node.now}</span>
                                        )}
                                        <span className="proxy-node-capability">
                                          {node?.type || '未知协议'}
                                        </span>
                                        {node?.udp === true && (
                                          <span className="proxy-node-capability">UDP</span>
                                        )}
                                        {node?.uot && (
                                          <span className="proxy-node-capability">UOT</span>
                                        )}
                                        {node?.xudp && (
                                          <span className="proxy-node-capability">XUDP</span>
                                        )}
                                      </span>
                                    </span>
                                  </button>
                                  {testable && (
                                    <button
                                      type="button"
                                      className={`proxy-node-test${latency.text === '-' ? ' is-untested' : ''}`}
                                      aria-label="测试节点延迟"
                                      aria-busy={testing}
                                      title={`${delayLabel} · ${name}${testing ? '' : ' · 点击测试延迟'}`}
                                      disabled={testing || Boolean(busy)}
                                      onClick={() => void testNode(name, group)}
                                    >
                                      {testing ? (
                                        <span
                                          className="proxy-delay-loading"
                                          role="status"
                                          aria-label={delayLabel}
                                        >
                                          <i />
                                          <i />
                                          <i />
                                        </span>
                                      ) : (
                                        <>
                                          {latency.text === '-' && selected ? (
                                            <CircleCheck
                                              className="proxy-delay-selection"
                                              size={16}
                                              aria-hidden="true"
                                            />
                                          ) : (
                                            <span className={`latency tone-${latency.tone}`}>
                                              {latency.text}
                                            </span>
                                          )}
                                          {latency.text === '-' && (
                                            <span className="proxy-delay-check">测试</span>
                                          )}
                                        </>
                                      )}
                                    </button>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          <p className="proxy-page-hint">
            <span className="proxy-hint-dot" />
            延迟单位为 ms，点击数字测试节点；三点动画表示正在等待内核测速结果。
          </p>
        </>
      )}
      {displaySettingsOpen && (
        <Modal
          title="代理显示设置"
          description="偏好按当前控制器保存；窄屏会自动减少列数。"
          onClose={() => setDisplaySettingsOpen(false)}
        >
          <div className="proxy-display-settings">
            <div className="proxy-display-setting">
              <div>
                <strong>节点间距</strong>
                <p>保留节点卡片与延迟字号，调整列表留白</p>
              </div>
              <div className="segmented" role="group" aria-label="节点间距">
                {(['compact', 'comfortable'] as const).map((value) => (
                  <button
                    key={value}
                    className={preferences.density === value ? 'active' : ''}
                    aria-pressed={preferences.density === value}
                    onClick={() => updatePreferences({ density: value })}
                  >
                    {value === 'compact' ? '紧凑' : '宽松'}
                  </button>
                ))}
              </div>
            </div>
            <div className="proxy-display-setting">
              <div>
                <label htmlFor="proxy-column-count">节点列数</label>
                <p>自动布局会随窗口宽度调整</p>
              </div>
              <select
                className="field"
                id="proxy-column-count"
                value={preferences.columns}
                onChange={(event) =>
                  updatePreferences({
                    columns:
                      event.target.value === 'auto'
                        ? 'auto'
                        : (Number(event.target.value) as 2 | 3 | 4),
                  })
                }
              >
                <option value="auto">自动</option>
                <option value="2">2 列</option>
                <option value="3">3 列</option>
                <option value="4">4 列</option>
              </select>
            </div>
            <div className="proxy-display-setting">
              <div>
                <strong>显示代理组图标</strong>
                <p>使用代理组提供的图标，无法加载时显示默认图标</p>
              </div>
              <Toggle
                label="显示代理组图标"
                checked={preferences.showGroupIcons}
                onChange={(value) => updatePreferences({ showGroupIcons: value })}
              />
            </div>
            {preferenceError && (
              <p className="proxy-preference-note" role="status">
                {preferenceError}
              </p>
            )}
          </div>
          <div className="form-actions">
            <button className="button" onClick={() => updatePreferences(defaultProxyPreferences())}>
              恢复默认显示
            </button>
            <button className="button primary" onClick={() => setDisplaySettingsOpen(false)}>
              完成
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
