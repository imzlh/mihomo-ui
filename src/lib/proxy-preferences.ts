export type ProxySortOrder = 'original' | 'name' | 'latency';
export interface ProxyPreferences {
  version: 1;
  sortOrder: ProxySortOrder;
  showHidden: boolean;
  expandedGroups: Record<string, boolean>;
  density: 'compact' | 'comfortable';
  columns: 'auto' | 2 | 3 | 4;
  showGroupIcons: boolean;
}

export function defaultProxyPreferences(): ProxyPreferences {
  return {
    version: 1,
    sortOrder: 'original',
    showHidden: false,
    expandedGroups: {},
    density: 'compact',
    columns: 'auto',
    showGroupIcons: true,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Keep exact group names, including names shared with Object.prototype properties. */
export function validateProxyPreferences(value: unknown): ProxyPreferences {
  if (!object(value) || value.version !== 1) throw new Error('代理显示偏好格式或版本无效');
  const keys = [
    'version',
    'sortOrder',
    'showHidden',
    'expandedGroups',
    'density',
    'columns',
    'showGroupIcons',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('代理显示偏好包含未知字段');
  if (!['original', 'name', 'latency'].includes(value.sortOrder as string))
    throw new Error('节点排序无效');
  if (typeof value.showHidden !== 'boolean' || typeof value.showGroupIcons !== 'boolean')
    throw new Error('代理显示开关必须是布尔值');
  if (value.density !== 'compact' && value.density !== 'comfortable')
    throw new Error('节点间距无效');
  if (value.columns !== 'auto' && value.columns !== 2 && value.columns !== 3 && value.columns !== 4)
    throw new Error('节点列数无效');
  if (!object(value.expandedGroups)) throw new Error('代理组展开状态无效');
  const expanded = Object.entries(value.expandedGroups);
  if (
    expanded.length > 500 ||
    expanded.some(([name, open]) => !name.length || name.length > 200 || typeof open !== 'boolean')
  )
    throw new Error('最多保存 500 个代理组的展开状态，组名不能超过 200 字符');
  return {
    version: 1,
    sortOrder: value.sortOrder as ProxySortOrder,
    showHidden: value.showHidden,
    expandedGroups: Object.fromEntries(expanded) as Record<string, boolean>,
    density: value.density,
    columns: value.columns,
    showGroupIcons: value.showGroupIcons,
  };
}

export function readProxyPreferences(
  scope: string,
  onError?: (message: string) => void,
): ProxyPreferences {
  try {
    const raw = localStorage.getItem(`mihomo-verge.proxy-preferences:${scope}`);
    return raw === null ? defaultProxyPreferences() : validateProxyPreferences(JSON.parse(raw));
  } catch {
    onError?.('未能读取代理显示偏好，已使用默认显示。');
    return defaultProxyPreferences();
  }
}

export function writeProxyPreferences(scope: string, value: ProxyPreferences): void {
  localStorage.setItem(
    `mihomo-verge.proxy-preferences:${scope}`,
    JSON.stringify(validateProxyPreferences(value)),
  );
}

const MAX_ICON_LENGTH = 128 * 1024;
const dataImage =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;charset=utf-8)?(?:;base64)?,/i;

/** Icons are image sources only. Raw SVG is encoded into an inert image document. */
export function safeProxyIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (!source || source.length > MAX_ICON_LENGTH) return undefined;
  if (/^<svg(?:\s|>)/i.test(source)) {
    try {
      const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      return encoded.length <= MAX_ICON_LENGTH ? encoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (dataImage.test(source)) return source;
  if (source.length > 2048) return undefined;
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
