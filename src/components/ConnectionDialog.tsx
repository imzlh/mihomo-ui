import { Modal } from './ui';
import { ConnectionForm } from './ConnectionForm';

export function ConnectionDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="连接到 Mihomo"
      description="填入内核的外部控制地址，即刻开始管理网络。"
      onClose={onClose}
    >
      <ConnectionForm onClose={onClose} />
    </Modal>
  );
}
