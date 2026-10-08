import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  defaultGlobalProfileEnhancement,
  defaultProfileEnhancement,
  type ProfileEnhancement,
} from '../src/lib/profile-enhancement';

const controller = 'http://127.0.0.1:9090/profiles%20control';
const otherController = 'http://127.0.0.1:9091/other%20control';
const secret = 'profiles /?& secret';
const libraryKey = 'mihomo-verge.profile-library:local';
const demoLibraryKey = 'mihomo-verge.profile-library:demo';
const sourceUrl = 'https://profiles.example/subscription.yaml?token=source-secret';
const original =
  '# Preserve this comment and CRLF\r\nmixed-port: 7890\r\nmode: rule\r\ndns: &resolver\r\n  enable: true\r\n  nameserver: [1.1.1.1]\r\nproxies: []\r\nproxy-groups: []\r\nrules:\r\n  - MATCH,DIRECT\r\n';
const revised =
  '# Edited without rewriting YAML\nmode: global\nmixed-port: 7891\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n';
const browserErrors = new WeakMap<Page, string[]>();

interface Entry {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  enhancement?: ProfileEnhancement;
}

interface ApiCall {
  controller: string;
  path: string;
  method: string;
  query: string;
  body: string | null;
  authorization: string | undefined;
}

interface ResponsePlan {
  gate?: Promise<void>;
  status?: number;
  message?: string;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function entry(name = 'Saved profile', overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'saved-profile',
    name,
    description: 'A local library entry',
    content: original,
    createdAt: 1_791_435_615_000,
    updatedAt: 1_791_435_615_000,
    ...overrides,
  };
}

async function seed(page: Page, profiles: Entry[], demoProfiles: Entry[] = []) {
  await page.addInitScript(
    ({ localKey, demoKey, profiles, demoProfiles }) => {
      if (localStorage.getItem(localKey) === null)
        localStorage.setItem(localKey, JSON.stringify({ version: 1, profiles }));
      if (localStorage.getItem(demoKey) === null)
        localStorage.setItem(demoKey, JSON.stringify({ version: 1, profiles: demoProfiles }));
    },
    { localKey: libraryKey, demoKey: demoLibraryKey, profiles, demoProfiles },
  );
}

async function storedProfiles(page: Page, key = libraryKey): Promise<Entry[]> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{"profiles":[]}').profiles,
    key,
  );
}

