import {
  PROFILE_YAML_MAX_BYTES,
  isGlobalProfileEnhancement,
  isProfileEnhancement,
  parseProfileYaml,
  type GlobalProfileEnhancement,
  type ProfileEnhancement,
} from './profile-enhancement';

export interface ProfileEntry {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceUrl?: string;
  enhancement?: ProfileEnhancement;
  createdAt: number;
  updatedAt: number;
}

export type ProfileScope = 'local' | 'demo';
export const PROFILE_MAX_BYTES = PROFILE_YAML_MAX_BYTES;
export function createProfileId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // LAN HTTP deployments lack randomUUID; getRandomValues is available there.
  const values = crypto.getRandomValues(new Uint32Array(4));
  return `profile-${Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('')}`;
}
export const profileLibraryKey = (scope: ProfileScope): string =>
  `mihomo-verge.profile-library:${scope}`;

/** Validate without serializing: comments, anchors and the user's formatting stay intact. */
export function validateProfileYaml(content: string): string | null {
  try {
    parseProfileYaml(content);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '无法解析 YAML 配置。';
  }
}

function isProfileEntry(value: unknown): value is ProfileEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    !!item.id &&
    typeof item.name === 'string' &&
    !!item.name.trim() &&
    typeof item.description === 'string' &&
    typeof item.content === 'string' &&
    (item.sourceUrl === undefined || typeof item.sourceUrl === 'string') &&
    (item.enhancement === undefined || isProfileEnhancement(item.enhancement)) &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt) &&
    typeof item.updatedAt === 'number' &&
    Number.isFinite(item.updatedAt)
  );
}

export function readProfileLibrary(
  scope: ProfileScope,
  storage: Pick<Storage, 'getItem'> = localStorage,
): ProfileEntry[] {
  let raw: string | null;
  try {
    raw = storage.getItem(profileLibraryKey(scope));
  } catch {
    throw new Error('浏览器未允许读取配置库，请检查存储权限后重试。');
  }
  if (raw === null) return [];
  try {
    const library = JSON.parse(raw) as { version?: unknown; profiles?: unknown };
    if (
      !library ||
      library.version !== 1 ||
      !Array.isArray(library.profiles) ||
      !library.profiles.every(isProfileEntry)
    )
      throw new Error();
    if (new Set(library.profiles.map((item) => item.id)).size !== library.profiles.length)
      throw new Error();
    return library.profiles;
  } catch {
    throw new Error('浏览器配置库格式损坏，现有数据已保留。请检查本地存储后重新读取。');
  }
}

/** Callers commit their in-memory state only after this write succeeds. */
export function writeProfileLibrary(
  scope: ProfileScope,
  profiles: ProfileEntry[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(profileLibraryKey(scope), JSON.stringify({ version: 1, profiles }));
  } catch {
    throw new Error('配置未保存：浏览器存储空间不足或未允许写入。可先下载原文保留修改。');
  }
}

export function normalizeProfileSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入完整的 HTTP 或 HTTPS 配置地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('配置来源仅支持 HTTP 和 HTTPS。');
  if (url.username || url.password) throw new Error('来源地址不能包含用户名或密码。');
  url.hash = '';
  return url.toString();
}

/** Direct browser fetch; no proxy, controller secret, or background polling. */
export async function fetchProfileSource(
  value: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = normalizeProfileSourceUrl(value);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok)
      throw new Error(
        `来源返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}。`,
      );
    if (Number(response.headers.get('content-length')) > PROFILE_MAX_BYTES)
      throw new Error('来源配置超过 5 MiB，已停止读取。');
    const reader = response.body?.getReader();
    if (!reader) {
      const content = await response.text();
      if (new TextEncoder().encode(content).byteLength > PROFILE_MAX_BYTES)
        throw new Error('来源配置超过 5 MiB。');
      return content;
    }
    const decoder = new TextDecoder();
    let size = 0;
    let content = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > PROFILE_MAX_BYTES) {
          await reader.cancel();
          throw new Error('来源配置超过 5 MiB，已停止读取。');
        }
        content += decoder.decode(chunk.value, { stream: true });
      }
      return content + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (timedOut) throw new Error('读取来源超时（20 秒），请稍后重试。');
    if (signal?.aborted) throw error;
    if (error instanceof TypeError)
      throw new Error(`浏览器无法读取来源：${error.message}。请检查网络和来源站点的 CORS 许可。`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function profileFileName(name: string): string {
  const clean =
    name
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/, '') || 'config';
  return /\.ya?ml$/i.test(clean) ? clean : `${clean}.yaml`;
}

