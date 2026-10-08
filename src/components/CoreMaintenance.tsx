import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowUpCircle,
  ChevronDown,
  Database,
  MonitorUp,
  RefreshCw,
  RotateCw,
  Wrench,
} from 'lucide-react';
import { Badge, Modal, Spinner } from './ui';
import { maintenanceStore, type MaintenanceKind } from '../lib/core-maintenance';
import { useMihomo } from '../state/mihomo';
import './core-maintenance.css';

const actions = [
  {
    kind: 'geo',
    label: '更新 GEO 数据',
    icon: Database,
    description: '下载内核配置使用的地理位置与域名数据。',
    confirmation: '从内核配置的来源更新 GEO 数据，下载可能需要一些时间。',
  },
  {
    kind: 'restart',
    label: '重启内核',
    icon: RotateCw,
    description: '重新启动 Mihomo，当前连接会短暂中断。',
    confirmation: '重启运行 Mihomo 的进程，正在进行的下载和请求可能中断。',
  },
  {
    kind: 'core',
    label: '升级内核',
    icon: ArrowUpCircle,
    description: '下载并替换当前内核，完成后重新启动。',
    confirmation: '内核将下载并替换自身可执行文件，然后重启。主机需要允许更新文件。',
  },
  {
    kind: 'ui',
    label: '更新托管面板',
    icon: MonitorUp,
    description: '更新 Mihomo external-ui 配置指定的面板。',
    confirmation: '这会替换后端托管的面板文件。更新来源由内核配置决定，可能不是当前 WebUI。',
  },
] as const;

export function CoreMaintenance({ busy = false }: { busy?: boolean }) {
  const { client, profile, connected, demo, version, refresh } = useMihomo();
  const store = maintenanceStore(client);
  const { pending, notice, configWriting } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const [confirmation, setConfirmation] = useState<MaintenanceKind | null>(null);
  const [channel, setChannel] = useState('auto');
  const [force, setForce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const currentClient = useRef(client);
  useEffect(() => {
    currentClient.current = client;
    setConfirmation(null);
    setRefreshing(false);
    return () => {
      currentClient.current = null;
    };
  }, [client, demo]);
  const selected = actions.find((action) => action.kind === confirmation);
  const disabled = !connected || !client || demo || pending !== null || configWriting || busy;

  async function refreshStatus() {
    if (!client || refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      if (currentClient.current === client) setRefreshing(false);
    }
  }

  function execute() {
    if (!confirmation || disabled) return;
    const kind = confirmation;
    setConfirmation(null);
    void store
      .execute(kind, channel === 'auto' ? undefined : channel, force || undefined)
      .then((success) => {
        if (success && client && currentClient.current === client) void refresh();
      });
  }

  return (
    <details className="panel settings-advanced core-maintenance">
      <summary>
        <span className="settings-section-heading">
          <Wrench size={19} />
          <span>内核维护</span>
          {pending ? <Spinner /> : <Badge>高级</Badge>}
        </span>
        <ChevronDown size={17} className="settings-expand-icon" />
      </summary>
      <div className="settings-advanced-content">
        <div className="maintenance-status-row">
          <span>
            内核版本 <strong>{version}</strong>
          </span>
          <Badge tone={connected ? 'green' : 'orange'}>
            {demo ? '演示数据' : connected ? '已连接' : '尚未连接'}
          </Badge>
          <button
            className="button small"
            disabled={!client || demo || refreshing || !!pending}
            onClick={() => void refreshStatus()}
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            刷新状态
          </button>
        </div>
        {demo && <p className="maintenance-note">演示模式仅预览维护操作。</p>}
        {notice && (
          <p
            className={`maintenance-notice ${notice.type}`}
            role={notice.type === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </p>
        )}
        <div className="maintenance-actions">
          {actions.map(({ kind, label, description, icon: Icon }) => (
            <div className="maintenance-row" key={kind}>
              <span className="maintenance-icon">
                <Icon size={18} />
              </span>
              <div className="maintenance-copy">
                <strong>{label}</strong>
                <p>{description}</p>
              </div>
              <button
                className="button small"
                disabled={disabled}
                onClick={() => {
                  setChannel('auto');
                  setForce(false);
                  setConfirmation(kind);
                }}
              >
                {pending === kind && <Spinner />}
                {pending === kind ? '正在执行…' : label}
              </button>
            </div>
          ))}
        </div>
      </div>
      {selected && (
        <Modal
          title={`${selected.label}？`}
          description={selected.confirmation}
          onClose={() => setConfirmation(null)}
        >
          <p className="settings-reload-target">
            目标后端：<span>{profile?.url}</span>
          </p>
          {confirmation === 'core' && (
            <div className="maintenance-upgrade-options">
              <label className="form-field">
                <span>升级通道</span>
                <select
                  className="field"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                >
                  <option value="auto">跟随当前通道</option>
                  <option value="release">稳定版 · Release</option>
                  <option value="alpha">测试版 · Alpha</option>
                </select>
              </label>
              <label className="maintenance-force">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                强制升级
              </label>
              <p className="maintenance-note">强制升级会在版本相同时重新下载。</p>
            </div>
          )}
          <div className="form-actions">
            <button className="button" onClick={() => setConfirmation(null)}>
              取消
            </button>
            <button className="button primary" disabled={disabled} onClick={execute}>
              确认执行
            </button>
          </div>
        </Modal>
      )}
    </details>
  );
}
