import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const controller = 'http://127.0.0.1:9090/control';
const otherController = 'http://127.0.0.1:9090/other';
const browserErrors = new WeakMap<Page, string[]>();

interface StreamLog {
  type: string;
  payload: string;
  time?: string;
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

async function mockLogsController(page: Page) {
  const calls: Array<{ method: string; path: string }> = [];
  const controls = { failVersion: false };
  const streams = new Map<string, Set<WebSocketRoute>>();
  const snapshot = { uploadTotal: 0, downloadTotal: 0, connections: [] };
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/(control|other)\//, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const path = new URL(route.request().url()).pathname.replace(/^\/(control|other)/, '');
    calls.push({ method: route.request().method(), path });
    if (path === '/version' && controls.failVersion) {
      await route.fulfill({
        status: 503,
        headers,
        json: { message: 'Controller temporarily unavailable' },
      });
      return;
    }
    const responses: Record<string, unknown> = {
      '/version': { version: 'v1.19.15', meta: true },
      '/configs': { mode: 'rule', 'mixed-port': 7890, 'log-level': 'debug' },
      '/proxies': { proxies: {} },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
      '/connections': snapshot,
    };
    await route.fulfill({
      status: path in responses ? 200 : 404,
      headers,
      json: responses[path] ?? { message: `Unmocked API: ${path}` },
    });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/(control|other)\//, (socket) => {
    const url = new URL(socket.url());
    const channel = url.pathname.split('/').pop()!;
    if (channel === 'logs') {
      const scope = `http://${url.host}${url.pathname.slice(0, -'/logs'.length)}`;
      const group = streams.get(scope) ?? new Set<WebSocketRoute>();
      group.add(socket);
      streams.set(scope, group);
      socket.onClose(() => group.delete(socket));
      return;
    }
    const messages: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 0, oslimit: 0 },
      connections: snapshot,
    };
    if (channel in messages) socket.send(JSON.stringify(messages[channel]));
  });
  return {
    calls,
    controls,
    async send(logs: StreamLog[], scope = controller) {
      await expect.poll(() => streams.get(scope)?.size ?? 0).toBe(1);
      for (const log of logs) {
        for (const socket of streams.get(scope)!) socket.send(JSON.stringify(log));
      }
    },
  };
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

async function openLogs(page: Page) {
  await page.goto('/#/logs');
  await connect(page);
  await expect(page.getByRole('heading', { name: '日志', exact: true })).toBeVisible();
}

function receivedLogs(start: number, count: number): StreamLog[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'info',
    payload: `received-${start + index}`,
    // The UI must order by receipt, even when server timestamps run backwards.
    time: new Date(Date.UTC(2026, 0, 1) - (start + index) * 1000).toISOString(),
  }));
}

async function distanceFromLatest(page: Page, order: 'asc' | 'desc') {
  return page.locator('.log-list').evaluate((element, direction) => {
    return direction === 'desc'
      ? element.scrollTop
      : element.scrollHeight - element.clientHeight - element.scrollTop;
  }, order);
}

async function exportText(page: Page) {
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出匹配日志', exact: true }).click();
  const download = await downloadReady;
  expect(download.url()).toMatch(/^blob:/);
  const file = await download.path();
  expect(file).not.toBeNull();
  return readFile(file!, 'utf8');
}

