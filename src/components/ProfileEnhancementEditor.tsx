import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  FileCode2,
  Info,
  Play,
  Save,
  Square,
  Terminal,
} from 'lucide-react';
import {
  compileProfile,
  defaultProfileEnhancement,
  ProfileCompileError,
  type EnhancementLog,
  type EnhancementSource,
  type EnhancementStage,
  type GlobalProfileEnhancement,
  type ProfileEnhancement,
} from '../lib/profile-enhancement';
import { profileFileName } from '../lib/profile-library';
import { useMihomo } from '../state/mihomo';
import { Badge, Modal, Spinner, Toggle } from './ui';
import './profile-enhancement-editor.css';

interface CommonProps {
  profileName: string;
  baseContent: string;
  globalEnhancement?: GlobalProfileEnhancement;
  profileEnhancement?: ProfileEnhancement;
  onClose: () => void;
}

export type ProfileEnhancementEditorProps = CommonProps &
  (
    | {
        kind: 'global';
        initial: GlobalProfileEnhancement;
        onSave: (value: GlobalProfileEnhancement) => string | null;
      }
    | {
        kind: 'profile';
        initial: ProfileEnhancement;
        onSave: (value: ProfileEnhancement) => string | null;
      }
  );

type SourceKey = 'rules' | 'proxies' | 'groups' | 'merge' | 'script';
type CompileResult = Awaited<ReturnType<typeof compileProfile>>;
type PreviewState = {
  context: string;
  status: 'running' | 'success' | 'error';
  result?: CompileResult;
  error?: string;
  stages: EnhancementStage[];
  logs: EnhancementLog[];
};

const sourceLabels: Record<SourceKey, string> = {
  rules: '规则',
  proxies: '代理',
  groups: '代理组',
  merge: 'Merge',
  script: 'Script',
};
const sourceHelp: Record<SourceKey, string> = {
  rules:
    'prepend 放在原规则之前，append 放在之后；delete 按完整规则文本删除原规则。新增条目不会被 delete 移除。',
  proxies: '按 name 删除原代理，并移除组内对应引用。新增代理会加入第一个 select / selector 组。',
  groups:
    '按 name 删除原代理组。替换某个组时，将名称写入 delete，再将新定义放入 prepend 或 append。',
  merge:
    '普通对象递归合并，数组直接替换。顶层 dns 仅合并第一层，hosts 整体替换；null 不会删除字段。',
  script:
    '入口 main(config, profileName) 接收当前配置和配置名称，须返回完整配置对象。运行预览或应用配置时才执行脚本。',
};
const sequenceTemplate = 'prepend: []\nappend: []\ndelete: []\n';
const templates: Record<SourceKey, string> = {
  rules: sequenceTemplate,
  proxies: sequenceTemplate,
  groups: sequenceTemplate,
  merge: '{}\n',
  script: 'function main(config, profileName) {\n  return config;\n}\n',
};
const profileSources: SourceKey[] = ['rules', 'proxies', 'groups', 'merge', 'script'];
const globalSources: SourceKey[] = ['merge', 'script'];
const cloneDraft = (initial: GlobalProfileEnhancement | ProfileEnhancement): ProfileEnhancement =>
  structuredClone({ ...defaultProfileEnhancement(), ...initial });

export function ProfileEnhancementEditor(props: ProfileEnhancementEditorProps) {
  const { client, demo } = useMihomo();
  const [session, setSession] = useState({ client, demo, id: 0 });
  if (session.client !== client || session.demo !== demo)
    setSession({ client, demo, id: session.id + 1 });
  return <EnhancementEditorSession key={session.id} {...props} />;
}

