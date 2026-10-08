import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import {
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import {
  PROFILE_SCRIPT_LIMITS,
  scriptByteLength,
  serializeScriptConfig,
  type ProfileScriptConfig,
  type ProfileScriptLog,
  type ProfileScriptResult,
  type ProfileScriptWorkerInput,
  type ProfileScriptWorkerMessage,
} from './profile-script-protocol';

const getQuickJS = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(RELEASE_SYNC));

// These helpers and intrinsics are captured before the user's program can change its globals.
const bootstrap = `(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const keys = Object.keys;
  const symbols = Object.getOwnPropertySymbols;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const isArray = Array.isArray;
  const finite = Number.isFinite;
  const asString = String;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const emit = globalThis.__profile_emit__;
  delete globalThis.__profile_emit__;
  const console = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table']) {
    console[level] = (...args) => {
      let message = '';
      for (let index = 0; index < args.length; index++) {
        const text = stringify(args[index], null, 2);
        message += (index ? ' ' : '') + (text === undefined ? asString(args[index]) : text);
      }
      emit(level, message);
    };
  }
  Object.defineProperty(globalThis, 'console', {
    value: Object.freeze(console), writable: false, configurable: false,
  });
  return {
    parse,
    error(value) {
      try { return slice(asString(value), 0, 4096); }
      catch { return 'Script threw an exception.'; }
    },
    serialize(value) {
      if (!value || typeof value !== 'object' || isArray(value) || !keys(value).length)
        throw new Error('main 必须同步返回非空 JSON 配置映射。');
      const ancestors = [];
      function visit(item, depth) {
        if (depth > 100) throw new Error('Script 返回配置的嵌套层级超过 100。');
        if (item === null || typeof item === 'string' || typeof item === 'boolean')
          return stringify(item);
        if (typeof item === 'number' && finite(item)) return stringify(item);
        if (!item || typeof item !== 'object')
          throw new Error('Script 返回配置包含非 JSON 值。');
        const array = isArray(item);
        const proto = prototype(item);
        if (!array && proto !== objectPrototype && proto !== null)
          throw new Error('main 必须同步返回普通 JSON 配置，不能返回 Promise 或类实例。');
        if (symbols(item).length) throw new Error('Script 返回配置不能包含 Symbol。');
        for (let index = 0; index < ancestors.length; index++)
          if (ancestors[index] === item) throw new Error('Script 返回配置不能包含循环引用。');
        ancestors[ancestors.length] = item;
        const names = keys(item);
        if (array && names.length !== item.length)
          throw new Error('Script 返回配置数组不能包含空项或额外字段。');
        let cursor = item;
        while (cursor !== null) {
          const hook = descriptor(cursor, 'toJSON');
          if (hook && (!('value' in hook) || typeof hook.value === 'function'))
            throw new Error('Script 返回配置不能包含 toJSON 钩子。');
          cursor = prototype(cursor);
        }
        let output = array ? '[' : '{';
        for (let index = 0; index < names.length; index++) {
          const key = array ? asString(index) : names[index];
          const field = descriptor(item, key);
          if (!field || !('value' in field))
            throw new Error('Script 返回配置不能包含 getter 或 setter。');
          output += (index ? ',' : '') + (array ? '' : stringify(key) + ':')
            + visit(field.value, depth + 1);
        }
        ancestors.length--;
        return output + (array ? ']' : '}');
      }
      return visit(value, 0);
    },
  };
})()`;

interface EvaluationOptions {
  onReady?: () => void;
  onLog?: (log: ProfileScriptLog) => void;
  /** A lower deadline is useful to exercise interruption without a five-second test. */
  executionMs?: number;
}

