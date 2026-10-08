import { describe, expect, it, vi } from 'vitest';
import {
  connectivityFailure,
  normalizeConnectivityPreferences,
  resolveConnectivityExit,
  runConnectivityTests,
  validateConnectivityPreferences,
  type ConnectivityResult,
  type ConnectivityTarget,
} from './connectivity-tests';
import { MihomoApiError } from './mihomo';
import type { ProxyNode, ProxyProvider } from './types';

const target: ConnectivityTarget = {
  id: 'test',
  name: 'Test',
  url: 'https://example.com/check',
  timeout: 5000,
};

describe('connectivity preference validation', () => {
  it('preserves an intentionally empty list and validates an explicit provider identity', () => {
    expect(normalizeConnectivityPreferences({ version: 1, targets: [] })).toEqual({
      version: 1,
      targets: [],
    });
    expect(
      validateConnectivityPreferences({
        version: 1,
        targets: [target],
        exit: { kind: 'provider', provider: ' Remote / A ', name: ' Same name ' },
      }),
    ).toEqual({
      version: 1,
      targets: [target],
      exit: { kind: 'provider', provider: ' Remote / A ', name: ' Same name ' },
    });
  });

  it.each([
    { version: 2, targets: [] },
    { version: 1, targets: [target, target] },
    { version: 1, targets: [target], secret: 'must not restore' },
    { version: 1, targets: [{ ...target, url: 'file:///private' }] },
    { version: 1, targets: [{ ...target, url: 'https://user:password@example.com/' }] },
    { version: 1, targets: [{ ...target, timeout: 500 }] },
    { version: 1, targets: [{ ...target, timeout: 30001 }] },
    { version: 1, targets: [target], exit: { kind: 'provider', name: 'Node' } },
  ])('rejects invalid or extra settings instead of importing them', (value) => {
    expect(() => validateConnectivityPreferences(value)).toThrow();
  });
});

describe('connectivity exit identity', () => {
  const leaf: ProxyNode = { name: 'Shared', type: 'Shadowsocks', history: [] };
  const group: ProxyNode = {
    name: 'Group',
    type: 'Selector',
    now: 'Shared',
    all: ['Shared'],
    history: [],
  };
  const providers: Record<string, ProxyProvider> = {
    a: { name: 'a', type: 'Proxy', vehicleType: 'HTTP', proxies: [{ ...leaf }] },
    b: { name: 'b', type: 'Proxy', vehicleType: 'HTTP', proxies: [{ ...leaf }] },
  };

  it('resolves the selected group to its core leaf even when providers reuse the name', () => {
    expect(
      resolveConnectivityExit(
        { kind: 'proxy', name: 'Group' },
        { Group: group, Shared: leaf },
        providers,
        { Shared: leaf },
      ),
    ).toMatchObject({
      name: 'Shared',
      chain: ['Group', 'Shared'],
      providerName: undefined,
      reason: undefined,
    });
  });

  it('requires an explicit provider when a provider-only name is ambiguous', () => {
    const proxies = { Group: group, Shared: leaf };
    expect(
      resolveConnectivityExit({ kind: 'proxy', name: 'Group' }, proxies, providers, {}).reason,
    ).toContain('同名');
    expect(
      resolveConnectivityExit(
        { kind: 'provider', provider: 'b', name: 'Shared' },
        proxies,
        providers,
        {},
      ),
    ).toMatchObject({ name: 'Shared', providerName: 'b', reason: undefined });
  });
});

describe('connectivity request batches', () => {
  it('limits concurrency and discards late completions plus queued work after cancellation', async () => {
    const controller = new AbortController();
    const targets = Array.from({ length: 5 }, (_, index) => ({ ...target, id: String(index) }));
    const pending: Array<(value: { delay: number }) => void> = [];
    const measure = vi.fn(() => new Promise<{ delay: number }>((resolve) => pending.push(resolve)));
    const updates: Array<{ id: string; result: ConnectivityResult }> = [];
    const running = runConnectivityTests({
      targets,
      signal: controller.signal,
      measure,
      onResult: (id, result) => updates.push({ id, result }),
    });
    expect(measure).toHaveBeenCalledTimes(3);
    pending.shift()!({ delay: 20 });
    await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(4));
    controller.abort();
    pending.splice(0).forEach((resolve) => resolve({ delay: 999 }));
    await running;
    expect(measure).toHaveBeenCalledTimes(4);
    expect(updates.filter((update) => update.result.status === 'success')).toEqual([
      { id: '0', result: { status: 'success', delay: 20 } },
    ]);
    expect(updates.some((update) => update.id === '4')).toBe(false);
  });

  it('keeps zero delay, an API error and a malformed response distinct', async () => {
    const measure = vi
      .fn()
      .mockResolvedValueOnce({ delay: 0 })
      .mockRejectedValueOnce(new MihomoApiError('Unavailable', 503))
      .mockResolvedValueOnce({ delay: NaN });
    const results: Record<string, ConnectivityResult> = {};
    await runConnectivityTests({
      targets: ['timeout', 'api-error', 'invalid'].map((id) => ({ ...target, id })),
      signal: new AbortController().signal,
      measure,
      onResult: (id, result) => {
        results[id] = result;
      },
    });
    expect(results.timeout?.status).toBe('timeout');
    expect(results['api-error']).toEqual({ status: 'error', detail: 'Unavailable' });
    expect(results.invalid).toEqual({ status: 'error', detail: '内核未返回有效延迟' });
    expect(connectivityFailure(new MihomoApiError('Gateway timeout', 504)).status).toBe('timeout');
    expect(connectivityFailure(new Error('Failed to fetch')).status).toBe('error');
  });
});