async function mockCore(page: Page, plan: (call: ApiCall) => ResponsePlan = () => ({})) {
  const calls: ApiCall[] = [];
  const settled: ApiCall[] = [];
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
    if (request.method() !== 'GET') {
      const call = {
        controller: base,
        path,
        method: request.method(),
        query: url.search,
        body: request.postData(),
        authorization: request.headers().authorization,
      };
      calls.push(call);
      const response = plan(call);
      await response.gate;
      if (response.status && response.status >= 400)
        await route.fulfill({
          status: response.status,
          headers,
          json: { message: response.message },
        });
      else await route.fulfill({ status: 204, headers });
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
        tun: { enable: false, stack: 'mixed' },
      },
      '/proxies': { proxies: {} },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
      '/connections': { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (path in values) await route.fulfill({ headers, json: values[path] });
    else
      await route.fulfill({
        status: 404,
        headers,
        json: { message: `Unmocked profiles API: ${path}` },
      });
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

async function openProfiles(page: Page, connected = false) {
  if (connected) {
    await page.addInitScript(
      (backend) => localStorage.setItem('mihomo-verge.backend', JSON.stringify(backend)),
      { url: controller, secret },
    );
  }
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

async function connect(page: Page, target: string) {
  await page.getByRole('button', { name: '切换内核', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接到 Mihomo', exact: true });
  await dialog.getByLabel('控制器地址', { exact: false }).fill(target);
  await dialog.getByPlaceholder('输入内核设置的 secret').fill(secret);
  await dialog.getByRole('button', { name: '连接内核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
}

async function select(page: Page, name: string) {
  await page.getByRole('button', { name: `选择配置 ${name}`, exact: true }).click();
  return page.locator('.profile-detail');
}

async function saveEditor(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('.profile-card')).not.toHaveCount(0);
}

async function discardEditor(editor: Locator) {
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await editor.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(editor).not.toBeVisible();
}

async function expectDownload(page: Page, button: Locator, content: string, filename?: string) {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  if (filename) expect(download.suggestedFilename()).toBe(filename);
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toBe(content);
}

async function openMaintenance(page: Page) {
  await navigate(page, '设置');
  const section = page.locator('details').filter({ hasText: '内核维护' });
  if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
  return section;
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
});

test('imports original files, edits, duplicates, downloads, searches and persists the library', async ({
  page,
}) => {
  // Match HTTP access from another LAN device, where randomUUID is unavailable.
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  const api = await mockCore(page);
  await openProfiles(page);
  await page.getByLabel('导入 YAML 文件', { exact: true }).setInputFiles({
    name: 'Original.yml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(original),
  });
  let editor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(
    original.replaceAll('\r\n', '\n'),
  );
  await editor.getByLabel('配置名称', { exact: true }).fill('Original');
  await editor.getByLabel('描述', { exact: true }).fill('Home routing with preserved comments');
  await saveEditor(page, editor);
  let detail = await select(page, 'Original');
  await expectDownload(
    page,
    detail.getByRole('button', { name: '下载原文', exact: true }),
    original,
    'Original.yaml',
  );
  expect((await storedProfiles(page))[0]?.content).toBe(original);
  await page.reload();
  detail = await select(page, 'Original');
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await editor.getByLabel('YAML 原文', { exact: false }).fill(revised);
  await saveEditor(page, editor);
  expect((await storedProfiles(page))[0]?.content).toBe(revised);
  await detail.getByRole('button', { name: '另存副本', exact: true }).click();
  editor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(revised);
  await editor.getByLabel('配置名称', { exact: true }).fill('Travel copy');
  await editor.getByLabel('描述', { exact: true }).fill('Only this description contains cabin');
  await saveEditor(page, editor);
  await expect(page.locator('.profile-card')).toHaveCount(2);
  const search = page.getByPlaceholder('搜索配置名称或描述…');
  await search.fill('cabin');
  await expect(
    page.getByRole('button', { name: '选择配置 Travel copy', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '选择配置 Original', exact: true })).toHaveCount(0);
  await search.fill('');
  detail = await select(page, 'Travel copy');
  await expectDownload(
    page,
    detail.getByRole('button', { name: '下载原文', exact: true }),
    revised,
    'Travel copy.yaml',
  );
  await detail.getByRole('button', { name: '删除配置', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除配置', exact: true });
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.profile-card')).toHaveCount(2);
  await detail.getByRole('button', { name: '删除配置', exact: true }).click();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deletion).not.toBeVisible();
  await expect(page.locator('.profile-card')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '选择配置 Original', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择配置 Travel copy', exact: true })).toHaveCount(
    0,
  );
  expect((await storedProfiles(page)).map(({ name, content }) => ({ name, content }))).toEqual([
    { name: 'Original', content: revised },
  ]);
  expect(api.calls).toEqual([]);
});

test('failed browser storage keeps the saved library and the editable draft intact', async ({
  page,
}) => {
  await seed(page, [entry()]);
  await openProfiles(page);
  await page.evaluate((key) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (candidate, value) {
      if (candidate === key) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, candidate, value);
    };
  }, libraryKey);
  const detail = await select(page, 'Saved profile');
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await editor.getByLabel('配置名称', { exact: true }).fill('Unsaved name');
  await editor.getByLabel('YAML 原文', { exact: false }).fill(revised);
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('未保存');
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(revised);
  expect((await storedProfiles(page))[0]).toMatchObject({
    name: 'Saved profile',
    content: original,
  });
  await expectDownload(
    page,
    editor.getByRole('button', { name: '下载草稿', exact: true }),
    revised,
  );
  await discardEditor(editor);
  await expect(
    page.getByRole('button', { name: '选择配置 Saved profile', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '选择配置 Unsaved name', exact: true }),
  ).toHaveCount(0);
  await detail.getByRole('button', { name: '删除配置', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除配置', exact: true });
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deletion.getByRole('alert')).toContainText('未保存');
  expect(await storedProfiles(page)).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole('button', { name: '选择配置 Saved profile', exact: true }),
  ).toBeVisible();
});

test('imports a URL without controller credentials and reviews updates before changing saved content', async ({
  page,
}) => {
  const api = await mockCore(page);
  const sourceHeaders: Record<string, string>[] = [];
  let sourceContent = original;
  let failSource = false;
  await page.route(sourceUrl, async (route) => {
    sourceHeaders.push(route.request().headers());
    if (failSource) await route.abort('failed');
    else
      await route.fulfill({
        status: 200,
        contentType: 'application/yaml',
        headers: { 'access-control-allow-origin': '*' },
        body: sourceContent,
      });
  });
  await openProfiles(page, true);
  await page.getByRole('button', { name: '从 URL 导入', exact: true }).click();
  const sourceDialog = page.getByRole('dialog', { name: '从 URL 导入', exact: true });
  await sourceDialog.getByLabel('配置来源 URL', { exact: true }).fill(sourceUrl);
  await sourceDialog.getByRole('button', { name: '读取配置', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await expect(editor).toBeVisible();
  expect(await storedProfiles(page)).toEqual([]);
  await editor.getByLabel('配置名称', { exact: true }).fill('Remote profile');
  await saveEditor(page, editor);
  const detail = await select(page, 'Remote profile');
  expect((await storedProfiles(page))[0]).toMatchObject({ content: original, sourceUrl });
  sourceContent = revised;
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  editor = page.getByRole('dialog', { name: '审阅来源更新', exact: true });
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(revised);
  expect((await storedProfiles(page))[0]?.content).toBe(original);
  await discardEditor(editor);
  await expectDownload(
    page,
    detail.getByRole('button', { name: '下载原文', exact: true }),
    original,
  );
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  await saveEditor(page, editor);
  expect((await storedProfiles(page))[0]?.content).toBe(revised);
  failSource = true;
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('CORS');
  expect((await storedProfiles(page))[0]?.content).toBe(revised);
  expect(sourceHeaders).toHaveLength(4);
  expect(
    sourceHeaders.every((headers) => !headers.authorization && !headers.cookie && !headers.referer),
  ).toBe(true);
  expect(api.calls).toEqual([]);
});

test('late URL responses cannot reopen a closed page or overwrite the next controller session', async ({
  page,
}) => {
  await mockCore(page);
  await seed(page, [entry('Remote profile', { sourceUrl })]);
  const requests: ReturnType<typeof gate>[] = [];
  let settled = 0;
  await page.route(sourceUrl, async (route) => {
    const pending = gate();
    requests.push(pending);
    await pending.promise;
    await route.fulfill({
      status: 200,
      contentType: 'application/yaml',
      headers: { 'access-control-allow-origin': '*' },
      body: revised,
    });
    settled += 1;
  });
  await openProfiles(page, true);
  let detail = await select(page, 'Remote profile');
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await navigate(page, '概览');
  requests[0]!.release();
  await expect.poll(() => settled).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, '配置');
  detail = await select(page, 'Remote profile');
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await connect(page, otherController);
  requests[1]!.release();
  await expect.poll(() => settled).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '从来源更新', exact: true })).toBeEnabled();
  expect((await storedProfiles(page))[0]?.content).toBe(original);
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('YAML 原文', { exact: false })).toHaveValue(
    original.replaceAll('\r\n', '\n'),
  );
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await detail.getByRole('button', { name: '从来源更新', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await editor.getByLabel('配置名称', { exact: true }).fill('Keep my unsaved draft');
  await editor.getByLabel('YAML 原文', { exact: false }).fill(`# Draft wins\n${original}`);
  requests[2]!.release();
  await expect.poll(() => settled).toBe(3);
  await expect(editor.getByLabel('配置名称', { exact: true })).toHaveValue('Keep my unsaved draft');
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(
    `# Draft wins\n${original.replaceAll('\r\n', '\n')}`,
  );
  expect((await storedProfiles(page))[0]?.content).toBe(original);
});

test('late local file reads cannot replace an editor or survive navigation and controller changes', async ({
  page,
}) => {
  await mockCore(page);
  await seed(page, [entry()]);
  const reads: ReturnType<typeof gate>[] = [];
  await page.exposeFunction('readDeferredProfileFile', async () => {
    const pending = gate();
    reads.push(pending);
    await pending.promise;
    return original;
  });
  await openProfiles(page, true);
  await page.evaluate(() => {
    const context = window as unknown as {
      readDeferredProfileFile: () => Promise<string>;
      completedProfileFileReads: number;
    };
    context.completedProfileFileReads = 0;
    File.prototype.text = async function () {
      const content = await context.readDeferredProfileFile();
      context.completedProfileFileReads += 1;
      return content;
    };
  });
  async function startRead(count: number) {
    await page.getByLabel('导入 YAML 文件', { exact: true }).setInputFiles({
      name: 'Late file.yml',
      mimeType: 'application/yaml',
      buffer: Buffer.from(original),
    });
    await expect.poll(() => reads.length).toBe(count);
  }
  async function finishRead(count: number) {
    reads[count - 1]!.release();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { completedProfileFileReads: number }).completedProfileFileReads,
        ),
      )
      .toBe(count);
  }
  const detail = await select(page, 'Saved profile');
  await startRead(1);
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await editor.getByLabel('YAML 原文', { exact: false }).fill(revised);
  await finishRead(1);
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toHaveValue(revised);
  await discardEditor(editor);
  await startRead(2);
  await navigate(page, '概览');
  await finishRead(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, '配置');
  await startRead(3);
  await connect(page, otherController);
  await finishRead(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await storedProfiles(page))[0]?.content).toBe(original);
});