/** The only code interpreter is QuickJS WASM. This function never evaluates source in the host. */
export async function evaluateProfileScript(
  input: ProfileScriptWorkerInput,
  options: EvaluationOptions = {},
): Promise<ProfileScriptResult> {
  const logs: ProfileScriptLog[] = [];
  let logBytes = 0;
  let limitError = '';
  let timedOut = false;
  const fail = (error: string): ProfileScriptResult => ({ ok: false, error, logs });
  try {
    const quickjs = await getQuickJS();
    options.onReady?.();
    const duration = Math.min(
      PROFILE_SCRIPT_LIMITS.executionMs,
      Math.max(1, options.executionMs ?? PROFILE_SCRIPT_LIMITS.executionMs),
    );
    const deadline = performance.now() + duration;
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(PROFILE_SCRIPT_LIMITS.memoryBytes);
    runtime.setMaxStackSize(PROFILE_SCRIPT_LIMITS.stackBytes);
    runtime.setInterruptHandler(() => {
      if (limitError) return true;
      if (performance.now() >= deadline) timedOut = true;
      return timedOut;
    });
    let context: QuickJSContext | undefined;
    const handles: QuickJSHandle[] = [];
    try {
      const vm = (context = runtime.newContext());
      const own = (handle: QuickJSHandle) => {
        handles.push(handle);
        return handle;
      };
      const boundedString = (handle: QuickJSHandle, maximum: number): string | null => {
        if (vm.typeof(handle) !== 'string') return null;
        const length = vm.getProp(handle, 'length');
        try {
          if (vm.getNumber(length) > maximum) return null;
        } finally {
          length.dispose();
        }
        const text = vm.getString(handle);
        return scriptByteLength(text) <= maximum ? text : null;
      };
      const emit = vm.newFunction('__profile_emit__', (levelHandle, textHandle) => {
        if (limitError) return { error: vm.newError(limitError) };
        const level = vm.getString(levelHandle) as ProfileScriptLog['level'];
        const remaining = PROFILE_SCRIPT_LIMITS.logBytes - logBytes - scriptByteLength(level);
        const message = boundedString(textHandle, remaining);
        if (logs.length >= PROFILE_SCRIPT_LIMITS.logCount || message === null) {
          limitError = 'Script 日志超过 1000 条或 1 MiB，已停止执行。';
          return { error: vm.newError(limitError) };
        }
        const log = { level, message };
        logBytes += scriptByteLength(level) + scriptByteLength(message);
        logs.push(log);
        options.onLog?.(log);
        return vm.undefined;
      });
      vm.setProp(vm.global, '__profile_emit__', emit);
      emit.dispose();
      const setup = vm.evalCode(bootstrap, 'profile-script-bootstrap.js');
      if (setup.error) {
        own(setup.error);
        return fail('无法初始化 Script 隔离执行环境。');
      }
      const helpers = own(setup.value);
      const parse = own(vm.getProp(helpers, 'parse'));
      const serialize = own(vm.getProp(helpers, 'serialize'));
      const errorText = own(vm.getProp(helpers, 'error'));
      const describeError = (error: QuickJSHandle): string => {
        if (timedOut) return 'Script 执行超过 5 秒，已终止。';
        if (limitError) return limitError;
        const formatted = vm.callFunction(errorText, vm.undefined, error);
        try {
          if (formatted.error) return timedOut ? 'Script 执行超时，已终止。' : 'Script 执行异常。';
          return boundedString(formatted.value, 16 * 1024) ?? 'Script 执行异常。';
        } finally {
          formatted.dispose();
        }
      };
      const configJson = own(vm.newString(input.configJson));
      const parsed = vm.callFunction(parse, vm.undefined, configJson);
      if (parsed.error) {
        const error = describeError(own(parsed.error));
        return fail(error);
      }
      const config = own(parsed.value);
      const profileName = own(vm.newString(input.profileName));
      const program = vm.evalCode(
        `${input.script}\n;if (typeof main !== 'function') throw new Error('Script 必须定义 main(config, profileName)。');\nmain;`,
        'profile-script.js',
        { type: 'global' },
      );
      if (program.error) {
        const error = describeError(own(program.error));
        return fail(error);
      }
      const main = own(program.value);
      const called = vm.callFunction(main, vm.undefined, config, profileName);
      if (called.error) {
        const error = describeError(own(called.error));
        return fail(error);
      }
      const returned = own(called.value);
      const serialized = vm.callFunction(serialize, vm.undefined, returned);
      if (serialized.error) {
        const error = describeError(own(serialized.error));
        return fail(error);
      }
      const output = own(serialized.value);
      if (limitError) return fail(limitError);
      const json = boundedString(output, PROFILE_SCRIPT_LIMITS.configBytes);
      if (json === null) return fail('Script 返回配置超过 10 MiB 或不是有效 JSON。');
      const result: unknown = JSON.parse(json);
      serializeScriptConfig(result);
      return { ok: true, config: result as ProfileScriptConfig, logs };
    } finally {
      for (let index = handles.length - 1; index >= 0; index--) {
        if (handles[index]!.alive) handles[index]!.dispose();
      }
      context?.dispose();
      runtime.dispose();
    }
  } catch (error) {
    return fail(
      timedOut
        ? 'Script 执行超时，已终止。'
        : error instanceof Error
          ? error.message.slice(0, 4096)
          : 'Script 隔离执行失败。',
    );
  }
}

if (typeof self !== 'undefined' && typeof Window === 'undefined') {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ProfileScriptWorkerInput>) => void) | null;
    postMessage: (message: ProfileScriptWorkerMessage) => void;
  };
  scope.onmessage = (event) => {
    // Only one run is accepted; the owner terminates this Worker on every completion path.
    scope.onmessage = null;
    void evaluateProfileScript(event.data, {
      onReady: () => scope.postMessage({ type: 'ready' }),
      onLog: (log) => scope.postMessage({ type: 'log', log }),
    }).then((result) => scope.postMessage({ type: 'result', result }));
  };
}
