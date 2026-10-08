import { expect, test, type Page } from '@playwright/test';
import { defaultProxyPreferences } from '../src/lib/proxy-preferences';

const controller = 'http://127.0.0.1:9090/proxy-display';
const preferenceKey = `mihomo-verge.proxy-preferences:${controller}`;
const dataSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" onload="window.top.iconExecuted=true"><rect width="32" height="32" fill="purple"/></svg>';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPe0AAAAASUVORK5CYII=';
const longGroupName = '自动选择 · 长名称代理组 Hong Kong Streaming and Work';
const longNodeName = '香港 Hong Kong · 高速专线 Streaming and Work';

async function mock(page: Page, longNames = false) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const groups = [
    { name: 'A group', icon: 'https://icons.example/group.png' },
    { name: 'SVG group', icon: dataSvg },
    { name: 'Broken group', icon: 'https://icons.example/broken.png' },
    { name: '__proto__', icon: 'javascript:window.iconExecuted=true' },
    { name: 'Hidden group', hidden: true },
    ...(longNames
      ? [
          {
            name: longGroupName,
            type: 'URLTest',
            hidden: true,
            fixed: longNodeName,
            now: longNodeName,
            all: [longNodeName, 'Alpha'],
          },
        ]
      : []),
  ];
  const proxies = Object.fromEntries([
    ...groups.map((group) => [
      group.name,
      {
        type: 'Selector',
        all: ['Zulu', 'Alpha', 'Middle', 'DIRECT'],
        now: 'Zulu',
        history: [],
        ...group,
      },
    ]),
    ...['Zulu', 'Alpha', 'Middle', ...(longNames ? [longNodeName] : [])].map((name, index) => [
      name,
      {
        name,
        type: 'Shadowsocks',
        history: [{ time: '2026-10-08T00:00:00Z', delay: [31, 90, 45, 48][index] }],
      },
    ]),
    ['DIRECT', { name: 'DIRECT', type: 'Direct', history: [] }],
  ]);
  let finishDelay: (() => void) | undefined;
  let delayRequests = 0;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route('https://icons.example/**', (route) =>
    route.request().url().endsWith('broken.png')
      ? route.fulfill({ status: 404 })
      : route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
  );
  await page.route(/^http:\/\/127\.0\.0\.1:9090\/proxy-display(?:-other)?\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const pathname = new URL(request.url()).pathname;
    const path = pathname.slice(pathname.indexOf('/', 1));
    const json = (value: unknown) => route.fulfill({ headers, json: value });
    if (path === '/version') await json({ version: 'proxy-display-test', meta: true });
    else if (path === '/configs')
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      });
    else if (path === '/proxies') await json({ proxies });
    else if (path.startsWith('/providers/')) await json({ providers: {} });
    else if (path === '/rules') await json({ rules: [] });
    else if (path.endsWith('/delay')) {
      delayRequests += 1;
      await new Promise<void>((resolve) => {
        finishDelay = resolve;
      });
      await json({ Zulu: 34, Alpha: 81, Middle: 47 });
    } else await route.fulfill({ status: 404, headers });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\/proxy-display(?:-other)?\//, () => {});
  await page.addInitScript((url) => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url, secret: '' }));
    (window as unknown as { iconExecuted: boolean }).iconExecuted = false;
  }, controller);
  await page.goto('/#/proxies');
  await expect(page.getByRole('button', { name: '代理显示设置', exact: true })).toBeVisible();
  return { errors, finishDelay: () => finishDelay?.(), delayRequests: () => delayRequests };
}

