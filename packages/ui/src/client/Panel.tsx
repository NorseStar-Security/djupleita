/** DSH right-sidebar plugin: live trajectories, evidence graph and engagement controls beside chats. */
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { GlobalStandardProps, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import css from './Panel.module.css';
import { EvidenceGraph } from './EvidenceGraph.tsx';
import { PolicyEditor } from './PolicyEditor.tsx';
import { BudgetCard } from './BudgetCard.tsx';
import type { BudgetSnapshot } from './BudgetCard.tsx';
import { CrawlPanel } from './CrawlPanel.tsx';
import type { CrawlSnapshot } from './CrawlPanel.tsx';
import { PluginCredentials } from './PluginCredentials.tsx';
import type { CredentialSnapshot } from './PluginCredentials.tsx';
import { ScopeEditor } from './ScopeEditor.tsx';
import { EngagementMode, engagementMode } from './EngagementMode.tsx';
import { LearningStudies } from './Learning.tsx';
import distribution from '../../../../configs/distribution.json' with { type: 'json' };
import { registerBrand } from './brand.tsx';
import type { ReviewQuestion, ReviewGrant } from '../../../dsh-plugin/src/review.ts';
import type { ToolSetup } from '../../../dsh-plugin/src/setup.ts';
import { pollingSource } from './polling.ts';
import { PanelBoundary } from './PanelBoundary.tsx';
import { reviewLoader } from './reviews.ts';
import { AssessmentPanel } from './AssessmentPanel.tsx';
import type { ReviewSnapshot } from './reviews.ts';

const en = {
  title: 'Pentest', description: 'Trajectories, evidence and test controls', trajectory: 'Trajectory', graph: 'Graph', evidenceGraph: 'Evidence graph', assessment: 'Assessment',
  identities: 'Identities', policy: 'Policy', plugins: 'Plugins', loading: 'Loading engagement…', refresh: 'Refresh',
  requests: 'requests', nodes: 'nodes', edges: 'relationships', noEvents: 'Tool activity will appear here as this chat runs.',
  addIdentity: 'Add identity', name: 'Name', role: 'Role', tenant: 'Tenant', hosts: 'Hosts, separated by commas',
  secret: 'Secret', kind: 'Credential type', save: 'Save to secure store', saved: 'Identity saved',
  candidate: 'Inferred', verified: 'Verified', observed: 'Observed', detail: 'Details', scope: 'Target scope',
  saveSettings: 'Apply scope and policy', settingsSaved: 'Settings applied; previous requests and crawl frontier were cancelled.',
  modelScope: 'API endpoints configured in Models are allowed automatically. Target scope changes do not require another provider approval.',
  noIdentities: 'Add two accounts to compare access across roles or tenants.', noGraph: 'Run recon or a crawl to populate the evidence graph.',
  studies: 'Studies', runStudy: 'Run offline study', promote: 'Promote ranking', pluginSettings: 'Plugin configuration',
  savePlugins: 'Apply plugin configuration', pluginsSaved: 'Plugin configuration applied.', noStudies: 'Configure an Optuna environment and labelled datasets in Plugins.',
  dataset: 'Dataset', trials: 'Trials', promoted: 'Crawl ranking promoted. Scope and effect rules stay operator-controlled.',
  studyCompleted: 'Study completed',
  reviewTitle: 'Action review', blocked: 'Action blocked · waiting for you', allowOnce: 'Allow once', allowAlways: 'Always allow', reject: 'Keep blocked',
  reviewScope: 'Once resumes this call. Always remembers this exact operation and destination for this engagement, until revoked or its configuration changes.',
  allowHost: 'Always allow all calls to', hostScope: 'All tools, chats, paths, methods and ports for this exact host/IP in this engagement, until revoked. Independent action-effect and filesystem approvals still apply.', manageHosts: 'Manage destination allowances', hostLabel: 'Exact hostname or IP', addHost: 'Add destination allowance', hostSaved: 'Destination allowance saved.',
  savedAllowances: 'Saved allowances', revoke: 'Revoke', reviewDetails: 'Operation and destinations', reviewDone: 'Decision applied.',
  revoked: 'Allowance revoked.', closeReviewNotice: 'Dismiss decision notice',
  pendingApprovals: 'Pending approvals', allAgents: 'All chats and subagents in this engagement',
  noApprovals: 'No pending approvals.', thisChat: 'This chat', subagent: 'Subagent', agent: 'Agent',
  crawl: 'Crawl', included: 'Included with Djupleita', coreTitle: 'Djupleita · Engagement and identities',
  coreDescription: 'Engagement scope, request budgets, action review and securely stored identities.',
  hideSetup: 'Hide setup reminder', showSetup: 'Show setup reminder', setupHidden: 'Setup reminder hidden. Tool setup remains in Plugins.', setupShown: 'Setup reminder restored.',
  toolSetup: 'Tool setup', setupNeeded: 'Testing tools need setup', setupIntro: 'Install only the tools you need for this engagement. Other toolchains are optional; a requested tool reports its own missing prerequisites.',
  installRecon: 'Install recon tools', installFfuf: 'Install ffuf', ffufInstalled: 'ffuf installed, verified and applied. Retry the failed tool call.', installingTools: 'Installing tools…', loadSetup: 'Load local setup', checkTools: 'Check tools',
  installRea: 'Install REA', reaInstalled: 'REA and its supported Node runtime installed and applied. Native decompilation also requires Ghidra/JDK.',
  setupHelp: 'Install managed recon tools, ffuf, or REA with a supported Node runtime. Archive/DMG inventory is built in; native decompilation needs Ghidra/JDK. Terminal commands run from the Djupleita project folder. Applying tools cancels in-flight tool requests.',
  setupLoaded: 'Local tool setup applied.', setupInstalled: 'Recon tools installed, verified and applied. Retry the failed tool call.', setupChecked: 'Tool checks refreshed.',
  ready: 'Verified', configured: 'Configured', missing: 'Needs setup', optional: 'Optional', setupRestart: 'Restart Djupleita after updating to enable in-app installation.',
  olderEvents: 'Older events', latestEvents: 'Latest events', nextPage: 'Next page', previousPage: 'Previous page',
  savedEvents: 'saved events', eventPreview: 'Preview. Complete data is saved locally; open the event to read it in pages.',
  graphPage: 'Showing a page of nodes and up to 500 relationships between displayed nodes.',
};
type Key = keyof typeof en;
const zh: Record<Key, string> = {
  assessment: '评估',
  title: '渗透测试', description: '轨迹、证据与测试控制', trajectory: '轨迹', graph: '关系图', evidenceGraph: '证据关系图', identities: '身份', policy: '策略', plugins: '插件',
  loading: '正在加载测试…', refresh: '刷新', requests: '请求', nodes: '节点', edges: '关系', noEvents: '聊天运行时，工具活动会显示在此处。',
  addIdentity: '添加身份', name: '名称', role: '角色', tenant: '租户', hosts: '主机（用逗号分隔）', secret: '凭据', kind: '凭据类型',
  save: '保存到钥匙串', saved: '身份已保存', candidate: '推断', verified: '已验证', observed: '已观察', detail: '详情', scope: '目标范围',
  noIdentities: '添加两个账户，以比较不同角色或租户的访问权限。', noGraph: '运行侦察或爬取以生成证据关系图。',
  saveSettings: '应用范围与策略', settingsSaved: '设置已应用；先前的请求与爬取队列已取消。',
  modelScope: '在模型设置中配置的 API 地址会自动获得访问许可。更改测试目标范围无需再次批准模型提供商。',
  studies: '学习实验', runStudy: '运行离线实验', promote: '应用排序参数', pluginSettings: '插件配置', savePlugins: '应用插件配置',
  pluginsSaved: '插件配置已应用。', noStudies: '请在插件中配置 Optuna 环境及标注的数据集。', dataset: '数据集', trials: '试验数', promoted: '已应用爬取排序参数；范围和效果规则仍由操作员控制。',
  studyCompleted: '实验已完成',
  reviewTitle: '操作审查', blocked: '操作已阻止 · 等待您的决定', allowOnce: '允许一次', allowAlways: '始终允许', reject: '保持阻止',
  reviewScope: '允许一次会继续此调用。始终允许会在本次测试中记住完全相同的操作和目标，直到撤销或配置更改。',
  allowHost: '始终允许所有调用至', hostScope: '在本次测试中允许所有工具、聊天、路径、方法和端口访问此精确主机/IP，直到撤销。操作效果及文件系统审批仍单独适用。', manageHosts: '管理目标许可', hostLabel: '精确主机名或 IP', addHost: '添加目标许可', hostSaved: '目标许可已保存。',
  savedAllowances: '已保存的许可', revoke: '撤销', reviewDetails: '操作和目标', reviewDone: '已应用决定。',
  revoked: '已撤销许可。', closeReviewNotice: '关闭决定通知',
  pendingApprovals: '待批准的操作', allAgents: '本次测试中的所有聊天和子代理',
  noApprovals: '没有待批准的操作。', thisChat: '当前聊天', subagent: '子代理', agent: '代理',
  crawl: '爬取', included: 'Djupleita 内置插件', coreTitle: 'Djupleita · 测试范围与身份',
  coreDescription: '测试范围、请求预算、操作审查与钥匙串身份。',
  hideSetup: '隐藏安装提醒', showSetup: '显示安装提醒', setupHidden: '安装提醒已隐藏；仍可在插件中安装工具。', setupShown: '已恢复安装提醒。',
  toolSetup: '工具安装', setupNeeded: '测试工具需要安装', setupIntro: 'Djupleita 包含这些插件。首次使用时需在本地安装可执行依赖。',
  installRecon: '安装侦察工具', installFfuf: '安装 ffuf', ffufInstalled: 'ffuf 已安装、验证并启用。请重试失败的工具调用。', installingTools: '正在安装工具…', loadSetup: '载入本地安装', checkTools: '检查工具',
  installRea: '安装 REA', reaInstalled: 'REA 及受支持的 Node 已安装并启用。本机反编译还需要 Ghidra/JDK。',
  setupHelp: '安装托管的侦察工具、ffuf，或 REA 及受支持的 Node。归档/DMG 清单无需 Ghidra；本机反编译需要 Ghidra/JDK。在 Djupleita 项目目录运行终端命令。应用工具会取消进行中的工具请求。',
  setupLoaded: '已应用本地工具配置。', setupInstalled: '侦察工具已安装、验证并启用。请重试失败的工具调用。', setupChecked: '工具检查已刷新。',
  ready: '已验证', configured: '已配置', missing: '需要安装', optional: '可选', setupRestart: '更新后请重启 Djupleita，以启用应用内安装。',
  olderEvents: '更早的事件', latestEvents: '最新事件', nextPage: '下一页', previousPage: '上一页',
  savedEvents: '已保存的事件', eventPreview: '预览。完整数据保存在本地；打开事件可分页读取。',
  graphPage: '当前显示一页节点，以及这些节点之间最多 500 条关系。',
};
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { pentest: Key } }
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' { interface SidebarRightTabParamsMap { pentest: Record<string, never> } }

