import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { Connection, ConnectionsResponse } from '../src/lib/types';

const controller = 'http://127.0.0.1:9090/view-one';
const otherController = 'http://127.0.0.1:9090/view-two';
const storageKey = `mihomo-verge.connections:${controller}`;
const observedAt = new Date('2026-10-08T04:00:10.000Z');
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    metadata: {
      network: 'tcp',
      type: 'Mixed',
      host: `${id}.example`,
      sourceIP: '2001:db8::1234',
      sourcePort: 51234,
      destinationIP: '203.0.113.10',
      destinationPort: 443,
      process: 'Browser',
      processPath: 'C:/Program Files/Example Browser/Application/browser.exe',
      inboundName: 'mixed-in',
      specialRules: `metadata-marker-${id}`,
    },
    upload: 1024,
    download: 2048,
    start: '2026-10-08T04:00:00.000Z',
    chains: ['DIRECT', 'Default'],
    providerChains: ['subscription-one'],
    rule: 'DomainSuffix',
    rulePayload: 'example',
    ...overrides,
  };
}

async function mockConnections(page: Page, initial: Connection[]) {
  const calls: Array<{ method: string; path: string }> = [];
  const sockets: string[] = [];
  const streams = new Map<string, Set<WebSocketRoute>>();
  const snapshots = new Map<string, ConnectionsResponse>();
  for (const scope of [controller, otherController]) {
    streams.set(scope, new Set());
    snapshots.set(scope, { connections: initial, uploadTotal: 10240, downloadTotal: 20480 });
  }
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, DELETE, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/view-(?:one|two)\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const url = new URL(request.url());
    const scope = `${url.origin}/${url.pathname.split('/')[1]}`;
    const path = url.pathname.replace(/^\/view-(?:one|two)/, '');
    calls.push({ method: request.method(), path });
    const responses: Record<string, unknown> = {
      '/version': { version: 'v1.19.15', meta: true },
      '/configs': { mode: 'rule', 'mixed-port': 7890, 'log-level': 'info' },
      '/proxies': { proxies: { DIRECT: { name: 'DIRECT', type: 'Direct', history: [] } } },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
      '/connections': snapshots.get(scope),
    };
    if (request.method() === 'DELETE') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    await route.fulfill({
      status: path in responses ? 200 : 404,
      headers,
      json: responses[path] ?? {},
    });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/view-(?:one|two)\//, (socket) => {
    sockets.push(socket.url());
    const url = new URL(socket.url());
    const scope = `http://${url.host}/${url.pathname.split('/')[1]}`;
    const channel = url.pathname.split('/').pop();
    if (channel === 'connections') {
      streams.get(scope)!.add(socket);
      socket.onClose(() => streams.get(scope)!.delete(socket));
      socket.send(JSON.stringify(snapshots.get(scope)));
    } else if (channel === 'traffic') socket.send(JSON.stringify({ up: 0, down: 0 }));
    else if (channel === 'memory') socket.send(JSON.stringify({ inuse: 0, oslimit: 0 }));
  });
  return {
    calls,
    sockets,
    async frame(connections: Connection[], scope = controller) {
      await expect.poll(() => streams.get(scope)!.size).toBe(1);
      const previous = snapshots.get(scope)!;
      const snapshot = {
        connections,
        uploadTotal: previous.uploadTotal + 1024,
        downloadTotal: previous.downloadTotal + 2048,
      };
      snapshots.set(scope, snapshot);
      streams.get(scope)!.forEach((socket) => socket.send(JSON.stringify(snapshot)));
    },
  };
}

async function installRateClock(page: Page) {
  await page.clock.setFixedTime(observedAt);
  await page.addInitScript(() => {
    const clock = { now: 1000 };
    Object.assign(window, { connectionRateClock: clock });
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now });
  });
}

async function sampleTime(page: Page, elapsed: number) {
  await page.clock.setFixedTime(new Date(observedAt.getTime() + elapsed));
  await page.evaluate((now) => {
    (window as unknown as { connectionRateClock: { now: number } }).connectionRateClock.now = now;
  }, 1000 + elapsed);
}

