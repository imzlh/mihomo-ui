import {
  PROFILE_SCRIPT_LIMITS,
  prepareScriptInput,
  type ProfileScriptInput,
  type ProfileScriptLog,
  type ProfileScriptResult,
  type ProfileScriptWorkerInput,
  type ProfileScriptWorkerMessage,
} from './profile-script-protocol';

export { PROFILE_SCRIPT_LIMITS } from './profile-script-protocol';
export type {
  ProfileScriptConfig,
  ProfileScriptInput,
  ProfileScriptLog,
  ProfileScriptResult,
} from './profile-script-protocol';

/** Each run owns its Worker; neither the caller's controller nor browser state is exposed to it. */
export function runProfileScript(
  input: ProfileScriptInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProfileScriptResult> {
  if (signal?.aborted)
    return Promise.resolve({ ok: false, error: 'Script 执行已取消。', logs: [] });
  let prepared: ProfileScriptWorkerInput;
  try {
    prepared = prepareScriptInput(input);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: error instanceof Error ? error.message : 'Script 输入无效。',
      logs: [],
    });
  }
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./profile-script.worker.ts', import.meta.url), {
        type: 'module',
        name: 'profile-script',
      });
    } catch {
      resolve({ ok: false, error: '无法启动 Script 隔离执行环境。', logs: [] });
      return;
    }
    const logs: ProfileScriptLog[] = [];
    let settled = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: ProfileScriptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      resolve(result);
    };
    const fail = (error: string) => finish({ ok: false, error, logs: [...logs] });
    const abort = () => fail('Script 执行已取消。');
    const armWatchdog = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(ready ? 'Script 执行超时，已终止。' : 'Script 隔离环境加载超时，已终止。'),
        PROFILE_SCRIPT_LIMITS.watchdogMs,
      );
    };
    worker.onmessage = (event: MessageEvent<ProfileScriptWorkerMessage>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === 'ready') {
        if (!ready) {
          ready = true;
          armWatchdog();
        }
      } else if (message.type === 'log') logs.push(message.log);
      else if (message.type === 'result') finish(message.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail('Script 隔离执行环境异常，未生成配置。');
    };
    worker.onmessageerror = () => fail('无法读取 Script 执行结果。');
    signal?.addEventListener('abort', abort, { once: true });
    armWatchdog();
    if (signal?.aborted) abort();
    else {
      try {
        worker.postMessage(prepared);
      } catch {
        fail('无法发送 Script 配置到隔离执行环境。');
      }
    }
  });
}
