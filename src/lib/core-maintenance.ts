import { MihomoApiError, type MihomoClient } from './mihomo';

export type MaintenanceKind = 'restart' | 'geo' | 'core' | 'ui';
export interface MaintenanceState {
  pending: MaintenanceKind | null;
  configWriting: boolean;
  notice: { type: 'success' | 'info' | 'error'; text: string } | null;
}

const initialState: MaintenanceState = { pending: null, configWriting: false, notice: null };
const accepted: Record<MaintenanceKind, string> = {
  restart: '内核已接受重启请求。连接可能短暂中断，请在重新连接后刷新状态。',
  core: '内核已接受升级请求，将重新启动。请在重新连接后核对版本。',
  geo: 'GEO 数据已更新。',
  ui: '后端托管面板已更新。',
};

function createStore(client: MihomoClient | null) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const publish = (next: MaintenanceState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beginConfigWrite(): boolean {
      if (!client || state.pending || state.configWriting) return false;
      publish({ ...state, configWriting: true });
      return true;
    },
    endConfigWrite() {
      publish({ ...state, configWriting: false });
    },
    async execute(kind: MaintenanceKind, channel?: string, force?: boolean): Promise<boolean> {
      if (!client || state.pending || state.configWriting) return false;
      publish({ ...state, pending: kind, notice: null });
      try {
        if (kind === 'restart') await client.restart();
        else if (kind === 'geo') await client.updateGeo();
        else if (kind === 'core') await client.upgradeCore(channel, force);
        else await client.upgradeUi();
        publish({
          ...state,
          pending: null,
          notice: {
            type: kind === 'core' || kind === 'restart' ? 'info' : 'success',
            text: accepted[kind],
          },
        });
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : '维护请求失败，请查看内核状态。';
        const uncertain = error instanceof MihomoApiError && error.status === undefined;
        publish({
          ...state,
          pending: null,
          notice: {
            type: 'error',
            text: uncertain
              ? `未收到内核确认，操作可能已执行。请检查内核状态后再操作。${detail}`
              : detail,
          },
        });
        return false;
      }
    },
  };
}

// An accepted maintenance request cannot be cancelled by navigating away.
const stores = new WeakMap<MihomoClient, ReturnType<typeof createStore>>();
const disconnectedStore = createStore(null);
export function maintenanceStore(client: MihomoClient | null) {
  if (!client) return disconnectedStore;
  let store = stores.get(client);
  if (!store) {
    store = createStore(client);
    stores.set(client, store);
  }
  return store;
}
