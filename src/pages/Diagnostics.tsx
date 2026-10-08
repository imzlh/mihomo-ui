import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Database,
  Globe2,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Modal, PageHeader, Spinner } from '../components/ui';
import { ConnectivityTests } from '../components/ConnectivityTests';
import { useTableSort, type SortAccessor } from '../hooks/use-table-sort';
import type { DnsRecord, DnsResponse } from '../lib/types';
import { useMihomo } from '../state/mihomo';
import './diagnostics.css';

type CacheKind = 'dns' | 'fakeip';
type RecordSort = 'section' | 'name' | 'type' | 'ttl' | 'data';
interface QueryResult {
  name: string;
  type: string;
  response: DnsResponse;
}
interface RecordRow extends DnsRecord {
  id: string;
  section: string;
  sectionOrder: number;
}
interface Notice {
  type: 'success' | 'error';
  text: string;
}

const queryTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'HTTPS'];
const recordTypes: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  41: 'OPT',
  43: 'DS',
  46: 'RRSIG',
  48: 'DNSKEY',
  64: 'SVCB',
  65: 'HTTPS',
  257: 'CAA',
};
const responseCodes: Record<number, { name: string; description: string }> = {
  0: { name: 'NOERROR', description: '内核已返回 DNS 响应。' },
  1: { name: 'FORMERR', description: 'DNS 服务器无法解析此查询。' },
  2: { name: 'SERVFAIL', description: 'DNS 服务器未能完成解析。' },
  3: { name: 'NXDOMAIN', description: 'DNS 服务器返回域名不存在。' },
  4: { name: 'NOTIMP', description: 'DNS 服务器不支持此查询。' },
  5: { name: 'REFUSED', description: 'DNS 服务器拒绝了此查询。' },
};
const demoResult: QueryResult = {
  name: 'example.com',
  type: 'A',
  response: {
    Status: 0,
    Answer: [
      { name: 'example.com.', type: 1, TTL: 300, data: '192.0.2.10' },
      { name: 'example.com.', type: 1, TTL: 60, data: '192.0.2.20' },
    ],
  },
};
const recordAccessors: Record<RecordSort, SortAccessor<RecordRow>> = {
  section: (row) => row.sectionOrder,
  name: (row) => row.name,
  type: (row) => recordTypes[row.type] ?? row.type,
  ttl: (row) => row.TTL,
  data: (row) => row.data,
};
const columns: { key: RecordSort; label: string }[] = [
  { key: 'section', label: '记录区域' },
  { key: 'name', label: '名称' },
  { key: 'type', label: '类型' },
  { key: 'ttl', label: 'TTL（秒）' },
  { key: 'data', label: '记录值' },
];

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
  return message.includes('DNS section is disabled')
    ? '内核未启用 DNS，启用后才能执行查询。'
    : message;
}

