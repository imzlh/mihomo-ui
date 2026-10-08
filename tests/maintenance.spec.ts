import { expect, test, type Locator, type Page } from '@playwright/test';

const controller = 'http://127.0.0.1:9090/control%20plane';
const otherController = 'http://127.0.0.1:9091/other%20control';
const secret = 'maintenance /?& secret';
const actions = ['重启内核', '更新 GEO 数据', '升级内核', '更新托管面板'] as const;
const browserErrors = new WeakMap<Page, string[]>();

interface MaintenanceCall {
  controller: string;
  method: string;
  path: string;
  query: string;
  body: string | null;
  authorization: string | undefined;
}

interface ResponsePlan {
  gate?: Promise<void>;
  status?: number;
  message?: string;
  abort?: boolean;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function mockMaintenance(
  page: Page,
  plan: (call: MaintenanceCall) => ResponsePlan = () => ({}),
) {
  const calls: MaintenanceCall[] = [];
  const settled: MaintenanceCall[] = [];
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:909[01]\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const url = new URL(request.url());
    const base = url.port === '9090' ? controller : otherController;
    const path = url.pathname.slice(new URL(base).pathname.length);
    if (request.headers().authorization !== `Bearer ${secret}`) {
      await route.fulfill({ status: 401, headers, json: { message: 'Unauthorized' } });
      return;
    }
    if (['/restart', '/configs/geo', '/upgrade', '/upgrade/ui'].includes(path)) {
      const call = {
        controller: base,
        method: request.method(),
        path,
        query: url.search,
        body: request.postData(),
        authorization: request.headers().authorization,
      };
      calls.push(call);
      const response = plan(call);
      await response.gate;
      if (response.abort) await route.abort('connectionreset');
      else if (response.status && response.status >= 400) {
        await route.fulfill({
          status: response.status,
          headers,
          json: { message: response.message },
        });
      } else await route.fulfill({ status: 204, headers });
      settled.push(call);
      return;
    }
    const values: Record<string, unknown> = {
      '/version': { version: 'v1.19.15', meta: true },
      '/configs': {
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      },
      '/proxies': { proxies: {} },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
    };
    if (path in values) await route.fulfill({ headers, json: values[path] });
    else {
      await route.fulfill({
        status: 404,
        headers,
        json: { message: `Unmocked maintenance API: ${request.method()} ${path}` },
      });
    }
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:909[01]\//, (socket) => {
    const path = new URL(socket.url()).pathname.split('/').at(-1)!;
    const values: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 4096 },
      connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (path in values) socket.send(JSON.stringify(values[path]));
  });
  return { calls, settled };
}

async function openSettings(page: Page) {
  await page.addInitScript(
    (profile) => localStorage.setItem('mihomo-verge.backend', JSON.stringify(profile)),
    { url: controller, secret },
  );
  await page.goto('/#/settings');
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  return openMaintenance(page);
}

async function openMaintenance(page: Page) {
  const section = page.locator('details').filter({ hasText: '内核维护' });
  if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
  return section;
}

async function confirmAction(
  page: Page,
  section: Locator,
  action: (typeof actions)[number],
  options: { channel?: 'auto' | 'release' | 'alpha'; force?: boolean } = {},
) {
  await section.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(controller);
  if (options.channel)
    await dialog.getByRole('combobox', { name: /^升级通道/ }).selectOption(options.channel);
  if (options.force !== undefined) {
    await dialog.getByRole('checkbox', { name: '强制升级', exact: true }).setChecked(options.force);
  }
  return dialog;
}