test('applying requires confirmation, submits exact content once and shares the maintenance lock', async ({
  page,
}) => {
  const applying = gate();
  const geo = gate();
  const api = await mockCore(page, (call) => ({
    gate: call.path === '/configs' ? applying.promise : geo.promise,
  }));
  await seed(page, [entry()]);
  await openProfiles(page, true);
  let detail = await select(page, 'Saved profile');
  await detail.getByRole('button', { name: '应用配置', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '应用配置', exact: true });
  await expect(confirmation).toContainText(controller);
  await expect(confirmation).toContainText('Saved profile');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(api.calls).toEqual([]);
  await detail.getByRole('button', { name: '应用配置', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认应用', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => api.calls.length).toBe(1);
  await expect(confirmation.getByRole('button', { name: '正在应用…', exact: true })).toBeDisabled();
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  expect(api.calls[0]).toEqual({
    controller,
    path: '/configs',
    method: 'PUT',
    query: '?force=true',
    body: JSON.stringify({ payload: original }),
    authorization: `Bearer ${secret}`,
  });
  // Hash navigation models leaving with the browser history while the modal is pending.
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(confirmation).not.toBeVisible();
  let maintenance = await openMaintenance(page);
  for (const button of await maintenance.locator('.maintenance-actions button').all())
    await expect(button).toBeDisabled();
  await navigate(page, '配置');
  detail = await select(page, 'Saved profile');
  await expect(detail.locator('.profile-applied')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeDisabled();
  applying.release();
  await expect(detail.locator('.profile-applied')).toContainText('本会话最近应用');
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeEnabled();
  maintenance = await openMaintenance(page);
  await expect(
    maintenance.getByRole('button', { name: '更新 GEO 数据', exact: true }),
  ).toBeEnabled();
  await maintenance.getByRole('button', { name: '更新 GEO 数据', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click();
  await expect.poll(() => api.calls.length).toBe(2);
  await navigate(page, '配置');
  detail = await select(page, 'Saved profile');
  await expect(detail.locator('.profile-applied')).toContainText('本会话最近应用');
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeDisabled();
  geo.release();
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeEnabled();
  expect(api.calls.map((call) => [call.path, call.method])).toEqual([
    ['/configs', 'PUT'],
    ['/configs/geo', 'POST'],
  ]);
  maintenance = await openMaintenance(page);
  await expect(maintenance.getByRole('status')).toContainText('已更新');
});

test('backend rejection preserves the library and old application responses stay with their controller', async ({
  page,
}) => {
  const oldApplication = gate();
  let hold = false;
  const api = await mockCore(page, (call) => ({
    gate: hold && call.controller === controller ? oldApplication.promise : undefined,
    status: 400,
    message: hold ? 'Old controller application failed' : 'Invalid proxy reference from core',
  }));
  await seed(page, [entry()]);
  await openProfiles(page, true);
  let detail = await select(page, 'Saved profile');
  await detail.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid proxy reference from core');
  expect((await storedProfiles(page))[0]?.content).toBe(original);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '确认应用', exact: true }),
  ).toBeEnabled();
  hold = true;
  await page.getByRole('dialog').getByRole('button', { name: '确认应用', exact: true }).click();
  await expect.poll(() => api.calls.length).toBe(2);
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await connect(page, otherController);
  oldApplication.release();
  await expect.poll(() => api.settled.length).toBe(2);
  await expect(page.getByText('Old controller application failed', { exact: false })).toHaveCount(
    0,
  );
  await navigate(page, '配置');
  detail = await select(page, 'Saved profile');
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeEnabled();
  expect(api.calls.every((call) => call.controller === controller)).toBe(true);
});

test('enhanced application submits the reviewed generated YAML and keeps original source and enhancement identity', async ({
  page,
}) => {
  const api = await mockCore(page);
  const enhancement = {
    ...defaultProfileEnhancement(),
    merge: { enabled: true, content: 'mode: global\ntun: {mtu: 1400}\n' },
    script: {
      enabled: true,
      content:
        'function main(config, name) { console.info(name); config["profile-result"] = name; return config; }',
    },
  };
  const global = {
    ...defaultGlobalProfileEnhancement(),
    merge: { enabled: true, content: 'mode: direct\ntun: {enable: true}\n' },
  };
  const globalKey = 'mihomo-verge.profile-enhancement:local';
  await seed(page, [entry('Saved profile', { enhancement })]);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: globalKey,
    value: global,
  });
  await openProfiles(page, true);
  const detail = await select(page, 'Saved profile');
  await detail.getByRole('button', { name: '应用配置', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '应用配置', exact: true });
  await expect(preview.getByRole('button', { name: '确认应用', exact: true })).toBeEnabled();
  await expect(preview).toContainText('已生成增强配置');
  const generated = await preview
    .locator('.profile-apply-preview')
    .first()
    .locator('pre')
    .textContent();
  expect(parse(generated!)).toMatchObject({
    mode: 'global',
    tun: { enable: true, mtu: 1400 },
    'profile-result': 'Saved profile',
  });
  expect(api.calls).toEqual([]);
  await preview.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(api.calls).toHaveLength(1);
  expect(JSON.parse(api.calls[0]!.body!)).toEqual({ payload: generated });
  expect((await storedProfiles(page))[0]).toMatchObject({ content: original, enhancement });
  await expect(detail.locator('.profile-applied')).toBeVisible();
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    },
    { key: globalKey, value: { ...global, merge: { enabled: true, content: 'mode: rule\n' } } },
  );
  await expect(detail.locator('.profile-applied')).toHaveCount(0);
  await expect(page.locator('.profile-card-applied')).toHaveCount(0);
});

