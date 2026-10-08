import type { Connection, ConnectionsResponse } from './types';

export interface ClosedConnection extends Connection {
  /** First subsequent snapshot in which this connection was absent. */
  closedAt: number;
  /** Last snapshot containing this connection; counters end at this observation. */
  lastSeenAt: number;
}

export interface ConnectionHistoryState {
  baseline: { connections: Connection[]; observedAt: number } | null;
  closed: ClosedConnection[];
}

type ConnectionHistoryAction =
  | { type: 'snapshot'; connections: Connection[]; observedAt: number }
  | { type: 'interrupt' }
  | { type: 'clear' }
  | { type: 'reset' };

export const CONNECTION_HISTORY_LIMIT = 500;
export const connectionIdentity = (connection: Connection): string =>
  JSON.stringify([connection.id, connection.start]);

export function createConnectionHistory(): ConnectionHistoryState {
  return { baseline: null, closed: [] };
}

/** Only adjacent, valid frames from the same uninterrupted stream prove a disappearance. */
export function reduceConnectionHistory(
  state: ConnectionHistoryState,
  action: ConnectionHistoryAction,
): ConnectionHistoryState {
  if (action.type === 'reset') return createConnectionHistory();
  if (action.type === 'clear') return { ...state, closed: [] };
  if (action.type === 'interrupt') return { ...state, baseline: null };
  const baseline = { connections: action.connections, observedAt: action.observedAt };
  if (!state.baseline) return { ...state, baseline };
  const current = new Set(action.connections.map(connectionIdentity));
  const removed = state.baseline.connections
    .filter((connection) => !current.has(connectionIdentity(connection)))
    .map((connection) => ({
      ...connection,
      closedAt: action.observedAt,
      lastSeenAt: state.baseline!.observedAt,
    }));
  if (!removed.length) return { ...state, baseline };
  const added = new Set(removed.map(connectionIdentity));
  return {
    baseline,
    closed: [
      ...removed,
      ...state.closed.filter((item) => !added.has(connectionIdentity(item))),
    ].slice(0, CONNECTION_HISTORY_LIMIT),
  };
}

/** A malformed response must not be interpreted as an empty connection list. */
export function isConnectionsResponse(value: unknown): value is ConnectionsResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (
    typeof data.uploadTotal !== 'number' ||
    !Number.isFinite(data.uploadTotal) ||
    data.uploadTotal < 0 ||
    typeof data.downloadTotal !== 'number' ||
    !Number.isFinite(data.downloadTotal) ||
    data.downloadTotal < 0
  )
    return false;
  return (
    data.connections === null ||
    (Array.isArray(data.connections) &&
      data.connections.every((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        const connection = item as Record<string, unknown>;
        const metadata = connection.metadata as Record<string, unknown> | undefined;
        return (
          typeof connection.id === 'string' &&
          typeof connection.start === 'string' &&
          typeof connection.upload === 'number' &&
          Number.isFinite(connection.upload) &&
          connection.upload >= 0 &&
          typeof connection.download === 'number' &&
          Number.isFinite(connection.download) &&
          connection.download >= 0 &&
          Array.isArray(connection.chains) &&
          connection.chains.every((chain) => typeof chain === 'string') &&
          (connection.providerChains == null ||
            (Array.isArray(connection.providerChains) &&
              connection.providerChains.every((provider) => typeof provider === 'string'))) &&
          !!metadata &&
          typeof metadata === 'object' &&
          typeof metadata.network === 'string' &&
          [
            'host',
            'sourceIP',
            'destinationIP',
            'process',
            'processPath',
            'type',
            'inboundName',
          ].every((key) => metadata[key] == null || typeof metadata[key] === 'string')
        );
      }))
  );
}
