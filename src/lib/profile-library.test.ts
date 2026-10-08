import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROFILE_MAX_BYTES,
  fetchProfileSource,
  lastAppliedProfile,
  normalizeProfileSourceUrl,
  profileFileName,
  profileLibraryKey,
  readProfileLibrary,
  rememberAppliedProfile,
  validateProfileYaml,
  writeProfileLibrary,
  type ProfileEntry,
} from './profile-library';
import { defaultProfileEnhancement } from './profile-enhancement';

const sourceUrl = 'https://subscriptions.example/config.yaml?token=private-value';
const originalYaml = [
  '# 保留注释、锚点、引号与换行',
  'mixed-port: 7890',
  'defaults: &defaults',
  "  type: 'http'",
  '  interval: 3600',
  'proxy-providers:',
  '  example:',
  '    <<: *defaults',
  "    url: 'https://example.com/providers.yaml'",
  '',
].join('\r\n');

function profile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id: 'profile-one',
    name: '工作配置',
    description: '保留原始配置',
    content: originalYaml,
    sourceUrl,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('profile YAML validation', () => {
  it('accepts one mapping with anchors, aliases and merge keys without rewriting the source', () => {
    expect(validateProfileYaml(originalYaml)).toBeNull();
    const storage = memoryStorage();
    writeProfileLibrary('local', [profile()], storage);
    expect(readProfileLibrary('local', storage)[0]?.content).toBe(originalYaml);
  });

  it.each([
    '',
    ' \n\t',
    '# comments alone do not form a config\n',
    'plain text',
    '- mode: rule\n- mixed-port: 7890',
    'mode: rule\nmode: direct\n',
    'mode: rule\n---\nmode: direct\n',
    'proxies: [unterminated\n',
    'proxy-groups: *undefined-anchor\n',
  ])('rejects empty, malformed, duplicate, multi-document or non-mapping YAML: %j', (content) => {
    expect(validateProfileYaml(content)).toEqual(expect.any(String));
    expect(validateProfileYaml(content)?.length).toBeGreaterThan(0);
  });

  it('rejects alias expansion that exceeds the parser limit', () => {
    const repeatedAliases = Array.from({ length: 20 }, () => '*a').join(', ');
    const nestedAliases = Array.from({ length: 20 }, () => '*b').join(', ');
    const content = `a: &a [1, 2, 3]\nb: &b [${repeatedAliases}]\nc: [${nestedAliases}]\n`;
    expect(validateProfileYaml(content)).toEqual(expect.any(String));
  });

  it('measures the YAML limit in UTF-8 bytes rather than JavaScript characters', () => {
    const content = `name: ${'界'.repeat(Math.floor(PROFILE_MAX_BYTES / 3))}`;
    expect(content.length).toBeLessThan(PROFILE_MAX_BYTES);
    expect(validateProfileYaml(content)).toMatch(/5 MiB/);
  });
});

describe('profile library persistence', () => {
  it('starts empty and keeps the local library separate from demo changes', () => {
    const storage = memoryStorage();
    expect(readProfileLibrary('local', storage)).toEqual([]);
    expect(readProfileLibrary('demo', storage)).toEqual([]);
    writeProfileLibrary('local', [profile()], storage);
    writeProfileLibrary(
      'demo',
      [profile({ name: '演示配置', content: 'mode: direct\n' })],
      storage,
    );
    expect(readProfileLibrary('local', storage)).toEqual([profile()]);
    expect(readProfileLibrary('demo', storage)[0]?.content).toBe('mode: direct\n');
    writeProfileLibrary('demo', [], storage);
    expect(readProfileLibrary('local', storage)).toEqual([profile()]);
  });

  it.each([
    '{broken',
    'null',
    '[]',
    JSON.stringify({ version: 2, profiles: [] }),
    JSON.stringify({ version: 1, profiles: [{ ...profile(), content: null }] }),
    JSON.stringify({ version: 1, profiles: [{ ...profile(), updatedAt: null }] }),
    JSON.stringify({ version: 1, profiles: [{ ...profile(), enhancement: null }] }),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          ...profile(),
          enhancement: { ...defaultProfileEnhancement(), script: { enabled: 1, content: 'bad' } },
        },
      ],
    }),
    JSON.stringify({ version: 1, profiles: [profile(), profile({ name: '重复 ID' })] }),
  ])('reports corrupted storage and preserves it for recovery: %#', (raw) => {
    const storage = memoryStorage();
    storage.values.set(profileLibraryKey('local'), raw);
    expect(() => readProfileLibrary('local', storage)).toThrow(/损坏/);
    expect(storage.values.get(profileLibraryKey('local'))).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('reports denied reads instead of presenting an empty library', () => {
    const storage = {
      getItem: () => {
        throw new DOMException('Storage access is denied', 'SecurityError');
      },
    };
    expect(() => readProfileLibrary('local', storage)).toThrow(/读取/);
  });

  it('throws on failed writes and leaves the previously saved profile intact', () => {
    const storage = memoryStorage();
    writeProfileLibrary('local', [profile()], storage);
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(() =>
      writeProfileLibrary('local', [profile({ content: 'mode: direct\n' })], storage),
    ).toThrow(/未保存/);
    expect(readProfileLibrary('local', storage)).toEqual([profile()]);
  });
});

