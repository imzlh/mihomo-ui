import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const libraryKey = 'mihomo-verge.profile-library:local';
const controller = 'http://127.0.0.1:9090/batch';
const otherController = 'http://127.0.0.1:9091/batch';
const original =
  '# Keep comments and CRLF\r\nmode: rule\r\nproxy-groups: []\r\nrules:\r\n  - MATCH,DIRECT\r\n';
const secondContent = '# Second configuration\nmode: global\nproxies: []\nrules: []\n';
const sourceUrl = 'https://profiles.example/remote.yaml?token=private-source';
const browserErrors = new WeakMap<Page, string[]>();
const configWrites = new WeakMap<Page, string[]>();

interface Entry {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
}

interface Archive {
  format: string;
  version: number;
  exportedAt: number;
  profiles: {
    name: string;
    description: string;
    content: string;
    sourceUrl?: string;
    id?: string;
  }[];
}

function entry(id: string, name: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    name,
    description: `${name} description`,
    content: original,
    createdAt: 1_791_435_615_000,
    updatedAt: 1_791_435_615_000,
    ...overrides,
  };
}

const initial = () => [
  entry('alpha', 'Travel Alpha', { sourceUrl }),
  entry('beta', 'Travel Beta', { content: secondContent }),
  entry('office', 'Office'),
];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function seed(page: Page, profiles = initial(), connected = false) {
  await page.addInitScript(
    ({ key, profiles, connected, controller }) => {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify({ version: 1, profiles }));
      if (connected)
        localStorage.setItem(
          'mihomo-verge.backend',
          JSON.stringify({ url: controller, secret: '' }),
        );
    },
    { key: libraryKey, profiles, connected, controller },
  );
}

async function stored(page: Page): Promise<Entry[]> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{"profiles":[]}').profiles,
    libraryKey,
  );
}

async function openProfiles(page: Page, connected = false) {
  await page.goto('/#/profiles');
  await expect(page.getByRole('heading', { name: '配置', exact: true })).toBeVisible();
  if (connected) await expect(page.locator('.connection-status')).toHaveText('内核已连接');
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '打开导航菜单', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name, exact: true })
    .click();
}

async function select(page: Page, name: string) {
  await page.getByRole('button', { name: `选择配置 ${name}`, exact: true }).click();
  return page.locator('.profile-detail');
}

function batchCheckbox(page: Page, name: string) {
  return page.getByRole('checkbox', { name: `批量选择 ${name}`, exact: true });
}

async function downloadedArchive(
  page: Page,
  button: Locator,
): Promise<{ content: string; archive: Archive }> {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const content = await readFile(path!, 'utf8');
  return { content, archive: JSON.parse(content) as Archive };
}

async function importArchive(page: Page, content: string) {
  await page.getByLabel('导入配置归档', { exact: true }).setInputFiles({
    name: 'profiles.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  });
  const preview = page.getByRole('dialog', { name: '导入配置预览', exact: true });
  await expect(preview).toBeVisible();
  return preview;
}

async function importFiles(page: Page) {
  await page.getByLabel('导入 YAML 文件', { exact: true }).setInputFiles([
    { name: 'a.yml', mimeType: 'application/yaml', buffer: Buffer.from(original) },
    { name: 'broken.yaml', mimeType: 'application/yaml', buffer: Buffer.from('mode: [rule\n') },
    { name: 'b.yaml', mimeType: 'application/yaml', buffer: Buffer.from(secondContent) },
  ]);
  const preview = page.getByRole('dialog', { name: '导入配置预览', exact: true });
  await expect(preview).toBeVisible();
  return preview;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const writes: string[] = [];
  browserErrors.set(page, errors);
  configWrites.set(page, writes);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'PUT' && /\/configs$/.test(new URL(request.url()).pathname))
      writes.push(request.url());
  });
  // A connected controller makes accidental application observable while library work remains local.
  await page.route(/^http:\/\/127\.0\.0\.1:909[01]\/batch\//, async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/batch'.length);
    const values: Record<string, unknown> = {
      '/version': { version: 'v1.19.15', meta: true },
      '/configs': { mode: 'rule', 'mixed-port': 7890, 'log-level': 'info' },
      '/proxies': { proxies: {} },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
    };
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') await route.fulfill({ status: 204, headers });
    else await route.fulfill({ headers, json: values[path] ?? {} });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:909[01]\/batch\//, (socket) => {
    const stream = new URL(socket.url()).pathname.split('/').at(-1)!;
    const frames: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 0 },
      connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (stream in frames) socket.send(JSON.stringify(frames[stream]));
  });
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
  expect(configWrites.get(page), 'Library operations never apply a configuration').toEqual([]);
});

