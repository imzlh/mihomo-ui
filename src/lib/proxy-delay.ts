export const PROXY_DELAY_TIMEOUT = 5_000;

export type ProxyDelayState = 'measured' | 'timeout' | 'error' | 'testing' | 'untested';
export interface ProxyDelayDetails {
  state: ProxyDelayState;
  value: number;
  tone: 'green' | 'accent' | 'orange' | 'red' | 'muted';
  text: string;
  label: string;
}

export function describeProxyDelay(
  delay: number | undefined,
  { failed = false, testing = false }: { failed?: boolean; testing?: boolean } = {},
): ProxyDelayDetails {
  const value = delay ?? -1;
  if (testing) return { state: 'testing', value, tone: 'muted', text: '-', label: '测试中' };
  if (failed || (Number.isFinite(value) && value > 100_000))
    return { state: 'error', value, tone: 'red', text: 'Error', label: '测试失败' };
  if (!Number.isFinite(value) || value < 0)
    return { state: 'untested', value, tone: 'muted', text: '-', label: '未测试' };
  if (value === 0 || value >= PROXY_DELAY_TIMEOUT)
    return { state: 'timeout', value, tone: 'red', text: 'Timeout', label: '超时' };
  return {
    state: 'measured',
    value,
    tone: value < 250 ? 'green' : value < 400 ? 'accent' : 'orange',
    text: `${value}`,
    label: `${value} ms`,
  };
}

const rank: Record<ProxyDelayState, number> = {
  measured: 0,
  timeout: 1,
  error: 2,
  testing: 3,
  untested: 4,
};

export function compareProxyDelays(left: ProxyDelayDetails, right: ProxyDelayDetails): number {
  const difference = rank[left.state] - rank[right.state];
  if (difference !== 0) return difference;
  return left.state === 'measured' ? left.value - right.value : 0;
}
