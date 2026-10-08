import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProfileScript } from './profile-script';
import type {
  ProfileScriptInput,
  ProfileScriptResult,
  ProfileScriptWorkerInput,
  ProfileScriptWorkerMessage,
} from './profile-script-protocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructorError: Error | null = null;
  static postError: Error | null = null;
  onmessage: ((event: MessageEvent<ProfileScriptWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_message: ProfileScriptWorkerInput) => {
    if (FakeWorker.postError) throw FakeWorker.postError;
  });

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    if (FakeWorker.constructorError) throw FakeWorker.constructorError;
    FakeWorker.instances.push(this);
  }

  emit(message: ProfileScriptWorkerMessage) {
    this.onmessage?.({ data: message } as MessageEvent<ProfileScriptWorkerMessage>);
  }
}

const input: ProfileScriptInput = {
  config: { mode: 'rule', rules: ['MATCH,DIRECT'] },
  script: 'function main(config, profileName) { return config; }',
  profileName: '工作配置',
};
const success: ProfileScriptResult = {
  ok: true,
  config: { mode: 'global' },
  logs: [{ level: 'info', message: 'Finished' }],
};

function worker() {
  expect(FakeWorker.instances).toHaveLength(1);
  return FakeWorker.instances[0]!;
}

function expectCleanedUp(instance: FakeWorker) {
  expect(instance.terminate).toHaveBeenCalledTimes(1);
  expect(instance.onmessage).toBeNull();
  expect(instance.onerror).toBeNull();
  expect(instance.onmessageerror).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  FakeWorker.constructorError = null;
  FakeWorker.postError = null;
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('profile Script Worker lifecycle', () => {
  it('sends only the three declared input fields, without reading browser credentials, and terminates on success', async () => {
    const readStorage = vi.fn(() => '{"secret":"browser-controller-secret"}');
    vi.stubGlobal('localStorage', { getItem: readStorage });
    vi.stubGlobal('sessionStorage', { getItem: readStorage });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const richerInput = {
      ...input,
      controller: { url: 'http://127.0.0.1:9090', secret: 'must-not-cross-worker-boundary' },
    };
    const pending = runProfileScript(richerInput, { signal: controller.signal });
    const instance = worker();
    expect(instance.options).toEqual({ type: 'module', name: 'profile-script' });
    expect(instance.url.pathname).toMatch(/\/profile-script\.worker\.ts$/);
    expect(instance.postMessage).toHaveBeenCalledExactlyOnceWith({
      configJson: '{"mode":"rule","rules":["MATCH,DIRECT"]}',
      script: input.script,
      profileName: input.profileName,
    });
    expect(readStorage).not.toHaveBeenCalled();
    instance.emit({ type: 'ready' });
    instance.emit({ type: 'result', result: success });
    await expect(pending).resolves.toEqual(success);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expectCleanedUp(instance);
    controller.abort();
    expect(instance.terminate).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed VM result and its logs while terminating the Worker', async () => {
    const pending = runProfileScript(input);
    const instance = worker();
    const failure: ProfileScriptResult = {
      ok: false,
      error: 'main returned an invalid configuration',
      logs: [{ level: 'warn', message: 'Before failure' }],
    };
    instance.emit({ type: 'result', result: failure });
    await expect(pending).resolves.toEqual(failure);
    expectCleanedUp(instance);
  });

  it('aborts with the logs already received and ignores late log and result callbacks', async () => {
    const controller = new AbortController();
    const pending = runProfileScript(input, { signal: controller.signal });
    const instance = worker();
    const log = { level: 'log' as const, message: 'Progress before cancellation' };
    instance.emit({ type: 'log', log });
    const lateCallback = instance.onmessage!;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('取消'),
      logs: [log],
    });
    lateCallback({
      data: { type: 'log', log: { level: 'error', message: 'Too late' } },
    } as MessageEvent<ProfileScriptWorkerMessage>);
    lateCallback({
      data: { type: 'result', result: success },
    } as MessageEvent<ProfileScriptWorkerMessage>);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual(result);
    expect(result.logs).toEqual([log]);
    expectCleanedUp(instance);
  });

  it('terminates startup at 8 seconds when the VM never becomes ready', async () => {
    const completed = vi.fn();
    const pending = runProfileScript(input).then((result) => {
      completed(result);
      return result;
    });
    const instance = worker();
    await vi.advanceTimersByTimeAsync(7999);
    expect(completed).not.toHaveBeenCalled();
    expect(instance.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('加载超时'),
    });
    expectCleanedUp(instance);
  });

  it('starts a separate 8 second execution deadline on ready and does not extend it on duplicate ready messages', async () => {
    const completed = vi.fn();
    const pending = runProfileScript(input).then((result) => {
      completed(result);
      return result;
    });
    const instance = worker();
    await vi.advanceTimersByTimeAsync(7000);
    instance.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(completed).not.toHaveBeenCalled();
    instance.emit({ type: 'ready' });
    const log = { level: 'debug' as const, message: 'Still executing' };
    instance.emit({ type: 'log', log });
    await vi.advanceTimersByTimeAsync(1999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('执行超时'),
      logs: [log],
    });
    expectCleanedUp(instance);
  });

  it.each(['error', 'messageerror'] as const)(
    'cleans up a Worker %s and retains logs already received',
    async (kind) => {
      const pending = runProfileScript(input);
      const instance = worker();
      const log = { level: 'info' as const, message: 'Started' };
      instance.emit({ type: 'log', log });
      const preventDefault = vi.fn();
      if (kind === 'error') {
        instance.onerror?.({ preventDefault } as unknown as ErrorEvent);
        expect(preventDefault).toHaveBeenCalledOnce();
      } else instance.onmessageerror?.({} as MessageEvent);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(kind === 'error' ? '环境异常' : '无法读取'),
        logs: [log],
      });
      expectCleanedUp(instance);
    },
  );

  it('terminates and removes the abort listener if postMessage throws', async () => {
    FakeWorker.postError = new DOMException('Could not clone', 'DataCloneError');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(runProfileScript(input, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('无法发送'),
      logs: [],
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expectCleanedUp(worker());
  });

  it('reports a Worker construction failure without leaving a watchdog', async () => {
    FakeWorker.constructorError = new Error('Workers unavailable');
    await expect(runProfileScript(input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('无法启动'),
      logs: [],
    });
    expect(FakeWorker.instances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create a Worker for a signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProfileScript(input, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('取消'),
      logs: [],
    });
    expect(FakeWorker.instances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects cyclic or accessor-based configuration inputs before creating a Worker', async () => {
    const cycle: Record<string, unknown> = { mode: 'rule' };
    cycle.self = cycle;
    const getter = vi.fn(() => 'browser-controller-secret');
    const accessor = Object.defineProperty({ mode: 'rule' }, 'secret', {
      enumerable: true,
      get: getter,
    });
    for (const config of [cycle, accessor, { mode: Number.NaN }]) {
      const result = await runProfileScript({
        ...input,
        config: config as ProfileScriptInput['config'],
      });
      expect(result).toMatchObject({ ok: false, logs: [] });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
