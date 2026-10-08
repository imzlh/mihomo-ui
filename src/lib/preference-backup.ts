import {
  CONNECTION_COLUMNS,
  readConnectionPreferences,
  type ConnectionPreferences,
} from './connection-view';
import { readHomePreferences, HOME_CARD_OPTIONS, type HomePreferences } from './preferences';
import {
  readConnectivityPreferences,
  validateConnectivityPreferences,
  type ConnectivityPreferences,
} from './connectivity-tests';
import { normalizeBackendUrl, type MihomoClient } from './mihomo';
import {
  readProxyPreferences,
  validateProxyPreferences,
  type ProxyPreferences,
} from './proxy-preferences';

export const BACKUP_STORAGE_KEY = 'mihomo-verge.preferences.v1';
export const MAX_BACKUP_BYTES = 1024 * 1024;
export type BackupRemoteOperation = 'read' | 'save' | 'delete';

function createRemoteStore(client: MihomoClient | null) {
  let pending: BackupRemoteOperation | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: BackupRemoteOperation | null) => {
    pending = value;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(operation: BackupRemoteOperation): boolean {
      if (!client || pending !== null) return false;
      publish(operation);
      return true;
    },
    finish() {
      publish(null);
    },
  };
}
const remoteStores = new WeakMap<MihomoClient, ReturnType<typeof createRemoteStore>>();
const offlineRemoteStore = createRemoteStore(null);

/** Keep a request locked across route changes; each controller session is independent. */
export function preferenceBackupStore(client: MihomoClient | null) {
  if (!client) return offlineRemoteStore;
  let store = remoteStores.get(client);
  if (!store) {
    store = createRemoteStore(client);
    remoteStores.set(client, store);
  }
  return store;
}
export const PREFERENCE_LABELS = {
  theme: '界面主题',
  home: '首页布局与测速',
  homeGroup: '首页代理组',
  homeProvider: '首页代理集',
  closeOnSwitch: '切换后关闭旧连接',
  connections: '连接视图与排序',
  proxies: '代理显示偏好',
  logOrder: '日志排列顺序',
  connectivity: '连通性测试',
} as const;

export interface BackupPreferences {
  theme?: 'light' | 'dark' | 'system';
  home?: HomePreferences;
  homeGroup?: string;
  homeProvider?: string;
  closeOnSwitch?: boolean;
  connections?: ConnectionPreferences;
  proxies?: ProxyPreferences;
  logOrder?: 'asc' | 'desc';
  connectivity?: ConnectivityPreferences;
}
export interface PreferenceBackupData {
  format: 'mihomo-verge.preferences';
  version: 1;
  createdAt: string;
  source: { controller: string };
  preferences: BackupPreferences;
}

type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}格式无效`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new Error(`${label}含不支持的字段：${unknown || '空字段名'}`);
  return record;
}
function choice<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效`);
  return value as T;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 200)
    throw new Error(`${label}必须是最多 200 字符的文本`);
  return value;
}
function scope(value: unknown): string {
  if (value === 'demo' || value === 'offline') return value;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('来源控制器地址无效');
  return normalizeBackendUrl(value);
}
function home(value: unknown): HomePreferences {
  const record = object(value, '首页偏好', [
    'cards',
    'chartStyle',
    'memberSort',
    'autoDelay',
    'autoDelayMinutes',
  ]);
  const cards = object(
    record.cards,
    '首页卡片',
    HOME_CARD_OPTIONS.map(({ key }) => key),
  );
  if (
    typeof record.autoDelayMinutes !== 'number' ||
    !Number.isInteger(record.autoDelayMinutes) ||
    record.autoDelayMinutes < 1 ||
    record.autoDelayMinutes > 60
  )
    throw new Error('自动测速间隔必须是 1 到 60 分钟的整数');
  return {
    cards: Object.fromEntries(
      HOME_CARD_OPTIONS.map(({ key }) => [key, boolean(cards[key], `首页卡片 ${key}`)]),
    ) as HomePreferences['cards'],
    chartStyle: choice(record.chartStyle, ['area', 'line'], '图表样式'),
    memberSort: choice(record.memberSort, ['default', 'delay', 'name'], '成员排序'),
    autoDelay: boolean(record.autoDelay, '自动测速'),
    autoDelayMinutes: record.autoDelayMinutes,
  };
}
function connections(value: unknown): ConnectionPreferences {
  const record = object(value, '连接视图偏好', ['view', 'columns', 'activeSort', 'closedSort']);
  const keys = CONNECTION_COLUMNS.map(({ key }) => key);
  if (
    !Array.isArray(record.columns) ||
    !record.columns.length ||
    record.columns.length > keys.length
  )
    throw new Error('连接表格列无效');
  const columns = record.columns.map((key) => choice(key, keys, '连接表格列'));
  if (!columns.includes('host') || new Set(columns).size !== columns.length)
    throw new Error('连接表格必须保留目标列，且不能有重复列');
  const sort = (value: unknown, active: boolean): ConnectionPreferences['activeSort'] => {
    const record = object(value, '连接排序', ['key', 'direction']);
    return {
      key: choice(
        record.key,
        CONNECTION_COLUMNS.filter(({ historyOnly }) => !active || !historyOnly).map(
          ({ key }) => key,
        ),
        '连接排序字段',
      ),
      direction: choice(record.direction, ['asc', 'desc'], '连接排序方向'),
    };
  };
  return {
    view: 'view' in record ? choice(record.view, ['table', 'list'], '连接视图') : 'table',
    columns,
    activeSort: sort(record.activeSort, true),
    closedSort: sort(record.closedSort, false),
  };
}