test('filtered batch selection preserves hidden choices and deletion keeps concurrently added profiles', async ({
  page,
  context,
}) => {
  await seed(page);
  await openProfiles(page);
  await page.getByRole('button', { name: '批量管理', exact: true }).click();
  const search = page.getByPlaceholder('搜索配置名称或描述…');
  await search.fill('Travel');
  await page.getByRole('button', { name: '仅选择当前筛选结果', exact: true }).click();
  await expect(batchCheckbox(page, 'Travel Alpha')).toBeChecked();
  await expect(batchCheckbox(page, 'Travel Beta')).toBeChecked();
  await search.fill('Office');
  await expect(batchCheckbox(page, 'Office')).not.toBeChecked();
  await batchCheckbox(page, 'Office').check();
  await search.fill('');
  for (const name of ['Travel Alpha', 'Travel Beta', 'Office'])
    await expect(batchCheckbox(page, name)).toBeChecked();
  await search.fill('Office');
  await page.getByRole('button', { name: '仅选择当前筛选结果', exact: true }).click();
  await search.fill('');
  await expect(batchCheckbox(page, 'Office')).toBeChecked();
  await expect(batchCheckbox(page, 'Travel Alpha')).not.toBeChecked();
  await expect(batchCheckbox(page, 'Travel Beta')).not.toBeChecked();
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除选中配置', exact: true })).toBeDisabled();
  await search.fill('Travel');
  await page.getByRole('button', { name: '仅选择当前筛选结果', exact: true }).click();
  await page.getByRole('button', { name: '删除选中配置', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除选中配置', exact: true });
  await expect(confirmation.getByRole('list')).toContainText('Travel Alpha');
  await expect(confirmation.getByRole('list')).toContainText('Travel Beta');
  await expect(confirmation).not.toContainText('Office');
  const otherTab = await context.newPage();
  await otherTab.goto('/#/profiles');
  const concurrent = entry('concurrent', 'Created while confirming');
  await otherTab.evaluate(
    ({ key, concurrent }) => {
      const library = JSON.parse(localStorage.getItem(key)!);
      library.profiles.push(concurrent);
      localStorage.setItem(key, JSON.stringify(library));
    },
    { key: libraryKey, concurrent },
  );
  await expect.poll(() => stored(page).then((profiles) => profiles.length)).toBe(4);
  await confirmation.getByRole('button', { name: /确认删除\s*2\s*份/ }).click();
  await expect(confirmation).not.toBeVisible();
  await search.fill('');
  await expect(page.getByRole('button', { name: '选择配置 Office', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '选择配置 Created while confirming', exact: true }),
  ).toBeVisible();
  expect((await stored(page)).map((profile) => profile.id)).toEqual(['office', 'concurrent']);
  await otherTab.close();
});

test('selected archives reimport as new copies with exact YAML, source URLs and duplicate previews', async ({
  page,
}) => {
  await seed(page, initial(), true);
  await openProfiles(page, true);
  await page.getByRole('button', { name: '批量管理', exact: true }).click();
  await batchCheckbox(page, 'Travel Alpha').check();
  await batchCheckbox(page, 'Travel Beta').check();
  const { content, archive } = await downloadedArchive(
    page,
    page.getByRole('button', { name: '导出选中归档', exact: true }),
  );
  expect(archive).toMatchObject({ format: 'mihomo-verge-profile-archive', version: 1 });
  expect(archive.profiles).toEqual([
    { name: 'Travel Alpha', description: 'Travel Alpha description', content: original, sourceUrl },
    { name: 'Travel Beta', description: 'Travel Beta description', content: secondContent },
  ]);
  const preview = await importArchive(page, content);
  await expect(preview.locator('.profile-import-item')).toHaveCount(2);
  for (const name of ['Travel Alpha', 'Travel Beta'])
    await expect(preview.locator('.profile-import-item').filter({ hasText: name })).toContainText(
      /同名|重复/,
    );
  expect(await stored(page)).toHaveLength(3);
  await preview.getByRole('button', { name: /确认导入\s*2\s*份/ }).click();
  await expect(preview).not.toBeVisible();
  const after = await stored(page);
  expect(after).toHaveLength(5);
  expect(new Set(after.map((profile) => profile.id)).size).toBe(5);
  const copies = after.filter((profile) => !['alpha', 'beta', 'office'].includes(profile.id));
  expect(copies).toHaveLength(2);
  expect(copies.find((profile) => profile.name === 'Travel Alpha')).toMatchObject({
    content: original,
    sourceUrl,
  });
  expect(copies.find((profile) => profile.name === 'Travel Beta')).toMatchObject({
    content: secondContent,
  });
  for (const saved of initial())
    expect(after.find((profile) => profile.id === saved.id)).toEqual(saved);
  await page.reload();
  expect(await stored(page)).toHaveLength(5);
});

test('multiple YAML files preview individually and commit only valid selected files in one write', async ({
  page,
}) => {
  await seed(page, [entry('existing', 'Existing')], true);
  await openProfiles(page, true);
  const preview = await importFiles(page);
  await expect(preview.locator('.profile-import-item')).toHaveCount(3);
  await expect(preview.getByRole('checkbox', { disabled: false })).toHaveCount(2);
  await expect(preview.getByRole('checkbox', { name: '导入 a.yml', exact: true })).toBeChecked();
  await expect(preview.getByRole('checkbox', { name: '导入 b.yaml', exact: true })).toBeChecked();
  const invalid = preview.locator('.profile-import-item').filter({ hasText: 'broken.yaml' });
  await expect(invalid.locator('.profile-import-error')).not.toHaveText('');
  await expect(invalid.getByRole('checkbox')).toBeDisabled();
  await expect(invalid.getByRole('checkbox')).not.toBeChecked();
  await preview.getByRole('checkbox', { name: '导入 b.yaml', exact: true }).uncheck();
  await expect(preview.getByRole('button', { name: /确认导入\s*1\s*份/ })).toBeEnabled();
  await preview.getByRole('checkbox', { name: '导入 b.yaml', exact: true }).check();
  await page.evaluate((key) => {
    const originalSetItem = Storage.prototype.setItem;
    (window as unknown as { profileImportWrites: number }).profileImportWrites = 0;
    Storage.prototype.setItem = function (candidate, value) {
      if (candidate === key)
        (window as unknown as { profileImportWrites: number }).profileImportWrites += 1;
      return originalSetItem.call(this, candidate, value);
    };
  }, libraryKey);
  await preview.getByRole('button', { name: /确认导入\s*2\s*份/ }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(preview).not.toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { profileImportWrites: number }).profileImportWrites,
    ),
  ).toBe(1);
  const after = await stored(page);
  expect(after).toHaveLength(3);
  expect(after.find((profile) => profile.name === 'a')?.content).toBe(original);
  expect(after.find((profile) => profile.name === 'b')?.content).toBe(secondContent);
  expect(after.some((profile) => profile.name.includes('broken'))).toBe(false);
});

