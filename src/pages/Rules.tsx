import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  LoaderCircle,
  Power,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, PageHeader, SearchInput } from '../components/ui';
import { useMihomo } from '../state/mihomo';
import type { Rule } from '../lib/types';
import { useTableSort, type SortAccessor } from '../hooks/use-table-sort';
import './resources.css';

const PAGE_SIZE = 100;
type DisplayRule = Rule & { priority: number; ruleIndex: number };
type RuleSortKey = 'priority' | 'type' | 'payload' | 'proxy' | 'hitCount' | 'disabled';
const ruleAccessors: Record<RuleSortKey, SortAccessor<DisplayRule>> = {
  priority: (rule) => rule.priority,
  type: (rule) => rule.type,
  payload: (rule) => rule.payload,
  proxy: (rule) => rule.proxy,
  hitCount: (rule) => rule.extra?.hitCount,
  disabled: (rule) => (rule.extra?.disabled === undefined ? null : Number(rule.extra.disabled)),
};
const ruleColumns: { key: RuleSortKey; label: string }[] = [
  { key: 'priority', label: '优先级' },
  { key: 'type', label: '类型' },
  { key: 'payload', label: '规则内容' },
  { key: 'proxy', label: '代理策略' },
];
function ruleTieBreaker(left: DisplayRule, right: DisplayRule): number {
  return left.priority - right.priority;
}

