import type { ProxyNode, ProxyProvider } from './types';

/** A name alone cannot identify nodes shared by multiple providers. */
export function mergeProxyNodes(
  proxies: Record<string, ProxyNode>,
  providers: Record<string, ProxyProvider>,
): Record<string, ProxyNode> {
  const candidates = new Map<string, ProxyNode[]>();
  for (const provider of Object.values(providers)) {
    for (const node of provider.proxies) {
      const existing = candidates.get(node.name) ?? [];
      existing.push(node);
      candidates.set(node.name, existing);
    }
  }
  return {
    ...Object.fromEntries(
      [...candidates]
        .filter(([, nodes]) => nodes.length === 1)
        .map(([name, nodes]) => [name, nodes[0]!]),
    ),
    ...proxies,
  };
}
