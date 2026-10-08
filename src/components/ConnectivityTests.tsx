import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Globe2, Pencil, Play, Plus, Settings2, Trash2, X } from 'lucide-react';
import { Badge, Modal } from './ui';
import { useMihomo } from '../state/mihomo';
import { PREFERENCES_CHANGED } from '../lib/preference-events';
import {
  measureConnectivityTarget,
  readConnectivityPreferences,
  resolveConnectivityExit,
  runConnectivityTests,
  validateConnectivityTarget,
  writeConnectivityPreferences,
  type ConnectivityExit,
  type ConnectivityPreferences,
  type ConnectivityResult,
  type ConnectivityTarget,
} from '../lib/connectivity-tests';
import './connectivity-tests.css';

interface TargetDraft {
  id: string;
  name: string;
  url: string;
  timeout: string;
}

function exitValue(exit: ConnectivityExit): string {
  return JSON.stringify(
    exit.kind === 'provider'
      ? { kind: 'provider', provider: exit.provider, name: exit.name }
      : { kind: 'proxy', name: exit.name },
  );
}

function resultLabel(result: ConnectivityResult | undefined): string {
  if (!result) return '未测试';
  if (result.status === 'success') return `${result.delay} ms`;
  if (result.status === 'queued') return '等待中';
  if (result.status === 'testing') return '测试中';
  if (result.status === 'cancelled') return '已取消';
  return result.status === 'timeout' ? '超时' : '错误';
}

