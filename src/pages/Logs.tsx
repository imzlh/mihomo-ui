import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Download, Pause, Play, ScrollText, Trash2, Unplug } from 'lucide-react';
import { Badge, EmptyState, PageHeader, SearchInput } from '../components/ui';
import { useMihomo } from '../state/mihomo';
import type { LogEntry } from '../lib/types';
import { PREFERENCES_CHANGED } from '../lib/preference-events';
import './logs.css';

type DisplayLog = LogEntry & { id: number; time: string };
type Severity = 'all' | 'debug' | 'info' | 'warning' | 'error';
type LogOrder = 'asc' | 'desc';

const severityLabels: Record<Severity, string> = {
  all: '所有级别',
  debug: '调试',
  info: '信息',
  warning: '警告',
  error: '错误',
};

function readOrder(scope: string): LogOrder {
  try {
    return localStorage.getItem(`mihomo-verge.log-order:${scope}`) === 'desc' ? 'desc' : 'asc';
  } catch {
    return 'asc';
  }
}

function normalizedSeverity(type: string): string {
  const value = type.toLowerCase();
  return value === 'warn' ? 'warning' : value;
}

function severityTone(type: string): 'green' | 'purple' | 'orange' | 'red' | 'neutral' {
  switch (normalizedSeverity(type)) {
    case 'info':
      return 'green';
    case 'debug':
      return 'purple';
    case 'warning':
      return 'orange';
    case 'error':
      return 'red';
    default:
      return 'neutral';
  }
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function logsText(logs: DisplayLog[]): string {
  return logs.map((log) => `[${log.time}] ${log.type.toUpperCase()} ${log.payload}`).join('\n');
}

export default function Logs() {
  const { connected, demo, client, profile, logs, clearLogs, notify } = useMihomo();
  const scope = demo ? 'demo' : (profile?.url ?? 'offline');
  const storedOrder = useMemo(() => readOrder(scope), [scope]);
  const [orderPreference, setOrderPreference] = useState<{ scope: string; order: LogOrder }>();
  const order = orderPreference?.scope === scope ? orderPreference.order : storedOrder;
  useEffect(() => {
    const sync = () => setOrderPreference({ scope, order: readOrder(scope) });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [scope]);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<Severity>('all');
  const [frozenLogs, setFrozenLogs] = useState<DisplayLog[] | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const [selectedIds, setSelectedIds] = useState(() => new Set<number>());
  const [copying, setCopying] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const paused = frozenLogs !== null;
  const source = frozenLogs ?? logs;
  const hasCachedLogs = source.length > 0 || logs.length > 0;
  const disconnectedEmpty = !connected && !demo && !hasCachedLogs;
  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return source.filter(
      (log) =>
        (severity === 'all' || normalizedSeverity(log.type) === severity) &&
        (!query || `${log.payload} ${log.type} ${log.time}`.toLowerCase().includes(query)),
    );
  }, [source, search, severity]);
  const visibleLogs = useMemo(() => {
    const recent = filteredLogs.slice(-500);
    return order === 'desc' ? recent.reverse() : recent;
  }, [filteredLogs, order]);
  const selectedLogs = visibleLogs.filter((log) => selectedIds.has(log.id));

  useEffect(() => {
    setFrozenLogs(null);
    setSelectedIds(new Set());
    setFollowTail(true);
  }, [client, demo]);

  useEffect(() => {
    const visibleIds = new Set(visibleLogs.map((log) => log.id));
    setSelectedIds((current) => {
      const remaining = new Set([...current].filter((id) => visibleIds.has(id)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [visibleLogs]);

  useLayoutEffect(() => {
    if (followTail && listRef.current) {
      listRef.current.scrollTop = order === 'desc' ? 0 : listRef.current.scrollHeight;
    }
  }, [followTail, visibleLogs, order]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedLogs.length > 0 && selectedLogs.length < visibleLogs.length;
    }
  }, [selectedLogs.length, visibleLogs.length]);

  function changeOrder(next: LogOrder) {
    setOrderPreference({ scope, order: next });
    try {
      localStorage.setItem(`mihomo-verge.log-order:${scope}`, next);
    } catch {
      // Ordering still works in this page session when browser storage is unavailable.
    }
  }

  function clear() {
    clearLogs();
    setSelectedIds(new Set());
    if (paused) setFrozenLogs([]);
  }

  async function copy(entries: DisplayLog[]) {
    if (!entries.length || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(logsText(entries));
      notify(`已复制 ${entries.length} 条日志`);
    } catch {
      notify('复制失败，请允许浏览器访问剪贴板，或使用“导出匹配日志”。', 'error');
    } finally {
      setCopying(false);
    }
  }

  function exportLogs() {
    if (!filteredLogs.length) return;
    const entries = order === 'desc' ? [...filteredLogs].reverse() : filteredLogs;
    try {
      const blob = new Blob([logsText(entries), '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mihomo-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify('导出失败，请检查浏览器是否允许下载文件。', 'error');
    }
  }

  return (
    <div className="page-stack logs-page">
      <PageHeader title="日志" description="查看接入后的实时日志，时间为浏览器接收时间。">
        {demo && <Badge tone="purple">演示数据</Badge>}
        {!connected && hasCachedLogs && <Badge tone="orange">连接中断</Badge>}
        <button
          className="button"
          type="button"
          disabled={disconnectedEmpty}
          onClick={() => setFrozenLogs(paused ? null : [...logs])}
          aria-pressed={paused}
        >
          {paused ? <Play size={16} /> : <Pause size={16} />}
          {paused ? '继续显示' : '暂停显示'}
        </button>
        <button
          className="button"
          type="button"
          onClick={exportLogs}
          disabled={!filteredLogs.length}
        >
          <Download size={16} />
          导出匹配日志
        </button>
        <button
          className="button"
          type="button"
          onClick={clear}
          disabled={source.length === 0 && logs.length === 0}
        >
          <Trash2 size={16} />
          清空日志
        </button>
      </PageHeader>

      {disconnectedEmpty ? (
        <div className="panel">
          <EmptyState
            icon={Unplug}
            title="尚未连接到 Mihomo"
            description="连接后即可实时查看内核日志。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <section className="panel logs-panel" aria-label="运行日志">
          <div className="logs-toolbar">
            <SearchInput
              value={search}
              onChange={(value) => {
                setSearch(value);
                setSelectedIds(new Set());
              }}
              placeholder="搜索日志内容…"
            />
            <div className="logs-filters">
              <select
                className="field"
                aria-label="日志级别"
                value={severity}
                onChange={(event) => {
                  setSeverity(event.target.value as Severity);
                  setSelectedIds(new Set());
                }}
              >
                {(Object.keys(severityLabels) as Severity[]).map((level) => (
                  <option key={level} value={level}>
                    {severityLabels[level]}
                  </option>
                ))}
              </select>
              <select
                className="field"
                aria-label="日志顺序"
                value={order}
                onChange={(event) => changeOrder(event.target.value as LogOrder)}
              >
                <option value="asc">接收时间：从旧到新</option>
                <option value="desc">接收时间：从新到旧</option>
              </select>
            </div>
          </div>
          <div className="logs-selection-toolbar">
            <label className="logs-checkbox">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label="选择当前显示的日志"
                checked={visibleLogs.length > 0 && selectedLogs.length === visibleLogs.length}
                disabled={!visibleLogs.length}
                onChange={(event) =>
                  setSelectedIds(
                    new Set(event.target.checked ? visibleLogs.map((log) => log.id) : []),
                  )
                }
              />
              当前显示
            </label>
            <span className="logs-count">
              {visibleLogs.length} / {filteredLogs.length} 条匹配
            </span>
            <button
              className="button small"
              type="button"
              aria-label="复制选中日志"
              disabled={copying || !selectedLogs.length}
              onClick={() => void copy(selectedLogs)}
            >
              <Copy size={14} />
              复制选中{selectedLogs.length ? ` (${selectedLogs.length})` : ''}
            </button>
            <label className="logs-checkbox logs-follow">
              <input
                type="checkbox"
                checked={followTail}
                onChange={(event) => setFollowTail(event.target.checked)}
              />
              跟随最新
            </label>
          </div>

          {visibleLogs.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={search || severity !== 'all' ? '没有匹配的日志' : '暂无日志'}
              description={
                search || severity !== 'all'
                  ? '试试其他关键词或日志级别。'
                  : paused
                    ? '显示已暂停，继续后查看最新日志。'
                    : '新的内核日志将在这里实时显示。'
              }
            />
          ) : (
            <div
              ref={listRef}
              className="log-list"
              role="log"
              aria-label="内核日志列表"
              aria-live="off"
              tabIndex={0}
              onScroll={(event) => {
                const list = event.currentTarget;
                const distance =
                  order === 'desc'
                    ? list.scrollTop
                    : list.scrollHeight - list.clientHeight - list.scrollTop;
                if (followTail && distance > 24) setFollowTail(false);
              }}
            >
              {visibleLogs.map((log) => (
                <div
                  className="log-row"
                  key={log.id}
                  data-log-id={log.id}
                  data-level={normalizedSeverity(log.type)}
                  data-selected={selectedIds.has(log.id) || undefined}
                >
                  <input
                    className="log-selection"
                    type="checkbox"
                    aria-label="选择此条日志"
                    checked={selectedIds.has(log.id)}
                    onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(log.id);
                        else next.delete(log.id);
                        return next;
                      });
                    }}
                  />
                  <span className="log-meta">
                    <time
                      className="log-time mono"
                      dateTime={log.time}
                      title={`接收时间：${log.time}`}
                    >
                      {displayTime(log.time)}
                    </time>
                    <span className="log-type">
                      <Badge tone={severityTone(log.type)}>{log.type.toUpperCase()}</Badge>
                    </span>
                  </span>
                  <span className="log-payload mono">{log.payload}</span>
                  <button
                    className="icon-button log-copy"
                    type="button"
                    aria-label="复制此条日志"
                    title="复制此条日志"
                    disabled={copying}
                    onClick={() => void copy([log])}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="logs-footer">
            <div className="logs-status">
              {paused && <Badge tone="orange">已暂停显示</Badge>}
              <span>
                {!connected
                  ? '连接中断，已接收日志保留在本页'
                  : demo
                    ? '当前为演示数据'
                    : paused
                      ? '日志继续在后台接收'
                      : '实时接收内核日志'}
              </span>
              <span>
                {paused ? '冻结快照' : '会话缓存'} {source.length} 条
              </span>
            </div>
            <p>
              会话最多缓存 1000 条，显示最近 500 条匹配日志；导出包含
              {paused ? '冻结快照中' : '会话缓存中'}全部 {filteredLogs.length}{' '}
              条匹配结果。清空只移除此页面中的日志。
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
