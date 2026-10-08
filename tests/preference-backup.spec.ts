import { expect, test, type Download, type Page } from '@playwright/test';
import { DEFAULT_HOME_PREFERENCES } from '../src/lib/preferences';
import { defaultProxyPreferences } from '../src/lib/proxy-preferences';

const controllerA = 'http://127.0.0.1:9090/preferences-a';
const controllerB = 'http://127.0.0.1:9090/preferences-b';
const secret = 'backup-private-secret';
const storagePath = '/storage/mihomo-verge.preferences.v1';
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});
const home = {
  ...DEFAULT_HOME_PREFERENCES,
  cards: { ...DEFAULT_HOME_PREFERENCES.cards, memory: false },
  chartStyle: 'line',
  memberSort: 'name',
};
const importedBackup = {
  format: 'mihomo-verge.preferences',
  version: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  source: { controller: controllerA },
  preferences: {
    theme: 'dark',
    home,
    homeGroup: 'Export group',
    homeProvider: 'Export provider',
    closeOnSwitch: true,
    proxies: {
      ...defaultProxyPreferences(),
      sortOrder: 'name',
      density: 'comfortable',
      columns: 4,
      showGroupIcons: false,
      expandedGroups: { 'Export group': true },
    },
    connections: {
      view: 'list',
      columns: ['host', 'network'],
      activeSort: { key: 'download', direction: 'desc' },
      closedSort: { key: 'closedAt', direction: 'desc' },
    },
    logOrder: 'desc',
  },
};

interface ApiCall {
  method: string;
  path: string;
  controller: string;
  authorization: string | undefined;
  body: unknown;
}

async function mockController(
  page: Page,
  options: { controller?: string; seed?: Record<string, string>; remoteValue?: unknown } = {},
) {
  const url = options.controller ?? controllerA;
  const calls: ApiCall[] = [];
  const heldReads: { respond: (value: unknown, status?: number) => Promise<void> }[] = [];
  const heldWrites: { authorization: string | undefined; respond: () => Promise<void> }[] = [];
  let holdNextRead = false;
  let holdNextWrite = false;
  let remoteValue: unknown = options.remoteValue ?? null;
  let storageStatus = 200;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/preferences-[ab]\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const requestUrl = new URL(request.url());
    const prefix = requestUrl.pathname.split('/')[1]!;
    const path = requestUrl.pathname.slice(prefix.length + 1);
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    calls.push({
      method: request.method(),
      path,
      controller: `${requestUrl.origin}/${prefix}`,
      authorization: request.headers().authorization,
      body,
    });
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers, json: value });
    if (path === storagePath && request.method() === 'GET') {
      if (holdNextRead) {
        holdNextRead = false;
        heldReads.push({ respond: json });
      } else if (storageStatus !== 200)
        await json({ message: 'storage unsupported' }, storageStatus);
      else await json(remoteValue);
    } else if (path === storagePath && request.method() === 'PUT') {
      if (storageStatus !== 200) await json({ message: 'storage unsupported' }, storageStatus);
      else {
        const respond = async () => {
          remoteValue = body;
          await route.fulfill({ status: 204, headers });
        };
        if (holdNextWrite) {
          holdNextWrite = false;
          heldWrites.push({ authorization: request.headers().authorization, respond });
        } else await respond();
      }
    } else if (path === storagePath && request.method() === 'DELETE') {
      remoteValue = null;
      await route.fulfill({ status: 204, headers });
    } else if (path === '/version') await json({ version: 'backup-test', meta: true });
    else if (path === '/configs')
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      });
    else if (path === '/proxies')
      await json({
        proxies: {
          'Export group': {
            name: 'Export group',
            type: 'Selector',
            all: ['DIRECT'],
            now: 'DIRECT',
            history: [],
          },
          DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
        },
      });
    else if (path === '/providers/proxies')
      await json({
        providers: {
          'Other provider': {
            name: 'Other provider',
            type: 'Proxy',
            vehicleType: 'HTTP',
            proxies: [],
          },
          'Export provider': {
            name: 'Export provider',
            type: 'Proxy',
            vehicleType: 'HTTP',
            proxies: [],
          },
        },
      });
    else if (path === '/providers/rules') await json({ providers: {} });
    else if (path === '/rules') await json({ rules: [] });
    else await route.fulfill({ status: 404, headers });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/preferences-[ab]\//, () => {});
  await page.addInitScript(
    ({ profile, seed }) => {
      localStorage.setItem('mihomo-verge.backend', JSON.stringify(profile));
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    },
    { profile: { url, secret }, seed: options.seed ?? {} },
  );
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '偏好备份', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存到当前后端', exact: true })).toBeEnabled();
  return {
    calls,
    heldReads,
    heldWrites,
    storageCalls: () => calls.filter((call) => call.path.startsWith('/storage/')),
    holdNextRead: () => {
      holdNextRead = true;
    },
    holdNextWrite: () => {
      holdNextWrite = true;
    },
    setStorageStatus: (status: number) => {
      storageStatus = status;
    },
  };
}