export const PROFILE_ARCHIVE_FORMAT = 'mihomo-verge-profile-archive';
export const PROFILE_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

export interface ProfileArchiveEntry {
  name: string;
  description: string;
  content: string;
  sourceUrl?: string;
  enhancement?: ProfileEnhancement;
}

export interface ProfileImportItem extends ProfileArchiveEntry {
  label: string;
  error?: string;
}

/** A portable archive of original configurations, separate from UI preference backups. */
export function serializeProfileArchive(
  profiles: readonly ProfileArchiveEntry[],
  { globalEnhancement }: { globalEnhancement?: GlobalProfileEnhancement } = {},
): string {
  if (globalEnhancement !== undefined && !isGlobalProfileEnhancement(globalEnhancement))
    throw new Error('全局增强字段格式错误，无法导出归档。');
  const content = JSON.stringify(
    {
      format: PROFILE_ARCHIVE_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      ...(globalEnhancement !== undefined ? { globalEnhancement } : {}),
      profiles: profiles.map(({ name, description, content, sourceUrl, enhancement }) => ({
        name,
        description,
        content,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(enhancement !== undefined ? { enhancement } : {}),
      })),
    },
    null,
    2,
  );
  if (new TextEncoder().encode(content).byteLength > PROFILE_ARCHIVE_MAX_BYTES)
    throw new Error('归档超过 20 MiB，请减少所选配置后分批导出。');
  return content;
}

