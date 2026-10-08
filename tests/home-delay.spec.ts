import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { ProxyNode, ProxyProvider } from '../src/lib/types';

const controller = 'http://127.0.0.1:9090/home-test';
const providerName = '远端 / 集合';
const node = (name: string, delay: number): ProxyNode => ({
  name,
  type: 'Shadowsocks',
  history: [{ time: '2026-10-08T00:00:00Z', delay }],
});

async function controllerFixture(page: Page, options: { collision?: boolean } = {}) {
  const remote = node('Remote', 80);
  const proxies: Record<string, ProxyNode> = {
    Exit: {
      name: 'Exit',
      type: 'URLTest',
      all: ['Local', 'Remote'],
      now: 'Local',
      fixed: 'Local',
      history: [],
      testUrl: 'https://example.com/check',
      expectedStatus: '204',
    },
    Local: node('Local', 30),
  };
  const providers: Record<string, ProxyProvider> = {
    [providerName]: {
      name: providerName,
      type: 'Proxy',
      vehicleType: 'HTTP',
      proxies: [remote, ...(options.collision ? [node('Local', 900)] : [])],
    },
  };
  const calls: { url: URL; method: string }[] = [];
  const delays: { url: URL; finish: (delay: number) => Promise<void> }[] = [];
  const sockets: WebSocketRoute[] = [];
  let hold = false;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/(home-test|other-test)\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/(home-test|other-test)/, '');
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ url, method: request.method() });
    const json = (value: unknown) => route.fulfill({ json: value, headers });
    if (path.endsWith('/delay') || path.endsWith('/healthcheck')) {
      delays.push({ url, finish: (delay) => json({ delay }).catch(() => {}) });
      if (!hold) await json({ delay: path.endsWith('/healthcheck') ? 42 : 23 });
    } else if (path === '/version') await json({ version: 'test', meta: true });
    else if (path === '/configs')
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      });
    else if (path === '/proxies') await json({ proxies });
    else if (path === '/providers/proxies') await json({ providers });
    else if (path === '/providers/rules') await json({ providers: {} });
    else if (path === '/rules') await json({ rules: [] });
    else if (path === '/proxies/Exit' && request.method() === 'PUT') {
      proxies.Exit!.now = request.postDataJSON().name as string;
      proxies.Exit!.fixed = proxies.Exit!.now;
      await route.fulfill({ status: 204, headers });
    } else await route.fulfill({ status: 404, headers });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\//, (socket) => {
    if (socket.url().includes('/traffic')) sockets.push(socket);
  });
  await page.addInitScript((url) => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url, secret: '' }));
  }, controller);
  await page.goto('/');
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  return {
    calls,
    delays,
    hold: () => {
      hold = true;
    },
    traffic: () =>
      sockets.forEach((socket) => socket.send(JSON.stringify({ up: 1234, down: 4321 }))),
  };
}

async function enableAuto(page: Page) {
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('自动测速间隔（分钟）').fill('1');
  await dialog.getByRole('switch', { name: '自动测试当前出口延迟' }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
}

async function visibility(page: Page, value: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('auto delay survives traffic rerenders and pauses for hidden pages, cards and routes', async ({
  page,
}) => {
  const mock = await controllerFixture(page);
  await page.clock.install();
  await enableAuto(page);
  await expect.poll(() => mock.delays.length).toBe(1);
  await expect(page.locator('.current-proxy-panel')).toContainText('23 ms');
  for (let i = 0; i < 10; i++) {
    mock.traffic();
    await page.clock.runFor(1000);
  }
  expect(mock.delays).toHaveLength(1);
  await page.clock.runFor(50_100);
  await expect.poll(() => mock.delays.length).toBe(2);
  await visibility(page, 'hidden');
  await page.clock.runFor(120_000);
  expect(mock.delays).toHaveLength(2);
  await visibility(page, 'visible');
  await expect.poll(() => mock.delays.length).toBe(3);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  await page.getByRole('switch', { name: '显示代理组出口', exact: true }).click();
  await expect(page.getByRole('switch', { name: '显示代理组出口', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.current-proxy-panel')).toHaveCount(0);
  await page.clock.runFor(120_000);
  expect(mock.delays).toHaveLength(3);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  await page.getByRole('switch', { name: '显示代理组出口', exact: true }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect.poll(() => mock.delays.length).toBe(4);
  await page.getByRole('link', { name: '管理代理组' }).click();
  await expect(page.locator('.current-proxy-panel')).toHaveCount(0);
  await page.clock.runFor(120_000);
  expect(mock.delays).toHaveLength(4);
  expect(mock.calls.some(({ url }) => url.pathname.includes('/group/'))).toBe(false);
});

test('changing an exit cancels its measurement and uses the provider endpoint without clearing pin', async ({
  page,
}) => {
  const mock = await controllerFixture(page);
  mock.hold();
  await page.getByRole('button', { name: '测试当前出口延迟' }).click();
  await expect.poll(() => mock.delays.length).toBe(1);
  await page.getByLabel('首页代理组成员').selectOption('Remote');
  await expect(page.locator('.home-exit-summary')).toContainText('Remote');
  await page.getByRole('button', { name: '测试当前出口延迟' }).click();
  await expect.poll(() => mock.delays.length).toBe(2);
  expect(mock.delays[1]!.url.pathname).toBe(
    `/home-test/providers/proxies/${encodeURIComponent(providerName)}/Remote/healthcheck`,
  );
  expect(mock.delays[1]!.url.searchParams.get('url')).toBe('https://example.com/check');
  await mock.delays[1]!.finish(42);
  await expect(page.locator('.current-proxy-panel')).toContainText('42 ms');
  await mock.delays[0]!.finish(999);
  await expect(page.locator('.current-proxy-panel')).toContainText('42 ms');
  await expect(page.locator('.current-proxy-panel')).not.toContainText('999 ms');
  await expect(page.getByLabel('首页代理组成员')).toHaveValue('Remote');
  expect(
    mock.calls.some(({ url, method }) => method === 'DELETE' || url.pathname.includes('/group/')),
  ).toBe(false);
});

test('top-level nodes retain their identity when a provider contains the same name', async ({
  page,
}) => {
  const mock = await controllerFixture(page, { collision: true });
  await expect(page.locator('.current-proxy-panel')).toContainText('30 ms');
  await page.getByRole('button', { name: '测试当前出口延迟' }).click();
  await expect.poll(() => mock.delays.length).toBe(1);
  expect(mock.delays[0]!.url.pathname).toBe('/home-test/proxies/Local/delay');
  expect(mock.delays[0]!.url.searchParams.get('expected')).toBe('204');
});
