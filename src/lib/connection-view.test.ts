import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConnectionPreferences, writeConnectionPreferences } from './connection-view';

afterEach(() => vi.unstubAllGlobals());

describe('connection view preferences', () => {
  it('keeps the table default for an older preference while preserving its columns and sort', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          columns: ['host', 'network'],
          activeSort: { key: 'host', direction: 'asc' },
        }),
    });
    expect(readConnectionPreferences('legacy')).toMatchObject({
      view: 'table',
      columns: ['host', 'network'],
      activeSort: { key: 'host', direction: 'asc' },
    });
  });

  it('stores list preference separately for each controller and retains the table configuration', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const previous = readConnectionPreferences('https://controller-a.example');
    writeConnectionPreferences('https://controller-a.example', { ...previous, view: 'list' });
    expect(readConnectionPreferences('https://controller-a.example')).toEqual({
      ...previous,
      view: 'list',
    });
    expect(readConnectionPreferences('https://controller-b.example')).toEqual(previous);
  });

  it.each(['grid', null, true])('falls back to table for unsupported view %s', (view) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ view }) });
    expect(readConnectionPreferences('controller').view).toBe('table');
  });
});
