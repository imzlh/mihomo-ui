import { useEffect, useRef, useState } from 'react';
import type { ConnectionsSnapshot } from '../lib/types';

export interface ConnectionRate {
  upload: number | null;
  download: number | null;
}

export type ConnectionRates = Record<string, ConnectionRate>;

function counterRate(previous: number, current: number, elapsedMs: number): number | null {
  if (
    !Number.isFinite(previous) ||
    !Number.isFinite(current) ||
    previous < 0 ||
    current < previous
  ) {
    return null;
  }

  const rate = (current - previous) / (elapsedMs / 1_000);
  return Number.isFinite(rate) ? rate : null;
}

export function calculateConnectionRates(
  previousSnapshot: ConnectionsSnapshot | null | undefined,
  currentSnapshot: ConnectionsSnapshot,
  elapsedMs: number,
): ConnectionRates {
  const previousConnections = new Map(
    previousSnapshot?.connections.map((connection) => [connection.id, connection]),
  );
  const validInterval = Number.isFinite(elapsedMs) && elapsedMs > 0;

  return Object.fromEntries(
    currentSnapshot.connections.map((connection) => {
      const previous = previousConnections.get(connection.id);
      const validBaseline = validInterval && previous && previous.start === connection.start;

      return [
        connection.id,
        {
          upload: validBaseline ? counterRate(previous.upload, connection.upload, elapsedMs) : null,
          download: validBaseline
            ? counterRate(previous.download, connection.download, elapsedMs)
            : null,
        },
      ];
    }),
  );
}

export function useConnectionRates(
  snapshot: ConnectionsSnapshot,
  sessionKey: unknown,
): ConnectionRates {
  const baseline = useRef<{
    snapshot: ConnectionsSnapshot;
    sessionKey: unknown;
    observedAt: number;
  } | null>(null);
  const [rates, setRates] = useState<ConnectionRates>(() =>
    calculateConnectionRates(null, snapshot, 0),
  );

  useEffect(() => {
    const previous = baseline.current;
    const sameSession = previous !== null && Object.is(previous.sessionKey, sessionKey);

    // React StrictMode can repeat an effect without receiving a new sample.
    if (sameSession && previous.snapshot === snapshot) return;

    const observedAt = performance.now();
    setRates(
      calculateConnectionRates(
        sameSession ? previous.snapshot : null,
        snapshot,
        sameSession ? observedAt - previous.observedAt : 0,
      ),
    );
    baseline.current = { snapshot, sessionKey, observedAt };
  }, [snapshot, sessionKey]);

  return rates;
}
