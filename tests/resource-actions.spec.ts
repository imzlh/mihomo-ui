import { expect, test, type Page } from '@playwright/test';
import type { ProxyNode, Rule } from '../src/lib/types';

const controller = 'http://127.0.0.1:9090/resource-check';
const otherController = 'http://127.0.0.1:9091/resource-check';
const providerName = 'Remote / 远端';
const nodeName = 'Tokyo / A #1';
const compatibleProvider = 'Built-in';
const compatibleNode = 'Built-in A';
const browserErrors = new WeakMap<Page, string[]>();

/** Rule writes can be ignored; provider history always stays at its old value. */
async function resourceFixture(page: Page, path: '/rules' | '/providers') {
  const rules: Rule[] = [
    {
      index: 8,
      type: 'DomainSuffix',
      payload: 'zulu.example',
      proxy: 'DIRECT',
      extra: { disabled: false },
    },
    {
      index: 3,
      type: 'DomainSuffix',
      payload: 'alpha.example',
      proxy: 'DIRECT',
      extra: { disabled: false },
    },
    { index: 17, type: 'DomainSuffix', payload: 'legacy.example', proxy: 'DIRECT' },
    { index: 18, type: 'Match', payload: '', proxy: 'DIRECT', extra: { hitCount: 3 } },
  ];
  const node = (name: string): ProxyNode => ({
    name,
    type: 'Shadowsocks',
    udp: true,
    history: [{ time: '2026-10-08T00:00:00Z', delay: 32 }],
  });
  const providers = {
    [providerName]: {
      name: providerName,
      type: 'Proxy',
      vehicleType: 'HTTP',
      proxies: [node(nodeName)],
    },
    [compatibleProvider]: {
      name: compatibleProvider,
      type: 'Proxy',
      vehicleType: 'Compatible',
      proxies: [node(compatibleNode)],
    },
  };
  const calls: { controller: string; method: string; path: string; body: unknown }[] = [];
  const measurements: {
    controller: string;
    method: string;
    path: string;
    finish: (value: unknown, status?: number) => Promise<void>;
  }[] = [];
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:909[01]\/resource-check\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const url = new URL(request.url());
    const base = url.port === '9090' ? controller : otherController;
    const resource = url.pathname.slice('/resource-check'.length);
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    calls.push({ controller: base, method: request.method(), path: resource, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers, json: value });
    if (resource.endsWith('/healthcheck') || resource.endsWith('/delay')) {
      measurements.push({
        controller: base,
        method: request.method(),
        path: resource,
        finish: json,
      });
    } else if (resource === '/rules/disable' && request.method() === 'PATCH') {
      // Only the alpha rule accepts writes, and its physical response position changes.
      if ((body as Record<string, boolean>)['3'] === true) {
        rules.find((rule) => rule.index === 3)!.extra!.disabled = true;
        rules.reverse();
      }
      await route.fulfill({ status: 204, headers });
    } else {
      const values: Record<string, unknown> = {
        '/version': { version: 'resource-test', meta: true },
        '/configs': {
          mode: 'rule',
          'mixed-port': 7890,
          'allow-lan': false,
          ipv6: false,
          'log-level': 'info',
        },
        '/proxies': { proxies: { [compatibleNode]: node(compatibleNode) } },
        '/providers/proxies': { providers },
        '/providers/rules': { providers: {} },
        '/rules': { rules },
      };
      if (resource in values) await json(values[resource]);
      else await json({ message: `Unmocked resource API: ${request.method()} ${resource}` }, 404);
    }
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:909[01]\/resource-check\//, () => {});
  await page.addInitScript((url) => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url, secret: '' }));
  }, controller);
  await page.goto(`/#${path}`);
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  return { calls, measurements };
}

async function openProvider(page: Page, name = providerName) {
  await page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .getByRole('button', { name: /^查看节点/ })
    .click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function reopenProvider(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await navigation.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: '资源', exact: true }).click();
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
  await openProvider(page);
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