function EnhancementEditorSession(props: ProfileEnhancementEditorProps) {
  const [draft, setDraft] = useState(() => cloneDraft(props.initial));
  const [selected, setSelected] = useState<SourceKey>(props.kind === 'global' ? 'merge' : 'rules');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewNotice, setPreviewNotice] = useState('');
  const [previewTab, setPreviewTab] = useState<'content' | 'logs'>('content');
  const [saveError, setSaveError] = useState('');
  const request = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const mounted = useRef(false);
  const editorId = useId();
  const tabs = props.kind === 'global' ? globalSources : profileSources;
  const source = draft[selected];
  const label = sourceLabels[selected];
  const initialKey = useMemo(
    () => JSON.stringify([props.kind, props.initial]),
    [props.kind, props.initial],
  );
  const previousInitial = useRef(initialKey);
  const context = useMemo(
    () =>
      JSON.stringify([
        props.kind,
        props.profileName,
        props.baseContent,
        props.globalEnhancement,
        props.profileEnhancement,
      ]),
    [
      props.kind,
      props.profileName,
      props.baseContent,
      props.globalEnhancement,
      props.profileEnhancement,
    ],
  );
  const currentContext = useRef(context);
  currentContext.current = context;
  const previousContext = useRef(context);
  const visiblePreview = preview?.context === context ? preview : null;
  const running = visiblePreview?.status === 'running';
  const result = visiblePreview?.result;
  const enabledCount = tabs.filter((key) => draft[key].enabled).length;
  const global = props.kind === 'global' ? draft : props.globalEnhancement;
  const profile = props.kind === 'profile' ? draft : props.profileEnhancement;
  const phases = [
    { id: 'rules', label: '规则', enabled: profile?.rules.enabled },
    { id: 'proxies', label: '代理', enabled: profile?.proxies.enabled },
    { id: 'groups', label: '代理组', enabled: profile?.groups.enabled },
    { id: 'global-merge', label: '全局 Merge', enabled: global?.merge.enabled },
    { id: 'global-script', label: '全局 Script', enabled: global?.script.enabled },
    { id: 'profile-merge', label: '配置 Merge', enabled: profile?.merge.enabled },
    { id: 'profile-script', label: '配置 Script', enabled: profile?.script.enabled },
  ];
  const selectedPhase =
    selected === 'merge' || selected === 'script' ? `${props.kind}-${selected}` : selected;

  function invalidatePreview(message = '') {
    request.current.id++;
    request.current.controller?.abort();
    request.current.controller = undefined;
    setPreview(null);
    setPreviewNotice(message);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current.id++;
      request.current.controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (previousInitial.current === initialKey) return;
    previousInitial.current = initialKey;
    setDraft(cloneDraft(props.initial));
    setSelected(props.kind === 'global' ? 'merge' : 'rules');
    setSaveError('');
    invalidatePreview();
  }, [initialKey, props.initial, props.kind]);

  useEffect(() => {
    if (previousContext.current === context) return;
    previousContext.current = context;
    invalidatePreview('预览配置已变化，请重新运行预览。');
  }, [context]);

  function updateSource(patch: Partial<EnhancementSource>) {
    invalidatePreview(preview || previewNotice ? '内容已修改，请重新运行预览。' : '');
    setSaveError('');
    setDraft((current) => ({ ...current, [selected]: { ...current[selected], ...patch } }));
  }

  function close() {
    invalidatePreview();
    props.onClose();
  }

  function save() {
    try {
      const error =
        props.kind === 'global'
          ? props.onSave({ version: 1, merge: draft.merge, script: draft.script })
          : props.onSave(draft);
      if (error) setSaveError(error);
      else close();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存增强失败，请重试。');
    }
  }

  async function runPreview() {
    if (running || !props.baseContent.trim()) return;
    request.current.controller?.abort();
    const controller = new AbortController();
    const id = ++request.current.id;
    request.current.controller = controller;
    const requestContext = context;
    const isCurrent = () =>
      mounted.current &&
      request.current.id === id &&
      !controller.signal.aborted &&
      currentContext.current === requestContext;
    setPreviewNotice('');
    setPreview({ context: requestContext, status: 'running', stages: [], logs: [] });
    try {
      const compiled = await compileProfile(
        {
          content: props.baseContent,
          profileName: props.profileName,
          global,
          enhancement: profile,
        },
        { signal: controller.signal },
      );
      if (!isCurrent()) return;
      setPreview({
        context: requestContext,
        status: 'success',
        result: compiled,
        stages: compiled.stages,
        logs: compiled.logs,
      });
      setPreviewTab('content');
    } catch (error) {
      if (!isCurrent()) return;
      setPreview({
        context: requestContext,
        status: 'error',
        error: error instanceof Error ? error.message : '预览失败，请检查增强内容。',
        stages: error instanceof ProfileCompileError ? error.stages : [],
        logs: error instanceof ProfileCompileError ? error.logs : [],
      });
      setPreviewTab('logs');
    } finally {
      if (request.current.id === id) request.current.controller = undefined;
    }
  }

  function downloadResult() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([result.content], { type: 'application/yaml;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = profileFileName(`${props.profileName || 'profile'}-enhanced`);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const key = tabs[next]!;
    setSelected(key);
    document.getElementById(`${editorId}-tab-${key}`)?.focus();
  }

  return (
    <Modal
      title={props.kind === 'global' ? '全局增强' : `配置增强 · ${props.profileName}`}
      description={
        props.kind === 'global'
          ? '为配置库中的配置设置共享的 Merge 与 Script。'
          : '在订阅原文上叠加规则、代理、代理组和自定义增强。'
      }
      onClose={close}
      wide
    >
      <div className="profile-enhancement-editor">
        <div className="enhancement-content">
          <div className="enhancement-order">
            <div className="enhancement-order-heading">
              <span>增强执行顺序</span>
              <small>依次执行已启用阶段，后续阶段可以覆盖前面的结果。</small>
            </div>
            <ol aria-label="增强执行顺序">
              {phases.map((phase, index) => (
                <li
                  key={phase.id}
                  className={`${phase.id === selectedPhase ? 'current' : ''} ${phase.enabled ? 'enabled' : ''}`}
                >
                  {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
                  <span>{phase.label}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="enhancement-workspace">
            <section className="enhancement-editor-panel" aria-label="编辑增强">
              <div className="enhancement-source-tabs" role="tablist" aria-label="增强类型">
                {tabs.map((key, index) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`${editorId}-tab-${key}`}
                    aria-label={sourceLabels[key]}
                    aria-selected={selected === key}
                    aria-controls={`${editorId}-source`}
                    tabIndex={selected === key ? 0 : -1}
                    onKeyDown={(event) => moveTab(event, index)}
                    onClick={() => setSelected(key)}
                  >
                    <span
                      className={`enhancement-source-dot ${draft[key].enabled ? 'enabled' : ''}`}
                      aria-hidden="true"
                    />
                    {sourceLabels[key]}
                  </button>
                ))}
              </div>
              <div
                className="enhancement-source-panel"
                role="tabpanel"
                id={`${editorId}-source`}
                aria-labelledby={`${editorId}-tab-${selected}`}
              >
                <div className="enhancement-source-heading">
                  <div>
                    <strong>{label}</strong>
                    <small>
                      {source.enabled ? '已启用，参与预览与应用' : '未启用，保留编辑内容'}
                    </small>
                  </div>
                  <Toggle
                    checked={source.enabled}
                    label={`启用 ${label}`}
                    onChange={(enabled) => updateSource({ enabled })}
                  />
                </div>
                <div className="enhancement-help">
                  <Info size={15} />
                  <p>{sourceHelp[selected]}</p>
                </div>
                <label className="enhancement-code-label" htmlFor={`${editorId}-code`}>
                  <span>{label} 内容</span>
                  <small>{selected === 'script' ? 'JavaScript' : 'YAML'}</small>
                </label>
                <textarea
                  id={`${editorId}-code`}
                  className="field enhancement-code"
                  aria-label={`${label} 内容`}
                  value={source.content}
                  onChange={(event) => updateSource({ content: event.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  wrap="off"
                />
                <details className="enhancement-template">
                  <summary>
                    查看
                    {selected === 'script'
                      ? '脚本入口'
                      : selected === 'merge'
                        ? 'Merge 模板'
                        : '序列补丁格式'}
                  </summary>
                  <pre>{templates[selected]}</pre>
                  {selected !== 'merge' && selected !== 'script' && (
                    <p>数组按 prepend → 原条目（排除 delete）→ append 拼接，保留所写顺序。</p>
                  )}
                  <button
                    type="button"
                    className="button small"
                    disabled={!!source.content.trim()}
                    onClick={() => updateSource({ content: templates[selected] })}
                  >
                    填入模板
                  </button>
                  {!!source.content.trim() && <small>清空编辑内容后可填入模板。</small>}
                </details>
              </div>
            </section>
            <section className="enhancement-preview-panel" aria-label="增强预览">
              <div className="enhancement-preview-heading">
                <div>
                  <strong>效果预览</strong>
                  <small title={props.profileName}>
                    {props.baseContent.trim() ? props.profileName : '请先在配置库中选择一个配置'}
                  </small>
                </div>
                {running ? (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => invalidatePreview('预览已取消，可以继续编辑。')}
                  >
                    <Square size={13} />
                    取消预览
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button small"
                    disabled={!props.baseContent.trim()}
                    onClick={() => void runPreview()}
                  >
                    <Play size={14} />
                    运行预览
                  </button>
                )}
              </div>
              {previewNotice && (
                <p className="enhancement-preview-notice" role="status">
                  {previewNotice}
                </p>
              )}
              {running && (
                <div className="enhancement-preview-empty" role="status">
                  <Spinner />
                  <strong>正在生成预览…</strong>
                  <p>按顺序合并配置并执行已启用脚本。</p>
                </div>
              )}
              {!visiblePreview && (
                <div className="enhancement-preview-empty">
                  <FileCode2 size={30} strokeWidth={1.4} />
                  <strong>查看增强后的完整配置</strong>
                  <p>
                    点击「运行预览」查看最终 YAML、改动字段和执行日志。编辑内容时不会自动运行脚本。
                  </p>
                </div>
              )}
              {visiblePreview?.status === 'error' && (
                <div className="enhancement-error" role="alert">
                  <strong>预览未完成</strong>
                  <span>{visiblePreview.error}</span>
                  <small>请修改增强内容后重新预览。本次没有生成可应用的配置。</small>
                </div>
              )}
              {result && (
                <div className="enhancement-result-summary" role="status">
                  <Check size={16} />
                  <span>预览完成 · {result.changedKeys.length} 个顶层字段有变化</span>
                  <button type="button" className="button small" onClick={downloadResult}>
                    <Download size={14} />
                    下载结果
                  </button>
                </div>
              )}
              {result && result.changedKeys.length > 0 && (
                <div className="enhancement-changed-keys" aria-label="改动顶层字段">
                  {result.changedKeys.map((key) => (
                    <code key={key}>{key}</code>
                  ))}
                </div>
              )}
              {visiblePreview && !running && (
                <>
                  <div className="enhancement-output-tabs segmented" aria-label="预览内容">
                    {result && (
                      <button
                        type="button"
                        aria-pressed={previewTab === 'content'}
                        onClick={() => setPreviewTab('content')}
                      >
                        <FileCode2 size={14} />
                        最终配置
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={previewTab === 'logs'}
                      onClick={() => setPreviewTab('logs')}
                    >
                      <Terminal size={14} />
                      阶段与日志
                      {visiblePreview.logs.length > 0 && (
                        <span> · {visiblePreview.logs.length}</span>
                      )}
                    </button>
                  </div>
                  {previewTab === 'content' && result ? (
                    <textarea
                      className="field enhancement-code enhancement-result-code"
                      aria-label="最终配置"
                      value={result.content}
                      readOnly
                      spellCheck={false}
                      wrap="off"
                    />
                  ) : (
                    <div className="enhancement-execution">
                      <ol className="enhancement-stage-results" aria-label="执行阶段">
                        {visiblePreview.stages.map((stage, index) => (
                          <li key={`${stage.id}-${index}`}>
                            <span className="enhancement-stage-number">{index + 1}</span>
                            <div>
                              <strong>{stage.label}</strong>
                              <p>
                                {stage.changedKeys.length
                                  ? stage.changedKeys.join(' · ')
                                  : '顶层字段未变化'}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      {visiblePreview.stages.length === 0 && (
                        <p className="enhancement-log-empty">
                          {visiblePreview.status === 'success'
                            ? '没有启用的增强阶段，保留原文。'
                            : '没有已完成的增强阶段。'}
                        </p>
                      )}
                      <div className="enhancement-console-heading">Console 日志</div>
                      {visiblePreview.logs.length ? (
                        <ol className="enhancement-console" aria-label="脚本日志">
                          {visiblePreview.logs.map((log, index) => (
                            <li key={index} data-level={log.level}>
                              <div>
                                <span>{log.level}</span>
                                {log.stage && <small>{log.stage}</small>}
                              </div>
                              <pre>{log.message}</pre>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="enhancement-log-empty">没有脚本输出。</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
        {saveError && (
          <p className="enhancement-error" role="alert">
            {saveError}
          </p>
        )}
        <div className="enhancement-footer">
          <div>
            <Badge tone={enabledCount ? 'purple' : 'neutral'}>{enabledCount} 项启用</Badge>
            <span>保存增强草稿，应用配置时生效。</span>
          </div>
          <button type="button" className="button" onClick={close}>
            关闭
          </button>
          <button type="button" className="button primary" onClick={save}>
            <Save size={16} />
            保存增强
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default ProfileEnhancementEditor;
