import { expect, test, type Page } from '@playwright/test';

const controller = 'http://127.0.0.1:9090/runtime-test';
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
}

interface HeldPatch {
  body: Record<string, unknown>;
  authorization: string | undefined;
  respond: (status?: number, message?: string) => Promise<void>;
}

async function runtimeController(page: Page, initial?: Record<string, unknown>) {
  let config = initial ?? {
    mode: 'rule',
    'mixed-port': 7890,
    port: 7891,
    'socks-port': 7892,
    'redir-port': 0,
    'tproxy-port': 0,
    'allow-lan': false,
    ipv6: false,
    'log-level': 'info',
    'bind-address': '*',
    'interface-name': '',
    'tcp-concurrent': false,
    sniffing: false,
    'find-process-mode': 'strict',
    tun: {
      enable: false,
      stack: 'system',
      device: 'Meta',
      'auto-route': true,
      'auto-detect-interface': false,
      mtu: 9000,
      'dns-hijack': ['any:53'],
    },
  };
  const calls: ApiCall[] = [];
  const sockets: string[] = [];
  const heldPatches: HeldPatch[] = [];
  let ignoreNextPatch = false;
  let holdNextPatch = false;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/runtime-test\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname.slice('/runtime-test'.length);
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    const authorization = request.headers().authorization;
    calls.push({ method: request.method(), path, body, authorization });
    const json = (value: unknown) => route.fulfill({ headers, json: value });
    if (path === '/configs' && request.method() === 'PATCH') {
      const ignored = ignoreNextPatch;
      ignoreNextPatch = false;
      const respond = async (status = 204, message = 'Held patch failed') => {
        if (status >= 400) {
          await route.fulfill({ status, headers, json: { message } });
          return;
        }
        if (!ignored) {
          const patch = body!;
          config = {
            ...config,
            ...patch,
            ...(patch.tun ? { tun: { ...(config.tun as object), ...(patch.tun as object) } } : {}),
          };
        }
        await route.fulfill({ status, headers });
      };
      if (holdNextPatch) {
        holdNextPatch = false;
        heldPatches.push({ body: body!, authorization, respond });
      } else await respond();
    } else if (path === '/configs') await json(config);
    else if (path === '/version') await json({ version: 'runtime-test', meta: true });
    else if (path === '/proxies') await json({ proxies: {} });
    else if (path === '/providers/proxies' || path === '/providers/rules')
      await json({ providers: {} });
    else if (path === '/rules') await json({ rules: [] });
    else await route.fulfill({ status: 404, headers });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/runtime-test\//, (socket) => {
    sockets.push(socket.url());
  });
  await page.addInitScript((url) => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url, secret: '' }));
  }, controller);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '内核设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '配置代理端口', exact: true })).toBeEnabled();
  return {
    calls,
    sockets,
    heldPatches,
    patches: () => calls.filter((call) => call.method === 'PATCH'),
    configReads: () => calls.filter((call) => call.path === '/configs' && call.method === 'GET'),
    changeConfig: (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    },
    ignoreNextPatch: () => {
      ignoreNextPatch = true;
    },
    holdNextPatch: () => {
      holdNextPatch = true;
    },
  };
}

async function openDialog(page: Page, button: string, title: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport;
      }),
    )
    .toBeLessThanOrEqual(1);
}

test('port drafts survive refresh, validate limits and only patch changed ports and interfaces', async ({
  page,
}) => {
  await page.clock.install();
  const mock = await runtimeController(page);
  const dialog = await openDialog(page, '配置代理端口', '代理端口');
  const mixed = dialog.getByRole('spinbutton', { name: '混合代理端口', exact: true });
  for (const invalid of ['', '-1', '1.5', '65536']) {
    await mixed.fill(invalid);
    await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('0 到 65535 之间的整数');
    expect(mock.patches()).toEqual([]);
  }

  await mixed.fill('7898');
  await dialog.getByRole('spinbutton', { name: 'SOCKS 代理端口', exact: true }).fill('0');
  const readsBeforeRefresh = mock.configReads().length;
  mock.changeConfig({ 'mixed-port': 7899, port: 7893 });
  await page.clock.runFor(15_100);
  await expect.poll(() => mock.configReads().length).toBeGreaterThan(readsBeforeRefresh);
  await expect(mixed).toHaveValue('7898');
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.patches().map((call) => call.body)).toEqual([
    { 'mixed-port': 7898, 'socks-port': 0 },
  ]);
  expect(mock.configReads().length).toBeGreaterThan(readsBeforeRefresh + 1);

  await openDialog(page, '配置代理端口', '代理端口');
  await expect(mixed).toHaveValue('7898');
  await expect(dialog.getByRole('spinbutton', { name: 'HTTP 代理端口', exact: true })).toHaveValue(
    '7893',
  );
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await openDialog(page, '配置网络接口', '网络接口');
  await dialog.getByRole('textbox', { name: '监听地址', exact: true }).fill('127.0.0.1');
  await dialog.getByRole('textbox', { name: '出站接口', exact: true }).fill('eth1');
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.patches().at(-1)?.body).toEqual({
    'bind-address': '127.0.0.1',
    'interface-name': 'eth1',
  });
});

