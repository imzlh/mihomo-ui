import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Columns3,
  History,
  List,
  Network,
  Pause,
  Play,
  Trash2,
  Table2,
  Unplug,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Modal, PageHeader, SearchInput, Toggle } from '../components/ui';
import { bytes } from '../lib/format';
import type { Connection, ConnectionsSnapshot } from '../lib/types';
import { stableSort, type SortAccessor } from '../hooks/use-table-sort';
import { useConnectionRates, type ConnectionRates } from '../hooks/use-connection-rates';
import {
  CONNECTION_HISTORY_LIMIT,
  connectionIdentity,
  type ClosedConnection,
} from '../lib/connection-history';
import {
  CONNECTION_COLUMNS,
  connectionAddress,
  connectionDuration,
  defaultConnectionPreferences,
  readConnectionPreferences,
  writeConnectionPreferences,
  type ConnectionColumn,
  type ConnectionPreferences,
} from '../lib/connection-view';
import { useMihomo } from '../state/mihomo';
import './resources.css';
import './connections.css';
import { PREFERENCES_CHANGED } from '../lib/preference-events';

type ConnectionRow = Connection | ClosedConnection;
type ConnectionTab = 'active' | 'closed';
const destination = (connection: Connection): string =>
  connection.metadata.host || connection.metadata.destinationIP || '未知目标';
const chain = (connection: Connection): string =>
  connection.chains.slice().reverse().join(' → ') || 'DIRECT';
const isClosed = (connection: ConnectionRow): connection is ClosedConnection =>
  'closedAt' in connection;
const timeText = (value: string | number): string =>
  Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
    : '未知时间';

const connectionAccessors: Record<ConnectionColumn, SortAccessor<ConnectionRow>> = {
  host: destination,
  network: (connection) => connection.metadata.network,
  strategy: (connection) => `${chain(connection)} ${connection.rule} ${connection.rulePayload}`,
  download: (connection) => connection.download,
  upload: (connection) => connection.upload,
  start: (connection) => Date.parse(connection.start),
  source: (connection) =>
    connectionAddress(connection.metadata.sourceIP, connection.metadata.sourcePort),
  destination: (connection) =>
    connectionAddress(connection.metadata.destinationIP, connection.metadata.destinationPort),
  process: (connection) => connection.metadata.processPath || connection.metadata.process,
  inbound: (connection) => connection.metadata.inboundName || connection.metadata.type,
  provider: (connection) => connection.providerChains?.join(' → '),
  rule: (connection) => `${connection.rule} ${connection.rulePayload}`,
  closedAt: (connection) => (isClosed(connection) ? connection.closedAt : undefined),
};
const connectionTieBreaker = (left: Connection, right: Connection): number =>
  connectionIdentity(left).localeCompare(connectionIdentity(right));

const metadataLabels: Record<string, string> = {
  network: '协议',
  type: '入站类型',
  sourceIP: '源 IP',
  sourcePort: '源端口',
  destinationIP: '目标 IP',
  destinationPort: '目标端口',
  host: '域名',
  dnsMode: 'DNS 模式',
  process: '进程名称',
  processPath: '进程路径',
  uid: '用户 ID',
  inboundIP: '入站 IP',
  inboundPort: '入站端口',
  inboundName: '入站名称',
  specialProxy: '指定代理',
  specialRules: '指定规则',
  remoteDestination: '远端目标',
  dscp: 'DSCP',
};

