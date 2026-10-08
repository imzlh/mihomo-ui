import { useState } from 'react';
import { Cable, Network, Pencil, SlidersHorizontal } from 'lucide-react';
import { Badge, Modal, Spinner, Toggle } from './ui';
import type { LogLevel, MihomoConfig, MihomoConfigPatch } from '../lib/types';

const ports = [
  { key: 'mixed-port', label: '混合代理端口', short: '混合', description: 'HTTP 与 SOCKS 共用' },
  { key: 'port', label: 'HTTP 代理端口', short: 'HTTP', description: '仅处理 HTTP 代理请求' },
  { key: 'socks-port', label: 'SOCKS 代理端口', short: 'SOCKS', description: 'SOCKS 代理监听' },
  {
    key: 'redir-port',
    label: 'Redirect 端口',
    short: 'Redirect',
    description: '透明代理 · 需要后端系统支持',
  },
  {
    key: 'tproxy-port',
    label: 'TProxy 端口',
    short: 'TProxy',
    description: '透明代理 · 仅 Linux 支持',
  },
] as const;
const logLevels: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: '调试 · Debug' },
  { value: 'info', label: '信息 · Info' },
  { value: 'warning', label: '警告 · Warning' },
  { value: 'error', label: '错误 · Error' },
  { value: 'silent', label: '静默 · Silent' },
];
const processModes = [
  { value: 'strict', label: '按规则匹配 · Strict' },
  { value: 'always', label: '始终查找 · Always' },
  { value: 'off', label: '不查找 · Off' },
];
type Editor = 'ports' | 'network' | 'tun';
type Values = Record<string, string | boolean | undefined>;
type UpdateCore = (name: string, patch: MihomoConfigPatch) => Promise<boolean>;

function BooleanSetting({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean | undefined;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      {typeof value === 'boolean' ? (
        <Toggle label={label} checked={value} disabled={disabled} onChange={onChange} />
      ) : (
        <Badge>未提供</Badge>
      )}
    </div>
  );
}

/** Capture the editor once: background refreshes must not replace unsaved input. */
function editorValues(section: Editor, config: MihomoConfig): Values {
  if (section === 'ports')
    return Object.fromEntries(
      ports.map(({ key }) => [key, config[key] === undefined ? undefined : String(config[key])]),
    );
  if (section === 'network')
    return { 'bind-address': config['bind-address'], 'interface-name': config['interface-name'] };
  return {
    stack: config.tun?.stack,
    device: config.tun?.device,
    'auto-route': config.tun?.['auto-route'],
    'auto-detect-interface': config.tun?.['auto-detect-interface'],
  };
}

