import { expect, it } from 'vitest';
import { mergeProxyNodes } from './proxy-nodes';
import type { ProxyNode, ProxyProvider } from './types';

it('retains controller identities and only fills unambiguous provider-only nodes', () => {
  const node = (name: string, provider?: string): ProxyNode => ({
    name,
    type: 'Shadowsocks',
    history: [],
    'provider-name': provider,
  });
  const provider = (name: string, nodes: ProxyNode[]): ProxyProvider => ({
    name,
    type: 'Proxy',
    vehicleType: 'HTTP',
    proxies: nodes,
  });
  const declared = node('declared', 'first');
  const unique = node('unique');
  const providers = {
    first: provider('first', [node('shared', 'first'), declared, unique]),
    second: provider('second', [node('shared', 'second'), node('declared', 'second')]),
  };
  expect(mergeProxyNodes({ declared }, providers)).toEqual({ declared, unique });
  expect(
    mergeProxyNodes({ declared }, { second: providers.second, first: providers.first }),
  ).toEqual({ declared, unique });
  expect(providers.first.proxies).toHaveLength(3);
});
