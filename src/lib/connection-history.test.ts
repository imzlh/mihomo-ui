import { describe, expect, it } from 'vitest';
import {
  createConnectionHistory,
  isConnectionsResponse,
  reduceConnectionHistory,
} from './connection-history';
import type { Connection } from './types';

function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    metadata: {
      network: 'tcp',
      type: 'Mixed',
      sourceIP: '127.0.0.1',
      sourcePort: 51234,
      destinationIP: '203.0.113.10',
      destinationPort: 443,
      host: 'example.com',
    },
    upload: 100,
    download: 200,
    start: '2026-10-08T00:00:00.000Z',
    chains: ['DIRECT'],
    rule: 'DomainSuffix',
    rulePayload: 'example.com',
    ...overrides,
  };
}

describe('connection history', () => {
  it('uses the first snapshot as a baseline without closing any connections', () => {
    const connections = [connection('first'), connection('second')];
    const state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections,
      observedAt: 1_000,
    });

    expect(state.closed).toEqual([]);
    expect(state.baseline).toEqual({ connections, observedAt: 1_000 });
  });

  it('archives the final observed values and distinguishes last seen from closure time', () => {
    const first = connection('first');
    const second = connection('second');
    const initial = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections: [first, second],
      observedAt: 1_000,
    });
    const finalFirst = connection('first', {
      upload: 1_200,
      download: 3_400,
      chains: ['Hong Kong', 'Proxy'],
      metadata: { ...first.metadata, process: 'browser.exe' },
    });
    const updated = reduceConnectionHistory(initial, {
      type: 'snapshot',
      connections: [finalFirst, second],
      observedAt: 2_000,
    });
    expect(updated.closed).toEqual([]);

    const state = reduceConnectionHistory(updated, {
      type: 'snapshot',
      connections: [second],
      observedAt: 3_500,
    });
    expect(state.closed).toEqual([{ ...finalFirst, lastSeenAt: 2_000, closedAt: 3_500 }]);
    expect(state.baseline).toEqual({ connections: [second], observedAt: 3_500 });
    expect(initial.closed).toEqual([]);
  });

  it('archives every removed connection once even across repeated empty snapshots', () => {
    const connections = [connection('first'), connection('second')];
    let state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections,
      observedAt: 1_000,
    });
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 2_000,
    });
    const closed = state.closed;
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 3_000,
    });

    expect(state.closed).toEqual(closed);
    expect(state.closed).toHaveLength(2);
    expect(state.closed).toEqual(
      expect.arrayContaining(
        connections.map((item) => ({ ...item, lastSeenAt: 1_000, closedAt: 2_000 })),
      ),
    );
  });

  it('preserves history across interruptions without treating missing reconnect rows as closed', () => {
    const alreadyClosed = connection('closed');
    const beforeDisconnect = connection('before-disconnect');
    let state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections: [alreadyClosed, beforeDisconnect],
      observedAt: 1_000,
    });
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [beforeDisconnect],
      observedAt: 2_000,
    });
    const existingHistory = state.closed;
    state = reduceConnectionHistory(state, { type: 'interrupt' });
    expect(state.baseline).toBeNull();
    expect(state.closed).toEqual(existingHistory);

    const afterReconnect = connection('after-reconnect');
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [afterReconnect],
      observedAt: 10_000,
    });
    expect(state.closed).toEqual(existingHistory);
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 11_000,
    });
    expect(state.closed).toHaveLength(2);
    expect(state.closed).toContainEqual({
      ...afterReconnect,
      lastSeenAt: 10_000,
      closedAt: 11_000,
    });
    expect(state.closed.some((item) => item.id === beforeDisconnect.id)).toBe(false);
  });

  it('clears closed rows while retaining the baseline for the next closure', () => {
    const first = connection('first');
    const second = connection('second');
    let state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections: [first, second],
      observedAt: 1_000,
    });
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [second],
      observedAt: 2_000,
    });
    state = reduceConnectionHistory(state, { type: 'clear' });
    expect(state.closed).toEqual([]);
    expect(state.baseline).toEqual({ connections: [second], observedAt: 2_000 });

    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 3_000,
    });
    expect(state.closed).toEqual([{ ...second, lastSeenAt: 2_000, closedAt: 3_000 }]);
  });

  it('resets both history and baseline when switching to another controller', () => {
    let state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections: [connection('closed'), connection('active')],
      observedAt: 1_000,
    });
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [connection('active')],
      observedAt: 2_000,
    });
    state = reduceConnectionHistory(state, { type: 'reset' });
    expect(state).toEqual({ baseline: null, closed: [] });

    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 3_000,
    });
    expect(state.closed).toEqual([]);
  });

  it('treats a reused id with a different start as a new connection', () => {
    const original = connection('reused', { download: 5_000 });
    const replacement = connection('reused', { start: '2026-10-08T00:00:02.000Z' });
    let state = reduceConnectionHistory(createConnectionHistory(), {
      type: 'snapshot',
      connections: [original],
      observedAt: 1_000,
    });
    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [replacement],
      observedAt: 2_000,
    });
    expect(state.closed).toEqual([{ ...original, lastSeenAt: 1_000, closedAt: 2_000 }]);

    state = reduceConnectionHistory(state, {
      type: 'snapshot',
      connections: [],
      observedAt: 3_000,
    });
    expect(state.closed).toHaveLength(2);
    expect(state.closed).toContainEqual({ ...original, lastSeenAt: 1_000, closedAt: 2_000 });
    expect(state.closed).toContainEqual({ ...replacement, lastSeenAt: 2_000, closedAt: 3_000 });
  });

  it('keeps the 500 most recently closed connections when history reaches its limit', () => {
    let state = createConnectionHistory();
    for (let index = 0; index < 502; index += 1) {
      state = reduceConnectionHistory(state, {
        type: 'snapshot',
        connections: [connection(`connection-${index}`)],
        observedAt: index * 1_000,
      });
    }

    expect(state.closed).toHaveLength(500);
    expect(state.closed.some((item) => item.id === 'connection-0')).toBe(false);
    expect(state.closed.some((item) => item.id === 'connection-501')).toBe(false);
    expect(state.closed.map((item) => item.id)).toEqual(
      expect.arrayContaining(Array.from({ length: 500 }, (_, index) => `connection-${index + 1}`)),
    );
    expect(state.closed[0]?.id).toBe('connection-500');
    expect(state.closed[499]?.id).toBe('connection-1');
  });
});

