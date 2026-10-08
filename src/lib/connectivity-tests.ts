import { resolveHomeExit, resolveHomeProvider } from './home-proxies';
import { MihomoApiError, type MihomoClient } from './mihomo';
import type { ProxyNode, ProxyProvider } from './types';

export interface ConnectivityTarget {
  id: string;
  name: string;
  url: string;
  timeout: number;
}

export type ConnectivityExit =
  { kind: 'proxy'; name: string } | { kind: 'provider'; provider: string; name: string };

export interface ConnectivityPreferences {
  version: 1;
  targets: ConnectivityTarget[];
  exit?: ConnectivityExit;
}

export type ConnectivityResult =
  | { status: 'queued' | 'testing' | 'cancelled' }
  | { status: 'success'; delay: number }
  | { status: 'timeout' | 'error'; detail: string };

export const DEFAULT_CONNECTIVITY_TARGETS: readonly ConnectivityTarget[] = [
  { id: 'google', name: 'Google', url: 'https://www.gstatic.com/generate_204', timeout: 5000 },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://cp.cloudflare.com/generate_204',
    timeout: 5000,
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    url: 'http://www.msftconnecttest.com/connecttest.txt',
    timeout: 5000,
  },
];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('测试偏好包含未知字段');
}

function text(value: unknown, label: string, max: number, preserve = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`${label}须为 1–${max} 个字符`);
  }
  return preserve ? value : value.trim();
}

export function validateConnectivityTarget(value: unknown): ConnectivityTarget {
  if (!object(value)) throw new Error('测试目标格式无效');
  checkKeys(value, ['id', 'name', 'url', 'timeout']);
  const id = text(value.id, '目标 ID', 80);
  const name = text(value.name, '目标名称', 40);
  const address = text(value.url, '测试地址', 2048);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('测试地址须为完整的 HTTP 或 HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('测试地址仅支持 HTTP/HTTPS，不能包含用户名或密码');
  }
  if (url.toString().length > 2048) throw new Error('编码后的测试地址不能超过 2048 个字符');
  if (
    typeof value.timeout !== 'number' ||
    !Number.isInteger(value.timeout) ||
    value.timeout < 1000 ||
    value.timeout > 30000
  ) {
    throw new Error('超时须为 1000–30000 毫秒的整数');
  }
  return { id, name, url: url.toString(), timeout: value.timeout };
}

export function validateConnectivityPreferences(value: unknown): ConnectivityPreferences {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length > 20
  ) {
    throw new Error('测试偏好须为版本 1，且最多包含 20 个目标');
  }
  checkKeys(value, ['version', 'targets', 'exit']);
  const targets = value.targets.map(validateConnectivityTarget);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new Error('测试目标 ID 不能重复');
  }
  if (value.exit === undefined) return { version: 1, targets };
  if (!object(value.exit)) throw new Error('测试出口格式无效');
  const name = text(value.exit.name, '出口名称', 200, true);
  if (value.exit.kind === 'proxy') {
    checkKeys(value.exit, ['kind', 'name']);
    return { version: 1, targets, exit: { kind: 'proxy', name } };
  }
  if (value.exit.kind === 'provider') {
    checkKeys(value.exit, ['kind', 'name', 'provider']);
    return {
      version: 1,
      targets,
      exit: {
        kind: 'provider',
        name,
        provider: text(value.exit.provider, '代理集名称', 200, true),
      },
    };
  }
  throw new Error('测试出口类型无效');
}

export function normalizeConnectivityPreferences(value: unknown): ConnectivityPreferences {
  try {
    return validateConnectivityPreferences(value);
  } catch {
    return { version: 1, targets: DEFAULT_CONNECTIVITY_TARGETS.map((target) => ({ ...target })) };
  }
}

export function readConnectivityPreferences(scope: string): ConnectivityPreferences {
  try {
    return normalizeConnectivityPreferences(
      JSON.parse(localStorage.getItem(`mihomo-verge.connectivity-tests:${scope}`) ?? 'null'),
    );
  } catch {
    return normalizeConnectivityPreferences(null);
  }
}

export function writeConnectivityPreferences(scope: string, value: ConnectivityPreferences): void {
  const validated = validateConnectivityPreferences(value);
  try {
    localStorage.setItem(`mihomo-verge.connectivity-tests:${scope}`, JSON.stringify(validated));
  } catch {
    // Browser storage can be unavailable while the current page remains usable.
  }
}

export function resolveConnectivityExit(
  selection: ConnectivityExit | undefined,
  proxies: Record<string, ProxyNode>,
  providers: Record<string, ProxyProvider>,
  coreProxies: Record<string, ProxyNode>,
): { name?: string; providerName?: string; chain: string[]; reason?: string } {
  if (!selection) return { chain: [], reason: '请选择测试出口' };
  const route =
    selection.kind === 'proxy'
      ? resolveHomeExit(proxies, selection.name)
      : {
          chain: [],
          leaf: providers[selection.provider]?.proxies.find((node) => node.name === selection.name),
        };
  if (!route.leaf)
    return {
      chain: route.chain.map((node) => node.name),
      reason: route.reason ?? '未找到所选代理集节点',
    };
  if (/^(reject|pass)/i.test(route.leaf.type))
    return { chain: [route.leaf.name], reason: '该策略不会建立可测试的出站连接' };
  const leaf =
    selection.kind === 'provider'
      ? { ...route.leaf, 'provider-name': selection.provider }
      : route.leaf;
  const source = resolveHomeProvider(leaf, providers, coreProxies);
  return {
    name: leaf.name,
    providerName: source.providerName,
    chain: route.chain.length ? route.chain.map((node) => node.name) : [leaf.name],
    reason: source.reason,
  };
}

export function connectivityFailure(error: unknown): ConnectivityResult {
  const detail = error instanceof Error ? error.message : '测试失败，请检查内核日志';
  const timedOut =
    (error instanceof MihomoApiError && [408, 504].includes(error.status ?? 0)) ||
    /timeout|timed out|deadline exceeded|超时/i.test(detail);
  return { status: timedOut ? 'timeout' : 'error', detail };
}

export async function runConnectivityTests({
  targets,
  signal,
  measure,
  onResult,
}: {
  targets: readonly ConnectivityTarget[];
  signal: AbortSignal;
  measure: (target: ConnectivityTarget, signal: AbortSignal) => Promise<{ delay: number }>;
  onResult: (id: string, result: ConnectivityResult) => void;
}): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (!signal.aborted && next < targets.length) {
        const target = targets[next++];
        if (!target) return;
        onResult(target.id, { status: 'testing' });
        try {
          const response = await measure(target, signal);
          if (signal.aborted) return;
          if (!Number.isFinite(response.delay) || response.delay < 0) {
            onResult(target.id, { status: 'error', detail: '内核未返回有效延迟' });
          } else {
            onResult(
              target.id,
              response.delay === 0
                ? { status: 'timeout', detail: '内核返回延迟 0，目标测试超时' }
                : { status: 'success', delay: response.delay },
            );
          }
        } catch (error) {
          if (!signal.aborted) onResult(target.id, connectivityFailure(error));
        }
      }
    }),
  );
}

export function measureConnectivityTarget(
  client: Pick<MihomoClient, 'delay' | 'providerProxyDelay'>,
  target: ConnectivityTarget,
  exit: { name: string; providerName?: string },
  signal: AbortSignal,
): Promise<{ delay: number }> {
  return exit.providerName
    ? client.providerProxyDelay(exit.providerName, exit.name, target.url, target.timeout, signal)
    : client.delay(exit.name, target.url, target.timeout, undefined, signal);
}
