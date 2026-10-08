import type { JsonValue } from './types';

export type ProfileScriptConfig = Record<string, JsonValue>;
export interface ProfileScriptInput {
  config: ProfileScriptConfig;
  script: string;
  profileName: string;
}
export interface ProfileScriptLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'table';
  message: string;
}
export type ProfileScriptResult =
  | { ok: true; config: ProfileScriptConfig; logs: ProfileScriptLog[] }
  | { ok: false; error: string; logs: ProfileScriptLog[] };

export const PROFILE_SCRIPT_LIMITS = Object.freeze({
  configBytes: 10 * 1024 * 1024,
  scriptBytes: 1024 * 1024,
  profileNameBytes: 1024,
  logCount: 1000,
  logBytes: 1024 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  executionMs: 5000,
  watchdogMs: 8000,
});

export interface ProfileScriptWorkerInput {
  configJson: string;
  script: string;
  profileName: string;
}
export type ProfileScriptWorkerMessage =
  | { type: 'ready' }
  | { type: 'log'; log: ProfileScriptLog }
  | { type: 'result'; result: ProfileScriptResult };

const encoder = new TextEncoder();
export const scriptByteLength = (value: string): number => encoder.encode(value).byteLength;

/** Reject values JSON.stringify would silently change, including getters and toJSON hooks. */
export function serializeScriptConfig(config: unknown): string {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Script 配置必须是非空 JSON 映射。');
  if (!Object.keys(config).length) throw new Error('Script 配置不能为空。');
  const ancestors = new Set<object>();
  let size = 0;
  const add = (text: string): string => {
    size += scriptByteLength(text);
    if (size > PROFILE_SCRIPT_LIMITS.configBytes)
      throw new Error('Script 配置或返回结果超过 10 MiB。');
    return text;
  };
  const visit = (value: unknown, depth: number): string => {
    if (depth > 100) throw new Error('Script 配置的嵌套层级超过 100。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return add(JSON.stringify(value));
    if (typeof value === 'number' && Number.isFinite(value)) return add(JSON.stringify(value));
    if (!value || typeof value !== 'object')
      throw new Error('Script 配置只能包含 JSON 值，不能包含函数或非有限数值。');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new Error('Script 配置只能包含普通 JSON 对象。');
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error('Script 配置不能包含 Symbol 字段。');
    if (ancestors.has(value)) throw new Error('Script 配置不能包含循环引用。');
    ancestors.add(value);
    const keys = Object.keys(value);
    if (array && keys.length !== (value as unknown[]).length)
      throw new Error('Script 配置数组不能包含空项或额外字段。');
    const parts = [add(array ? '[' : '{')];
    for (let index = 0; index < keys.length; index++) {
      const key = array ? String(index) : keys[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error('Script 配置不能包含 getter 或 setter。');
      if (index) parts.push(add(','));
      if (!array) parts.push(add(JSON.stringify(key)), add(':'));
      parts.push(visit(descriptor.value, depth + 1));
    }
    parts.push(add(array ? ']' : '}'));
    ancestors.delete(value);
    return parts.join('');
  };
  return visit(config, 0);
}

export function prepareScriptInput(input: ProfileScriptInput): ProfileScriptWorkerInput {
  if (typeof input.script !== 'string' || !input.script.trim())
    throw new Error('请输入包含 main(config, profileName) 的 Script。');
  if (scriptByteLength(input.script) > PROFILE_SCRIPT_LIMITS.scriptBytes)
    throw new Error('Script 不能超过 1 MiB。');
  if (
    typeof input.profileName !== 'string' ||
    scriptByteLength(input.profileName) > PROFILE_SCRIPT_LIMITS.profileNameBytes
  )
    throw new Error('Script 配置名称不能超过 1024 字节。');
  return {
    configJson: serializeScriptConfig(input.config),
    script: input.script,
    profileName: input.profileName,
  };
}