async function readDownload(download: Download) {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let content = '';
  for await (const chunk of stream!) content += String(chunk);
  return { content, value: JSON.parse(content) as typeof importedBackup };
}

async function importFile(page: Page, backup: unknown) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'preferences.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
}

async function storageSnapshot(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
  );
}

test('download exports only the current scope preferences and never connection credentials or arbitrary storage', async ({
  page,
}) => {
  const mock = await mockController(page, {
    seed: {
      'mihomo-verge.theme': 'dark',
      [`mihomo-verge.home-preferences:${controllerA}`]: JSON.stringify(home),
      [`mihomo-verge.home-group:${controllerA}`]: 'Export group',
      [`mihomo-verge.home-provider:${controllerA}`]: 'Export provider',
      [`mihomo-verge.close-on-switch:${controllerA}`]: 'true',
      [`mihomo-verge.log-order:${controllerA}`]: 'desc',
      [`mihomo-verge.proxy-preferences:${controllerA}`]: JSON.stringify(
        importedBackup.preferences.proxies,
      ),
      [`mihomo-verge.home-group:${controllerB}`]: 'other-controller-private-marker',
      'mihomo-verge.profiles': 'yaml-private-marker: secret-config',
      'unknown-backup-key': 'arbitrary-private-marker',
    },
  });
  const pendingDownload = page.waitForEvent('download');
  await page
    .locator('.preference-backup')
    .screenshot({ path: '.verification/preference-backup-desktop.png' });
  await page.getByRole('button', { name: '下载备份', exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const { content, value } = await readDownload(download);
  expect(Object.keys(value).sort()).toEqual([
    'createdAt',
    'format',
    'preferences',
    'source',
    'version',
  ]);
  expect(value).toMatchObject({
    format: 'mihomo-verge.preferences',
    version: 1,
    source: { controller: controllerA },
    preferences: {
      theme: 'dark',
      home,
      homeGroup: 'Export group',
      homeProvider: 'Export provider',
      closeOnSwitch: true,
      logOrder: 'desc',
      proxies: importedBackup.preferences.proxies,
    },
  });
  expect(Number.isFinite(Date.parse(value.createdAt))).toBe(true);
  for (const excluded of [
    secret,
    'yaml-private-marker',
    'other-controller-private-marker',
    'arbitrary-private-marker',
    'mihomo-verge.backend',
  ]) {
    expect(content).not.toContain(excluded);
  }
  expect(mock.storageCalls()).toEqual([]);
});

test('file restore previews without side effects then remaps the source scope and updates the current UI', async ({
  page,
}) => {
  const mock = await mockController(page, {
    controller: controllerB,
    seed: {
      'mihomo-verge.theme': 'light',
      [`mihomo-verge.home-group:${controllerA}`]: 'untouched-source-group',
      [`mihomo-verge.close-on-switch:${controllerB}`]: 'false',
    },
  });
  const before = await storageSnapshot(page);
  await importFile(page, {
    ...importedBackup,
    preferences: { ...importedBackup.preferences, backend: { url: controllerA, secret } },
  });
  await expect(page.getByRole('alert').filter({ hasText: /不支持.*backend/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await storageSnapshot(page)).toEqual(before);
  await importFile(page, importedBackup);
  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: '恢复偏好预览', exact: true })).toBeVisible();
  await expect(preview).toContainText(controllerA);
  await expect(preview).toContainText(controllerB);
  await expect(preview).toContainText('名称排序 · 宽松 · 4 列');
  await expect(preview).toContainText('列表 · 2 列');
  expect(await storageSnapshot(page)).toEqual(before);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(mock.storageCalls()).toEqual([]);

  await preview.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '深色', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const after = await storageSnapshot(page);
  expect(after['mihomo-verge.backend']).toBe(before['mihomo-verge.backend']);
  expect(after[`mihomo-verge.home-group:${controllerA}`]).toBe('untouched-source-group');
  expect(after[`mihomo-verge.home-group:${controllerB}`]).toBe('Export group');
  expect(after[`mihomo-verge.home-provider:${controllerB}`]).toBe('Export provider');
  expect(JSON.parse(after[`mihomo-verge.home-preferences:${controllerB}`]!)).toEqual(home);
  expect(JSON.parse(after[`mihomo-verge.connections:${controllerB}`]!)).toEqual(
    importedBackup.preferences.connections,
  );
  expect(JSON.parse(after[`mihomo-verge.proxy-preferences:${controllerB}`]!)).toEqual(
    importedBackup.preferences.proxies,
  );
  await page.getByRole('link', { name: '代理', exact: true }).click();
  await expect(page.locator('.proxies-page')).toHaveClass(/proxy-density-comfortable/);
  await expect(page.locator('.proxies-page')).toHaveClass(/proxy-columns-4/);
  await expect(page.locator('.proxy-group-icon')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true })).toBeChecked();
  await page.getByRole('link', { name: '概览', exact: true }).click();
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(3);
  await expect(page.locator('.traffic-panel .traffic-chart')).toHaveAttribute(
    'data-chart-style',
    'line',
  );
  await expect(page.getByRole('combobox', { name: '首页代理组', exact: true })).toHaveValue(
    'Export group',
  );
  await expect(page.getByRole('combobox', { name: '首页代理集', exact: true })).toHaveValue(
    'Export provider',
  );
  await page.locator('a[href="#/connections"]').click();
  await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '表格视图', exact: true }).click();
  await page.getByRole('button', { name: '管理连接列', exact: true }).click();
  const columns = page.getByRole('dialog');
  await expect(columns.getByRole('switch', { name: '显示协议', exact: true })).toBeChecked();
  await expect(
    columns.getByRole('switch', { name: '显示下载总量', exact: true }),
  ).not.toBeChecked();
  await columns.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('link', { name: '日志', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '日志顺序', exact: true })).toHaveValue('desc');
  expect(mock.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('remote backup uses its one storage key and unsupported storage is reported honestly', async ({
  page,
}) => {
  const mock = await mockController(page, { seed: { 'mihomo-verge.theme': 'dark' } });
  await page.getByRole('button', { name: '保存到当前后端', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(
    confirmation.getByRole('heading', { name: '保存偏好到后端？', exact: true }),
  ).toBeVisible();
  await expect(confirmation).toContainText(controllerA);
  expect(mock.storageCalls()).toEqual([]);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.storageCalls()).toEqual([]);
  await page.getByRole('button', { name: '保存到当前后端', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect
    .poll(() => mock.storageCalls().filter((call) => call.method === 'PUT').length)
    .toBe(1);
  await expect(page.getByRole('button', { name: '从后端读取', exact: true })).toBeEnabled();
  const put = mock.storageCalls()[0]!;
  expect(put).toMatchObject({
    path: storagePath,
    controller: controllerA,
    authorization: `Bearer ${secret}`,
    body: { format: 'mihomo-verge.preferences', source: { controller: controllerA } },
  });
  expect(JSON.stringify(put.body)).not.toContain(secret);
  const beforeRead = await storageSnapshot(page);
  await page.getByRole('button', { name: '从后端读取', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: '恢复偏好预览', exact: true })).toBeVisible();
  expect(await storageSnapshot(page)).toEqual(beforeRead);
  await preview.getByRole('button', { name: '关闭弹窗', exact: true }).click();

  await page.getByRole('button', { name: '删除后端备份', exact: true }).click();
  await expect(
    confirmation.getByRole('heading', { name: '删除后端备份？', exact: true }),
  ).toBeVisible();
  await expect(confirmation).toContainText(controllerA);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.storageCalls()).toHaveLength(2);
  await page.getByRole('button', { name: '删除后端备份', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(mock.storageCalls().at(-1)).toMatchObject({
    method: 'DELETE',
    path: storagePath,
    body: null,
  });
  expect(await storageSnapshot(page)).toEqual(beforeRead);

  mock.setStorageStatus(404);
  await page.getByRole('button', { name: '从后端读取', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /404|不支持/ })).toBeVisible();
  await expect(preview).toHaveCount(0);
  expect(await storageSnapshot(page)).toEqual(beforeRead);
  expect(mock.storageCalls().map((call) => [call.method, call.path])).toEqual([
    ['PUT', storagePath],
    ['GET', storagePath],
    ['DELETE', storagePath],
    ['GET', storagePath],
  ]);
});

test('demo backup and restore stay local while remote actions remain unavailable', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controllerRequests: string[] = [];
  const ui = new URL(baseURL!);
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== ui.origin) controllerRequests.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).host !== ui.host) controllerRequests.push(socket.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存到当前后端', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '从后端读取', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除后端备份', exact: true })).toBeDisabled();
  await page
    .locator('.preference-backup')
    .screenshot({ path: '.verification/preference-backup-mobile.png' });
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载备份', exact: true }).click();
  expect((await readDownload(await pendingDownload)).value.source).toEqual({ controller: 'demo' });
  await importFile(page, importedBackup);
  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: '恢复偏好预览', exact: true })).toBeVisible();
  await preview.screenshot({ path: '.verification/preference-backup-preview-mobile.png' });
  expect(
    await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await preview.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(preview).toHaveCount(0);
  const stored = await storageSnapshot(page);
  expect(stored['mihomo-verge.home-group:demo']).toBe('Export group');
  expect(stored[`mihomo-verge.home-group:${controllerA}`]).toBeUndefined();
  expect(stored['mihomo-verge.backend']).toBeUndefined();
  expect(controllerRequests).toEqual([]);
});