test('invalid scripts and changed enhancement snapshots cannot be applied as the original configuration', async ({
  page,
}) => {
  const api = await mockCore(page);
  await seed(page, [
    entry('Saved profile', {
      enhancement: {
        ...defaultProfileEnhancement(),
        script: {
          enabled: true,
          content:
            'function main() { console.warn("before-failure-marker"); throw new Error("script-failed-marker"); }',
        },
      },
    }),
  ]);
  await openProfiles(page, true);
  const detail = await select(page, 'Saved profile');
  await detail.getByRole('button', { name: '应用配置', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '应用配置', exact: true });
  await expect(preview.getByRole('alert')).toContainText('script-failed-marker');
  await expect(preview.locator('.profile-code')).toContainText('before-failure-marker');
  await expect(preview.getByRole('button', { name: '确认应用', exact: true })).toBeDisabled();
  expect(api.calls).toEqual([]);
  const replaceEnhancement = async (content: string) =>
    page.evaluate(
      ({ key, content }) => {
        const library = JSON.parse(localStorage.getItem(key)!);
        library.profiles[0].enhancement.script = { enabled: true, content };
        localStorage.setItem(key, JSON.stringify(library));
        window.dispatchEvent(new StorageEvent('storage', { key }));
      },
      { key: libraryKey, content },
    );
  await replaceEnhancement('function main(config) { config.mode = "global"; return config; }');
  await preview.getByRole('button', { name: '重新生成预览', exact: true }).click();
  await expect(preview.getByRole('button', { name: '确认应用', exact: true })).toBeEnabled();
  await replaceEnhancement('function main(config) { config.mode = "direct"; return config; }');
  await preview.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('配置或增强已改变');
  await expect(preview.getByRole('button', { name: '确认应用', exact: true })).toBeDisabled();
  expect(api.calls).toEqual([]);
  await preview.getByRole('button', { name: '重新生成预览', exact: true }).click();
  await expect(preview.getByRole('button', { name: '确认应用', exact: true })).toBeEnabled();
  await preview.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(api.calls).toHaveLength(1);
  expect(parse(JSON.parse(api.calls[0]!.body!).payload).mode).toBe('direct');
  expect((await storedProfiles(page))[0]!.content).toBe(original);
});

