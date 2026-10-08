import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Archive,
  CloudDownload,
  CloudUpload,
  Download,
  HardDrive,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge, Modal, Spinner } from './ui';
import { useMihomo } from '../state/mihomo';
import { MihomoApiError } from '../lib/mihomo';
import type { JsonValue } from '../lib/types';
import {
  BACKUP_STORAGE_KEY,
  MAX_BACKUP_BYTES,
  PREFERENCE_LABELS,
  createPreferenceBackup,
  parsePreferenceBackup,
  preferenceBackupStore,
  restorePreferenceBackup,
  serializePreferenceBackup,
  validatePreferenceBackup,
  type BackupPreferences,
  type PreferenceBackupData,
} from '../lib/preference-backup';
import { notifyPreferencesChanged } from '../lib/preference-events';
import './preference-backup.css';

type Operation = 'file' | 'read' | 'save' | 'delete';
type DialogState = { kind: 'restore' | 'save'; data: PreferenceBackupData } | { kind: 'delete' };
const controllerLabel = (scope: string) =>
  scope === 'demo' ? '演示模式' : scope === 'offline' ? '尚未连接' : scope;
const errorMessage = (error: unknown) =>
  error instanceof MihomoApiError && error.status
    ? `HTTP ${error.status} · ${error.message}`
    : error instanceof Error
      ? error.message
      : '操作失败，请稍后重试';

function summaries(preferences: BackupPreferences): [string, string][] {
  const values: Partial<Record<keyof BackupPreferences, string>> = {};
  if (preferences.theme)
    values.theme = { light: '浅色', dark: '深色', system: '跟随系统' }[preferences.theme];
  if (preferences.home) {
    const { cards, chartStyle, autoDelay, autoDelayMinutes } = preferences.home;
    values.home = `${Object.values(cards).filter(Boolean).length} 张卡片 · ${chartStyle === 'line' ? '折线图' : '面积图'} · ${autoDelay ? `每 ${autoDelayMinutes} 分钟测速` : '手动测速'}`;
  }
  if (preferences.homeGroup !== undefined) values.homeGroup = preferences.homeGroup || '默认选择';
  if (preferences.homeProvider !== undefined)
    values.homeProvider = preferences.homeProvider || '默认选择';
  if (preferences.closeOnSwitch !== undefined)
    values.closeOnSwitch = preferences.closeOnSwitch ? '开启' : '关闭';
  if (preferences.connections)
    values.connections = `${preferences.connections.view === 'list' ? '列表' : '表格'} · ${preferences.connections.columns.length} 列 · 活动与关闭记录的排序`;
  if (preferences.proxies) {
    const { sortOrder, density, columns, expandedGroups } = preferences.proxies;
    values.proxies = `${{ original: '原始排序', name: '名称排序', latency: '延迟排序' }[sortOrder]} · ${density === 'compact' ? '紧凑' : '宽松'} · ${columns === 'auto' ? '自动列数' : `${columns} 列`} · ${Object.keys(expandedGroups).length} 个组的展开状态`;
  }
  if (preferences.logOrder)
    values.logOrder = preferences.logOrder === 'asc' ? '旧日志在前' : '新日志在前';
  if (preferences.connectivity)
    values.connectivity = `${preferences.connectivity.targets.length} 个目标 · ${preferences.connectivity.exit?.name ?? '未指定出口'}`;
  return (Object.keys(values) as (keyof BackupPreferences)[]).map((key) => [
    PREFERENCE_LABELS[key],
    values[key]!,
  ]);
}

