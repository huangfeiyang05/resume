<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { CareerJob, Resume, ResumeExportFormat, RestoreResumeResult } from '../../shared/types';
import type { AuthCapabilities, AuthUser, VerifyEmailInput, BindPhoneInput, BindEmailInput } from '../../shared/auth';
import type { PaidPlanId } from '../../shared/membership';
import { parseResumeText, type ResumeExportTemplate } from '../../shared/resume-layout';
import { inputLimits } from '../../shared/limits';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';
import AccountBindings from './AccountBindings.vue';
import ResumeDocument from './ResumeDocument.vue';
import ResumeHistory from './ResumeHistory.vue';
import ResumeLayoutLibrary from './ResumeLayoutLibrary.vue';
import DiagnosisReport from './DiagnosisReport.vue';
import BenefitsPanel from './BenefitsPanel.vue';
import CareerPanel from './CareerPanel.vue';
import SiteFooter from './SiteFooter.vue';
import { useWorkspace, type Page } from '../services/workspace';
import { api, ApiError } from '../services/api';
import { useEmailChallenge } from '../services/auth';
import { exampleJob } from '../utils/example';
import { selectResumeFile } from '../utils/selectResumeFile';
import { normalizeImportedText } from '../utils/importResume';
import { saveResumeExportFile } from '../utils/saveExportFile';
import { downloadResumeTemplate } from '../utils/downloadResumeTemplate';
import { resumeTemplates, type ResumeWordTemplate } from '../data/resumeTemplates';

