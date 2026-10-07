import { useEffect, useState } from 'react';
import {
  ChevronDown,
  FileCode2,
  Monitor,
  Moon,
  Palette,
  PlugZap,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sun,
  Unplug,
} from 'lucide-react';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { Badge, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import type { LogLevel, MihomoConfig } from '../lib/types';
import { useMihomo } from '../state/mihomo';
import './settings.css';

type ThemePreference = 'light' | 'dark' | 'system';
const themeKey = 'mihomo-verge.theme';
const themes = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;
const logLevels: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: '调试 · Debug' },
  { value: 'info', label: '信息 · Info' },
  { value: 'warning', label: '警告 · Warning' },
  { value: 'error', label: '错误 · Error' },
  { value: 'silent', label: '静默 · Silent' },
];

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
    runAction,
    notify,
  } = useMihomo();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const [pending, setPending] = useState<string | null>(null);
  const [mixedPort, setMixedPort] = useState(config ? String(config['mixed-port']) : '');
  const [portError, setPortError] = useState('');
  const [content, setContent] = useState('');
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState('');
  const coreDisabled = !connected || !config || pending !== null || reloading;

  useEffect(() => {
    setMixedPort(config ? String(config['mixed-port']) : '');
    setPortError('');
  }, [config?.['mixed-port'], profile?.url, demo]);

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

  const updateCore = async (name: string, patch: Partial<MihomoConfig>) => {
    if (coreDisabled) return;
    setPending(name);
    try {
      await patchConfig(patch);
    } finally {
      setPending(null);
    }
  };

  const applyPort = () => {
    const port = Number(mixedPort);
    if (!/^\d+$/.test(mixedPort.trim()) || !Number.isInteger(port) || port < 0 || port > 65535) {
      setPortError('请输入 0 到 65535 之间的整数');
      return;
    }
    setPortError('');
    void updateCore('mixed-port', { 'mixed-port': port });
  };

  const reload = async () => {
    if (!client || demo || !content.trim() || reloading) return;
    setReloading(true);
    setReloadError('');
    try {
      const success = await runAction(async () => {
        try {
          await client.reloadConfig(content.trim());
        } catch (error) {
          setReloadError(error instanceof Error ? error.message : '重新加载失败，请检查配置内容');
          throw error;
        }
      }, '配置已重新加载');
      if (success) setReloadConfirm(false);
      else setReloadError((current) => current || '重新加载失败，请检查后端连接后重试');
    } finally {
      setReloading(false);
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

      <section
        className="panel settings-section"
        aria-labelledby="core-heading"
        aria-busy={pending !== null}
      >
        <div className="settings-section-heading">
          <SlidersHorizontal size={19} />
          <h2 id="core-heading">内核设置</h2>
          {pending && <Spinner />}
          {demo && <Badge tone="purple">仅影响演示</Badge>}
        </div>
        {!connected && (
          <p className="info-note settings-core-note">连接后端后，即可读取和修改内核设置。</p>
        )}
        {connected && !config && (
          <p className="info-note settings-core-note">
            <Spinner />
            正在读取内核配置…
          </p>
        )}
        <div className="setting-row">
          <div className="setting-copy">
            <strong>允许局域网连接</strong>
            <p>让局域网中的其他设备使用此内核的代理服务</p>
          </div>
          <Toggle
            label="允许局域网连接"
            checked={config?.['allow-lan'] ?? false}
            disabled={coreDisabled}
            onChange={(value) => void updateCore('allow-lan', { 'allow-lan': value })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>IPv6</strong>
            <p>允许内核处理 IPv6 连接</p>
          </div>
          <Toggle
            label="IPv6"
            checked={config?.ipv6 ?? false}
            disabled={coreDisabled}
            onChange={(value) => void updateCore('ipv6', { ipv6: value })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <label htmlFor="settings-log-level">日志级别</label>
            <p>控制内核输出日志的详细程度</p>
          </div>
          <select
            id="settings-log-level"
            className="field settings-select"
            value={config?.['log-level'] ?? 'info'}
            disabled={coreDisabled}
            onChange={(event) =>
              void updateCore('log-level', { 'log-level': event.target.value as LogLevel })
            }
          >
            {logLevels.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row settings-port-row">
          <div className="setting-copy">
            <label htmlFor="settings-mixed-port">混合代理端口</label>
            <p>HTTP 与 SOCKS 共用端口，设为 0 时关闭</p>
          </div>
          <div className="settings-port-control">
            <div className="settings-inline-controls">
              <input
                id="settings-mixed-port"
                className="field"
                type="number"
                min="0"
                max="65535"
                step="1"
                placeholder="7890"
                value={mixedPort}
                disabled={coreDisabled}
                aria-invalid={!!portError}
                aria-describedby={portError ? 'settings-port-error' : undefined}
                onChange={(event) => {
                  setMixedPort(event.target.value);
                  setPortError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyPort();
                }}
              />
              <button
                className="button"
                disabled={coreDisabled || mixedPort === String(config?.['mixed-port'] ?? '')}
                onClick={applyPort}
              >
                {pending === 'mixed-port' ? <Spinner /> : null}应用
              </button>
            </div>
            {portError && (
              <p id="settings-port-error" className="settings-error" role="alert">
                {portError}
              </p>
            )}
          </div>
        </div>
        {config?.tun && (
          <>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>TUN 模式</strong>
                <p>
                  通过虚拟网卡接管运行内核的设备流量
                  {config.tun.stack ? ` · ${config.tun.stack}` : ''}
                </p>
              </div>
              <Toggle
                label="TUN 模式"
                checked={config.tun.enable}
                disabled={coreDisabled}
                onChange={(enable) => void updateCore('tun', { tun: { ...config.tun, enable } })}
              />
            </div>
            <p className="info-note settings-core-note">
              TUN 在运行 Mihomo 的设备上生效，需要该设备授予内核相应的网络管理权限。
            </p>
          </>
        )}
      </section>

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
            粘贴完整的 YAML 配置，替换内核当前使用的配置。请先保留原配置备份。
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
                !connected || demo || !client || !content.trim() || reloading || pending !== null
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
              disabled={reloading || !connected}
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
