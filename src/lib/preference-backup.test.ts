import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConnectionPreferences } from './connection-view';
import { DEFAULT_HOME_PREFERENCES } from './preferences';
import { defaultProxyPreferences } from './proxy-preferences';
import {
  BACKUP_STORAGE_KEY,
  MAX_BACKUP_BYTES,
  createPreferenceBackup,
  parsePreferenceBackup,
  restorePreferenceBackup,
  serializePreferenceBackup,
  validatePreferenceBackup,
  type PreferenceBackupData,
} from './preference-backup';

const source = 'http://127.0.0.1:9090/source';
const target = 'http://127.0.0.1:9090/target';
let stored: Map<string, string>;

function backup(): PreferenceBackupData {
  return {
    format: 'mihomo-verge.preferences',
    version: 1,
    createdAt: '2026-10-08T00:00:00.000Z',
    source: { controller: source },
    preferences: {
      theme: 'dark',
      home: {
        ...DEFAULT_HOME_PREFERENCES,
        cards: { ...DEFAULT_HOME_PREFERENCES.cards, memory: false },
      },
      homeGroup: '',
      homeProvider: '',
      closeOnSwitch: false,
      connections: defaultConnectionPreferences(),
      proxies: defaultProxyPreferences(),
      logOrder: 'asc',
      connectivity: {
        version: 1,
        targets: [{ id: 'example', name: 'Example', url: 'https://example.com/', timeout: 1000 }],
        exit: { kind: 'provider', provider: 'Remote', name: 'Exit' },
      },
    },
  };
}

function storage(overrides: Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>> = {}) {
  return {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      stored.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      stored.delete(key);
    }),
    ...overrides,
  };
}

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', storage());
});
afterEach(() => vi.unstubAllGlobals());

