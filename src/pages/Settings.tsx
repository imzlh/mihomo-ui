import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  FileCode2,
  Monitor,
  Moon,
  Palette,
  PlugZap,
  RefreshCw,
  Server,
  Sun,
  Unplug,
} from 'lucide-react';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { CoreMaintenance } from '../components/CoreMaintenance';
import { RuntimeSettings } from '../components/RuntimeSettings';
import { PreferenceBackup } from '../components/PreferenceBackup';
import { Badge, Modal, PageHeader, Spinner } from '../components/ui';
import type { MihomoConfigPatch } from '../lib/types';
import { maintenanceStore } from '../lib/core-maintenance';
import { useMihomo } from '../state/mihomo';
import './settings.css';

type ThemePreference = 'light' | 'dark' | 'system';
const themeKey = 'mihomo-verge.theme';
const themes = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;

function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(themeKey);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* Theme selection still works for the current browser session. */
  }
  return 'system';
}

export default function Settings() {
  const { client, demo } = useMihomo();
  const [scope, setScope] = useState({ client, demo, id: 0 });
  if (scope.client !== client || scope.demo !== demo) {
    setScope({ client, demo, id: scope.id + 1 });
  }
  return <SessionSettings key={scope.id} />;
}

/** A new controller session starts with fresh drafts, confirmations and busy state. */
function SessionSettings() {
  const {
    profile,
    demo,
    client,
    connected,
    status,
    config,
    version,
    disconnect,
    patchConfig,
    reloadConfig,
    notify,
  } = useMihomo();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const [pending, setPending] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState('');
  const active = useRef(false);
  const maintenance = maintenanceStore(client);
  const { pending: maintenancePending, configWriting } = useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
  );
  const coreDisabled =
    !connected ||
    !config ||
    pending !== null ||
    reloading ||
    maintenancePending !== null ||
    configWriting;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener('theme-change', sync);
    return () => window.removeEventListener('theme-change', sync);
  }, []);

  const selectTheme = (value: ThemePreference) => {
    try {
      localStorage.setItem(themeKey, value);
    } catch {
      notify('主题已应用，浏览器未允许保存偏好', 'info');
    }
    document.documentElement.dataset.theme =
      value === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : value;
    window.dispatchEvent(new Event('theme-change'));
    setTheme(value);
  };

  const updateCore = async (name: string, patch: MihomoConfigPatch): Promise<boolean> => {
    if (coreDisabled) return false;
    setPending(name);
    try {
      const success = await patchConfig(patch);
      return active.current && success;
    } finally {
      if (active.current) setPending(null);
    }
  };

  const reload = async () => {
    if (
      !client ||
      demo ||
      !content.trim() ||
      reloading ||
      maintenancePending !== null ||
      configWriting
    )
      return;
    setReloading(true);
    setReloadError('');
    try {
      const success = await reloadConfig(content.trim(), (message) => {
        if (active.current) setReloadError(message);
      });
      if (!active.current) return;
      if (success) setReloadConfirm(false);
      else setReloadError((current) => current || '重新加载失败，请检查后端连接后重试');
    } finally {
      if (active.current) setReloading(false);
    }
  };

  const backendLabel = demo
    ? '演示模式'
    : connected
      ? '已连接'
      : status === 'connecting'
        ? '连接中'
        : profile
          ? '连接不可用'
          : '未连接';

  return (
    <div className="settings-page">
      <PageHeader title="设置" description="让每一次连接，都更合你意。" />

      <section className="panel settings-section" aria-labelledby="backend-heading">
        <div className="settings-section-heading">
          <Server size={19} />
          <h2 id="backend-heading">后端连接</h2>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <div className="settings-title-line">
              <strong>Mihomo 内核</strong>
              <Badge tone={demo ? 'purple' : connected ? 'green' : profile ? 'orange' : 'neutral'}>
                {backendLabel}
              </Badge>
            </div>
            <p className="settings-backend-address">
              {demo
                ? '正在浏览本地示例数据'
                : (profile?.url ?? '连接你的 Mihomo，开始管理代理与流量')}
            </p>
            {connected && !demo && <span className="settings-version">内核版本 {version}</span>}
          </div>
          <div className="settings-backend-actions">
            {(profile || demo) && (
              <button className="button settings-disconnect" onClick={disconnect}>
                <Unplug size={15} />
                {demo ? '退出演示' : '断开连接'}
              </button>
            )}
            <button className="button primary" onClick={() => setConnectionOpen(true)}>
              <PlugZap size={16} />
              {profile && !demo ? '更改连接' : '连接后端'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel settings-section" aria-labelledby="appearance-heading">
        <div className="settings-section-heading">
          <Palette size={19} />
          <h2 id="appearance-heading">外观</h2>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>界面主题</strong>
            <p>选择你喜欢的明暗风格</p>
          </div>
          <div className="segmented settings-theme-options" role="group" aria-label="界面主题">
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                className={theme === value ? 'active' : ''}
                aria-pressed={theme === value}
                onClick={() => selectTheme(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <PreferenceBackup />

      <RuntimeSettings
        key={JSON.stringify([profile?.url, profile?.secret, demo])}
        config={config}
        connected={connected}
        demo={demo}
        pending={pending ?? (configWriting ? 'config-write' : null)}
        disabled={coreDisabled}
        updateCore={updateCore}
      />

      <CoreMaintenance busy={pending !== null || reloading} />

      <details className="panel settings-advanced">
        <summary>
          <span className="settings-section-heading">
            <FileCode2 size={19} />
            <span>重新加载配置</span>
          </span>
          <ChevronDown size={17} className="settings-expand-icon" />
        </summary>
        <div className="settings-advanced-content">
          <p className="muted">
            粘贴完整的 YAML 配置，替换内核当前使用的配置。请先保留原配置备份。{' '}
            保存和管理多份配置，可<Link to="/profiles">打开配置库</Link>。
          </p>
          <label className="form-field settings-yaml-label" htmlFor="settings-config-yaml">
            <span>配置内容</span>
            <textarea
              id="settings-config-yaml"
              className="field settings-yaml"
              rows={9}
              spellCheck={false}
              autoComplete="off"
              value={content}
              disabled={reloading}
              placeholder={'# 粘贴完整的 Mihomo YAML 配置\nmixed-port: 7890\nmode: rule\n…'}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <div className="settings-reload-footer">
            <p className="muted">
              {demo ? '演示模式不会提交或替换真实配置。' : '配置内容由 Mihomo 内核校验。'}
            </p>
            <button
              className="button"
              disabled={
                !connected ||
                demo ||
                !client ||
                !content.trim() ||
                reloading ||
                pending !== null ||
                maintenancePending !== null ||
                configWriting
              }
              onClick={() => {
                setReloadError('');
                setReloadConfirm(true);
              }}
            >
              <RefreshCw size={15} />
              重新加载
            </button>
          </div>
        </div>
      </details>

      {connectionOpen && <ConnectionDialog onClose={() => setConnectionOpen(false)} />}
      {reloadConfirm && (
        <Modal
          title="重新加载内核配置？"
          description="当前配置将被替换，现有代理连接可能受到影响。"
          onClose={() => {
            if (!reloading) setReloadConfirm(false);
          }}
        >
          <p className="settings-reload-target">
            目标后端：<span>{profile?.url}</span>
          </p>
          {reloadError && (
            <p className="settings-error" role="alert">
              {reloadError}
            </p>
          )}
          <div className="form-actions">
            <button className="button" disabled={reloading} onClick={() => setReloadConfirm(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={reloading || !connected || maintenancePending !== null || configWriting}
              onClick={() => void reload()}
            >
              {reloading ? <Spinner /> : <RefreshCw size={15} />}
              {reloading ? '正在重新加载…' : '确认重新加载'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