type Row = Record<string, unknown>;
interface EventPage { events: Row[]; total: number; nextBefore: number | null; file: string }
interface GraphPage { nodes: Row[]; edges: Row[]; counts: { nodes: number; edges: number; evidence: number }; offset: number; nextOffset: number | null }
interface EventDetail { text: string; offset: number; nextOffset: number | null; totalChars: number }
interface Snapshot {
  engagement: { name: string; scope: { targets: { host: string }[] } }; policyVersion: string;
  budget: BudgetSnapshot; identities: Row[];
  graph: GraphPage; events: Row[]; trajectory: Omit<EventPage, 'events'>; plugins: Row[]; policy: Row;
  review: { pending: ReviewQuestion[]; grants: ReviewGrant[] };
  credentials: CredentialSnapshot; crawl: CrawlSnapshot; pluginConfig: Row; telemetry: Row; learning: { active: boolean; datasets: Row[]; reports: Row[] } | null; ranking: Row;
  procedure?: { runId: string; text: string; datasetHash: string } | null;
  setup?: ToolSetup;
}
interface PanelState { snapshot?: Snapshot; error?: string; loading: boolean }
interface ReviewInjected {
  hooks: { reviews: ReturnType<typeof pollingSource<ReviewSnapshot>> };
  sessionId: string;
  reviewOperation(endpoint: string, payload: Row): Promise<void>;
}
interface PanelInjected {
  hooks: ReviewInjected['hooks'] & { data: ReturnType<typeof pollingSource<Snapshot>> };
  sessionId: string;
  inspect<T>(endpoint: string, payload: Row): Promise<T>;
  refresh(): void;
  openPolicy(): void;
  createIdentity(metadata: Row, secret: string): Promise<void>;
  updateSettings(scope: Row, policy: Row): Promise<void>;
  ownerOperation(endpoint: string, payload: Row): Promise<void>;
  reviewOperation: ReviewInjected['reviewOperation'];
}
type Props = PropsLocale<'pentest'> & InjectFace<PanelInjected> & Pick<GlobalStandardProps, 'useSessions'> & {
  initialTab?: Tab; visibleTabs?: readonly Tab[]; configKeys?: readonly string[]; included?: boolean; pluginId?: string;
};
type Tab = 'trajectory' | 'graph' | 'identities' | 'policy' | 'studies' | 'plugins' | 'assessment' | 'crawl';
const TABS: Tab[] = ['trajectory', 'graph', 'assessment', 'identities', 'policy', 'studies', 'plugins', 'crawl'];
function stringify(value: unknown): string { return JSON.stringify(value, null, 2); }
function label(row: Row, key: string): string { return String(row[key] ?? ''); }

