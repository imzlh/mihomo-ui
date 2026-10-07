import { useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  EyeOff,
  Gauge,
  Globe2,
  LoaderCircle,
  Network,
  Pin,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, PageHeader, SearchInput } from '../components/ui';
import type { ProxyMode, ProxyNode } from '../lib/types';
import { useMihomo } from '../state/mihomo';
import './proxies.css';

type SortOrder = 'original' | 'name' | 'latency';
type PendingAction = 'select' | 'test' | 'reset';

const modes: { value: ProxyMode; label: string }[] = [
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
  { value: 'direct', label: '直连' },
];

function lastDelay(node: ProxyNode | undefined): number | undefined {
  return node?.history?.at(-1)?.delay;
}

function latencyRank(node: ProxyNode | undefined): number {
  const value = lastDelay(node);
  return value !== undefined && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function latencyDetails(node: ProxyNode | undefined) {
  const value = lastDelay(node);
  if (value === undefined) return { tone: 'muted', text: '未测试' };
  if (value <= 0) return { tone: 'red', text: '超时' };
  return { tone: value < 100 ? 'green' : value < 200 ? 'orange' : 'red', text: `${value} ms` };
}

function flagOf(name: string): string | undefined {
  return name.match(/^\p{Regional_Indicator}{2}/u)?.[0];
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
    connected,
    demo,
    config,
    proxies,
    patchConfig,
    selectProxy,
    clearProxySelection,
    testDelay,
    testNodeDelay,
    refresh,
    notify,
  } = useMihomo();
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('original');
  const [showHidden, setShowHidden] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Map<string, boolean>());
  const [pending, setPending] = useState(() => new Map<string, PendingAction>());
  const [nodeTesting, setNodeTesting] = useState(() => new Set<string>());
  const [modePending, setModePending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const activeActions = useRef(new Set<string>());
  const activeNodeTests = useRef(new Set<string>());
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
              : latencyRank(proxies[left]) - latencyRank(proxies[right]) ||
                left.localeCompare(right, 'zh-CN'),
          );
        return { group, nodes, matched: groupMatches || nodes.length > 0 };
      })
      .filter((item) => item.matched);
  }, [availableGroups, proxies, search, sortOrder]);
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
    if (!connected || activeActions.current.has(group.name)) return;
    if (action === 'select') {
      if (!name || (group.type !== 'Selector' && !canPin(group))) return;
      if (group.type === 'Selector' ? group.now === name : group.fixed === name) return;
    }
    if (action === 'reset' && (!canPin(group) || !group.fixed)) return;
    if (action === 'test' && group.all?.some((member) => activeNodeTests.current.has(member)))
      return;
    activeActions.current.add(group.name);
    setPending((current) => new Map(current).set(group.name, action));
    try {
      if (action === 'test') await testDelay(group.name);
      else if (action === 'reset') await clearProxySelection(group.name);
      else if (name) await selectProxy(group.name, name);
    } finally {
      activeActions.current.delete(group.name);
      setPending((current) => {
        const next = new Map(current);
        next.delete(group.name);
        return next;
      });
    }
  }

  async function testNode(name: string) {
    if (!connected || activeNodeTests.current.has(name)) return;
    activeNodeTests.current.add(name);
    setNodeTesting((current) => new Set(current).add(name));
    try {
      await testNodeDelay(name);
    } finally {
      activeNodeTests.current.delete(name);
      setNodeTesting((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
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
    <div className="page-stack proxies-page">
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
              <label className="proxy-hidden-filter">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                显示隐藏代理组{hiddenCount > 0 && <span>({hiddenCount})</span>}
              </label>
              <label className="proxy-sort">
                <ArrowDownWideNarrow size={16} />
                <select
                  aria-label="节点排序"
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value as SortOrder)}
                >
                  <option value="original">默认排序</option>
                  <option value="name">名称排序</option>
                  <option value="latency">延迟排序</option>
                </select>
              </label>
              <button
                className="icon-button"
                title={allExpanded ? '收起全部代理组' : '展开全部代理组'}
                aria-label={allExpanded ? '收起全部代理组' : '展开全部代理组'}
                disabled={visibleGroups.length === 0}
                onClick={() =>
                  setExpandedGroups(
                    (current) =>
                      new Map([
                        ...current,
                        ...visibleGroups.map(({ group }) => [group.name, !allExpanded] as const),
                      ]),
                  )
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
                const busy = pending.get(group.name);
                const hasNodeTest = group.all?.some((name) => nodeTesting.has(name)) ?? false;
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
                          setExpandedGroups((current) =>
                            new Map(current).set(group.name, !expanded),
                          )
                        }
                      >
                        <ChevronDown size={16} className={expanded ? '' : 'is-collapsed'} />
                        <span className="proxy-group-name">{group.name}</span>
                        <span className="proxy-member-count">{group.all?.length ?? 0}</span>
                      </button>
                      <Badge tone="neutral">{typeLabel(group.type)}</Badge>
                      {group.hidden && (
                        <span className="proxy-hidden-badge" title="此代理组设置为隐藏">
                          <EyeOff size={14} />
                          隐藏
                        </span>
                      )}
                      {pinnable && group.fixed && (
                        <Badge tone="purple">
                          <Pin size={12} />
                          已固定
                        </Badge>
                      )}
                      <div
                        className="group-summary"
                        title={
                          group.now ||
                          (group.type === 'LoadBalance'
                            ? '请求按负载均衡策略分配'
                            : '内核未提供当前节点')
                        }
                      >
                        <span className="proxy-selected-dot" />
                        {group.now || (group.type === 'LoadBalance' ? '负载均衡' : '尚未选择')}
                      </div>
                      <div className="proxy-group-actions">
                        {pinnable && group.fixed && (
                          <button
                            className="button small proxy-reset-button"
                            disabled={Boolean(busy)}
                            onClick={() => void groupAction(group, 'reset')}
                          >
                            {busy === 'reset' ? (
                              <LoaderCircle size={14} className="proxy-spinning" />
                            ) : (
                              <RotateCcw size={14} />
                            )}
                            恢复自动
                          </button>
                        )}
                        <button
                          className="button small proxy-test-button"
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
                          {busy === 'test'
                            ? '测试中…'
                            : pinnable && group.fixed
                              ? '测速并恢复自动'
                              : '延迟测试'}
                        </button>
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
                              const flag = flagOf(name);
                              const latency = latencyDetails(node);
                              const testingNode = nodeTesting.has(name);
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
                                >
                                  <button
                                    type="button"
                                    className="proxy-node-select"
                                    disabled={!selectable || Boolean(busy)}
                                    aria-pressed={selected}
                                    aria-label={`${name}，${latency.text}${selected ? '，当前选择' : ''}`}
                                    title={
                                      pinnable
                                        ? `${name} · ${pinned ? '已固定' : '点击固定此节点'}`
                                        : name
                                    }
                                    onClick={() => void groupAction(group, 'select', name)}
                                  >
                                    <span className="proxy-node-main">
                                      <span
                                        className={`proxy-node-symbol${flag ? ' is-flag' : ''}`}
                                        aria-hidden="true"
                                      >
                                        {flag ||
                                          (node?.all ? <Route size={16} /> : <Globe2 size={16} />)}
                                      </span>
                                      <span className="proxy-node-name">
                                        {flag ? name.slice(flag.length).trim() : name}
                                      </span>
                                      <span
                                        className={`proxy-selection-mark${selected || pinned ? ' is-selected' : ''}`}
                                      >
                                        {pinned ? (
                                          <Pin size={11} strokeWidth={2.5} />
                                        ) : selected ? (
                                          <Check size={11} strokeWidth={3} />
                                        ) : null}
                                      </span>
                                    </span>
                                    <span className="proxy-node-details">
                                      <span className="proxy-node-protocol" title={capabilities}>
                                        {node?.type || '未知协议'}
                                        {node?.udp === true && (
                                          <span className="proxy-node-capability">UDP</span>
                                        )}
                                        {node?.uot && (
                                          <span className="proxy-node-capability">UOT</span>
                                        )}
                                      </span>
                                      <span className={`latency tone-${latency.tone}`}>
                                        <i />
                                        {latency.text}
                                      </span>
                                    </span>
                                  </button>
                                  <div className="proxy-node-footer">
                                    <span
                                      className={`proxy-node-source${node?.alive === false ? ' tone-red' : ''}`}
                                      title={
                                        provider
                                          ? `来自 ${provider}${capabilities ? ` · ${capabilities}` : ''}`
                                          : capabilities || undefined
                                      }
                                    >
                                      {node?.alive === false
                                        ? '最近测试不可用'
                                        : provider ||
                                          (pinned
                                            ? '已固定节点'
                                            : node?.now
                                              ? `当前：${node.now}`
                                              : node?.udp === false
                                                ? '不支持 UDP'
                                                : '节点延迟')}
                                    </span>
                                    <button
                                      type="button"
                                      className="proxy-node-test"
                                      aria-label="测试节点延迟"
                                      title={`测试 ${name} 的延迟`}
                                      disabled={testingNode || Boolean(busy)}
                                      onClick={() => void testNode(name)}
                                    >
                                      {testingNode ? (
                                        <LoaderCircle size={14} className="proxy-spinning" />
                                      ) : (
                                        <Gauge size={14} />
                                      )}
                                      <span>{testingNode ? '测试中' : '测试'}</span>
                                    </button>
                                  </div>
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
            延迟来自最近一次测试，可单独测试节点或测试整个代理组。
          </p>
        </>
      )}
    </div>
  );
}
