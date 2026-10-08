import { expect, test, type Page } from '@playwright/test';
import type { ConnectionsResponse, MihomoConfig, ProxyNode, Rule } from '../src/lib/types';

const controller = 'http://127.0.0.1:9090/control';
const secret = 'browser-test /?&';
const storageKey = 'mihomo-verge.backend';
const groupName = '出口 / 选择 #1';
const autoGroupName = 'Auto / Tokyo';
const providerName = 'Remote / 远端';
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
  authorization: string | undefined;
  body: unknown;
}

/** Stateful standard controller responses exercise the browser/API boundary. */
async function mockController(
  page: Page,
  options: {
    idle?: boolean;
    providerOnly?: boolean;
    versionGate?: Promise<void>;
    dnsGate?: Promise<void>;
    ignoreTunPatch?: boolean;
    connectionChains?: Record<string, string[]>;
    rejectSelection?: boolean;
    rejectCloseIds?: string[];
  } = {},
) {
  const calls: ApiCall[] = [];
  const sockets: URL[] = [];
  const requestUrls: URL[] = [];
  const connectionStreams = new Set<(snapshot: ConnectionsResponse) => void>();
  const snapshot: ConnectionsResponse = {
    uploadTotal: 1048576,
    downloadTotal: 8388608,
    connections: options.idle
      ? null
      : Object.entries(
          options.connectionChains ?? { 'browser-connection': ['Tokyo A', groupName] },
        ).map(([id, chains]) => ({
          id,
          chains,
          upload: 1024,
          download: 2048,
          start: '2026-10-07T06:00:00Z',
          rule: 'Match',
          rulePayload: '',
          metadata: {
            network: 'tcp',
            type: 'Mixed',
            host: 'browser-smoke.example',
            sourceIP: '127.0.0.1',
            sourcePort: 51800,
            destinationIP: '203.0.113.10',
            destinationPort: 443,
            process: 'Chrome',
          },
        })),
  };
  let config: MihomoConfig = {
    mode: 'rule',
    'mixed-port': 7890,
    'allow-lan': false,
    ipv6: false,
    'log-level': 'info',
    tun: { enable: false, stack: 'mixed' },
  };
  const node = (name: string, delay: number): ProxyNode => ({
    name,
    type: 'Shadowsocks',
    udp: true,
    alive: true,
    history: [{ time: '2026-10-07T06:00:00Z', delay }],
  });
  const proxies: Record<string, ProxyNode> = {
    GLOBAL: {
      name: 'GLOBAL',
      type: 'Selector',
      all: [groupName, 'DIRECT'],
      now: groupName,
      history: [],
    },
    [groupName]: {
      name: groupName,
      type: 'Selector',
      all: ['Tokyo A', 'Tokyo B', 'DIRECT'],
      now: 'Tokyo A',
      history: [],
    },
    'Tokyo A': node('Tokyo A', 32),
    'Tokyo B': node('Tokyo B', 67),
    DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
  };
  const providers = options.providerOnly
    ? {
        [providerName]: {
          name: providerName,
          type: 'Proxy',
          vehicleType: 'HTTP',
          proxies: [proxies['Tokyo B']!],
        },
      }
    : {};
  if (options.providerOnly) {
    delete proxies['Tokyo B'];
    proxies[autoGroupName] = {
      name: autoGroupName,
      type: 'URLTest',
      all: ['Tokyo A', 'Tokyo B'],
      now: 'Tokyo A',
      history: [],
      hidden: true,
      testUrl: 'https://example.com/check?sample=1',
      expectedStatus: '204',
    };
  }
  const rules: Rule[] = [
    { type: 'DomainSuffix', payload: 'zulu.example', proxy: groupName, extra: { disabled: false } },
    { type: 'DomainSuffix', payload: 'alpha.example', proxy: 'DIRECT', extra: { disabled: false } },
    { type: 'Match', payload: '', proxy: groupName, extra: { disabled: false } },
  ];
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/control\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const url = new URL(request.url());
    requestUrls.push(url);
    const path = url.pathname.slice('/control'.length);
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    calls.push({
      method: request.method(),
      path,
      authorization: request.headers().authorization,
      body,
    });
    const json = async (value: unknown, status = 200) =>
      route.fulfill({ status, headers, json: value });
    if (request.headers().authorization !== `Bearer ${secret}`) {
      await json({ message: 'Unauthorized' }, 401);
      return;
    }
    if (path === '/version') {
      await options.versionGate;
      await json({ version: 'v1.19.15', meta: true });
    } else if (path === '/configs' && request.method() === 'PATCH') {
      const patch = body as Partial<MihomoConfig>;
      config = {
        ...config,
        ...patch,
        ...(options.ignoreTunPatch && patch.tun ? { tun: config.tun } : {}),
      };
      await route.fulfill({ status: 204, headers });
    } else if (path === '/configs') await json(config);
    else if (path === '/proxies') await json({ proxies });
    else if (path.startsWith('/proxies/') && ['PUT', 'DELETE'].includes(request.method())) {
      const group = proxies[decodeURIComponent(path.slice('/proxies/'.length))]!;
      if (request.method() === 'PUT' && options.rejectSelection) {
        await json({ message: 'Proxy selection rejected' }, 400);
        return;
      }
      if (request.method() === 'DELETE') delete group.fixed;
      else {
        group.now = (body as { name: string }).name;
        if (group.type === 'URLTest') group.fixed = group.now;
      }
      await route.fulfill({ status: 204, headers });
    } else if (path.startsWith('/proxies/') && request.method() === 'GET') {
      const proxy = proxies[decodeURIComponent(path.slice('/proxies/'.length))];
      if (proxy) await json(proxy);
      else await json({ message: 'Proxy not found' }, 404);
    } else if (path === '/connections' && request.method() === 'GET') {
      await json(snapshot);
    } else if (path.startsWith('/connections/') && request.method() === 'DELETE') {
      const id = decodeURIComponent(path.slice('/connections/'.length));
      if (options.rejectCloseIds?.includes(id)) {
        await json({ message: 'Connection close rejected' }, 500);
        return;
      }
      snapshot.connections = (snapshot.connections ?? []).filter((item) => item.id !== id);
      await route.fulfill({ status: 204, headers });
      connectionStreams.forEach((send) => send(snapshot));
    } else if (
      path ===
      `/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent('Tokyo B')}/healthcheck`
    ) {
      await json({ delay: 42 });
    } else if (path === `/group/${encodeURIComponent(autoGroupName)}/delay`) {
      delete proxies[autoGroupName]!.fixed;
      await json({ 'Tokyo A': 32, 'Tokyo B': 42 });
    } else if (path === '/providers/proxies') await json({ providers });
    else if (path === '/providers/rules') await json({ providers: {} });
    else if (path === '/rules') await json({ rules });
    else if (path === '/rules/disable' && request.method() === 'PATCH') {
      for (const [index, disabled] of Object.entries(body as Record<string, boolean>)) {
        const rule = rules[Number(index)];
        if (rule) rule.extra = { ...rule.extra, disabled };
      }
      await route.fulfill({ status: 204, headers });
    } else if (path === '/dns/query') {
      if (url.searchParams.get('name') === 'disabled.example')
        await json({ message: 'DNS section is disabled' }, 400);
      else if (url.searchParams.get('name') === 'missing.example')
        await json({ Status: 3, Answer: null });
      else {
        if (url.searchParams.get('name') === 'slow.example') await options.dnsGate;
        await json({
          Status: 0,
          Answer: [
            { name: 'example.com.', type: 1, TTL: 300, data: '203.0.113.10' },
            { name: 'example.com.', type: 1, TTL: 60, data: '203.0.113.20' },
          ],
        });
      }
    } else if (
      ['/cache/dns/flush', '/cache/fakeip/flush'].includes(path) &&
      request.method() === 'POST'
    ) {
      await route.fulfill({ status: 204, headers });
    } else await json({ message: `Unmocked API: ${request.method()} ${path}` }, 404);
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/control\//, (socket) => {
    const url = new URL(socket.url());
    sockets.push(url);
    const messages: Record<string, unknown> = {
      traffic: { up: 524288, down: 2097152 },
      memory: { inuse: 67108864, oslimit: 0 },
      connections: snapshot,
      logs: { type: 'info', payload: 'Browser WebSocket verification message' },
    };
    const message = messages[url.pathname.split('/').pop()!];
    if (message) socket.send(JSON.stringify(message));
    if (url.pathname.endsWith('/connections')) {
      const send = (value: ConnectionsResponse) => socket.send(JSON.stringify(value));
      connectionStreams.add(send);
      socket.onClose(() => connectionStreams.delete(send));
    }
  });
  return { calls, sockets, requestUrls, snapshot };
}

