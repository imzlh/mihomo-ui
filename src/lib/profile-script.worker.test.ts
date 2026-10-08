import { describe, expect, it } from 'vitest';
import { evaluateProfileScript } from './profile-script.worker';
import {
  PROFILE_SCRIPT_LIMITS,
  prepareScriptInput,
  type ProfileScriptLog,
} from './profile-script-protocol';

const config = { mode: 'rule', rules: ['MATCH,DIRECT'] };
const input = (script: string, profileName = '工作配置') =>
  prepareScriptInput({ config, script, profileName });

describe('isolated QuickJS profile scripts', () => {
  it('calls synchronous main with a private config copy and an uninterpreted profile name', async () => {
    const name = "Name'); globalThis.stolen = true; //\n配置";
    const logs: ProfileScriptLog[] = [];
    const result = await evaluateProfileScript(
      input(
        `console.info('starting');
         const main = (config, profileName) => {
           console.log(profileName, { before: config.mode });
           config.mode = 'direct';
           config.name = profileName;
           config.injected = typeof stolen;
           return config;
         };`,
        name,
      ),
      { onLog: (log) => logs.push(log) },
    );
    expect(result).toEqual({
      ok: true,
      config: { ...config, mode: 'direct', name, injected: 'undefined' },
      logs: [
        { level: 'info', message: '"starting"' },
        { level: 'log', message: `${JSON.stringify(name)} {\n  "before": "rule"\n}` },
      ],
    });
    expect(result.logs).toEqual(logs);
    expect(config.mode).toBe('rule');
  });

  it('has no host network, DOM, storage, worker, Node, or controller capability, including via Function', async () => {
    const result = await evaluateProfileScript(
      input(`function main(config) {
        config.capabilities = [typeof fetch, typeof XMLHttpRequest, typeof WebSocket,
          typeof localStorage, typeof sessionStorage, typeof document, typeof window,
          typeof postMessage, typeof Worker, typeof process, typeof require, typeof secret,
          typeof __profile_emit__, typeof setTimeout];
        config.constructorEscape = ({}).constructor.constructor('return typeof localStorage')();
        return config;
      }`),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.capabilities).toEqual(Array(14).fill('undefined'));
      expect(result.config.constructorEscape).toBe('undefined');
    }
  });

  it.each([
    'return null',
    'return []',
    'return {}',
    'return "mode: rule"',
    'return Promise.resolve(config)',
    'return { bad: undefined }',
    'return { bad: NaN }',
    'return { bad: Infinity }',
    'return { bad: 1n }',
    'return { bad() {} }',
    'return { bad: Symbol("x") }',
    'config.self = config; return config',
    'return { get mode() { return "direct"; } }',
    'return { bad: new Date() }',
    'return { bad: [, 1] }',
  ])('rejects non-mapping or lossy JSON results: %s', async (body) => {
    const result = await evaluateProfileScript(input(`function main(config) { ${body}; }`));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('config');
  });

  it('reports missing main, syntax failures and thrown errors while retaining preceding logs', async () => {
    const missing = await evaluateProfileScript(input('const value = 1;'));
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('main') });
    const syntax = await evaluateProfileScript(input('function main( {'));
    expect(syntax.ok).toBe(false);
    const thrown = await evaluateProfileScript(
      input(
        'console.warn("before"); function main() { console.error(42); throw new Error("boom"); }',
      ),
    );
    expect(thrown).toEqual({
      ok: false,
      error: 'Error: boom',
      logs: [
        { level: 'warn', message: '"before"' },
        { level: 'error', message: '42' },
      ],
    });
  });

  it('interrupts an infinite loop and releases the runtime for the next run', async () => {
    const result = await evaluateProfileScript(
      input('function main() { console.debug("loop"); while (true) {} }'),
      { executionMs: 30 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/超时|超过/),
      logs: [{ level: 'debug', message: '"loop"' }],
    });
    expect(await evaluateProfileScript(input('function main(config) { return config; }'))).toEqual({
      ok: true,
      config,
      logs: [],
    });
  });

  it('enforces the VM memory limit and preserves logs before allocation failure', async () => {
    const result = await evaluateProfileScript(
      input(
        'function main() { console.log("allocate"); return { huge: "x".repeat(128 * 1024 * 1024) }; }',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.logs).toEqual([{ level: 'log', message: '"allocate"' }]);
    expect(result).not.toHaveProperty('config');
  });

  it('stops a log flood even if the script catches the limit error', async () => {
    const result = await evaluateProfileScript(
      input(`function main(config) {
        try { for (let i = 0; i < 1001; i++) console.log(i); } catch {}
        return config;
      }`),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('日志') });
    expect(result.logs).toHaveLength(PROFILE_SCRIPT_LIMITS.logCount);
    expect(result.logs[999]).toEqual({ level: 'log', message: '999' });
  });

  it('bounds UTF-8 log bytes and oversized JSON results', async () => {
    const largeLog = await evaluateProfileScript(
      input(
        'function main(config) { console.log("before"); console.log("界".repeat(400000)); return config; }',
      ),
    );
    expect(largeLog).toMatchObject({ ok: false, error: expect.stringContaining('日志') });
    expect(largeLog.logs).toEqual([{ level: 'log', message: '"before"' }]);
    const largeResult = await evaluateProfileScript(
      input('function main() { return { huge: "x".repeat(11 * 1024 * 1024) }; }'),
    );
    expect(largeResult.ok).toBe(false);
    expect(largeResult).not.toHaveProperty('config');
  });

  it('keeps validation and serialization intact when the script changes global intrinsics', async () => {
    const valid = await evaluateProfileScript(
      input(`function main(config) {
        JSON.stringify = () => 'null'; Object.keys = () => [];
        config.mode = 'direct'; return config;
      }`),
    );
    expect(valid).toEqual({ ok: true, config: { ...config, mode: 'direct' }, logs: [] });
    const invalid = await evaluateProfileScript(
      input('function main() { Number.isFinite = () => true; return { bad: Infinity }; }'),
    );
    expect(invalid.ok).toBe(false);
  });

  it('rejects hidden and inherited toJSON hooks instead of changing data after validation', async () => {
    for (const install of [
      `Object.defineProperty(config, 'toJSON', { value() { return { mode: 'direct' }; } });`,
      `Object.prototype.toJSON = function () { return { mode: 'direct' }; };`,
      `Object.defineProperty(config, 'toJSON', { get() { throw new Error('must not run'); } });`,
    ]) {
      const result = await evaluateProfileScript(
        input(`function main(config) { ${install} return config; }`),
      );
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('toJSON') });
      expect(result).not.toHaveProperty('config');
    }
  });
});
