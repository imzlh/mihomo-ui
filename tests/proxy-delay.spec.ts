import { expect, test, type Page } from '@playwright/test';
import type { ProxyNode } from '../src/lib/types';

const controller = 'http://127.0.0.1:9090/delay-check';
const groupName = '节点选择';
const sharedGroupName = '共享节点';
const selectedName = '当前未测';
const values: readonly (readonly [string, number | undefined])[] = [
  ['日本 Tokyo 10', 32],
  ['香港 Hong Kong', 249],
  ['日本 Tokyo 2', 32],
  ['美国 Los Angeles', 250],
  ['新加坡 Singapore', 399],
  ['英国 London', 400],
  ['超时节点 2', 5000],
  ['超时节点 1', 0],
  ['未测试节点 2', undefined],
  ['未测试节点 1', undefined],
  [selectedName, undefined],
];
const browserErrors = new WeakMap<Page, string[]>();

/** Keep /proxies history unchanged so the page must use each measurement response. */
async function delayFixture(page: Page) {
  const proxies: Record<string, ProxyNode> = Object.fromEntries(
    values.map(([name, delay]) => [
      name,
      {
        name,
        type: 'Shadowsocks',
        udp: true,
        history: delay === undefined ? [] : [{ time: '2026-10-08T00:00:00Z', delay }],
      },
    ]),
  );
  proxies.DIRECT = { name: 'DIRECT', type: 'Direct', history: [] };
  proxies.REJECT = { name: 'REJECT', type: 'Reject', history: [] };
  proxies[groupName] = {
    name: groupName,
    type: 'Selector',
    all: Object.keys(proxies),
    now: selectedName,
    history: [],
  };
  proxies[sharedGroupName] = {
    name: sharedGroupName,
    type: 'Selector',
    all: [selectedName, '香港 Hong Kong'],
    now: selectedName,
    history: [],
  };
  const requests: {
    path: string;
    method: string;
    finish: (value: unknown, status?: number) => Promise<void>;
  }[] = [];
  let proxyReads = 0;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/delay-check\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = decodeURIComponent(new URL(request.url()).pathname.slice('/delay-check'.length));
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers, json: value });
    if (path.endsWith('/delay')) {
      requests.push({ path, method: request.method(), finish: json });
    } else if (path === '/version') await json({ version: 'delay-test', meta: true });
    else if (path === '/configs') {
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      });
    } else if (path === '/proxies') {
      proxyReads++;
      await json({ proxies });
    } else if (path === '/providers/proxies' || path === '/providers/rules') {
      await json({ providers: {} });
    } else if (path === '/rules') await json({ rules: [] });
    else await json({ message: `Unmocked delay API: ${request.method()} ${path}` }, 404);
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/delay-check\//, () => {});
  await page.addInitScript((url) => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url, secret: '' }));
  }, controller);
  await page.goto('/#/proxies');
  const group = page.getByRole('region', { name: `${groupName} 代理组`, exact: true });
  const card = (name: string) => group.getByRole('article', { name: `${name} 节点`, exact: true });
  const latency = (name: string) => card(name).locator('.proxy-node-test .latency');
  const measure = (name: string) =>
    card(name).getByRole('button', { name: '测试节点延迟', exact: true });
  await expect(group.locator('.proxy-node')).toHaveCount(values.length + 2);
  return {
    group,
    card,
    latency,
    measure,
    requests,
    sharedGroup: page.getByRole('region', { name: `${sharedGroupName} 代理组`, exact: true }),
    proxyReads: () => proxyReads,
  };
}

async function leaveAndReturn(page: Page) {
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await navigation.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '设置', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: '代理', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '代理', exact: true })).toBeVisible();
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

