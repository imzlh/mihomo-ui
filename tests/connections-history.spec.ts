import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { Connection, ConnectionsResponse } from '../src/lib/types';

const controllerOrigin = 'http://127.0.0.1:9090';
const firstController = `${controllerOrigin}/history-one`;
const secondController = `${controllerOrigin}/history-two`;
const observedAt = new Date('2026-10-08T04:00:15.000Z');
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
    },
    upload: 1_024,
    download: 2_048,
    start: '2026-10-08T04:00:00.000Z',
    chains: ['DIRECT'],
    providerChains: ['subscription-one'],
    rule: 'DomainSuffix',
    rulePayload: 'example',
    ...overrides,
  };
}

async function mockConnections(page: Page, initialConnections: Connection[]) {
  const calls: { method: string; path: string }[] = [];
  const streams = new Map<string, Set<WebSocketRoute>>();
  const withheld = new Set<string>();
  const opened = new Map<string, number>();
  const snapshots = new Map<string, ConnectionsResponse>();
  for (const controller of [firstController, secondController]) {
    streams.set(controller, new Set());
    snapshots.set(controller, {
      connections: initialConnections,
      uploadTotal: 10_240,
      downloadTotal: 20_480,
    });
  }
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/history-(?:one|two)\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const url = new URL(request.url());
    const controller = `${controllerOrigin}/${url.pathname.split('/')[1]}`;
    const path = url.pathname.slice(new URL(controller).pathname.length);
    calls.push({ method: request.method(), path });
    const json = (value: unknown) => route.fulfill({ headers, json: value });
    if (path === '/version') await json({ version: 'v1.19.15', meta: true });
    else if (path === '/configs') {
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
        tun: { enable: false, stack: 'mixed' },
      });
    } else if (path === '/proxies') {
      await json({
        proxies: {
          DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
          GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['DIRECT'], now: 'DIRECT', history: [] },
        },
      });
    } else if (path === '/connections' && request.method() === 'GET') {
      await json(snapshots.get(controller));
    } else if (path === '/rules') await json({ rules: [] });
    else if (path === '/providers/proxies' || path === '/providers/rules') {
      await json({ providers: {} });
    } else if (path.endsWith('/delay')) await json({ delay: 25 });
    else if (request.method() === 'DELETE') await route.fulfill({ status: 204, headers });
    else await route.fulfill({ status: 404, headers, json: { message: `Unmocked API: ${path}` } });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/history-(?:one|two)\//, (socket) => {
    const url = new URL(socket.url());
    const controller = `${controllerOrigin}/${url.pathname.split('/')[1]}`;
    const stream = url.pathname.split('/').pop();
    if (stream === 'connections') {
      streams.get(controller)!.add(socket);
      opened.set(controller, (opened.get(controller) ?? 0) + 1);
      socket.onClose(() => streams.get(controller)!.delete(socket));
      if (!withheld.has(controller)) socket.send(JSON.stringify(snapshots.get(controller)));
    } else if (stream === 'traffic') socket.send(JSON.stringify({ up: 0, down: 0 }));
    else if (stream === 'memory') socket.send(JSON.stringify({ inuse: 67_108_864, oslimit: 0 }));
  });

  return {
    calls,
    opened,
    frame(connections: Connection[] | null, controller = firstController) {
      const previous = snapshots.get(controller)!;
      const snapshot = {
        connections,
        uploadTotal: previous.uploadTotal + 1_024,
        downloadTotal: previous.downloadTotal + 2_048,
      };
      snapshots.set(controller, snapshot);
      streams.get(controller)!.forEach((socket) => socket.send(JSON.stringify(snapshot)));
    },
    raw(value: unknown, controller = firstController) {
      streams.get(controller)!.forEach((socket) => socket.send(JSON.stringify(value)));
    },
    corruptFrame(controller = firstController) {
      streams.get(controller)!.forEach((socket) => socket.send('{invalid json'));
    },
    async interrupt(controller = firstController) {
      withheld.add(controller);
      const sockets = [...streams.get(controller)!];
      streams.get(controller)!.clear();
      await Promise.all(sockets.map((socket) => socket.close({ code: 1012, reason: 'Restart' })));
    },
  };
}