export default function Diagnostics() {
  const { client, profile, connected, demo } = useMihomo();
  const [name, setName] = useState('example.com');
  const [queryType, setQueryType] = useState('A');
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [confirmation, setConfirmation] = useState<CacheKind | null>(null);
  const [clearing, setClearing] = useState<CacheKind | null>(null);
  const [cacheNotice, setCacheNotice] = useState<Notice | null>(null);
  const request = useRef<AbortController | null>(null);
  const lifecycle = useRef(0);
  const clearingRef = useRef(false);

  useEffect(() => {
    lifecycle.current += 1;
    setQuerying(false);
    setQueryError('');
    setResult(demo ? demoResult : null);
    setConfirmation(null);
    setClearing(null);
    setCacheNotice(null);
    clearingRef.current = false;
    return () => {
      lifecycle.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, [client, connected, demo]);

  const rows = useMemo(() => {
    if (!result) return [];
    const sections = [
      { key: 'Answer', label: '答案' },
      { key: 'Authority', label: '授权' },
      { key: 'Additional', label: '附加' },
    ] as const;
    return sections.flatMap((section, sectionOrder) =>
      (result.response[section.key] ?? []).map((record, index): RecordRow => ({
        ...record,
        id: `${section.key}-${index}`,
        section: section.label,
        sectionOrder,
      })),
    );
  }, [result]);
  const { sortedRows, sort, toggleSort, ariaSort } = useTableSort<RecordRow, RecordSort>(
    rows,
    recordAccessors,
    { key: 'section', direction: 'asc' },
  );
  const responseCode = result ? responseCodes[result.response.Status] : undefined;
  const canOperate = connected && !!client && !demo;

  async function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || !client || request.current || clearingRef.current) return;
    const domain = name.trim();
    if (!domain || domain.length > 253 || /[\s:/\\?#@]/u.test(domain)) {
      setQueryError('请输入域名，例如 example.com，不要包含协议、端口或路径。');
      return;
    }
    const controller = new AbortController();
    const generation = lifecycle.current;
    const type = queryType;
    request.current = controller;
    setQuerying(true);
    setQueryError('');
    setResult(null);
    try {
      const response = await client.dnsQuery(domain, type, controller.signal);
      if (generation === lifecycle.current && !controller.signal.aborted)
        setResult({ name: domain, type, response });
    } catch (error) {
      if (generation === lifecycle.current && !controller.signal.aborted)
        setQueryError(describeError(error));
    } finally {
      if (generation === lifecycle.current && request.current === controller) {
        request.current = null;
        setQuerying(false);
      }
    }
  }

  async function flushCache() {
    if (!confirmation || !canOperate || !client || clearingRef.current || request.current) return;
    const kind = confirmation;
    const generation = lifecycle.current;
    clearingRef.current = true;
    setClearing(kind);
    setConfirmation(null);
    setCacheNotice(null);
    try {
      if (kind === 'dns') await client.flushDns();
      else await client.flushFakeIp();
      if (generation === lifecycle.current)
        setCacheNotice({
          type: 'success',
          text: kind === 'dns' ? '内核已接受 DNS 缓存清理请求。' : '内核 Fake-IP 映射已清理。',
        });
    } catch (error) {
      if (generation === lifecycle.current)
        setCacheNotice({ type: 'error', text: describeError(error) });
    } finally {
      if (generation === lifecycle.current) {
        clearingRef.current = false;
        setClearing(null);
      }
    }
  }

  return (
    <div className="page-stack diagnostics-page">
      <PageHeader title="网络诊断" description="测试指定出口的连通性，查询 DNS 与管理内核缓存。">
        {demo && <Badge tone="purple">演示数据</Badge>}
      </PageHeader>

      {!connected && !demo ? (
        <div className="panel">
          <EmptyState
            icon={Globe2}
            title="连接内核后开始诊断"
            description="DNS 查询和缓存管理均由你连接的 Mihomo 内核执行。"
            action={
              <Link className="button primary" to="/settings">
                连接内核
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <ConnectivityTests />
          {demo && (
            <p className="info-note diagnostics-note">
              下方为本地示例记录，并非实际 DNS 结果。连接内核后即可查询和清理缓存。
            </p>
          )}

          <section className="panel diagnostics-query-panel" aria-labelledby="dns-query-title">
            <div className="diagnostics-heading">
              <span className="diagnostics-section-icon">
                <Globe2 size={21} />
              </span>
              <div>
                <h2 id="dns-query-title">DNS 查询</h2>
                <p>使用内核当前配置的 DNS 解析器查询域名。</p>
              </div>
            </div>
            <form className="diagnostics-query-form" onSubmit={(event) => void query(event)}>
              <label className="diagnostics-field">
                <span>域名</span>
                <input
                  className="field"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  placeholder="example.com"
                  value={name}
                  disabled={!canOperate || querying || !!clearing}
                  aria-invalid={!!queryError}
                  aria-describedby={queryError ? 'dns-query-error' : undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                    setQueryError('');
                  }}
                />
              </label>
              <label className="diagnostics-field">
                <span>记录类型</span>
                <select
                  className="field"
                  value={queryType}
                  disabled={!canOperate || querying || !!clearing}
                  onChange={(event) => setQueryType(event.target.value)}
                >
                  {queryTypes.map((type) => (
                    <option value={type} key={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <div className="diagnostics-query-actions">
                <button
                  className="button primary"
                  type="submit"
                  disabled={!canOperate || querying || !!clearing}
                >
                  {querying ? <Spinner /> : <Search size={16} />}
                  {querying ? '查询中…' : '查询'}
                </button>
                {querying && (
                  <button className="button" type="button" onClick={() => request.current?.abort()}>
                    <X size={16} />
                    取消
                  </button>
                )}
              </div>
            </form>
            {queryError && (
              <p id="dns-query-error" className="error-note diagnostics-note" role="alert">
                {queryError}
              </p>
            )}
            {querying && (
              <p className="diagnostics-query-status" role="status">
                <Spinner />
                正在等待内核返回解析结果…
              </p>
            )}
          </section>

          {result && (
            <section className="panel diagnostics-results" aria-labelledby="dns-result-title">
              <div className="diagnostics-result-header">
                <div>
                  <h2 id="dns-result-title">查询结果</h2>
                  <p>
                    <span className="mono">{result.name}</span>
                    <span>· {result.type}</span>
                    <span>· {rows.length} 条记录</span>
                  </p>
                </div>
                <Badge tone={demo ? 'purple' : result.response.Status === 0 ? 'green' : 'orange'}>
                  {demo ? '本地示例' : (responseCode?.name ?? `RCODE ${result.response.Status}`)}
                </Badge>
              </div>
              <div className="diagnostics-response-info" role="status">
                <span>
                  {demo
                    ? '文档保留地址，仅用于展示 DNS 记录格式。'
                    : (responseCode?.description ??
                      `内核返回 DNS 状态码 ${result.response.Status}。`)}
                </span>
                {result.response.TC && <Badge tone="orange">响应被截断</Badge>}
                {result.response.AD && <Badge>AD 认证标记</Badge>}
              </div>
              {sortedRows.length ? (
                <div className="table-wrap">
                  <table className="data-table diagnostics-record-table">
                    <thead>
                      <tr>
                        {columns.map((column) => (
                          <th key={column.key} aria-sort={ariaSort(column.key)}>
                            <button
                              type="button"
                              className="diagnostics-sort-button"
                              onClick={() => toggleSort(column.key)}
                            >
                              {column.label}
                              {sort.key !== column.key ? (
                                <ArrowUpDown size={13} />
                              ) : sort.direction === 'asc' ? (
                                <ArrowUp size={13} />
                              ) : (
                                <ArrowDown size={13} />
                              )}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <span className="diagnostics-record-section">{row.section}</span>
                          </td>
                          <td className="mono diagnostics-record-name">{row.name}</td>
                          <td>
                            <Badge>{recordTypes[row.type] ?? `TYPE ${row.type}`}</Badge>
                          </td>
                          <td className="mono">{row.TTL.toLocaleString()}</td>
                          <td className="mono diagnostics-record-data">{row.data}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  icon={Search}
                  title="没有返回 DNS 记录"
                  description={
                    result.response.Status === 0
                      ? '此查询没有答案记录。可以更换记录类型后重试。'
                      : 'DNS 服务器已返回上述状态，可以检查域名或内核 DNS 配置。'
                  }
                />
              )}
              <p className="diagnostics-result-footnote">
                TTL 为记录可缓存的秒数。答案、授权与附加记录分别由 DNS 响应提供。
              </p>
            </section>
          )}

          <section
            className="panel diagnostics-cache-panel"
            aria-labelledby="dns-cache-title"
            aria-busy={!!clearing}
          >
            <div className="diagnostics-heading">
              <span className="diagnostics-section-icon">
                <Database size={21} />
              </span>
              <div>
                <h2 id="dns-cache-title">内核缓存</h2>
                <p>清理当前连接的 Mihomo 内核缓存，后续请求将重新解析。</p>
              </div>
            </div>
            <div className="diagnostics-cache-grid">
              <article className="diagnostics-cache-card">
                <Database size={21} />
                <div>
                  <h3>DNS 缓存</h3>
                  <p>清理内核已缓存的域名解析结果。</p>
                </div>
                <button
                  className="button"
                  type="button"
                  disabled={!canOperate || !!clearing || querying}
                  onClick={() => setConfirmation('dns')}
                >
                  {clearing === 'dns' ? <Spinner /> : <Trash2 size={15} />}
                  {clearing === 'dns' ? '清理中…' : '清理 DNS'}
                </button>
              </article>
              <article className="diagnostics-cache-card">
                <ShieldCheck size={21} />
                <div>
                  <h3>Fake-IP 映射</h3>
                  <p>清理域名与 Fake-IP 的对应关系。依赖旧映射的请求可能需要重新解析。</p>
                </div>
                <button
                  className="button"
                  type="button"
                  disabled={!canOperate || !!clearing || querying}
                  onClick={() => setConfirmation('fakeip')}
                >
                  {clearing === 'fakeip' ? <Spinner /> : <Trash2 size={15} />}
                  {clearing === 'fakeip' ? '清理中…' : '清理 Fake-IP'}
                </button>
              </article>
            </div>
            {cacheNotice && (
              <p
                className={`${cacheNotice.type === 'error' ? 'error-note' : 'diagnostics-success-note'} diagnostics-note`}
                role={cacheNotice.type === 'error' ? 'alert' : 'status'}
              >
                {cacheNotice.text}
              </p>
            )}
            {demo && <p className="diagnostics-cache-hint">演示模式不会发送缓存清理请求。</p>}
          </section>
        </>
      )}

      {confirmation && (
        <Modal
          title={confirmation === 'dns' ? '清理内核 DNS 缓存？' : '清理内核 Fake-IP 映射？'}
          description={
            confirmation === 'dns'
              ? '后续请求将重新向内核配置的 DNS 解析器查询。'
              : '已缓存的域名与 Fake-IP 对应关系将被清空，依赖旧映射的请求可能需要重新解析。'
          }
          onClose={() => setConfirmation(null)}
        >
          <p className="diagnostics-confirm-target">
            目标后端：<span>{profile?.url}</span>
          </p>
          <div className="form-actions">
            <button className="button" type="button" onClick={() => setConfirmation(null)}>
              取消
            </button>
            <button
              className="button primary"
              type="button"
              disabled={!canOperate || !!clearing || querying}
              onClick={() => void flushCache()}
            >
              <Trash2 size={16} />
              确认清理
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