test('a held remote read prevents duplicate reads and cannot open a preview in a newer session', async ({
  page,
}) => {
  const mock = await mockController(page);
  mock.holdNextRead();
  const read = page.getByRole('button', { name: /从后端读取|正在读取/ });
  await read.dblclick();
  await expect.poll(() => mock.heldReads.length).toBe(1);
  await expect(read).toBeDisabled();
  expect(mock.storageCalls()).toHaveLength(1);
  await page.getByRole('button', { name: '更改连接', exact: true }).click();
  const connection = page.getByRole('dialog');
  await connection.getByPlaceholder('输入内核设置的 secret').fill('new-backup-session');
  await connection.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(connection).toHaveCount(0);
  await expect(read).toBeEnabled();
  const beforeResponse = await storageSnapshot(page);
  await mock.heldReads[0]!.respond(importedBackup).catch(() => {});
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(read).toBeEnabled();
  expect(await storageSnapshot(page)).toEqual(beforeResponse);
  expect(mock.storageCalls()).toHaveLength(1);
});

test('remote writes retain their lock across routes and remain isolated from a new client session', async ({
  page,
}) => {
  const mock = await mockController(page);
  const section = page.locator('.preference-backup');
  const save = page.getByRole('button', { name: '保存到当前后端', exact: true });
  const read = page.getByRole('button', { name: /从后端读取|正在读取/ });
  const remove = page.getByRole('button', { name: '删除后端备份', exact: true });
  const dialog = page.getByRole('dialog');
  mock.holdNextWrite();
  await save.click();
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect.poll(() => mock.heldWrites.length).toBe(1);
  // Hash navigation also works while a confirmation dialog is waiting for the server.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(section).toHaveCount(0);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(section).toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeDisabled();
  await expect(read).toBeDisabled();
  await expect(remove).toBeDisabled();
  expect(mock.storageCalls()).toHaveLength(1);

  await page.getByRole('button', { name: '更改连接', exact: true }).click();
  await dialog.getByPlaceholder('输入内核设置的 secret').fill('new-write-session');
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeEnabled();
  await expect(read).toBeEnabled();
  await expect(remove).toBeEnabled();
  mock.holdNextWrite();
  await save.click();
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect.poll(() => mock.heldWrites.length).toBe(2);
  expect(mock.heldWrites[0]!.authorization).toBe(`Bearer ${secret}`);
  expect(mock.heldWrites[1]!.authorization).toBe('Bearer new-write-session');
  await mock.heldWrites[0]!.respond();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(section).toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeDisabled();
  await expect(read).toBeDisabled();
  await expect(remove).toBeDisabled();
  await expect(page.getByText('已保存到当前后端', { exact: true })).toHaveCount(0);

  await mock.heldWrites[1]!.respond();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeEnabled();
  await expect(read).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(section).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('已保存到当前后端', { exact: true })).toBeVisible();
  expect(mock.storageCalls().map((call) => call.method)).toEqual(['PUT', 'PUT']);
});
