import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProxyNode, ProxyProvider } from '../src/lib/types';
import type { ConnectivityPreferences, ConnectivityTarget } from '../src/lib/connectivity-tests';

const controller = 'http://127.0.0.1:9090/connectivity';
const otherController = 'http://127.0.0.1:9090/connectivity-other';
const localGroup = 'Main / 出口';
const remoteGroup = 'Remote / 出口';
const localNode = 'Core / Alpha';
const remoteNode = 'Remote / Beta';
const providerName = 'Provider / 远端';
const storageKey = `mihomo-verge.connectivity-tests:${controller}`;
const defaultTargets: ConnectivityTarget[] = [
  { id: 'google', name: 'Google', url: 'https://www.gstatic.com/generate_204', timeout: 5000 },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://cp.cloudflare.com/generate_204',
    timeout: 5000,
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    url: 'http://www.msftconnecttest.com/connecttest.txt',
    timeout: 5000,
  },
];

interface ApiCall {
  url: URL;
  method: string;
}

interface PendingCheck extends ApiCall {
  finish: (delay: number, status?: number) => Promise<void>;
}

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

async function mockConnectivityController(page: Page) {
  const node = (name: string): ProxyNode => ({ name, type: 'Shadowsocks', history: [] });
  const remote = { ...node(remoteNode), 'provider-name': providerName };
  const proxies: Record<string, ProxyNode> = {
    [localGroup]: {
      name: localGroup,
      type: 'Selector',
      all: [localNode],
      now: localNode,
      history: [],
    },
    [remoteGroup]: {
      name: remoteGroup,
      type: 'Selector',
      all: [remoteNode],
      now: remoteNode,
      history: [],
    },
    [localNode]: node(localNode),
    [remoteNode]: remote,
  };
  const providers: Record<string, ProxyProvider> = {
    [providerName]: { name: providerName, type: 'Proxy', vehicleType: 'HTTP', proxies: [remote] },
    Collision: {
      name: 'Collision',
      type: 'Proxy',
      vehicleType: 'HTTP',
      proxies: [node(localNode), node(remoteNode)],
    },
  };
  const calls: ApiCall[] = [];
  const checks: PendingCheck[] = [];
  const sockets: string[] = [];
  const externalRequests: string[] = [];
  const frontendOrigin = new URL(test.info().project.use.baseURL!).origin;
  let activeChecks = 0;
  let maxConcurrent = 0;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, OPTIONS',
  };
  await page.route(/^https?:\/\//, async (route) => {
    if (new URL(route.request().url()).origin === frontendOrigin) {
      await route.fallback();
      return;
    }
    externalRequests.push(route.request().url());
    await route.abort();
  });
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/connectivity(?:-other)?\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/connectivity(?:-other)?/, '');
    calls.push({ url, method });
    if (
      /^\/proxies\/.+\/delay$/.test(path) ||
      /^\/providers\/proxies\/.+\/.+\/healthcheck$/.test(path)
    ) {
      activeChecks += 1;
      maxConcurrent = Math.max(maxConcurrent, activeChecks);
      let finished = false;
      checks.push({
        url,
        method,
        finish: async (delay, status = 200) => {
          if (finished) return;
          finished = true;
          activeChecks -= 1;
          await route
            .fulfill({
              status,
              headers,
              json: status === 200 ? { delay } : { message: 'Target unavailable' },
            })
            .catch(() => {});
        },
      });
      return;
    }
    const responses: Record<string, unknown> = {
      '/version': { version: 'test', meta: true },
      '/configs': { mode: 'rule', 'mixed-port': 7890, 'log-level': 'info' },
      '/proxies': { proxies },
      '/providers/proxies': { providers },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
    };
    await route.fulfill({
      status: path in responses ? 200 : 404,
      headers,
      json: responses[path] ?? {},
    });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\//, (socket) => {
    sockets.push(socket.url());
  });
  return { calls, checks, sockets, externalRequests, maxConcurrent: () => maxConcurrent };
}

async function connect(page: Page, url = controller) {
  await page.getByRole('button', { name: '切换内核', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('控制器地址', { exact: false }).fill(`${url}/`);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
}

async function openConnectivity(page: Page) {
  await page.goto('/#/diagnostics');
  await connect(page);
  const region = page.getByRole('region', { name: '连通性测试', exact: true });
  await expect(region).toBeVisible();
  return region;
}

async function seedTargets(page: Page, targets = defaultTargets) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: { version: 1, targets, exit: { kind: 'proxy', name: localGroup } },
  });
}

async function targetNames(region: Locator) {
  return region
    .locator('article[data-target-id] button[aria-label^="测试 "]')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')!.slice('测试 '.length)),
    );
}

