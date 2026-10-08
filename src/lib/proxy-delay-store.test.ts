import { describe, expect, it, vi } from 'vitest';
import { MihomoClient } from './mihomo';
import {
  createProxyDelayStore,
  isProxyDelayPending,
  proxyDelayKey,
  proxyDelayStore,
} from './proxy-delay-store';

describe('proxy delay store', () => {
  it('preserves requests and results across subscribers leaving and rejoining', () => {
    const store = createProxyDelayStore();
    const firstPage = vi.fn();
    const leave = store.subscribe(firstPage);
    expect(store.beginNode('Tokyo')).toBe(true);
    expect(firstPage).toHaveBeenCalledTimes(1);
    leave();
    expect(store.beginNode('Tokyo')).toBe(false);
    expect(isProxyDelayPending(store.getSnapshot(), 'Tokyo')).toBe(true);
    store.finishNode('Proxy', 'Tokyo', { delay: 96, historyKey: 'old:32' });
    expect(firstPage).toHaveBeenCalledTimes(1);
    const secondPage = vi.fn();
    const leaveAgain = store.subscribe(secondPage);
    expect(store.getSnapshot().results.get(proxyDelayKey('Proxy', 'Tokyo'))).toEqual({
      delay: 96,
      historyKey: 'old:32',
    });
    expect(store.beginNode('Tokyo')).toBe(true);
    store.finishNode('Proxy', 'Tokyo', { delay: undefined, historyKey: 'old:32' });
    expect(secondPage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().results.has(proxyDelayKey('Proxy', 'Tokyo'))).toBe(true);
    expect(store.getSnapshot().results.get(proxyDelayKey('Proxy', 'Tokyo'))?.delay).toBeUndefined();
    leaveAgain();
  });

  it('synchronously excludes overlapping node and group requests while allowing unrelated groups', () => {
    const store = createProxyDelayStore();
    expect(store.beginNode('Tokyo')).toBe(true);
    expect(store.beginGroup('First', ['Tokyo', 'London'])).toBe(false);
    expect(store.beginGroup('Other', ['Berlin'])).toBe(true);
    expect(store.beginGroup('Other', [])).toBe(false);
    store.finishNode('First', 'Tokyo', { delay: 12, historyKey: '' });
    expect(store.beginGroup('First', ['Tokyo', 'London'])).toBe(true);
    expect(store.beginNode('London')).toBe(false);
    expect(store.beginGroup('Overlapping', ['London', 'Sydney'])).toBe(false);
    expect(store.beginGroup('Unrelated', ['Sydney'])).toBe(true);
    store.finishGroup('First', { Tokyo: 25, London: 0 }, new Map([['Tokyo', 'before:12']]));
    expect(isProxyDelayPending(store.getSnapshot(), 'Tokyo')).toBe(false);
    expect(isProxyDelayPending(store.getSnapshot(), 'Berlin')).toBe(true);
    expect(store.getSnapshot().results.get(proxyDelayKey('First', 'Tokyo'))).toEqual({
      delay: 25,
      historyKey: 'before:12',
    });
    expect(store.getSnapshot().results.get(proxyDelayKey('First', 'London'))?.delay).toBe(0);
  });

  it('clears missing group measurements but records whole-request failure for every member', () => {
    const store = createProxyDelayStore();
    store.beginNode('Tokyo');
    store.finishNode('Proxy', 'Tokyo', { delay: 20, historyKey: '' });
    store.beginGroup('Proxy', ['Tokyo', 'London']);
    store.finishGroup('Proxy', { London: 0 }, new Map());
    expect(store.getSnapshot().results.has(proxyDelayKey('Proxy', 'Tokyo'))).toBe(false);
    expect(store.getSnapshot().results.get(proxyDelayKey('Proxy', 'London'))?.delay).toBe(0);
    store.beginGroup('Proxy', ['Tokyo', 'London']);
    store.finishGroup('Proxy', undefined, new Map());
    for (const name of ['Tokyo', 'London']) {
      expect(store.getSnapshot().results.has(proxyDelayKey('Proxy', name))).toBe(true);
      expect(store.getSnapshot().results.get(proxyDelayKey('Proxy', name))?.delay).toBeUndefined();
      expect(isProxyDelayPending(store.getSnapshot(), name)).toBe(false);
    }
  });

  it('isolates reconnects and Secrets even when controller URLs match', () => {
    const first = new MihomoClient({ url: 'http://127.0.0.1:9090', secret: 'first' });
    const second = new MihomoClient({ url: 'http://127.0.0.1:9090', secret: 'second' });
    const firstStore = proxyDelayStore(first);
    const secondStore = proxyDelayStore(second);
    expect(proxyDelayStore(first)).toBe(firstStore);
    expect(secondStore).not.toBe(firstStore);
    firstStore.beginNode('Tokyo');
    expect(secondStore.beginNode('Tokyo')).toBe(true);
    firstStore.finishNode('Proxy', 'Tokyo', { delay: 99, historyKey: '' });
    expect(secondStore.getSnapshot().results.size).toBe(0);
    expect(secondStore.getSnapshot().nodes.has('Tokyo')).toBe(true);
  });
});
