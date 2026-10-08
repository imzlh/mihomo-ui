import type { HomeMemberSort } from './preferences';
import type { ProxyNode, ProxyProvider } from './types';

const groupTypes = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function resolveHomeExit(
  proxies: Record<string, ProxyNode>,
  initial: string,
): { chain: ProxyNode[]; leaf?: ProxyNode; reason?: string } {
  const chain: ProxyNode[] = [];
  const visited = new Set<string>();
  let name = initial;
  while (name) {
    if (visited.has(name)) return { chain, reason: '代理组存在循环引用' };
    visited.add(name);
    const proxy = proxies[name];
    if (!proxy) return { chain, reason: `暂未获取到 ${name} 的信息` };
    chain.push(proxy);
    if (proxy.type === 'LoadBalance') return { chain, reason: '由内核为每条连接分配出口' };
    if (!proxy.all && !groupTypes.has(proxy.type)) return { chain, leaf: proxy };
    if (!proxy.now) return { chain, reason: '内核尚未返回当前组成员' };
    name = proxy.now;
  }
  return { chain, reason: '尚未选择代理组' };
}

/** A name alone must never pick one of several provider records. */
export function resolveHomeProvider(
  leaf: ProxyNode | undefined,
  providers: Record<string, ProxyProvider>,
  coreProxies: Record<string, ProxyNode> = {},
): { providerName?: string; node?: ProxyNode; reason?: string } {
  if (!leaf) return {};
  const declared = leaf['provider-name'];
  if (declared) {
    const provider = providers[declared];
    const node = provider?.proxies.find((item) => item.name === leaf.name);
    if (!provider || !node) {
      return { reason: `暂未确认代理集 ${declared} 中的节点信息` };
    }
    return {
      providerName: provider.vehicleType === 'Compatible' ? undefined : declared,
      node,
    };
  }
  if (coreProxies[leaf.name] === leaf) return { node: leaf };
  const matches = Object.entries(providers).filter(([, provider]) =>
    provider.proxies.some((node) => node.name === leaf.name),
  );
  if (matches.length > 1) {
    return { reason: '多个代理集包含同名节点，暂无法确定测试对象' };
  }
  const match = matches[0];
  return match
    ? {
        providerName: match[1].vehicleType === 'Compatible' ? undefined : match[0],
        node: match[1].proxies.find((node) => node.name === leaf.name),
      }
    : { node: leaf };
}

export function sortHomeMembers(
  names: readonly string[],
  sort: HomeMemberSort,
  delayOf: (name: string) => number | undefined,
): string[] {
  if (sort === 'default') return [...names];
  if (sort === 'name') return [...names].sort(collator.compare);
  const delay = (name: string) => {
    const value = delayOf(name);
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : Infinity;
  };
  return names
    .map((name, index) => ({ name, index, delay: delay(name) }))
    .sort((a, b) => a.delay - b.delay || a.index - b.index)
    .map(({ name }) => name);
}