describe('remote profile sources', () => {
  it('preserves query authentication, removes fragments and uses direct CORS without browser credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(originalYaml));
    await expect(fetchProfileSource(` ${sourceUrl}#section `, undefined, fetcher)).resolves.toBe(
      originalYaml,
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      sourceUrl,
      expect.objectContaining({
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it.each([
    '/relative.yaml',
    'file:///etc/config.yaml',
    'data:text/yaml,mode:rule',
    'ftp://example.com/config.yaml',
    'https://user:password@example.com/config.yaml',
  ])('rejects unsupported or credential-bearing source URLs before fetching: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => normalizeProfileSourceUrl(url)).toThrow();
    await expect(fetchProfileSource(url, undefined, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains the HTTP status and explains native browser CORS/network failures', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('denied', { status: 403, statusText: 'Forbidden' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchProfileSource(sourceUrl, undefined, fetcher)).rejects.toThrow(/HTTP 403/);
    await expect(fetchProfileSource(sourceUrl, undefined, fetcher)).rejects.toThrow(
      /Failed to fetch.*CORS/,
    );
  });

  it('decodes UTF-8 correctly when a character spans separate streamed chunks', async () => {
    const content = "name: '香港'\r\nmode: rule\r\n";
    const encoded = new TextEncoder().encode(content);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 8));
          controller.enqueue(encoded.slice(8, 10));
          controller.enqueue(encoded.slice(10));
          controller.close();
        },
      }),
    );
    await expect(
      fetchProfileSource(sourceUrl, undefined, vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).resolves.toBe(content);
  });

  it.each([undefined, '1'])(
    'rejects oversized streamed responses when Content-Length is %j',
    async (declaredLength) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(PROFILE_MAX_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
        { headers: declaredLength ? { 'content-length': declaredLength } : undefined },
      );
      await expect(
        fetchProfileSource(sourceUrl, undefined, vi.fn<typeof fetch>().mockResolvedValue(response)),
      ).rejects.toThrow(/5 MiB/);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('rejects a declared oversized response before reading its body', async () => {
    const response = new Response('mode: rule\n', {
      headers: { 'content-length': String(PROFILE_MAX_BYTES + 1) },
    });
    const read = vi.spyOn(response.body!, 'getReader');
    await expect(
      fetchProfileSource(sourceUrl, undefined, vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toThrow(/5 MiB/);
    expect(read).not.toHaveBeenCalled();
  });

  it('aborts a stalled fetch after 20 seconds and reports a timeout', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const result = expect(fetchProfileSource(sourceUrl, undefined, fetcher)).rejects.toThrow(
      /超时/,
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation without reclassifying it as a CORS failure', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const abortError = new DOMException('User cancelled import', 'AbortError');
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
      });
    });
    const result = expect(fetchProfileSource(sourceUrl, caller.signal, fetcher)).rejects.toBe(
      abortError,
    );
    caller.abort(abortError);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('profile file and session identity', () => {
  it('retains source content and generated content separately with an enhancement signature', () => {
    const client = {};
    const entry = profile({ enhancement: defaultProfileEnhancement() });
    const signature = JSON.stringify({ enhancement: entry.enhancement });
    rememberAppliedProfile(client, entry, {
      content: 'mode: direct\n',
      enhancementSignature: signature,
    });
    entry.enhancement!.merge.content = 'mode: global';
    expect(lastAppliedProfile(client)).toMatchObject({
      content: originalYaml,
      generatedContent: 'mode: direct\n',
      enhancementSignature: signature,
    });
    rememberAppliedProfile(client, entry);
    expect(lastAppliedProfile(client)).not.toHaveProperty('generatedContent');
    expect(lastAppliedProfile(client)).not.toHaveProperty('enhancementSignature');
  });

  it('keeps YAML extensions and removes path separators and unsafe filename characters', () => {
    expect(profileFileName(' 工作配置 ')).toBe('工作配置.yaml');
    expect(profileFileName('office.YML')).toBe('office.YML');
    expect(profileFileName('config.yaml')).toBe('config.yaml');
    expect(profileFileName('folder/subfolder\\bad:name?')).toBe('folder-subfolder-bad-name-.yaml');
    expect(profileFileName('... ')).toBe('config.yaml');
  });

  it('remembers the applied content snapshot only for the exact controller session', () => {
    const client = {};
    const otherSession = {};
    const entry = profile();
    rememberAppliedProfile(client, entry);
    entry.content = 'mode: direct\n';
    expect(lastAppliedProfile(client)).toMatchObject({ id: entry.id, content: originalYaml });
    expect(lastAppliedProfile(otherSession)).toBeUndefined();
    expect(lastAppliedProfile(null)).toBeUndefined();
    rememberAppliedProfile(client, entry);
    expect(lastAppliedProfile(client)?.content).toBe(entry.content);
  });
});
