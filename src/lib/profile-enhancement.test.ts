import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  ProfileCompileError,
  compileProfile,
  defaultGlobalProfileEnhancement,
  defaultProfileEnhancement,
  globalProfileEnhancementKey,
  isProfileEnhancement,
  parseProfileYaml,
  readGlobalProfileEnhancement,
  writeGlobalProfileEnhancement,
  type EnhancementSource,
  type ProfileEnhancement,
} from './profile-enhancement';
import { runProfileScript } from './profile-script';

vi.mock('./profile-script', () => ({ runProfileScript: vi.fn() }));
const enabled = (content: string): EnhancementSource => ({ enabled: true, content });
const seq = (prepend: unknown[] = [], append: unknown[] = [], deleted: string[] = []) =>
  enabled(stringify({ prepend, append, delete: deleted }));
const enhancement = (values: Partial<ProfileEnhancement> = {}): ProfileEnhancement => ({
  ...defaultProfileEnhancement(),
  ...values,
});
const compile = (content: string, values: Partial<ProfileEnhancement>) =>
  compileProfile({ content, profileName: '测试配置', enhancement: enhancement(values) });

beforeEach(() => vi.resetAllMocks());

describe('profile enhancement compilation', () => {
  it('preserves original YAML byte-for-byte when all stages are disabled', async () => {
    const content = '# 注释\r\nMODE: "rule"\r\ndefaults: &base {interval: 30}\r\ncopy: *base\r\n';
    const values = enhancement({ merge: { enabled: false, content: 'invalid: [' } });
    const result = await compileProfile({
      content,
      profileName: 'No scripts',
      enhancement: values,
    });
    expect(result).toEqual({ content, logs: [], stages: [], changedKeys: [] });
    expect(runProfileScript).not.toHaveBeenCalled();
  });

  it('merges recursively, replaces hosts, shallow-merges dns and retains null as a value', async () => {
    const result = await compile(
      stringify({
        mode: 'rule',
        hosts: { old: '1.1.1.1' },
        dns: {
          enable: true,
          'nameserver-policy': { old: 'a' },
          'fallback-filter': { geoip: true },
        },
        nested: { dns: { one: true }, hosts: { old: true }, keep: 1, remove: 2 },
        rules: ['MATCH,DIRECT'],
      }),
      {
        merge: enabled(
          stringify({
            MODE: 'direct',
            HOSTS: { next: '2.2.2.2' },
            DNS: { 'nameserver-policy': { next: 'b' } },
            nested: { dns: { two: true }, hosts: { next: true }, remove: null },
            rules: ['MATCH,REJECT'],
            'prepend-rules': ['ordinary field'],
          }),
        ),
      },
    );
    expect(parse(result.content)).toEqual({
      mode: 'direct',
      hosts: { next: '2.2.2.2' },
      dns: { enable: true, 'nameserver-policy': { next: 'b' }, 'fallback-filter': { geoip: true } },
      nested: {
        dns: { one: true, two: true },
        hosts: { old: true, next: true },
        keep: 1,
        remove: null,
      },
      rules: ['MATCH,REJECT'],
      'prepend-rules': ['ordinary field'],
    });
    expect(result.stages.map((stage) => stage.id)).toEqual(['profile-merge', 'cleanup']);
  });

  it('runs Seq before global stages and then profile merge/script, lowercasing only top-level ASCII script keys', async () => {
    const global = defaultGlobalProfileEnhancement();
    global.merge = enabled('rules: [global]\nx-order: [global-merge]\n');
    global.script = enabled('global script');
    vi.mocked(runProfileScript)
      .mockImplementationOnce(async ({ config, profileName }) => {
        expect(profileName).toBe('测试配置');
        expect(config.rules).toEqual(['global']);
        expect(config.mode).toBe('rule');
        expect(config.MODE).toBeUndefined();
        return {
          ok: true,
          config: {
            ...config,
            'x-order': [...(config['x-order'] as string[]), 'global-script'],
            NewField: { InnerCase: 1 },
            ÄKey: true,
          },
          logs: [{ level: 'info', message: 'global log' }],
        };
      })
      .mockImplementationOnce(async ({ config }) => {
        expect(config['x-order']).toEqual(['profile-merge']);
        expect(config.newfield).toEqual({ InnerCase: 1 });
        expect(config['Äkey']).toBe(true);
        return {
          ok: true,
          config: { ...config, 'x-order': [...(config['x-order'] as string[]), 'profile-script'] },
          logs: [],
        };
      });
    const result = await compileProfile({
      content: 'MODE: rule\nrules: [base]\n',
      profileName: '测试配置',
      global,
      enhancement: enhancement({
        rules: seq(['seq']),
        proxies: seq(),
        groups: seq(),
        merge: enabled('x-order: [profile-merge]\n'),
        script: enabled('profile script'),
      }),
    });
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'rules',
      'proxies',
      'groups',
      'global-merge',
      'global-script',
      'profile-merge',
      'profile-script',
      'cleanup',
    ]);
    expect(parse(result.content)['x-order']).toEqual(['profile-merge', 'profile-script']);
    expect(result.logs).toEqual([{ level: 'info', message: 'global log', stage: 'global-script' }]);
  });

  it('deletes matching existing strings/names while preserving all prepended/appended entries and duplicates', async () => {
    const result = await compile(
      stringify({ rules: ['drop', { name: 'drop' }, 42, { other: 'keep' }, 'keep', 'keep'] }),
      {
        rules: seq(['drop'], ['drop', 'keep'], ['drop']),
      },
    );
    expect(parse(result.content).rules).toEqual([
      'drop',
      42,
      { other: 'keep' },
      'keep',
      'keep',
      'drop',
      'keep',
    ]);
  });

  it('inserts added names only into the first existing selector and deletes references from all old groups', async () => {
    const result = await compile(
      stringify({
        proxies: [{ name: 'old' }, { name: 'keep' }, { name: 'keep' }],
        'proxy-groups': [
          { name: 'auto', type: 'url-test', proxies: ['old', 'keep', 'keep'] },
          { name: 'first', type: 'SELECTOR', proxies: ['old', 'keep', 'keep', 5, 5] },
          { name: 'second', type: 'select', proxies: ['old', 'keep', 'keep'] },
        ],
      }),
      {
        proxies: seq([{ name: 'old' }, { name: 'new' }], [{ name: 'new' }, 'string-node'], ['old']),
        groups: seq([], [{ name: 'later', type: 'select', proxies: ['old', 'keep'] }]),
      },
    );
    const value = parse(result.content);
    expect(
      value.proxies.map((entry: { name: string } | string) =>
        typeof entry === 'string' ? entry : entry.name,
      ),
    ).toEqual(['old', 'new', 'keep', 'keep', 'new', 'string-node']);
    expect(value['proxy-groups'].map((group: { proxies: unknown[] }) => group.proxies)).toEqual([
      ['keep', 'keep'],
      ['old', 'new', 'string-node', 'keep', 5, 5],
      ['keep', 'keep'],
      ['old', 'keep'],
    ]);
  });

  it('does not create or deduplicate selector references when there are no named additions', async () => {
    const result = await compile(
      stringify({
        proxies: ['keep'],
        'proxy-groups': [
          { name: 'missing', type: 'select' },
          { name: 'existing', type: 'selector', proxies: ['keep', 'keep'] },
        ],
      }),
      { proxies: seq([42]) },
    );
    expect(parse(result.content)['proxy-groups']).toEqual([
      { name: 'missing', type: 'select' },
      { name: 'existing', type: 'selector', proxies: ['keep', 'keep'] },
    ]);
  });

  it('uses empty arrays for malformed Seq targets and does not create a selector group', async () => {
    const result = await compile('proxies: malformed\n', { proxies: seq(['node']) });
    expect(parse(result.content)).toEqual({ proxies: ['node'] });
  });

  it.each([{ deleted: [] }, { deleted: ['drop'] }])(
    'does not rewrite non-array references or deduplicate groups for empty/delete-only patches: %j',
    async ({ deleted }) => {
      const result = await compile(
        stringify({
          proxies: ['keep', 'drop'],
          'proxy-groups': [
            { name: 'first', type: 'select', proxies: 'untouched' },
            { name: 'second', type: 'select', proxies: ['keep', 'keep', 'drop'] },
          ],
        }),
        { proxies: seq([], [], deleted) },
      );
      expect(parse(result.content)['proxy-groups']).toEqual([
        { name: 'first', type: 'select', proxies: 'untouched' },
        {
          name: 'second',
          type: 'select',
          proxies: deleted.length ? ['keep', 'keep'] : ['keep', 'keep', 'drop'],
        },
      ]);
    },
  );

  it('cleans group references using all final nodes/groups/providers/builtins and retains provider-derived names', async () => {
    const result = await compile(
      stringify({
        proxies: ['string-node', { name: 'node' }],
        'proxy-providers': { provider: {} },
        'proxy-groups': [
          {
            name: 'with-provider',
            use: ['provider', 'invalid', 9],
            proxies: ['dynamic', 'invalid'],
          },
          {
            name: 'plain',
            use: ['invalid', 5],
            proxies: [
              'invalid',
              'string-node',
              'node',
              'with-provider',
              'provider',
              'DIRECT',
              'REJECT',
              'REJECT-DROP',
              'PASS',
              'PASS-RULE',
              9,
              9,
            ],
          },
          'not-a-group',
          { name: 'other', use: 'untouched', proxies: 'untouched' },
        ],
        rules: ['MATCH,invalid'],
      }),
      { merge: enabled('{}') },
    );
    const value = parse(result.content);
    expect(value['proxy-groups'][0]).toEqual({
      name: 'with-provider',
      use: ['provider'],
      proxies: ['dynamic', 'invalid'],
    });
    expect(value['proxy-groups'][1]).toEqual({
      name: 'plain',
      use: [],
      proxies: [
        'string-node',
        'node',
        'with-provider',
        'provider',
        'DIRECT',
        'REJECT',
        'REJECT-DROP',
        'PASS',
        'PASS-RULE',
        9,
        9,
      ],
    });
    expect(value['proxy-groups'][3]).toEqual({
      name: 'other',
      use: 'untouched',
      proxies: 'untouched',
    });
    expect(value.rules).toEqual(['MATCH,invalid']);
  });

  it('reports removed top-level keys while ignoring property-order-only changes', async () => {
    vi.mocked(runProfileScript).mockResolvedValue({
      ok: true,
      config: { nested: { second: 2, first: 1 } },
      logs: [],
    });
    const result = await compile('removed: true\nnested: {first: 1, second: 2}\n', {
      script: enabled('script'),
    });
    expect(result.changedKeys).toEqual(['removed']);
    expect(result.stages[0]?.changedKeys).toEqual(['removed']);
  });

  it('keeps completed stage records and script logs on failure without returning partially generated YAML', async () => {
    vi.mocked(runProfileScript).mockResolvedValue({
      ok: false,
      error: 'boom',
      logs: [{ level: 'warn', message: 'before error' }],
    });
    const result = compile('mode: rule\n', {
      merge: enabled('mode: direct\n'),
      script: enabled('throw'),
    });
    await expect(result).rejects.toMatchObject({
      name: 'ProfileCompileError',
      message: 'boom',
      stages: [expect.objectContaining({ id: 'profile-merge' })],
      logs: [
        { level: 'warn', message: 'before error', stage: 'profile-script' },
        { level: 'error', message: 'boom', stage: 'profile-script' },
      ],
    });
  });

  it('stops before script execution when cancelled and forwards cancellation to a running script', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      compileProfile(
        { content: 'mode: rule', profileName: 'Cancel' },
        { signal: cancelled.signal },
      ),
    ).rejects.toBeInstanceOf(ProfileCompileError);
    expect(runProfileScript).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.mocked(runProfileScript).mockImplementation(async (_input, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return { ok: true, config: { mode: 'direct' }, logs: [] };
    });
    await expect(
      compileProfile(
        {
          content: 'mode: rule',
          profileName: 'Cancel',
          enhancement: enhancement({ script: enabled('script') }),
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/取消/);
  });

  it.each([
    'prepend: []\nappend: []',
    'prepend: []\nappend: []\ndelete: [42]',
    'prepend: wrong\nappend: []\ndelete: []',
  ])('rejects invalid enabled Seq syntax: %s', async (content) => {
    await expect(compile('mode: rule', { rules: enabled(content) })).rejects.toThrow(/三个数组/);
  });
});

