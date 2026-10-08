import { describe, expect, it } from 'vitest';
import { compareProxyDelays, describeProxyDelay } from './proxy-delay';

describe('proxy delay display and sorting', () => {
  it.each([
    [undefined, 'untested', '-', 'muted'],
    [Number.NaN, 'untested', '-', 'muted'],
    [Number.POSITIVE_INFINITY, 'untested', '-', 'muted'],
    [-1, 'untested', '-', 'muted'],
    [0, 'timeout', 'Timeout', 'red'],
    [249, 'measured', '249', 'green'],
    [250, 'measured', '250', 'accent'],
    [399, 'measured', '399', 'accent'],
    [400, 'measured', '400', 'orange'],
    [4_999, 'measured', '4999', 'orange'],
    [5_000, 'timeout', 'Timeout', 'red'],
    [100_000, 'timeout', 'Timeout', 'red'],
    [100_001, 'error', 'Error', 'red'],
  ] as const)(
    'classifies %s consistently for its displayed value and color',
    (value, state, text, tone) => {
      expect(describeProxyDelay(value)).toMatchObject({ state, text, tone });
    },
  );

  it('lets pending tests replace old results and distinguishes a failed request from untested', () => {
    expect(describeProxyDelay(24, { testing: true })).toMatchObject({ state: 'testing' });
    expect(describeProxyDelay(undefined, { failed: true })).toMatchObject({
      state: 'error',
      text: 'Error',
    });
    expect(describeProxyDelay(undefined, { failed: true, testing: true }).state).toBe('testing');
  });

  it('orders measured, timeout, error, testing and untested while retaining ties in source order', () => {
    const entries = [
      ['untried-z', describeProxyDelay(undefined)],
      ['timeout-z', describeProxyDelay(0)],
      ['measured-z', describeProxyDelay(23)],
      ['error-z', describeProxyDelay(undefined, { failed: true })],
      ['untried-a', describeProxyDelay(-1)],
      ['testing-z', describeProxyDelay(1, { testing: true })],
      ['timeout-a', describeProxyDelay(5_000)],
      ['measured-a', describeProxyDelay(23)],
      ['error-a', describeProxyDelay(1_000_000)],
      ['testing-a', describeProxyDelay(undefined, { testing: true })],
      ['fastest', describeProxyDelay(12)],
    ] as const;
    const sorted = [...entries].sort((left, right) => compareProxyDelays(left[1], right[1]));
    expect(sorted.map(([name]) => name)).toEqual([
      'fastest',
      'measured-z',
      'measured-a',
      'timeout-z',
      'timeout-a',
      'error-z',
      'error-a',
      'testing-z',
      'testing-a',
      'untried-z',
      'untried-a',
    ]);
  });
});
