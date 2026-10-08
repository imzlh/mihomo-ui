import { describe, expect, it, vi } from 'vitest';
import type { MihomoClient } from './mihomo';
import type { Connection, ConnectionsSnapshot, ProxyNode } from './types';
import { connectionsForProxySwitch, switchProxyWithCleanup } from './proxy-switch';

const group = '策略组';
const previous = '旧节点';
const replacement = '新节点';

function connection(id: string, chains: string[] = [previous, group]): Connection {
  return {
    id,
    chains,
    metadata: {
      network: 'tcp',
      type: 'HTTP',
      sourceIP: '127.0.0.1',
      sourcePort: 1234,
      destinationIP: '192.0.2.1',
      destinationPort: 443,
      host: 'example.com',
    },
    upload: 0,
    download: 0,
    start: '2026-10-08T00:00:00.000Z',
    rule: 'Match',
    rulePayload: '',
  };
}

function mockClient(connections: Connection[] = [connection('old')]) {
  const node: ProxyNode = { name: group, type: 'Selector', now: previous, history: [] };
  const snapshot: ConnectionsSnapshot = { connections, uploadTotal: 0, downloadTotal: 0 };
  return {
    proxy: vi.fn<MihomoClient['proxy']>().mockResolvedValue(node),
    connections: vi.fn<MihomoClient['connections']>().mockResolvedValue(snapshot),
    selectProxy: vi.fn<MihomoClient['selectProxy']>().mockResolvedValue(undefined),
    closeConnection: vi.fn<MihomoClient['closeConnection']>().mockResolvedValue(undefined),
  };
}

describe('connections affected by a proxy switch', () => {
  it('matches the previous member immediately before its group and deduplicates IDs', () => {
    const connections = [
      connection('direct'),
      connection('nested', ['leaf', previous, group, 'outer']),
      connection('other-group', [previous, 'other']),
      connection('nonadjacent', [previous, 'other', group]),
      connection('reverse', [group, previous]),
      connection('group-only', [group]),
      connection('old-only', [previous]),
      connection('empty', []),
      connection('direct'),
    ];

    expect(connectionsForProxySwitch(connections, group, previous).map(({ id }) => id)).toEqual([
      'direct',
      'nested',
    ]);
    expect(connections).toHaveLength(9);
  });
});

describe('switching proxies with old connection cleanup', () => {
  it('closes only captured matching connections after selection succeeds', async () => {
    const connections = [connection('old'), connection('unrelated', [previous, 'other'])];
    const client = mockClient(connections);
    client.selectProxy.mockImplementation(async () => {
      expect(client.closeConnection).not.toHaveBeenCalled();
      connections.push(connection('new-after-snapshot'));
    });

    await expect(switchProxyWithCleanup(client, group, replacement)).resolves.toEqual({
      closed: 1,
      failed: 0,
    });
    expect(client.proxy).toHaveBeenCalledExactlyOnceWith(group);
    expect(client.connections).toHaveBeenCalledTimes(1);
    expect(client.selectProxy).toHaveBeenCalledExactlyOnceWith(group, replacement);
    expect(client.closeConnection).toHaveBeenCalledExactlyOnceWith('old');
  });

  it('keeps connections when selecting the current member even if its snapshot is unavailable', async () => {
    const client = mockClient();
    client.connections.mockRejectedValue(new Error('snapshot unavailable'));

    await expect(switchProxyWithCleanup(client, group, previous)).resolves.toEqual({
      closed: 0,
      failed: 0,
    });
    expect(client.selectProxy).toHaveBeenCalledExactlyOnceWith(group, previous);
    expect(client.closeConnection).not.toHaveBeenCalled();
  });

  it('propagates a rejected selection without closing any connection', async () => {
    const client = mockClient();
    const error = new Error('selection rejected');
    client.selectProxy.mockRejectedValue(error);

    await expect(switchProxyWithCleanup(client, group, replacement)).rejects.toBe(error);
    expect(client.closeConnection).not.toHaveBeenCalled();
  });

  it.each(['proxy', 'connections'] as const)(
    'still selects the requested proxy when reading %s fails',
    async (method) => {
      const client = mockClient();
      client[method].mockRejectedValue(new Error('read failed'));

      await expect(switchProxyWithCleanup(client, group, replacement)).resolves.toEqual({
        closed: 0,
        failed: 0,
        error: 'read failed',
      });
      expect(client.selectProxy).toHaveBeenCalledExactlyOnceWith(group, replacement);
      expect(client.closeConnection).not.toHaveBeenCalled();
    },
  );

  it('reads the group and old connection snapshot concurrently before selecting', async () => {
    const client = mockClient();
    let finishProxy!: (node: ProxyNode) => void;
    client.proxy.mockReturnValue(new Promise((resolve) => (finishProxy = resolve)));

    const switching = switchProxyWithCleanup(client, group, replacement);
    expect(client.connections).toHaveBeenCalledTimes(1);
    expect(client.selectProxy).not.toHaveBeenCalled();
    finishProxy({ name: group, type: 'Selector', now: previous, history: [] });

    await expect(switching).resolves.toEqual({ closed: 1, failed: 0 });
  });

  it('skips cleanup when the core does not identify the previous member', async () => {
    const client = mockClient();
    client.proxy.mockResolvedValue({ name: group, type: 'Selector', history: [] });

    await expect(switchProxyWithCleanup(client, group, replacement)).resolves.toEqual({
      closed: 0,
      failed: 0,
      error: '内核未返回代理组原成员，未清理旧连接',
    });
    expect(client.selectProxy).toHaveBeenCalledExactlyOnceWith(group, replacement);
    expect(client.closeConnection).not.toHaveBeenCalled();
  });

  it('reports partial deletion failures separately from successful selection', async () => {
    const client = mockClient([connection('first'), connection('second'), connection('third')]);
    client.closeConnection.mockImplementation(async (id) => {
      if (id === 'second') throw new Error('delete failed');
    });

    await expect(switchProxyWithCleanup(client, group, replacement)).resolves.toEqual({
      closed: 2,
      failed: 1,
      error: 'delete failed',
    });
    expect(client.closeConnection).toHaveBeenCalledTimes(3);
  });

  it('counts every failed deletion without rejecting a successful switch', async () => {
    const client = mockClient([connection('first'), connection('second')]);
    client.closeConnection.mockRejectedValue(new Error('delete failed'));

    await expect(switchProxyWithCleanup(client, group, replacement)).resolves.toEqual({
      closed: 0,
      failed: 2,
      error: 'delete failed',
    });
  });

  it('limits concurrent deletion requests to four while processing every captured ID', async () => {
    const client = mockClient(Array.from({ length: 9 }, (_, index) => connection(String(index))));
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    client.closeConnection.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });

    const switching = switchProxyWithCleanup(client, group, replacement);
    await vi.waitFor(() => expect(client.closeConnection).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(client.closeConnection).toHaveBeenCalledTimes(8));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(client.closeConnection).toHaveBeenCalledTimes(9));
    releases.splice(0).forEach((release) => release());

    await expect(switching).resolves.toEqual({ closed: 9, failed: 0 });
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });
});