describe('safe configuration parsing', () => {
  it.each([
    '1: numeric key',
    'nested: {true: boolean key}',
    '? [complex, key]\n: invalid',
    'mode: rule\nmode: direct',
    'value: .inf',
    'value: .nan',
    'value: !!set {a, b}',
    'value: !!binary aGVsbG8=',
    'value: !!timestamp 2025-01-01',
    'value: !unknown custom',
    'value: &a [*a]',
  ])('rejects non-JSON values, non-string keys, duplicate keys and cycles: %s', (source) => {
    expect(() => parseProfileYaml(source)).toThrow();
  });

  it('bounds syntax depth, bytes and alias expansion', () => {
    expect(() => parseProfileYaml(`value: ${'['.repeat(102)}0${']'.repeat(102)}`)).toThrow(/100/);
    expect(() => parseProfileYaml(`value: ${'界'.repeat(2 * 1024 * 1024)}`)).toThrow(/5 MiB/);
    expect(() =>
      parseProfileYaml(
        `a: &a [1, 2, 3]\nb: &b [${Array(20).fill('*a').join(',')}]\nc: [${Array(20).fill('*b').join(',')}]`,
      ),
    ).toThrow();
  });

  it('preserves hostile property names as data through nested merges without changing Object.prototype', async () => {
    const result = await compile(
      '__proto__: {base: true}\nconstructor: {prototype: {base: true}}\n',
      {
        merge: enabled('__proto__: {polluted: true}\nconstructor: {prototype: {polluted: true}}\n'),
      },
    );
    const value = parseProfileYaml(result.content);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.__proto__).toEqual({ base: true, polluted: true });
    expect(value.constructor).toEqual({ prototype: { base: true, polluted: true } });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('global enhancement storage', () => {
  function storage() {
    const values = new Map<string, string>();
    return {
      values,
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    };
  }

  it('defaults disabled, accepts invalid draft text, isolates demo, and returns independent sources', () => {
    const store = storage();
    const initial = readGlobalProfileEnhancement('local', store);
    expect(initial.merge.enabled).toBe(false);
    const value = { ...initial, merge: { enabled: false, content: 'invalid: [' } };
    writeGlobalProfileEnhancement('local', value, { expected: initial, storage: store });
    expect(readGlobalProfileEnhancement('local', store)).toEqual(value);
    expect(readGlobalProfileEnhancement('demo', store)).toEqual(initial);
    const local = defaultProfileEnhancement();
    local.rules.content = 'edited';
    expect(local.proxies.content).not.toBe('edited');
    expect(defaultProfileEnhancement().rules.content).not.toBe('edited');
    expect(isProfileEnhancement(local)).toBe(true);
    expect(runProfileScript).not.toHaveBeenCalled();
  });

  it.each([
    'invalid',
    'null',
    '{}',
    '{"version":2}',
    JSON.stringify({
      ...defaultGlobalProfileEnhancement(),
      script: { enabled: 'true', content: 'bad' },
    }),
  ])('reports corrupt global data without replacing it: %s', (raw) => {
    const store = storage();
    store.values.set(globalProfileEnhancementKey('local'), raw);
    expect(() => readGlobalProfileEnhancement('local', store)).toThrow(/损坏/);
    expect(store.values.get(globalProfileEnhancementKey('local'))).toBe(raw);
    expect(store.setItem).not.toHaveBeenCalled();
  });

  it('rejects stale saves, including when another tab corrupts the stored value', () => {
    const store = storage();
    const expected = readGlobalProfileEnhancement('local', store);
    const next = { ...expected, merge: enabled('mode: direct') };
    writeGlobalProfileEnhancement('local', next, { expected, storage: store });
    expect(() =>
      writeGlobalProfileEnhancement('local', expected, { expected, storage: store }),
    ).toThrow(/其他页面/);
    expect(readGlobalProfileEnhancement('local', store)).toEqual(next);
    store.values.set(globalProfileEnhancementKey('local'), 'bad');
    expect(() =>
      writeGlobalProfileEnhancement('local', expected, { expected: next, storage: store }),
    ).toThrow(/损坏/);
    expect(store.values.get(globalProfileEnhancementKey('local'))).toBe('bad');
  });

  it('reports denied reads and writes without pretending to save', () => {
    const store = storage();
    store.getItem.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => readGlobalProfileEnhancement('local', store)).toThrow(/读取/);
    store.setItem.mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() =>
      writeGlobalProfileEnhancement('local', defaultGlobalProfileEnhancement(), { storage: store }),
    ).toThrow(/未保存/);
    expect(store.values.size).toBe(0);
  });
});
