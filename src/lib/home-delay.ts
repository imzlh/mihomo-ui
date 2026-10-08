export type HomeDelayMeasurement =
  { status: 'testing' } | { status: 'success'; delay: number } | { status: 'error' };

/** One page/exit owns one runner. Disposing cancels its request and all future work. */
export function createHomeDelayRunner({
  measure,
  onMeasurement,
  onError,
}: {
  measure: (signal: AbortSignal) => Promise<{ delay: number }>;
  onMeasurement: (measurement: HomeDelayMeasurement) => void;
  onError: (error: unknown) => void;
}) {
  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function run(manual = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    controller = new AbortController();
    const signal = controller.signal;
    onMeasurement({ status: 'testing' });
    inFlight = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        return measure(signal);
      })
      .then(({ delay }) => {
        if (!disposed && !signal.aborted) onMeasurement({ status: 'success', delay });
      })
      .catch((error: unknown) => {
        if (!disposed && !signal.aborted) {
          onMeasurement({ status: 'error' });
          if (manual) onError(error);
        }
      })
      .finally(() => {
        controller = undefined;
        inFlight = undefined;
      });
    return inFlight;
  }

  function schedule(intervalMs: number) {
    clearTimeout(timer);
    const tick = async () => {
      await run();
      if (!disposed) timer = setTimeout(() => void tick(), intervalMs);
    };
    if (!disposed) timer = setTimeout(() => void tick(), 100);
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
  }

  return { run, schedule, dispose };
}
