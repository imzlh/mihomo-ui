import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOME_PREFERENCES,
  readHomePreferences,
  writeHomePreferences,
  type HomePreferences,
} from './preferences';

const scope = 'http://localhost:9090';
const storageKey = `mihomo-verge.home-preferences:${scope}`;
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('home preferences', () => {
  it('returns independent defaults for a new controller', () => {
    const preferences = readHomePreferences(scope);
    expect(preferences).toEqual(DEFAULT_HOME_PREFERENCES);
    preferences.cards.stats = false;
    expect(readHomePreferences(scope).cards.stats).toBe(true);
    expect(DEFAULT_HOME_PREFERENCES.cards.stats).toBe(true);
  });

  it.each(['{', 'undefined', '', 'null', '[]', '[{"autoDelay":true}]', 'true', '42', '"line"'])(
    'falls back to defaults for malformed or non-object JSON: %s',
    (value) => {
      stored.set(storageKey, value);
      expect(readHomePreferences(scope)).toEqual(DEFAULT_HOME_PREFERENCES);
    },
  );

  it('merges valid partial preferences and ignores unknown fields', () => {
    stored.set(
      storageKey,
      JSON.stringify({
        cards: { memory: false, core: false, unknown: false },
        chartStyle: 'line',
        memberSort: 'delay',
        autoDelay: true,
        unknown: 'ignored',
      }),
    );
    expect(readHomePreferences(scope)).toEqual({
      ...DEFAULT_HOME_PREFERENCES,
      cards: { ...DEFAULT_HOME_PREFERENCES.cards, memory: false, core: false },
      chartStyle: 'line',
      memberSort: 'delay',
      autoDelay: true,
    });
  });

  it('rejects mistyped booleans and invalid enum values without coercion', () => {
    stored.set(
      storageKey,
      JSON.stringify({
        cards: { stats: 'false', memory: 0, traffic: null, mode: [], proxy: false },
        chartStyle: 'bars',
        memberSort: 'speed',
        autoDelay: 'true',
      }),
    );
    expect(readHomePreferences(scope)).toEqual({
      ...DEFAULT_HOME_PREFERENCES,
      cards: { ...DEFAULT_HOME_PREFERENCES.cards, proxy: false },
    });
  });

  it.each([null, [], false, 'stats', 0])('rejects an invalid cards shape: %j', (cards) => {
    stored.set(storageKey, JSON.stringify({ cards, memberSort: 'name' }));
    expect(readHomePreferences(scope)).toEqual({
      ...DEFAULT_HOME_PREFERENCES,
      memberSort: 'name',
    });
  });

  it.each([0, -1, 61, 1.5, '5', null, true])(
    'falls back to five minutes for an invalid interval: %j',
    (autoDelayMinutes) => {
      stored.set(storageKey, JSON.stringify({ autoDelayMinutes }));
      expect(readHomePreferences(scope).autoDelayMinutes).toBe(5);
    },
  );

  it.each([1, 5, 60])('accepts an integer interval of %i minutes', (autoDelayMinutes) => {
    stored.set(storageKey, JSON.stringify({ autoDelayMinutes }));
    expect(readHomePreferences(scope).autoDelayMinutes).toBe(autoDelayMinutes);
  });

  it('persists preferences independently for each exact controller scope', () => {
    const otherScope = 'https://example.com/controller/';
    const preferences: HomePreferences = {
      ...DEFAULT_HOME_PREFERENCES,
      cards: { ...DEFAULT_HOME_PREFERENCES.cards, providers: false },
      chartStyle: 'line',
      memberSort: 'name',
      autoDelay: true,
      autoDelayMinutes: 12,
    };
    writeHomePreferences(scope, preferences);
    writeHomePreferences(otherScope, DEFAULT_HOME_PREFERENCES);

    expect(stored.get(storageKey)).toBe(JSON.stringify(preferences));
    expect(stored.has(`mihomo-verge.home-preferences:${otherScope}`)).toBe(true);
    expect(readHomePreferences(scope)).toEqual(preferences);
    expect(readHomePreferences(otherScope)).toEqual(DEFAULT_HOME_PREFERENCES);
    expect(readHomePreferences('https://example.com/controller')).toEqual(DEFAULT_HOME_PREFERENCES);
  });

  it('continues with defaults when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage disabled');
      },
      setItem: () => {
        throw new Error('Storage disabled');
      },
    });
    expect(readHomePreferences(scope)).toEqual(DEFAULT_HOME_PREFERENCES);
    expect(() => writeHomePreferences(scope, DEFAULT_HOME_PREFERENCES)).not.toThrow();
  });
});
