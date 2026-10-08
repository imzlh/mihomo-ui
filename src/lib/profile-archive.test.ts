import { describe, expect, it, vi } from 'vitest';
import {
  PROFILE_ARCHIVE_FORMAT,
  PROFILE_ARCHIVE_MAX_BYTES,
  createImportedProfiles,
  createProfileImportItem,
  moveProfile,
  parseProfileArchive,
  parseProfileArchiveBundle,
  readProfileLibrary,
  serializeProfileArchive,
  writeProfileLibrary,
  type ProfileEntry,
} from './profile-library';
import { defaultGlobalProfileEnhancement, defaultProfileEnhancement } from './profile-enhancement';

const original = '# original comments\r\nmode: rule\r\nrules:\r\n  - MATCH,DIRECT\r\n';
const entry = (id: string, name = id): ProfileEntry => ({
  id,
  name,
  description: 'description',
  content: original,
  sourceUrl: 'https://example.com/config.yaml?token=source%2Fsecret',
  createdAt: 10,
  updatedAt: 20,
});

describe('portable profile archives', () => {
  it('round-trips local and global enhancements without running enabled imported scripts', () => {
    const local = defaultProfileEnhancement();
    local.rules = { enabled: true, content: 'prepend: [MATCH,REJECT]\nappend: []\ndelete: []\n' };
    local.script = { enabled: true, content: 'throw new Error("must never run during import")' };
    const global = defaultGlobalProfileEnhancement();
    global.merge = { enabled: true, content: 'dns: {enable: true}\n' };
    global.script = { enabled: true, content: 'while (true) {}' };
    const archived = serializeProfileArchive([{ ...entry('old'), enhancement: local }], {
      globalEnhancement: global,
    });
    const bundle = parseProfileArchiveBundle(archived);
    expect(bundle.globalEnhancement).toEqual(global);
    expect(bundle.items[0]?.enhancement).toEqual(local);
    expect(bundle.items[0]?.error).toBeUndefined();
    const imported = createImportedProfiles(bundle.items);
    expect(imported[0]?.enhancement).toEqual(local);
    imported[0]!.enhancement!.rules.content = 'modified after import';
    expect(bundle.items[0]?.enhancement?.rules.content).toBe(local.rules.content);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    writeProfileLibrary('local', imported, storage);
    expect(readProfileLibrary('local', storage)).toEqual(imported);
    expect(bundle.globalEnhancement?.script.enabled).toBe(true);
  });

  it('keeps older archives compatible and does not invent or enable enhancement data', () => {
    const bundle = parseProfileArchiveBundle(serializeProfileArchive([entry('old')]));
    expect(bundle.globalEnhancement).toBeUndefined();
    expect(bundle.items[0]?.enhancement).toBeUndefined();
    expect(createImportedProfiles(bundle.items)[0]?.enhancement).toBeUndefined();
    expect(parseProfileArchive(serializeProfileArchive([entry('old')]))[0]?.error).toBeUndefined();
  });

  it('keeps bad enhancement entries visible and rejects malformed global enhancement headers', () => {
    const raw = JSON.parse(serializeProfileArchive([entry('good'), entry('bad')]));
    raw.profiles[1].enhancement = {
      ...defaultProfileEnhancement(),
      rules: { enabled: 'yes', content: '' },
    };
    const bundle = parseProfileArchiveBundle(JSON.stringify(raw));
    expect(bundle.items[0]?.error).toBeUndefined();
    expect(bundle.items[1]?.error).toMatch(/格式错误/);
    expect(createImportedProfiles(bundle.items)).toHaveLength(1);
    raw.globalEnhancement = null;
    expect(() => parseProfileArchiveBundle(JSON.stringify(raw))).toThrow(/全局增强/);
  });

  it('round-trips complete original content and source URLs without importing identity or applied-state claims', () => {
    const old = entry('old-id', 'Office');
    const content = serializeProfileArchive([old]);
    const archive = JSON.parse(content);
    expect(archive).toMatchObject({
      format: PROFILE_ARCHIVE_FORMAT,
      version: 1,
      profiles: [
        {
          name: 'Office',
          description: old.description,
          content: original,
          sourceUrl: old.sourceUrl,
        },
      ],
    });
    expect(archive.profiles[0]).not.toHaveProperty('id');
    expect(archive.profiles[0]).not.toHaveProperty('createdAt');
    archive.profiles[0].id = old.id;
    archive.profiles[0].applied = true;
    archive.profiles[0].updatedAt = old.updatedAt;
    const items = parseProfileArchive(JSON.stringify(archive));
    const imported = createImportedProfiles(items, [old]);
    expect(imported[0]).toMatchObject({
      name: old.name,
      description: old.description,
      content: original,
      sourceUrl: old.sourceUrl,
    });
    expect(imported[0]?.id).not.toBe(old.id);
    expect(imported[0]?.createdAt).toBeGreaterThan(20);
    expect(imported[0]).not.toHaveProperty('applied');
  });

  it.each([
    'not json',
    JSON.stringify({ format: 'mihomo-verge-preferences', version: 1, profiles: [] }),
    JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, version: 2, profiles: [] }),
    JSON.stringify({ version: 1, profiles: [] }),
    JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, version: 1, profiles: [] }),
  ])(
    'rejects invalid headers and empty archives without treating them as imported configurations',
    (content) => {
      expect(() => parseProfileArchive(content)).toThrow();
    },
  );

  it('keeps entry-level errors visible without discarding valid neighboring configurations', () => {
    const archive = {
      format: PROFILE_ARCHIVE_FORMAT,
      version: 1,
      profiles: [
        { name: 'Valid', description: '', content: original },
        { name: 'Broken YAML', description: '', content: 'mode: [' },
        {
          name: 'Invalid source',
          description: '',
          content: original,
          sourceUrl: 'file:///tmp/core.yaml',
        },
        { name: 'Missing original', description: '' },
        { name: '', description: '', content: original },
      ],
    };
    const items = parseProfileArchive(JSON.stringify(archive));
    expect(items).toHaveLength(5);
    expect(items[0]?.error).toBeUndefined();
    expect(items.slice(1).every((item) => !!item.error)).toBe(true);
    expect(items[1]?.content).toBe('mode: [');
    expect(createImportedProfiles(items)).toHaveLength(1);
  });

  it('accepts a JSON BOM and preserves duplicate names as separate new copies', () => {
    const content =
      '\uFEFF' + serializeProfileArchive([entry('old-a', 'Same'), entry('old-b', 'Same')]);
    const items = parseProfileArchive(content);
    const existing = [entry('existing', 'Same')];
    const copies = createImportedProfiles(items, existing);
    expect(copies.map((item) => item.name)).toEqual(['Same', 'Same']);
    expect(new Set([...copies, ...existing].map((item) => item.id)).size).toBe(3);
    expect(existing).toEqual([entry('existing', 'Same')]);
  });

  it('retains valid UTF-8 YAML file originals while reporting per-file validation errors', () => {
    const valid = createProfileImportItem('工作.yaml', original);
    const invalid = createProfileImportItem('bad.yaml', '- not\n- a mapping\n');
    expect(valid).toMatchObject({
      label: '工作.yaml',
      name: '工作',
      content: original,
      description: '',
    });
    expect(valid.error).toBeUndefined();
    expect(invalid.error).toBeTruthy();
    expect(invalid.content).toBe('- not\n- a mapping\n');
  });

  it('generates fresh IDs even when the random source initially collides with a latest-library entry', () => {
    const random = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-1111-1111-111111111111')
      .mockReturnValueOnce('22222222-2222-2222-2222-222222222222');
    try {
      const copies = createImportedProfiles(
        [createProfileImportItem('Copy.yaml', original)],
        [entry('11111111-1111-1111-1111-111111111111')],
      );
      expect(copies[0]?.id).toBe('22222222-2222-2222-2222-222222222222');
    } finally {
      random.mockRestore();
    }
  });

  it('prevents oversized exports that could not be imported again', () => {
    expect(() =>
      serializeProfileArchive([
        { name: 'Too large', description: '', content: 'x'.repeat(PROFILE_ARCHIVE_MAX_BYTES) },
      ]),
    ).toThrow(/20 MiB/);
    expect(() => parseProfileArchive(' '.repeat(PROFILE_ARCHIVE_MAX_BYTES + 1))).toThrow(/20 MiB/);
  });
});

describe('manual profile order', () => {
  it('moves within the latest library while retaining new entries and leaving source arrays unchanged', () => {
    const latest = [entry('new-tab'), entry('a'), entry('b'), entry('c')];
    const moved = moveProfile(latest, 'b', 'up');
    expect(moved.map((item) => item.id)).toEqual(['new-tab', 'b', 'a', 'c']);
    expect(moveProfile(moved, 'b', 'down').map((item) => item.id)).toEqual([
      'new-tab',
      'a',
      'b',
      'c',
    ]);
    expect(latest.map((item) => item.id)).toEqual(['new-tab', 'a', 'b', 'c']);
    expect(moved[0]).toBe(latest[0]);
  });

  it('keeps first, last and already deleted entries stable at the boundaries', () => {
    const profiles = [entry('a'), entry('b')];
    expect(moveProfile(profiles, 'a', 'up')).toEqual(profiles);
    expect(moveProfile(profiles, 'b', 'down')).toEqual(profiles);
    expect(moveProfile(profiles, 'deleted', 'up')).toEqual(profiles);
  });
});