test('a successful HTTP response cannot hide a rejected runtime change or discard its draft', async ({
  page,
}) => {
  const mock = await runtimeController(page);
  mock.ignoreNextPatch();
  const dialog = await openDialog(page, '配置代理端口', '代理端口');
  const mixed = dialog.getByRole('spinbutton', { name: '混合代理端口', exact: true });
  await mixed.fill('7900');
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(page.getByText(/配置未生效：mixed-port/)).toBeVisible();
  await expect(page.getByText('内核配置已应用', { exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(mixed).toHaveValue('7900');
  const firstPatch = mock.calls.findIndex((call) => call.method === 'PATCH');
  expect(mock.calls[firstPatch + 1]).toMatchObject({ method: 'GET', path: '/configs' });

  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.patches().map((call) => call.body)).toEqual([
    { 'mixed-port': 7900 },
    { 'mixed-port': 7900 },
  ]);
  await openDialog(page, '配置代理端口', '代理端口');
  await expect(mixed).toHaveValue('7900');
});

test('runtime controls send exact patches and TUN edits preserve enable without copying read-only fields', async ({
  page,
}) => {
  const mock = await runtimeController(page);
  for (const label of ['允许局域网连接', 'IPv6', 'TCP 并发连接', '域名嗅探', 'TUN 模式']) {
    const toggle = page.getByRole('switch', { name: label, exact: true });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
  }
  await page.getByRole('combobox', { name: '进程匹配模式', exact: true }).selectOption('always');
  await expect(page.getByRole('combobox', { name: '进程匹配模式', exact: true })).toHaveValue(
    'always',
  );
  expect(mock.patches().map((call) => call.body)).toEqual([
    { 'allow-lan': true },
    { ipv6: true },
    { 'tcp-concurrent': true },
    { sniffing: true },
    { tun: { enable: true } },
    { 'find-process-mode': 'always' },
  ]);

  const dialog = await openDialog(page, '配置 TUN', 'TUN 设置');
  await dialog.getByRole('combobox', { name: 'TUN 协议栈', exact: true }).selectOption('gvisor');
  await dialog.getByRole('textbox', { name: 'TUN 网卡名称', exact: true }).fill('test-tun');
  await dialog.getByRole('switch', { name: '自动设置路由', exact: true }).click();
  await dialog.getByRole('switch', { name: '自动识别出站接口', exact: true }).click();
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.patches().at(-1)?.body).toEqual({
    tun: {
      enable: true,
      stack: 'gvisor',
      device: 'test-tun',
      'auto-route': false,
      'auto-detect-interface': true,
    },
  });
  await expect(page.getByRole('switch', { name: 'TUN 模式', exact: true })).toBeChecked();
  await openDialog(page, '配置 TUN', 'TUN 设置');
  await expect(dialog.getByRole('combobox', { name: 'TUN 协议栈', exact: true })).toHaveValue(
    'gvisor',
  );
  await expect(dialog.getByRole('switch', { name: '自动设置路由', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: '自动识别出站接口', exact: true })).toBeChecked();
});

test('switching controller sessions releases old locks and old responses cannot unlock the new session', async ({
  page,
}) => {
  const mock = await runtimeController(page);
  const lan = page.getByRole('switch', { name: '允许局域网连接', exact: true });
  const ipv6 = page.getByRole('switch', { name: 'IPv6', exact: true });
  const runtimeSettings = page.locator('.runtime-settings');
  mock.holdNextPatch();
  await lan.click();
  await expect.poll(() => mock.heldPatches.length).toBe(1);
  await expect(ipv6).toBeDisabled();
  expect(mock.heldPatches[0]).toMatchObject({
    authorization: undefined,
    body: { 'allow-lan': true },
  });

  await page.getByRole('button', { name: '更改连接', exact: true }).click();
  const connection = page.getByRole('dialog');
  await connection.getByPlaceholder('输入内核设置的 secret').fill('runtime-session-b');
  await connection.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(connection).toHaveCount(0);
  await expect(lan).toBeEnabled();
  await expect(ipv6).toBeEnabled();
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'false');

  mock.holdNextPatch();
  await ipv6.click();
  await expect.poll(() => mock.heldPatches.length).toBe(2);
  expect(mock.heldPatches[1]).toMatchObject({
    authorization: 'Bearer runtime-session-b',
    body: { ipv6: true },
  });
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'true');
  const oldResponse = page.waitForResponse(
    (response) =>
      response.url() === `${controller}/configs` &&
      response.request().method() === 'PATCH' &&
      response.request().headers().authorization === undefined,
  );
  await mock.heldPatches[0]!.respond(500, 'old-session-patch-error');
  await (await oldResponse).finished();
  // Let the old fetch rejection and its React updates settle while B is still pending.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'true');
  await expect(lan).toBeDisabled();
  await expect(ipv6).toBeDisabled();
  await expect(page.getByText(/old-session-patch-error/)).toHaveCount(0);
  await expect(page.getByText('内核配置已应用', { exact: true })).toHaveCount(0);

  await mock.heldPatches[1]!.respond();
  await expect(ipv6).toBeChecked();
  await expect(ipv6).toBeEnabled();
  await expect(lan).not.toBeChecked();
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('内核配置已应用', { exact: true })).toBeVisible();
  await expect(page.getByText(/old-session-patch-error/)).toHaveCount(0);
});

