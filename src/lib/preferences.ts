export type HomeCardKey = 'stats' | 'memory' | 'traffic' | 'mode' | 'proxy' | 'providers' | 'core';
export type HomeChartStyle = 'area' | 'line';
export type HomeMemberSort = 'default' | 'delay' | 'name';

export interface HomePreferences {
  cards: Record<HomeCardKey, boolean>;
  chartStyle: HomeChartStyle;
  memberSort: HomeMemberSort;
  autoDelay: boolean;
  autoDelayMinutes: number;
}

export const HOME_CARD_OPTIONS: readonly { key: HomeCardKey; label: string }[] = [
  { key: 'stats', label: '实时网络指标' },
  { key: 'memory', label: '内存占用' },
  { key: 'traffic', label: '流量趋势' },
  { key: 'mode', label: '出站模式' },
  { key: 'proxy', label: '代理组出口' },
  { key: 'providers', label: '代理集' },
  { key: 'core', label: '内核配置' },
];

export const DEFAULT_HOME_PREFERENCES: HomePreferences = {
  cards: {
    stats: true,
    memory: true,
    traffic: true,
    mode: true,
    proxy: true,
    providers: true,
    core: true,
  },
  chartStyle: 'area',
  memberSort: 'default',
  autoDelay: false,
  autoDelayMinutes: 5,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHomePreferences(value: unknown): HomePreferences {
  const preferences: HomePreferences = {
    ...DEFAULT_HOME_PREFERENCES,
    cards: { ...DEFAULT_HOME_PREFERENCES.cards },
  };
  if (!isObject(value)) return preferences;

  if (isObject(value.cards)) {
    for (const { key } of HOME_CARD_OPTIONS) {
      if (typeof value.cards[key] === 'boolean') preferences.cards[key] = value.cards[key];
    }
  }
  if (value.chartStyle === 'area' || value.chartStyle === 'line') {
    preferences.chartStyle = value.chartStyle;
  }
  if (
    value.memberSort === 'default' ||
    value.memberSort === 'delay' ||
    value.memberSort === 'name'
  ) {
    preferences.memberSort = value.memberSort;
  }
  if (typeof value.autoDelay === 'boolean') preferences.autoDelay = value.autoDelay;
  if (
    typeof value.autoDelayMinutes === 'number' &&
    Number.isInteger(value.autoDelayMinutes) &&
    value.autoDelayMinutes >= 1 &&
    value.autoDelayMinutes <= 60
  ) {
    preferences.autoDelayMinutes = value.autoDelayMinutes;
  }
  return preferences;
}

/** Scope by the controller URL; never include its authentication secret. */
export function readHomePreferences(scope: string): HomePreferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`mihomo-verge.home-preferences:${scope}`) ?? 'null',
    );
    return normalizeHomePreferences(value);
  } catch {
    return normalizeHomePreferences(null);
  }
}

export function writeHomePreferences(scope: string, preferences: HomePreferences): void {
  try {
    localStorage.setItem(
      `mihomo-verge.home-preferences:${scope}`,
      JSON.stringify(normalizeHomePreferences(preferences)),
    );
  } catch {
    // Browsers can disable storage or exhaust its quota; preferences still work in memory.
  }
}