export function ConnectivityTests() {
  const state = useMihomo();
  const scope = state.demo ? 'demo' : (state.profile?.url ?? 'offline');
  const [revision, setRevision] = useState(0);
  const stored = useMemo(() => readConnectivityPreferences(scope), [scope, revision]);
  const [preference, setPreference] = useState<{ scope: string; value: ConnectivityPreferences }>();
  const preferences = preference?.scope === scope ? preference.value : stored;
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<TargetDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [results, setResults] = useState<Record<string, ConnectivityResult>>({});
  const [running, setRunning] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const groups = Object.values(state.proxies).filter((node) => node.all);
  const nodes = Object.values(state.coreProxies).filter(
    (node) => !node.all && !/^(reject|pass)/i.test(node.type),
  );
  const providerOptions = Object.entries(state.providers)
    .filter(([, provider]) => provider.vehicleType !== 'Compatible')
    .flatMap(([provider, value]) =>
      value.proxies
        .filter((node) => !/^(reject|pass)/i.test(node.type))
        .map((node) => ({ provider, name: node.name })),
    );
  const defaultProxy =
    state.config?.mode === 'direct'
      ? state.proxies.DIRECT
      : state.config?.mode === 'global'
        ? state.proxies.GLOBAL
        : (groups.find(
            (node) => node.type === 'Selector' && node.name !== 'GLOBAL' && !node.hidden,
          ) ??
          groups.find((node) => node.name !== 'GLOBAL') ??
          nodes[0]);
  const selected =
    preferences.exit ??
    (defaultProxy
      ? { kind: 'proxy' as const, name: defaultProxy.name }
      : providerOptions[0]
        ? { kind: 'provider' as const, ...providerOptions[0] }
        : undefined);
  const exit = resolveConnectivityExit(selected, state.proxies, state.providers, state.coreProxies);
  const selectedValue = selected ? exitValue(selected) : '';
  const options = [
    ...groups.map((node) => ({
      label: `${node.name} · ${node.type}`,
      group: '代理组',
      exit: { kind: 'proxy' as const, name: node.name },
    })),
    ...nodes.map((node) => ({
      label: node.name,
      group: '内核节点',
      exit: { kind: 'proxy' as const, name: node.name },
    })),
    ...providerOptions.map((node) => ({
      label: node.name,
      group: `代理集 · ${node.provider}`,
      exit: { kind: 'provider' as const, ...node },
    })),
  ];
  const optionGroups = [...new Set(options.map((option) => option.group))];
  const identity = JSON.stringify([
    scope,
    selected,
    exit.name,
    exit.providerName,
    exit.chain,
    exit.reason,
    preferences.targets,
  ]);
  const canTest = state.connected && !!exit.name && !exit.reason && (state.demo || !!state.client);
  const failures = preferences.targets.flatMap((target) => {
    const result = results[target.id];
    return result?.status === 'error' || result?.status === 'timeout' ? [{ target, result }] : [];
  });

  const stop = useCallback((markCancelled: boolean) => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    setRunning(false);
    setResults((current) =>
      markCancelled
        ? Object.fromEntries(
            Object.entries(current).map(([id, result]) => [
              id,
              result.status === 'testing' || result.status === 'queued'
                ? { status: 'cancelled' }
                : result,
            ]),
          )
        : {},
    );
  }, []);

  useEffect(() => {
    stop(false);
    return () => {
      generation.current++;
      request.current?.abort();
      request.current = null;
    };
  }, [identity, state.client, state.connected, state.demo, stop]);

  useEffect(() => {
    setManaging(false);
    setDraft(null);
    setFormError('');
  }, [scope]);

  useEffect(() => {
    const reload = () => {
      stop(false);
      setPreference(undefined);
      setRevision((value) => value + 1);
      setManaging(false);
      setDraft(null);
      setFormError('');
    };
    window.addEventListener(PREFERENCES_CHANGED, reload);
    return () => window.removeEventListener(PREFERENCES_CHANGED, reload);
  }, [stop]);

  function save(next: ConnectivityPreferences) {
    writeConnectivityPreferences(scope, next);
    stop(false);
    setPreference({ scope, value: next });
  }

  async function testTargets(targets: ConnectivityTarget[]) {
    if (!canTest || request.current || !targets.length || !exit.name) return;
    if (state.demo) {
      setResults((current) => ({
        ...current,
        ...Object.fromEntries(
          targets.map((target) => [
            target.id,
            { status: 'success', delay: 28 + preferences.targets.indexOf(target) * 23 },
          ]),
        ),
      }));
      return;
    }
    const client = state.client;
    if (!client) return;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    request.current = controller;
    setRunning(true);
    setResults((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((target) => [target.id, { status: 'queued' }])),
    }));
    await runConnectivityTests({
      targets,
      signal: controller.signal,
      measure: (target, signal) =>
        measureConnectivityTarget(
          client,
          target,
          { name: exit.name!, providerName: exit.providerName },
          signal,
        ),
      onResult: (id, result) => {
        if (generation.current === currentGeneration && !controller.signal.aborted)
          setResults((current) => ({ ...current, [id]: result }));
      },
    });
    if (generation.current === currentGeneration) {
      request.current = null;
      setRunning(false);
    }
  }

  function edit(target?: ConnectivityTarget) {
    setFormError('');
    setDraft(
      target
        ? { ...target, timeout: String(target.timeout) }
        : {
            id: `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: '',
            url: 'https://',
            timeout: '5000',
          },
    );
  }

  function saveTarget(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    try {
      const target = validateConnectivityTarget({ ...draft, timeout: Number(draft.timeout) });
      const exists = preferences.targets.some((item) => item.id === target.id);
      if (!exists && preferences.targets.length >= 20) throw new Error('最多添加 20 个测试目标');
      save({
        ...preferences,
        targets: exists
          ? preferences.targets.map((item) => (item.id === target.id ? target : item))
          : [...preferences.targets, target],
      });
      setDraft(null);
      setFormError('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '无法保存测试目标');
    }
  }

  function move(index: number, direction: number) {
    const targets = [...preferences.targets];
    const target = targets[index];
    const to = index + direction;
    if (!target || to < 0 || to >= targets.length) return;
    targets.splice(index, 1);
    targets.splice(to, 0, target);
    save({ ...preferences, targets });
  }

  return (
    <section className="panel connectivity-panel" aria-label="连通性测试">
      <div className="connectivity-heading">
        <div className="panel-title">
          <Globe2 size={18} />
          <h2>连通性测试</h2>
          {state.demo && <Badge tone="purple">演示示例</Badge>}
        </div>
        <div className="connectivity-actions">
          <button className="button small" type="button" onClick={() => setManaging(true)}>
            <Settings2 size={14} />
            管理测试目标
          </button>
          {running ? (
            <button className="button small" type="button" onClick={() => stop(true)}>
              <X size={14} />
              取消测试
            </button>
          ) : (
            <button
              className="button small"
              type="button"
              disabled={!canTest || !preferences.targets.length}
              onClick={() => void testTargets(preferences.targets)}
            >
              <Play size={14} />
              全部测试
            </button>
          )}
        </div>
      </div>
      <div className="connectivity-outlet">
        <label>
          <span>测试出口</span>
          <select
            className="field"
            aria-label="测试出口"
            value={selectedValue}
            onChange={(event) => {
              const choice = options.find(
                (option) => exitValue(option.exit) === event.target.value,
              );
              if (choice) save({ ...preferences, exit: choice.exit });
            }}
          >
            {!selected && <option value="">暂无可用出口</option>}
            {selected && !options.some((option) => exitValue(option.exit) === selectedValue) && (
              <option value={selectedValue}>{selected.name}（暂不可用）</option>
            )}
            {optionGroups.map((group) => (
              <optgroup label={group} key={group}>
                {options
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <option key={exitValue(option.exit)} value={exitValue(option.exit)}>
                      {option.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <p className={exit.reason ? 'connectivity-unavailable' : ''}>
          {exit.reason ??
            `当前出口：${exit.chain.join(' → ')}${exit.providerName ? ` · ${exit.providerName}` : ''}`}
        </p>
      </div>
      <div className="connectivity-grid">
        {preferences.targets.map((target) => {
          const result = results[target.id];
          const tone =
            result?.status === 'success'
              ? result.delay < 250
                ? 'good'
                : result.delay < 400
                  ? 'slow'
                  : 'bad'
              : result?.status === 'timeout' || result?.status === 'error'
                ? 'bad'
                : 'muted';
          return (
            <article
              className="connectivity-site"
              key={target.id}
              data-target-id={target.id}
              data-status={result?.status ?? 'idle'}
            >
              <button
                className="connectivity-site-button"
                type="button"
                aria-label={`测试 ${target.name}`}
                disabled={!canTest || running}
                onClick={() => void testTargets([target])}
                title={`${target.url}\n超时 ${target.timeout} ms`}
              >
                <span className="connectivity-site-icon">
                  <Globe2 size={21} />
                </span>
                <span className="connectivity-site-name">{target.name}</span>
                <span
                  className={`connectivity-site-result ${tone}`}
                  aria-label={resultLabel(result)}
                >
                  {result?.status === 'testing' ? (
                    <span className="connectivity-wait" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    resultLabel(result)
                  )}
                </span>
              </button>
            </article>
          );
        })}
        {!preferences.targets.length && (
          <p className="connectivity-empty">暂无测试目标，可在“管理测试目标”中添加。</p>
        )}
      </div>
      {failures.length > 0 && (
        <details className="connectivity-failures">
          <summary>查看 {failures.length} 项测试失败原因</summary>
          <ul>
            {failures.map(({ target, result }) => (
              <li key={target.id}>
                <strong>{target.name}：</strong>
                {result.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="connectivity-caption">
        {state.demo
          ? '演示结果在浏览器内生成。'
          : '由 Mihomo 通过所选节点访问目标地址，显示内核返回的延迟。'}
        测试目标仅保存在此浏览器。
      </p>

      {managing && (
        <Modal
          title="测试目标"
          description="管理当前控制器的测试地址和显示顺序，最多 20 个。"
          onClose={() => {
            setManaging(false);
            setDraft(null);
            setFormError('');
          }}
        >
          <div className="connectivity-manager">
            <div className="connectivity-target-list">
              {preferences.targets.map((target, index) => (
                <div className="connectivity-managed-target" key={target.id}>
                  <div>
                    <strong>{target.name}</strong>
                    <span>{target.url}</span>
                    <small>{target.timeout} ms 超时</small>
                  </div>
                  <div className="connectivity-target-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`上移 ${target.name}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`下移 ${target.name}`}
                      disabled={index === preferences.targets.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`编辑 ${target.name}`}
                      onClick={() => edit(target)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`删除 ${target.name}`}
                      onClick={() => {
                        save({
                          ...preferences,
                          targets: preferences.targets.filter((item) => item.id !== target.id),
                        });
                        if (draft?.id === target.id) setDraft(null);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {!draft && (
              <button
                className="button small"
                type="button"
                disabled={preferences.targets.length >= 20}
                onClick={() => edit()}
              >
                <Plus size={14} />
                新增目标
              </button>
            )}
            {draft && (
              <form className="connectivity-target-form" noValidate onSubmit={saveTarget}>
                <label>
                  <span>目标名称</span>
                  <input
                    className="field"
                    value={draft.name}
                    maxLength={40}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>测试地址</span>
                  <input
                    className="field"
                    value={draft.url}
                    type="url"
                    maxLength={2048}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                </label>
                <label>
                  <span>超时（毫秒）</span>
                  <input
                    className="field"
                    value={draft.timeout}
                    type="number"
                    min={1000}
                    max={30000}
                    step={1000}
                    onChange={(event) => setDraft({ ...draft, timeout: event.target.value })}
                  />
                </label>
                {formError && (
                  <p className="error-note" role="alert">
                    {formError}
                  </p>
                )}
                <div className="form-actions">
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setDraft(null);
                      setFormError('');
                    }}
                  >
                    取消编辑
                  </button>
                  <button className="button primary" type="submit">
                    保存目标
                  </button>
                </div>
              </form>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