async function connectFromSettings(page: Page, target: string) {
  await page.getByRole('button', { name: /^(更改连接|连接后端)$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('控制器地址', { exact: false }).fill(target);
  await dialog.getByPlaceholder('输入内核设置的 secret').fill(secret);
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.settings-backend-address')).toHaveText(target);
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

test('maintenance confirms the target, locks repeated submissions and sends standard bodyless requests', async ({
  page,
}) => {
  const geo = gate();
  const api = await mockMaintenance(page, (call) =>
    call.path === '/configs/geo' ? { gate: geo.promise } : {},
  );
  const section = await openSettings(page);
  const canceled = await confirmAction(page, section, '重启内核');
  await canceled.getByRole('button', { name: '取消', exact: true }).click();
  await expect(canceled).not.toBeVisible();
  expect(api.calls).toEqual([]);

  const dialog = await confirmAction(page, section, '更新 GEO 数据');
  await dialog.getByRole('button', { name: '确认执行', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => api.calls.length).toBe(1);
  await expect(dialog).not.toBeVisible();
  for (const button of await section.locator('.maintenance-actions button').all()) {
    await expect(button).toBeDisabled();
  }
  geo.release();
  await expect(section.getByRole('status')).toContainText('GEO');
  await expect(section.getByRole('status')).toContainText('已更新');

  for (const action of ['重启内核', '更新托管面板', '升级内核'] as const) {
    const confirmation = await confirmAction(page, section, action);
    await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(section.getByRole('status')).toContainText(
      action === '更新托管面板' ? '已更新' : '内核已接受',
    );
    if (action !== '更新托管面板') {
      await expect(section.getByRole('status')).toContainText('重新连接后');
    }
  }
  for (const channel of ['release', 'alpha'] as const) {
    const confirmation = await confirmAction(page, section, '升级内核', { channel, force: true });
    await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(section.getByRole('status')).toContainText('内核已接受');
  }
  expect(api.calls.map(({ path, query }) => [path, query])).toEqual([
    ['/configs/geo', ''],
    ['/restart', ''],
    ['/upgrade/ui', ''],
    ['/upgrade', ''],
    ['/upgrade', '?channel=release&force=true'],
    ['/upgrade', '?channel=alpha&force=true'],
  ]);
  expect(api.calls.every((call) => call.method === 'POST' && call.body === null)).toBe(true);
  expect(api.calls.every((call) => call.controller === controller)).toBe(true);
  expect(api.calls.every((call) => call.authorization === `Bearer ${secret}`)).toBe(true);
});

test('maintenance preserves unsupported and backend failures without replaying uncertain requests', async ({
  page,
}) => {
  const api = await mockMaintenance(page, (call) =>
    call.path === '/configs/geo'
      ? { status: 404, message: 'Geo update unavailable' }
      : call.path === '/upgrade/ui'
        ? { status: 500, message: 'Panel archive checksum mismatch' }
        : { abort: true },
  );
  const section = await openSettings(page);
  for (const [action, error] of [
    ['更新 GEO 数据', '接口不存在'],
    ['更新托管面板', 'Panel archive checksum mismatch'],
    ['重启内核', '未收到内核确认'],
  ] as const) {
    const dialog = await confirmAction(page, section, action);
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(section.getByRole('alert')).toContainText(error);
    await expect(section.getByRole('status')).toHaveCount(0);
    await expect(section.getByRole('button', { name: action, exact: true })).toBeEnabled();
  }
  await page.clock.install();
  await page.clock.fastForward(60_000);
  expect(api.calls.map((call) => call.path)).toEqual(['/configs/geo', '/upgrade/ui', '/restart']);
  await expect(section.getByRole('alert')).toContainText('未收到内核确认');
});

test('demo disables maintenance and an old controller completion cannot overwrite the new controller', async ({
  page,
}) => {
  const oldRequest = gate();
  const api = await mockMaintenance(page, (call) =>
    call.controller === controller
      ? { gate: oldRequest.promise, status: 500, message: 'Old controller maintenance failed' }
      : {},
  );
  await page.goto('/');
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '设置', exact: true })
    .click();
  let section = await openMaintenance(page);
  for (const action of actions) {
    await expect(section.getByRole('button', { name: action, exact: true })).toBeDisabled();
  }
  expect(api.calls).toEqual([]);
  await connectFromSettings(page, controller);
  section = await openMaintenance(page);
  const dialog = await confirmAction(page, section, '更新 GEO 数据');
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => api.calls.length).toBe(1);

  const navigation = page.getByRole('navigation', { name: '主导航' });
  await navigation.getByRole('link', { name: '概览', exact: true }).click();
  await navigation.getByRole('link', { name: '设置', exact: true }).click();
  section = await openMaintenance(page);
  await expect(
    section.locator('.maintenance-row').filter({ hasText: '更新 GEO 数据' }).getByRole('button'),
  ).toBeDisabled();
  await connectFromSettings(page, otherController);
  section = await openMaintenance(page);
  await expect(section.getByRole('button', { name: '更新 GEO 数据', exact: true })).toBeEnabled();
  oldRequest.release();
  await expect.poll(() => api.settled.length).toBe(1);
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('Old controller maintenance failed', { exact: false })).toHaveCount(
    0,
  );

  await section.getByRole('button', { name: '更新 GEO 数据', exact: true }).click();
  const currentDialog = page.getByRole('dialog');
  await expect(currentDialog).toContainText(otherController);
  await currentDialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('已更新');
  expect(api.calls.map((call) => call.controller)).toEqual([controller, otherController]);
});