async function openConnection(page: Page) {
  await page.locator('.backend-card').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '连接到 Mihomo' })).toBeVisible();
  return dialog;
}

async function connect(page: Page, remember = false) {
  const dialog = await openConnection(page);
  await dialog.getByLabel('控制器地址', { exact: false }).fill(`${controller}/`);
  await dialog.getByPlaceholder('输入内核设置的 secret').fill(secret);
  await dialog.getByRole('checkbox').setChecked(remember);
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '打开导航菜单' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
    .click();
}

async function expectNoOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
}

test('first run is disconnected, rejects invalid controllers, and explains unauthorized Secret', async ({
  page,
}) => {
  const api = await mockController(page);
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  expect(api.calls).toHaveLength(0);
  await page.screenshot({
    path: '.verification/welcome-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });

  const dialog = await openConnection(page);
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByLabel('控制器地址', { exact: false }).fill('ftp://127.0.0.1:9090');
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('http:// 或 https://');
  expect(api.calls).toHaveLength(0);

  await dialog.getByLabel('控制器地址', { exact: false }).fill(controller);
  await dialog.getByPlaceholder('输入内核设置的 secret').fill('wrong-secret');
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请检查 Secret 密钥是否正确');
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  expect(api.calls).toEqual([
    { method: 'GET', path: '/version', authorization: 'Bearer wrong-secret', body: null },
  ]);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
});

test('explicit demo supports navigation, mode and node selection without controller calls', async ({
  page,
}) => {
  const api = await mockController(page);
  await page.goto('/');
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await expect(page.locator('.demo-banner')).toBeVisible();
  await page.getByRole('button', { name: /全局模式/ }).click();
  await expect(page.locator('.mode-option.selected')).toContainText('全局模式');
  await page.getByRole('button', { name: /规则模式/ }).click();
  await navigate(page, '代理');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const closeOnSwitch = page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true });
  await expect(closeOnSwitch).not.toBeChecked();
  await closeOnSwitch.check();
  const demoNode = page.getByRole('button', { name: /香港 02 · 流媒体/ });
  await demoNode.click();
  await expect(demoNode).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['资源', '连接', '规则', '日志', '网络诊断', '设置']) {
    await navigate(page, name);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
    await expectNoOverflow(page);
  }
  await navigate(page, '概览');
  await expectNoOverflow(page);
  expect(api.calls).toHaveLength(0);
  expect(api.sockets).toHaveLength(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({
    path: '.verification/overview-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('authenticated REST and WebSocket state survive reload only after remember is selected', async ({
  page,
}) => {
  const api = await mockController(page, { ignoreTunPatch: true });
  await page.goto('/');
  await connect(page, true);
  await expect(
    page.locator('.stat-card').filter({ hasText: '下载速率' }).locator('.stat-value'),
  ).toHaveText('2.0 MB/s');
  await expect
    .poll(() => [...new Set(api.sockets.map((url) => url.pathname))].sort())
    .toEqual(['/control/connections', '/control/logs', '/control/memory', '/control/traffic']);
  expect(api.sockets.every((url) => url.searchParams.get('token') === secret)).toBe(true);
  expect(api.sockets.find((url) => url.pathname.endsWith('/logs'))?.searchParams.get('level')).toBe(
    'debug',
  );
  await navigate(page, '连接');
  await expect(page.locator('.connection-destination')).toContainText('browser-smoke.example');
  await navigate(page, '日志');
  await expect(
    page.getByText('Browser WebSocket verification message', { exact: true }),
  ).toBeVisible();
  await navigate(page, '代理');
  await expect(
    page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true }),
  ).not.toBeChecked();
  const modes = page.getByRole('group', { name: '代理模式' });
  await modes.getByRole('button', { name: '全局', exact: true }).click();
  await expect(modes.getByRole('button', { name: '全局', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => api.calls.filter((call) => call.method === 'PATCH'))
    .toEqual([
      {
        method: 'PATCH',
        path: '/configs',
        authorization: `Bearer ${secret}`,
        body: { mode: 'global' },
      },
    ]);
  await modes.getByRole('button', { name: '规则', exact: true }).click();
  const alternate = page.getByRole('button', { name: /^Tokyo B，/ });
  await alternate.click();
  await expect(alternate).toHaveAttribute('aria-pressed', 'true');
  expect(api.calls.find((call) => call.method === 'PUT')).toEqual({
    method: 'PUT',
    path: `/proxies/${encodeURIComponent(groupName)}`,
    authorization: `Bearer ${secret}`,
    body: { name: 'Tokyo B' },
  });
  expect(api.calls.filter((call) => call.path.startsWith('/connections'))).toHaveLength(0);
  await navigate(page, '概览');
  await expect(page.getByRole('combobox', { name: '首页代理组成员', exact: true })).toHaveValue(
    'Tokyo B',
  );
  const tun = page.getByRole('switch', { name: 'TUN 模式', exact: true });
  await expect(tun).toHaveAttribute('aria-checked', 'false');
  await tun.click();
  await expect(page.locator('.toast').filter({ hasText: '配置未生效' })).toBeVisible();
  await expect(tun).toHaveAttribute('aria-checked', 'false');
  await navigate(page, '规则');
  await page.getByRole('button', { name: '按规则内容排序', exact: true }).click();
  await expect(page.locator('.rules-table tbody tr').first()).toHaveAttribute(
    'data-rule-index',
    '2',
  );
  await page.getByPlaceholder('搜索规则内容或策略…').fill('alpha.example');
  await expect(page.locator('.rules-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.rules-table tbody tr')).toHaveAttribute('data-rule-index', '1');
  await page.getByRole('button', { name: '临时禁用第 2 条规则', exact: true }).click();
  await expect(page.locator('.rules-table tbody tr')).toContainText('已禁用');
  expect(api.calls.find((call) => call.path === '/rules/disable')).toEqual({
    method: 'PATCH',
    path: '/rules/disable',
    authorization: `Bearer ${secret}`,
    body: { '1': true },
  });
  expect(api.calls.every((call) => call.authorization === `Bearer ${secret}`)).toBe(true);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey),
  ).toEqual({ url: controller, secret });
  const requestsBeforeReload = api.calls.length;
  await page.reload();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect
    .poll(() => api.calls.slice(requestsBeforeReload).some((call) => call.path === '/version'))
    .toBe(true);
});

