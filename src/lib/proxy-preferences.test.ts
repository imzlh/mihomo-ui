import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultProxyPreferences,
  readProxyPreferences,
  safeProxyIcon,
  validateProxyPreferences,
  writeProxyPreferences,
} from './proxy-preferences';

afterEach(() => vi.unstubAllGlobals());

describe('proxy display preferences', () => {
  it('preserves exact special group names as own boolean fields without prototype mutation', () => {
    const input = {
      ...defaultProxyPreferences(),
      expandedGroups: Object.fromEntries([
        ['__proto__', true],
        ['constructor', false],
        ['  spaced  ', false],
      ]),
    };
    const result = validateProxyPreferences(input);
    expect(new Map(Object.entries(result.expandedGroups)).get('__proto__')).toBe(true);
    expect(Object.keys(result.expandedGroups)).toEqual(['__proto__', 'constructor', '  spaced  ']);
    expect(Object.getPrototypeOf(result.expandedGroups)).toBe(Object.prototype);
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
    Object.defineProperty(result.expandedGroups, 'constructor', { value: true });
    expect(new Map(Object.entries(input.expandedGroups)).get('constructor')).toBe(false);
  });

  it('rejects malformed schema and values instead of coercing backup data', () => {
    for (const patch of [
      { secret: 'private' },
      { version: '1' },
      { sortOrder: 'speed' },
      { showHidden: 'false' },
      { columns: '4' },
      { columns: 0 },
      { density: 'huge' },
      { showGroupIcons: 1 },
      { expandedGroups: { group: 'true' } },
      { expandedGroups: { '': false } },
      {
        expandedGroups: Object.fromEntries(
          Array.from({ length: 501 }, (_, index) => [`Group ${index}`, false]),
        ),
      },
    ])
      expect(() => validateProxyPreferences({ ...defaultProxyPreferences(), ...patch })).toThrow();
  });

  it('reports corrupt or unavailable storage and only writes the current controller key', () => {
    const stored = new Map([['mihomo-verge.proxy-preferences:demo', '{']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const report = vi.fn();
    expect(readProxyPreferences('demo', report)).toEqual(defaultProxyPreferences());
    expect(report).toHaveBeenCalledOnce();
    writeProxyPreferences('http://localhost:9090', {
      ...defaultProxyPreferences(),
      showHidden: true,
      columns: 4,
    });
    expect(readProxyPreferences('http://localhost:9090').showHidden).toBe(true);
    expect(stored.get('mihomo-verge.proxy-preferences:demo')).toBe('{');
    expect(stored.size).toBe(2);
  });
});

describe('group image sources', () => {
  it('accepts inert image sources and encodes raw SVG instead of inserting markup', () => {
    expect(safeProxyIcon(' https://icons.example/group.png ')).toBe(
      'https://icons.example/group.png',
    );
    expect(safeProxyIcon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect(safeProxyIcon(svg)).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  });
  it('rejects executable schemes, non-image data, embedded credentials and oversized sources', () => {
    for (const source of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///secret.png',
      'blob:https://example.com/id',
      '/icon.png',
      'https://user:password@example.com/icon.png',
      '<img src=x onerror=alert(1)>',
      '<svg>\ud800</svg>',
      `data:image/png;base64,${'A'.repeat(128 * 1024)}`,
    ])
      expect(safeProxyIcon(source)).toBeUndefined();
  });
});
