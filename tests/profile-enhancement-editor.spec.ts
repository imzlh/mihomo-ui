import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const controller = 'http://127.0.0.1:9090/enhancement';
const libraryKey = 'mihomo-verge.profile-library:local';
const globalKey = 'mihomo-verge.profile-enhancement:local';
const original =
  '# Keep this original comment and CRLF\r\nmode: rule\r\nproxies:\r\n  - { name: Old node, type: http, server: old.example, port: 8080 }\r\nproxy-groups:\r\n  - { name: Old group, type: select, proxies: [DIRECT] }\r\nrules:\r\n  - DOMAIN,old.example,DIRECT\r\n  - MATCH,DIRECT\r\n';

interface Source {
  enabled: boolean;
  content: string;
}

interface GlobalEnhancement {
  version: 1;
  merge: Source;
  script: Source;
}

interface ProfileEnhancement extends GlobalEnhancement {
  rules: Source;
  proxies: Source;
  groups: Source;
}

interface Entry {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  enhancement?: ProfileEnhancement;
}

const browserErrors = new WeakMap<Page, string[]>();
const coreWrites = new WeakMap<Page, string[]>();
const source = (content = '', enabled = false): Source => ({ enabled, content });
const defaultGlobal = (): GlobalEnhancement => ({
  version: 1,
  merge: source(),
  script: source(),
});

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'saved-profile',
    name: 'Saved profile',
    description: 'Original content stays separate from enhancement sources',
    content: original,
    createdAt: 1_791_435_615_000,
    updatedAt: 1_791_435_615_000,
    ...overrides,
  };
}

async function seed(page: Page, profiles = [entry()], global = defaultGlobal()) {
  await page.addInitScript(
    ({ libraryKey, globalKey, controller, profiles, global }) => {
      if (localStorage.getItem(libraryKey) === null)
        localStorage.setItem(libraryKey, JSON.stringify({ version: 1, profiles }));
      if (localStorage.getItem(globalKey) === null)
        localStorage.setItem(globalKey, JSON.stringify(global));
      localStorage.setItem(
        'mihomo-verge.backend',
        JSON.stringify({ url: controller, secret: 'enhancement-secret' }),
      );
    },
    { libraryKey, globalKey, controller, profiles, global },
  );
}

async function storedProfiles(page: Page): Promise<Entry[]> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{"profiles":[]}').profiles,
    libraryKey,
  );
}

async function storedGlobal(page: Page): Promise<GlobalEnhancement> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), globalKey);
}

async function openProfiles(page: Page) {
  await page.goto('/#/profiles');
  await expect(page.getByRole('heading', { name: '配置', exact: true })).toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('内核已连接');
}