test('opted-in proxy cleanup survives reload and closes only the old member of the selected group from Home', async ({
  page,
}) => {
  const oldId = 'old / connection #1';
  const api = await mockController(page, {
    connectionChains: {
      [oldId]: ['Tokyo A', groupName],
      'other-group': ['Tokyo A', 'Other group'],
      'new-member': ['Tokyo B', groupName],
      'nonadjacent-group': ['Tokyo A', 'Inner group', groupName],
    },
  });
  await page.goto('/');
  await connect(page, true);
  await navigate(page, '代理');
  const closeOnSwitch = page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true });
  await expect(closeOnSwitch).not.toBeChecked();
  await closeOnSwitch.check();
  await page.reload();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect(closeOnSwitch).toBeChecked();
  await navigate(page, '概览');
  const member = page.getByRole('combobox', { name: '首页代理组成员', exact: true });
  await expect(member).toHaveValue('Tokyo A');
  await member.selectOption('Tokyo B');
  await expect(member).toHaveValue('Tokyo B');
  await expect(page.locator('.toast').filter({ hasText: '已关闭 1 条旧连接' })).toBeVisible();
  expect(api.calls.filter((call) => call.method === 'DELETE')).toEqual([
    {
      method: 'DELETE',
      path: `/connections/${encodeURIComponent(oldId)}`,
      authorization: `Bearer ${secret}`,
      body: null,
    },
  ]);
  expect(api.snapshot.connections?.map(({ id }) => id)).toEqual([
    'other-group',
    'new-member',
    'nonadjacent-group',
  ]);
  await expect(
    page.locator('.stat-card').filter({ hasText: '活跃连接' }).locator('.stat-value'),
  ).toHaveText('3个');
});