function ToolSetupCard({ setup, t, busy, operate, compact = false }: PropsLocale<'pentest'> & {
  setup: ToolSetup; busy: boolean; compact?: boolean; operate(endpoint: string, success: string): void;
}): ReactNode {
  return <section className={css.setup} aria-label={t('toolSetup')}>
    <h3>{t(compact ? 'setupNeeded' : 'toolSetup')}</h3><p>{t('setupIntro')}</p>
    {compact && <button className={css.reviewButton} disabled={busy} onClick={() => operate('setup/dismiss', t('setupHidden'))}>{t('hideSetup')}</button>}
    {!compact && setup.bannerDismissed && <button className={css.reviewButton} disabled={busy} onClick={() => operate('setup/show', t('setupShown'))}>{t('showSetup')}</button>}
    <div className={css.setupActions}>
      <button className={css.button} disabled={busy || setup.installing || !setup.installAvailable}
        onClick={() => operate('setup/install-recon', t('setupInstalled'))}>{t(setup.installing ? 'installingTools' : 'installRecon')}</button>
      <button className={css.button} disabled={busy || setup.installing || !setup.installAvailable}
        onClick={() => operate('setup/install-ffuf', t('ffufInstalled'))}>{t('installFfuf')}</button>
      <button className={css.button} disabled={busy || setup.installing || !setup.installAvailable}
        onClick={() => operate('setup/install-rea', t('reaInstalled'))}>{t('installRea')}</button>
      <button className={css.button} disabled={busy || setup.installing || !setup.installAvailable}
        onClick={() => operate('setup/load', t('setupLoaded'))}>{t('loadSetup')}</button>
      <button className={css.button} disabled={busy || setup.installing} onClick={() => operate('setup/check', t('setupChecked'))}>{t('checkTools')}</button>
    </div>
    {!setup.installAvailable && <p>{t('setupRestart')}</p>}
    <details open={!compact}><summary>{t('detail')}</summary><p>{t('setupHelp')}</p>
      {setup.entries.filter(entry => !compact || ['recon', 'ffuf', 'rea'].includes(entry.group)).map(entry => <article key={entry.id} className={css.setupEntry}>
        <header><strong>{entry.id}</strong><span data-status={entry.status}>{t(entry.status)}</span></header>
        <p>{entry.reason}</p>{entry.status !== 'ready' && entry.command && <code>{entry.command}</code>}
      </article>)}
    </details>
  </section>;
}