async function connect(page: Page, url = controller) {
  await page.getByRole('button', { name: '切换内核', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('控制器地址', { exact: false }).fill(`${url}/`);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect(page.locator('.resource-panel-footer')).toContainText('连接列表实时更新');
}

async function openConnections(page: Page) {
  await page.goto('/#/connections');
  await connect(page);
}

function card(page: Page, id: string) {
  return page.locator(`.connection-list-card[data-connection-id="${id}"]`);
}

function tableRow(page: Page, id: string) {
  return page.locator('.connection-row').filter({ hasText: `${id}.example` });
}

async function setView(page: Page, view: 'table' | 'list') {
  const controls = page.getByRole('group', { name: '连接视图', exact: true });
  const button = controls.getByRole('button', {
    name: view === 'table' ? '表格视图' : '列表视图',
    exact: true,
  });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function cardIds(page: Page) {
  return page
    .locator('.connection-list-card')
    .evaluateAll((cards) => cards.map((item) => item.getAttribute('data-connection-id')));
}

async function sortBy(page: Page, key: string, direction: 'asc' | 'desc') {
  await page.getByRole('combobox', { name: '连接排序字段', exact: true }).selectOption(key);
  const button = page.getByRole('button', { name: '切换排序方向', exact: true });
  const label = direction === 'asc' ? '升序' : '降序';
  if (!(await button.innerText()).includes(label)) await button.click();
  await expect(button).toContainText(label);
}

async function dismissNotifications(page: Page) {
  const close = page.getByRole('button', { name: '关闭通知', exact: true });
  while (await close.count()) await close.first().click();
}

test('table defaults to a sortable searchable list with real sample rates and keyboard metadata details', async ({
  page,
}) => {
  await installRateClock(page);
  const initial = [
    connection('zeta', { download: 8192 }),
    connection('alpha'),
    connection('middle', { download: 4096 }),
  ];
  const api = await mockConnections(page, initial);
  await openConnections(page);
  await expect(page.getByRole('button', { name: '表格视图', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.connection-row')).toHaveCount(3);
  await setView(page, 'list');
  await expect(page.locator('.connections-table')).toHaveCount(0);
  await sortBy(page, 'download', 'asc');
  await expect.poll(() => cardIds(page)).toEqual(['alpha', 'middle', 'zeta']);
  await page.getByRole('button', { name: '切换排序方向', exact: true }).click();
  await expect.poll(() => cardIds(page)).toEqual(['zeta', 'middle', 'alpha']);

  await sampleTime(page, 2000);
  await api.frame([
    connection('zeta', { download: 16384 }),
    connection('alpha', { download: 8192, upload: 5120 }),
    connection('middle', { download: 12288 }),
  ]);
  const alpha = card(page, 'alpha');
  await expect(alpha).toContainText('3.0 KB/s');
  await expect(alpha).toContainText('2.0 KB/s');
  await expect(alpha).toContainText('8.0 KB');
  await dismissNotifications(page);
  await page.screenshot({
    path: '.verification/connections-list-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByPlaceholder('搜索域名、进程或代理链…').fill('metadata-marker-alpha');
  await expect.poll(() => cardIds(page)).toEqual(['alpha']);
  const expand = alpha.getByRole('button', { name: '展开 alpha.example 的详情', exact: true });
  await expand.focus();
  await page.keyboard.press('Enter');
  const collapse = alpha.getByRole('button', { name: '收起 alpha.example 的详情', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(alpha.locator('.connection-details')).toContainText('[2001:db8::1234]:51234');
  await expect(alpha.locator('.connection-details')).toContainText(
    'C:/Program Files/Example Browser/Application/browser.exe',
  );
  await expect(alpha.locator('.connection-details')).toContainText('subscription-one');
  await expect(alpha.locator('.connection-details')).toContainText('metadata-marker-alpha');
  await collapse.focus();
  await page.keyboard.press('Space');
  await expect(alpha.locator('.connection-details')).toHaveCount(0);
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('freeze spans table, list and history while view and sort restore per controller and on preference events', async ({
  page,
}) => {
  await installRateClock(page);
  const api = await mockConnections(page, [connection('alpha'), connection('beta')]);
  await openConnections(page);
  await setView(page, 'list');
  await sortBy(page, 'download', 'desc');
  await sampleTime(page, 2000);
  await api.frame([connection('beta', { download: 8192, upload: 5120 })]);
  await expect(page.getByRole('tab', { name: /^最近关闭/ })).toHaveText('最近关闭1');
  await expect(card(page, 'beta')).toContainText('3.0 KB/s');
  await page.getByRole('button', { name: '暂停显示', exact: true }).click();
  const frozenCard = await card(page, 'beta').innerText();
  const frozenStats = await page.locator('.resource-stats').innerText();
  await sampleTime(page, 32000);
  await api.frame([connection('gamma', { download: 65536 })]);
  await setView(page, 'table');
  await expect(tableRow(page, 'beta').locator('[data-column="download"]')).toContainText(
    '3.0 KB/s',
  );
  await expect(tableRow(page, 'gamma')).toHaveCount(0);
  await expect(page.locator('.resource-stats')).toHaveText(frozenStats, { useInnerText: true });
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(tableRow(page, 'alpha')).toBeVisible();
  await expect(tableRow(page, 'beta')).toHaveCount(0);
  await setView(page, 'list');
  await expect.poll(() => cardIds(page)).toEqual(['alpha']);
  await expect(page.getByRole('button', { name: /^关闭 .+ 的连接$/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /^活动连接/ }).click();
  await expect(card(page, 'beta')).toHaveText(frozenCard, { useInnerText: true });
  await page.getByRole('button', { name: '继续显示', exact: true }).click();
  await expect.poll(() => cardIds(page)).toEqual(['gamma']);
  await expect(page.getByRole('tab', { name: /^最近关闭/ })).toHaveText('最近关闭2');
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(card(page, 'beta')).toContainText('8.0 KB');
  await expect(card(page, 'beta').locator('[data-traffic="download"]')).toContainText('末次下载');
  await expect(card(page, 'beta').locator('[data-traffic="download"]')).not.toContainText('/s');
  await expect(page.getByRole('button', { name: /^关闭 .+ 的连接$/ })).toHaveCount(0);
  await sortBy(page, 'host', 'desc');
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey),
  ).toMatchObject({
    view: 'list',
    activeSort: { key: 'download', direction: 'desc' },
    closedSort: { key: 'host', direction: 'desc' },
  });
  await page.reload();
  await expect(card(page, 'gamma')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '连接排序字段', exact: true })).toHaveValue(
    'download',
  );
  await connect(page, otherController);
  await expect(page.getByRole('button', { name: '表格视图', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await connect(page, controller);
  await expect(card(page, 'gamma')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '连接排序字段', exact: true })).toHaveValue(
    'download',
  );
  await page.evaluate((key) => {
    const preferences = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...preferences,
        view: 'table',
        activeSort: { key: 'host', direction: 'asc' },
      }),
    );
    window.dispatchEvent(new Event('mihomo-verge:preferences-changed'));
  }, storageKey);
  await expect(page.getByRole('button', { name: '表格视图', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page
      .locator('th')
      .filter({ has: page.getByRole('button', { name: '按目标 / 进程排序', exact: true }) }),
  ).toHaveAttribute('aria-sort', 'ascending');
  await page.evaluate((key) => {
    const preferences = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...preferences,
        view: 'list',
        activeSort: { key: 'upload', direction: 'desc' },
      }),
    );
    window.dispatchEvent(new Event('mihomo-verge:preferences-changed'));
  }, storageKey);
  await expect(card(page, 'gamma')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '连接排序字段', exact: true })).toHaveValue(
    'upload',
  );
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('390px cards keep long metadata inside the viewport and demo list actions never request the controller', async ({
  page,
}) => {
  const mobile = connection('mobile');
  mobile.metadata.remoteDestination = `https://example.com/trace/${'abcdef0123456789'.repeat(25)}`;
  const api = await mockConnections(page, [mobile]);
  await openConnections(page);
  await setView(page, 'list');
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, 'mobile')
    .getByRole('button', { name: '展开 mobile.example 的详情', exact: true })
    .click();
  await expect(card(page, 'mobile').locator('.connection-details')).toContainText(
    mobile.metadata.remoteDestination,
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      card(page, 'mobile').evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await dismissNotifications(page);
  await page.screenshot({
    path: '.verification/connections-list-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);

  await page.evaluate(() => localStorage.removeItem('mihomo-verge.backend'));
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  const callsBeforeDemo = api.calls.length;
  const socketsBeforeDemo = api.sockets.length;
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: /^连接(?:\s*\d+)?$/ })
    .click();
  await setView(page, 'list');
  await page.getByRole('combobox', { name: '连接排序字段', exact: true }).selectOption('upload');
  await page
    .getByRole('button', { name: /^关闭 .+ 的连接$/ })
    .first()
    .click();
  await expect(
    page.locator('.toast').filter({ hasText: '演示模式下不会修改实际内核' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '暂停显示', exact: true }).click();
  await setView(page, 'table');
  await setView(page, 'list');
  await page.waitForLoadState('networkidle');
  expect(api.calls).toHaveLength(callsBeforeDemo);
  expect(api.sockets).toHaveLength(socketsBeforeDemo);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
});