describe('preference backup boundaries', () => {
  it('exports known categories for one scope without reading saved controllers or unrelated data', () => {
    stored.set('mihomo-verge.backend', JSON.stringify({ url: source, secret: 'private-token' }));
    stored.set('mihomo-verge.profiles', 'private-yaml-content');
    stored.set(`mihomo-verge.home-group:${source}`, 'Source group');
    stored.set(`mihomo-verge.home-provider:${source}`, 'Source provider');
    stored.set(`mihomo-verge.home-group:${target}`, 'Other controller data');
    stored.set('arbitrary-storage', 'private-unrelated-content');
    const result = createPreferenceBackup(source);
    const text = serializePreferenceBackup(result);
    expect(BACKUP_STORAGE_KEY).toBe('mihomo-verge.preferences.v1');
    expect(result.source).toEqual({ controller: source });
    expect(result.preferences.homeGroup).toBe('Source group');
    expect(result.preferences.homeProvider).toBe('Source provider');
    expect(Object.keys(result.preferences).sort()).toEqual([
      'closeOnSwitch',
      'connections',
      'connectivity',
      'home',
      'homeGroup',
      'homeProvider',
      'logOrder',
      'proxies',
      'theme',
    ]);
    for (const value of [
      'private-token',
      'private-yaml-content',
      'Other controller data',
      'private-unrelated-content',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(localStorage.getItem).not.toHaveBeenCalledWith('mihomo-verge.backend');
    expect(localStorage.getItem).not.toHaveBeenCalledWith('mihomo-verge.profiles');
    expect(localStorage.getItem).not.toHaveBeenCalledWith(`mihomo-verge.home-group:${target}`);
  });

  it('round-trips valid false and empty values without sharing mutable input objects', () => {
    const input = backup();
    const result = parsePreferenceBackup(serializePreferenceBackup(input));
    expect(result).toEqual(input);
    expect(result.preferences.closeOnSwitch).toBe(false);
    expect(result.preferences.homeGroup).toBe('');
    expect(result.preferences.home!.cards.memory).toBe(false);
    result.preferences.home!.cards.memory = true;
    result.preferences.connections!.columns.push('process');
    expect(input.preferences.home!.cards.memory).toBe(false);
    expect(input.preferences.connections!.columns).not.toContain('process');
  });

  it.each([
    [],
    ['source'],
    ['preferences'],
    ['preferences', 'home'],
    ['preferences', 'home', 'cards'],
    ['preferences', 'connections'],
    ['preferences', 'connections', 'activeSort'],
    ['preferences', 'connections', 'closedSort'],
    ['preferences', 'proxies'],
    ['preferences', 'connectivity'],
    ['preferences', 'connectivity', 'targets', 0],
    ['preferences', 'connectivity', 'exit'],
  ])('rejects unknown fields at nested path %j', (...path) => {
    const input = backup();
    let record: unknown = input;
    for (const key of path) record = (record as Record<string | number, unknown>)[key];
    (record as Record<string, unknown>).secret = 'must never be accepted';
    expect(() => validatePreferenceBackup(input)).toThrow();
  });

  it.each(['', '__proto__', 'constructor', 'prototype'])(
    'rejects JSON property %s without prototype pollution',
    (key) => {
      const value = JSON.parse(JSON.stringify(backup())) as Record<string, unknown>;
      Object.defineProperty(value, key, { enumerable: true, value: { polluted: true } });
      expect(() => parsePreferenceBackup(JSON.stringify(value))).toThrow();
      expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    },
  );

  it('rejects inherited objects and does not coerce scalar preference types', () => {
    expect(() =>
      validatePreferenceBackup(Object.assign(Object.create({ secret: 'hidden' }), backup())),
    ).toThrow();
    const mutate = (change: (input: Record<string, any>) => void) => {
      const input = backup();
      change(input);
      expect(() => validatePreferenceBackup(input)).toThrow();
    };
    mutate((value) => {
      value.version = '1';
    });
    mutate((value) => {
      value.preferences.closeOnSwitch = 'false';
    });
    mutate((value) => {
      value.preferences.home.autoDelay = 0;
    });
    mutate((value) => {
      value.preferences.home.cards.memory = 'false';
    });
    mutate((value) => {
      value.preferences.home.autoDelayMinutes = 0;
    });
    mutate((value) => {
      value.preferences.home.autoDelayMinutes = 1.5;
    });
    mutate((value) => {
      value.preferences.home.autoDelayMinutes = '5';
    });
    mutate((value) => {
      value.preferences.home.chartStyle = 'bars';
    });
    mutate((value) => {
      value.preferences.connections.activeSort.key = 'closedAt';
    });
    mutate((value) => {
      value.preferences.connections.view = 'grid';
    });
    mutate((value) => {
      value.preferences.proxies.columns = '3';
    });
    mutate((value) => {
      value.preferences.proxies.expandedGroups = { 'Example group': 'false' };
    });
    mutate((value) => {
      value.preferences.connectivity.targets[0].timeout = '1000';
    });
  });

  it('measures the 1 MiB limit in UTF-8 bytes before JSON validation', () => {
    const text = serializePreferenceBackup(backup());
    const padded = text + ' '.repeat(MAX_BACKUP_BYTES - new TextEncoder().encode(text).byteLength);
    expect(parsePreferenceBackup(padded)).toEqual(backup());
    const multibyte = JSON.stringify({ extra: '界'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3)) });
    expect(multibyte.length).toBeLessThan(MAX_BACKUP_BYTES);
    expect(() => parsePreferenceBackup(multibyte)).toThrow(/1 MiB/);
    expect(() => parsePreferenceBackup(`${padded} `)).toThrow(/1 MiB/);
    expect(() => parsePreferenceBackup('{')).toThrow(/JSON/);
  });
});

