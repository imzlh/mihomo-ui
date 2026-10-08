import { expect, test, type Page } from '@playwright/test';

async function enterDemo(page: Page) {
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await expect(page.getByRole('button', { name: '体验演示', exact: true })).toHaveCount(0);
}

async function reloadDemo(page: Page) {
  await page.reload();
  await enterDemo(page);
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

test('home defaults are safe and hidden memory and cards persist after a reload', async ({
  page,
}) => {
  await page.goto('/');
  await enterDemo(page);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).not.toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' })).toHaveValue('5');
  await expect(dialog.getByRole('combobox', { name: '流量图表样式' })).toHaveValue('area');
  await dialog.getByRole('switch', { name: '显示内存占用', exact: true }).click();
  await dialog.getByRole('switch', { name: '显示流量趋势', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(3);
  await expect(page.locator('.stat-card').filter({ hasText: '内存占用' })).toHaveCount(0);
  await expect(page.locator('.traffic-panel')).toHaveCount(0);

  await reloadDemo(page);
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(3);
  await expect(page.locator('.stat-card').filter({ hasText: '内存占用' })).toHaveCount(0);
  await expect(page.locator('.traffic-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '显示内存占用', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: '显示流量趋势', exact: true })).not.toBeChecked();
});

test('both chart styles and every member sort persist across demo sessions', async ({ page }) => {
  await page.goto('/');
  await enterDemo(page);
  const chart = page.locator('.traffic-panel .traffic-chart');
  const sort = page.getByRole('combobox', { name: '首页成员排序', exact: true });
  await expect(chart).toHaveAttribute('data-chart-style', 'area');
  await expect(sort).toHaveValue('default');

  await page.getByRole('button', { name: '切换流量图表样式', exact: true }).click();
  await sort.selectOption('delay');
  await reloadDemo(page);
  await expect(chart).toHaveAttribute('data-chart-style', 'line');
  await expect(sort).toHaveValue('delay');

  await sort.selectOption('name');
  await reloadDemo(page);
  await expect(sort).toHaveValue('name');
  await expect(chart).toHaveAttribute('data-chart-style', 'line');

  await sort.selectOption('default');
  await page.getByRole('button', { name: '切换流量图表样式', exact: true }).click();
  await reloadDemo(page);
  await expect(sort).toHaveValue('default');
  await expect(chart).toHaveAttribute('data-chart-style', 'area');
});

test('narrow home restores hidden cards and demo auto testing makes no controller requests', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const ui = new URL(baseURL!);
  const controllerRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== ui.origin ||
      url.port === '9090' ||
      /\/(?:delay|healthcheck)(?:\/|$)/.test(url.pathname)
    ) {
      controllerRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.host !== ui.host) controllerRequests.push(socket.url());
  });

  await page.goto('/');
  await enterDemo(page);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('switch', { name: '自动测试当前出口延迟', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' }).fill('1');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('演示模式使用示例延迟', { exact: true })).toBeVisible();
  await page.clock.runFor(200);
  await page.clock.fastForward(61_000);
  await page.getByRole('button', { name: '测试当前出口延迟', exact: true }).click();
  await expect(page.getByText('演示模式展示的是示例延迟', { exact: true })).toBeVisible();
  expect(controllerRequests).toEqual([]);

  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  for (const label of [
    '内存占用',
    '实时网络指标',
    '流量趋势',
    '出站模式',
    '代理组出口',
    '代理集',
    '内核配置',
  ]) {
    await dialog.getByRole('switch', { name: `显示${label}`, exact: true }).click();
  }
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-grid, .overview-main-grid, .overview-bottom-grid')).toHaveCount(
    0,
  );
  await expectNoHorizontalOverflow(page);

  await reloadDemo(page);
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置显示卡片', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' })).toHaveValue('1');
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toHaveCount(0);
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(4);
  for (const title of ['流量趋势', '出站模式', '代理组出口', '代理集', '内核配置']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
  expect(controllerRequests).toEqual([]);
});