function RuntimeEditor({
  section,
  config,
  disabled,
  pending,
  updateCore,
  onClose,
}: {
  section: Editor;
  config: MihomoConfig;
  disabled: boolean;
  pending: string | null;
  updateCore: UpdateCore;
  onClose: () => void;
}) {
  const [initial] = useState(() => editorValues(section, config));
  const [values, setValues] = useState(initial);
  const [error, setError] = useState('');
  const changed = (key: string) => initial[key] !== undefined && values[key] !== initial[key];
  const hasChanges = Object.keys(values).some(changed);
  const edit = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError('');
  };
  const title = section === 'ports' ? '代理端口' : section === 'network' ? '网络接口' : 'TUN 设置';
  const save = async () => {
    if (disabled || !hasChanges) return;
    const patch: MihomoConfigPatch = {};
    if (section === 'ports') {
      for (const { key, label } of ports) {
        if (!changed(key)) continue;
        const value = String(values[key]).trim();
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) {
          setError(`${label}：请输入 0 到 65535 之间的整数`);
          return;
        }
        if (port !== config[key]) patch[key] = port;
      }
    } else if (section === 'network') {
      for (const key of ['bind-address', 'interface-name'] as const) {
        if (!changed(key)) continue;
        const value = String(values[key]).trim();
        if (key === 'bind-address' && !value) {
          setError('监听地址不能为空；监听所有地址可填写 *');
          return;
        }
        if (value !== config[key]) patch[key] = value;
      }
    } else {
      if (typeof config.tun?.enable !== 'boolean') return;
      const tun: NonNullable<MihomoConfigPatch['tun']> = { enable: config.tun.enable };
      for (const key of ['stack', 'device'] as const) {
        if (changed(key) && values[key] !== config.tun[key]) tun[key] = String(values[key]).trim();
      }
      for (const key of ['auto-route', 'auto-detect-interface'] as const) {
        if (changed(key) && values[key] !== config.tun[key]) tun[key] = values[key] as boolean;
      }
      if (Object.keys(tun).length > 1) patch.tun = tun;
    }
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setError('');
    if (await updateCore(section, patch)) onClose();
    else setError('更改尚未生效，请查看错误提示和内核日志后重试。');
  };
  const field = (key: string, label: string, description: string, placeholder?: string) => (
    <label className="form-field runtime-editor-field" key={key}>
      <span>{label}</span>
      <input
        className="field"
        aria-label={label}
        aria-describedby={`runtime-${key}-description`}
        value={typeof values[key] === 'string' ? values[key] : ''}
        disabled={disabled || initial[key] === undefined}
        placeholder={initial[key] === undefined ? '未提供' : placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => edit(key, event.target.value)}
      />
      <small id={`runtime-${key}-description`}>
        {initial[key] === undefined ? '后端未提供此设置' : description}
      </small>
    </label>
  );

  return (
    <Modal
      title={title}
      description={
        section === 'ports'
          ? '端口设为 0 时关闭。更改将在运行内核的设备上生效。'
          : section === 'network'
            ? '设置代理监听地址与内核使用的出站网卡。'
            : '通过虚拟网卡接管运行内核的设备流量。'
      }
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <form
        className="runtime-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        {section === 'ports' && (
          <div className="runtime-port-fields">
            {ports.map(({ key, label, description }) => (
              <label className="form-field runtime-editor-field" key={key}>
                <span>{label}</span>
                <input
                  className="field"
                  aria-label={label}
                  aria-describedby={`runtime-${key}-description`}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="65535"
                  step="1"
                  value={typeof values[key] === 'string' ? values[key] : ''}
                  placeholder={initial[key] === undefined ? '未提供' : '0'}
                  disabled={disabled || initial[key] === undefined}
                  onChange={(event) => edit(key, event.target.value)}
                />
                <small id={`runtime-${key}-description`}>
                  {initial[key] === undefined ? '后端未提供此端口' : description}
                </small>
              </label>
            ))}
          </div>
        )}
        {section === 'network' && (
          <>
            {field(
              'bind-address',
              '监听地址',
              '* 表示所有地址；其他设备访问还需要开启「允许局域网连接」',
              '*',
            )}
            {field(
              'interface-name',
              '出站接口',
              '填写内核设备上的网卡名称，留空使用自动选择',
              '自动选择',
            )}
          </>
        )}
        {section === 'tun' && (
          <>
            <label className="form-field runtime-editor-field">
              <span>TUN 协议栈</span>
              <select
                className="field"
                value={String(values.stack ?? '')}
                disabled={disabled || initial.stack === undefined}
                onChange={(event) => edit('stack', event.target.value)}
              >
                {initial.stack === undefined && <option value="">未提供</option>}
                {typeof initial.stack === 'string' &&
                  !['mixed', 'system', 'gvisor'].includes(initial.stack) && (
                    <option value={initial.stack}>{initial.stack}</option>
                  )}
                <option value="mixed">Mixed · 混合</option>
                <option value="system">System · 系统</option>
                <option value="gvisor">gVisor · 用户空间</option>
              </select>
            </label>
            {field('device', 'TUN 网卡名称', '运行内核的设备上的虚拟网卡名称', '例如 Mihomo')}
            <div className="runtime-editor-toggles">
              <BooleanSetting
                label="自动设置路由"
                description="自动将设备流量路由到 TUN 网卡"
                value={values['auto-route'] as boolean | undefined}
                disabled={disabled}
                onChange={(value) => edit('auto-route', value)}
              />
              <BooleanSetting
                label="自动识别出站接口"
                description="由内核识别用于出站连接的网卡"
                value={values['auto-detect-interface'] as boolean | undefined}
                disabled={disabled}
                onChange={(value) => edit('auto-detect-interface', value)}
              />
            </div>
            <p className="info-note runtime-editor-note">
              TUN 需要内核设备的网络管理权限；保存后会核对实际生效状态。
            </p>
          </>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" disabled={pending !== null} onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={disabled || !hasChanges} type="submit">
            {pending && <Spinner />}
            {pending ? '正在应用…' : '应用更改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RuntimeSettings({
  config,
  connected,
  demo,
  pending,
  disabled,
  updateCore,
}: {
  config: MihomoConfig | undefined;
  connected: boolean;
  demo: boolean;
  pending: string | null;
  disabled: boolean;
  updateCore: UpdateCore;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <section
      className="panel settings-section runtime-settings"
      aria-labelledby="core-heading"
      aria-busy={pending !== null}
    >
      <div className="settings-section-heading">
        <SlidersHorizontal size={19} />
        <h2 id="core-heading">内核设置</h2>
        {pending && <Spinner />}
        {demo && <Badge tone="purple">仅影响演示</Badge>}
      </div>
      {!connected ? (
        <p className="info-note settings-core-note">连接后端后，即可读取和修改内核设置。</p>
      ) : !config ? (
        <p className="info-note settings-core-note">
          <Spinner />
          正在读取内核配置…
        </p>
      ) : null}
      <div className="runtime-group-heading">
        <Cable size={15} />
        <h3>监听与网络</h3>
      </div>
      <div className="setting-row runtime-summary-row">
        <div className="setting-copy">
          <strong>代理端口</strong>
          <div className="runtime-port-summary">
            {ports.map(({ key, short }) => (
              <span key={key}>
                {short}
                <b>
                  {config?.[key] === undefined
                    ? '未提供'
                    : config[key] === 0
                      ? '关闭'
                      : config[key]}
                </b>
              </span>
            ))}
          </div>
        </div>
        <button
          className="button runtime-edit-button"
          disabled={disabled || !ports.some(({ key }) => config?.[key] !== undefined)}
          onClick={() => setEditor('ports')}
          aria-label="配置代理端口"
        >
          <Pencil size={14} />
          配置
        </button>
      </div>
      <BooleanSetting
        label="允许局域网连接"
        description="让局域网中的其他设备使用此内核的代理服务"
        value={config?.['allow-lan']}
        disabled={disabled}
        onChange={(value) => void updateCore('allow-lan', { 'allow-lan': value })}
      />
      <div className="setting-row runtime-summary-row">
        <div className="setting-copy">
          <strong>网络接口</strong>
          <p className="runtime-interface-summary">
            <span>监听 {config?.['bind-address'] ?? '未提供'}</span>
            <span>
              出站{' '}
              {config?.['interface-name'] === ''
                ? '自动选择'
                : (config?.['interface-name'] ?? '未提供')}
            </span>
          </p>
        </div>
        <button
          className="button runtime-edit-button"
          disabled={
            disabled ||
            (config?.['bind-address'] === undefined && config?.['interface-name'] === undefined)
          }
          onClick={() => setEditor('network')}
          aria-label="配置网络接口"
        >
          <Pencil size={14} />
          配置
        </button>
      </div>
      <div className="runtime-group-heading">
        <SlidersHorizontal size={15} />
        <h3>连接行为</h3>
      </div>
      <BooleanSetting
        label="IPv6"
        description="允许内核处理 IPv6 连接"
        value={config?.ipv6}
        disabled={disabled}
        onChange={(value) => void updateCore('ipv6', { ipv6: value })}
      />
      <BooleanSetting
        label="TCP 并发连接"
        description="并发尝试解析出的 IP，使用最先建立的连接"
        value={config?.['tcp-concurrent']}
        disabled={disabled}
        onChange={(value) => void updateCore('tcp-concurrent', { 'tcp-concurrent': value })}
      />
      <BooleanSetting
        label="域名嗅探"
        description="从连接内容识别域名，辅助匹配代理规则"
        value={config?.sniffing}
        disabled={disabled}
        onChange={(value) => void updateCore('sniffing', { sniffing: value })}
      />
      <div className="setting-row runtime-select-row">
        <div className="setting-copy">
          <label htmlFor="settings-process-mode">进程匹配模式</label>
          <p>控制内核何时查找连接所属进程</p>
        </div>
        <select
          id="settings-process-mode"
          className="field settings-select"
          value={config?.['find-process-mode'] ?? ''}
          disabled={disabled || config?.['find-process-mode'] === undefined}
          onChange={(event) =>
            void updateCore('find-process-mode', { 'find-process-mode': event.target.value })
          }
        >
          {config?.['find-process-mode'] === undefined && <option value="">未提供</option>}
          {config?.['find-process-mode'] !== undefined &&
            !processModes.some(({ value }) => value === config['find-process-mode']) && (
              <option value={config['find-process-mode']}>{config['find-process-mode']}</option>
            )}
          {processModes.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row runtime-select-row">
        <div className="setting-copy">
          <label htmlFor="settings-log-level">日志级别</label>
          <p>控制内核输出日志的详细程度</p>
        </div>
        <select
          id="settings-log-level"
          className="field settings-select"
          value={config?.['log-level'] ?? ''}
          disabled={disabled || config?.['log-level'] === undefined}
          onChange={(event) =>
            void updateCore('log-level', { 'log-level': event.target.value as LogLevel })
          }
        >
          {config?.['log-level'] === undefined && <option value="">未提供</option>}
          {logLevels.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="runtime-group-heading">
        <Network size={15} />
        <h3>虚拟网卡</h3>
      </div>
      <BooleanSetting
        label="TUN 模式"
        description="通过虚拟网卡接管运行内核的设备流量"
        value={config?.tun?.enable}
        disabled={disabled}
        onChange={(enable) => void updateCore('tun', { tun: { enable } })}
      />
      <div className="setting-row runtime-summary-row">
        <div className="setting-copy">
          <strong>TUN 参数</strong>
          <p>
            {config?.tun?.stack ?? '协议栈未提供'}
            {config?.tun?.device ? ` · ${config.tun.device}` : ''} · 需要内核设备的网络管理权限
          </p>
        </div>
        <button
          className="button runtime-edit-button"
          disabled={disabled || typeof config?.tun?.enable !== 'boolean'}
          onClick={() => setEditor('tun')}
          aria-label="配置 TUN"
        >
          <Pencil size={14} />
          配置
        </button>
      </div>
      <p className="runtime-footnote">
        设置即时应用于内核运行状态；重新加载配置后可能被覆盖。后端未返回的选项显示为「未提供」。
      </p>
      {editor && config && (
        <RuntimeEditor
          section={editor}
          config={config}
          disabled={disabled}
          pending={pending}
          updateCore={updateCore}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
