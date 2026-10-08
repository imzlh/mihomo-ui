import { describe, expect, it, vi } from 'vitest';
import { resolveHomeExit, resolveHomeProvider, sortHomeMembers } from './home-proxies';
import type { ProxyNode, ProxyProvider } from './types';

function node(name: string, overrides: Partial<ProxyNode> = {}): ProxyNode {
  return { name, type: 'Shadowsocks', history: [], ...overrides };
}

function provider(name: string, proxies: ProxyNode[], vehicleType = 'HTTP'): ProxyProvider {
  return { name, type: 'Proxy', vehicleType, proxies };
}

describe('home exit resolution', () => {
  it('follows the selected members of nested groups to the actual exit', () => {
    const leaf = node('香港 1');
    const selector = node('主出口', { type: 'Selector', all: ['自动选择'], now: '自动选择' });
    const urlTest = node('自动选择', { type: 'URLTest', all: ['故障转移'], now: '故障转移' });
    const fallback = node('故障转移', { type: 'Fallback', all: [leaf.name], now: leaf.name });
    const result = resolveHomeExit(
      Object.fromEntries([selector, urlTest, fallback, leaf].map((proxy) => [proxy.name, proxy])),
      selector.name,
    );

    expect(result.chain).toEqual([selector, urlTest, fallback, leaf]);
    expect(result.leaf).toBe(leaf);
    expect(result.reason).toBeUndefined();
  });

  it('stops a cyclic group chain without returning a testable exit', () => {
    const first = node('first', { type: 'Selector', all: ['second'], now: 'second' });
    const second = node('second', { type: 'Fallback', all: ['first'], now: 'first' });
    const result = resolveHomeExit({ first, second }, 'first');

    expect(result.chain).toEqual([first, second]);
    expect(result.leaf).toBeUndefined();
    expect(result.reason).toContain('循环');
  });

  it('does not treat a LoadBalance group current member as a deterministic exit', () => {
    const leaf = node('出口');
    const balanced = node('均衡', { type: 'LoadBalance', all: [leaf.name], now: leaf.name });
    const result = resolveHomeExit({ [balanced.name]: balanced, [leaf.name]: leaf }, balanced.name);

    expect(result.chain).toEqual([balanced]);
    expect(result.leaf).toBeUndefined();
    expect(result.reason).toContain('每条连接');
  });

  it('explains a missing selected node and a group without a current member', () => {
    const missing = resolveHomeExit({}, 'missing');
    expect(missing.leaf).toBeUndefined();
    expect(missing.reason).toContain('missing');

    const group = node('unselected', { type: 'Selector', all: ['node'] });
    const unselected = resolveHomeExit({ unselected: group }, 'unselected');
    expect(unselected.chain).toEqual([group]);
    expect(unselected.leaf).toBeUndefined();
    expect(unselected.reason).toContain('当前组成员');
  });
});

describe('home provider resolution', () => {
  it('preserves a top-level node when providers reuse its name', () => {
    const leaf = node('shared');
    const providers = { remote: provider('remote', [node('shared')]) };
    expect(resolveHomeProvider(leaf, providers, { shared: leaf })).toEqual({ node: leaf });
    expect(
      resolveHomeProvider(
        leaf,
        { ...providers, other: provider('other', [node('shared')]) },
        { shared: leaf },
      ),
    ).toEqual({ node: leaf });
  });

  it('uses an explicit provider to disambiguate identical node names', () => {
    const leaf = node('shared', { 'provider-name': 'second' });
    const first = node('shared', { udp: false });
    const second = node('shared', { udp: true });
    const result = resolveHomeProvider(leaf, {
      first: provider('first', [first]),
      second: provider('second', [second]),
    });

    expect(result.providerName).toBe('second');
    expect(result.node).toBe(second);
    expect(result.reason).toBeUndefined();
  });

  it('does not fall back to a matching name when the declared provider is unknown', () => {
    const leaf = node('shared', { 'provider-name': 'missing' });
    const result = resolveHomeProvider(leaf, { other: provider('other', [node('shared')]) });

    expect(result.node).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.reason).toContain('missing');
  });

  it('does not route to another provider when the declared provider lacks this node', () => {
    const leaf = node('shared', { 'provider-name': 'declared' });
    const result = resolveHomeProvider(leaf, {
      declared: provider('declared', [node('different')]),
      other: provider('other', [node('shared')]),
    });

    expect(result.node).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.reason).toContain('declared');
  });

  it('disables testing when multiple providers contain the same undeclared node name', () => {
    const result = resolveHomeProvider(node('shared'), {
      first: provider('first', [node('shared')]),
      second: provider('second', [node('shared')]),
    });

    expect(result.node).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.reason).toContain('多个代理集');
  });

  it('infers a single provider while retaining its exact node record', () => {
    const provided = node('unique', { history: [{ time: '2026-10-08T00:00:00Z', delay: 90 }] });
    const result = resolveHomeProvider(node('unique'), { remote: provider('remote', [provided]) });

    expect(result.providerName).toBe('remote');
    expect(result.node).toBe(provided);
    expect(result.reason).toBeUndefined();
  });

  it.each([true, false])(
    'routes Compatible nodes through the ordinary proxy endpoint (declared: %s)',
    (declared) => {
      const leaf = node('builtin', declared ? { 'provider-name': 'default' } : {});
      const provided = node('builtin', { udp: true });
      const result = resolveHomeProvider(leaf, {
        default: provider('default', [provided], 'Compatible'),
      });

      expect(result.providerName).toBeUndefined();
      expect(result.node).toBe(provided);
      expect(result.reason).toBeUndefined();
    },
  );

  it('retains standalone nodes and leaves unresolved exits untestable', () => {
    const leaf = node('standalone');
    expect(resolveHomeProvider(leaf, {})).toEqual({ node: leaf });
    expect(resolveHomeProvider(undefined, {})).toEqual({});
  });
});

describe('home member sorting', () => {
  it('preserves default order and returns a fresh array without reading delays', () => {
    const names = Object.freeze(['节点 10', '节点 2', '节点 1']);
    const delayOf = vi.fn();
    const result = sortHomeMembers(names, 'default', delayOf);

    expect(result).toEqual(names);
    expect(result).not.toBe(names);
    expect(delayOf).not.toHaveBeenCalled();
    result.reverse();
    expect(names).toEqual(['节点 10', '节点 2', '节点 1']);
  });

  it('places unknown and invalid delays last while preserving all equal-delay ties', () => {
    const names = Object.freeze([
      'unknown',
      'slow first',
      'zero',
      'fast',
      'negative',
      'slow second',
      'NaN',
      'infinite',
    ]);
    const delays: Record<string, number | undefined> = {
      unknown: undefined,
      'slow first': 80,
      zero: 0,
      fast: 15,
      negative: -1,
      'slow second': 80,
      NaN: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
    };
    const original = [...names];

    expect(sortHomeMembers(names, 'delay', (name) => delays[name])).toEqual([
      'fast',
      'slow first',
      'slow second',
      'unknown',
      'zero',
      'negative',
      'NaN',
      'infinite',
    ]);
    expect(names).toEqual(original);
  });

  it('sorts names with numeric collation without changing the original array', () => {
    const names = Object.freeze(['香港 10', '香港 2', '香港 1']);
    const delayOf = vi.fn();

    expect(sortHomeMembers(names, 'name', delayOf)).toEqual(['香港 1', '香港 2', '香港 10']);
    expect(names).toEqual(['香港 10', '香港 2', '香港 1']);
    expect(delayOf).not.toHaveBeenCalled();
  });
});