test('a rejected proxy selection never closes connections with cleanup enabled', async ({
  page,
}) => {
  const api = await mockController(page, { rejectSelection: true });
  await page.goto('/');
  await connect(page);
  await navigate(page, '代理');
  await page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true }).check();
  await page.getByRole('button', { name: /^Tokyo B，/ }).click();
  await expect(
    page.locator('.toast').filter({ hasText: 'Proxy selection rejected' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tokyo A，/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  expect(api.snapshot.connections).toHaveLength(1);
});

test('a cleanup failure preserves the successful selection and reports the remaining old connection', async ({
  page,
}) => {
  const api = await mockController(page, { rejectCloseIds: ['browser-connection'] });
  await page.goto('/');
  await connect(page);
  await navigate(page, '代理');
  await page.getByRole('checkbox', { name: '切换后关闭旧连接', exact: true }).check();
  await page.getByRole('button', { name: /^Tokyo B，/ }).click();
  await expect(
    page.locator('.toast').filter({ hasText: '已切换到 Tokyo B，旧连接清理未完成' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tokyo B，/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect(api.snapshot.connections).toHaveLength(1);
  await navigate(page, '概览');
  await expect(page.getByRole('combobox', { name: '首页代理组成员', exact: true })).toHaveValue(
    'Tokyo B',
  );
});

test('a session-only connection clears previous remembered credentials and does not reconnect on reload', async ({
  page,
}) => {
  const api = await mockController(page);
  await page.goto('/');
  await connect(page, true);
  await connect(page, false);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await page.reload();
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  const requests = api.calls.length;
  await page.waitForLoadState('networkidle');
  expect(api.calls).toHaveLength(requests);
});

test('an idle controller with null connections stays connected and displays its empty state', async ({
  page,
}) => {
  await mockController(page, { idle: true });
  await page.goto('/');
  await connect(page);
  await expect(
    page.locator('.stat-card').filter({ hasText: '活跃连接' }).locator('.stat-value'),
  ).toHaveText('0个');
  await navigate(page, '连接');
  await expect(page.getByRole('heading', { name: '暂时没有活动连接' })).toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
  await expect(page.locator('.connection-row')).toHaveCount(0);
});

test('provider-only nodes expose metadata and health checks, while hidden automatic groups support pin and reset', async ({
  page,
}) => {
  const api = await mockController(page, { providerOnly: true });
  await page.goto('/');
  await connect(page);
  await navigate(page, '代理');
  const node = page.getByRole('button', { name: /^Tokyo B，67 ms/ });
  await expect(node).toBeVisible();
  await expect(node).toContainText('Shadowsocks');
  await expect(node).toContainText('UDP');
  await node.click();
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('article', { name: 'Tokyo B 节点', exact: true })
    .getByRole('button', { name: '测试节点延迟' })
    .click();
  await expect
    .poll(() =>
      api.calls.some(
        (call) =>
          call.path ===
          `/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent('Tokyo B')}/healthcheck`,
      ),
    )
    .toBe(true);

  const automatic = page.getByRole('region', { name: `${autoGroupName} 代理组`, exact: true });
  await expect(automatic).toHaveCount(0);
  await page.getByRole('checkbox', { name: /显示隐藏代理组/ }).check();
  await automatic.getByRole('button', { name: `展开 ${autoGroupName}`, exact: true }).click();
  await automatic.getByRole('button', { name: /^Tokyo A，/ }).click();
  await expect(
    automatic.getByRole('button', { name: '测速并恢复自动', exact: true }),
  ).toBeVisible();
  expect(
    api.calls.find(
      (call) => call.method === 'PUT' && call.path.includes(encodeURIComponent(autoGroupName)),
    ),
  ).toMatchObject({ body: { name: 'Tokyo A' } });
  await automatic.getByRole('button', { name: '恢复自动', exact: true }).click();
  await expect(automatic.getByRole('button', { name: '恢复自动', exact: true })).toHaveCount(0);
  expect(api.calls.find((call) => call.method === 'DELETE')).toMatchObject({
    path: `/proxies/${encodeURIComponent(autoGroupName)}`,
  });
  await automatic.getByRole('button', { name: /^Tokyo A，/ }).click();
  await automatic.getByRole('button', { name: '测速并恢复自动', exact: true }).click();
  await expect(automatic.getByRole('button', { name: '恢复自动', exact: true })).toHaveCount(0);
  const delayUrl = api.requestUrls.find(
    (url) => url.pathname === `/control/group/${encodeURIComponent(autoGroupName)}/delay`,
  );
  expect(delayUrl?.searchParams.get('url')).toBe('https://example.com/check?sample=1');
  expect(delayUrl?.searchParams.get('expected')).toBe('204');
});

test('cancelling a delayed connection prevents the response from connecting or saving its Secret', async ({
  page,
}) => {
  let releaseVersion!: () => void;
  const versionGate = new Promise<void>((resolve) => {
    releaseVersion = resolve;
  });
  const api = await mockController(page, { versionGate });
  await page.goto('/');
  const dialog = await openConnection(page);
  await dialog.getByLabel('控制器地址', { exact: false }).fill(controller);
  await dialog.getByPlaceholder('输入内核设置的 secret').fill(secret);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect.poll(() => api.calls.some((call) => call.path === '/version')).toBe(true);
  await expect(dialog.getByRole('button', { name: '正在连接…' })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  releaseVersion();
  await expect(dialog).not.toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.connection-status')).toHaveText('等待连接');
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  expect(api.calls).toHaveLength(1);
  expect(api.sockets).toHaveLength(0);
});

test('DNS results sort by TTL, distinguish errors and cancellation, and cache writes require confirmation', async ({
  page,
}) => {
  let releaseDns!: () => void;
  const dnsGate = new Promise<void>((resolve) => {
    releaseDns = resolve;
  });
  const api = await mockController(page, { dnsGate });
  await page.goto('/');
  await connect(page);
  await navigate(page, '网络诊断');
  const domain = page.getByRole('textbox', { name: '域名', exact: true });
  const query = page.getByRole('button', { name: '查询', exact: true });
  await domain.fill('example.com');
  await query.click();
  await expect(page.getByText('NOERROR', { exact: true })).toBeVisible();
  const records = page.locator('.diagnostics-record-table tbody tr');
  await expect(records).toHaveCount(2);
  await page.getByRole('button', { name: 'TTL（秒）', exact: true }).click();
  await expect(records.first()).toContainText('203.0.113.20');
  const dnsUrl = api.requestUrls.find((url) => url.pathname.endsWith('/dns/query'));
  expect(dnsUrl?.searchParams.get('name')).toBe('example.com');
  expect(dnsUrl?.searchParams.get('type')).toBe('A');

  await domain.fill('missing.example');
  await query.click();
  await expect(page.getByText('NXDOMAIN', { exact: true })).toBeVisible();
  await expect(records).toHaveCount(0);
  await domain.fill('disabled.example');
  await query.click();
  await expect(page.getByRole('alert')).toContainText('内核未启用 DNS');
  await domain.fill('slow.example');
  await query.click();
  await expect
    .poll(() => api.requestUrls.some((url) => url.searchParams.get('name') === 'slow.example'))
    .toBe(true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  releaseDns();
  await expect(query).toBeEnabled();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: '查询结果', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: '清理 DNS', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  for (const name of ['清理 DNS', '清理 Fake-IP']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认清理', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  }
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([
    { method: 'POST', path: '/cache/dns/flush', authorization: `Bearer ${secret}`, body: null },
    { method: 'POST', path: '/cache/fakeip/flush', authorization: `Bearer ${secret}`, body: null },
  ]);
});

test('mobile dark theme fits the viewport and its navigation closes after selecting a page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoOverflow(page);
  for (const name of ['代理', '资源', '连接', '规则', '日志', '网络诊断', '设置', '概览']) {
    await navigate(page, name);
    await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/);
    await expectNoOverflow(page);
    if (name === '代理')
      await page.screenshot({
        path: '.verification/proxies-mobile-dark.png',
        fullPage: true,
        animations: 'disabled',
      });
  }
  await page.screenshot({
    path: '.verification/overview-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});