test('failed batch persistence keeps the old library and can download the import draft archive', async ({
  page,
}) => {
  await seed(page, [entry('existing', 'Existing')]);
  await openProfiles(page);
  const preview = await importFiles(page);
  const before = await stored(page);
  await page.evaluate((key) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (candidate, value) {
      if (candidate === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, candidate, value);
    };
  }, libraryKey);
  await preview.getByRole('button', { name: /确认导入\s*2\s*份/ }).click();
  await expect(preview.getByRole('alert')).toContainText(/未保存|存储/);
  expect(await stored(page)).toEqual(before);
  await expect(preview.getByRole('checkbox', { name: '导入 a.yml', exact: true })).toBeChecked();
  const { archive } = await downloadedArchive(
    page,
    preview.getByRole('button', { name: '下载草稿归档', exact: true }),
  );
  expect(archive.profiles.map(({ name, content }) => ({ name, content }))).toEqual([
    { name: 'a', content: original },
    { name: 'b', content: secondContent },
  ]);
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  expect(await stored(page)).toEqual(before);
  await expect(page.locator('.profile-card')).toHaveCount(1);
});

test('keyboard move controls persist manual order and disable movement while filtering', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  await select(page, 'Travel Beta');
  const up = page.getByRole('button', { name: '上移配置 Travel Beta', exact: true });
  await up.focus();
  await expect(up).toBeFocused();
  await up.press('Enter');
  expect((await stored(page)).map((profile) => profile.id)).toEqual(['beta', 'alpha', 'office']);
  await expect(up).toBeDisabled();
  const down = page.getByRole('button', { name: '下移配置 Travel Beta', exact: true });
  await down.focus();
  await down.press('Space');
  expect((await stored(page)).map((profile) => profile.id)).toEqual(['alpha', 'beta', 'office']);
  await down.press('Enter');
  expect((await stored(page)).map((profile) => profile.id)).toEqual(['alpha', 'office', 'beta']);
  await expect(down).toBeDisabled();
  await page.reload();
  await expect(page.locator('.profile-card-name')).toHaveText([
    'Travel Alpha',
    'Office',
    'Travel Beta',
  ]);
  await select(page, 'Travel Beta');
  await page.getByPlaceholder('搜索配置名称或描述…').fill('Travel');
  await expect(
    page.getByRole('button', { name: '上移配置 Travel Beta', exact: true }),
  ).toBeDisabled();
  expect((await stored(page)).map((profile) => profile.id)).toEqual(['alpha', 'office', 'beta']);
});