async function readPreferences(page: Page): Promise<ConnectivityPreferences> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey);
}

async function openTargets(page: Page, region: Locator) {
  await region.getByRole('button', { name: '管理测试目标', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '测试目标', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function expectReadOnly(api: Awaited<ReturnType<typeof mockConnectivityController>>) {
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  expect(api.externalRequests, 'Only the controller may request target URLs').toEqual([]);
}

test('target add, edit, delete, order and exit preferences persist separately for each controller', async ({
  page,
}) => {
  const api = await mockConnectivityController(page);
  const region = await openConnectivity(page);
  await expect.poll(() => targetNames(region)).toEqual(['Google', 'Cloudflare', 'Microsoft']);
  const dialog = await openTargets(page, region);
  await dialog.getByRole('button', { name: '新增目标', exact: true }).click();
  await dialog.getByLabel('目标名称', { exact: true }).fill('Custom');
  await dialog.getByLabel('测试地址', { exact: true }).fill('https://example.com/health');
  await dialog.getByLabel('超时（毫秒）', { exact: true }).fill('6500');
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click();
  await dialog.getByRole('button', { name: '编辑 Custom', exact: true }).click();
  await dialog.getByLabel('目标名称', { exact: true }).fill('Edited');
  await dialog
    .getByLabel('测试地址', { exact: true })
    .fill('https://example.com/revised?check=a+b');
  await dialog.getByLabel('超时（毫秒）', { exact: true }).fill('7300');
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click();
  await dialog.getByRole('button', { name: '删除 Google', exact: true }).click();
  await dialog.getByRole('button', { name: '上移 Edited', exact: true }).click();
  await dialog.getByRole('button', { name: '上移 Edited', exact: true }).click();
  await expect
    .poll(async () => (await readPreferences(page)).targets.map((target) => target.name))
    .toEqual(['Edited', 'Cloudflare', 'Microsoft']);
  await dialog.getByRole('button', { name: '下移 Edited', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const selectedExit = { kind: 'proxy', name: remoteGroup };
  await region
    .getByRole('combobox', { name: '测试出口', exact: true })
    .selectOption(JSON.stringify(selectedExit));
  expect(await readPreferences(page)).toMatchObject({
    version: 1,
    targets: [
      defaultTargets[1],
      { name: 'Edited', url: 'https://example.com/revised?check=a+b', timeout: 7300 },
      defaultTargets[2],
    ],
    exit: selectedExit,
  });
  await page.reload();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect.poll(() => targetNames(region)).toEqual(['Cloudflare', 'Edited', 'Microsoft']);
  await expect(region.getByRole('combobox', { name: '测试出口', exact: true })).toHaveValue(
    JSON.stringify(selectedExit),
  );
  await connect(page, otherController);
  await expect.poll(() => targetNames(region)).toEqual(['Google', 'Cloudflare', 'Microsoft']);
  await connect(page, controller);
  await expect.poll(() => targetNames(region)).toEqual(['Cloudflare', 'Edited', 'Microsoft']);
  expect(api.checks).toHaveLength(0);
  expectReadOnly(api);
});

test('all targets use at most three leaf delay requests and distinguish timeout, error and cancellation', async ({
  page,
}) => {
  const targets = [
    ...defaultTargets,
    {
      id: 'extra',
      name: 'Extra',
      url: 'https://example.com/check?token=a+b&part=2',
      timeout: 7300,
    },
  ];
  const api = await mockConnectivityController(page);
  await seedTargets(page, targets);
  const region = await openConnectivity(page);
  await region.getByRole('button', { name: '全部测试', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(3);
  await expect(region.locator('article[data-status="testing"]')).toHaveCount(3);
  await expect(region.locator('article[data-status="queued"]')).toHaveCount(1);
  await api.checks[0]!.finish(38);
  await expect.poll(() => api.checks.length).toBe(4);
  await Promise.all([
    api.checks[1]!.finish(0),
    api.checks[2]!.finish(0, 503),
    api.checks[3]!.finish(63),
  ]);
  const google = region.locator('article[data-target-id="google"]');
  await expect(google).toHaveAttribute('data-status', 'success');
  await expect(google).toContainText('38 ms');
  await expect(region.locator('article[data-target-id="cloudflare"]')).toHaveAttribute(
    'data-status',
    'timeout',
  );
  await expect(region.locator('article[data-target-id="microsoft"]')).toHaveAttribute(
    'data-status',
    'error',
  );
  await expect(region.locator('article[data-target-id="extra"]')).toContainText('63 ms');
  expect(api.maxConcurrent()).toBe(3);
  expect(
    api.checks.map(({ url, method }) => ({
      method,
      path: url.pathname,
      url: url.searchParams.get('url'),
      timeout: url.searchParams.get('timeout'),
    })),
  ).toEqual(
    targets.map((target) => ({
      method: 'GET',
      path: `/connectivity/proxies/${encodeURIComponent(localNode)}/delay`,
      url: target.url,
      timeout: String(target.timeout),
    })),
  );
  await google.getByRole('button', { name: '测试 Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(5);
  await region.getByRole('button', { name: '取消测试', exact: true }).click();
  await expect(google).toHaveAttribute('data-status', 'cancelled');
  await api.checks[4]!.finish(999);
  await page.waitForLoadState('networkidle');
  await expect(google).not.toContainText('999 ms');
  await expect(google).toHaveAttribute('data-status', 'cancelled');
  expectReadOnly(api);
});

test('exit and target changes discard obsolete results, resolve provider identity and keep demo offline', async ({
  page,
}) => {
  const api = await mockConnectivityController(page);
  await seedTargets(page);
  const region = await openConnectivity(page);
  const google = region.locator('article[data-target-id="google"]');
  await google.getByRole('button', { name: '测试 Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(1);
  await region
    .getByRole('combobox', { name: '测试出口', exact: true })
    .selectOption(JSON.stringify({ kind: 'proxy', name: remoteGroup }));
  await api.checks[0]!.finish(999);
  await page.waitForLoadState('networkidle');
  await expect(google).not.toContainText('999 ms');
  await google.getByRole('button', { name: '测试 Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(2);
  expect(api.checks[1]!.url.pathname).toBe(
    `/connectivity/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent(remoteNode)}/healthcheck`,
  );
  await api.checks[1]!.finish(41);
  await expect(google).toContainText('41 ms');
  await google.getByRole('button', { name: '测试 Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(3);
  const dialog = await openTargets(page, region);
  await dialog.getByRole('button', { name: '编辑 Google', exact: true }).click();
  await dialog.getByLabel('目标名称', { exact: true }).fill('Revised Google');
  await dialog.getByLabel('测试地址', { exact: true }).fill('https://example.com/revised-google');
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await api.checks[2]!.finish(999);
  await page.waitForLoadState('networkidle');
  await expect(google).not.toContainText('999 ms');
  await expect(google).not.toContainText('41 ms');
  await google.getByRole('button', { name: '测试 Revised Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(4);
  expect(api.checks[3]!.url.searchParams.get('url')).toBe('https://example.com/revised-google');
  await api.checks[3]!.finish(37);
  await expect(google).toContainText('37 ms');

  await google.getByRole('button', { name: '测试 Revised Google', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(5);
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        targets: [
          {
            id: 'restored',
            name: 'Restored target',
            url: 'https://example.com/restored',
            timeout: 6000,
          },
        ],
        exit: { kind: 'proxy', name: 'Main / 出口' },
      }),
    );
    window.dispatchEvent(new Event('mihomo-verge:preferences-changed'));
  }, storageKey);
  await expect.poll(() => targetNames(region)).toEqual(['Restored target']);
  await api.checks[4]!.finish(999);
  await page.waitForLoadState('networkidle');
  await expect(region.locator('article[data-target-id="restored"]')).toHaveAttribute(
    'data-status',
    'idle',
  );
  await expect(region).not.toContainText('999 ms');
  await region.getByRole('button', { name: '测试 Restored target', exact: true }).click();
  await expect.poll(() => api.checks.length).toBe(6);
  expect(api.checks[5]!.url.pathname).toBe(
    `/connectivity/proxies/${encodeURIComponent(localNode)}/delay`,
  );
  expect(api.checks[5]!.url.searchParams.get('url')).toBe('https://example.com/restored');
  await api.checks[5]!.finish(29);
  await expect(region.locator('article[data-target-id="restored"]')).toContainText('29 ms');
  expectReadOnly(api);

  await page.evaluate(() => localStorage.removeItem('mihomo-verge.backend'));
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  const callsBeforeDemo = api.calls.length;
  const socketsBeforeDemo = api.sockets.length;
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '网络诊断', exact: true })
    .click();
  await expect(region).toContainText('演示');
  await region.getByRole('button', { name: '全部测试', exact: true }).click();
  await expect(region.locator('article[data-status="success"]')).toHaveCount(3);
  await page.waitForLoadState('networkidle');
  expect(api.calls).toHaveLength(callsBeforeDemo);
  expect(api.sockets).toHaveLength(socketsBeforeDemo);
  expectReadOnly(api);

  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1);
    await region.screenshot({
      path: `.verification/connectivity-${name}.png`,
      animations: 'disabled',
    });
  }
});