async function openGlobal(page: Page) {
  await page.getByRole('button', { name: '全局增强', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '全局增强', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function openProfile(page: Page, name = 'Saved profile') {
  await page.getByRole('button', { name: `选择配置 ${name}`, exact: true }).click();
  await page
    .locator('.profile-detail')
    .getByRole('button', { name: '配置增强', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: `配置增强 · ${name}`, exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function editSource(editor: Locator, label: string, content: string, enabled = true) {
  await editor.getByRole('tab', { name: label, exact: true }).click();
  const toggle = editor.getByRole('switch', { name: `启用 ${label}`, exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click();
  await editor.getByRole('textbox', { name: `${label} 内容`, exact: true }).fill(content);
}

async function runPreview(editor: Locator) {
  await editor.getByRole('button', { name: '运行预览', exact: true }).click();
  const result = editor.getByRole('textbox', { name: '最终配置', exact: true });
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute('readonly', '');
  await expect(editor.getByRole('button', { name: '下载结果', exact: true })).toBeEnabled();
  return result.inputValue();
}

async function expectNoResult(editor: Locator) {
  await expect(editor.getByRole('textbox', { name: '最终配置', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '下载结果', exact: true })).toHaveCount(0);
}

async function saveEnhancement(editor: Locator) {
  await editor.getByRole('button', { name: '保存增强', exact: true }).click();
  await expect(editor).not.toBeVisible();
}

async function downloadedText(page: Page, button: Locator) {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.ya?ml$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const writes: string[] = [];
  browserErrors.set(page, errors);
  coreWrites.set(page, writes);
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  await page.route(/^http:\/\/127\.0\.0\.1:9090\//, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
      await route.fulfill({ status: 204, headers });
      return;
    }
    const path = new URL(request.url()).pathname.slice('/enhancement'.length);
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
    else await route.fulfill({ status: 404, headers, json: { message: `Unmocked API ${path}` } });
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9090\//, (socket) => {
    const path = new URL(socket.url()).pathname.split('/').at(-1)!;
    const values: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 4096 },
      connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (path in values) socket.send(JSON.stringify(values[path]));
  });
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page), 'No uncaught browser errors').toEqual([]);
  expect(coreWrites.get(page), 'Editing, saving and previewing never writes to the core').toEqual(
    [],
  );
});

test('global and profile sources compile in order while saves and copies preserve original YAML', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  const globalMerge = 'mode: direct\nx-order: [global-merge]\n';
  const globalScript = `function main(config) {
  config['x-order'].push('global-script');
  config['x-lists-before-global'] = {
    rule: config.rules[0],
    proxy: config.proxies[0].name,
    group: config['proxy-groups'][0].name,
  };
  console.log('global script completed');
  return config;
}`;
  let editor = await openGlobal(page);
  await expect(editor.getByRole('tab')).toHaveCount(2);
  await expect(editor.getByRole('tab', { name: 'Merge', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await editSource(editor, 'Merge', globalMerge);
  await editSource(editor, 'Script', globalScript);
  const globalResult = parse(await runPreview(editor));
  expect(globalResult.mode).toBe('direct');
  expect(globalResult['x-order']).toEqual(['global-merge', 'global-script']);
  expect((await storedGlobal(page)).merge.enabled).toBe(false);
  await saveEnhancement(editor);
  expect(await storedGlobal(page)).toEqual({
    version: 1,
    merge: source(globalMerge, true),
    script: source(globalScript, true),
  });

  const rules =
    'prepend:\n  - DOMAIN,enhanced.example,Enhanced\nappend: []\ndelete:\n  - DOMAIN,old.example,DIRECT\n';
  const proxies =
    'prepend:\n  - { name: Node Added, type: http, server: proxy.example, port: 8080 }\nappend: []\ndelete: [Old node]\n';
  const groups =
    'prepend:\n  - { name: Enhanced, type: select, proxies: [Node Added, DIRECT] }\nappend: []\ndelete: [Old group]\n';
  const merge = 'mode: global\nx-profile-merge: true\n';
  const script = `function main(config) {
  if (!config['x-profile-merge']) throw new Error('Profile merge must run before its script');
  config['x-order'].push('profile-merge', 'profile-script');
  console.info('profile script completed');
  return config;
}`;
  editor = await openProfile(page);
  await expect(editor.getByRole('tab')).toHaveCount(5);
  await expect(editor.getByRole('tab', { name: '规则', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (const [label, content] of [
    ['规则', rules],
    ['代理', proxies],
    ['代理组', groups],
    ['Merge', merge],
    ['Script', script],
  ])
    await editSource(editor, label!, content!);
  const resultText = await runPreview(editor);
  const result = parse(resultText);
  expect(result.mode).toBe('global');
  expect(result['x-order']).toEqual([
    'global-merge',
    'global-script',
    'profile-merge',
    'profile-script',
  ]);
  expect(result['x-lists-before-global']).toEqual({
    rule: 'DOMAIN,enhanced.example,Enhanced',
    proxy: 'Node Added',
    group: 'Enhanced',
  });
  expect(result.rules).toEqual(['DOMAIN,enhanced.example,Enhanced', 'MATCH,DIRECT']);
  expect(result.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['Node Added']);
  expect(result['proxy-groups'].map((group: { name: string }) => group.name)).toEqual(['Enhanced']);
  expect(
    await downloadedText(page, editor.getByRole('button', { name: '下载结果', exact: true })),
  ).toBe(resultText);
  await editor.getByRole('button', { name: /^阶段与日志/ }).click();
  await expect(editor).toContainText('global script completed');
  await expect(editor).toContainText('profile script completed');
  expect((await storedProfiles(page))[0]?.enhancement).toBeUndefined();
  await saveEnhancement(editor);
  const saved = (await storedProfiles(page))[0]!;
  expect(saved.content).toBe(original);
  expect(saved.enhancement).toEqual({
    version: 1,
    rules: source(rules, true),
    proxies: source(proxies, true),
    groups: source(groups, true),
    merge: source(merge, true),
    script: source(script, true),
  });

  const detail = page.locator('.profile-detail');
  expect(
    await downloadedText(page, detail.getByRole('button', { name: '下载原文', exact: true })),
  ).toBe(original);
  await detail.getByRole('button', { name: '另存副本', exact: true }).click();
  const originalEditor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await originalEditor.getByLabel('配置名称', { exact: true }).fill('Enhanced copy');
  await originalEditor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(originalEditor).not.toBeVisible();
  const copy = (await storedProfiles(page)).find((profile) => profile.name === 'Enhanced copy');
  expect(copy?.content).toBe(original);
  expect(copy?.enhancement).toEqual(saved.enhancement);
  await page.reload();
  editor = await openProfile(page, 'Enhanced copy');
  await editor.getByRole('tab', { name: 'Script', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Script 内容', exact: true })).toHaveValue(
    script,
  );
  expect(parse(await runPreview(editor))['x-order']).toEqual(result['x-order']);
});

test('scripts are not executed by typing, switching stages, saving or reopening an enhancement', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.clock.install();
  await seed(page);
  await openProfiles(page);
  const script =
    "function main(config) { throw new Error('Only explicit preview executes this script'); }";
  let editor = await openProfile(page);
  await editSource(editor, 'Script', script);
  await editor.getByRole('tab', { name: 'Merge', exact: true }).click();
  await page.clock.runFor(2_000);
  await expectNoResult(editor);
  await expect(editor.getByRole('alert')).toHaveCount(0);
  expect(workers).toEqual([]);
  await saveEnhancement(editor);
  expect((await storedProfiles(page))[0]?.enhancement?.script).toEqual(source(script, true));
  editor = await openProfile(page);
  await page.clock.runFor(2_000);
  expect(workers).toEqual([]);
  await editor.getByRole('button', { name: '运行预览', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(
    'Only explicit preview executes this script',
  );
  expect(workers).toHaveLength(1);
  await expectNoResult(editor);
});

test('editing a source or its enabled state discards the prior downloadable preview', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  const editor = await openProfile(page);
  await editSource(editor, 'Merge', 'mode: global\n');
  expect(parse(await runPreview(editor)).mode).toBe('global');
  await editor.getByRole('textbox', { name: 'Merge 内容', exact: true }).fill('mode: direct\n');
  await expectNoResult(editor);
  expect(parse(await runPreview(editor)).mode).toBe('direct');
  await editor.getByRole('switch', { name: '启用 Merge', exact: true }).click();
  await expectNoResult(editor);
  expect(parse(await runPreview(editor)).mode).toBe('rule');
  await editor.getByRole('tab', { name: 'Script', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '最终配置', exact: true })).toBeVisible();
  await editor
    .getByRole('textbox', { name: 'Script 内容', exact: true })
    .fill('function main(config) { return config; }');
  await expectNoResult(editor);
  expect((await storedProfiles(page))[0]?.enhancement).toBeUndefined();
});

test('external source and global enhancement changes invalidate a saved preview without replacing its draft', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  const editor = await openProfile(page);
  await editSource(editor, 'Merge', 'x-draft: preserved\n');
  await runPreview(editor);
  await page.evaluate(() => {
    const key = 'mihomo-verge.profile-enhancement:local';
    const value = {
      version: 1,
      merge: { enabled: true, content: 'x-external: true\n' },
      script: { enabled: false, content: '' },
    };
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  await expectNoResult(editor);
  const result = parse(await runPreview(editor));
  expect(result['x-external']).toBe(true);
  expect(result['x-draft']).toBe('preserved');
  await page.evaluate(() => {
    const key = 'mihomo-verge.profile-library:local';
    const library = JSON.parse(localStorage.getItem(key)!);
    library.profiles[0].content += '\nx-source: updated\n';
    localStorage.setItem(key, JSON.stringify(library));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  await expectNoResult(editor);
  expect(parse(await runPreview(editor))['x-source']).toBe('updated');
  await expect(editor.getByRole('textbox', { name: 'Merge 内容', exact: true })).toHaveValue(
    'x-draft: preserved\n',
  );
});

test('a failed script cannot expose the previous successful result or a download', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  const editor = await openProfile(page);
  await editSource(
    editor,
    'Script',
    "function main(config) { config['x-preview'] = 'successful'; return config; }",
  );
  expect(parse(await runPreview(editor))['x-preview']).toBe('successful');
  await editSource(
    editor,
    'Script',
    "function main(config) { console.warn('before failure'); throw new Error('Deliberate preview failure'); }",
  );
  await expectNoResult(editor);
  await editor.getByRole('button', { name: '运行预览', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Deliberate preview failure');
  await expect(editor.getByRole('button', { name: '运行预览', exact: true })).toBeEnabled();
  await expectNoResult(editor);
  expect((await storedProfiles(page))[0]?.content).toBe(original);
});

test('cancelling and editing a running script terminate its worker and never publish stale results', async ({
  page,
}) => {
  await seed(page);
  await openProfiles(page);
  const editor = await openProfile(page);
  await editSource(editor, 'Script', 'function main(config) { while (true) {} }');
  const firstWorker = page.waitForEvent('worker');
  await editor.getByRole('button', { name: '运行预览', exact: true }).click();
  const cancelledWorker = await firstWorker;
  const cancelled = new Promise<void>((resolve) => cancelledWorker.once('close', () => resolve()));
  await editor.getByRole('button', { name: '取消预览', exact: true }).click();
  await cancelled;
  await expect(editor.getByRole('button', { name: '运行预览', exact: true })).toBeEnabled();
  await expectNoResult(editor);

  const secondWorker = page.waitForEvent('worker');
  await editor.getByRole('button', { name: '运行预览', exact: true }).click();
  const obsoleteWorker = await secondWorker;
  const aborted = new Promise<void>((resolve) => obsoleteWorker.once('close', () => resolve()));
  await editor
    .getByRole('textbox', { name: 'Script 内容', exact: true })
    .fill("function main(config) { config['x-preview'] = 'latest draft'; return config; }");
  await aborted;
  await expect(editor.getByRole('button', { name: '运行预览', exact: true })).toBeEnabled();
  await expectNoResult(editor);
  expect(parse(await runPreview(editor))['x-preview']).toBe('latest draft');
  expect((await storedProfiles(page))[0]?.enhancement).toBeUndefined();
});

test('390px enhancement editors keep all stages, preview and actions within the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = 'Travel / a very long configuration name for the enhancement editor';
  await seed(page, [entry({ name })]);
  await openProfiles(page);
  let editor = await openProfile(page, name);
  for (const label of ['规则', '代理', '代理组', 'Merge', 'Script']) {
    const tab = editor.getByRole('tab', { name: label, exact: true });
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(editor.getByRole('textbox', { name: `${label} 内容`, exact: true })).toBeVisible();
  }
  await editSource(editor, 'Merge', `mode: global\nx-long-value: ${'long-value-'.repeat(100)}\n`);
  expect(parse(await runPreview(editor)).mode).toBe('global');
  await editor.getByRole('button', { name: '保存增强', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const box = await editor.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(box?.height).toBeLessThanOrEqual(844);
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({
    path: '.verification/profiles/mobile-enhancement-preview.png',
    animations: 'disabled',
  });
  await saveEnhancement(editor);
  editor = await openGlobal(page);
  await editSource(editor, 'Script', 'function main(config) { return config; }');
  await runPreview(editor);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await saveEnhancement(editor);
});