async function connect(page: Page, controller = firstController, remember = false) {
  await page.locator('.backend-card').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('控制器地址', { exact: false }).fill(controller);
  await dialog.getByRole('checkbox').setChecked(remember);
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect(page.locator('.resource-panel-footer')).toContainText('连接列表实时更新');
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '打开导航菜单' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
    .click();
}

function row(page: Page, id: string) {
  return page.locator('.connection-row').filter({ hasText: `${id}.example` });
}

async function historyCount(page: Page, count: number) {
  await expect(page.getByRole('tab', { name: /^最近关闭/ })).toHaveText(`最近关闭${count}`);
}

test('records closures while navigating and preserves the last snapshot across socket reconnects', async ({
  page,
}) => {
  const api = await mockConnections(page, [connection('alpha'), connection('beta')]);
  await page.goto('/#/connections');
  await connect(page);
  await expect(page.locator('.connection-row')).toHaveCount(2);
  await historyCount(page, 0);

  api.frame([connection('beta')]);
  await historyCount(page, 1);
  await navigate(page, '概览');
  api.frame(null);
  await expect(
    page.locator('.stat-card').filter({ hasText: '活跃连接' }).locator('.stat-value'),
  ).toHaveText('0个');
  await navigate(page, '连接');
  await historyCount(page, 2);
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'alpha')).toBeVisible();
  await expect(row(page, 'beta')).toBeVisible();

  await page.getByRole('tab', { name: /^活动连接/ }).click();
  api.frame([connection('before-reconnect')]);
  await expect(row(page, 'before-reconnect')).toBeVisible();
  const previousOpened = api.opened.get(firstController)!;
  await api.interrupt();
  await expect(page.locator('.resource-panel-footer')).toContainText('连接采样中断，保留末次快照');
  await expect(row(page, 'before-reconnect')).toBeVisible();
  await expect(row(page, 'before-reconnect').locator('[data-column="download"]')).toContainText(
    '采样中断',
  );
  await expect(page.getByRole('button', { name: '关闭全部', exact: true })).toBeDisabled();
  await historyCount(page, 2);
  await expect.poll(() => api.opened.get(firstController)).toBeGreaterThan(previousOpened);
  api.frame([connection('after-reconnect')]);
  await expect(row(page, 'after-reconnect')).toBeVisible();
  await expect(row(page, 'before-reconnect')).toHaveCount(0);
  await historyCount(page, 2);
  api.frame([]);
  await historyCount(page, 3);
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'after-reconnect')).toBeVisible();
  await expect(row(page, 'before-reconnect')).toHaveCount(0);
  expect(api.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
});

test('freezes active rows, history, counters, duration and rates until resumed; clears history locally', async ({
  page,
}) => {
  await page.clock.setFixedTime(observedAt);
  const api = await mockConnections(page, [connection('alpha'), connection('beta')]);
  await page.goto('/#/connections');
  await connect(page);
  await page.clock.setFixedTime(new Date(observedAt.getTime() + 5_000));
  api.frame([connection('beta', { download: 8_192, upload: 4_096 })]);
  await historyCount(page, 1);
  await expect(row(page, 'beta').locator('[data-column="download"]')).toContainText('8.0 KB');
  await expect(row(page, 'beta').locator('[data-column="download"] .resource-subline')).toHaveText(
    /\/s$/,
  );
  await expect(row(page, 'beta').locator('[data-column="start"]')).toContainText('20 秒');
  await page.getByRole('button', { name: '暂停显示', exact: true }).click();
  const frozenRow = await row(page, 'beta').innerText();
  const frozenStats = await page.locator('.resource-stats').innerText();

  await page.clock.setFixedTime(new Date(observedAt.getTime() + 35_000));
  api.frame([connection('gamma', { download: 65_536 })]);
  await expect(page.locator('.resource-panel-footer')).toContainText('已暂停显示');
  await expect(row(page, 'beta')).toHaveText(frozenRow, { useInnerText: true });
  await expect(page.locator('.resource-stats')).toHaveText(frozenStats, { useInnerText: true });
  await expect(row(page, 'gamma')).toHaveCount(0);
  await historyCount(page, 1);
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'alpha')).toBeVisible();
  await expect(row(page, 'beta')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续显示', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('tab', { name: /^活动连接/ }).click();
  await expect(row(page, 'beta')).toHaveText(frozenRow, { useInnerText: true });
  await page.getByRole('button', { name: '继续显示', exact: true }).click();
  await expect(row(page, 'gamma')).toBeVisible();
  await expect(row(page, 'beta')).toHaveCount(0);
  await historyCount(page, 2);

  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'beta').locator('[data-column="start"]')).toContainText('20 秒');
  await expect(row(page, 'beta').locator('[data-column="download"]')).toContainText('8.0 KB');
  await expect(row(page, 'beta').locator('[data-column="download"]')).toContainText('末次观测');
  await expect(page.locator('.resource-close')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '关闭全部', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '清空本地历史', exact: true }).click();
  await historyCount(page, 0);
  await expect(page.getByText('暂时没有关闭记录', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^活动连接/ }).click();
  await expect(row(page, 'gamma')).toBeVisible();
  expect(api.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
});