describe('connection snapshot validation', () => {
  it('accepts valid connection arrays and the empty null slice sent by Mihomo', () => {
    for (const connections of [null, [], [connection('valid')]]) {
      expect(isConnectionsResponse({ connections, uploadTotal: 100, downloadTotal: 200 })).toBe(
        true,
      );
    }
  });

  it.each([
    null,
    {},
    { uploadTotal: 100, downloadTotal: 200 },
    { uploadTotal: '100', downloadTotal: 200, connections: [] },
    { uploadTotal: 100, downloadTotal: Number.NaN, connections: [] },
    { uploadTotal: Infinity, downloadTotal: 200, connections: [] },
    { uploadTotal: 100, downloadTotal: 200, connections: {} },
    { uploadTotal: 100, downloadTotal: 200, connections: [null] },
    { uploadTotal: 100, downloadTotal: 200, connections: [{ ...connection('bad'), id: null }] },
    { uploadTotal: 100, downloadTotal: 200, connections: [{ ...connection('bad'), start: null }] },
    { uploadTotal: 100, downloadTotal: 200, connections: [connection('bad', { upload: NaN })] },
    {
      uploadTotal: 100,
      downloadTotal: 200,
      connections: [connection('bad', { download: Infinity })],
    },
    {
      uploadTotal: 100,
      downloadTotal: 200,
      connections: [{ ...connection('bad'), metadata: null }],
    },
    { uploadTotal: 100, downloadTotal: 200, connections: [{ ...connection('bad'), metadata: {} }] },
    { uploadTotal: 100, downloadTotal: 200, connections: [{ ...connection('bad'), chains: null }] },
    { uploadTotal: 100, downloadTotal: 200, connections: [{ ...connection('bad'), chains: [42] }] },
  ])('rejects malformed snapshot %# instead of interpreting it as an empty list', (value) => {
    expect(isConnectionsResponse(value)).toBe(false);
  });
});
