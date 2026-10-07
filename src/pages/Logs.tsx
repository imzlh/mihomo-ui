import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, ScrollText, Trash2, Unplug } from 'lucide-react';
import { Badge, EmptyState, PageHeader, SearchInput } from '../components/ui';
import { useMihomo } from '../state/mihomo';
import type { LogEntry } from '../lib/types';
import './resources.css';

type DisplayLog = LogEntry & { id: number; time: string };
type Severity = 'all' | 'debug' | 'info' | 'warning' | 'error';

const severityLabels: Record<Severity, string> = {
  all: '所有级别',
  debug: '调试',
  info: '信息',
  warning: '警告',
  error: '错误',
};

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

export default function Logs() {
  const { connected, demo, client, logs, clearLogs } = useMihomo();
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<Severity>('all');
  const [frozenLogs, setFrozenLogs] = useState<DisplayLog[] | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const paused = frozenLogs !== null;
  const source = frozenLogs ?? logs;
  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return source.filter(
      (log) =>
        (severity === 'all' || normalizedSeverity(log.type) === severity) &&
        (!query || `${log.payload} ${log.type} ${log.time}`.toLowerCase().includes(query)),
    );
  }, [source, search, severity]);
  const visibleLogs = filteredLogs.slice(-500);

  useEffect(() => {
    setFrozenLogs(null);
  }, [client, demo]);

  useEffect(() => {
    if (followTail && !paused && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [followTail, paused, logs, search, severity]);

  const handleClear = () => {
    clearLogs();
    if (paused) setFrozenLogs([]);
  };

  return (
    <div className="page-stack">
      <PageHeader title="日志" description="查看内核运行状态，追踪每一次请求。">
        {demo && <Badge tone="purple">演示数据</Badge>}
        <button
          className="button"
          type="button"
          disabled={!connected && !demo}
          onClick={() => setFrozenLogs(paused ? null : [...logs])}
          aria-pressed={paused}
        >
          {paused ? <Play size={16} /> : <Pause size={16} />}
          {paused ? '继续显示' : '暂停显示'}
        </button>
        <button
          className="button"
          type="button"
          onClick={handleClear}
          disabled={source.length === 0 && logs.length === 0}
        >
          <Trash2 size={16} />
          清空日志
        </button>
      </PageHeader>

      {!connected && !demo ? (
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
        <section className="panel resource-log-panel" aria-label="运行日志">
          <div className="toolbar resource-toolbar resource-log-toolbar">
            <div className="toolbar-left">
              <SearchInput value={search} onChange={setSearch} placeholder="搜索日志内容…" />
              <select
                className="field resource-select"
                aria-label="日志级别"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as Severity)}
              >
                {(Object.keys(severityLabels) as Severity[]).map((level) => (
                  <option key={level} value={level}>
                    {severityLabels[level]}
                  </option>
                ))}
              </select>
              <span className="inline-count">{visibleLogs.length} 条日志</span>
              {paused && <Badge tone="orange">已暂停显示</Badge>}
            </div>
            <label className="resource-follow-tail">
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
            >
              {filteredLogs.length > 500 && (
                <div className="resource-log-limit muted">仅显示最近 500 条匹配日志</div>
              )}
              {visibleLogs.map((log) => (
                <div className="log-row" key={log.id} data-level={normalizedSeverity(log.type)}>
                  <time className="log-time mono" title={log.time}>
                    {displayTime(log.time)}
                  </time>
                  <span className="log-type">
                    <Badge tone={severityTone(log.type)}>{log.type.toUpperCase()}</Badge>
                  </span>
                  <span className="log-payload mono">{log.payload}</span>
                </div>
              ))}
            </div>
          )}
          <div className="resource-panel-footer">
            <span className="live-indicator" />
            {demo
              ? paused
                ? '已暂停演示日志显示'
                : '当前为演示数据'
              : paused
                ? '已暂停显示，日志继续在后台接收'
                : '实时接收内核日志'}
            <span className="muted">清空只移除此页面中的日志</span>
          </div>
        </section>
      )}
    </div>
  );
}
