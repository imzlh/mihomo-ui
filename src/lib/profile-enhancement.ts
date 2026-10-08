import { isMap, isSeq, parseDocument, stringify } from 'yaml';
import { runProfileScript, type ProfileScriptLog } from './profile-script';
import type { JsonValue } from './types';

export interface EnhancementSource {
  enabled: boolean;
  content: string;
}

export interface GlobalProfileEnhancement {
  version: 1;
  merge: EnhancementSource;
  script: EnhancementSource;
}

export interface ProfileEnhancement extends GlobalProfileEnhancement {
  rules: EnhancementSource;
  proxies: EnhancementSource;
  groups: EnhancementSource;
}

export interface EnhancementLog extends ProfileScriptLog {
  stage?: string;
}

export interface EnhancementStage {
  id:
    | 'rules'
    | 'proxies'
    | 'groups'
    | 'global-merge'
    | 'global-script'
    | 'profile-merge'
    | 'profile-script'
    | 'cleanup';
  label: string;
  changedKeys: string[];
}

export class ProfileCompileError extends Error {
  constructor(
    message: string,
    public readonly logs: EnhancementLog[],
    public readonly stages: EnhancementStage[],
  ) {
    super(message);
    this.name = 'ProfileCompileError';
  }
}

export const PROFILE_YAML_MAX_BYTES = 5 * 1024 * 1024;
const SCRIPT_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 100;
const MAX_NODES = 250_000;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const sequenceTemplate = 'prepend: []\nappend: []\ndelete: []\n';
const disabled = (content: string): EnhancementSource => ({ enabled: false, content });

export function defaultGlobalProfileEnhancement(): GlobalProfileEnhancement {
  return {
    version: 1,
    merge: disabled('{}\n'),
    script: disabled('function main(config, profileName) {\n  return config;\n}\n'),
  };
}

export function defaultProfileEnhancement(): ProfileEnhancement {
  return {
    ...defaultGlobalProfileEnhancement(),
    rules: disabled(sequenceTemplate),
    proxies: disabled(sequenceTemplate),
    groups: disabled(sequenceTemplate),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSource(value: unknown, maxBytes: number): value is EnhancementSource {
  return (
    isRecord(value) &&
    Object.hasOwn(value, 'enabled') &&
    Object.hasOwn(value, 'content') &&
    typeof value.enabled === 'boolean' &&
    typeof value.content === 'string' &&
    byteLength(value.content) <= maxBytes
  );
}

/** Persist text without parsing or executing it, including drafts that need fixing. */
export function isGlobalProfileEnhancement(value: unknown): value is GlobalProfileEnhancement {
  return (
    isRecord(value) &&
    Object.hasOwn(value, 'version') &&
    value.version === 1 &&
    Object.hasOwn(value, 'merge') &&
    isSource(value.merge, PROFILE_YAML_MAX_BYTES) &&
    Object.hasOwn(value, 'script') &&
    isSource(value.script, SCRIPT_MAX_BYTES)
  );
}

export function isProfileEnhancement(value: unknown): value is ProfileEnhancement {
  return (
    isGlobalProfileEnhancement(value) &&
    ['rules', 'proxies', 'groups'].every(
      (key) =>
        Object.hasOwn(value, key) &&
        isSource((value as unknown as Record<string, unknown>)[key], PROFILE_YAML_MAX_BYTES),
    )
  );
}

function copyGlobal(value: GlobalProfileEnhancement): GlobalProfileEnhancement {
  return {
    version: 1,
    merge: { enabled: value.merge.enabled, content: value.merge.content },
    script: { enabled: value.script.enabled, content: value.script.content },
  };
}

export const globalProfileEnhancementKey = (scope: 'local' | 'demo'): string =>
  `mihomo-verge.profile-enhancement:${scope}`;

export function readGlobalProfileEnhancement(
  scope: 'local' | 'demo',
  storage: Pick<Storage, 'getItem'> = localStorage,
): GlobalProfileEnhancement {
  let raw: string | null;
  try {
    raw = storage.getItem(globalProfileEnhancementKey(scope));
  } catch {
    throw new Error('浏览器未允许读取全局增强，请检查存储权限后重试。');
  }
  if (raw === null) return defaultGlobalProfileEnhancement();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isGlobalProfileEnhancement(value)) throw new Error();
    return copyGlobal(value);
  } catch {
    throw new Error('全局增强数据格式损坏，现有数据已保留。请检查本地存储后重新读取。');
  }
}

export function writeGlobalProfileEnhancement(
  scope: 'local' | 'demo',
  value: GlobalProfileEnhancement,
  {
    expected,
    storage = localStorage,
  }: {
    expected?: GlobalProfileEnhancement;
    storage?: Pick<Storage, 'getItem' | 'setItem'>;
  } = {},
): void {
  if (!isGlobalProfileEnhancement(value)) throw new Error('全局增强字段格式错误或内容过大。');
  if (
    expected !== undefined &&
    (!isGlobalProfileEnhancement(expected) ||
      JSON.stringify(copyGlobal(expected)) !==
        JSON.stringify(readGlobalProfileEnhancement(scope, storage)))
  )
    throw new Error('全局增强已在其他页面更新，请重新读取后再保存。');
  try {
    storage.setItem(globalProfileEnhancementKey(scope), JSON.stringify(copyGlobal(value)));
  } catch {
    throw new Error('全局增强未保存：浏览器存储空间不足或未允许写入。请保留修改后重试。');
  }
}