describe('preference restoration', () => {
  it('restores proxy display and connection views only into the target controller', () => {
    const input = backup();
    const expandedGroups = Object.fromEntries([
      ['__proto__', false],
      ['constructor', true],
      ['  Group  ', false],
    ]);
    const proxies = {
      ...defaultProxyPreferences(),
      density: 'comfortable' as const,
      columns: 3 as const,
      showGroupIcons: false,
      expandedGroups,
    };
    input.preferences = {
      proxies,
      connections: { ...defaultConnectionPreferences(), view: 'list' },
    };
    stored.set(`mihomo-verge.proxy-preferences:${source}`, 'source-preferences');
    expect(restorePreferenceBackup(input, target)).toBe(2);
    expect(JSON.parse(stored.get(`mihomo-verge.proxy-preferences:${target}`)!)).toEqual(proxies);
    expect(JSON.parse(stored.get(`mihomo-verge.connections:${target}`)!).view).toBe('list');
    expect(stored.get(`mihomo-verge.proxy-preferences:${source}`)).toBe('source-preferences');
    expect(createPreferenceBackup(target).preferences.proxies).toEqual(proxies);
    expect(Object.prototype.hasOwnProperty.call(expandedGroups, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(expandedGroups)).toBe(Object.prototype);
  });

  it('accepts older backups without proxy preferences or a connection view', () => {
    const input = backup();
    delete input.preferences.proxies;
    delete (input.preferences.connections as { view?: string }).view;
    const parsed = parsePreferenceBackup(JSON.stringify(input));
    expect(parsed.preferences.connections?.view).toBe('table');
    expect(parsed.preferences.proxies).toBeUndefined();
    stored.set(`mihomo-verge.proxy-preferences:${target}`, 'target-proxy-preferences');
    restorePreferenceBackup(parsed, target);
    expect(JSON.parse(stored.get(`mihomo-verge.connections:${target}`)!).view).toBe('table');
    expect(stored.get(`mihomo-verge.proxy-preferences:${target}`)).toBe('target-proxy-preferences');
  });

  it('maps supplied categories into the current scope and leaves source, omitted categories and connection untouched', () => {
    const input = backup();
    input.preferences = { theme: 'dark', homeGroup: '', closeOnSwitch: false };
    stored.set('mihomo-verge.theme', 'light');
    stored.set('mihomo-verge.backend', 'saved-controller-and-secret');
    stored.set(`mihomo-verge.home-group:${source}`, 'Source must stay');
    stored.set(`mihomo-verge.home-group:${target}`, 'Old target');
    stored.set(`mihomo-verge.connections:${target}`, 'Unchanged columns');
    expect(restorePreferenceBackup(input, target)).toBe(3);
    expect(stored.get('mihomo-verge.backend')).toBe('saved-controller-and-secret');
    expect(stored.get(`mihomo-verge.home-group:${source}`)).toBe('Source must stay');
    expect(stored.get(`mihomo-verge.home-group:${target}`)).toBe('');
    expect(stored.get(`mihomo-verge.close-on-switch:${target}`)).toBe('false');
    expect(stored.get(`mihomo-verge.connections:${target}`)).toBe('Unchanged columns');
    expect(stored.get('mihomo-verge.theme')).toBe('dark');
  });

  it('rolls back replaced and newly introduced keys when a later write fails', () => {
    stored.set('mihomo-verge.theme', 'light');
    stored.set(`mihomo-verge.home-group:${source}`, 'Source stays');
    const before = new Map(stored);
    const access = storage({
      setItem: (key, value) => {
        if (key === `mihomo-verge.home-provider:${target}`) throw new Error('Quota exceeded');
        stored.set(key, value);
      },
    });
    expect(() => restorePreferenceBackup(backup(), target, access)).toThrow(/已撤销/);
    expect(stored).toEqual(before);
    expect(access.removeItem).toHaveBeenCalledWith(`mihomo-verge.home-group:${target}`);
  });

  it('reports incomplete rollback instead of claiming the restore was undone', () => {
    stored.set('mihomo-verge.theme', 'light');
    const access = storage({
      setItem: (key, value) => {
        if (key === `mihomo-verge.home-provider:${target}` || value === 'light')
          throw new Error('Storage unavailable');
        stored.set(key, value);
      },
    });
    expect(() => restorePreferenceBackup(backup(), target, access)).toThrow(/部分偏好未能撤销/);
    expect(stored.get('mihomo-verge.theme')).toBe('dark');
  });

  it('does not write anything if validation or reading the previous values fails', () => {
    const invalid = { ...backup(), secret: 'unexpected' };
    const access = storage();
    expect(() => restorePreferenceBackup(invalid, target, access)).toThrow();
    expect(access.setItem).not.toHaveBeenCalled();
    const unreadable = storage({
      getItem: () => {
        throw new Error('Storage denied');
      },
    });
    expect(() => restorePreferenceBackup(backup(), target, unreadable)).toThrow();
    expect(unreadable.setItem).not.toHaveBeenCalled();
  });
});
