import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Network,
  Pause,
  Play,
  Unplug,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, PageHeader, SearchInput } from '../components/ui';
import { bytes, duration } from '../lib/format';
import type { Connection, ConnectionsSnapshot } from '../lib/types';
import { useTableSort, type SortAccessor } from '../hooks/use-table-sort';
import { useConnectionRates, type ConnectionRates } from '../hooks/use-connection-rates';
import { useMihomo } from '../state/mihomo';
import './resources.css';

function destination(connection: Connection): string {
  return connection.metadata.host || connection.metadata.destinationIP || '未知目标';
}

type ConnectionSortKey = 'host' | 'network' | 'strategy' | 'download' | 'upload' | 'start';
const connectionAccessors: Record<ConnectionSortKey, SortAccessor<Connection>> = {
  host: destination,
  network: (connection) => connection.metadata.network,
  strategy: (connection) =>
    `${connection.chains.slice().reverse().join(' → ')} ${connection.rule} ${connection.rulePayload}`,
  download: (connection) => connection.download,
  upload: (connection) => connection.upload,
  start: (connection) => Date.parse(connection.start),
};
const connectionColumns: { key: ConnectionSortKey; label: string }[] = [
  { key: 'host', label: '目标 / 进程' },
  { key: 'network', label: '协议' },
  { key: 'strategy', label: '策略' },
  { key: 'download', label: '下载总量' },
  { key: 'upload', label: '上传总量' },
  { key: 'start', label: '建立时间' },
];
function connectionTieBreaker(left: Connection, right: Connection): number {
  return left.id.localeCompare(right.id);
}

interface FrozenConnectionView {
  snapshot: ConnectionsSnapshot;
  durations: Record<string, string>;
  rates: ConnectionRates;
}