test('proxy display preferences persist by controller, restore immediately and retain exact group names', async ({
  page,
}) => {
  const api = await mock(page);
  await page.getByRole('combobox', { name: '节点排序', exact: true }).selectOption('name');
  await page.getByLabel(/显示隐藏代理组/).check();
  await page.getByRole('button', { name: '展开 __proto__', exact: true }).click();
  await page.getByRole('button', { name: '代理显示设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '宽松', exact: true }).click();
  await dialog.getByRole('combobox', { name: '节点列数', exact: true }).selectOption('4');
  await dialog.getByRole('switch', { name: '显示代理组图标', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('combobox', { name: '节点排序', exact: true })).toHaveValue('name');
  await expect(page.getByLabel(/显示隐藏代理组/)).toBeChecked();
  await expect(page.getByRole('button', { name: '收起 __proto__', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('.proxies-page')).toHaveClass(/proxy-columns-4/);
  await expect(page.locator('.proxy-group-icon')).toHaveCount(0);
  const stored = await page.evaluate((key) => localStorage.getItem(key), preferenceKey);
  expect(Object.entries(JSON.parse(stored!).expandedGroups)).toContainEqual(['__proto__', true]);
  await page.evaluate(
    ({ key, preferences }) => {
      localStorage.setItem(key, JSON.stringify(preferences));
      window.dispatchEvent(new Event('mihomo-verge:preferences-changed'));
    },
    { key: preferenceKey, preferences: defaultProxyPreferences() },
  );
  await expect(page.getByRole('combobox', { name: '节点排序', exact: true })).toHaveValue(
    'original',
  );
  await expect(page.getByLabel(/显示隐藏代理组/)).not.toBeChecked();
  await expect(page.locator('.proxies-page')).toHaveClass(/proxy-columns-auto/);
  await expect(page.getByRole('button', { name: '展开 __proto__', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const otherController = `${controller}-other`;
  await page.evaluate(
    ({ key, preferences }) => localStorage.setItem(key, JSON.stringify(preferences)),
    {
      key: `mihomo-verge.proxy-preferences:${otherController}`,
      preferences: {
        ...defaultProxyPreferences(),
        sortOrder: 'name',
        showHidden: true,
        columns: 2,
      },
    },
  );
  await page.locator('.backend-card').click();
  await page.getByRole('dialog').getByLabel('控制器地址', { exact: false }).fill(otherController);
  await page.getByRole('dialog').getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '节点排序', exact: true })).toHaveValue('name');
  await expect(page.getByLabel(/显示隐藏代理组/)).toBeChecked();
  await expect(page.locator('.proxies-page')).toHaveClass(/proxy-columns-2/);
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), preferenceKey))!).sortOrder,
  ).toBe('original');
  expect(api.errors).toEqual([]);
  await page.screenshot({
    path: '.verification/proxy-display-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('compact group headers and toolbar fit phone and tablet widths with long names and fixed selections', async ({
  page,
}) => {
  const api = await mock(page, true);
  await page.getByRole('checkbox', { name: '显示隐藏代理组', exact: true }).check();
  const group = page.getByRole('region', { name: `${longGroupName} 代理组`, exact: true });
  await group.getByRole('button', { name: `展开 ${longGroupName}`, exact: true }).click();
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await group.evaluate((element) => {
      const bounds = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const header = bounds('.group-header');
      const name = bounds('.proxy-group-name');
      const tools = bounds('.proxy-group-actions');
      const toolbar = document.querySelector('.proxy-page-toolbar')!.getBoundingClientRect();
      const nameElement = element.querySelector('.proxy-group-name')!;
      return {
        headerHeight: header.height,
        toolbarHeight: toolbar.height,
        toolsFit:
          tools.top >= header.top && tools.bottom <= header.bottom && tools.right <= header.right,
        nameFits: name.right <= tools.left && name.width > 30,
        nameTruncated: nameElement.scrollWidth > nameElement.clientWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(layout.headerHeight).toBeLessThanOrEqual(72);
    expect(layout.toolbarHeight).toBeLessThanOrEqual(80);
    expect(layout.toolsFit).toBe(true);
    expect(layout.nameFits).toBe(true);
    expect(layout.nameTruncated).toBe(true);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    await expect(group.locator('.proxy-group-name')).toHaveCSS('font-size', '16px');
    await expect(group.locator('.proxy-node').first()).toHaveCSS('height', '56px');
    await expect(group.locator('.latency').first()).toHaveCSS('font-size', '14px');
    await expect(group.getByRole('button', { name: '恢复自动', exact: true })).toBeVisible();
    await expect(group.getByRole('button', { name: '测速并恢复自动', exact: true })).toBeEnabled();
  }
  expect(api.errors).toEqual([]);
});

test('group icons load as images, fail to a fallback and never insert or execute SVG markup', async ({
  page,
}) => {
  const api = await mock(page);
  const image = page
    .getByRole('region', { name: 'A group 代理组', exact: true })
    .locator('.proxy-group-icon img');
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  const svgGroup = page.getByRole('region', { name: 'SVG group 代理组', exact: true });
  const svgImage = svgGroup.locator('.proxy-group-icon img');
  await svgImage.scrollIntoViewIfNeeded();
  await expect(svgImage).toHaveAttribute('src', /^data:image\/svg\+xml;charset=utf-8,/);
  await expect
    .poll(() => svgImage.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(32);
  await expect(svgGroup.locator('.proxy-group-icon svg')).toHaveCount(0);
  const broken = page.getByRole('region', { name: 'Broken group 代理组', exact: true });
  await broken.scrollIntoViewIfNeeded();
  await expect(broken.locator('.proxy-group-icon img')).toHaveCount(0);
  await expect(broken.locator('.proxy-group-icon > svg')).toHaveCount(1);
  const invalid = page.getByRole('region', { name: '__proto__ 代理组', exact: true });
  await expect(invalid.locator('.proxy-group-icon img')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { iconExecuted: boolean }).iconExecuted),
  ).toBe(false);
  expect(api.errors).toEqual([]);
});

test('display controls preserve delay dimensions and pending state across routes and fit narrow screens', async ({
  page,
}) => {
  const api = await mock(page);
  const firstGroup = page.getByRole('region', { name: 'A group 代理组', exact: true });
  const node = firstGroup.locator('.proxy-node').first();
  await expect(node).toHaveCSS('height', '56px');
  expect(
    await node.locator('.latency').evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe('14px');
  await firstGroup.getByRole('button', { name: '延迟测试', exact: true }).click();
  await expect.poll(api.delayRequests).toBe(1);
  await expect(firstGroup.locator('.proxy-delay-loading').first().locator('i')).toHaveCount(3);
  await page.getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('link', { name: '代理', exact: true }).click();
  await expect(firstGroup.getByRole('button', { name: '测试中…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '代理显示设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '宽松', exact: true }).click();
  await dialog.getByRole('combobox', { name: '节点列数', exact: true }).selectOption('4');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(node).toHaveCSS('height', '56px');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await firstGroup
      .locator('.proxy-grid')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  await page.screenshot({
    path: '.verification/proxy-display-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  api.finishDelay();
  await expect(firstGroup.getByRole('button', { name: '延迟测试', exact: true })).toBeEnabled();
  await expect(firstGroup.locator('.proxy-delay-loading')).toHaveCount(0);
  expect(api.delayRequests()).toBe(1);
  expect(api.errors).toEqual([]);
});