export default function Rules() {
  const { connected, demo, client, rules, runAction, refresh, notify } = useMihomo();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingRules, setPendingRules] = useState<Set<number>>(new Set());
  const pendingActions = useRef(new Set<number>());
  const session = useMemo(() => ({ client, demo }), [client, demo]);
  const currentSession = useRef<typeof session | null>(session);
  useEffect(() => {
    currentSession.current = session;
    pendingActions.current.clear();
    setPendingRules(new Set());
    setRefreshing(false);
    return () => {
      currentSession.current = null;
    };
  }, [session]);
  const hasExtra = rules.some((rule) => rule.extra !== undefined);
  const columns: typeof ruleColumns = [
    ...ruleColumns,
    ...(hasExtra ? [{ key: 'hitCount' as const, label: '命中次数' }] : []),
    { key: 'disabled', label: '状态' },
  ];
  const types = useMemo(() => [...new Set(rules.map((rule) => rule.type))].sort(), [rules]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rules
      .map((rule, arrayIndex) => {
        const ruleIndex = rule.index ?? arrayIndex;
        return { ...rule, ruleIndex, priority: ruleIndex + 1 };
      })
      .filter(
        (rule) =>
          (type === 'all' || rule.type === type) &&
          [rule.type, rule.payload, rule.proxy].join(' ').toLowerCase().includes(needle),
      );
  }, [rules, query, type]);
  const { sortedRows, sort, toggleSort, ariaSort } = useTableSort<DisplayRule, RuleSortKey>(
    filtered,
    ruleAccessors,
    { key: 'priority', direction: 'asc' },
    ruleTieBreaker,
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = sortedRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function reload() {
    if (demo) return notify('正在浏览演示数据', 'info');
    if (!connected) return;
    setRefreshing(true);
    try {
      await runAction(refresh, '规则已刷新');
    } finally {
      if (currentSession.current === session) setRefreshing(false);
    }
  }

  async function toggleRule(rule: DisplayRule) {
    if (demo) return notify('演示模式下不会修改实际内核', 'info');
    if (
      !client ||
      !connected ||
      typeof rule.extra?.disabled !== 'boolean' ||
      pendingActions.current.has(rule.ruleIndex)
    )
      return;
    pendingActions.current.add(rule.ruleIndex);
    setPendingRules((current) => new Set(current).add(rule.ruleIndex));
    const disabled = rule.extra?.disabled !== true;
    try {
      await runAction(
        async () => {
          await client.disableRules({ [String(rule.ruleIndex)]: disabled });
          const actual = (await client.rules()).find(
            (item, index) => (item.index ?? index) === rule.ruleIndex,
          );
          if (
            !actual ||
            actual.type !== rule.type ||
            actual.payload !== rule.payload ||
            actual.proxy !== rule.proxy
          )
            throw new Error('规则列表已改变，无法确认这次修改。请刷新规则后重试。');
          if (actual.extra?.disabled !== disabled)
            throw new Error(`第 ${rule.priority} 条规则的临时状态未生效，请检查内核状态后重试。`);
        },
        `第 ${rule.priority} 条规则已${disabled ? '临时禁用' : '启用'}`,
      );
    } finally {
      if (currentSession.current === session) {
        pendingActions.current.delete(rule.ruleIndex);
        setPendingRules((current) => {
          const next = new Set(current);
          next.delete(rule.ruleIndex);
          return next;
        });
      }
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="规则" description="请求按顺序匹配规则，第一条命中的规则决定代理策略。">
        <button
          className="button"
          disabled={refreshing || (!connected && !demo)}
          onClick={() => void reload()}
        >
          <RefreshCw size={16} className={refreshing ? 'resource-spinning' : ''} />
          刷新规则
        </button>
      </PageHeader>
      {!connected && !demo ? (
        <div className="panel">
          <EmptyState
            icon={ShieldCheck}
            title="连接内核后查看规则"
            description="展示 Mihomo 当前配置中的路由规则及实际匹配顺序。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <section className="panel resource-table-panel">
          <div className="toolbar resource-toolbar">
            <div className="toolbar-left">
              <h2 className="panel-title">路由规则</h2>
              <span className="inline-count">{rules.length}</span>
              {demo && <Badge tone="orange">演示数据</Badge>}
            </div>
            <div className="resource-filters">
              <label className="resource-select-wrap">
                <ListFilter size={15} />
                <select
                  className="field resource-select"
                  aria-label="按规则类型筛选"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">全部类型</option>
                  {types.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <SearchInput
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setPage(1);
                }}
                placeholder="搜索规则内容或策略…"
              />
            </div>
          </div>
          {visible.length === 0 ? (
            <EmptyState
              icon={ListFilter}
              title={query || type !== 'all' ? '没有匹配的规则' : '当前配置没有路由规则'}
              description={
                query || type !== 'all'
                  ? '更换筛选条件或搜索词后再试。'
                  : '在内核配置中添加 rules 后，规则会显示在这里。'
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table rules-table">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        className={column.key === 'priority' ? 'rule-priority' : undefined}
                        scope="col"
                        aria-sort={ariaSort(column.key)}
                      >
                        <button
                          type="button"
                          className="table-sort-button"
                          aria-label={`按${column.label}排序`}
                          onClick={() => {
                            toggleSort(column.key);
                            setPage(1);
                          }}
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
                  </tr>
                </thead>
                <tbody>
                  {visible.map((rule) => (
                    <tr
                      key={rule.ruleIndex}
                      data-rule-index={rule.ruleIndex}
                      className={rule.extra?.disabled ? 'rule-row-disabled' : undefined}
                    >
                      <td className="rule-priority mono" title={`内核规则索引：${rule.ruleIndex}`}>
                        {String(rule.priority).padStart(2, '0')}
                      </td>
                      <td>
                        <Badge tone={rule.type.toLowerCase() === 'match' ? 'orange' : 'neutral'}>
                          {rule.type}
                        </Badge>
                      </td>
                      <td className="mono rule-payload" title={rule.payload}>
                        {rule.payload ||
                          (rule.type.toLowerCase() === 'match' ? '所有剩余流量' : '—')}
                        {typeof rule.size === 'number' && rule.size >= 0 && (
                          <span className="resource-subline">
                            {rule.size.toLocaleString()} 条子规则
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`rule-strategy ${rule.proxy === 'DIRECT' ? 'is-direct' : rule.proxy === 'REJECT' || rule.proxy === 'REJECT-DROP' ? 'is-reject' : ''}`}
                        >
                          <ArrowRight size={13} />
                          {rule.proxy}
                        </span>
                      </td>
                      {hasExtra && (
                        <td className="mono rule-hit-count">
                          <span
                            title={rule.extra?.hitAt ? `最近命中：${rule.extra.hitAt}` : undefined}
                          >
                            {typeof rule.extra?.hitCount === 'number'
                              ? rule.extra.hitCount.toLocaleString()
                              : '—'}
                          </span>
                          {typeof rule.extra?.missCount === 'number' && (
                            <span
                              className="resource-subline"
                              title={
                                rule.extra.missAt ? `最近未命中：${rule.extra.missAt}` : undefined
                              }
                            >
                              未命中 {rule.extra.missCount.toLocaleString()}
                            </span>
                          )}
                        </td>
                      )}
                      <td>
                        <div className="rule-status-controls">
                          <Badge
                            tone={
                              rule.extra?.disabled
                                ? 'orange'
                                : rule.extra?.disabled === false
                                  ? 'green'
                                  : 'neutral'
                            }
                          >
                            {rule.extra?.disabled
                              ? '已禁用'
                              : rule.extra?.disabled === false
                                ? '已启用'
                                : '状态未提供'}
                          </Badge>
                          <button
                            type="button"
                            className="button small"
                            disabled={
                              typeof rule.extra?.disabled !== 'boolean' ||
                              pendingRules.has(rule.ruleIndex)
                            }
                            aria-label={`${rule.extra?.disabled ? '启用' : '临时禁用'}第 ${rule.priority} 条规则`}
                            title={
                              typeof rule.extra?.disabled === 'boolean'
                                ? '临时开关，内核重启后重置'
                                : '内核未提供此规则的临时启停能力'
                            }
                            onClick={() => void toggleRule(rule)}
                          >
                            {pendingRules.has(rule.ruleIndex) ? (
                              <LoaderCircle size={14} className="resource-spinning" />
                            ) : (
                              <Power size={14} />
                            )}
                            {rule.extra?.disabled ? '启用' : '禁用'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="resource-panel-footer resource-sort-note">
            排序仅改变显示，不改变内核匹配顺序；临时禁用会在内核重启后重置。
          </div>
          <div className="resource-pagination">
            <span className="muted">
              {filtered.length
                ? `第 ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} 条，共 ${filtered.length.toLocaleString()} 条`
                : '共 0 条规则'}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="上一页规则"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={17} />
              </button>
              <span className="mono">
                {currentPage} / {pages}
              </span>
              <button
                className="icon-button"
                aria-label="下一页规则"
                disabled={currentPage >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
