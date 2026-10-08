import { useCallback, useEffect, useRef, useState } from 'react';
import { createHomeDelayRunner, type HomeDelayMeasurement } from '../lib/home-delay';
import type { MihomoClient } from '../lib/mihomo';

export function useHomeDelay({
  client,
  active,
  autoDelay,
  intervalMinutes,
  identity,
  name,
  providerName,
  testUrl,
  expectedStatus,
  onError,
}: {
  client: MihomoClient | null;
  active: boolean;
  autoDelay: boolean;
  intervalMinutes: number;
  identity: string;
  name: string | undefined;
  providerName: string | undefined;
  testUrl: string;
  expectedStatus: string | undefined;
  onError: (message: string, type: 'error') => void;
}) {
  const runnerRef = useRef<ReturnType<typeof createHomeDelayRunner> | null>(null);
  const [result, setResult] = useState<{
    identity: string;
    measurement: HomeDelayMeasurement;
  } | null>(null);

  useEffect(() => {
    setResult(null);
    if (!active || !client || !name) return;
    const runner = createHomeDelayRunner({
      measure: (signal) =>
        providerName
          ? client.providerProxyDelay(providerName, name, testUrl, 5000, signal)
          : client.delay(name, testUrl, 5000, expectedStatus, signal),
      onMeasurement: (measurement) => setResult({ identity, measurement }),
      onError: (error) =>
        onError(error instanceof Error ? error.message : '测试当前出口失败', 'error'),
    });
    runnerRef.current = runner;
    if (autoDelay) runner.schedule(intervalMinutes * 60_000);
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
  }, [
    active,
    client,
    identity,
    name,
    providerName,
    testUrl,
    expectedStatus,
    autoDelay,
    intervalMinutes,
    onError,
  ]);

  const run = useCallback(() => runnerRef.current?.run(true), []);
  return {
    run,
    measurement: active && result?.identity === identity ? result.measurement : null,
  };
}