/** Accept only the explicit preference schema, including at every nested level. */
export function validatePreferenceBackup(raw: unknown): PreferenceBackupData {
  const value = object(raw, '备份', ['format', 'version', 'createdAt', 'source', 'preferences']);
  if (value.format !== 'mihomo-verge.preferences' || value.version !== 1)
    throw new Error('不支持此备份格式或版本');
  if (
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error('备份创建时间无效');
  const source = object(value.source, '备份来源', ['controller']);
  const input = object(value.preferences, '偏好', Object.keys(PREFERENCE_LABELS));
  if (!Object.keys(input).length) throw new Error('备份中没有可恢复的偏好');
  const preferences: BackupPreferences = {};
  if ('theme' in input)
    preferences.theme = choice(input.theme, ['light', 'dark', 'system'], '主题');
  if ('home' in input) preferences.home = home(input.home);
  if ('homeGroup' in input) preferences.homeGroup = name(input.homeGroup, '首页代理组');
  if ('homeProvider' in input) preferences.homeProvider = name(input.homeProvider, '首页代理集');
  if ('closeOnSwitch' in input)
    preferences.closeOnSwitch = boolean(input.closeOnSwitch, '切换后关闭旧连接');
  if ('connections' in input) preferences.connections = connections(input.connections);
  if ('proxies' in input) preferences.proxies = validateProxyPreferences(input.proxies);
  if ('logOrder' in input)
    preferences.logOrder = choice(input.logOrder, ['asc', 'desc'], '日志排列顺序');
  if ('connectivity' in input)
    preferences.connectivity = validateConnectivityPreferences(input.connectivity);
  return {
    format: 'mihomo-verge.preferences',
    version: 1,
    createdAt: value.createdAt,
    source: { controller: scope(source.controller) },
    preferences,
  };
}

export function parsePreferenceBackup(text: string): PreferenceBackupData {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES)
    throw new Error('备份文件不能超过 1 MiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('无法读取备份，请选择有效的 JSON 文件');
  }
  return validatePreferenceBackup(parsed);
}

export function serializePreferenceBackup(data: PreferenceBackupData): string {
  const text = JSON.stringify(validatePreferenceBackup(data), null, 2);
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES)
    throw new Error('备份内容不能超过 1 MiB');
  return text;
}

/** Read named preferences for exactly one controller; never enumerate browser storage. */
export function createPreferenceBackup(controller: string): PreferenceBackupData {
  const current = scope(controller);
  return validatePreferenceBackup({
    format: 'mihomo-verge.preferences',
    version: 1,
    createdAt: new Date().toISOString(),
    source: { controller: current },
    preferences: {
      theme: localStorage.getItem('mihomo-verge.theme') ?? 'system',
      home: readHomePreferences(current),
      homeGroup: localStorage.getItem(`mihomo-verge.home-group:${current}`) ?? '',
      homeProvider: localStorage.getItem(`mihomo-verge.home-provider:${current}`) ?? '',
      closeOnSwitch: localStorage.getItem(`mihomo-verge.close-on-switch:${current}`) === 'true',
      connections: readConnectionPreferences(current),
      proxies: readProxyPreferences(current),
      logOrder:
        localStorage.getItem(`mihomo-verge.log-order:${current}`) === 'desc' ? 'desc' : 'asc',
      connectivity: readConnectivityPreferences(current),
    },
  });
}

/** Write only supplied categories to the target scope, rolling back a failed batch. */
export function restorePreferenceBackup(
  data: PreferenceBackupData,
  targetScope: string,
  storage: StorageAccess = localStorage,
): number {
  const { preferences } = validatePreferenceBackup(data);
  const current = scope(targetScope);
  const keys: Record<keyof BackupPreferences, string> = {
    theme: 'mihomo-verge.theme',
    home: `mihomo-verge.home-preferences:${current}`,
    homeGroup: `mihomo-verge.home-group:${current}`,
    homeProvider: `mihomo-verge.home-provider:${current}`,
    closeOnSwitch: `mihomo-verge.close-on-switch:${current}`,
    connections: `mihomo-verge.connections:${current}`,
    proxies: `mihomo-verge.proxy-preferences:${current}`,
    logOrder: `mihomo-verge.log-order:${current}`,
    connectivity: `mihomo-verge.connectivity-tests:${current}`,
  };
  const writes = (Object.keys(preferences) as (keyof BackupPreferences)[]).map((key) => ({
    key: keys[key],
    value: ['home', 'connections', 'proxies', 'connectivity'].includes(key)
      ? JSON.stringify(preferences[key])
      : String(preferences[key]),
    previous: storage.getItem(keys[key]),
  }));
  let completed = 0;
  try {
    for (const item of writes) {
      storage.setItem(item.key, item.value);
      completed += 1;
    }
  } catch {
    let rollbackFailed = false;
    for (const item of writes.slice(0, completed).reverse()) {
      try {
        if (item.previous === null) storage.removeItem(item.key);
        else storage.setItem(item.key, item.previous);
      } catch {
        rollbackFailed = true;
      }
    }
    throw new Error(
      rollbackFailed
        ? '恢复失败，部分偏好未能撤销。请检查浏览器存储权限和剩余空间。'
        : '恢复失败，已撤销本次更改。请检查浏览器存储权限和剩余空间。',
    );
  }
  return writes.length;
}
