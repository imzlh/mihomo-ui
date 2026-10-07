import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, PlugZap, ShieldCheck } from 'lucide-react';
import { Modal, Spinner } from './ui';
import { useMihomo } from '../state/mihomo';

export function ConnectionDialog({ onClose }: { onClose: () => void }) {
  const { profile, connect, cancelConnect, testing, connectError } = useMihomo();
  useEffect(() => () => cancelConnect(), [cancelConnect]);
  const [url, setUrl] = useState(profile?.url ?? 'http://127.0.0.1:9090');
  const [secret, setSecret] = useState(profile?.secret ?? '');
  const [remember, setRemember] = useState(false);
  const [visible, setVisible] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await connect({ url, secret }, remember)) onClose();
  }
  return (
    <Modal
      title="连接到 Mihomo"
      description="填入内核的外部控制地址，即刻开始管理网络。"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="connection-form">
        <div className="connection-illustration">
          <span>
            <PlugZap size={29} />
          </span>
          <div>
            <strong>你的内核，你的网络</strong>
            <p>直接连接 · 无需额外服务</p>
          </div>
          <ShieldCheck size={23} />
        </div>
        <label className="form-field">
          控制器地址
          <input
            type="url"
            required
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:9090"
            disabled={testing}
          />
          <small>对应配置中的 external-controller</small>
        </label>
        <label className="form-field">
          访问密钥 <span className="field-optional">Secret · 可选</span>
          <div className="password-field">
            <input
              type={visible ? 'text' : 'password'}
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="输入内核设置的 secret"
              disabled={testing}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={visible ? '隐藏密钥' : '显示密钥'}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住此连接和密钥 <span className="muted">（保存在本机浏览器）</span>
        </label>
        {connectError && (
          <div className="error-note" role="alert">
            {connectError}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={testing}>
            {testing ? <Spinner /> : <ArrowRight size={17} />}
            {testing ? '正在连接…' : '连接内核'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