test('archive global enhancement restore is opt-in and a second storage failure rolls the profile import back', async ({
  page,
}) => {
  const globalKey = 'mihomo-verge.profile-enhancement:local';
  const incomingGlobal = {
    ...defaultGlobalProfileEnhancement(),
    merge: { enabled: true, content: 'mode: global\n' },
  };
  const incomingProfile = {
    ...entry('Incoming'),
    enhancement: {
      ...defaultProfileEnhancement(),
      merge: { enabled: true, content: 'ipv6: true\n' },
    },
  };
  await seed(page, [entry()]);
  await openProfiles(page);
  const archive = {
    format: 'mihomo-verge-profile-archive',
    version: 1,
    profiles: [incomingProfile],
    globalEnhancement: incomingGlobal,
  };
  const importArchive = async () =>
    page.getByLabel('导入配置归档', { exact: true }).setInputFiles({
      name: 'archive.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(archive)),
    });
  await importArchive();
  let preview = page.getByRole('dialog', { name: '导入配置预览', exact: true });
  await expect(
    preview.getByRole('checkbox', { name: /同时恢复归档中的全局增强/ }),
  ).not.toBeChecked();
  await preview.getByRole('button', { name: '确认导入 1 份', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), globalKey)).toBeNull();
  expect((await storedProfiles(page))[0]!.enhancement).toEqual(incomingProfile.enhancement);
  const before = await storedProfiles(page);
  await importArchive();
  preview = page.getByRole('dialog', { name: '导入配置预览', exact: true });
  await preview.getByRole('checkbox', { name: /同时恢复归档中的全局增强/ }).check();
  await page.evaluate((key) => {
    const setItem = Storage.prototype.setItem;
    (window as any).restoreGlobalStorage = () => {
      Storage.prototype.setItem = setItem;
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, globalKey);
  await preview.getByRole('button', { name: '确认导入 1 份', exact: true }).click();
  await expect(preview.getByRole('alert')).toBeVisible();
  expect(await storedProfiles(page)).toEqual(before);
  expect(await page.evaluate((key) => localStorage.getItem(key), globalKey)).toBeNull();
  await page.evaluate(() => (window as any).restoreGlobalStorage());
  await preview.getByRole('button', { name: '确认导入 1 份', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(await storedProfiles(page)).toHaveLength(before.length + 1);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), globalKey)).toEqual(
    incomingGlobal,
  );
  const beforePartial = await storedProfiles(page);
  await importArchive();
  await preview.getByRole('checkbox', { name: /同时恢复归档中的全局增强/ }).check();
  await page.evaluate(
    ({ globalKey, libraryKey }) => {
      const setItem = Storage.prototype.setItem;
      let libraryWrites = 0;
      (window as any).restoreGlobalStorage = () => {
        Storage.prototype.setItem = setItem;
      };
      Storage.prototype.setItem = function (name, value) {
        if (name === libraryKey) libraryWrites++;
        if (name === globalKey || (name === libraryKey && libraryWrites > 1))
          throw new DOMException('Storage unavailable during rollback', 'QuotaExceededError');
        return setItem.call(this, name, value);
      };
    },
    { globalKey, libraryKey },
  );
  await preview.getByRole('button', { name: '确认导入 1 份', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('回滚也未完成');
  await expect(preview.getByRole('button', { name: '确认导入 1 份', exact: true })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '下载草稿归档', exact: true })).toBeEnabled();
  expect(await storedProfiles(page)).toHaveLength(beforePartial.length + 1);
  await page.evaluate(() => (window as any).restoreGlobalStorage());
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await storedProfiles(page)).toHaveLength(beforePartial.length + 1);
});