const props = defineProps<{ user: AuthUser; logoutBusy?: boolean; logoutError?: string; verificationBusy?: boolean; bindingBusy?: boolean; capabilities?: AuthCapabilities }>();
const emit = defineEmits<{ logout: []; verifyEmail: [input: VerifyEmailInput]; bindPhone: [input: BindPhoneInput]; bindEmail: [input: BindEmailInput]; clearAuthError: [] }>();
const w = useWorkspace({ userId: props.user.id });
const verification = useEmailChallenge();
const { code: verifyCode, busy: verifyCodeBusy, error: verifyCodeError, message: verifyCodeMessage, remaining: verifyRemaining } = verification;
const verifyOpen = ref(false);
const verificationAvailable = computed(() => props.capabilities?.emailVerification === true);
const verifyMessage = computed(() => verifyCodeError.value || props.logoutError || '');
watch(() => props.user.email, email => { if (email) verification.setTarget(email, 'verify-email'); }, { immediate: true });
watch(() => props.user.emailVerified, verified => {
  if (!verified || !verifyOpen.value) return;
  verifyOpen.value = false;
  verification.clearProof();
  w.toast('邮箱已验证，现在可以用它找回密码。');
});
function openVerify() {
  if (!verificationAvailable.value || props.verificationBusy || !props.user.email) return;
  verification.clearProof();
  verification.setTarget(props.user.email, 'verify-email');
  verifyOpen.value = true;
}
function closeVerify() {
  if (props.verificationBusy) return;
  verifyOpen.value = false;
  verification.clearProof();
}
async function sendVerifyCode() {
  if (props.verificationBusy || verifyCodeBusy.value || !props.user.email) return;
  verification.setTarget(props.user.email, 'verify-email');
  await verification.send();
}
function submitVerify() {
  if (props.verificationBusy || verifyCodeBusy.value) return;
  const proof = verification.proof();
  if (!proof) return;
  emit('verifyEmail', proof);
}
const { health, analysisRunning, page, resumes, selectedId, selected, analysis, history, busy, loading, loadError, notice, editorOpen, editorId, editorTitle, editorRole, editorText, editorBaseRevision, jobDescription, targetRole, activeSuggestion } = w;
const { editorImportBusy, editorImportError, editorImportPreview } = w;
const tabs: { id: Page; label: string; icon: string }[] = [
  { id: 'overview', label: '首页', icon: 'grid' }, { id: 'career', label: '工作台', icon: 'sparkles' },
  { id: 'benefits', label: '权益', icon: 'crown' }, { id: 'resumes', label: '我的', icon: 'user' },
];
const activeTab = computed(() => ['diagnosis', 'match', 'templates'].includes(page.value) ? 'overview' : page.value);
const pageTitle = computed(() => tabs.find(t => t.id === activeTab.value)?.label || '首页');
const importOpen = ref(false), guideOpen = ref(false), exportOpen = ref(false);
const pasteText = ref(''), pasteTitle = ref(''), search = ref('');
const suggestionText = ref('');
const suggestionIncomplete = computed(() => !suggestionText.value.trim() || /\[请填写真实[^\]]*\]/.test(suggestionText.value));
const deleteTarget = ref<Resume>();
const historyTarget = ref<Resume>();
async function restoredVersion(result: RestoreResumeResult) {
  historyTarget.value = undefined;
  const synchronized = await w.acceptRestoredResume(result.resume);
  if (synchronized && result.noChange) w.toast('本次恢复未新增版本，已同步最新简历。');
}
const template = ref<ResumeExportTemplate>('minimal');
const exportFormat = ref<ResumeExportFormat>('pdf');
const exporting = ref(false);
const downloadingTemplateId = ref<string>();
const exportDocument = computed(() => selected.value ? parseResumeText(selected.value.text, selected.value.title) : undefined);
const editorOrigin = ref<Page>('overview');
let navigationRevision = 0;
const visibleResumes = computed(() => resumes.value.filter(r => `${r.title} ${r.targetRole}`.toLowerCase().includes(search.value.toLowerCase())));
const editorConflict = computed(() => !!editorId.value && editorBaseRevision.value !== resumes.value.find(r => r.id === editorId.value)?.revision);
const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
watch(activeSuggestion, value => { suggestionText.value = value?.replacement || ''; });
watch([editorTitle, editorRole, editorText], () => w.saveDraft());
const requestedMembershipPlan = ref<PaidPlanId>();
function navigate(next: Page) { requestedMembershipPlan.value = undefined; navigationRevision++; page.value = next; nextTick(() => uni.pageScrollTo({ scrollTop: 0, duration: 0 })); }
function openMembershipUpgrade(planId: PaidPlanId) {
  navigate('benefits');
  requestedMembershipPlan.value = planId;
}
function openEditor(resume?: Resume, text?: string, title?: string) { editorOrigin.value = page.value; w.openEditor(resume, text, title); }
async function saveResume(diagnose = false) {
  const origin = editorOrigin.value, revision = navigationRevision;
  await w.saveEditor(diagnose, true);
  if (!editorOpen.value && selected.value && revision === navigationRevision) {
    page.value = origin === 'overview' ? 'overview' : diagnose ? 'diagnosis' : origin === 'career' ? 'career' : 'resumes';
    if (diagnose && origin === 'overview') scrollTo('#analysis-result');
  }
}
async function openResume(resume: Resume, next: Page = 'overview') { const revision = navigationRevision; await w.select(resume.id); if (revision === navigationRevision && selectedId.value === resume.id) navigate(next); }
function selectChange(event: { detail: { value: string | number } }) { const resume = resumes.value[Number(event.detail.value)]; if (resume) w.select(resume.id); }
function scrollTo(selector: string) {
  nextTick(() => uni.createSelectorQuery().select(selector).boundingClientRect().select('.glass-header').boundingClientRect().selectViewport().scrollOffset(() => {}).exec(results => {
    const [target, header, viewport] = results;
    if (!target) return;
    uni.pageScrollTo({ scrollTop: Math.max(0, (viewport?.scrollTop || 0) + target.top - (header?.height || 65) - 18), duration: 260 });
  }));
}
function homeSection(selector: string) { navigationRevision++; page.value = 'overview'; scrollTo(selector); }
function tailorCareerJob(job: CareerJob) {
  targetRole.value = job.title;
  jobDescription.value = job.description;
  homeSection('#job-section');
  w.toast('岗位要求已带入，请核对所选简历后开始分析。');
}
function invalidateCareerAction() { navigationRevision++; }
async function optimizeAssistantResume(action: { resumeId: string; revision: number; targetRole: string }) {
  const revision = navigationRevision;
  const stillActive = () => revision === navigationRevision && page.value === 'career';
  const result = await w.analyzeFromAssistant(action, stillActive);
  if (result && stillActive()) navigate('diagnosis');
}
async function tailorAssistantJob(input: { job: CareerJob; resumeId?: string; revision?: number }) {
  const revision = navigationRevision;
  const stillActive = () => revision === navigationRevision && page.value === 'career';
  if (input.resumeId && input.revision !== undefined) {
    if (!await w.selectAssistantResume({ resumeId: input.resumeId, revision: input.revision }, stillActive)) return;
  }
  if (stillActive()) tailorCareerJob(input.job);
}
async function runHomeAnalysis() {
  if (!selected.value) { importOpen.value = true; return; }
  const result = await w.diagnoseResume(!!jobDescription.value.trim(), true);
  if (result && page.value === 'overview') scrollTo('#analysis-result');
}
async function useExample() { const revision = navigationRevision; await w.useExample(true); if (analysis.value && revision === navigationRevision && page.value === 'overview') scrollTo('#analysis-result'); }
function pasteImport() {
  if (pasteText.value.trim().length < 20) { w.toast('请粘贴至少 20 字的简历正文。'); return; }
  importOpen.value = false; openEditor(undefined, pasteText.value.trim(), pasteTitle.value.trim() || '导入的简历');
}
function chooseFile() {
  importOpen.value = false;
  openEditor();
  chooseEditorFile();
}
function chooseEditorFile() {
  void w.importEditorFile((signal, onParsing) => selectResumeFile({ signal, onParsing }));
}
function importEditorClipboard() {
  void w.importEditorFile((_signal, onParsing) => new Promise((resolve, reject) => {
    onParsing();
    uni.getClipboardData({
      success: result => {
        try {
          const text = normalizeImportedText(result.data);
          if (!text) throw new Error('剪贴板没有简历正文，请复制文字后重试。');
          resolve({ text, fileName: '', format: 'txt' });
        } catch (cause) { reject(cause); }
      },
      fail: () => reject(new Error('无法读取剪贴板，请直接粘贴简历正文。')),
    });
  }));
}
function readClipboard() { uni.getClipboardData({ success: result => { pasteText.value = result.data; }, fail: () => w.toast('无法读取剪贴板，请直接粘贴正文。') }); }
function openExport() { if (!selected.value) { w.toast('请先导入或创建简历。'); importOpen.value = true; return; } exportOpen.value = true; }
function editExportResume() { if (!selected.value) return; exportOpen.value = false; openEditor(selected.value); }
async function downloadExport() {
  const resume = selected.value;
  if (!resume || exporting.value) return;
  exporting.value = true;
  try {
    const file = await api.exportResume(resume.id, { revision: resume.revision, format: exportFormat.value, template: template.value });
    const result = await saveResumeExportFile(file);
    w.toast(result === 'file-opened' ? '简历文件已打开，可保存或转发。' : '导出已开始，请在浏览器下载中查看。');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
      w.toast('简历正文已更新，正在载入最新版本，请重新预览后导出。');
      exportOpen.value = false;
      await w.refresh();
    } else if (error instanceof ApiError && error.code === 'EXPORT_BUSY') {
      w.toast('已有文件正在生成，请稍后重试。');
    } else {
      w.fail(error);
    }
  } finally {
    exporting.value = false;
  }
}
async function downloadWordTemplate(item: ResumeWordTemplate) {
  if (downloadingTemplateId.value) return;
  downloadingTemplateId.value = item.id;
  try { await downloadResumeTemplate({ path: item.downloadUrl, fileName: item.fileName }); }
  catch (error) { w.fail(error); }
  finally { downloadingTemplateId.value = undefined; }
}
async function confirmDelete() { if (deleteTarget.value) { await w.remove(deleteTarget.value); deleteTarget.value = undefined; } }
function selectLayout(item: ResumeWordTemplate) { template.value = item.layout; }
</script>