export function PreferenceBackup() {
  const { client, profile, demo, connected } = useMihomo();
  const scope = demo ? 'demo' : (profile?.url ?? 'offline');
  const [localBusy, setBusy] = useState<Operation | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const pending = useRef(false);
  const reader = useRef<AbortController | null>(null);
  const remoteStore = preferenceBackupStore(client);
  const remoteBusy = useSyncExternalStore(remoteStore.subscribe, remoteStore.getSnapshot);
  const busy = localBusy ?? remoteBusy;
  const remoteDisabled = !client || !connected || demo || busy !== null;

  useEffect(() => {
    epoch.current += 1;
    pending.current = false;
    setBusy(null);
    setDialog(null);
    setNotice(null);
    return () => {
      epoch.current += 1;
      reader.current?.abort();
    };
  }, [client, demo]);

  async function perform<T>(kind: Operation, action: () => Promise<T>, commit: (value: T) => void) {
    if (pending.current) return;
    const capturedStore = kind === 'file' ? null : remoteStore;
    if (capturedStore && kind !== 'file' && !capturedStore.begin(kind)) return;
    pending.current = true;
    const ticket = epoch.current;
    setBusy(kind);
    setNotice(null);
    try {
      const result = await action();
      if (epoch.current === ticket) commit(result);
    } catch (error) {
      if (epoch.current === ticket) setNotice({ text: errorMessage(error), error: true });
    } finally {
      capturedStore?.finish();
      if (epoch.current === ticket) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  function download() {
    try {
      const data = createPreferenceBackup(scope);
      const url = URL.createObjectURL(
        new Blob([serializePreferenceBackup(data)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `mihomo-verge-preferences-${data.createdAt.slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice({ text: '偏好备份已准备下载', error: false });
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    }
  }

  function importFile(file: File) {
    if (file.size > MAX_BACKUP_BYTES) {
      setNotice({ text: '备份文件不能超过 1 MiB', error: true });
      return;
    }
    void perform(
      'file',
      async () => parsePreferenceBackup(await file.text()),
      (data) => setDialog({ kind: 'restore', data }),
    );
  }

  function readRemote() {
    if (remoteDisabled || !client) return;
    void perform(
      'read',
      async () => {
        const controller = new AbortController();
        reader.current = controller;
        const raw = await client.getStorage<unknown>(BACKUP_STORAGE_KEY, controller.signal);
        if (raw === null) throw new Error('当前后端尚未保存偏好备份');
        return validatePreferenceBackup(raw);
      },
      (data) => setDialog({ kind: 'restore', data }),
    );
  }

  function prepareSave() {
    if (remoteDisabled) return;
    try {
      setDialog({ kind: 'save', data: createPreferenceBackup(scope) });
      setNotice(null);
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    }
  }

  function confirm() {
    if (!dialog || pending.current) return;
    if (dialog.kind === 'restore') {
      try {
        const count = restorePreferenceBackup(dialog.data, scope);
        notifyPreferencesChanged();
        setDialog(null);
        setNotice({ text: `已恢复 ${count} 项偏好，当前页面已更新`, error: false });
      } catch (error) {
        setNotice({ text: errorMessage(error), error: true });
      }
      return;
    }
    if (remoteDisabled || !client) return;
    const kind = dialog.kind;
    const data =
      kind === 'save'
        ? (dialog as Extract<DialogState, { data: PreferenceBackupData }>).data
        : null;
    void perform(
      kind,
      async () => {
        if (data)
          await client.setStorage(
            BACKUP_STORAGE_KEY,
            JSON.parse(serializePreferenceBackup(data)) as JsonValue,
          );
        else await client.deleteStorage(BACKUP_STORAGE_KEY);
      },
      () => {
        setDialog(null);
        setNotice({
          text: kind === 'save' ? '已保存到当前后端' : '已删除后端备份，当前浏览器偏好保持不变',
          error: false,
        });
      },
    );
  }

  const dialogNotice = dialog && notice;
  return (
    <section
      className="panel settings-section preference-backup"
      aria-labelledby="preference-backup-heading"
      aria-busy={busy !== null}
    >
      <div className="settings-section-heading">
        <Archive size={19} />
        <h2 id="preference-backup-heading">偏好备份</h2>
        <Badge>界面偏好</Badge>
        {busy && <Spinner />}
      </div>
      <p className="backup-intro">
        保存当前控制器的布局、排序和测试目标，以及全局主题。连接密钥与内核配置不包含在备份中。
      </p>
      <div className="backup-options">
        <div className="backup-option">
          <div className="backup-option-heading">
            <HardDrive size={17} />
            <strong>本地文件</strong>
          </div>
          <p>下载 JSON 备份，或预览文件中的偏好后恢复。</p>
          <div className="backup-actions">
            <button className="button" disabled={busy !== null} onClick={download}>
              <Download size={15} />
              下载备份
            </button>
            <button
              className="button"
              disabled={busy !== null}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={15} />
              导入备份
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="选择偏好备份文件"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) importFile(file);
            }}
          />
        </div>
        <div className="backup-option">
          <div className="backup-option-heading">
            <CloudUpload size={17} />
            <strong>保存到后端</strong>
          </div>
          <p>
            {demo
              ? '演示模式下可使用本地文件备份。'
              : '在当前后端保存一份偏好，需要时手动读取并恢复。'}
          </p>
          <div className="backup-actions">
            <button className="button" disabled={remoteDisabled} onClick={prepareSave}>
              <CloudUpload size={15} />
              保存到当前后端
            </button>
            <button className="button" disabled={remoteDisabled} onClick={readRemote}>
              {busy === 'read' ? <Spinner /> : <CloudDownload size={15} />}
              {busy === 'read' ? '正在读取…' : '从后端读取'}
            </button>
            <button
              className="icon-button backup-delete"
              disabled={remoteDisabled}
              onClick={() => {
                setDialog({ kind: 'delete' });
                setNotice(null);
              }}
              aria-label="删除后端备份"
              title="删除后端备份"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>
      {!dialog && notice && (
        <p
          className={`backup-notice${notice.error ? ' error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      {dialog && (
        <Modal
          title={
            dialog.kind === 'restore'
              ? '恢复偏好预览'
              : dialog.kind === 'save'
                ? '保存偏好到后端？'
                : '删除后端备份？'
          }
          description={
            dialog.kind === 'restore'
              ? '确认后，将这些偏好应用到当前控制器与浏览器。'
              : dialog.kind === 'save'
                ? '保存会覆盖此后端之前保存的偏好备份。'
                : '仅删除此后端保存的偏好备份，当前浏览器偏好保持不变。'
          }
          onClose={() => {
            if (!pending.current) {
              setDialog(null);
              setNotice(null);
            }
          }}
        >
          <dl className="backup-targets">
            {dialog.kind === 'restore' && (
              <div>
                <dt>来源控制器</dt>
                <dd>{controllerLabel(dialog.data.source.controller)}</dd>
              </div>
            )}
            <div>
              <dt>{dialog.kind === 'restore' ? '目标控制器' : '当前后端'}</dt>
              <dd>{controllerLabel(scope)}</dd>
            </div>
            {dialog.kind !== 'delete' && (
              <div>
                <dt>备份时间</dt>
                <dd>
                  {new Date(dialog.data.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </dd>
              </div>
            )}
          </dl>
          {dialog.kind !== 'delete' && (
            <dl className="backup-preview">
              {summaries(dialog.data.preferences).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {dialog.kind === 'restore' && dialog.data.source.controller !== scope && (
            <p className="backup-scope-note">
              首页的代理组或代理集不存在时使用默认选择；连通性测试出口不存在时需重新选择。
            </p>
          )}
          {dialogNotice && (
            <p
              className={`backup-notice${dialogNotice.error ? ' error' : ''}`}
              role={dialogNotice.error ? 'alert' : 'status'}
            >
              {dialogNotice.text}
            </p>
          )}
          <div className="form-actions">
            <button
              className="button"
              disabled={busy !== null}
              onClick={() => {
                setDialog(null);
                setNotice(null);
              }}
            >
              取消
            </button>
            <button className="button primary" disabled={busy !== null} onClick={confirm}>
              {busy && <Spinner />}
              {busy
                ? '正在处理…'
                : dialog.kind === 'restore'
                  ? '确认恢复'
                  : dialog.kind === 'save'
                    ? '确认保存'
                    : '确认删除'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
