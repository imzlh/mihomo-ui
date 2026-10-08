import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  FileCode2,
  FilePlus2,
  FileUp,
  Globe2,
  Link2,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { Badge, EmptyState, Modal, PageHeader, SearchInput, Spinner } from '../components/ui';
import { bytes } from '../lib/format';
import { maintenanceStore } from '../lib/core-maintenance';
import ProfileEnhancementEditor from '../components/ProfileEnhancementEditor';
import {
  compileProfile,
  defaultGlobalProfileEnhancement,
  defaultProfileEnhancement,
  ProfileCompileError,
  globalProfileEnhancementKey,
  readGlobalProfileEnhancement,
  writeGlobalProfileEnhancement,
  type GlobalProfileEnhancement,
  type ProfileEnhancement,
  type EnhancementLog,
} from '../lib/profile-enhancement';
import {
  PROFILE_MAX_BYTES,
  PROFILE_ARCHIVE_MAX_BYTES,
  createImportedProfiles,
  createProfileImportItem,
  createProfileId,
  fetchProfileSource,
  lastAppliedProfile,
  normalizeProfileSourceUrl,
  moveProfile,
  parseProfileArchiveBundle,
  profileFileName,
  profileLibraryKey,
  readProfileLibrary,
  rememberAppliedProfile,
  serializeProfileArchive,
  subscribeAppliedProfile,
  validateProfileYaml,
  writeProfileLibrary,
  type ProfileEntry,
  type ProfileImportItem,
  type ProfileScope,
} from '../lib/profile-library';
import { useMihomo } from '../state/mihomo';
import './profiles.css';

interface ProfileDraft {
  id?: string;
  name: string;
  description: string;
  content: string;
  sourceUrl: string;
  original?: ProfileEntry;
  fromSource?: boolean;
  enhancement?: ProfileEnhancement;
}

type CompiledProfile = Awaited<ReturnType<typeof compileProfile>>;
type EnhancementEditorState =
  | { kind: 'global'; initial: GlobalProfileEnhancement; profile?: ProfileEntry }
  | {
      kind: 'profile';
      initial: ProfileEnhancement;
      global: GlobalProfileEnhancement;
      profile: ProfileEntry;
    };

const enhancementSignature = (
  global: GlobalProfileEnhancement,
  profile?: ProfileEnhancement,
  profileName?: string,
) => JSON.stringify({ global, profile: profile ?? defaultProfileEnhancement(), profileName });

const emptyDraft = (): ProfileDraft => ({ name: '', description: '', content: '', sourceUrl: '' });
const fromProfile = (profile: ProfileEntry): ProfileDraft => ({
  ...profile,
  sourceUrl: profile.sourceUrl ?? '',
  original: profile,
});
const dateText = (value: number): string =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败，请重试。';

function downloadContent(name: string, content: string) {
  downloadFile(profileFileName(name), content, 'application/yaml;charset=utf-8');
}

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function Profiles() {
  const { client, demo } = useMihomo();
  const [session, setSession] = useState({ client, demo, id: 0 });
  if (session.client !== client || session.demo !== demo)
    setSession({ client, demo, id: session.id + 1 });
  return <SessionProfiles key={session.id} />;
}