test('rejects malformed snapshots without closing rows or bridging the observation gap', async ({
  page,
}) => {
  const api = await mockConnections(page, [connection('before-error')]);
  await page.goto('/#/connections');
  await connect(page);
  api.raw({ uploadTotal: 10_240, downloadTotal: 20_480, connections: [{ id: 'broken' }] });
  await expect(page.locator('.resource-panel-footer')).toContainText('连接数据异常，保留末次快照');
  await expect(row(page, 'before-error')).toBeVisible();
  await historyCount(page, 0);
  await expect(page.getByRole('button', { name: '关闭全部', exact: true })).toBeDisabled();
  api.frame([connection('after-error')]);
  await expect(row(page, 'after-error')).toBeVisible();
  await historyCount(page, 0);
  api.frame(null);
  await historyCount(page, 1);
  api.frame([connection('before-corrupt')]);
  await expect(row(page, 'before-corrupt')).toBeVisible();
  api.corruptFrame();
  await expect(page.locator('.resource-panel-footer')).toContainText('连接数据异常，保留末次快照');
  api.frame([connection('after-corrupt')]);
  await expect(row(page, 'after-corrupt')).toBeVisible();
  await historyCount(page, 1);
  api.frame(null);
  await historyCount(page, 2);
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'after-error')).toBeVisible();
  await expect(row(page, 'after-corrupt')).toBeVisible();
  await expect(row(page, 'before-corrupt')).toHaveCount(0);
  await expect(row(page, 'before-error')).toHaveCount(0);
});

test('restores columns per controller URL and keeps the 390px page and column dialog within the viewport', async ({
  page,
}, testInfo) => {
  const api = await mockConnections(page, [connection('columns')]);
  await page.goto('/#/connections');
  await connect(page, firstController, true);
  await page.getByRole('button', { name: '管理连接列', exact: true }).click();
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: '连接列设置' }) });
  await expect(dialog.getByRole('switch', { name: '显示目标 / 进程', exact: true })).toBeDisabled();
  await dialog.getByRole('switch', { name: '显示协议', exact: true }).click();
  await dialog.getByRole('switch', { name: '显示源地址', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '按协议排序', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '按源地址排序', exact: true })).toBeVisible();
  await page.reload();
  await expect(row(page, 'columns')).toBeVisible();
  await expect(page.getByRole('button', { name: '按协议排序', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '按源地址排序', exact: true })).toBeVisible();

  await connect(page, secondController);
  await expect(page.getByRole('button', { name: '按协议排序', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '按源地址排序', exact: true })).toHaveCount(0);
  await connect(page, `${firstController}/`);
  await expect(page.getByRole('button', { name: '按协议排序', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '按源地址排序', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row(page, 'columns')).toBeVisible();
  await row(page, 'columns').getByRole('button', { name: /^展开/ }).click();
  await expect(page.locator('.connection-detail-row')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '管理连接列', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.getBoundingClientRect().right - window.innerWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  api.frame(null);
  await historyCount(page, 1);
  await page.getByRole('tab', { name: /^最近关闭/ }).click();
  await expect(row(page, 'columns')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath('connections-history-mobile.png'),
    fullPage: true,
  });
});
