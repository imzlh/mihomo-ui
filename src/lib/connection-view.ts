import type { SortState } from '../hooks/use-table-sort';

export type ConnectionColumn =
  | 'host'
  | 'network'
  | 'strategy'
  | 'download'
  | 'upload'
  | 'start'
  | 'source'
  | 'destination'
  | 'process'
  | 'inbound'
  | 'provider'
  | 'rule'
  | 'closedAt';

export const CONNECTION_COLUMNS: readonly {
  key: ConnectionColumn;
  label: string;
  historyOnly?: boolean;
}[] = [
  { key: 'host', label: '目标 / 进程' },
  { key: 'network', label: '协议' },
  { key: 'strategy', label: '策略' },
  { key: 'download', label: '下载总量' },
  { key: 'upload', label: '上传总量' },
  { key: 'start', label: '建立时间' },
  { key: 'source', label: '源地址' },
  { key: 'destination', label: '目标地址' },
  { key: 'process', label: '进程路径' },
  { key: 'inbound', label: '入站' },
  { key: 'provider', label: '代理集' },
  { key: 'rule', label: '匹配规则' },
  { key: 'closedAt', label: '观测关闭时间', historyOnly: true },
];

export interface ConnectionPreferences {
  view: 'table' | 'list';
  columns: ConnectionColumn[];
  activeSort: SortState<ConnectionColumn>;
  closedSort: SortState<ConnectionColumn>;
}

export function defaultConnectionPreferences(): ConnectionPreferences {
  return {
    view: 'table',
    columns: ['host', 'network', 'strategy', 'download', 'upload', 'start', 'closedAt'],
    activeSort: { key: 'start', direction: 'desc' },
    closedSort: { key: 'closedAt', direction: 'desc' },
  };
}

export function readConnectionPreferences(scope: string): ConnectionPreferences {
  const defaults = defaultConnectionPreferences();
  try {
    const value = JSON.parse(
      localStorage.getItem(`mihomo-verge.connections:${scope}`) ?? 'null',
    ) as Partial<ConnectionPreferences> | null;
    if (!value || typeof value !== 'object') return defaults;
    if (value.view === 'table' || value.view === 'list') defaults.view = value.view;
    if (Array.isArray(value.columns)) {
      defaults.columns = CONNECTION_COLUMNS.filter(
        ({ key }) => key === 'host' || value.columns!.includes(key),
      ).map(({ key }) => key);
    }
    for (const field of ['activeSort', 'closedSort'] as const) {
      const sort = value[field];
      if (
        sort &&
        CONNECTION_COLUMNS.some(
          ({ key, historyOnly }) => key === sort.key && (field === 'closedSort' || !historyOnly),
        ) &&
        (sort.direction === 'asc' || sort.direction === 'desc')
      )
        defaults[field] = sort;
    }
  } catch {
    /* Use defaults when storage is disabled or invalid. */
  }
  return defaults;
}

export function writeConnectionPreferences(scope: string, value: ConnectionPreferences): void {
  try {
    localStorage.setItem(`mihomo-verge.connections:${scope}`, JSON.stringify(value));
  } catch {
    /* Preferences remain usable in this page when browser storage is unavailable. */
  }
}

export function connectionDuration(start: string, end: number): string {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1_000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3_600)} 小时`;
}

export function connectionAddress(
  ip: string | undefined,
  port: string | number | undefined,
): string {
  if (!ip) return port ? `—:${port}` : '—';
  return `${ip.includes(':') ? `[${ip}]` : ip}${port ? `:${port}` : ''}`;
}