test('deferred multi-file reads are discarded after leaving, changing controller or opening a new editor', async ({
  page,
}) => {
  await seed(page, [entry('existing', 'Existing')], true);
  const rounds: ReturnType<typeof gate>[] = [];
  let currentRound = -1;
  let startedForRound = 0;
  await page.exposeFunction('readDeferredBatchFile', async () => {
    const pending = rounds[currentRound]!;
    await pending.promise;
    return original;
  });
  await openProfiles(page, true);
  await page.evaluate(() => {
    const context = window as unknown as {
      readDeferredBatchFile: () => Promise<string>;
      batchFileReadsStarted: number;
      batchFileReadsCompleted: number;
    };
    context.batchFileReadsStarted = 0;
    context.batchFileReadsCompleted = 0;
    File.prototype.text = async function () {
      context.batchFileReadsStarted += 1;
      const content = await context.readDeferredBatchFile();
      context.batchFileReadsCompleted += 1;
      return content;
    };
  });
  async function startRound() {
    const previousStarted = await page.evaluate(
      () => (window as unknown as { batchFileReadsStarted: number }).batchFileReadsStarted,
    );
    currentRound += 1;
    rounds.push(gate());
    await page.getByLabel('导入 YAML 文件', { exact: true }).setInputFiles([
      { name: 'late-a.yaml', mimeType: 'application/yaml', buffer: Buffer.from(original) },
      { name: 'late-b.yaml', mimeType: 'application/yaml', buffer: Buffer.from(secondContent) },
    ]);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { batchFileReadsStarted: number }).batchFileReadsStarted,
        ),
      )
      .toBeGreaterThan(previousStarted);
    startedForRound = await page.evaluate(
      () => (window as unknown as { batchFileReadsStarted: number }).batchFileReadsStarted,
    );
  }
  async function finishRound() {
    rounds[currentRound]!.release();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { batchFileReadsCompleted: number }).batchFileReadsCompleted,
        ),
      )
      .toBe(startedForRound);
  }
  await startRound();
  await navigate(page, '概览');
  await finishRound();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, '配置');
  await startRound();
  await page.getByRole('button', { name: '切换内核', exact: true }).click();
  const connection = page.getByRole('dialog', { name: '连接到 Mihomo', exact: true });
  await connection.getByLabel('控制器地址', { exact: false }).fill(otherController);
  await connection.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(connection).not.toBeVisible();
  await finishRound();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await startRound();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await editor.getByLabel('配置名称', { exact: true }).fill('My current draft');
  await editor.getByLabel('YAML 原文', { exact: false }).fill(secondContent);
  await finishRound();
  await expect(page.getByRole('dialog', { name: '导入配置预览', exact: true })).toHaveCount(0);
  await expect(editor.getByLabel('配置名称', { exact: true })).toHaveValue('My current draft');
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(secondContent);
  expect(await stored(page)).toHaveLength(1);
});

test('390px batch toolbar and import preview stay usable within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [
    entry('long', 'A very long profile name for portable archive previews', { sourceUrl }),
    entry('office', 'Office'),
  ]);
  await openProfiles(page);
  await page.getByRole('button', { name: '批量管理', exact: true }).click();
  await page.getByRole('button', { name: '仅选择当前筛选结果', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.verification/profiles-batch/mobile-batch.png',
    fullPage: true,
    animations: 'disabled',
  });
  const { content } = await downloadedArchive(
    page,
    page.getByRole('button', { name: '导出选中归档', exact: true }),
  );
  const preview = await importArchive(page, content);
  await expect(preview.locator('.profile-import-item')).toHaveCount(2);
  const first = preview.locator('.profile-import-item').first();
  await first.getByText('查看原文', { exact: true }).click();
  await expect(first).toContainText('# Keep comments and CRLF');
  await preview.getByRole('button', { name: /确认导入\s*2\s*份/ }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await preview.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(box?.height).toBeLessThanOrEqual(804);
  await page.screenshot({
    path: '.verification/profiles-batch/mobile-preview.png',
    animations: 'disabled',
  });
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  expect(await stored(page)).toHaveLength(2);
});
