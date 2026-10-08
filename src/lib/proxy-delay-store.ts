import type { MihomoClient } from './mihomo';

export interface ProxyDelayResult {
  delay?: number;
  historyKey: string;
}

export interface ProxyDelaySnapshot {
  results: ReadonlyMap<string, ProxyDelayResult>;
  nodes: ReadonlySet<string>;
  groups: ReadonlyMap<string, readonly string[]>;
}

export const proxyDelayKey = (group: string, name: string) => JSON.stringify([group, name]);

export function isProxyDelayPending(snapshot: ProxyDelaySnapshot, name: string): boolean {
  return (
    snapshot.nodes.has(name) ||
    [...snapshot.groups.values()].some((members) => members.includes(name))
  );
}

export function createProxyDelayStore() {
  let state: ProxyDelaySnapshot = {
    results: new Map(),
    nodes: new Set(),
    groups: new Map(),
  };
  const listeners = new Set<() => void>();
  const publish = (next: ProxyDelaySnapshot) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beginNode(name: string): boolean {
      if (isProxyDelayPending(state, name)) return false;
      publish({ ...state, nodes: new Set(state.nodes).add(name) });
      return true;
    },
    finishNode(group: string, name: string, result: ProxyDelayResult) {
      const nodes = new Set(state.nodes);
      nodes.delete(name);
      publish({
        ...state,
        nodes,
        results: new Map(state.results).set(proxyDelayKey(group, name), result),
      });
    },
    beginGroup(group: string, members: readonly string[]): boolean {
      if (state.groups.has(group) || members.some((name) => isProxyDelayPending(state, name)))
        return false;
      publish({ ...state, groups: new Map(state.groups).set(group, [...members]) });
      return true;
    },
    finishGroup(
      group: string,
      delays: Record<string, number> | undefined,
      historyKeys: ReadonlyMap<string, string>,
    ) {
      const results = new Map(state.results);
      for (const name of state.groups.get(group) ?? []) {
        const key = proxyDelayKey(group, name);
        if (delays && delays[name] === undefined) results.delete(key);
        else results.set(key, { delay: delays?.[name], historyKey: historyKeys.get(name) ?? '' });
      }
      const groups = new Map(state.groups);
      groups.delete(group);
      publish({ ...state, groups, results });
    },
  };
}

// Requests and their results stay with the connection while pages mount and unmount.
const stores = new WeakMap<MihomoClient, ReturnType<typeof createProxyDelayStore>>();
export function proxyDelayStore(client: MihomoClient) {
  let store = stores.get(client);
  if (!store) {
    store = createProxyDelayStore();
    stores.set(client, store);
  }
  return store;
}