<template>
  <view class="app-shell liquid-app">
    <view class="glass-header"><view class="header-inner"><button class="header-brand" @click="navigate('overview')" role="button" tabindex="0"><view class="brand-mark"><image class="brand-logo" src="/static/brand/logo.png" mode="aspectFill" aria-label="简历有方 Logo" /></view><text>简历有方</text></button><view class="desktop-tabs"><button v-for="tab in tabs" :key="tab.id" :class="{ active: activeTab === tab.id }" @click="navigate(tab.id)" role="button" tabindex="0">{{ tab.label }}</button></view><button class="header-benefits" @click="navigate('benefits')" role="button" tabindex="0"><AppIcon name="crown" :size="16" /><text>我的权益</text></button></view></view>
    <view class="content">
      <template v-if="page === 'overview'">
        <view class="home-intro"><view><text class="home-title">简历与岗位</text></view><button class="sample-link" :disabled="!!busy" @click="useExample()" role="button" tabindex="0">使用示例<AppIcon name="arrow" :size="15" /></button></view>
        <view class="home-form-grid">
          <view id="resume-section" class="glass-panel flow-card resume-input-card"><view class="flow-card-heading"><view><text class="flow-card-title">简历内容</text></view><button class="text-button" @click="openEditor()" role="button" tabindex="0"><AppIcon name="plus" :size="15" />新建</button></view>
            <view v-if="loading" class="inline-load"><view class="spinner" /><text>正在打开简历…</text></view><view v-else-if="loadError" class="connection-error"><text>{{ loadError }}</text><button class="text-button" @click="w.refresh()" role="button" tabindex="0">重新连接</button></view>
            <view v-else-if="selected" class="selected-resume"><view class="selected-resume-top"><view class="document-icon"><AppIcon name="file" :size="25" /></view><view class="selected-resume-info"><text>{{ selected.title }}</text><text>{{ selected.text.length }} 字 · V{{ selected.revision }} · {{ formatDate(selected.updatedAt) }}更新</text></view><view class="ready-check"><AppIcon name="check" :size="15" /></view></view><view class="selected-resume-excerpt">{{ selected.text.slice(0, 160) }}</view><view class="selected-resume-actions"><button class="text-button" @click="openEditor(selected)" role="button" tabindex="0"><AppIcon name="edit" :size="15" />编辑正文</button><button class="text-button" :disabled="!!busy" @click="historyTarget = selected" role="button" tabindex="0"><AppIcon name="clock" :size="15" />版本记录</button><button class="text-button" @click="importOpen = true" role="button" tabindex="0">更换简历<AppIcon name="upload" :size="14" /></button></view></view>
            <view v-else class="home-upload"><!-- #ifdef H5 --><button class="upload-trigger" :disabled="!!busy" @click="chooseFile" role="button" tabindex="0"><view class="upload-button-icon"><AppIcon name="upload" :size="28" /></view><text>点击选择简历</text><text>PDF、DOCX、TXT、Markdown</text></button><!-- #endif --><!-- #ifdef MP-WEIXIN --><button class="upload-trigger" :disabled="!!busy" @click="importOpen = true" role="button" tabindex="0"><view class="upload-button-icon"><AppIcon name="file" :size="28" /></view><text>导入简历正文</text><text>粘贴文字或读取剪贴板</text></button><!-- #endif --><button class="paste-entry" @click="importOpen = true" role="button" tabindex="0"><AppIcon name="copy" :size="15" />直接粘贴简历正文<AppIcon name="chevron" :size="13" /></button></view>
            <view v-if="resumes.length > 1" class="switch-resume"><text>切换简历</text><picker :range="resumes" range-key="title" :value="Math.max(0, resumes.findIndex(r => r.id === selectedId))" @change="selectChange"><view><text>{{ selected?.title }}</text><AppIcon name="chevron" :size="13" /></view></picker></view>
          </view>
          <view id="job-section" class="glass-panel flow-card job-input-card"><view class="flow-card-heading"><view><text class="flow-card-title">优化要求</text></view><button class="text-button" @click="jobDescription = exampleJob; targetRole = '产品经理'" role="button" tabindex="0">填入示例</button></view><text class="field-label">目标岗位</text><input v-model="targetRole" class="text-input" placeholder="例如：Java 开发工程师" :maxlength="inputLimits.targetRole" aria-label="目标岗位" /><view class="field-label-row"><text class="field-label">岗位描述 / 优化方向</text><text class="optional-label">选填</text></view><textarea v-model="jobDescription" class="large-textarea home-job-textarea" placeholder="粘贴岗位职责、任职要求，帮助找出值得补充的能力与经历。" :maxlength="inputLimits.jobDescription" aria-label="岗位描述与优化方向" /></view>
        </view>
        <ResumeLayoutLibrary :selected-layout="template" :loading-id="downloadingTemplateId" @select="selectLayout" @preview-resume="openExport" @download="downloadWordTemplate" />
        <view class="home-submit-row"><button class="button primary analyze-button" :disabled="!!busy" @click="runHomeAnalysis" role="button" tabindex="0"><AppIcon name="sparkles" :size="19" />{{ selected ? '开始诊断与优化' : '导入简历，开始优化' }}<AppIcon name="arrow" :size="17" /></button></view>
        <view v-if="analysis && selected" id="analysis-result"><DiagnosisReport :analysis="analysis" :resume="selected" :history="history" :busy="busy" @inspect="activeSuggestion = $event" @export="openExport" @history="analysis = $event" @reanalyze="runHomeAnalysis" /></view>
        <button class="glass-panel membership-banner" @click="navigate('benefits')" role="button" tabindex="0"><view class="membership-banner-copy"><text class="membership-banner-title">会员方案</text><text class="membership-banner-description">按需选择适合你的会员权益</text></view><view class="membership-banner-link">查看权益<AppIcon name="arrow" :size="16" /></view></button>

      </template>
      <BenefitsPanel v-else-if="page === 'benefits'" :initial-plan="requestedMembershipPlan" />
      <CareerPanel v-else-if="page === 'career'" :resumes="resumes" :owner="user.id" @context-change="invalidateCareerAction" @tailor="tailorCareerJob" @tailor-assistant-job="tailorAssistantJob" @optimize-resume="optimizeAssistantResume" @create-resume="openEditor()" @upgrade="openMembershipUpgrade" />
      <template v-else-if="page === 'resumes'"><view class="compact-page-heading my-page-heading"><view><text class="compact-page-title">我的简历</text></view><button class="button primary small-button" @click="openEditor()" role="button" tabindex="0"><AppIcon name="plus" :size="16" />新建简历</button></view><view class="glass-panel account-strip"><view class="avatar">YF</view><view><text class="account-email">{{ user.email || (user.phone ? `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}` : user.wechat ? '微信用户' : '当前账号') }}</text><text class="account-meta">{{ resumes.length }} 份简历 · 仅本人账号可访问</text><view v-if="user.email" :class="['account-state', { verified: user.emailVerified }]"><AppIcon :name="user.emailVerified ? 'check' : 'info'" :size="12" /><text>{{ user.emailVerified ? '邮箱已验证 · 可用于找回密码' : verificationAvailable ? '邮箱未验证 · 验证后可用于找回密码' : '邮箱未验证 · 验证功能暂未启用' }}</text></view></view><view class="account-actions"><button v-if="user.email && !user.emailVerified && verificationAvailable" class="text-button account-verify" :disabled="verificationBusy" @click="openVerify" role="button" tabindex="0">{{ verificationBusy ? '正在验证…' : '验证邮箱' }}</button><button class="text-button" @click="navigate('benefits')" role="button" tabindex="0">查看权益<AppIcon name="chevron" :size="14" /></button><button class="text-button account-logout" :disabled="logoutBusy" @click="emit('logout')" role="button" tabindex="0">{{ logoutBusy ? '正在退出…' : '退出登录' }}</button></view></view><AccountBindings :key="user.id" :user="user" :capabilities="capabilities" :busy="bindingBusy || logoutBusy || verificationBusy" :error="logoutError" @bind-phone="emit('bindPhone', $event)" @bind-email="emit('bindEmail', $event)" @clear-error="emit('clearAuthError')" /><view v-if="logoutError && !verifyOpen" class="info-banner" role="alert"><AppIcon name="info" :size="16" /><text>{{ logoutError }}</text></view><view v-if="resumes.length" class="search-field"><AppIcon name="search" :size="18" /><input v-model="search" placeholder="搜索简历名称或岗位" aria-label="搜索简历" /></view><view v-if="loading" class="empty-state"><view class="spinner" /><text>正在加载…</text></view><view v-else-if="loadError" class="empty-state"><text>{{ loadError }}</text><button class="text-button" @click="w.refresh()" role="button" tabindex="0">重试</button></view><view v-else-if="!resumes.length" class="glass-panel empty-state"><AppIcon name="file" :size="32" /><text class="empty-title">从第一份简历开始</text><button class="button primary" @click="importOpen = true" role="button" tabindex="0">导入简历</button></view><view v-else-if="!visibleResumes.length" class="empty-state"><text>没有找到相关简历</text><button class="text-button" @click="search = ''" role="button" tabindex="0">清除搜索</button></view><view v-else class="resume-list glass-panel"><view v-for="resume in visibleResumes" :key="resume.id" class="resume-row"><view class="document-icon"><AppIcon name="file" :size="23" /></view><view class="resume-row-main"><button class="resume-name" @click="openResume(resume)" role="button" tabindex="0">{{ resume.title }}</button><view class="resume-meta"><text>{{ resume.targetRole || '未设置岗位' }}</text><text>V{{ resume.revision }} · {{ formatDate(resume.updatedAt) }}</text></view></view><view class="resume-row-actions"><button class="text-button" :disabled="!!busy" @click="openResume(resume)" role="button" tabindex="0">打开<AppIcon name="arrow" :size="14" /></button><button class="icon-button" :disabled="!!busy" :aria-label="`查看${resume.title}的版本记录`" @click="historyTarget = resume" role="button" tabindex="0"><AppIcon name="clock" :size="17" /></button><button class="icon-button" :aria-label="`编辑${resume.title}`" @click="openEditor(resume)" role="button" tabindex="0"><AppIcon name="edit" :size="17" /></button><button class="icon-button delete-button" :aria-label="`删除${resume.title}`" @click="deleteTarget = resume" role="button" tabindex="0"><AppIcon name="trash" :size="17" /></button></view></view></view><button class="glass-panel my-guide-row" @click="guideOpen = true" role="button" tabindex="0"><AppIcon name="book" :size="19" /><text>简历优化指南</text><AppIcon name="chevron" :size="15" /></button></template>
      <template v-else><view class="compact-page-heading"><text class="compact-page-title">简历诊断</text><button class="text-button" @click="navigate('overview')" role="button" tabindex="0">返回首页<AppIcon name="arrow" :size="15" /></button></view><DiagnosisReport v-if="analysis && selected" :analysis="analysis" :resume="selected" :history="history" :busy="busy" @inspect="activeSuggestion = $event" @export="openExport" @history="analysis = $event" @reanalyze="w.diagnoseResume()" /><view v-else class="glass-panel empty-state"><text class="empty-title">先导入简历，开始一次诊断。</text><button class="button primary" @click="navigate('overview')" role="button" tabindex="0">回到首页</button></view></template>
      <SiteFooter />
    </view>
    <view class="liquid-dock" role="navigation" aria-label="主导航"><button v-for="tab in tabs" :key="tab.id" :class="{ active: activeTab === tab.id }" :aria-current="activeTab === tab.id ? 'page' : undefined" @click="navigate(tab.id)" role="button" tabindex="0"><view><AppIcon :name="tab.icon" :size="21" /></view><text>{{ tab.label }}</text></button></view>
    <AppModal v-if="importOpen" title="导入简历" @close="importOpen = false"><view class="import-body"><!-- #ifdef H5 --><button class="upload-dropzone" :disabled="!!busy" @click="chooseFile" role="button" tabindex="0"><view class="upload-cloud"><AppIcon name="upload" :size="30" /></view><text class="upload-title">选择你的简历文件</text><text class="upload-description">PDF、Word（.docx）、TXT、Markdown · 最大 10 MB</text><text class="upload-local"><AppIcon name="shield" :size="13" />文件在本机解析，不上传原文件</text></button><!-- #endif --><view class="or-divider"><view /><text>或直接粘贴正文</text><view /></view><input v-model="pasteTitle" class="text-input" placeholder="简历名称（选填）" :maxlength="100" aria-label="导入简历名称" /><textarea v-model="pasteText" class="large-textarea paste-textarea" placeholder="在这里粘贴简历正文，请保留教育、工作与项目经历等内容。" :maxlength="inputLimits.resumeText" aria-label="粘贴简历正文" /><!-- #ifdef MP-WEIXIN --><button class="text-button" @click="readClipboard" role="button" tabindex="0">从剪贴板读取</button><!-- #endif --><view class="modal-footer"><button class="button primary" :disabled="!!busy" @click="pasteImport" role="button" tabindex="0">继续整理<AppIcon name="arrow" :size="16" /></button></view></view></AppModal>
    <AppModal v-if="editorOpen" :title="editorId ? '编辑简历' : '新建简历'" wide @close="w.closeEditor()">
      <view v-if="editorConflict" class="info-banner"><AppIcon name="info" :size="17" /><text>草稿基于旧版本。请先复制要保留的内容，再载入最新版本。</text><button class="text-button" :disabled="!!busy || editorImportBusy || !!editorImportPreview" @click="w.reloadEditor()" role="button" tabindex="0">载入最新版本</button></view>
      <view class="editor-grid"><view class="editor-form">
        <view class="editor-import-entry">
          <!-- #ifdef H5 -->
          <view class="editor-import-row"><view><text class="editor-import-title">已有 Word 或 PDF 简历？</text><text class="editor-import-description">上传文件，自动提取为可编辑的简历正文</text></view><button class="button secondary" :disabled="!!busy || editorImportBusy || !!editorImportPreview" @click="chooseEditorFile" role="button" tabindex="0"><view v-if="editorImportBusy" class="spinner" /><AppIcon v-else name="upload" :size="17" />{{ editorImportBusy ? '正在选择或识别…' : '上传 Word / PDF' }}</button></view>
          <text class="editor-import-hint">支持 .docx、文字型 PDF、TXT、Markdown · 最大 10 MB</text>
          <text class="editor-import-local"><AppIcon name="shield" :size="13" />在本机提取文字，不上传原文件；请核对内容后保存。</text>
          <!-- #endif -->
          <!-- #ifdef MP-WEIXIN -->
          <view class="editor-import-row"><view><text class="editor-import-title">导入已有简历正文</text><text class="editor-import-description">复制文字后填入，也可以直接在下方编辑</text></view><button class="button secondary" :disabled="!!busy || editorImportBusy || !!editorImportPreview" @click="importEditorClipboard" role="button" tabindex="0"><AppIcon name="copy" :size="17" />{{ editorImportBusy ? '正在读取…' : '从剪贴板导入' }}</button></view>
          <text class="editor-import-hint">Word / PDF 文件请在网页端导入，微信端可粘贴正文。</text>
          <!-- #endif -->
          <button v-if="editorImportBusy" class="text-button editor-import-cancel" @click="w.cancelEditorImport()" role="button" tabindex="0">取消导入，保留当前正文</button>
        </view>
        <view v-if="editorImportError" class="editor-import-error" role="alert"><AppIcon name="info" :size="16" /><text>{{ editorImportError }}</text></view>
        <view v-if="editorImportPreview" class="editor-import-preview">
          <text class="editor-import-title">识别结果预览</text><text class="editor-import-description">{{ editorImportPreview.fileName || '剪贴板正文' }} · {{ editorImportPreview.text.length }} 字</text>
          <text class="editor-import-hint">当前已有正文。请核对识别内容，确认后再替换；简历名称和目标岗位会保留。</text>
          <scroll-view scroll-y class="editor-import-preview-body"><text selectable class="editor-import-preview-text">{{ editorImportPreview.text }}</text></scroll-view>
          <view class="editor-import-actions"><button class="button secondary" @click="w.cancelEditorImport()" role="button" tabindex="0">保留现有正文</button><button class="button primary" @click="w.confirmEditorImport()" role="button" tabindex="0">替换为识别正文</button></view>
        </view>
        <view class="editor-inputs"><view><text class="field-label">简历名称</text><input v-model="editorTitle" class="text-input" placeholder="例如：产品经理 · 秋招版" :maxlength="100" aria-label="简历名称" /></view><view><text class="field-label">目标岗位</text><input v-model="editorRole" class="text-input" placeholder="例如：产品经理" :maxlength="100" aria-label="编辑目标岗位" /></view></view>
        <view class="field-label-row"><text class="field-label">简历正文</text><text class="subtle">{{ editorText.length }} 字</text></view><textarea v-model="editorText" class="large-textarea editor-textarea" placeholder="写下你的基本信息、教育、工作、项目经历和技能。" :maxlength="inputLimits.resumeText" aria-label="简历正文" /><view class="draft-status"><view class="online-dot" />草稿保存在本机，保存后同步。</view>
      </view></view>
      <view class="modal-footer editor-footer"><view class="inline-actions"><button class="button secondary" :disabled="!!busy || editorImportBusy || !!editorImportPreview" @click="saveResume(false)" role="button" tabindex="0">保存简历</button><button class="button primary" :disabled="!!busy || editorImportBusy || !!editorImportPreview" @click="saveResume(true)" role="button" tabindex="0">保存并诊断<AppIcon name="sparkles" :size="17" /></button></view></view>
    </AppModal>
    <AppModal v-if="activeSuggestion" title="审核修改" subtitle="核对真实内容后，确认采纳。" wide @close="activeSuggestion = undefined"><view class="comparison-grid"><view class="comparison-original"><view class="comparison-label">原文</view><text>{{ activeSuggestion.original }}</text></view><view class="comparison-revised"><view class="comparison-label">修改后</view><textarea v-model="suggestionText" class="large-textarea suggestion-textarea" :maxlength="inputLimits.replacement" aria-label="编辑建议内容" /></view></view><view class="comparison-reason"><AppIcon name="bulb" :size="18" /><text>{{ activeSuggestion.reason }}</text></view><view class="modal-footer"><button class="text-button muted" @click="activeSuggestion = undefined" role="button" tabindex="0">暂时保留原文</button><button class="button primary" :disabled="!!busy || suggestionIncomplete" @click="w.applySuggestion(suggestionText, true)" role="button" tabindex="0">{{ suggestionIncomplete ? '请补充待填内容' : '确认并采纳' }}<AppIcon name="check" :size="17" /></button></view></AppModal>
    <AppModal v-if="exportOpen && selected && exportDocument" title="预览与导出" subtitle="导出已保存的简历。" wide @close="exportOpen = false">
      <view class="export-body">
        <view class="export-resume"><view class="resume-file-icon"><AppIcon name="file" :size="24" /></view><view><text class="issue-title">{{ selected.title }}</text><text class="subtle">V{{ selected.revision }} · {{ selected.text.length }} 字</text></view></view>
        <view class="template-options"><button v-for="item in resumeTemplates" :key="item.id" :class="{ active: template === item.layout }" :aria-pressed="template === item.layout" @click="template = item.layout" role="button" tabindex="0">{{ item.name }}<text>{{ item.caption }}</text></button></view>
        <view class="resume-layout-stage"><ResumeDocument :document="exportDocument" :variant="template" /></view>
        <view class="layout-edit-hint"><button class="text-button" @click="editExportResume" role="button" tabindex="0">编辑正文<AppIcon name="edit" :size="14" /></button></view>
        <text class="field-label">导出格式</text>
        <view class="template-options export-format-options" role="group" aria-label="选择导出格式"><button :class="{ active: exportFormat === 'pdf' }" :aria-pressed="exportFormat === 'pdf'" :disabled="exporting" @click="exportFormat = 'pdf'" role="button" tabindex="0">PDF<text>A4 定稿 · 适合直接投递</text></button><button :class="{ active: exportFormat === 'docx' }" :aria-pressed="exportFormat === 'docx'" :disabled="exporting" @click="exportFormat = 'docx'" role="button" tabindex="0">Word<text>.docx · 可继续编辑</text></button></view>
        <button class="button primary full-width" :disabled="exporting" @click="downloadExport" role="button" tabindex="0"><view v-if="exporting" class="spinner" /><AppIcon v-else name="download" :size="18" />{{ exporting ? '正在生成文件…' : `导出 ${exportFormat === 'pdf' ? 'PDF' : 'Word'} 文件` }}</button>

      </view>
    </AppModal>
    <ResumeHistory v-if="historyTarget" :resume="historyTarget" @close="historyTarget = undefined" @restored="restoredVersion" />
    <AppModal v-if="deleteTarget" title="删除这份简历？" subtitle="简历、历史版本、关联诊断和绑定这份简历的投递计划将一并删除，无法撤销。" @close="deleteTarget = undefined"><view class="delete-confirm-name">{{ deleteTarget.title }}</view><view class="modal-footer"><button class="button secondary" @click="deleteTarget = undefined" role="button" tabindex="0">保留简历</button><button class="button danger" :disabled="!!busy" @click="confirmDelete" role="button" tabindex="0">确认删除</button></view></AppModal>
    <AppModal v-if="verifyOpen" title="验证你的邮箱" subtitle="验证后，这个邮箱可用于找回密码。" @close="closeVerify">
      <view class="verify-email">
        <view class="verify-email-summary"><text class="field-caption">当前账号邮箱</text><text class="verify-email-address">{{ user.email }}</text></view>
        <view class="auth-field"><text class="field-label">邮箱验证码</text><view class="auth-code-row"><input v-model="verifyCode" class="text-input auth-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字验证码" :maxlength="6" :disabled="verificationBusy || verifyCodeBusy" aria-label="邮箱验证码" @confirm="submitVerify" /><button class="button secondary auth-code-send" :disabled="verificationBusy || verifyCodeBusy || verifyRemaining > 0" role="button" tabindex="0" @click="sendVerifyCode">{{ verifyCodeBusy ? '正在发送…' : verifyRemaining > 0 ? `${verifyRemaining} 秒后重发` : '获取验证码' }}</button></view><text v-if="verifyCodeMessage" class="auth-code-message" role="status">{{ verifyCodeMessage }}</text></view>
        <view v-if="verifyMessage" class="auth-error" role="alert"><AppIcon name="info" :size="16" /><text>{{ verifyMessage }}</text></view>
        <text class="verify-email-note">验证码 10 分钟内有效。</text>
        <view class="modal-footer"><button class="text-button muted" :disabled="verificationBusy" @click="closeVerify" role="button" tabindex="0">稍后验证</button><button class="button primary" :disabled="verificationBusy || verifyCodeBusy || verifyCode.length !== 6" @click="submitVerify" role="button" tabindex="0"><view v-if="verificationBusy" class="spinner" /><text>{{ verificationBusy ? '正在验证…' : '完成验证' }}</text><AppIcon v-if="!verificationBusy" name="check" :size="17" /></button></view>
      </view>
    </AppModal>
    <AppModal v-if="guideOpen" title="简历写作指南" @close="guideOpen = false"><view class="guide-content"><view v-for="(tip, index) in [{ title: '先回答：为什么是你？', body: '围绕目标岗位，把最相关的能力和经历放在前面，避免用一份泛泛的简历应对所有机会。' }, { title: '写贡献，也写背景', body: '交代问题是什么、你具体做了什么、结果如何。明确你的个人贡献，少用空泛的“负责、参与、协助”。' }, { title: '有数字，更要有依据', body: '使用能说明和验证的数据。缺少量化指标时，可以补充业务规模、交付结果、难度和反馈。' }, { title: '真实，比完美更重要', body: '逐条确认优化建议。不要添加做不到、说不清或没有发生过的经历、技能和成果。' }]" :key="tip.title" class="guide-tip"><view>{{ String(index + 1).padStart(2, '0') }}</view><view><text>{{ tip.title }}</text><text>{{ tip.body }}</text></view></view><view class="guide-engine-note"><AppIcon name="info" :size="17" /><text>{{ health?.aiConfigured ? '当前使用百炼千问提供表达建议，参考分和关键词覆盖由规则计算。未接入知识库，所有建议需要核实真实事实。' : '当前使用本地规则检查表达、结构与关键词。知识库尚未接入。' }}</text></view></view></AppModal>
    <view v-if="notice" class="toast" role="status" aria-live="polite"><AppIcon name="info" :size="18" /><text>{{ notice }}</text><button aria-label="关闭提示" @click="notice = ''" role="button" tabindex="0"><AppIcon name="close" :size="16" /></button></view>
    <view v-if="busy" class="busy-indicator" role="status" aria-live="polite"><view class="spinner" /><text>{{ busy }}…</text><button v-if="analysisRunning" class="text-button" role="button" tabindex="0" @click="w.cancelAnalysis()">取消</button></view>
  </view>
