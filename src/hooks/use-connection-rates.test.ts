import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionsSnapshot } from '../lib/types';
import { calculateConnectionRates } from './use-connection-rates';

function connection(
  id: string,
  upload: number,
  download: number,
  start = '2026-10-07T00:00:00Z',
): Connection {
  return {
    id,
    upload,
    download,
    start,
    metadata: {
      network: 'tcp',
      type: 'HTTP',
      sourceIP: '127.0.0.1',
      sourcePort: 10_000,
      destinationIP: '1.1.1.1',
      destinationPort: 443,
      host: 'example.com',
    },
    chains: ['DIRECT'],
    rule: 'MATCH',
    rulePayload: '',
  };
}

function snapshot(...connections: Connection[]): ConnectionsSnapshot {
  return { connections, uploadTotal: 0, downloadTotal: 0 };
}

describe('calculateConnectionRates', () => {
  it('computes actual byte deltas per second for a fractional sampling interval', () => {
    const previous = snapshot(connection('a', 1_000, 5_000), connection('b', 1_000_000, 8_000_000));
    const current = snapshot(connection('a', 1_750, 6_500), connection('b', 1_001_500, 8_750_000));

    expect(calculateConnectionRates(previous, current, 1_500)).toEqual({
      a: { upload: 500, download: 1_000 },
      b: { upload: 1_000, download: 500_000 },
    });
  });

  it('reports zero when valid counters do not change', () => {
    const sample = snapshot(connection('a', 100, 200));

    expect(calculateConnectionRates(sample, sample, 1_000)).toEqual({
      a: { upload: 0, download: 0 },
    });
  });

  it.each([null, undefined])(
    'reports unknown rates without a previous snapshot (%s)',
    (previous) => {
      expect(
        calculateConnectionRates(previous, snapshot(connection('a', 100, 200)), 1_000),
      ).toEqual({
        a: { upload: null, download: null },
      });
    },
  );

  it('matches connections by ID, leaves new IDs unknown, and prunes disappeared IDs', () => {
    const previous = snapshot(connection('removed', 100, 100), connection('kept', 400, 500));
    const current = snapshot(connection('new', 30_000, 40_000), connection('kept', 900, 1_500));

    expect(calculateConnectionRates(previous, current, 1_000)).toEqual({
      new: { upload: null, download: null },
      kept: { upload: 500, download: 1_000 },
    });
    expect(calculateConnectionRates(current, snapshot(), 1_000)).toEqual({});
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'reports unknown rates for an invalid elapsed interval (%s)',
    (elapsedMs) => {
      expect(
        calculateConnectionRates(
          snapshot(connection('a', 100, 200)),
          snapshot(connection('a', 300, 400)),
          elapsedMs,
        ),
      ).toEqual({ a: { upload: null, download: null } });
    },
  );

  it('discards decreased counters independently and accepts the next valid baseline', () => {
    const previous = snapshot(connection('a', 1_000, 5_000), connection('b', 1_000, 5_000));
    const reset = snapshot(connection('a', 0, 6_000), connection('b', 2_000, 0));
    const recovered = snapshot(connection('a', 250, 7_000), connection('b', 2_500, 1_000));

    expect(calculateConnectionRates(previous, reset, 1_000)).toEqual({
      a: { upload: null, download: 1_000 },
      b: { upload: 1_000, download: null },
    });
    expect(calculateConnectionRates(reset, recovered, 1_000)).toEqual({
      a: { upload: 250, download: 1_000 },
      b: { upload: 500, download: 1_000 },
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    'rejects invalid current and previous counters (%s)',
    (invalid) => {
      const previous = snapshot(connection('a', invalid, 0), connection('b', 0, invalid));
      const current = snapshot(connection('a', 10, invalid), connection('b', invalid, 10));

      expect(calculateConnectionRates(previous, current, 1_000)).toEqual({
        a: { upload: null, download: null },
        b: { upload: null, download: null },
      });
    },
  );

  it('rejects overflow instead of returning infinite rates', () => {
    expect(
      calculateConnectionRates(
        snapshot(connection('a', 0, 0)),
        snapshot(connection('a', Number.MAX_VALUE, 1)),
        1,
      ),
    ).toEqual({ a: { upload: null, download: 1_000 } });
  });

  it('treats a reused ID with a different start as a new connection', () => {
    const previous = snapshot(connection('a', 100, 200));
    const current = snapshot(connection('a', 2_000, 3_000, '2026-10-07T01:00:00Z'));

    expect(calculateConnectionRates(previous, current, 1_000)).toEqual({
      a: { upload: null, download: null },
    });
  });
});