type Config = Record<string, JsonValue>;
const jsonMap = (value: JsonValue | undefined): value is Config =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Maps preserve hostile property names until they are copied into prototype-free records. */
function safeJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > MAX_DEPTH) throw new Error('配置的嵌套层级不能超过 100。');
    if (++nodes > MAX_NODES) throw new Error('配置展开后的节点数量过多。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object')
      throw new Error('配置只能包含 JSON 值，不能包含非有限数值。');
    if (!Array.isArray(item) && !(item instanceof Map) && !isRecord(item))
      throw new Error('配置只能包含 JSON 对象，不能包含日期、集合或二进制标签。');
    if (ancestors.has(item)) throw new Error('配置不能包含循环别名或循环引用。');
    ancestors.add(item);
    let result: JsonValue;
    if (Array.isArray(item)) result = item.map((child) => visit(child, depth + 1));
    else {
      const mapping: Config = Object.create(null);
      const pairs = item instanceof Map ? item.entries() : Object.entries(item);
      for (const [key, child] of pairs) {
        if (typeof key !== 'string') throw new Error('YAML 映射的键必须是字符串。');
        mapping[key] = visit(child, depth + 1);
      }
      result = mapping;
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

export function parseProfileYaml(content: string): Config {
  if (!content.trim()) throw new Error('请输入完整的 YAML 配置。');
  if (byteLength(content) > PROFILE_YAML_MAX_BYTES) throw new Error('配置文件不能超过 5 MiB。');
  const document = parseDocument(content, { merge: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  if (document.warnings.length) throw new Error(document.warnings[0]!.message);
  if (!isMap(document.contents))
    throw new Error('配置必须是单个 YAML 映射，不能是列表或普通文本。');
  // Bound the syntax tree before toJS recursively resolves it.
  const pending: { node: unknown; depth: number }[] = [{ node: document.contents, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > MAX_DEPTH) throw new Error('配置的嵌套层级不能超过 100。');
    if (++nodes > MAX_NODES) throw new Error('配置节点数量过多。');
    if (isMap(node)) {
      for (const pair of node.items)
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
    } else if (isSeq(node)) {
      for (const child of node.items) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return safeJson(document.toJS({ mapAsMap: true, maxAliasCount: 100 })) as Config;
}

const asciiLowercase = (key: string) => key.replace(/[A-Z]/g, (char) => char.toLowerCase());
function lowercase(config: Config): Config {
  const result: Config = Object.create(null);
  for (const [key, value] of Object.entries(config)) result[asciiLowercase(key)] = value;
  return result;
}

function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (jsonMap(a) && jsonMap(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
  return false;
}

function changedKeys(before: Config, after: Config): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) =>
      Object.hasOwn(before, key) !== Object.hasOwn(after, key) || !equal(before[key], after[key]),
  );
}

function merge(config: Config, overlay: Config): Config {
  const mergeMap = (target: Config, source: Config, root: boolean) => {
    for (const [key, value] of Object.entries(source)) {
      const old = Object.hasOwn(target, key) ? target[key] : undefined;
      if (root && key === 'hosts') target[key] = value;
      else if (jsonMap(old) && jsonMap(value)) {
        if (root && key === 'dns') {
          for (const [childKey, child] of Object.entries(value)) old[childKey] = child;
        } else mergeMap(old, value, false);
      } else target[key] = value;
    }
  };
  mergeMap(config, lowercase(overlay), true);
  return config;
}

function entryName(value: JsonValue): string | undefined {
  if (typeof value === 'string') return value;
  return jsonMap(value) && typeof value.name === 'string' ? value.name : undefined;
}

function applySequence(config: Config, id: 'rules' | 'proxies' | 'groups', source: string): Config {
  const parsed = parseProfileYaml(source);
  const { prepend, append, delete: deleted } = parsed;
  if (
    !Array.isArray(prepend) ||
    !Array.isArray(append) ||
    !Array.isArray(deleted) ||
    !deleted.every((item) => typeof item === 'string')
  )
    throw new Error('序列增强需要 prepend、append 和 delete 三个数组，delete 只能包含字符串。');
  const key = id === 'groups' ? 'proxy-groups' : id;
  const removals = new Set(deleted);
  const previous = Array.isArray(config[key]) ? config[key] : [];
  config[key] = [
    ...prepend,
    ...previous.filter((entry) => {
      const name = entryName(entry);
      return name === undefined || !removals.has(name);
    }),
    ...append,
  ];
  if (id === 'proxies' && Array.isArray(config['proxy-groups'])) {
    const additions = [
      ...new Set(
        [...prepend, ...append].map(entryName).filter((name): name is string => name !== undefined),
      ),
    ];
    let selectorSeen = false;
    for (const group of config['proxy-groups']) {
      if (!jsonMap(group)) continue;
      if (Array.isArray(group.proxies))
        group.proxies = group.proxies.filter(
          (name) => typeof name !== 'string' || !removals.has(name),
        );
      if (
        !selectorSeen &&
        additions.length > 0 &&
        typeof group.type === 'string' &&
        ['select', 'selector'].includes(asciiLowercase(group.type))
      ) {
        selectorSeen = true;
        const seen = new Set<string>();
        group.proxies = [
          ...additions,
          ...(Array.isArray(group.proxies) ? group.proxies : []),
        ].filter((name) => {
          if (typeof name !== 'string') return true;
          if (seen.has(name)) return false;
          seen.add(name);
          return true;
        });
      }
    }
  }
  return config;
}

function cleanup(config: Config): Config {
  const providers = new Set(
    jsonMap(config['proxy-providers']) ? Object.keys(config['proxy-providers']) : [],
  );
  const names = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', ...providers]);
  if (Array.isArray(config.proxies))
    for (const proxy of config.proxies) {
      const name = entryName(proxy);
      if (name !== undefined) names.add(name);
    }
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  for (const group of groups)
    if (jsonMap(group) && typeof group.name === 'string') names.add(group.name);
  for (const group of groups) {
    if (!jsonMap(group)) continue;
    let hasProvider = false;
    if (Array.isArray(group.use)) {
      group.use = group.use.filter((name) => typeof name === 'string' && providers.has(name));
      hasProvider = group.use.length > 0;
    }
    if (Array.isArray(group.proxies))
      group.proxies = group.proxies.filter(
        (name) => typeof name !== 'string' || hasProvider || names.has(name),
      );
  }
  return config;
}

export async function compileProfile(
  {
    content,
    profileName,
    global = defaultGlobalProfileEnhancement(),
    enhancement = defaultProfileEnhancement(),
  }: {
    content: string;
    profileName: string;
    global?: GlobalProfileEnhancement;
    enhancement?: ProfileEnhancement;
  },
  { signal }: { signal?: AbortSignal } = {},
): Promise<{
  content: string;
  logs: EnhancementLog[];
  stages: EnhancementStage[];
  changedKeys: string[];
}> {
  const logs: EnhancementLog[] = [];
  const stages: EnhancementStage[] = [];
  let activeStage: EnhancementStage['id'] | undefined;
  const checkAbort = () => {
    if (signal?.aborted) throw new Error('配置生成已取消。');
  };
  try {
    checkAbort();
    if (!isGlobalProfileEnhancement(global) || !isProfileEnhancement(enhancement))
      throw new Error('增强字段格式错误或内容过大。');
    const original = parseProfileYaml(content);
    let config = safeJson(original) as Config;
    const sequence = [
      ['rules', '规则', enhancement.rules],
      ['proxies', '代理', enhancement.proxies],
      ['groups', '代理组', enhancement.groups],
      ['global-merge', '全局 Merge', global.merge],
      ['global-script', '全局 Script', global.script],
      ['profile-merge', '配置 Merge', enhancement.merge],
      ['profile-script', '配置 Script', enhancement.script],
    ] as const;
    if (!sequence.some(([, , source]) => source.enabled))
      return { content, logs, stages, changedKeys: [] };
    for (const [id, label, source] of sequence) {
      if (!source.enabled) continue;
      activeStage = id;
      checkAbort();
      const before = safeJson(config) as Config;
      if (id === 'rules' || id === 'proxies' || id === 'groups')
        config = applySequence(config, id, source.content);
      else if (id.endsWith('-merge')) config = merge(config, parseProfileYaml(source.content));
      else {
        const result = await runProfileScript(
          { config: lowercase(config), script: source.content, profileName },
          { signal },
        );
        logs.push(...result.logs.map((log) => ({ ...log, stage: id })));
        if (!result.ok) throw new Error(result.error);
        const output = safeJson(result.config);
        if (!jsonMap(output)) throw new Error('Script 必须返回 JSON 映射。');
        config = lowercase(output);
      }
      checkAbort();
      // Keep size, depth and expansion bounded after every transformation.
      config = safeJson(config) as Config;
      if (byteLength(JSON.stringify(config)) > PROFILE_YAML_MAX_BYTES)
        throw new Error('增强后的配置超过 5 MiB。');
      stages.push({ id, label, changedKeys: changedKeys(before, config) });
    }
    activeStage = 'cleanup';
    const beforeCleanup = safeJson(config) as Config;
    cleanup(config);
    stages.push({
      id: 'cleanup',
      label: '代理组引用清理',
      changedKeys: changedKeys(beforeCleanup, config),
    });
    checkAbort();
    const generated = stringify(config, { lineWidth: 0, aliasDuplicateObjects: false });
    if (byteLength(generated) > PROFILE_YAML_MAX_BYTES) throw new Error('生成的配置超过 5 MiB。');
    return { content: generated, logs, stages, changedKeys: changedKeys(original, config) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法生成增强配置。';
    logs.push({ level: 'error', message, ...(activeStage ? { stage: activeStage } : {}) });
    throw new ProfileCompileError(message, logs, stages);
  }
}