/** Engagement-wide approvals stay visible from the main agent without retaining child chats. */
export function ReviewCards({ useReviews, reviewOperation, sessionId, useSessions, t }:
  PropsLocale<'pentest'> & InjectFace<ReviewInjected> & Pick<GlobalStandardProps, 'useSessions'>): ReactNode {
  const state = useReviews(value => value);
  const review = state.snapshot;
  const setup = review?.setup;
  const sessions = useSessions(value => value.byId);
  const sources = new Map(Object.entries(sessions));
  const needsRecon = setup?.entries.some(entry => ['recon', 'ffuf', 'rea'].includes(entry.group) && entry.status === 'missing');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showGrants, setShowGrants] = useState(false);
  const [showPending, setShowPending] = useState(true);
  const decide = async (endpoint: string, payload: Row, item: string, success: string): Promise<void> => {
    setBusy(item); setError('');
    try { await reviewOperation(endpoint, payload); setNotice(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(undefined); }
  };
  const groups = new Map<string, ReviewQuestion[]>();
  for (const question of review?.pending ?? []) {
    const questions = groups.get(question.sessionId) ?? []; questions.push(question); groups.set(question.sessionId, questions);
  }
  return <section className={css.reviewDock} aria-label={t('reviewTitle')}>
    <button className={css.reviewSummary} aria-expanded={showPending}
      aria-label={`${t('pendingApprovals')}: ${review ? review.pending.length : '…'} · ${t('allAgents')}`}
      onClick={() => setShowPending(!showPending)}>
      <span>{t('pendingApprovals')} <strong data-pending={Boolean(review?.pending.length)} role="status">{review ? review.pending.length : '…'}</strong></span>
      <small>{t('allAgents')}</small><span aria-hidden="true">{showPending ? '▴' : '▾'}</span>
    </button>
    {showPending && <div className={css.approvalList}>
    {review && !review.pending.length && <p className={css.reviewEmpty}>{t('noApprovals')}</p>}
    {[...groups].map(([sourceId, questions]) => <section className={css.approvalGroup} key={sourceId}>
      <header className={css.approvalSource}>
        <strong>{sourceId === sessionId ? t('thisChat') : sources.get(sourceId)?.origin === 'subagent' ? t('subagent') : t('agent')}: {sources.get(sourceId)?.displayTitle || sourceId}</strong>
        <code title={sourceId}>{sourceId.slice(0, 12)}</code><span>{questions.length}</span>
      </header>
      {questions.map(question => <article className={css.reviewCard} key={question.id}>
      <header><strong>{t('blocked')}</strong><code>{question.tool}</code></header>
      <p>{question.reason}</p>
      <details><summary>{t('reviewDetails')}</summary><pre>{stringify({ operation: question.operation, details: question.details })}</pre></details>
      <small>{t('reviewScope')}</small>
      {question.host && <p><code>{question.host}</code><br /><small>{t('hostScope')}</small></p>}
      <div className={css.reviewActions}>
        {question.host && <button className={css.reviewButton} disabled={Boolean(busy)} onClick={() => { void decide('review/decide', { requestId: question.id, sessionId: question.sessionId, choice: 'destination' }, question.id, t('reviewDone')); }}>{t('allowHost')} {question.host}</button>}
        {(['once', 'always', 'reject'] as const).map(choice => <button className={css.reviewButton} key={choice} disabled={Boolean(busy)}
          onClick={() => { void decide('review/decide', { requestId: question.id, sessionId: question.sessionId, choice }, question.id, t('reviewDone')); }}>
          {t(choice === 'once' ? 'allowOnce' : choice === 'always' ? 'allowAlways' : 'reject')}
        </button>)}
      </div>
    </article>)}</section>)}
    </div>}
    {setup && needsRecon && !setup.bannerDismissed && <ToolSetupCard setup={setup} t={t} busy={Boolean(busy)} compact
      operate={(endpoint, success) => { void decide(endpoint, {}, 'setup', success); }} />}
    {notice && <div className={css.reviewNotice} role="status">{notice}<button className={css.reviewButton} aria-label={t('closeReviewNotice')} onClick={() => setNotice('')}>×</button></div>}
    {error && <p role="alert">{error}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    <details><summary>{t('manageHosts')}</summary><p>{t('hostScope')}</p>
      <form className={css.form} onSubmit={event => { event.preventDefault(); const host = String(new FormData(event.currentTarget).get('host') ?? ''); void decide('review/destination', { host }, 'destination', t('hostSaved')); }}>
        <label>{t('hostLabel')}<input name="host" required maxLength={253} placeholder="api.example.test" /></label><button className={css.reviewButton} disabled={Boolean(busy)}>{t('addHost')}</button>
      </form>
    </details>
    {Boolean(review?.grants.length) && <>
      <button className={css.reviewButton} aria-expanded={showGrants} onClick={() => setShowGrants(!showGrants)}>{t('savedAllowances')} ({review?.grants.length})</button>
      {showGrants && review?.grants.map(grant => <article className={css.reviewGrant} key={grant.id}>
        <code>{grant.kind === 'destination' ? grant.host : grant.tool}</code><p>{grant.reason}</p>{grant.kind === 'destination' && <small>{t('hostScope')}</small>}
        <details><summary>{t('reviewDetails')}</summary><pre>{stringify({ operation: grant.operation, details: grant.details })}</pre></details>
        <button className={css.reviewButton} disabled={Boolean(busy)} onClick={() => { void decide('review/revoke', { grantId: grant.id }, grant.id, t('revoked')); }}>{t('revoke')}</button>
      </article>)}
    </>}
  </section>;
}

function Panel({ useData, useReviews, useSessions, reviewOperation, refresh, createIdentity, updateSettings, ownerOperation, inspect: remoteInspect, sessionId, t,
  initialTab = 'trajectory', visibleTabs = TABS, configKeys, included, pluginId, openPolicy }: Props): ReactNode {
  const state = useData(value => value);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<EventPage>();
  const [detail, setDetail] = useState<EventDetail & { seq: string }>();
  const [reading, setReading] = useState(false);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  useEffect(() => { setHistory(undefined); setDetail(undefined); setExpanded(undefined); setReading(false); setNotice(''); }, [sessionId]);
  const data = state.snapshot;
  const events = history ?? (data ? { ...data.trajectory, events: data.events } : undefined);
  const inspect = async <T,>(endpoint: string, payload: Row): Promise<T> => {
    const result = await remoteInspect<T>(endpoint, payload);
    if (currentSession.current !== sessionId) throw new Error('Inspection belongs to the previous session');
    return result;
  };
  const read = async (action: () => Promise<void>): Promise<void> => {
    setReading(true); setNotice('');
    try { await action(); } catch (error) { if (currentSession.current === sessionId) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (currentSession.current === sessionId) setReading(false); }
  };
  const openEvent = (seq: string, offset = 0): void => { void read(async () => {
    const result = await inspect<EventDetail>('trajectory/detail', { seq: Number(seq), offset });
    setDetail({ ...result, seq });
  }); };
  const editorConfig = data && (configKeys ? Object.fromEntries(configKeys.map(key => [key, data.pluginConfig[key] ?? {}])) : data.pluginConfig);
  const operate = async (endpoint: string, payload: Row, success: string): Promise<void> => {
    setSaving(true); setNotice('');
    try { await ownerOperation(endpoint, payload); setNotice(success); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const saveIdentity = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
    setSaving(true); setNotice('');
    try {
      await createIdentity({ name: values.get('name'), role: values.get('role'), tenant: values.get('tenant'),
        hosts: String(values.get('hosts')).split(',').map(host => host.trim()).filter(Boolean), kind: values.get('kind') }, String(values.get('secret')));
      form.reset(); setNotice(t('saved'));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const saveSettings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const values = new FormData(event.currentTarget); setSaving(true); setNotice('');
    try { await updateSettings(JSON.parse(String(values.get('scope'))) as Row, JSON.parse(String(values.get('policy'))) as Row); setNotice(t('settingsSaved')); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <section className={css.panel}>
    <header className={css.header}><div><div className={css.eyebrow}>Djupleita / {t('title')}</div><h2>{data?.engagement.name ?? t('loading')}</h2>
      {included && <p className={css.distribution}>{t('included')}</p>}</div>
      <button className={css.button} onClick={refresh} disabled={state.loading} aria-label={t('refresh')}>↻</button></header>
    {data && <div className={css.stats}><span><strong>{data.budget.requests}</strong> {t('requests')}</span>
      <span><strong>{data.graph.counts.nodes}</strong> {t('nodes')}</span><span><strong>{data.graph.counts.edges}</strong> {t('edges')}</span></div>}
    {data?.budget.timeExhausted && tab !== 'policy' && <p className={css.error} role="alert">Engagement time budget expired. Open Engagement and identities → Policy → Renew time budget.</p>}
    <nav className={css.tabs} aria-label={t('title')}>{visibleTabs.map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{t(item)}</button>)}</nav>
    {state.error && <div className={css.error} role="alert">{state.error}</div>}
    {notice && (tab === 'trajectory' || tab === 'graph') && <div className={css.error} role="alert">{notice}</div>}
    {data && <div className={css.body}>
      {tab === 'crawl' && <CrawlPanel data={data.crawl} operate={ownerOperation} openPolicy={openPolicy} />}
      {tab === 'assessment' && <AssessmentPanel key={sessionId} inspect={inspect} sessionId={sessionId} identities={data.identities} />}
      {tab === 'trajectory' && events && <div className={css.timeline}>
        <div className={css.setupActions}><span>{events.total} {t('savedEvents')}</span>
          <button className={css.button} disabled={reading || events.nextBefore === null} onClick={() => { void read(async () => { setHistory(await inspect<EventPage>('trajectory/page', { before: events.nextBefore })); setExpanded(undefined); setDetail(undefined); }); }}>{t('olderEvents')}</button>
          {history && <button className={css.button} onClick={() => { setHistory(undefined); setExpanded(undefined); setDetail(undefined); }}>{t('latestEvents')}</button>}
        </div>
        {events.events.length === 0 && <p className={css.empty}>{t('noEvents')}</p>}
        {[...events.events].reverse().map(event => {
          const seq = label(event, 'seq'), eventData = event.data as Row | undefined;
          const decision = eventData?.decision as Row | undefined;
          const severity = decision?.kind ?? (label(event, 'type').includes('error') ? 'deny' : 'allow');
          return <article key={seq} className={css.event} data-severity={severity}>
            <button onClick={() => { setExpanded(expanded === seq ? undefined : seq); setDetail(undefined); if (expanded !== seq && event.dataTruncated) openEvent(seq); }}><span className={css.dot} />
              <span><strong>{label(event, 'type')}</strong><small>{label(event, 'timestamp').slice(11, 23)} · #{seq}</small></span>
              {decision && <span className={css.badge}>{String(severity)}</span>}</button>
            {decision && <p>{Array.isArray(decision.reasons) ? decision.reasons.join('; ') : ''}</p>}
            {expanded === seq && <>
              {Boolean(event.dataTruncated) && <p>{t('eventPreview')}</p>}
              <pre>{detail?.seq === seq ? detail.text : stringify(event.data)}</pre>
              {detail?.seq === seq && <div className={css.setupActions}>
                <button className={css.button} disabled={reading || detail.offset === 0} onClick={() => openEvent(seq, Math.max(0, detail.offset - 16384))}>{t('previousPage')}</button>
                <span>{detail.offset + 1}–{detail.offset + detail.text.length} / {detail.totalChars}</span>
                <button className={css.button} disabled={reading || detail.nextOffset === null} onClick={() => openEvent(seq, detail.nextOffset!)}>{t('nextPage')}</button>
              </div>}
            </>}</article>;
        })}</div>}
      {tab === 'graph' && <EvidenceGraph key={sessionId} engagement={data.engagement} revision={stringify(data.graph.counts)} inspect={remoteInspect} />}
      {tab === 'identities' && <div>{data.identities.length === 0 && <p className={css.empty}>{t('noIdentities')}</p>}
        {data.identities.map(identity => <article className={css.card} key={label(identity, 'id')}><strong>{label(identity, 'name')}</strong><small>{label(identity, 'role')} / {label(identity, 'tenant')}</small>
          <code>{label(identity, 'id')}</code><small>{Array.isArray(identity.hosts) ? identity.hosts.join(', ') : ''}</small></article>)}
        <form onSubmit={event => { void saveIdentity(event); }} className={css.form}><h3>{t('addIdentity')}</h3>
          {(['name', 'role', 'tenant', 'hosts'] as const).map(field => <label key={field}>{t(field)}<input name={field} required autoComplete="off" /></label>)}
          <label>{t('kind')}<select name="kind"><option value="bearer">Bearer token</option><option value="basic">Basic (user:password)</option><option value="headers">Headers (JSON)</option><option value="browser-state">Browser storage state (JSON)</option></select></label>
          <label>{t('secret')}<textarea name="secret" required autoComplete="off" spellCheck={false} /></label><button className={css.button} disabled={saving}>{t('save')}</button>
          <p role="status">{notice}</p></form></div>}
      {tab === 'policy' && <div><ReviewCards useReviews={useReviews} useSessions={useSessions} reviewOperation={reviewOperation} sessionId={sessionId} t={t} />
        <BudgetCard budget={data.budget} busy={saving} renew={() => { void operate('budget/renew-time', {}, 'Time budget renewed; request usage retained.'); }} />
        <form className={css.form} key={data.policyVersion} onSubmit={event => { void saveSettings(event); }}>
          <PolicyEditor policy={data.policy} />
          <h3>{t('scope')}</h3><p>{t('modelScope')}</p><div className={css.pills}>{data.engagement.scope.targets.map(rule => <code key={rule.host}>{rule.host}</code>)}</div>
          <ScopeEditor scope={data.engagement.scope} title={t('scope')} />
          <button className={css.button} disabled={saving}>{t('saveSettings')}</button><p role="status">{notice}</p>
        </form>
        {(!pluginId || pluginId === 'engagement') && <PluginCredentials data={data.credentials} plugin="engagement" operate={ownerOperation} />}
        </div>}
      {tab === 'studies' && <LearningStudies learning={data.learning} procedure={data.procedure ?? null} busy={saving} notice={notice} operate={operate} />}
      {tab === 'plugins' && <div>
        {pluginId && <PluginCredentials data={data.credentials} plugin={pluginId} operate={ownerOperation} />}
        {data.setup && <ToolSetupCard setup={data.setup} t={t} busy={saving}
          operate={(endpoint, success) => { void operate(endpoint, {}, success); }} />}
        <form className={css.form} key={stringify(editorConfig)} onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget);
          try { const draft = JSON.parse(String(values.get('config'))) as Row;
            void operate('plugins/update', { config: configKeys ? { ...data.pluginConfig, ...draft } : draft }, t('pluginsSaved')); }
          catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }}>
          <label>{t('pluginSettings')}<textarea className={css.editor} name="config" defaultValue={stringify(editorConfig)} required spellCheck={false} /></label>
          <button className={css.button} disabled={saving}>{t('savePlugins')}</button><p role="status">{notice}</p>
        </form><pre>{stringify({ telemetry: data.telemetry, ranking: data.ranking })}</pre>
        {data.plugins.map(plugin => <article className={css.card} key={label(plugin, 'tool')}><strong>{label(plugin, 'tool')}</strong><small>{label(plugin, 'plugin')} · {label(plugin, 'confinement')}</small></article>)}</div>}
    </div>}
  </section>;
}

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'connection'];
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle;
  const ID = '@dsh-pentest/ui';
  ctx.effect(() => ctx.locale.register('pentest', { en, zh }), 'pentest-ui: dictionaries');
  registerBrand(ctx);
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: 'pentest', multiple: false, priority: 'extension',
    title: () => ctx.locale.bind('pentest')('title'), guide: [{ id: 'pentest', order: 5,
      title: () => ctx.locale.bind('pentest')('title'), description: () => ctx.locale.bind('pentest')('description') }] }), 'pentest-ui: tab type');
  const sources = new Map<string, PanelInjected>();
  const lifetime = new AbortController();
  const mode = engagementMode(connection, lifetime.signal);
  ctx.effect(() => () => mode.dispose(), 'pentest-ui: engagement mode');
  const reviews = pollingSource(createSnapshotStore<{ snapshot?: ReviewSnapshot; loading: boolean; error?: string }>({ loading: true }), reviewLoader(connection));
  const reviewFor = (sessionId: string): ReviewInjected => ({ hooks: { reviews }, sessionId,
    async reviewOperation(endpoint, payload) {
      const reply = await connection.rpc.call('/api', `pentest/${endpoint}`, { sessionId, ...payload }, lifetime.signal);
      if (!reply.ok) throw new Error(reply.error.message);
      await reviews.refresh();
    },
  });
  ctx.effect(() => () => { lifetime.abort(); reviews.dispose(); for (const source of sources.values()) source.hooks.data.dispose(); sources.clear(); }, 'pentest-ui: lifetimes');
  const sourceFor = (sessionId: string): PanelInjected => {
      let source = sources.get(sessionId);
      if (!source) {
        const store = createSnapshotStore<PanelState>({ loading: true });
        const data = pollingSource(store, async signal => {
          const reply = await connection.rpc.call('/api', 'pentest/snapshot', { sessionId }, signal);
          if (!reply.ok) throw new Error(reply.error.message);
          return reply.value as Snapshot;
        });
        const inspect = async <T,>(endpoint: string, payload: Row): Promise<T> => {
          const reply = await connection.rpc.call('/api', `pentest/${endpoint}`, { ...payload, sessionId }, lifetime.signal);
          if (!reply.ok) throw new Error(reply.error.message);
          return reply.value as T;
        };
        source = { openPolicy: () => { const navigation = ctx.get('pluginNavigation') as { openItem?(id: string): void; openList(): void } | undefined;
        if (navigation?.openItem) navigation.openItem('djupleita-engagement'); else navigation?.openList(); }, ...reviewFor(sessionId), hooks: { data, reviews }, sessionId, inspect, refresh: () => { void data.refresh(); void reviews.refresh(); }, async createIdentity(metadata, secret) {
          await inspect('identity/create', { metadata, secret }); await data.refresh();
        }, async updateSettings(scope, policy) {
          await inspect('settings/update', { scope, policy }); await data.refresh();
        }, async ownerOperation(endpoint, payload) {
          await inspect(endpoint, payload); await data.refresh();
        } };
        sources.set(sessionId, source);
      }
      return source;
  };
  // The same session-scoped extension point used by Chat and Trajectory works
  // in both the native desktop browser and the authenticated Linux web app.
  const EvidenceView = ({ useData, inspect, sessionId }: InjectFace<PanelInjected>) => {
    const state = useData(value => value);
    if (!state.snapshot) return <p role="status">{state.error ?? 'Loading evidence graph…'}</p>;
    return <EvidenceGraph key={sessionId} engagement={state.snapshot.engagement} revision={stringify(state.snapshot.graph.counts)} inspect={inspect} />;
  };
  const EvidenceMode = (props: InjectFace<PanelInjected>) => {
    const enabled = useSyncExternalStore(mode.subscribe, mode.getSnapshot).snapshot?.enabled;
    return enabled ? <EvidenceView {...props} /> : <EngagementMode mode={mode}><></></EngagementMode>;
  };
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'djupleita-evidence',
    order: 20, locale: 'pentest', label: () => ctx.locale.bind('pentest')('evidenceGraph'), inject: sourceFor }, props => <PanelBoundary><EvidenceMode {...props} /></PanelBoundary>));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'djupleita-review',
    order: -100, locale: 'pentest', inject: reviewFor }, props => <EngagementMode mode={mode} activeOnly><ReviewCards {...props} /></EngagementMode>));
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID,
    locale: 'pentest', inject: sourceFor }, props => <EngagementMode mode={mode}><PanelBoundary><Panel {...props} /></PanelBoundary></EngagementMode>));
  const settings = () => sourceFor('djupleita-settings');
  ctx.slots.inject('plugins.item', () => ctx.slots.register({ name: 'plugins.item', id: 'djupleita-engagement',
    order: -100, label: () => ctx.locale.bind('pentest')('coreTitle'), locale: 'pentest', inject: settings },
    props => props.view === 'summary' ? props.t('coreDescription')
      : <EngagementMode mode={mode}><PanelBoundary><Panel {...props} initialTab="policy" visibleTabs={['policy', 'identities']} pluginId="engagement" included /></PanelBoundary></EngagementMode>));
  for (const plugin of distribution.plugins) {
    const tabs = plugin.tabs.filter((tab): tab is Tab => TABS.includes(tab as Tab));
    const ConfigPage = (props: Props) => <EngagementMode mode={mode} controls={false} openControls={props.openPolicy}><PanelBoundary><Panel {...props} initialTab={tabs[0] ?? 'plugins'}
      visibleTabs={tabs} configKeys={plugin.configKeys} pluginId={plugin.id} included /></PanelBoundary></EngagementMode>;
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config',
      key: plugin.name, locale: 'pentest', inject: settings }, ConfigPage));
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config',
      key: `${plugin.name}#${plugin.row}`, locale: 'pentest', inject: settings }, ConfigPage));
  }
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({ name: 'plugins.detail.badge',
    id: 'djupleita-included', locale: 'pentest' }, ({ subject, t }) => {
      const owned = subject.kind === 'item' ? subject.id === 'djupleita-engagement'
        : distribution.plugins.some(plugin => plugin.name === subject.pkg.name);
      return owned ? <span className={css.includedBadge}>{t('included')}</span> : null;
    }));
}