test('rules require disabled support and verify sparse core indices after each acknowledged write', async ({
  page,
}) => {
  const api = await resourceFixture(page, '/rules');
  const row = (index: number) => page.locator(`.rules-table tr[data-rule-index="${index}"]`);
  for (const index of [17, 18]) {
    await expect(row(index)).toContainText('状态未提供');
    await expect(row(index).getByRole('button')).toBeDisabled();
    await row(index)
      .getByRole('button')
      .evaluate((button) => (button as HTMLButtonElement).click());
  }
  expect(api.calls.filter((call) => call.method === 'PATCH')).toEqual([]);

  const beforeIgnoredWrite = api.calls.length;
  await row(8).getByRole('button', { name: '临时禁用第 9 条规则', exact: true }).click();
  await expect(page.locator('.toast.error').filter({ hasText: '未生效' })).toBeVisible();
  await expect(row(8)).toContainText('已启用');
  await expect(row(8).getByRole('button')).toBeEnabled();
  await expect(page.locator('.toast.success').filter({ hasText: '第 9 条规则' })).toHaveCount(0);
  expect(
    api.calls
      .slice(beforeIgnoredWrite)
      .filter((call) => call.path.startsWith('/rules'))
      .slice(0, 2)
      .map(({ method, path }) => [method, path]),
  ).toEqual([
    ['PATCH', '/rules/disable'],
    ['GET', '/rules'],
  ]);

  await page.getByRole('button', { name: '按规则内容排序', exact: true }).click();
  await page.getByPlaceholder('搜索规则内容或策略…').fill('alpha.example');
  await expect(page.locator('.rules-table tbody tr')).toHaveCount(1);
  await expect(row(3)).toBeVisible();
  await row(3).getByRole('button', { name: '临时禁用第 4 条规则', exact: true }).click();
  await expect(row(3)).toContainText('已禁用');
  await expect(
    page.locator('.toast.success').filter({ hasText: '第 4 条规则已临时禁用' }),
  ).toBeVisible();
  expect(
    api.calls
      .filter((call) => call.path === '/rules/disable')
      .map(({ method, body }) => ({ method, body })),
  ).toEqual([
    { method: 'PATCH', body: { '8': true } },
    { method: 'PATCH', body: { '3': true } },
  ]);
});

test('provider measurements survive modal and route changes, preserve response values, and stay with their controller', async ({
  page,
}) => {
  const api = await resourceFixture(page, '/providers');
  const dialog = await openProvider(page);
  const row = dialog
    .locator('tbody tr')
    .filter({ has: page.getByRole('cell', { name: nodeName, exact: true }) });
  const latency = row.getByRole('cell').nth(2);
  await expect(latency).toHaveText('32 ms');
  await row.getByRole('button', { name: '测速', exact: true }).click();
  await expect.poll(() => api.measurements.length).toBe(1);
  expect(api.measurements[0]).toMatchObject({
    controller,
    method: 'GET',
    path: `/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent(nodeName)}/healthcheck`,
  });
  await expect(latency).toHaveText('测试中');
  await expect(row.getByRole('button')).toBeDisabled();
  await reopenProvider(page);
  await expect(latency).toHaveText('测试中');
  await expect(row.getByRole('button')).toBeDisabled();
  expect(api.measurements).toHaveLength(1);

  await api.measurements[0]!.finish({ delay: 96 });
  await expect(latency).toHaveText('96 ms');
  await expect(row.getByRole('button')).toBeEnabled();
  await reopenProvider(page);
  await expect(latency).toHaveText('96 ms');

  await row.getByRole('button', { name: '测速', exact: true }).click();
  await expect.poll(() => api.measurements.length).toBe(2);
  await api.measurements[1]!.finish({ message: 'Healthcheck failed' }, 500);
  await expect(latency).toHaveText('Error');
  await reopenProvider(page);
  await expect(latency).toHaveText('Error');
  await expect(row.getByRole('button')).toBeEnabled();

  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '切换内核', exact: true }).click();
  const connection = page.getByRole('dialog');
  await connection.getByLabel('控制器地址', { exact: false }).fill(otherController);
  await connection.getByPlaceholder('输入内核设置的 secret').fill('');
  await connection.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(connection).not.toBeVisible();
  await openProvider(page);
  await expect(latency).toHaveText('32 ms');
  await expect(row.getByRole('button')).toBeEnabled();

  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const builtIn = await openProvider(page, compatibleProvider);
  await builtIn.getByRole('button', { name: '测速', exact: true }).click();
  await expect.poll(() => api.measurements.length).toBe(3);
  expect(api.measurements[2]).toMatchObject({
    controller: otherController,
    method: 'GET',
    path: `/proxies/${encodeURIComponent(compatibleNode)}/delay`,
  });
  await api.measurements[2]!.finish({ delay: 42 });
  await expect(builtIn.getByRole('cell', { name: '42 ms', exact: true })).toBeVisible();
});