test('demo profiles are isolated from the real library and never apply to the controller', async ({
  page,
}) => {
  const api = await mockCore(page);
  await seed(
    page,
    [entry('Private real profile')],
    [entry('Demo-only profile', { id: 'demo-profile', content: revised })],
  );
  await page.goto('/');
  await page.getByRole('button', { name: '体验演示', exact: true }).click();
  await navigate(page, '配置');
  const detail = await select(page, 'Demo-only profile');
  await expect(
    page.getByRole('button', { name: '选择配置 Private real profile', exact: true }),
  ).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '应用配置', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await editor.getByLabel('描述', { exact: true }).fill('Edited in demo');
  await saveEditor(page, editor);
  expect((await storedProfiles(page, demoLibraryKey))[0]?.description).toBe('Edited in demo');
  expect((await storedProfiles(page))[0]).toMatchObject({
    name: 'Private real profile',
    content: original,
    description: 'A local library entry',
  });
  expect(api.calls).toEqual([]);
  await connect(page, controller);
  await expect(
    page.getByRole('button', { name: '选择配置 Private real profile', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '选择配置 Demo-only profile', exact: true }),
  ).toHaveCount(0);
  expect(api.calls).toEqual([]);
});

test('390px layout keeps profile details and the YAML editor usable without document overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [
    entry('Travel / a very long configuration name for narrow screens', {
      description: 'A long description describing the current profile and its routing preferences.',
      sourceUrl,
    }),
    entry('Office profile', { id: 'office-profile', content: revised }),
  ]);
  await openProfiles(page);
  const detail = await select(page, 'Travel / a very long configuration name for narrow screens');
  await expect(detail).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: '.verification/profiles/mobile-library.png',
    fullPage: true,
    animations: 'disabled',
  });
  await detail.getByRole('button', { name: '编辑原文', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑配置', exact: true });
  await expect(editor.getByLabel('YAML 原文', { exact: false })).toBeVisible();
  await editor.getByLabel('YAML 原文', { exact: false }).fill(revised);
  await editor.getByRole('button', { name: '保存配置', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const editorBox = await editor.boundingBox();
  expect(editorBox?.y).toBeGreaterThanOrEqual(0);
  expect(editorBox?.height).toBeLessThanOrEqual(804);
  await page.screenshot({
    path: '.verification/profiles/mobile-editor.png',
    animations: 'disabled',
  });
  await saveEditor(page, editor);
  expect(
    (await storedProfiles(page)).find((profile) => profile.name.startsWith('Travel'))?.content,
  ).toBe(revised);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: '.verification/profiles/desktop-library.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: '.verification/profiles/desktop-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
});