test('filtered Blob exports preserve frozen and disconnected caches beyond the 500 visible rows', async ({
  page,
}) => {
  const api = await mockLogsController(page);
  await page.clock.install();
  await openLogs(page);
  const input = Array.from({ length: 1205 }, (_, index) => ({
    type: index % 10 === 9 ? 'debug' : 'info',
    payload: index % 10 === 8 ? `noise-${index}` : `retained-${index}`,
  }));
  await api.send(input);
  const payloads = page.locator('.log-row .log-payload');
  await expect(payloads.last()).toHaveText('retained-1204');
  await page.getByPlaceholder('搜索日志内容…').fill('retained-');
  await page.getByRole('combobox', { name: '日志级别', exact: true }).selectOption('info');
  const expected = input
    .slice(-1000)
    .filter((log) => log.type === 'info' && log.payload.startsWith('retained-'));
  await expect(payloads).toHaveCount(500);
  await expect(payloads.first()).toHaveText(expected.at(-500)!.payload);
  await page.getByRole('button', { name: '暂停显示', exact: true }).click();
  await api.send([{ type: 'info', payload: 'retained-after-pause' }]);

  const text = await exportText(page);
  expect(text.match(/retained-\d+/g)).toEqual(expected.map((log) => log.payload));
  expect(expected.length).toBeGreaterThan(500);
  expect(text).not.toContain('noise-');
  expect(text).not.toContain('retained-after-pause');
  await expect(payloads.last()).toHaveText('retained-1204');

  api.controls.failVersion = true;
  await page.clock.fastForward(15_000);
  await expect(page.locator('.logs-page')).toContainText('连接中断');
  await expect(payloads).toHaveCount(500);
  await expect(payloads.last()).toHaveText('retained-1204');
  await page.getByRole('button', { name: '继续显示', exact: true }).click();
  await expect(payloads.last()).toHaveText('retained-after-pause');
  const disconnectedText = await exportText(page);
  const retained = [...input, { type: 'info', payload: 'retained-after-pause' }]
    .slice(-1000)
    .filter((log) => log.type === 'info' && log.payload.startsWith('retained-'));
  expect(disconnectedText.match(/retained-(?:\d+|after-pause)/g)).toEqual(
    retained.map((log) => log.payload),
  );
  await page.getByRole('button', { name: '清空日志', exact: true }).click();
  await expect(payloads).toHaveCount(0);
  await expect(page.getByRole('button', { name: '清空日志', exact: true })).toBeDisabled();
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('receipt order keeps the latest 500, is remembered per controller, and following resumes at the correct edge', async ({
  page,
}) => {
  const api = await mockLogsController(page);
  await openLogs(page);
  await api.send(receivedLogs(0, 610));
  const payloads = page.locator('.log-row .log-payload');
  const order = page.getByRole('combobox', { name: '日志顺序', exact: true });
  const follow = page.getByRole('checkbox', { name: '跟随最新', exact: true });
  await expect(payloads).toHaveCount(500);
  await expect(payloads.first()).toHaveText('received-110');
  await expect(payloads.last()).toHaveText('received-609');
  await expect(order).toHaveValue('asc');
  await expect(follow).toBeChecked();
  await expect.poll(() => distanceFromLatest(page, 'asc')).toBeLessThanOrEqual(2);

  await order.selectOption('desc');
  await expect(payloads.first()).toHaveText('received-609');
  await expect(payloads.last()).toHaveText('received-110');
  await expect.poll(() => distanceFromLatest(page, 'desc')).toBeLessThanOrEqual(2);
  await api.send(receivedLogs(610, 1));
  await expect(payloads.first()).toHaveText('received-610');
  await expect(follow).toBeChecked();
  await expect.poll(() => distanceFromLatest(page, 'desc')).toBeLessThanOrEqual(2);

  await page.locator('.log-list').hover();
  await page.mouse.wheel(0, 450);
  await expect(follow).not.toBeChecked();
  await api.send(receivedLogs(611, 1));
  await expect(payloads.first()).toHaveText('received-611');
  expect(await distanceFromLatest(page, 'desc')).toBeGreaterThan(100);
  await follow.check();
  await expect.poll(() => distanceFromLatest(page, 'desc')).toBeLessThanOrEqual(2);

  await order.selectOption('asc');
  await expect(payloads.first()).toHaveText('received-112');
  await expect(payloads.last()).toHaveText('received-611');
  await expect.poll(() => distanceFromLatest(page, 'asc')).toBeLessThanOrEqual(2);
  await page.locator('.log-list').hover();
  await page.mouse.wheel(0, -450);
  await expect(follow).not.toBeChecked();
  await api.send(receivedLogs(612, 1));
  await expect(payloads.last()).toHaveText('received-612');
  expect(await distanceFromLatest(page, 'asc')).toBeGreaterThan(100);
  await follow.check();
  await expect.poll(() => distanceFromLatest(page, 'asc')).toBeLessThanOrEqual(2);

  await order.selectOption('desc');
  await connect(page, otherController);
  await expect(order).toHaveValue('asc');
  await connect(page, controller);
  await expect(order).toHaveValue('desc');
  await page.reload();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect(order).toHaveValue('desc');
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('single and selected log copies preserve their content and clipboard rejection shows an error', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { writes: [] as string[], reject: false };
    Object.assign(window, { logClipboardTest: state });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (state.reject)
            throw new DOMException('Clipboard permission denied', 'NotAllowedError');
          state.writes.push(text);
        },
      },
    });
  });
  const clipboardState = () =>
    page.evaluate(
      () =>
        (window as unknown as { logClipboardTest: { writes: string[] } }).logClipboardTest.writes,
    );
  const api = await mockLogsController(page);
  await openLogs(page);
  await api.send([
    { type: 'info', payload: 'clipboard-first 你好' },
    { type: 'error', payload: 'clipboard-unselected' },
    {
      type: 'warning',
      payload: `clipboard-third GET https://example.com/path?trace=${'abcdef0123456789'.repeat(20)}`,
    },
  ]);
  const rows = page.locator('.log-row');
  await expect(rows).toHaveCount(3);
  await rows.first().getByRole('button', { name: '复制此条日志', exact: true }).click();
  await expect.poll(async () => (await clipboardState()).length).toBe(1);
  expect((await clipboardState())[0]).toContain('clipboard-first 你好');
  await expect(page.locator('.toast').filter({ hasText: /已复制/ })).toBeVisible();

  await rows.first().getByRole('checkbox', { name: '选择此条日志', exact: true }).check();
  await rows.last().getByRole('checkbox', { name: '选择此条日志', exact: true }).check();
  await page.getByRole('button', { name: /^复制选中日志/ }).click();
  await expect.poll(async () => (await clipboardState()).length).toBe(2);
  const selected = (await clipboardState())[1]!;
  expect(selected).toContain('clipboard-first 你好');
  expect(selected).toContain('clipboard-third');
  expect(selected).not.toContain('clipboard-unselected');

  await page.evaluate(() => {
    (window as unknown as { logClipboardTest: { reject: boolean } }).logClipboardTest.reject = true;
  });
  await rows.last().getByRole('button', { name: '复制此条日志', exact: true }).click();
  await expect(
    page
      .locator('.toast')
      .filter({ hasText: /复制.*失败|无法.*剪贴板|剪贴板.*(拒绝|失败|禁止|权限)/ }),
  ).toBeVisible();
  expect(await clipboardState()).toHaveLength(2);
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);

  while (await page.getByRole('button', { name: '关闭通知', exact: true }).count()) {
    await page.getByRole('button', { name: '关闭通知', exact: true }).first().click();
  }
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => page.locator('.log-list').evaluate((list) => list.scrollWidth - list.clientWidth))
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `.verification/logs-${name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});