test('proxy delay keeps the compact layout, selected slot and measurements across route changes', async ({
  page,
}) => {
  const api = await delayFixture(page);
  await page.mouse.move(0, 0);
  for (const [name, delay] of values) {
    await expect(api.card(name)).toHaveCSS('height', '56px');
    await expect(api.card(name).locator('.proxy-node-name')).toHaveCSS('font-size', '14px');
    if (name !== selectedName) {
      await expect(api.latency(name)).toHaveText(
        delay === undefined ? '-' : delay === 0 || delay >= 5000 ? 'Timeout' : String(delay),
      );
      await expect(api.latency(name)).toHaveCSS('font-size', '14px');
      await expect(api.card(name).locator('.proxy-delay-selection')).toHaveCount(0);
    }
  }
  await expect(
    api.card(selectedName).locator('.proxy-node-test .proxy-delay-selection'),
  ).toBeVisible();
  await expect(
    api.card(selectedName).locator('.proxy-node-select .proxy-delay-selection'),
  ).toHaveCount(0);
  for (const name of ['DIRECT', 'REJECT']) {
    await expect(api.card(name).locator('.proxy-node-test')).toHaveCount(0);
  }
  const colors = await Promise.all(
    ['日本 Tokyo 10', '香港 Hong Kong', '美国 Los Angeles', '新加坡 Singapore', '英国 London'].map(
      (name) => api.latency(name).evaluate((element) => getComputedStyle(element).color),
    ),
  );
  expect(colors[0]).toBe(colors[1]);
  expect(colors[2]).toBe(colors[3]);
  expect(new Set([colors[0], colors[2], colors[4]]).size).toBe(3);

  const readsBeforeMeasurement = api.proxyReads();
  await api.measure(selectedName).click();
  await expect.poll(() => api.requests.length).toBe(1);
  expect(api.requests[0]!.path).toBe(`/proxies/${selectedName}/delay`);
  await expect(api.card(selectedName).locator('.proxy-delay-loading > i')).toHaveCount(3);
  await expect(api.card(selectedName).locator('.proxy-delay-selection')).toHaveCount(0);
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(1);
  await expect(api.sharedGroup.locator('.proxy-test-button')).toBeDisabled();
  await leaveAndReturn(page);
  await expect(api.measure(selectedName)).toBeDisabled();
  await expect(api.card(selectedName).locator('.proxy-delay-loading > i')).toHaveCount(3);
  await expect(api.sharedGroup.locator('.proxy-test-button')).toBeDisabled();
  expect(api.requests).toHaveLength(1);
  await api.requests[0]!.finish({ delay: 96 });
  await expect(api.latency(selectedName)).toHaveText('96');
  await expect.poll(api.proxyReads).toBeGreaterThan(readsBeforeMeasurement);
  await expect(api.measure(selectedName)).toBeEnabled();
  await expect(api.card(selectedName).locator('.proxy-delay-selection')).toHaveCount(0);
  await leaveAndReturn(page);
  await expect(api.latency(selectedName)).toHaveText('96');

  await api.measure(selectedName).click();
  await expect.poll(() => api.requests.length).toBe(2);
  await api.requests[1]!.finish({ message: 'Delay request failed' }, 500);
  await expect(api.latency(selectedName)).toHaveText('Error');
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(0);
  await leaveAndReturn(page);
  await expect(api.latency(selectedName)).toHaveText('Error');
  await expect(api.card(selectedName).locator('.proxy-delay-selection')).toHaveCount(0);
  await expect(api.latency('香港 Hong Kong')).toHaveText('249');

  await api.measure('香港 Hong Kong').click();
  await expect.poll(() => api.requests.length).toBe(3);
  await page.getByLabel('节点排序', { exact: true }).selectOption('latency');
  await expect(api.group.locator('.proxy-node-name')).toHaveText([
    '日本 Tokyo 10',
    '日本 Tokyo 2',
    '美国 Los Angeles',
    '新加坡 Singapore',
    '英国 London',
    '超时节点 2',
    '超时节点 1',
    selectedName,
    '香港 Hong Kong',
    '未测试节点 2',
    '未测试节点 1',
    'DIRECT',
    'REJECT',
  ]);
  await api.requests[2]!.finish({ delay: 42 });
  await expect(api.latency('香港 Hong Kong')).toHaveText('42');
  expect(api.requests.every((request) => request.method === 'GET')).toBe(true);
});

test('group delay shows three-dot waits, response values and failures, and a timed-out node unlocks', async ({
  page,
}) => {
  const api = await delayFixture(page);
  await api.group.locator('.proxy-test-button').click();
  await expect.poll(() => api.requests.length).toBe(1);
  expect(api.requests[0]!.path).toBe(`/group/${groupName}/delay`);
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(values.length);
  await expect(api.sharedGroup.locator('.proxy-test-button')).toBeDisabled();
  for (const [name] of values) {
    await expect(api.measure(name)).toBeDisabled();
    await expect(api.measure(name)).toHaveAttribute('title', /^等待测速结果/);
    await expect(api.card(name).locator('.proxy-delay-loading > i')).toHaveCount(3);
    await expect(api.card(name).locator('.proxy-delay-selection')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(api.card(selectedName)).toHaveCSS('height', '56px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = Object.fromEntries(
    values.map(([name], index) => [
      name,
      [41, 0, 41, 252, 399, 400, 5000, 0, 99, 150, 123][index]!,
    ]),
  );
  await api.requests[0]!.finish(results);
  for (const [name, delay] of Object.entries(results)) {
    await expect(api.latency(name)).toHaveText(
      delay === 0 || delay >= 5000 ? 'Timeout' : String(delay),
    );
    await expect(api.measure(name)).toBeEnabled();
  }
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(0);
  await expect(api.card(selectedName).locator('.proxy-delay-selection')).toHaveCount(0);
  await api.group.locator('.proxy-test-button').click();
  await expect.poll(() => api.requests.length).toBe(2);
  await api.requests[1]!.finish({ message: 'Group measurement failed' }, 500);
  for (const [name] of values) await expect(api.latency(name)).toHaveText('Error');
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(0);
  await expect(api.group.locator('.proxy-test-button')).toBeEnabled();

  await page.clock.install();
  await api.measure(selectedName).click();
  await expect.poll(() => api.requests.length).toBe(3);
  await expect(api.card(selectedName).locator('.proxy-delay-loading > i')).toHaveCount(3);
  await page.clock.fastForward(12_001);
  await expect(api.latency(selectedName)).toHaveText('Error');
  await expect(api.measure(selectedName)).toBeEnabled();
  await expect(api.group.locator('.proxy-test-button')).toBeEnabled();
  await expect(api.sharedGroup.locator('.proxy-test-button')).toBeEnabled();
  await expect(page.locator('.toast').filter({ hasText: '连接后端超时' })).toBeVisible();
  await expect(api.group.locator('.proxy-delay-loading')).toHaveCount(0);
  expect(api.requests).toHaveLength(3);
});