function SessionProfiles() {
  const { client, demo, connected, profile: backend, reloadConfig, notify } = useMihomo();
  const scope: ProfileScope = demo ? 'demo' : 'local';
  const [library, setLibrary] = useState(() => {
    try {
      return { profiles: readProfileLibrary(scope), error: '' };
    } catch (error) {
      return { profiles: [] as ProfileEntry[], error: errorText(error) };
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [operationError, setOperationError] = useState('');
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [editorError, setEditorError] = useState('');
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProfileEntry | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelection, setBatchSelection] = useState<Set<string>>(new Set());
  const [batchDelete, setBatchDelete] = useState<ProfileEntry[] | null>(null);
  const [importPreview, setImportPreview] = useState<{
    items: ProfileImportItem[];
    chosen: Set<number>;
    globalEnhancement?: GlobalProfileEnhancement;
    restoreGlobal: boolean;
    expectedGlobal?: GlobalProfileEnhancement;
  } | null>(null);
  const [importError, setImportError] = useState('');
  const [applyTarget, setApplyTarget] = useState<ProfileEntry | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [compiled, setCompiled] = useState<CompiledProfile | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [applyGlobal, setApplyGlobal] = useState<GlobalProfileEnhancement | null>(null);
  const [applyLogs, setApplyLogs] = useState<EnhancementLog[]>([]);
  const [importRecoveryRequired, setImportRecoveryRequired] = useState(false);
  const [enhancementEditor, setEnhancementEditor] = useState<EnhancementEditorState | null>(null);
  const [globalState, setGlobalState] = useState(() => {
    try {
      return { value: readGlobalProfileEnhancement(scope), error: '' };
    } catch (error) {
      return { value: defaultGlobalProfileEnhancement(), error: errorText(error) };
    }
  });
  const applied = useSyncExternalStore(
    (listener) => subscribeAppliedProfile(client, listener),
    () => lastAppliedProfile(client),
  );
  const active = useRef(false);
  const applyLock = useRef(false);
  const importLock = useRef(false);
  const readRequest = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const compileRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const archiveInput = useRef<HTMLInputElement>(null);
  const maintenance = maintenanceStore(client);
  const { pending: maintenancePending, configWriting } = useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
  );
  const coreBusy = applying || configWriting || maintenancePending !== null;
  const selected = library.profiles.find((item) => item.id === selectedId) ?? library.profiles[0];
  const editorProfile = library.profiles.find((item) => item.id === enhancementEditor?.profile?.id);
  const batchProfiles = library.profiles.filter((item) => batchSelection.has(item.id));
  const selectedIndex = selected
    ? library.profiles.findIndex((item) => item.id === selected.id)
    : -1;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return library.profiles.filter((item) =>
      `${item.name} ${item.description} ${item.sourceUrl ?? ''}`.toLowerCase().includes(needle),
    );
  }, [library.profiles, query]);
  const duplicateImportNames = useMemo(() => {
    const known = new Set(library.profiles.map((item) => item.name.trim().toLocaleLowerCase()));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of importPreview?.items ?? []) {
      if (item.error) continue;
      const name = item.name.trim().toLocaleLowerCase();
      if (known.has(name) || seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    return duplicates;
  }, [library.profiles, importPreview?.items]);
  const draftChanged =
    draft !== null &&
    (draft.original
      ? ['name', 'description', 'content', 'sourceUrl'].some(
          (key) =>
            draft[key as keyof ProfileDraft] !== (draft.original![key as keyof ProfileEntry] ?? ''),
        )
      : !!(draft.name || draft.description || draft.content || draft.sourceUrl));

  useEffect(() => {
    active.current = true;
    const synchronize = (event: StorageEvent) => {
      if (event.key === null || event.key === globalProfileEnhancementKey(scope)) {
        try {
          setGlobalState({ value: readGlobalProfileEnhancement(scope), error: '' });
        } catch (error) {
          setGlobalState((current) => ({ ...current, error: errorText(error) }));
        }
      }
      if (event.key !== null && event.key !== profileLibraryKey(scope)) return;
      try {
        setLibrary({ profiles: readProfileLibrary(scope), error: '' });
      } catch (error) {
        setLibrary((current) => ({ ...current, error: errorText(error) }));
      }
    };
    window.addEventListener('storage', synchronize);
    return () => {
      active.current = false;
      readRequest.current.controller?.abort();
      readRequest.current.id++;
      compileRequest.current?.abort();
      window.removeEventListener('storage', synchronize);
    };
  }, [scope]);

  useEffect(() => {
    if (!draftChanged) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draftChanged]);

  function cancelReading() {
    readRequest.current.controller?.abort();
    readRequest.current = { id: readRequest.current.id + 1 };
    setFetching(false);
    compileRequest.current?.abort();
    compileRequest.current = null;
    setPreparing(false);
  }

  function openEditor(next: ProfileDraft) {
    cancelReading();
    setImportPreview(null);
    setDraft(next);
    setEditorError('');
    setDiscardConfirm(false);
    setOperationError('');
  }

  function closeEditor() {
    if (draftChanged) setDiscardConfirm(true);
    else setDraft(null);
  }

  function persist(transform: (profiles: ProfileEntry[]) => ProfileEntry[]): string | null {
    try {
      // Merge with the latest browser copy so an action cannot erase another tab's new files.
      const next = transform(readProfileLibrary(scope));
      writeProfileLibrary(scope, next);
      setLibrary({ profiles: next, error: '' });
      setOperationError('');
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim()) {
      setEditorError('请为配置填写名称。');
      return;
    }
    const yamlError = validateProfileYaml(draft.content);
    if (yamlError) {
      setEditorError(`YAML 校验失败：${yamlError}`);
      return;
    }
    let source: string | undefined;
    try {
      source = draft.sourceUrl.trim() ? normalizeProfileSourceUrl(draft.sourceUrl) : undefined;
    } catch (error) {
      setEditorError(errorText(error));
      return;
    }
    const now = Date.now();
    const entry: ProfileEntry = {
      id: draft.id ?? createProfileId(),
      name: draft.name.trim(),
      description: draft.description,
      content: draft.content,
      sourceUrl: source,
      createdAt: draft.original?.createdAt ?? now,
      updatedAt: now,
      ...(draft.enhancement ? { enhancement: draft.enhancement } : {}),
    };
    const error = persist((profiles) => {
      if (!draft.id) return [entry, ...profiles];
      const current = profiles.find((item) => item.id === draft.id);
      if (!current) throw new Error('这份配置已从浏览器库删除。请下载草稿，或另存为新配置。');
      if (draft.original && JSON.stringify(current) !== JSON.stringify(draft.original))
        throw new Error('这份配置已在其他页面修改。请先下载草稿，再重新打开最新版本。');
      return profiles.map((item) => (item.id === entry.id ? entry : item));
    });
    if (error) {
      setEditorError(error);
      return;
    }
    setSelectedId(entry.id);
    setQuery('');
    setDraft(null);
    notify('配置已保存到浏览器');
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    cancelReading();
    const requestId = readRequest.current.id;
    setOperationError('');
    if (file.size > PROFILE_MAX_BYTES) {
      setOperationError('配置文件不能超过 5 MiB。');
      return;
    }
    setFetching(true);
    try {
      const content = await file.text();
      if (!active.current || requestId !== readRequest.current.id) return;
      const error = validateProfileYaml(content);
      if (error) {
        setOperationError(`无法导入此文件：${error}`);
        return;
      }
      openEditor({ ...emptyDraft(), name: file.name.replace(/\.ya?ml$/i, ''), content });
    } catch (error) {
      if (active.current && requestId === readRequest.current.id)
        setOperationError(errorText(error));
    } finally {
      if (active.current && requestId === readRequest.current.id) setFetching(false);
    }
  }

  function showImportPreview(
    items: ProfileImportItem[],
    globalEnhancement?: GlobalProfileEnhancement,
  ) {
    const expectedGlobal = globalEnhancement ? readGlobalProfileEnhancement(scope) : undefined;
    cancelReading();
    setImportRecoveryRequired(false);
    setImportError('');
    importLock.current = false;
    setImportPreview({
      items,
      chosen: new Set(items.flatMap((item, index) => (item.error ? [] : [index]))),
      globalEnhancement,
      restoreGlobal: false,
      expectedGlobal,
    });
  }

  async function importFiles(files: File[]) {
    if (files.length <= 1) return importFile(files[0]);
    cancelReading();
    const requestId = readRequest.current.id;
    setOperationError('');
    setFetching(true);
    const items: ProfileImportItem[] = [];
    try {
      for (const file of files) {
        if (!active.current || requestId !== readRequest.current.id) return;
        if (file.size > PROFILE_MAX_BYTES) {
          items.push({
            label: file.name,
            name: file.name.replace(/\.ya?ml$/i, ''),
            description: '',
            content: '',
            error: '文件超过 5 MiB，未读取。',
          });
          continue;
        }
        try {
          const content = await file.text();
          if (!active.current || requestId !== readRequest.current.id) return;
          items.push(createProfileImportItem(file.name, content));
        } catch (error) {
          items.push({
            label: file.name,
            name: file.name,
            description: '',
            content: '',
            error: errorText(error),
          });
        }
      }
      if (active.current && requestId === readRequest.current.id) showImportPreview(items);
    } finally {
      if (active.current && requestId === readRequest.current.id) setFetching(false);
    }
  }

  async function importArchive(file: File | undefined) {
    if (!file) return;
    cancelReading();
    const requestId = readRequest.current.id;
    setOperationError('');
    if (file.size > PROFILE_ARCHIVE_MAX_BYTES) {
      setOperationError('配置归档不能超过 20 MiB。');
      return;
    }
    setFetching(true);
    try {
      const content = await file.text();
      if (!active.current || requestId !== readRequest.current.id) return;
      const bundle = parseProfileArchiveBundle(content);
      showImportPreview(bundle.items, bundle.globalEnhancement);
    } catch (error) {
      if (active.current && requestId === readRequest.current.id)
        setOperationError(errorText(error));
    } finally {
      if (active.current && requestId === readRequest.current.id) setFetching(false);
    }
  }

  function exportArchive(
    profiles: readonly Pick<ProfileEntry, 'name' | 'description' | 'content' | 'sourceUrl'>[],
    draftArchive = false,
  ) {
    try {
      downloadFile(
        draftArchive ? 'mihomo-profiles-draft.json' : 'mihomo-profiles.json',
        serializeProfileArchive(profiles, {
          globalEnhancement:
            draftArchive && importPreview?.globalEnhancement
              ? importPreview.globalEnhancement
              : readGlobalProfileEnhancement(scope),
        }),
        'application/json;charset=utf-8',
      );
    } catch (error) {
      if (draftArchive) setImportError(errorText(error));
      else setOperationError(errorText(error));
    }
  }

  function confirmImport() {
    if (
      !importPreview ||
      importLock.current ||
      importRecoveryRequired ||
      !importPreview.chosen.size
    )
      return;
    importLock.current = true;
    const items = importPreview.items.filter(
      (item, index) => !item.error && importPreview.chosen.has(index),
    );
    let added: ProfileEntry[] = [];
    let error: string | null = null;
    try {
      const previous = readProfileLibrary(scope);
      added = createImportedProfiles(items, previous);
      const next = [...added, ...previous];
      writeProfileLibrary(scope, next);
      if (importPreview.restoreGlobal && importPreview.globalEnhancement) {
        try {
          writeGlobalProfileEnhancement(scope, importPreview.globalEnhancement, {
            expected: importPreview.expectedGlobal,
          });
        } catch (failure) {
          try {
            const addedIds = new Set(added.map((item) => item.id));
            writeProfileLibrary(
              scope,
              readProfileLibrary(scope).filter((item) => !addedIds.has(item.id)),
            );
          } catch {
            const recoveryError = '导入失败且回滚未完成，请重新读取配置库后检查已导入的副本。';
            setImportRecoveryRequired(true);
            try {
              setLibrary({ profiles: readProfileLibrary(scope), error: recoveryError });
            } catch {
              setLibrary((current) => ({ ...current, error: recoveryError }));
            }
            throw new Error('导入失败，配置库回滚也未完成。请保留草稿归档并重新读取浏览器库。');
          }
          throw failure;
        }
        setGlobalState({ value: importPreview.globalEnhancement, error: '' });
      }
      setLibrary({ profiles: next, error: '' });
      setOperationError('');
    } catch (failure) {
      error = errorText(failure);
    }
    if (error) {
      setImportError(error);
      importLock.current = false;
      return;
    }
    setSelectedId(added[0]?.id ?? null);
    setQuery('');
    setImportPreview(null);
    notify(`已将 ${added.length} 份配置保存到浏览器`);
  }

  function moveSelected(direction: 'up' | 'down') {
    if (!selected || query.trim()) return;
    const error = persist((profiles) => moveProfile(profiles, selected.id, direction));
    if (error) setOperationError(error);
  }

  async function readSource(entry?: ProfileEntry) {
    cancelReading();
    const controller = new AbortController();
    const requestId = readRequest.current.id;
    readRequest.current.controller = controller;
    setFetching(true);
    setSourceError('');
    setOperationError('');
    try {
      const url = normalizeProfileSourceUrl(entry?.sourceUrl ?? sourceUrl);
      const content = await fetchProfileSource(url, controller.signal);
      if (!active.current || requestId !== readRequest.current.id) return;
      const error = validateProfileYaml(content);
      if (error) throw new Error(`来源内容不是有效的完整 YAML 配置：${error}`);
      setSourceOpen(false);
      if (entry) openEditor({ ...fromProfile(entry), content, fromSource: true });
      else {
        const pathName = new URL(url).pathname.split('/').filter(Boolean).at(-1);
        let decodedName = pathName;
        try {
          if (pathName) decodedName = decodeURIComponent(pathName);
        } catch {
          /* Keep a literal filename when the URL contains invalid percent escapes. */
        }
        openEditor({
          ...emptyDraft(),
          name: decodedName ? decodedName.replace(/\.ya?ml$/i, '') : '远程配置',
          sourceUrl: url,
          content,
        });
      }
    } catch (error) {
      if (!active.current || requestId !== readRequest.current.id || controller.signal.aborted)
        return;
      if (entry) setOperationError(errorText(error));
      else setSourceError(errorText(error));
    } finally {
      if (active.current && requestId === readRequest.current.id) setFetching(false);
    }
  }

  function openEnhancement(kind: 'global' | 'profile') {
    cancelReading();
    try {
      const global = readGlobalProfileEnhancement(scope);
      setGlobalState({ value: global, error: '' });
      if (kind === 'global') setEnhancementEditor({ kind, initial: global, profile: selected });
      else if (selected)
        setEnhancementEditor({
          kind,
          initial: selected.enhancement ?? defaultProfileEnhancement(),
          global,
          profile: selected,
        });
    } catch (error) {
      setOperationError(errorText(error));
    }
  }

  function saveGlobalEnhancement(value: GlobalProfileEnhancement): string | null {
    if (enhancementEditor?.kind !== 'global') return '编辑会话已结束，请重新打开。';
    try {
      writeGlobalProfileEnhancement(scope, value, { expected: enhancementEditor.initial });
      setGlobalState({ value, error: '' });
      setEnhancementEditor(null);
      notify('全局增强已保存，应用配置时生效');
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  function saveProfileEnhancement(value: ProfileEnhancement): string | null {
    if (enhancementEditor?.kind !== 'profile') return '编辑会话已结束，请重新打开。';
    const original = enhancementEditor.profile;
    const error = persist((profiles) => {
      const current = profiles.find((item) => item.id === original.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(original))
        throw new Error('配置已在其他页面修改或删除，请保留增强草稿并重新打开。');
      return profiles.map((item) =>
        item.id === original.id ? { ...item, enhancement: value, updatedAt: Date.now() } : item,
      );
    });
    if (!error) {
      setEnhancementEditor(null);
      notify('配置增强已保存，原文保持不变');
    }
    return error;
  }

  async function prepareApplication(target: ProfileEntry) {
    cancelReading();
    const controller = new AbortController();
    compileRequest.current = controller;
    setApplyTarget(target);
    setCompiled(null);
    setApplyGlobal(null);
    setApplyLogs([]);
    setApplyError('');
    setPreparing(true);
    try {
      const current = readProfileLibrary(scope).find((item) => item.id === target.id);
      if (!current) throw new Error('此配置已被删除，请重新选择。');
      const global = readGlobalProfileEnhancement(scope);
      setGlobalState({ value: global, error: '' });
      const result = await compileProfile(
        {
          content: current.content,
          profileName: current.name,
          global,
          enhancement: current.enhancement,
        },
        { signal: controller.signal },
      );
      if (!active.current || controller.signal.aborted) return;
      setApplyTarget(current);
      setApplyGlobal(global);
      setCompiled(result);
      setApplyLogs(result.logs);
    } catch (error) {
      if (active.current && !controller.signal.aborted) {
        setApplyError(errorText(error));
        if (error instanceof ProfileCompileError) setApplyLogs(error.logs);
      }
    } finally {
      if (active.current && compileRequest.current === controller) setPreparing(false);
    }
  }

  function closeApplication() {
    if (applying) return;
    compileRequest.current?.abort();
    compileRequest.current = null;
    setPreparing(false);
    setApplyTarget(null);
    setCompiled(null);
    setApplyLogs([]);
  }

  async function applyConfiguration() {
    if (
      !applyTarget ||
      !compiled ||
      !applyGlobal ||
      preparing ||
      !client ||
      demo ||
      !connected ||
      coreBusy ||
      applyLock.current
    )
      return;
    try {
      const current = readProfileLibrary(scope).find((item) => item.id === applyTarget.id);
      const global = readGlobalProfileEnhancement(scope);
      if (
        !current ||
        current.content !== applyTarget.content ||
        current.name !== applyTarget.name ||
        enhancementSignature(global, current.enhancement, current.name) !==
          enhancementSignature(applyGlobal, applyTarget.enhancement, applyTarget.name)
      ) {
        setCompiled(null);
        throw new Error('配置或增强已改变，请重新生成预览后确认应用。');
      }
    } catch (error) {
      setApplyError(errorText(error));
      return;
    }
    const error = validateProfileYaml(compiled.content);
    if (error) {
      setApplyError(`YAML 校验失败：${error}`);
      return;
    }
    applyLock.current = true;
    setApplying(true);
    setApplyError('');
    try {
      const success = await reloadConfig(compiled.content, (message) => {
        if (active.current) setApplyError(message);
      });
      if (success)
        rememberAppliedProfile(client, applyTarget, {
          content: compiled.content,
          enhancementSignature: enhancementSignature(
            applyGlobal,
            applyTarget.enhancement,
            applyTarget.name,
          ),
        });
      if (!active.current) return;
      if (success) {
        setApplyTarget(null);
      }
    } finally {
      applyLock.current = false;
      if (active.current) setApplying(false);
    }
  }

  const isRecentlyApplied = (item: ProfileEntry) =>
    applied?.id === item.id &&
    applied.content === item.content &&
    !globalState.error &&
    applied.enhancementSignature ===
      enhancementSignature(globalState.value, item.enhancement, item.name);
  const lastApplied = selected && isRecentlyApplied(selected);

  return (
    <div className="page-stack profiles-page">
      <PageHeader
        title="配置"
        description="收藏完整 YAML 配置，在浏览器中编辑，并按需应用到已连接的内核。"
      >
        <button
          className="button"
          disabled={!!library.error}
          onClick={() => {
            cancelReading();
            fileInput.current?.click();
          }}
        >
          <FileUp size={16} />
          导入文件
        </button>
        <button
          className="button"
          disabled={!!library.error}
          onClick={() => {
            cancelReading();
            setSourceError('');
            setSourceOpen(true);
          }}
        >
          <Link2 size={16} />从 URL 导入
        </button>
        <button
          className="button primary"
          disabled={!!library.error}
          onClick={() => {
            cancelReading();
            openEditor(emptyDraft());
          }}
        >
          <FilePlus2 size={16} />
          新建配置
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".yaml,.yml,application/yaml,text/yaml,text/plain"
          aria-label="导入 YAML 文件"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importFiles(files);
          }}
        />
        <input
          ref={archiveInput}
          type="file"
          hidden
          accept=".json,application/json"
          aria-label="导入配置归档"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void importArchive(file);
          }}
        />
      </PageHeader>

      <div className="profiles-overview">
        <span>
          <FileCode2 size={15} />
          {demo ? '演示配置库' : '浏览器配置库'}
          <Badge tone={demo ? 'orange' : 'purple'}>{library.profiles.length} 份配置</Badge>
        </span>
        <span>完整原文保存在此浏览器</span>
      </div>
      {library.error && (
        <div className="profile-error" role="alert">
          <span>{library.error}</span>
          <button
            className="button small"
            onClick={() => {
              try {
                setLibrary({ profiles: readProfileLibrary(scope), error: '' });
              } catch (error) {
                setLibrary((current) => ({ ...current, error: errorText(error) }));
              }
            }}
          >
            重新读取
          </button>
        </div>
      )}
      {operationError && (
        <div className="profile-error" role="alert">
          {operationError}
        </div>
      )}
      {globalState.error && (
        <div className="profile-error" role="alert">
          {globalState.error}
        </div>
      )}
      <div className="profiles-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="搜索配置名称或描述…" />
        {fetching && (
          <span className="profile-loading">
            <Spinner />
            正在读取配置…
          </span>
        )}
        <div className="profile-library-actions">
          <button className="button small" onClick={() => openEnhancement('global')}>
            <SlidersHorizontal size={14} />
            全局增强
          </button>
          <button
            className="button small"
            disabled={!!library.error}
            onClick={() => {
              cancelReading();
              archiveInput.current?.click();
            }}
          >
            <Archive size={14} />
            导入归档
          </button>
          <button
            className="button small"
            disabled={!library.profiles.length}
            onClick={() => exportArchive(library.profiles)}
          >
            <Download size={14} />
            导出全部归档
          </button>
          <button
            className="button small"
            disabled={!library.profiles.length}
            aria-pressed={batchMode}
            onClick={() => {
              setBatchMode(!batchMode);
              setBatchSelection(new Set());
            }}
          >
            {batchMode ? '退出批量' : '批量管理'}
          </button>
        </div>
      </div>

      {batchMode && (
        <div className="panel profile-batch-toolbar" aria-label="批量配置操作">
          <strong>已选择 {batchProfiles.length} 份</strong>
          <button
            className="button small"
            disabled={!shown.length}
            onClick={() => setBatchSelection(new Set(shown.map((item) => item.id)))}
          >
            仅选择当前筛选结果
          </button>
          <button
            className="button small"
            disabled={!batchProfiles.length}
            onClick={() => setBatchSelection(new Set())}
          >
            取消选择
          </button>
          <span className="profile-batch-spacer" />
          <button
            className="button small"
            disabled={!batchProfiles.length}
            onClick={() => exportArchive(batchProfiles)}
          >
            <Download size={14} />
            导出选中归档
          </button>
          <button
            className="button small danger"
            disabled={!batchProfiles.length || !!library.error}
            onClick={() => {
              cancelReading();
              setOperationError('');
              setBatchDelete(batchProfiles);
            }}
          >
            <Trash2 size={14} />
            删除选中配置
          </button>
          <p>归档包含完整 YAML、名称、描述和来源 URL，可在配置库中重新导入。</p>
        </div>
      )}

      {library.profiles.length === 0 ? (
        <section className="panel profile-empty">
          <EmptyState
            icon={FileCode2}
            title="添加第一份完整配置"
            description="导入本地 YAML，粘贴配置原文，或从允许浏览器访问的 URL 读取。"
            action={
              <button
                className="button primary"
                disabled={!!library.error}
                onClick={() => openEditor(emptyDraft())}
              >
                <FilePlus2 size={16} />
                新建配置
              </button>
            }
          />
        </section>
      ) : (
        <div className="profiles-layout">
          <section className="profile-list" aria-label="浏览器配置列表">
            {shown.length === 0 ? (
              <div className="panel">
                <EmptyState title="没有匹配的配置" description="试试其他名称、描述或来源地址。" />
              </div>
            ) : (
              shown.map((item) => {
                const recent = isRecentlyApplied(item);
                return (
                  <div
                    key={item.id}
                    className={`profile-list-item${batchMode ? ' is-batch-mode' : ''}`}
                  >
                    {batchMode && (
                      <input
                        className="profile-batch-checkbox"
                        type="checkbox"
                        aria-label={`批量选择 ${item.name}`}
                        checked={batchSelection.has(item.id)}
                        onChange={(event) =>
                          setBatchSelection((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <button
                      className={`profile-card${selected?.id === item.id ? ' is-selected' : ''}`}
                      aria-label={`选择配置 ${item.name}`}
                      aria-pressed={selected?.id === item.id}
                      onClick={() => {
                        cancelReading();
                        setSelectedId(item.id);
                        setOperationError('');
                      }}
                    >
                      <span className="profile-card-top">
                        <span className="profile-file-icon">
                          {item.sourceUrl ? <Globe2 size={20} /> : <FileCode2 size={20} />}
                        </span>
                        <span className="profile-card-name">{item.name}</span>
                        {selected?.id === item.id && <Check size={17} />}
                      </span>
                      <span className="profile-card-description">
                        {item.description ||
                          (item.sourceUrl ? '来自远程配置地址' : '本地 YAML 配置')}
                      </span>
                      <span className="profile-card-meta">
                        <span>
                          {item.sourceUrl ? 'URL' : '本地'} ·{' '}
                          {bytes(new TextEncoder().encode(item.content).byteLength)}
                        </span>
                        <span>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
                      </span>
                      {recent && (
                        <span className="profile-card-applied">
                          <CheckCircle2 size={12} />
                          本会话最近应用
                        </span>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </section>
          {selected && (
            <section className="profile-detail" aria-label="配置详情">
              <div className="profile-detail-heading">
                <div>
                  <span className="profile-eyebrow">
                    {selected.sourceUrl ? '远程来源 · 手动更新' : '本地配置'}
                  </span>
                  <h2>{selected.name}</h2>
                </div>
                <button
                  className="button primary"
                  disabled={!connected || demo || coreBusy}
                  title={
                    demo
                      ? '演示模式不应用到内核'
                      : !connected
                        ? '连接内核后可应用'
                        : coreBusy
                          ? '等待当前内核操作完成'
                          : '应用此完整配置'
                  }
                  onClick={() => void prepareApplication(selected)}
                >
                  <Play size={15} />
                  应用配置
                </button>
              </div>
              {selected.description && (
                <p className="profile-description">{selected.description}</p>
              )}
              {lastApplied && applied && (
                <div className="profile-applied">
                  <CheckCircle2 size={14} />
                  本会话最近应用 · {dateText(applied.appliedAt)}
                </div>
              )}
              <dl className="profile-metadata">
                <div>
                  <dt>保存时间</dt>
                  <dd>{dateText(selected.updatedAt)}</dd>
                </div>
                <div>
                  <dt>原文大小</dt>
                  <dd>
                    {bytes(new TextEncoder().encode(selected.content).byteLength)} ·{' '}
                    {selected.content.split(/\r?\n/).length} 行
                  </dd>
                </div>
                {selected.sourceUrl && (
                  <div className="profile-source">
                    <dt>来源</dt>
                    <dd>{selected.sourceUrl}</dd>
                  </div>
                )}
              </dl>
              <div className="profile-actions">
                <button className="button small" onClick={() => openEnhancement('profile')}>
                  <SlidersHorizontal size={14} />
                  配置增强
                </button>
                <button className="button small" onClick={() => openEditor(fromProfile(selected))}>
                  <Edit3 size={14} />
                  编辑原文
                </button>
                <button
                  className="button small"
                  onClick={() =>
                    openEditor({
                      ...fromProfile(selected),
                      id: undefined,
                      original: undefined,
                      name: `${selected.name} 副本`,
                    })
                  }
                >
                  <Copy size={14} />
                  另存副本
                </button>
                <button
                  className="button small"
                  onClick={() => downloadContent(selected.name, selected.content)}
                >
                  <Download size={14} />
                  下载原文
                </button>
                {selected.sourceUrl && (
                  <button
                    className="button small"
                    disabled={fetching}
                    onClick={() => void readSource(selected)}
                  >
                    <RefreshCw size={14} />
                    从来源更新
                  </button>
                )}
                <button
                  className="icon-button profile-delete"
                  aria-label="删除配置"
                  title="删除配置"
                  onClick={() => {
                    cancelReading();
                    setOperationError('');
                    setDeleteTarget(selected);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="profile-order-bar">
                <span>
                  {query.trim()
                    ? '清空搜索后可调整列表顺序'
                    : `列表顺序 ${selectedIndex + 1} / ${library.profiles.length}`}
                </span>
                <button
                  className="icon-button"
                  aria-label={`上移配置 ${selected.name}`}
                  title={query.trim() ? '清空搜索后调整顺序' : '上移配置'}
                  disabled={selectedIndex <= 0 || !!query.trim() || !!library.error}
                  onClick={() => moveSelected('up')}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`下移配置 ${selected.name}`}
                  title={query.trim() ? '清空搜索后调整顺序' : '下移配置'}
                  disabled={
                    selectedIndex < 0 ||
                    selectedIndex >= library.profiles.length - 1 ||
                    !!query.trim() ||
                    !!library.error
                  }
                  onClick={() => moveSelected('down')}
                >
                  <ArrowDown size={15} />
                </button>
              </div>
              <pre className="profile-code" tabIndex={0} aria-label="配置原文">
                {selected.content}
              </pre>
              <p className="profile-footnote">
                {demo
                  ? '演示库与日常配置独立，不会向真实内核应用配置。'
                  : '选中配置后才可应用；“最近应用”记录本次连接会话中的操作。'}
              </p>
            </section>
          )}
        </div>
      )}

      {importPreview && (
        <Modal
          title="导入配置预览"
          description="将所选配置创建为新副本，保留原文和来源 URL；同名配置也不会覆盖。导入不会应用到内核。"
          wide
          onClose={() => setImportPreview(null)}
        >
          <div className="profile-import-summary">
            <strong>可导入 {importPreview.items.filter((item) => !item.error).length} 份</strong>
            <span>错误 {importPreview.items.filter((item) => item.error).length} 份</span>
            <span>已选择 {importPreview.chosen.size} 份</span>
          </div>
          {importPreview.globalEnhancement && (
            <label className="profile-global-import">
              <input
                type="checkbox"
                checked={importPreview.restoreGlobal}
                onChange={(event) =>
                  setImportPreview({ ...importPreview, restoreGlobal: event.target.checked })
                }
              />
              <span>
                同时恢复归档中的全局增强
                <small>
                  替换此配置库的全局 Merge 和 Script；导入时不执行脚本，也不应用到内核。
                </small>
              </span>
            </label>
          )}
          <div className="profile-import-list">
            {importPreview.items.map((item, index) => (
              <section
                key={index}
                className={`profile-import-item${item.error ? ' has-error' : ''}`}
              >
                <div className="profile-import-heading">
                  <input
                    type="checkbox"
                    aria-label={`导入 ${item.label}`}
                    checked={importPreview.chosen.has(index)}
                    disabled={!!item.error}
                    onChange={(event) =>
                      setImportPreview((current) => {
                        if (!current) return current;
                        const chosen = new Set(current.chosen);
                        if (event.target.checked) chosen.add(index);
                        else chosen.delete(index);
                        return { ...current, chosen };
                      })
                    }
                  />
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.label}</small>
                  </div>
                  {!item.error &&
                    duplicateImportNames.has(item.name.trim().toLocaleLowerCase()) && (
                      <Badge tone="orange">同名副本</Badge>
                    )}
                  {!item.error && (
                    <span>{bytes(new TextEncoder().encode(item.content).byteLength)}</span>
                  )}
                </div>
                {item.error && <p className="profile-import-error">{item.error}</p>}
                {item.description && <p>{item.description}</p>}
                {item.sourceUrl && <p className="profile-import-source">{item.sourceUrl}</p>}
                {item.content && (
                  <details>
                    <summary>查看原文</summary>
                    <pre className="profile-code">{item.content}</pre>
                  </details>
                )}
              </section>
            ))}
          </div>
          {importError && (
            <div className="profile-error" role="alert">
              {importError}
            </div>
          )}
          <div className="profile-modal-actions">
            <button
              className="button"
              disabled={!importPreview.chosen.size}
              onClick={() =>
                exportArchive(
                  importPreview.items.filter(
                    (item, index) => !item.error && importPreview.chosen.has(index),
                  ),
                  true,
                )
              }
            >
              <Download size={15} />
              下载草稿归档
            </button>
            <span />
            <button className="button" onClick={() => setImportPreview(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={!importPreview.chosen.size || importRecoveryRequired}
              onClick={confirmImport}
            >
              确认导入 {importPreview.chosen.size} 份
            </button>
          </div>
        </Modal>
      )}

      {batchDelete && (
        <Modal
          title="删除选中配置"
          description={`仅从此浏览器删除以下 ${batchDelete.length} 份配置，内核运行配置不受影响。`}
          onClose={() => setBatchDelete(null)}
        >
          <ul className="profile-delete-list">
            {batchDelete.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
          {operationError && (
            <div className="profile-error" role="alert">
              {operationError}
            </div>
          )}
          <div className="profile-modal-actions">
            <button className="button" onClick={() => setBatchDelete(null)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                const ids = new Set(batchDelete.map((item) => item.id));
                const error = persist((profiles) => profiles.filter((item) => !ids.has(item.id)));
                if (error) {
                  setOperationError(error);
                  return;
                }
                setBatchSelection((current) => new Set([...current].filter((id) => !ids.has(id))));
                if (selectedId && ids.has(selectedId)) setSelectedId(null);
                setBatchDelete(null);
                notify('已从浏览器删除选中的配置');
              }}
            >
              确认删除 {batchDelete.length} 份
            </button>
          </div>
        </Modal>
      )}

      {draft && (
        <Modal
          title={draft.fromSource ? '审阅来源更新' : draft.id ? '编辑配置' : '新建配置'}
          description={
            draft.fromSource
              ? '来源的新原文已载入草稿。保存到配置库后，可另行确认应用到内核。'
              : '保留 YAML 原文和注释。保存到浏览器后，可选择应用到内核。'
          }
          wide
          onClose={closeEditor}
        >
          <form
            className="profile-editor"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraft();
            }}
          >
            <div className="profile-editor-fields">
              <label>
                <span>配置名称</span>
                <input
                  className="field"
                  value={draft.name}
                  maxLength={100}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label>
                <span>描述</span>
                <input
                  className="field"
                  value={draft.description}
                  maxLength={500}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
            </div>
            <label>
              <span>来源 URL（可选）</span>
              <input
                className="field"
                type="url"
                value={draft.sourceUrl}
                placeholder="https://example.com/config.yaml"
                onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })}
              />
            </label>
            <label className="profile-code-label">
              <span>
                YAML 原文<small>{draftChanged ? '未保存' : '已保存原文'}</small>
              </span>
              <textarea
                aria-label="YAML 原文"
                className="field profile-code-editor"
                value={draft.content}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            </label>
            {editorError && (
              <div className="profile-error" role="alert">
                {editorError}
              </div>
            )}
            {discardConfirm && (
              <div className="profile-discard" role="alert">
                <span>草稿尚未保存，确定放弃修改？</span>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setDiscardConfirm(false)}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="button danger small"
                  onClick={() => {
                    setDraft(null);
                    setDiscardConfirm(false);
                  }}
                >
                  放弃修改
                </button>
              </div>
            )}
            <div className="profile-modal-actions">
              <button
                type="button"
                className="button"
                disabled={!draft.content}
                onClick={() => downloadContent(draft.name || '未命名配置', draft.content)}
              >
                <Download size={15} />
                下载草稿
              </button>
              <span />
              <button type="button" className="button" onClick={closeEditor}>
                取消
              </button>
              <button type="submit" className="button primary">
                <Save size={15} />
                保存配置
              </button>
            </div>
          </form>
        </Modal>
      )}

      {sourceOpen && (
        <Modal
          title="从 URL 导入"
          description="由浏览器直接读取 HTTP(S) 地址。来源站点需要允许跨域访问。"
          onClose={() => {
            cancelReading();
            setSourceOpen(false);
          }}
        >
          <form
            className="profile-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!fetching) void readSource();
            }}
          >
            <label>
              <span>配置来源 URL</span>
              <input
                className="field"
                type="url"
                value={sourceUrl}
                placeholder="https://example.com/config.yaml"
                required
                onChange={(event) => setSourceUrl(event.target.value)}
                disabled={fetching}
              />
            </label>
            {sourceError && (
              <div className="profile-error" role="alert">
                {sourceError}
              </div>
            )}
            <div className="profile-modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  cancelReading();
                  setSourceOpen(false);
                }}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={fetching || !sourceUrl.trim()}
              >
                {fetching ? <Spinner /> : <Download size={15} />}
                {fetching ? '正在读取…' : '读取配置'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="删除配置"
          description={`从此浏览器删除“${deleteTarget.name}”？这不会更改内核正在运行的配置。`}
          onClose={() => setDeleteTarget(null)}
        >
          {operationError && (
            <div className="profile-error" role="alert">
              {operationError}
            </div>
          )}
          <div className="profile-modal-actions">
            <button className="button" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                const error = persist((profiles) =>
                  profiles.filter((item) => item.id !== deleteTarget.id),
                );
                if (error) {
                  setOperationError(error);
                  return;
                }
                if (selectedId === deleteTarget.id) setSelectedId(null);
                setDeleteTarget(null);
                notify('已从浏览器删除配置');
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}

      {applyTarget && (
        <Modal
          title="应用配置"
          description={`将使用“${applyTarget.name}”的完整 YAML 替换内核运行配置，连接可能短暂中断。`}
          onClose={closeApplication}
          wide={Boolean(compiled?.stages.length)}
        >
          <div className="profile-apply-target">
            <span>目标控制器</span>
            <strong>{backend?.url ?? '未连接'}</strong>
          </div>
          {preparing && (
            <p className="profile-loading" role="status">
              <Spinner />
              正在生成配置预览…
            </p>
          )}
          {compiled && (
            <>
              {compiled.stages.length > 0 && (
                <div className="profile-apply-enhancement">
                  <strong>已生成增强配置</strong>
                  <p>{compiled.stages.map((stage) => stage.label).join(' → ')}</p>
                  <p>改动字段：{compiled.changedKeys.join('、') || '无'}。库中原文保持不变。</p>
                </div>
              )}
              <details className="profile-apply-preview" open={compiled.stages.length > 0}>
                <summary>
                  {compiled.stages.length ? '查看即将应用的最终 YAML' : '查看即将应用的原文'}
                </summary>
                <pre className="profile-code">{compiled.content}</pre>
              </details>
            </>
          )}
          {applyLogs.length > 0 && (
            <details className="profile-apply-preview" open={!compiled}>
              <summary>查看生成日志（{applyLogs.length}）</summary>
              <pre className="profile-code">
                {applyLogs.map((log) => `[${log.level}] ${log.message}`).join('\n')}
              </pre>
            </details>
          )}
          {applyError && (
            <div className="profile-error" role="alert">
              {applyError}
            </div>
          )}
          <div className="profile-modal-actions">
            {!preparing && !compiled && (
              <button className="button" onClick={() => void prepareApplication(applyTarget)}>
                重新生成预览
              </button>
            )}
            {compiled && compiled.stages.length > 0 && (
              <button
                className="button"
                onClick={() => downloadContent(`${applyTarget.name}-增强`, compiled.content)}
              >
                下载最终 YAML
              </button>
            )}
            <button className="button" disabled={applying} onClick={closeApplication}>
              取消
            </button>
            <button
              className="button primary"
              disabled={demo || !connected || coreBusy || preparing || !compiled}
              onClick={() => void applyConfiguration()}
            >
              {applying ? <Spinner /> : <Play size={15} />}
              {applying ? '正在应用…' : '确认应用'}
            </button>
          </div>
        </Modal>
      )}
      {enhancementEditor?.kind === 'global' && (
        <ProfileEnhancementEditor
          kind="global"
          initial={enhancementEditor.initial}
          profileName={editorProfile?.name ?? ''}
          baseContent={editorProfile?.content ?? ''}
          profileEnhancement={editorProfile?.enhancement}
          onSave={saveGlobalEnhancement}
          onClose={() => setEnhancementEditor(null)}
        />
      )}
      {enhancementEditor?.kind === 'profile' && (
        <ProfileEnhancementEditor
          kind="profile"
          initial={enhancementEditor.initial}
          profileName={editorProfile?.name ?? ''}
          baseContent={globalState.error ? '' : (editorProfile?.content ?? '')}
          globalEnhancement={globalState.value}
          onSave={saveProfileEnhancement}
          onClose={() => setEnhancementEditor(null)}
        />
      )}
    </div>
  );
}