test('an active config write keeps runtime, reload and maintenance locked after leaving and reopening settings', async ({
  page,
}) => {
  const mock = await runtimeController(page);
  const runtimeSettings = page.locator('.runtime-settings');
  const lan = page.getByRole('switch', { name: '允许局域网连接', exact: true });
  mock.holdNextPatch();
  await lan.click();
  await expect.poll(() => mock.heldPatches.length).toBe(1);
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'true');

  await page.getByRole('link', { name: '概览', exact: true }).click();
  await expect(runtimeSettings).toHaveCount(0);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'true');
  await expect(lan).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'IPv6', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '配置代理端口', exact: true })).toBeDisabled();
  await page.locator('summary').filter({ hasText: '内核维护' }).click();
  const maintenanceActions = ['更新 GEO 数据', '重启内核', '升级内核', '更新托管面板'];
  for (const action of maintenanceActions) {
    await expect(page.getByRole('button', { name: action, exact: true })).toBeDisabled();
  }
  await page.locator('summary').filter({ hasText: '重新加载配置' }).click();
  await page.getByLabel('配置内容', { exact: true }).fill('mixed-port: 7890\nmode: rule');
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeDisabled();

  await mock.heldPatches[0]!.respond();
  await expect(lan).toBeChecked();
  await expect(lan).toBeEnabled();
  await expect(runtimeSettings).toHaveAttribute('aria-busy', 'false');
  for (const action of maintenanceActions) {
    await expect(page.getByRole('button', { name: action, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeEnabled();
  expect(mock.patches().map((call) => call.body)).toEqual([{ 'allow-lan': true }]);
  expect(mock.calls.filter((call) => call.method === 'PUT' || call.method === 'POST')).toEqual([]);
});

test('missing runtime fields stay unknown and narrow demo settings never contact the controller', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const controllerRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).port === '9090') controllerRequests.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).port === '9090') controllerRequests.push(socket.url());
  });
  const mock = await runtimeController(page, {
    mode: 'rule',
    'mixed-port': 7890,
    'allow-lan': false,
    ipv6: false,
    'log-level': 'info',
  });
  await expectNoHorizontalOverflow(page);
  for (const label of ['TCP 并发连接', '域名嗅探', 'TUN 模式']) {
    await expect(page.getByRole('switch', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('combobox', { name: '进程匹配模式', exact: true })).toBeDisabled();
  const dialog = await openDialog(page, '配置代理端口', '代理端口');
  for (const label of ['HTTP 代理端口', 'SOCKS 代理端口', 'Redirect 端口', 'TProxy 端口']) {
    const input = dialog.getByRole('spinbutton', { name: label, exact: true });
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('');
  }
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  const requestsBeforeDemoEdits = mock.calls.length;
  const socketsBeforeDemoEdits = mock.sockets.length;
  const controllerRequestsBeforeDemoEdits = controllerRequests.length;
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await openDialog(page, '配置代理端口', '代理端口');
  await dialog.getByRole('spinbutton', { name: '混合代理端口', exact: true }).fill('8888');
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openDialog(page, '配置 TUN', 'TUN 设置');
  await dialog.getByRole('combobox', { name: 'TUN 协议栈', exact: true }).selectOption('system');
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.clock.runFor(16_000);
  await openDialog(page, '配置代理端口', '代理端口');
  await expect(dialog.getByRole('spinbutton', { name: '混合代理端口', exact: true })).toHaveValue(
    '8888',
  );
  await expectNoHorizontalOverflow(page);
  expect(mock.calls).toHaveLength(requestsBeforeDemoEdits);
  expect(mock.sockets).toHaveLength(socketsBeforeDemoEdits);
  expect(controllerRequests).toHaveLength(controllerRequestsBeforeDemoEdits);
  expect(mock.patches()).toEqual([]);
});
