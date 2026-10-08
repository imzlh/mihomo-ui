import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeDelayRunner } from './home-delay';

function deferredMeasurement() {
  let resolve!: (value: { delay: number }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ delay: number }>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(measure: (signal: AbortSignal) => Promise<{ delay: number }>) {
  const onMeasurement = vi.fn();
  const onError = vi.fn();
  return {
    runner: createHomeDelayRunner({ measure, onMeasurement, onError }),
    onMeasurement,
    onError,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('home delay runner', () => {
  it('starts at 100 ms and waits a full interval after a slow request completes', async () => {
    const pending = deferredMeasurement();
    const measure = vi.fn((_signal: AbortSignal) => pending.promise);
    const { runner, onMeasurement } = setup(measure);
    runner.schedule(60_000);

    await vi.advanceTimersByTimeAsync(99);
    expect(measure).not.toHaveBeenCalled();
    expect(onMeasurement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(onMeasurement).toHaveBeenLastCalledWith({ status: 'testing' });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(measure).toHaveBeenCalledTimes(1);
    pending.resolve({ delay: 86 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMeasurement).toHaveBeenLastCalledWith({ status: 'success', delay: 86 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(measure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(measure).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it('shares an in-flight request across repeated automatic and manual runs', async () => {
    const pending = deferredMeasurement();
    const measure = vi.fn((_signal: AbortSignal) => pending.promise);
    const { runner, onMeasurement } = setup(measure);
    const first = runner.run();
    expect(runner.run(true)).toBe(first);
    expect(runner.run()).toBe(first);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runner.run(true)).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(onMeasurement).toHaveBeenCalledTimes(1);

    pending.resolve({ delay: 35 });
    await first;
    expect(onMeasurement.mock.calls).toEqual([
      [{ status: 'testing' }],
      [{ status: 'success', delay: 35 }],
    ]);
    await runner.run(true);
    expect(measure).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it.each(['resolve', 'reject'] as const)(
    'aborts on dispose and ignores a late %s without scheduling more work',
    async (settlement) => {
      const pending = deferredMeasurement();
      const measure = vi.fn((_signal: AbortSignal) => pending.promise);
      const { runner, onMeasurement, onError } = setup(measure);
      runner.schedule(60_000);
      const request = runner.run(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(measure).toHaveBeenCalledTimes(1);
      const signal = measure.mock.calls[0]![0];
      expect(signal.aborted).toBe(false);

      runner.dispose();
      expect(signal.aborted).toBe(true);
      if (settlement === 'resolve') pending.resolve({ delay: 50 });
      else pending.reject(new Error('Late failure from an obsolete exit'));
      await request;
      await vi.advanceTimersByTimeAsync(120_000);
      runner.schedule(60_000);
      await runner.run(true);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(measure).toHaveBeenCalledTimes(1);
      expect(onMeasurement.mock.calls).toEqual([[{ status: 'testing' }]]);
      expect(onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cancels a pending initial timer when disposed before the first measurement', async () => {
    const measure = vi.fn().mockResolvedValue({ delay: 50 });
    const { runner, onMeasurement, onError } = setup(measure);
    runner.schedule(60_000);
    runner.dispose();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(measure).not.toHaveBeenCalled();
    expect(onMeasurement).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps automatic failures quiet, retries on schedule, and notifies manual failures', async () => {
    const automaticError = new Error('Automatic measurement failed');
    const manualError = new Error('Manual measurement failed');
    const measure = vi.fn().mockRejectedValueOnce(automaticError).mockResolvedValue({ delay: 20 });
    const { runner, onMeasurement, onError } = setup(measure);
    runner.schedule(1_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(onMeasurement).toHaveBeenLastCalledWith({ status: 'error' });
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(measure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(onMeasurement).toHaveBeenLastCalledWith({ status: 'success', delay: 20 });
    expect(onError).not.toHaveBeenCalled();

    measure.mockRejectedValueOnce(manualError);
    await expect(runner.run(true)).resolves.toBeUndefined();
    expect(onMeasurement).toHaveBeenLastCalledWith({ status: 'error' });
    expect(onError).toHaveBeenCalledExactlyOnceWith(manualError);
    runner.dispose();
  });
});