</template>

<style scoped>
.editor-import-entry { border: 1px dashed #b6c9e2; border-radius: 12px; padding: 17px 18px; background: rgba(240,246,255,.55); margin-bottom: 20px; }
.editor-import-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.editor-import-row > view { min-width: 0; }
.editor-import-row > .button { flex-shrink: 0; font-size: 14px; }
.editor-import-title { display: block; color: var(--ink); font-size: 15px; font-weight: 600; }
.editor-import-description { display: block; color: var(--muted); font-size: 13px; line-height: 1.7; margin-top: 4px; overflow-wrap: anywhere; }
.editor-import-hint { display: block; color: var(--muted); font-size: 12px; line-height: 1.8; margin-top: 10px; }
.editor-import-local { display: flex; align-items: center; gap: 5px; color: #647a73; font-size: 12px; line-height: 1.8; margin-top: 4px; }
.editor-import-cancel { margin-top: 9px; font-size: 13px; }
.editor-import-error { display: flex; gap: 8px; align-items: flex-start; color: #9e3b36; background: #fff3f0; border: 1px solid #f0d2cc; padding: 12px; border-radius: 10px; font-size: 13px; line-height: 1.8; margin-bottom: 18px; }
.editor-import-error > .app-icon { margin-top: 3px; }
.editor-import-preview { padding: 16px; margin-bottom: 20px; border: 1px solid #c7d6ec; border-radius: 12px; background: rgba(255,255,255,.65); }
.editor-import-preview-body { display: block; height: 180px; width: 100%; margin: 12px 0; background: rgba(244,247,252,.8); border-radius: 8px; }
.editor-import-preview-text { display: block; padding: 12px; white-space: pre-wrap; font-size: 14px; line-height: 1.8; color: var(--ink); }
.editor-import-actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.editor-import-actions > .button { font-size: 14px; }
@media (max-width: 600px) {
  .editor-import-entry { padding: 14px; margin-bottom: 18px; }
  .editor-import-row { flex-wrap: wrap; gap: 12px; }
  .editor-import-row > .button { width: 100%; justify-content: center; }
  .editor-import-local { align-items: flex-start; }
  .editor-import-local > .app-icon { margin-top: 4px; }
  .editor-import-actions { display: grid; grid-template-columns: 1fr; }
  .editor-import-actions > .button { justify-content: center; }
}
</style>