function ConnectionDetails({ connection }: { connection: ConnectionRow }) {
  const details: [string, ReactNode][] = [
    ['连接 ID', connection.id],
    ['源地址', connectionAddress(connection.metadata.sourceIP, connection.metadata.sourcePort)],
    [
      '目标地址',
      connectionAddress(connection.metadata.destinationIP, connection.metadata.destinationPort),
    ],
    ['代理链', chain(connection)],
    ['代理集链', connection.providerChains?.join(' → ') || '内核未提供'],
    [
      '匹配规则',
      `${connection.rule || '—'}${connection.rulePayload ? ` (${connection.rulePayload})` : ''}`,
    ],
    [
      '建立时间',
      Number.isFinite(Date.parse(connection.start))
        ? new Date(connection.start).toLocaleString('zh-CN', { hour12: false })
        : '未知时间',
    ],
    ['下载 / 上传', `${bytes(connection.download)} / ${bytes(connection.upload)}`],
    ...Object.entries(connection.metadata).map(([key, value]): [string, ReactNode] => [
      metadataLabels[key] || key,
      value === undefined || value === null || value === ''
        ? '内核未提供'
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value),
    ]),
  ];
  if (isClosed(connection))
    details.push(
      ['末次观察', new Date(connection.lastSeenAt).toLocaleString('zh-CN', { hour12: false })],
      ['观测关闭', new Date(connection.closedAt).toLocaleString('zh-CN', { hour12: false })],
    );
  return (
    <dl className="connection-details">
      {details.map(([label, value], index) => (
        <div key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd className="mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface FrozenConnectionView {
  snapshot: ConnectionsSnapshot;
  closed: ClosedConnection[];
  observedAt: number;
  rates: ConnectionRates;
}

export default function Connections() {
  const {
    connected,
    demo,
    client,
    profile,
    snapshot,
    connectionHistory,
    connectionsStream,
    clearConnectionHistory,
    runAction,
    notify,
  } = useMihomo();
  const activeClient = useRef(client);
  activeClient.current = client;
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<ConnectionTab>('active');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [closingAll, setClosingAll] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [frozenView, setFrozenView] = useState<FrozenConnectionView | null>(null);
  const scope = demo ? 'demo' : (profile?.url ?? 'offline');
  const storedPreferences = useMemo(() => readConnectionPreferences(scope), [scope]);
  const [preferenceState, setPreferenceState] = useState<{
    scope: string;
    value: ConnectionPreferences;
  } | null>(null);
  const preferences = preferenceState?.scope === scope ? preferenceState.value : storedPreferences;
  useEffect(() => {
    const sync = () => setPreferenceState({ scope, value: readConnectionPreferences(scope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);
  const setPreferences = (value: ConnectionPreferences) => {
    setPreferenceState({ scope, value });
    writeConnectionPreferences(scope, value);
  };

  // Traffic total frames must not create zero-rate samples for unchanged connection counters.
  const rateSnapshot = useMemo(
    () => ({ connections: snapshot.connections, uploadTotal: 0, downloadTotal: 0 }),
    [snapshot.connections],
  );
  const rateSession = useMemo(
    () => ({ client, demo, status: connectionsStream.status }),
    [client, demo, connectionsStream.status],
  );
  const rates = useConnectionRates(rateSnapshot, rateSession);
  const paused = frozenView !== null;
  const displaySnapshot = frozenView?.snapshot ?? snapshot;
  const displayHistory = frozenView?.closed ?? connectionHistory;
  const displayRates = frozenView?.rates ?? rates;
  const observedAt =
    frozenView?.observedAt ??
    (demo ? Date.now() : (connectionsStream.lastSnapshotAt ?? Date.now()));
  const streamReady = demo || connectionsStream.status === 'open';
  const hasData =
    connected || demo || connectionsStream.lastSnapshotAt !== null || connectionHistory.length > 0;
  const columns = CONNECTION_COLUMNS.filter(
    (column) =>
      preferences.columns.includes(column.key) && (tab === 'closed' || !column.historyOnly),
  );

  useEffect(() => {
    setFrozenView(null);
    setExpanded(null);
    setClosing(new Set());
    setClosingAll(false);
    setConfirmClose(false);
    setTab('active');
  }, [client, demo]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const connections: ConnectionRow[] =
      tab === 'closed' ? displayHistory : displaySnapshot.connections;
    return connections.filter((connection) =>
      [
        connection.id,
        ...Object.values(connection.metadata),
        connection.rule,
        connection.rulePayload,
        ...connection.chains,
        ...(connection.providerChains ?? []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [displaySnapshot.connections, displayHistory, query, tab]);
  const sort = tab === 'active' ? preferences.activeSort : preferences.closedSort;
  const sortedRows = useMemo(
    () => stableSort(filtered, sort, connectionAccessors, connectionTieBreaker),
    [filtered, sort],
  );
  const activeIdentities = useMemo(
    () => new Set(snapshot.connections.map(connectionIdentity)),
    [snapshot.connections],
  );
  const toggleSort = (key: ConnectionColumn) =>
    setPreferences({
      ...preferences,
      [tab === 'active' ? 'activeSort' : 'closedSort']: {
        key,
        direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc',
      },
    });

  function setListSort(key: ConnectionColumn, direction = sort.direction) {
    setPreferences({
      ...preferences,
      [tab === 'active' ? 'activeSort' : 'closedSort']: { key, direction },
    });
  }

  function rateLabel(connection: ConnectionRow, key: 'download' | 'upload'): string {
    const rate = displayRates[connection.id]?.[key];
    return isClosed(connection)
      ? '末次观测'
      : !paused && !streamReady
        ? '采样中断'
        : rate == null
          ? '等待采样'
          : `${bytes(rate)}/s`;
  }

  async function closeConnection(connection: Connection) {
    if (demo) return notify('演示模式下不会修改实际内核', 'info');
    if (
      !client ||
      !connected ||
      !streamReady ||
      isClosed(connection) ||
      !activeIdentities.has(connectionIdentity(connection))
    )
      return;
    setClosing((current) => new Set(current).add(connection.id));
    try {
      const success = await runAction(() => client.closeConnection(connection.id), '连接已关闭');
      if (success) {
        setFrozenView((current) =>
          current
            ? {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  connections: current.snapshot.connections.filter(
                    (item) => connectionIdentity(item) !== connectionIdentity(connection),
                  ),
                },
              }
            : null,
        );
        setExpanded((current) => (current === connectionIdentity(connection) ? null : current));
      }
    } finally {
      if (activeClient.current === client)
        setClosing((current) => {
          const next = new Set(current);
          next.delete(connection.id);
          return next;
        });
    }
  }

  async function closeAll() {
    if (demo) {
      setConfirmClose(false);
      return notify('演示模式下不会修改实际内核', 'info');
    }
    if (!client || !connected || !streamReady) return;
    setClosingAll(true);
    try {
      const success = await runAction(() => client.closeAllConnections(), '全部连接已关闭');
      if (success) {
        setFrozenView((current) =>
          current ? { ...current, snapshot: { ...current.snapshot, connections: [] } } : null,
        );
        setExpanded(null);
        setConfirmClose(false);
      }
    } finally {
      if (activeClient.current === client) setClosingAll(false);
    }
  }

  function renderCell(key: ConnectionColumn, connection: ConnectionRow): ReactNode {
    const closed = isClosed(connection);
    switch (key) {
      case 'host':
        return (
          <>
            <div className="connection-destination" title={destination(connection)}>
              {destination(connection)}
            </div>
            <div
              className="resource-subline"
              title={connection.metadata.processPath || connection.metadata.sourceIP}
            >
              {connection.metadata.process || connection.metadata.sourceIP || '未知进程'}
              {connection.metadata.destinationPort && (
                <span> · :{connection.metadata.destinationPort}</span>
              )}
            </div>
          </>
        );
      case 'network':
        return (
          <span className="connection-network">{connection.metadata.network.toUpperCase()}</span>
        );
      case 'strategy':
        return (
          <>
            <div className="connection-chain" title={chain(connection)}>
              {chain(connection)}
            </div>
            <div className="resource-subline">
              {connection.rule}
              {connection.rulePayload && ` · ${connection.rulePayload}`}
            </div>
          </>
        );
      case 'download':
      case 'upload': {
        return (
          <>
            <div className="connection-traffic mono">
              {key === 'download' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
              {bytes(connection[key])}
            </div>
            <span
              className="resource-subline mono"
              title={
                closed ? '最后一次观察到的流量，可能少于关闭时的最终值' : '相邻两次采样之间的速率'
              }
            >
              {rateLabel(connection, key)}
            </span>
          </>
        );
      }
      case 'start':
        return (
          <div className="connection-duration" title={connection.start}>
            <time dateTime={connection.start}>{timeText(connection.start)}</time>
            <span className="resource-subline">
              {connectionDuration(connection.start, closed ? connection.lastSeenAt : observedAt)}
            </span>
          </div>
        );
      case 'closedAt':
        return closed ? (
          <div
            className="connection-duration"
            title={new Date(connection.closedAt).toLocaleString('zh-CN', { hour12: false })}
          >
            <time dateTime={new Date(connection.closedAt).toISOString()}>
              {timeText(connection.closedAt)}
            </time>
            <span className="resource-subline">末次 {timeText(connection.lastSeenAt)}</span>
          </div>
        ) : (
          '—'
        );
      default:
        return (
          <span
            className="connection-extra-value"
            title={String(connectionAccessors[key](connection) || '内核未提供')}
          >
            {connectionAccessors[key](connection) || '—'}
          </span>
        );
    }
  }

  const streamLabel = demo
    ? '当前为演示数据'
    : streamReady
      ? '连接列表实时更新'
      : connectionsStream.status === 'error'
        ? '连接数据异常，保留末次快照'
        : connectionsStream.lastSnapshotAt !== null
          ? '连接采样中断，保留末次快照'
          : '正在等待连接快照…';

  return (
    <div className="page-stack connections-page">
      <PageHeader
        title="连接"
        description="追踪网络请求、代理链与流量，查看本次会话内最近关闭的连接。"
      >
        <button
          className="button"
          aria-pressed={paused}
          disabled={!hasData}
          onClick={() =>
            setFrozenView(
              paused ? null : { snapshot, closed: connectionHistory, rates, observedAt },
            )
          }
        >
          {paused ? <Play size={16} /> : <Pause size={16} />}
          {paused ? '继续显示' : '暂停显示'}
        </button>
        {tab === 'active' ? (
          <button
            className="button danger"
            onClick={() => setConfirmClose(true)}
            disabled={!streamReady || !snapshot.connections.length || closingAll}
          >
            <Unplug size={16} />
            {closingAll ? '正在关闭…' : '关闭全部'}
          </button>
        ) : (
          <button
            className="button"
            disabled={!connectionHistory.length && !displayHistory.length}
            onClick={() => {
              clearConnectionHistory();
              setFrozenView((current) => (current ? { ...current, closed: [] } : null));
              setExpanded(null);
            }}
          >
            <Trash2 size={16} />
            清空本地历史
          </button>
        )}
      </PageHeader>

      {!hasData ? (
        <div className="panel">
          <EmptyState
            icon={Network}
            title="连接内核后查看网络活动"
            description="接入 Mihomo 外部控制器，实时查看连接、流量和匹配规则。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="resource-stats">
            <div className="panel resource-stat">
              <span className="resource-stat-icon">
                <Network size={19} />
              </span>
              <div>
                <span className="muted">{streamReady ? '活动连接' : '末次活动连接'}</span>
                <strong>
                  {displaySnapshot.connections.length}
                  <small>个</small>
                </strong>
              </div>
            </div>
            <div className="panel resource-stat">
              <span className="resource-stat-icon download">
                <ArrowDown size={19} />
              </span>
              <div>
                <span className="muted">累计下载</span>
                <strong>{bytes(displaySnapshot.downloadTotal)}</strong>
              </div>
            </div>
            <div className="panel resource-stat">
              <span className="resource-stat-icon upload">
                <ArrowUp size={19} />
              </span>
              <div>
                <span className="muted">累计上传</span>
                <strong>{bytes(displaySnapshot.uploadTotal)}</strong>
              </div>
            </div>
          </div>
          <section className="panel resource-table-panel">
            <div className="toolbar resource-toolbar connections-toolbar">
              <div className="toolbar-left">
                <div className="connection-tabs" role="tablist" aria-label="连接列表">
                  {(['active', 'closed'] as const).map((item) => (
                    <button
                      key={item}
                      id={`connections-tab-${item}`}
                      role="tab"
                      aria-selected={tab === item}
                      tabIndex={tab === item ? 0 : -1}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 'active'
                            : event.key === 'End'
                              ? 'closed'
                              : item === 'active'
                                ? 'closed'
                                : 'active';
                        setTab(next);
                        setExpanded(null);
                        document.getElementById(`connections-tab-${next}`)?.focus();
                      }}
                      aria-controls="connections-list"
                      className={tab === item ? 'is-active' : ''}
                      onClick={() => {
                        setTab(item);
                        setExpanded(null);
                      }}
                    >
                      {item === 'active' ? <Network size={14} /> : <History size={14} />}
                      {item === 'active' ? '活动连接' : '最近关闭'}
                      <span>
                        {item === 'active'
                          ? displaySnapshot.connections.length
                          : displayHistory.length}
                      </span>
                    </button>
                  ))}
                </div>
                {paused && <Badge tone="orange">已暂停显示</Badge>}
                {demo && <Badge tone="orange">演示数据</Badge>}
              </div>
              <div className="connection-filter-actions">
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索域名、进程或代理链…"
                />
                <div className="connection-view-toggle" role="group" aria-label="连接视图">
                  {(['table', 'list'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      aria-label={view === 'table' ? '表格视图' : '列表视图'}
                      aria-pressed={preferences.view === view}
                      title={view === 'table' ? '表格视图' : '列表视图'}
                      onClick={() => setPreferences({ ...preferences, view })}
                    >
                      {view === 'table' ? <Table2 size={15} /> : <List size={15} />}
                      <span>{view === 'table' ? '表格' : '列表'}</span>
                    </button>
                  ))}
                </div>
                {preferences.view === 'table' && (
                  <button
                    className="icon-button"
                    aria-label="管理连接列"
                    title="管理连接列"
                    onClick={() => setColumnsOpen(true)}
                  >
                    <Columns3 size={17} />
                  </button>
                )}
              </div>
            </div>
            {preferences.view === 'list' && (
              <div className="connection-list-sort">
                <label>
                  <span>排序</span>
                  <select
                    className="field"
                    aria-label="连接排序字段"
                    value={sort.key}
                    onChange={(event) => setListSort(event.target.value as ConnectionColumn)}
                  >
                    {CONNECTION_COLUMNS.filter(
                      (column) => tab === 'closed' || !column.historyOnly,
                    ).map((column) => (
                      <option value={column.key} key={column.key}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button small"
                  type="button"
                  aria-label="切换排序方向"
                  title={sort.direction === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'}
                  onClick={() => setListSort(sort.key, sort.direction === 'asc' ? 'desc' : 'asc')}
                >
                  {sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                  {sort.direction === 'asc' ? '升序' : '降序'}
                </button>
                <span>
                  {filtered.length} 条{query ? '匹配' : '连接'}
                </span>
              </div>
            )}
            {tab === 'closed' && (
              <p className="connection-history-note">
                仅记录本次接入后持续观测到的关闭连接，最多 {CONNECTION_HISTORY_LIMIT}{' '}
                条。流量取末次观测值；刷新页面或切换内核后清空。
              </p>
            )}
            <div role="tabpanel" id="connections-list" aria-labelledby={`connections-tab-${tab}`}>
              {filtered.length === 0 ? (
                <EmptyState
                  icon={tab === 'closed' ? History : Network}
                  title={
                    query
                      ? '没有匹配的连接'
                      : tab === 'closed'
                        ? '暂时没有关闭记录'
                        : '暂时没有活动连接'
                  }
                  description={
                    query
                      ? '试试其他域名、进程或代理名称。'
                      : tab === 'closed'
                        ? '连接从连续实时快照中消失后，会记录在这里。'
                        : '通过 Mihomo 访问网络后，连接会自动显示在这里。'
                  }
                />
              ) : preferences.view === 'list' ? (
                <div className="connection-card-list">
                  {sortedRows.map((connection) => {
                    const identity = connectionIdentity(connection);
                    const isExpanded = expanded === identity;
                    const closed = isClosed(connection);
                    const stillActive = activeIdentities.has(identity);
                    const rule = `${connection.rule || '未知规则'}${connection.rulePayload ? ` · ${connection.rulePayload}` : ''}`;
                    const process =
                      connection.metadata.process ||
                      connection.metadata.processPath ||
                      '未提供进程';
                    return (
                      <article
                        className={`connection-list-card${isExpanded ? ' is-expanded' : ''}`}
                        key={identity}
                        data-connection-id={connection.id}
                        aria-label={`${destination(connection)} 的连接`}
                      >
                        <div className="connection-card-main">
                          <button
                            className="connection-card-heading"
                            type="button"
                            aria-label={`${isExpanded ? '收起' : '展开'} ${destination(connection)} 的详情`}
                            aria-expanded={isExpanded}
                            onClick={() => setExpanded(isExpanded ? null : identity)}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            <span
                              className="connection-card-destination"
                              title={destination(connection)}
                            >
                              {destination(connection)}
                            </span>
                            {connection.metadata.destinationPort && (
                              <span className="connection-card-port">
                                :{connection.metadata.destinationPort}
                              </span>
                            )}
                          </button>
                          <div className="connection-card-traffic">
                            {(['download', 'upload'] as const).map((key) => (
                              <div
                                key={key}
                                data-traffic={key}
                                aria-label={key === 'download' ? '下载流量' : '上传流量'}
                              >
                                <span className="mono">
                                  {key === 'download' ? (
                                    <ArrowDown size={12} />
                                  ) : (
                                    <ArrowUp size={12} />
                                  )}
                                  {closed ? bytes(connection[key]) : rateLabel(connection, key)}
                                </span>
                                <small>
                                  {closed
                                    ? key === 'download'
                                      ? '末次下载'
                                      : '末次上传'
                                    : `总计 ${bytes(connection[key])}`}
                                </small>
                              </div>
                            ))}
                          </div>
                          {tab === 'active' && (
                            <button
                              className="icon-button resource-close connection-card-close"
                              type="button"
                              aria-label={`关闭 ${destination(connection)} 的连接`}
                              title={stillActive ? '关闭连接' : '连接已结束'}
                              disabled={
                                !streamReady ||
                                !stillActive ||
                                closing.has(connection.id) ||
                                closingAll
                              }
                              onClick={() => void closeConnection(connection)}
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                        <div className="connection-card-tags">
                          <span>{connection.metadata.network.toUpperCase()}</span>
                          <span>{connection.metadata.inboundName || connection.metadata.type}</span>
                          <span title={connection.metadata.processPath || process}>{process}</span>
                          <span className="connection-card-chain" title={chain(connection)}>
                            {chain(connection)}
                          </span>
                          <span title={rule}>{rule}</span>
                          {connection.providerChains?.length ? (
                            <span title={connection.providerChains.join(' → ')}>
                              代理集 · {connection.providerChains.join(' → ')}
                            </span>
                          ) : null}
                          <span
                            title={
                              closed
                                ? `观测关闭 ${new Date(connection.closedAt).toLocaleString('zh-CN', { hour12: false })}`
                                : connection.start
                            }
                          >
                            {closed
                              ? `观测关闭 ${timeText(connection.closedAt)}`
                              : `持续 ${connectionDuration(connection.start, observedAt)}`}
                          </span>
                        </div>
                        {isExpanded && (
                          <div className="connection-card-details">
                            <ConnectionDetails connection={connection} />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table connections-table">
                    <thead>
                      <tr>
                        <th className="expand-column" aria-label="展开详情" />
                        {columns.map((column) => (
                          <th
                            key={column.key}
                            scope="col"
                            aria-sort={
                              sort.key === column.key
                                ? sort.direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                          >
                            <button
                              type="button"
                              className="table-sort-button"
                              aria-label={`按${column.label}排序`}
                              onClick={() => toggleSort(column.key)}
                            >
                              {column.label}
                              {sort.key === column.key ? (
                                sort.direction === 'asc' ? (
                                  <ArrowUp size={14} aria-hidden="true" />
                                ) : (
                                  <ArrowDown size={14} aria-hidden="true" />
                                )
                              ) : (
                                <ArrowUpDown size={14} aria-hidden="true" />
                              )}
                            </button>
                          </th>
                        ))}
                        {tab === 'active' && <th className="resource-actions-column">操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((connection) => {
                        const identity = connectionIdentity(connection);
                        const isExpanded = expanded === identity;
                        const stillActive = activeIdentities.has(identity);
                        return (
                          <Fragment key={identity}>
                            <tr
                              className={
                                isExpanded ? 'connection-row is-expanded' : 'connection-row'
                              }
                            >
                              <td className="expand-column">
                                <button
                                  className="icon-button"
                                  aria-label={`${isExpanded ? '收起' : '展开'} ${destination(connection)} 的详情`}
                                  aria-expanded={isExpanded}
                                  onClick={() => setExpanded(isExpanded ? null : identity)}
                                >
                                  {isExpanded ? (
                                    <ChevronDown size={15} />
                                  ) : (
                                    <ChevronRight size={15} />
                                  )}
                                </button>
                              </td>
                              {columns.map((column) => (
                                <td key={column.key} data-column={column.key}>
                                  {renderCell(column.key, connection)}
                                </td>
                              ))}
                              {tab === 'active' && (
                                <td className="resource-actions-column">
                                  <button
                                    className="icon-button resource-close"
                                    aria-label={`关闭 ${destination(connection)} 的连接`}
                                    title={stillActive ? '关闭连接' : '连接已结束'}
                                    disabled={
                                      !streamReady ||
                                      !stillActive ||
                                      closing.has(connection.id) ||
                                      closingAll
                                    }
                                    onClick={() => void closeConnection(connection)}
                                  >
                                    <X size={16} />
                                  </button>
                                </td>
                              )}
                            </tr>
                            {isExpanded && (
                              <tr className="connection-detail-row">
                                <td colSpan={columns.length + (tab === 'active' ? 2 : 1)}>
                                  <ConnectionDetails connection={connection} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="resource-panel-footer">
              <span className={`live-indicator${paused || !streamReady ? ' is-idle' : ''}`} />
              {paused
                ? `已暂停显示 · ${demo ? '演示数据' : streamReady ? '内核当前' : '末次快照'} ${snapshot.connections.length} 个连接`
                : streamLabel}
              <span className="muted">
                {query ? `${filtered.length} 条匹配 · ` : ''}
                {connectionsStream.lastSnapshotAt !== null && !demo
                  ? `末次采样 ${timeText(connectionsStream.lastSnapshotAt)}`
                  : preferences.view === 'table'
                    ? '点击列标题可切换升序 / 降序'
                    : '点击目标可展开连接详情'}
              </span>
            </div>
          </section>
        </>
      )}

      {columnsOpen && (
        <Modal
          title="连接列设置"
          description="显示偏好按当前内核保存，目标列始终保留。"
          onClose={() => setColumnsOpen(false)}
        >
          <div className="connection-column-options">
            {CONNECTION_COLUMNS.map((column) => (
              <div key={column.key}>
                <span>
                  {column.label}
                  {column.historyOnly && <small>仅最近关闭</small>}
                </span>
                <Toggle
                  label={`显示${column.label}`}
                  checked={preferences.columns.includes(column.key)}
                  disabled={column.key === 'host'}
                  onChange={(enabled) =>
                    setPreferences({
                      ...preferences,
                      columns: enabled
                        ? [...preferences.columns, column.key]
                        : preferences.columns.filter((key) => key !== column.key),
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => setPreferences(defaultConnectionPreferences())}
            >
              恢复默认
            </button>
            <button className="button primary" onClick={() => setColumnsOpen(false)}>
              完成
            </button>
          </div>
        </Modal>
      )}
      {confirmClose && (
        <Modal
          title="关闭全部连接"
          description={`将关闭内核中的全部 ${snapshot.connections.length} 个活动连接，正在进行的下载或请求可能会中断。`}
          onClose={() => {
            if (!closingAll) setConfirmClose(false);
          }}
        >
          <div className="modal-actions">
            <button className="button" disabled={closingAll} onClick={() => setConfirmClose(false)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={closingAll || !streamReady}
              onClick={() => void closeAll()}
            >
              {closingAll ? '正在关闭…' : '确认关闭全部'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