export default function Connections() {
  const { connected, demo, client, snapshot, runAction, notify } = useMihomo();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [closingAll, setClosingAll] = useState(false);
  const [frozenView, setFrozenView] = useState<FrozenConnectionView | null>(null);
  const rates = useConnectionRates(snapshot, client ?? (demo ? 'demo' : 'disconnected'));
  const paused = frozenView !== null;
  const displaySnapshot = frozenView?.snapshot ?? snapshot;
  const displayRates = frozenView?.rates ?? rates;
  useEffect(() => {
    setFrozenView(null);
  }, [client, demo]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return displaySnapshot.connections.filter((connection) =>
      [
        destination(connection),
        connection.metadata.destinationIP,
        connection.metadata.process,
        connection.metadata.processPath,
        connection.metadata.sourceIP,
        connection.metadata.network,
        connection.rule,
        connection.rulePayload,
        ...connection.chains,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [displaySnapshot.connections, query]);
  const { sortedRows, sort, toggleSort, ariaSort } = useTableSort<Connection, ConnectionSortKey>(
    filtered,
    connectionAccessors,
    { key: 'start', direction: 'desc' },
    connectionTieBreaker,
  );

  async function closeConnection(id: string) {
    if (demo) return notify('演示模式下不会修改实际内核', 'info');
    if (!client || !connected) return;
    setClosing((current) => new Set(current).add(id));
    try {
      const success = await runAction(() => client.closeConnection(id), '连接已关闭');
      if (success) {
        setFrozenView((current) =>
          current
            ? {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  connections: current.snapshot.connections.filter(
                    (connection) => connection.id !== id,
                  ),
                },
              }
            : null,
        );
        setExpanded((current) => (current === id ? null : current));
      }
    } finally {
      setClosing((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function closeAll() {
    if (demo) return notify('演示模式下不会修改实际内核', 'info');
    if (!client || !connected) return;
    if (
      !window.confirm(
        `确定关闭全部 ${snapshot.connections.length} 个连接？正在进行的下载或请求可能会中断。`,
      )
    )
      return;
    setClosingAll(true);
    try {
      const success = await runAction(() => client.closeAllConnections(), '全部连接已关闭');
      if (success) {
        setFrozenView((current) =>
          current ? { ...current, snapshot: { ...current.snapshot, connections: [] } } : null,
        );
        setExpanded(null);
      }
    } finally {
      setClosingAll(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="连接" description="查看实时网络请求，了解每一条连接的去向。">
        <button
          className="button"
          aria-pressed={paused}
          disabled={!connected && !demo}
          onClick={() =>
            setFrozenView(
              paused
                ? null
                : {
                    snapshot,
                    rates,
                    durations: Object.fromEntries(
                      snapshot.connections.map((connection) => [
                        connection.id,
                        duration(connection.start),
                      ]),
                    ),
                  },
            )
          }
        >
          {paused ? <Play size={16} /> : <Pause size={16} />}
          {paused ? '继续显示' : '暂停显示'}
        </button>
        <button
          className="button danger"
          onClick={() => void closeAll()}
          disabled={(!connected && !demo) || snapshot.connections.length === 0 || closingAll}
        >
          <Unplug size={16} />
          {closingAll ? '正在关闭…' : '关闭全部'}
        </button>
      </PageHeader>

      {!connected && !demo ? (
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
                <span className="muted">活动连接</span>
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
            <div className="toolbar resource-toolbar">
              <div className="toolbar-left">
                <h2 className="panel-title">活动连接</h2>
                <span className="inline-count">{filtered.length}</span>
                {paused && <Badge tone="orange">已暂停显示</Badge>}
                {demo && <Badge tone="orange">演示数据</Badge>}
              </div>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="搜索域名、进程或代理链…"
              />
            </div>
            {filtered.length === 0 ? (
              <EmptyState
                icon={Network}
                title={query ? '没有匹配的连接' : '暂时没有活动连接'}
                description={
                  query
                    ? '试试其他域名、进程或代理名称。'
                    : '通过 Mihomo 访问网络后，连接会自动显示在这里。'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data-table connections-table">
                  <thead>
                    <tr>
                      <th className="expand-column" aria-label="展开详情" />
                      {connectionColumns.map((column) => (
                        <th key={column.key} scope="col" aria-sort={ariaSort(column.key)}>
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
                      <th className="resource-actions-column">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((connection) => {
                      const isExpanded = expanded === connection.id;
                      const rate = displayRates[connection.id];
                      return (
                        <Fragment key={connection.id}>
                          <tr
                            className={isExpanded ? 'connection-row is-expanded' : 'connection-row'}
                          >
                            <td className="expand-column">
                              <button
                                className="icon-button"
                                aria-label={`${isExpanded ? '收起' : '展开'} ${destination(connection)} 的详情`}
                                aria-expanded={isExpanded}
                                onClick={() => setExpanded(isExpanded ? null : connection.id)}
                              >
                                {isExpanded ? (
                                  <ChevronDown size={15} />
                                ) : (
                                  <ChevronRight size={15} />
                                )}
                              </button>
                            </td>
                            <td>
                              <div
                                className="connection-destination"
                                title={destination(connection)}
                              >
                                {destination(connection)}
                              </div>
                              <div
                                className="resource-subline"
                                title={
                                  connection.metadata.processPath || connection.metadata.sourceIP
                                }
                              >
                                {connection.metadata.process ||
                                  connection.metadata.sourceIP ||
                                  '未知进程'}
                                {connection.metadata.destinationPort && (
                                  <span> · :{connection.metadata.destinationPort}</span>
                                )}
                              </div>
                            </td>
                            <td>
                              <span className="connection-network">
                                {connection.metadata.network.toUpperCase()}
                              </span>
                            </td>
                            <td>
                              <div
                                className="connection-chain"
                                title={connection.chains.slice().reverse().join(' → ')}
                              >
                                {connection.chains.slice().reverse().join(' → ') || 'DIRECT'}
                              </div>
                              <div className="resource-subline">
                                {connection.rule}
                                {connection.rulePayload && ` · ${connection.rulePayload}`}
                              </div>
                            </td>
                            <td className="mono">
                              <div className="connection-traffic">
                                <ArrowDown size={12} />
                                {bytes(connection.download)}
                              </div>
                              <span className="resource-subline" title="相邻两次采样之间的下载速率">
                                {rate?.download == null ? '等待采样' : `${bytes(rate.download)}/s`}
                              </span>
                            </td>
                            <td className="mono">
                              <div className="connection-traffic">
                                <ArrowUp size={12} />
                                {bytes(connection.upload)}
                              </div>
                              <span className="resource-subline" title="相邻两次采样之间的上传速率">
                                {rate?.upload == null ? '等待采样' : `${bytes(rate.upload)}/s`}
                              </span>
                            </td>
                            <td className="connection-duration" title={connection.start}>
                              <time dateTime={connection.start}>
                                {Number.isFinite(Date.parse(connection.start))
                                  ? new Date(connection.start).toLocaleTimeString('zh-CN', {
                                      hour12: false,
                                    })
                                  : '未知时间'}
                              </time>
                              <span className="resource-subline">
                                {frozenView?.durations[connection.id] ?? duration(connection.start)}
                              </span>
                            </td>
                            <td className="resource-actions-column">
                              <button
                                className="icon-button resource-close"
                                aria-label={`关闭 ${destination(connection)} 的连接`}
                                title="关闭连接"
                                disabled={closing.has(connection.id) || closingAll}
                                onClick={() => void closeConnection(connection.id)}
                              >
                                <X size={16} />
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="connection-detail-row">
                              <td colSpan={8}>
                                <dl className="connection-details">
                                  <div>
                                    <dt>连接 ID</dt>
                                    <dd className="mono">{connection.id}</dd>
                                  </div>
                                  <div>
                                    <dt>源地址</dt>
                                    <dd className="mono">
                                      {connection.metadata.sourceIP || '—'}:
                                      {connection.metadata.sourcePort}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>目标地址</dt>
                                    <dd className="mono">
                                      {connection.metadata.destinationIP || '尚未解析'}:
                                      {connection.metadata.destinationPort}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>入站类型</dt>
                                    <dd>
                                      {connection.metadata.type || '—'}
                                      {connection.metadata.inboundName &&
                                        ` / ${connection.metadata.inboundName}`}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>匹配规则</dt>
                                    <dd>
                                      {connection.rule}
                                      {connection.rulePayload ? ` (${connection.rulePayload})` : ''}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>进程路径</dt>
                                    <dd className="mono">
                                      {connection.metadata.processPath || '内核未提供'}
                                    </dd>
                                  </div>
                                </dl>
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
            <div className="resource-panel-footer">
              <span className="live-indicator" />
              {paused
                ? `已暂停显示 · ${demo ? '演示数据' : '内核当前'} ${snapshot.connections.length} 个连接`
                : demo
                  ? '当前为演示数据'
                  : '连接列表实时更新'}
              <span className="muted">
                {paused ? '关闭操作仍作用于内核中的实际连接' : '点击列标题可切换升序 / 降序'}
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