export function createProfileImportItem(
  label: string,
  content: string,
  metadata?: Partial<ProfileArchiveEntry>,
): ProfileImportItem {
  const item: ProfileImportItem = {
    label,
    name: metadata?.name ?? label.replace(/\.ya?ml$/i, ''),
    description: metadata?.description ?? '',
    content,
    ...(metadata?.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    ...(metadata?.enhancement !== undefined ? { enhancement: metadata.enhancement } : {}),
  };
  if (!item.name.trim()) item.error = '配置名称不能为空。';
  else item.error = validateProfileYaml(content) ?? undefined;
  if (!item.error && item.enhancement !== undefined && !isProfileEnhancement(item.enhancement))
    item.error = '配置增强字段格式错误或内容过大。';
  if (!item.error && item.sourceUrl) {
    try {
      normalizeProfileSourceUrl(item.sourceUrl);
    } catch (error) {
      item.error = error instanceof Error ? error.message : '来源 URL 无效。';
    }
  }
  return item;
}

/** Invalid archive headers reject the archive; invalid entries remain visible in the preview. */
export function parseProfileArchiveBundle(content: string): {
  items: ProfileImportItem[];
  globalEnhancement?: GlobalProfileEnhancement;
} {
  if (new TextEncoder().encode(content).byteLength > PROFILE_ARCHIVE_MAX_BYTES)
    throw new Error('配置归档不能超过 20 MiB。');
  let archive: unknown;
  try {
    archive = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('无法读取配置归档，请选择导出的 JSON 配置归档。');
  }
  if (
    !archive ||
    typeof archive !== 'object' ||
    !('format' in archive) ||
    archive.format !== PROFILE_ARCHIVE_FORMAT ||
    !('version' in archive) ||
    archive.version !== 1 ||
    !('profiles' in archive) ||
    !Array.isArray(archive.profiles)
  )
    throw new Error('这不是支持的完整配置归档（版本 1）。偏好备份不能在这里导入。');
  if (!archive.profiles.length) throw new Error('配置归档中没有配置。');
  const globalEnhancement = 'globalEnhancement' in archive ? archive.globalEnhancement : undefined;
  if (globalEnhancement !== undefined && !isGlobalProfileEnhancement(globalEnhancement))
    throw new Error('归档中的全局增强字段格式错误或内容过大。');
  const items = archive.profiles.map((value: unknown, index: number) => {
    const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const name = typeof item.name === 'string' ? item.name : `配置 ${index + 1}`;
    const label = `${index + 1}. ${name}`;
    if (
      typeof item.name !== 'string' ||
      typeof item.description !== 'string' ||
      typeof item.content !== 'string' ||
      (item.sourceUrl !== undefined && typeof item.sourceUrl !== 'string') ||
      (item.enhancement !== undefined && !isProfileEnhancement(item.enhancement))
    )
      return {
        label,
        name,
        description: typeof item.description === 'string' ? item.description : '',
        content: typeof item.content === 'string' ? item.content : '',
        error: '配置条目字段不完整或格式错误。',
      };
    return createProfileImportItem(label, item.content, {
      name: item.name,
      description: item.description,
      sourceUrl: item.sourceUrl as string | undefined,
      enhancement: item.enhancement as ProfileEnhancement | undefined,
    });
  });
  return { items, ...(globalEnhancement !== undefined ? { globalEnhancement } : {}) };
}

export function parseProfileArchive(content: string): ProfileImportItem[] {
  return parseProfileArchiveBundle(content).items;
}

/** Always make new copies: archive IDs, timestamps and applied-state claims are not imported. */
export function createImportedProfiles(
  items: readonly ProfileImportItem[],
  existing: readonly ProfileEntry[] = [],
): ProfileEntry[] {
  const used = new Set(existing.map((item) => item.id));
  const now = Date.now();
  return items
    .filter((item) => !item.error)
    .map(({ name, description, content, sourceUrl, enhancement }) => {
      let id = createProfileId();
      while (used.has(id)) id = createProfileId();
      used.add(id);
      return {
        id,
        name,
        description,
        content,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(enhancement !== undefined ? { enhancement: structuredClone(enhancement) } : {}),
        createdAt: now,
        updatedAt: now,
      };
    });
}

/** Move against the latest full library, preserving additions made in another browser tab. */
export function moveProfile(
  profiles: readonly ProfileEntry[],
  id: string,
  direction: 'up' | 'down',
): ProfileEntry[] {
  const next = [...profiles];
  const index = next.findIndex((item) => item.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

interface AppliedProfile {
  id: string;
  content: string;
  generatedContent?: string;
  enhancementSignature?: string;
  appliedAt: number;
}
const appliedProfiles = new WeakMap<object, AppliedProfile>();
const appliedListeners = new WeakMap<object, Set<() => void>>();
export const lastAppliedProfile = (client: object | null): AppliedProfile | undefined =>
  client ? appliedProfiles.get(client) : undefined;
export function rememberAppliedProfile(
  client: object,
  profile: ProfileEntry,
  options: { content?: string; enhancementSignature?: string } = {},
): void {
  appliedProfiles.set(client, {
    id: profile.id,
    content: profile.content,
    ...(options.content !== undefined ? { generatedContent: options.content } : {}),
    ...(options.enhancementSignature !== undefined
      ? { enhancementSignature: options.enhancementSignature }
      : {}),
    appliedAt: Date.now(),
  });
  appliedListeners.get(client)?.forEach((listener) => listener());
}

export function subscribeAppliedProfile(client: object | null, listener: () => void): () => void {
  if (!client) return () => {};
  let listeners = appliedListeners.get(client);
  if (!listeners) {
    listeners = new Set();
    appliedListeners.set(client, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
