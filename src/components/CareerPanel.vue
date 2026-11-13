<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import type { ApplicationStatus, CareerApplication, CareerJob, CareerJobAudience, CareerJobInput, CompanyRecord, Resume, WorkbenchFeature } from '../../shared/types';
import { careerJobAudienceLabels, careerJobIsStale } from '../../shared/career';
import { inputLimits } from '../../shared/limits';
import { careerFileFallbackText } from '../../shared/career-attachment';
import { workbenchFeatureNames, workbenchRequiredPlan } from '../../shared/workbench';
import { api, openCareerMaterialFile, startCareerVideo, type CareerVideoSource } from '../services/api';
import { applicationStatusLabels, applicationTransitions, jobAcceptingPlans, useCareerWorkspace } from '../services/career';
import { useWorkbenchAccess } from '../services/workbenchAccess';
import { createCareerHistory } from '../services/careerAssistantHistory';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';
import CompanyLibrary from './CompanyLibrary.vue';
import CareerAssistant from './CareerAssistant.vue';
import WorkbenchLock from './WorkbenchLock.vue';

const props = defineProps<{ resumes: Resume[]; owner: string }>();
const emit = defineEmits<{ contextChange: []; tailor: [job: CareerJob]; createResume: []; optimizeResume: [input: { resumeId: string; revision: number; targetRole: string }]; tailorAssistantJob: [input: { job: CareerJob; resumeId?: string; revision?: number }]; upgrade: [planId: 'basic' | 'premium'] }>();
const a = useWorkbenchAccess({ autoLoad: false });
const { loading: accessLoading, error: accessError, ready: accessReady, planName } = a;
const c = useCareerWorkspace({ autoLoad: false });
const { state, jobs, materials, applications, favoriteJobIds, loading, busy, error, notice } = c;
type Section = 'overview' | 'jobs' | 'materials' | 'applications';
type Modal = 'job' | 'job-form' | 'plan-new' | 'application' | 'material' | 'confirm' | 'optimize' | 'clear-history';
const sectionFeatures: Record<Exclude<Section, 'overview'>, WorkbenchFeature> = {
  jobs: 'companyJobs', materials: 'studyMaterials', applications: 'applications',
};
const tabs: Array<{ id: Section; title: string }> = [
  { id: 'overview', title: '工作台' }, { id: 'jobs', title: '公司岗位' },
  { id: 'materials', title: '复习资料' }, { id: 'applications', title: '投递计划' },
];
const section = ref<Section>('overview');
const lockedSection = computed(() => section.value === 'overview' ? undefined : !a.canUse(sectionFeatures[section.value]) ? sectionFeatures[section.value] : undefined);
const upgradeFeature = ref<WorkbenchFeature>();
const upgradePlanName = computed(() => upgradeFeature.value && workbenchRequiredPlan[upgradeFeature.value] === 'basic' ? '初级会员' : '高级会员');
const companyView = ref<'companies' | 'jobs'>('jobs');
const companyLibrary = ref<{ reload: () => Promise<void> }>();
const modal = ref<Modal>();
const selectedJobId = ref(''), selectedApplicationId = ref(''), selectedMaterialId = ref('');
const activeJob = computed(() => jobs.value.find(item => item.id === selectedJobId.value));
const activeApplication = computed(() => applications.value.find(item => item.id === selectedApplicationId.value));
const activeMaterial = computed(() => materials.value.find(item => item.id === selectedMaterialId.value));
const openingMaterialFile = ref(false), materialFileNotice = ref('');
const videoSource = shallowRef<CareerVideoSource>(), videoProgress = ref<number | null>(null), videoLoading = ref(false);
let pendingVideo: ReturnType<typeof startCareerVideo> | undefined;
const jobQuery = ref(''), materialQuery = ref(''), major = ref(''), materialMajor = ref('');
const audience = ref<CareerJobAudience | ''>(''), audiences = Object.keys(careerJobAudienceLabels) as CareerJobAudience[];
const audienceOptions = ['全部招聘类型', ...audiences.map(value => careerJobAudienceLabels[value])];
const favoritesOnly = ref(false), applicationFilter = ref<ApplicationStatus | '' | 'active'>('');
const localError = ref('');
const visibleError = computed(() => localError.value || error.value);
const jobMajors = computed(() => ['', ...Array.from(new Set(jobs.value.map(item => item.major))).sort()]);
const materialMajors = computed(() => ['', ...Array.from(new Set(materials.value.map(item => item.major))).sort()]);
const favoriteSet = computed(() => new Set(favoriteJobIds.value));
const filteredJobs = computed(() => {
  const query = jobQuery.value.trim().toLowerCase();
  return jobs.value.filter(item => (!major.value || item.major === major.value)
    && (!audience.value || item.audience === audience.value)
    && (!favoritesOnly.value || favoriteSet.value.has(item.id))
    && (!query || `${item.title} ${item.company} ${item.major} ${item.location} ${item.description}`.toLowerCase().includes(query)));
});
const filteredMaterials = computed(() => {
  const query = materialQuery.value.trim().toLowerCase();
  return materials.value.filter(item => (!materialMajor.value || item.major === materialMajor.value)
    && (!query || `${item.title} ${item.major} ${item.role} ${item.summary}`.toLowerCase().includes(query)));
});
const filteredApplications = computed(() => applications.value.filter(item => !applicationFilter.value
  || (applicationFilter.value === 'active' ? ['applied', 'interview'].includes(item.status) : item.status === applicationFilter.value)));
const allStatuses = Object.keys(applicationStatusLabels) as ApplicationStatus[];
const counts = computed(() => ({
  favorites: jobs.value.filter(item => favoriteSet.value.has(item.id)).length,
  planned: applications.value.filter(item => item.status === 'planned').length,
  active: applications.value.filter(item => ['applied', 'interview'].includes(item.status)).length,
  offer: applications.value.filter(item => item.status === 'offer').length,
}));
const jobForm = reactive({ company: '', title: '', major: '', location: '', description: '', companyOverview: '', sourceUrl: '', deadline: '' });
const savedResumes = ref<Resume[]>([...props.resumes]);
const resumeLoading = ref(false), selectedResumeId = ref(''), resumeReviewed = ref(false);
const chosenResume = computed(() => savedResumes.value.find(item => item.id === selectedResumeId.value));
const resumeLabels = computed(() => savedResumes.value.map(item => `${item.title} · V${item.revision}`));
const resumeIndex = computed(() => Math.max(0, savedResumes.value.findIndex(item => item.id === selectedResumeId.value)));
const note = ref('');
const noteBase = ref(''), noteRevision = ref(0), noteConflict = ref(false);
const noteDirty = computed(() => note.value !== noteBase.value);
const currentSnapshotChanged = computed(() => {
  const item = activeApplication.value;
  if (!item) return false;
  const current = savedResumes.value.find(resume => resume.id === item.resumeSnapshot.id);
  return !current || current.revision !== item.resumeSnapshot.revision;
});
const canRebind = computed(() => !!chosenResume.value && !!activeApplication.value && activeApplication.value.status === 'planned'
  && (chosenResume.value.id !== activeApplication.value.resumeSnapshot.id || chosenResume.value.revision !== activeApplication.value.resumeSnapshot.revision));
type Confirmation = 'status' | 'delete-application' | 'delete-job';
const confirmation = ref<Confirmation>('status'), nextStatus = ref<ApplicationStatus>('applied'), manualSubmitted = ref(false);
let disposed = false, resumeRequest = 0;
watch(() => props.resumes, values => { savedResumes.value = [...values]; }, { deep: true });
watch(() => `${chosenResume.value?.id || ''}:${chosenResume.value?.revision || 0}`, () => { resumeReviewed.value = false; });
watch(activeApplication, item => {
  if (!item || !['application', 'confirm'].includes(modal.value || '')) return;
  if (!noteDirty.value) { note.value = item.note; noteBase.value = item.note; noteRevision.value = item.revision; noteConflict.value = false; }
  else if (item.revision !== noteRevision.value) noteConflict.value = true;
});
watch([activeJob, activeApplication, activeMaterial, modal], () => {
  const kind = modal.value;
  if ((['job', 'plan-new'].includes(kind || '') && !activeJob.value)
    || (kind === 'application' && !activeApplication.value) || (kind === 'material' && !activeMaterial.value)
    || (kind === 'confirm' && !(confirmation.value === 'delete-job' ? activeJob.value : activeApplication.value))) {
    modal.value = undefined; localError.value = '这项内容已更新或移除，请重新读取后选择。';
  }
});
watch(() => a.canUse('companyJobs'), allowed => { if (!allowed && modal.value !== 'optimize' && modal.value !== 'clear-history') modal.value = undefined; });
watch(() => a.canUse('resumeOptimization'), allowed => { if (!allowed && modal.value === 'optimize') modal.value = undefined; });
watch(() => modal.value === 'material' && a.canUse('studyMaterials') ? `${props.owner}/${activeMaterial.value?.id}/${activeMaterial.value?.attachment?.id}` : '', resetMaterialVideo);
onMounted(() => { void refreshWorkspace(); });
onUnmounted(() => { disposed = true; ++resumeRequest; resetMaterialVideo(); c.dispose(); a.dispose(); });
function date(value: string) {
  const local = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  return `${local.getUTCFullYear()}/${String(local.getUTCMonth() + 1).padStart(2, '0')}/${String(local.getUTCDate()).padStart(2, '0')}`;
}
function resetError() { localError.value = ''; error.value = ''; }
function closeModal() {
  if (busy.value) return;
  if (modal.value === 'application' && noteDirty.value) { localError.value = '备注尚未保存，请先保存或明确放弃本次备注修改。'; return; }
  modal.value = undefined; resetError();
}
function requestFeature(feature: WorkbenchFeature): boolean {
  const decision = a.check(feature);
  if (decision.status === 'allowed') return true;
  if (decision.status === 'upgrade') upgradeFeature.value = feature;
  return false;
}
function confirmUpgrade() {
  const feature = upgradeFeature.value;
  if (!feature) return;
  upgradeFeature.value = undefined;
  emit('upgrade', workbenchRequiredPlan[feature]);
}
function selectSection(next: Section): boolean {
  emit('contextChange'); section.value = next; resetError();
  return next === 'overview' || requestFeature(sectionFeatures[next]);
}
function selectCount(kind: 'favorites' | 'planned' | 'active' | 'offer') {
  if (!selectSection(kind === 'favorites' ? 'jobs' : 'applications')) return;
  if (kind === 'favorites') { companyView.value = 'jobs'; favoritesOnly.value = true; }
  else applicationFilter.value = kind;
}
function showJob(item: CareerJob) { if (!requestFeature('companyJobs')) return; selectedJobId.value = item.id; modal.value = 'job'; resetError(); }
function showApplication(item: CareerApplication) {
  if (!requestFeature('applications')) return;
  selectedApplicationId.value = item.id; note.value = item.note; noteBase.value = item.note; noteRevision.value = item.revision; noteConflict.value = false;
  selectedResumeId.value = item.resumeSnapshot.id; resumeReviewed.value = false;
  modal.value = 'application'; resetError(); void refreshResumes();
}
function showMaterial(id: string) { if (!requestFeature('studyMaterials')) return; selectedMaterialId.value = id; materialFileNotice.value = ''; modal.value = 'material'; resetError(); }
function resetMaterialVideo() {
  pendingVideo?.cancel();
  pendingVideo = undefined;
  videoLoading.value = false;
  videoProgress.value = null;
  const previous = videoSource.value;
  videoSource.value = undefined;
  if (previous) void nextTick(() => previous.release());
}
async function openMaterialVideo() {
  const item = activeMaterial.value;
  if (item?.attachment?.format !== 'mp4' || videoLoading.value || !requestFeature('studyMaterials')) return;
  resetError();
  videoLoading.value = true;
  const task = startCareerVideo(item.id, item.attachment, progress => { if (pendingVideo === task) videoProgress.value = progress; });
  pendingVideo = task;
  try {
    const source = await task.ready;
    if (pendingVideo === task) videoSource.value = source;
    else source.release();
  } catch (error) {
    if (pendingVideo === task) localError.value = error instanceof Error ? error.message : '视频暂时无法打开。';
  } finally {
    if (pendingVideo === task) {
      pendingVideo = undefined;
      videoLoading.value = false;
      videoProgress.value = null;
    }
  }
}
function materialVideoError() {
  resetMaterialVideo();
  localError.value = '视频无法播放，请重新打开资料或检查网络。';
}
async function openMaterialFile() {
  const item = activeMaterial.value;
  if (!item?.attachment || openingMaterialFile.value || !requestFeature('studyMaterials')) return;
  const stillCurrent = () => !disposed && modal.value === 'material' && activeMaterial.value?.id === item.id;
  openingMaterialFile.value = true;
  materialFileNotice.value = '';
  resetError();
  try {
    const result = await openCareerMaterialFile(item.id, item.attachment);
    if (result === 'download-started' && stillCurrent()) materialFileNotice.value = '已开始下载，可在浏览器下载列表中查看。';
  } catch (error) {
    if (stillCurrent()) localError.value = error instanceof Error ? error.message : '资料文件暂时无法打开。';
  } finally {
    openingMaterialFile.value = false;
  }
}
function showJobForm() { if (!requestFeature('companyJobs')) return; companyView.value = 'jobs'; modal.value = 'job-form'; resetError(); }
async function refreshWorkspace() {
  if (busy.value) return;
  if (modal.value === 'application' && noteDirty.value) { localError.value = '请先保存或放弃未保存的备注，再重新读取工作台。'; return; }
  modal.value = undefined; upgradeFeature.value = undefined; notice.value = ''; resetError();
  if (await a.load() && !disposed) await c.load();
}
defineExpose({ refresh: refreshWorkspace });
function addCompanyJob(company: CompanyRecord) {
  if (!requestFeature('companyJobs')) return;
  Object.assign(jobForm, { company: company.name, title: '', major: '', location: '', description: '', companyOverview: '', sourceUrl: '', deadline: '' });
  section.value = 'jobs'; showJobForm();
  notice.value = '已带入企业名称，请核对最新公告后填写具体岗位、地区、专业和要求。';
}
function clearJobFilters() { jobQuery.value = ''; major.value = ''; audience.value = ''; favoritesOnly.value = false; }
function clearMaterialFilters() { materialQuery.value = ''; materialMajor.value = ''; }
function pickMajor(event: { detail: { value: string | number } }) { major.value = jobMajors.value[Number(event.detail.value)] || ''; }
function pickAudience(event: { detail: { value: string | number } }) { audience.value = audiences[Number(event.detail.value) - 1] || ''; }
function pickMaterialMajor(event: { detail: { value: string | number } }) { materialMajor.value = materialMajors.value[Number(event.detail.value)] || ''; }
function pickResume(event: { detail: { value: string | number } }) { selectedResumeId.value = savedResumes.value[Number(event.detail.value)]?.id || ''; }
async function refreshResumes() {
  const requestId = ++resumeRequest;
  resumeLoading.value = true; localError.value = '';
  try {
    const result = await api.resumes();
    if (disposed || requestId !== resumeRequest) return;
    savedResumes.value = result;
    if (!result.some(item => item.id === selectedResumeId.value)) selectedResumeId.value = result[0]?.id || '';
  } catch (cause) { if (!disposed && requestId === resumeRequest) localError.value = cause instanceof Error ? cause.message : '无法读取最新简历，请重试。'; }
  finally { if (!disposed && requestId === resumeRequest) resumeLoading.value = false; }
}
async function saveJob() {
  if (!requestFeature('companyJobs')) return;
  resetError();
  if (![jobForm.company, jobForm.title, jobForm.major, jobForm.location, jobForm.description].every(value => value.trim())) {
    localError.value = '请填写公司、岗位、专业、地点和岗位描述。'; return;
  }
  const input: CareerJobInput = {
    company: jobForm.company.trim(), title: jobForm.title.trim(), major: jobForm.major.trim(), location: jobForm.location.trim(),
    description: jobForm.description.trim(), ...(jobForm.companyOverview.trim() ? { companyOverview: jobForm.companyOverview.trim() } : {}),
    ...(jobForm.sourceUrl.trim() ? { sourceUrl: jobForm.sourceUrl.trim() } : {}), ...(jobForm.deadline.trim() ? { deadline: jobForm.deadline.trim() } : {}),
  };
  const result = await c.createJob(input);
  if (!result || disposed) return;
  Object.keys(jobForm).forEach(key => { jobForm[key as keyof typeof jobForm] = ''; });
  section.value = 'jobs'; showJob(result);
}
function copyToPersonalJob(item: CareerJob) {
  Object.assign(jobForm, { company: item.company, title: item.title, major: item.major, location: item.location,
    description: item.description, sourceUrl: item.sourceUrl ?? '', companyOverview: item.companyOverview, deadline: '' });
  showJobForm();
}
function tailorJob(item: CareerJob) { if (!requestFeature('resumeOptimization')) return; closeModal(); emit('tailor', item); }
function createResume() { closeModal(); emit('createResume'); }
function beginOptimize() {
  if (!requestFeature('resumeOptimization')) return;
  selectedResumeId.value = savedResumes.value[0]?.id || ''; modal.value = 'optimize'; resetError(); void refreshResumes();
}
function optimizeResume() {
  if (!requestFeature('resumeOptimization') || resumeLoading.value || !chosenResume.value) return;
  const selected = chosenResume.value;
  modal.value = undefined; emit('contextChange');
  emit('optimizeResume', { resumeId: selected.id, revision: selected.revision, targetRole: selected.targetRole });
}
function optimizeAssistant(input: { resumeId: string; revision: number; targetRole: string }) {
  if (requestFeature('resumeOptimization')) emit('optimizeResume', input);
}
function tailorAssistant(input: { job: CareerJob; resumeId?: string; revision?: number }) {
  if (requestFeature('careerAssistant')) emit('tailorAssistantJob', input);
}
function favoriteJob(id: string, wanted: boolean) { if (requestFeature('companyJobs')) void c.favorite(id, wanted); }
function clearHistory() {
  const history = createCareerHistory(props.owner), items = history.list();
  history.clear(); modal.value = undefined;
  if (history.list().length || items.some(item => history.load(item.id))) localError.value = '部分本机历史对话未能清理，请重试。';
  else notice.value = '当前账号在本机保存的求职助手历史对话已清理。';
}
function beginPlan() {
  if (!requestFeature('applications')) return;
  if (!activeJob.value || !jobAcceptingPlans(activeJob.value)) return;
  selectedResumeId.value = savedResumes.value[0]?.id || ''; resumeReviewed.value = false;
  modal.value = 'plan-new'; resetError(); void refreshResumes();
}
async function savePlan() {
  if (!requestFeature('applications')) return;
  resetError();
  const target = activeJob.value, selected = chosenResume.value;
  if (!target || !selected || !resumeReviewed.value || resumeLoading.value) { localError.value = '请先选择并核对已保存的简历版本。'; return; }
  const result = await c.createApplication({ jobId: target.id, resumeId: selected.id, resumeRevision: selected.revision });
  if (result && !disposed) { section.value = 'applications'; showApplication(result); }
}
async function saveNote() {
  if (!requestFeature('applications')) return;
  if (!activeApplication.value) return;
  resetError();
  const result = await c.updateApplication(activeApplication.value.id, { revision: noteRevision.value, note: note.value });
  if (result && !disposed) { note.value = result.note; noteBase.value = result.note; noteRevision.value = result.revision; noteConflict.value = false; }
}
function discardNote() {
  const item = activeApplication.value;
  if (!item || busy.value) return;
  note.value = item.note; noteBase.value = item.note; noteRevision.value = item.revision; noteConflict.value = false; resetError();
}
function copyNote() {
  uni.setClipboardData({ data: note.value, success: () => { if (!disposed) notice.value = '未保存备注已复制。'; }, fail: () => { if (!disposed) localError.value = '无法复制，请先自行保留备注内容。'; } });
}
async function rebindResume() {
  if (!requestFeature('applications')) return;
  const item = activeApplication.value, selected = chosenResume.value;
  if (!item || !selected || !resumeReviewed.value || !canRebind.value || resumeLoading.value) return;
  resetError();
  if (noteDirty.value) { localError.value = '请先保存或放弃未保存的备注，再更换简历版本。'; return; }
  const result = await c.updateApplication(item.id, { revision: item.revision, resumeId: selected.id, resumeRevision: selected.revision });
  if (result && !disposed) resumeReviewed.value = false;
}
function askStatus(value: ApplicationStatus) {
  if (!requestFeature('applications')) return;
  if (!activeApplication.value || !applicationTransitions[activeApplication.value.status].includes(value)) return;
  if (noteDirty.value) { localError.value = '请先保存或放弃未保存的备注，再更新进度。'; return; }
  confirmation.value = 'status'; nextStatus.value = value; manualSubmitted.value = false; modal.value = 'confirm'; resetError();
}
function askDeleteApplication() { confirmation.value = 'delete-application'; modal.value = 'confirm'; resetError(); }
function askDeleteJob() { confirmation.value = 'delete-job'; modal.value = 'confirm'; resetError(); }
function cancelConfirmation() { if (!busy.value) { modal.value = confirmation.value === 'delete-job' ? 'job' : 'application'; resetError(); } }
async function confirmAction() {
  if (!requestFeature(confirmation.value === 'delete-job' ? 'companyJobs' : 'applications')) return;
  resetError();
  if (confirmation.value === 'delete-job' && activeJob.value) {
    if (await c.removeJob(activeJob.value.id) && !disposed) modal.value = undefined;
  } else if (confirmation.value === 'delete-application' && activeApplication.value) {
    if (await c.removeApplication(activeApplication.value.id, activeApplication.value.revision) && !disposed) modal.value = undefined;
  } else if (confirmation.value === 'status' && activeApplication.value) {
    if (nextStatus.value === 'applied' && !manualSubmitted.value) { localError.value = '请确认你已自行完成真实投递。'; return; }
    const result = await c.updateApplication(activeApplication.value.id, {
      revision: activeApplication.value.revision, status: nextStatus.value,
      ...(nextStatus.value === 'applied' ? { confirmedManualSubmission: true } : {}),
    });
    if (result && !disposed) modal.value = 'application';
  }
}
function copySource(value?: string) {
  if (!value) return;
  uni.setClipboardData({ data: value, success: () => { if (!disposed) notice.value = '来源链接已复制。'; }, fail: () => { if (!disposed) localError.value = '未能复制链接，请稍后重试。'; } });
}
</script>

<template>
  <view class="career-panel">
    <view class="career-heading">
      <view><text class="career-title">求职工作台</text><text v-if="accessReady" class="career-identity">{{ planName }}</text></view>
      <button class="button secondary career-refresh" :disabled="accessLoading || (accessReady && loading) || busy" @click="refreshWorkspace" role="button" tabindex="0"><AppIcon name="undo" :size="15" />重新读取</button>
    </view>
    <view v-if="accessReady && visibleError && !modal" class="career-alert" role="alert"><text>{{ visibleError }}</text><button class="text-button" :disabled="busy || loading" @click="refreshWorkspace" role="button" tabindex="0">重新读取</button></view>
    <view v-if="accessReady && notice" class="career-notice" role="status" aria-live="polite"><AppIcon name="check" :size="16" /><text>{{ notice }}</text><button class="icon-button" aria-label="关闭提示" @click="notice = ''" role="button" tabindex="0"><AppIcon name="close" :size="14" /></button></view>
    <view v-if="accessLoading" class="glass-panel career-empty" role="status"><view class="spinner" /><text>正在读取工作台权限…</text></view>
    <view v-else-if="!accessReady" class="glass-panel career-empty" role="alert"><AppIcon name="info" :size="28" /><text>工作台权限暂时无法读取</text><text class="career-caption">{{ accessError }}</text><button class="button secondary" @click="refreshWorkspace" role="button" tabindex="0">重新读取</button></view>
    <view v-else-if="loading && !state" class="glass-panel career-empty" role="status"><view class="spinner" /><text>正在读取你的求职工作台…</text></view>
    <view v-else-if="!state" class="glass-panel career-empty"><AppIcon name="briefcase" :size="28" /><text>工作台暂时无法读取</text><button class="button secondary" @click="refreshWorkspace" role="button" tabindex="0">重试</button></view>
    <template v-else>
      <view class="career-tabs-wrap"><view class="career-tabs" role="tablist" aria-label="求职工作台功能" aria-orientation="horizontal"><button v-for="item in tabs" :id="`career-tab-${item.id}`" :key="item.id" :class="{ active: section === item.id, locked: item.id !== 'overview' && !a.canUse(sectionFeatures[item.id]) }" :aria-selected="section === item.id" :aria-label="item.id !== 'overview' && !a.canUse(sectionFeatures[item.id]) ? `${item.title}，高级会员解锁` : item.title" role="tab" @click="selectSection(item.id)" tabindex="0"><AppIcon v-if="item.id !== 'overview' && !a.canUse(sectionFeatures[item.id])" name="lock" :size="12" />{{ item.title }}</button></view></view>

      <WorkbenchLock v-if="lockedSection" :feature="lockedSection" @unlock="requestFeature(lockedSection)" />
      <template v-else-if="section === 'overview'">
        <view class="career-shortcuts">
          <button class="glass-panel career-shortcut" @click="createResume" role="button" tabindex="0"><view class="career-shortcut-icon"><AppIcon name="plus" :size="20" /></view><view><text>创建简历</text><text class="career-caption">填写并保存真实经历</text></view><AppIcon name="arrow" :size="16" /></button>
          <button class="glass-panel career-shortcut" :class="{ locked: !a.canUse('resumeOptimization') }" @click="beginOptimize" role="button" tabindex="0"><view class="career-shortcut-icon"><AppIcon :name="a.canUse('resumeOptimization') ? 'file' : 'lock'" :size="20" /></view><view><text>简历优化<text v-if="!a.canUse('resumeOptimization')" class="career-shortcut-tier">初级会员</text></text><text class="career-caption">{{ a.canUse('resumeOptimization') ? '选择已保存版本，进入诊断与审核' : '升级后解锁诊断与审核入口' }}</text></view><AppIcon name="arrow" :size="16" /></button>
        </view>
        <view class="career-counts">
          <button class="glass-panel career-count" :class="{ locked: !a.canUse('companyJobs') }" @click="selectCount('favorites')" role="button" tabindex="0"><text>{{ a.canUse('companyJobs') ? counts.favorites : '高级会员解锁' }}</text><text>已收藏岗位</text><AppIcon :name="a.canUse('companyJobs') ? 'briefcase' : 'lock'" :size="20" /></button>
          <button class="glass-panel career-count" :class="{ locked: !a.canUse('applications') }" @click="selectCount('planned')" role="button" tabindex="0"><text>{{ a.canUse('applications') ? counts.planned : '高级会员解锁' }}</text><text>待投递计划</text><AppIcon :name="a.canUse('applications') ? 'file' : 'lock'" :size="20" /></button>
          <button class="glass-panel career-count" :class="{ locked: !a.canUse('applications') }" @click="selectCount('active')" role="button" tabindex="0"><text>{{ a.canUse('applications') ? counts.active : '高级会员解锁' }}</text><text>投递与面试中</text><AppIcon :name="a.canUse('applications') ? 'clock' : 'lock'" :size="20" /></button>
          <button class="glass-panel career-count" :class="{ locked: !a.canUse('applications') }" @click="selectCount('offer')" role="button" tabindex="0"><text>{{ a.canUse('applications') ? counts.offer : '高级会员解锁' }}</text><text>收到录用</text><AppIcon :name="a.canUse('applications') ? 'check' : 'lock'" :size="20" /></button>
        </view>
        <CareerAssistant v-if="a.canUse('careerAssistant')" :resumes="savedResumes" :owner="owner" @context-change="emit('contextChange')" @add-company="addCompanyJob" @tailor-assistant-job="tailorAssistant" @create-resume="createResume" @optimize="optimizeAssistant" />
        <template v-else><WorkbenchLock feature="careerAssistant" @unlock="requestFeature('careerAssistant')" /><view class="career-locked-footer"><text class="career-caption">按资料和文本规则查询企业与岗位方向。</text><button class="text-button" @click="modal = 'clear-history'" role="button" tabindex="0">清理本机历史对话</button></view></template>
      </template>

      <template v-else-if="section === 'jobs'">
        <view class="career-status-filters" role="tablist" aria-label="企业与岗位视图"><button :class="{ active: companyView === 'companies' }" :aria-selected="companyView === 'companies'" @click="companyView = 'companies'" role="tab" tabindex="0">企业资料</button><button :class="{ active: companyView === 'jobs' }" :aria-selected="companyView === 'jobs'" @click="companyView = 'jobs'" role="tab" tabindex="0">目标岗位</button></view>
        <CompanyLibrary v-if="companyView === 'companies'" ref="companyLibrary" @add-job="addCompanyJob" />
        <template v-else>
        <view class="career-section-heading"><view><text class="career-section-title">公司岗位</text></view><button class="button primary" :disabled="busy" @click="showJobForm" role="button" tabindex="0"><AppIcon name="plus" :size="16" />添加目标岗位</button></view>
        <view class="glass-panel career-filters"><view class="career-search"><AppIcon name="search" :size="17" /><input v-model="jobQuery" placeholder="搜索公司、岗位或地点" :maxlength="100" aria-label="搜索岗位" /></view><picker :range="jobMajors.map(value => value || '全部专业')" :value="Math.max(0, jobMajors.indexOf(major))" @change="pickMajor"><view class="career-picker">{{ major || '全部专业' }}<AppIcon name="chevron" :size="13" /></view></picker><picker :range="audienceOptions" :value="audiences.findIndex(value => value === audience) + 1" @change="pickAudience"><view class="career-picker">{{ audience ? careerJobAudienceLabels[audience] : '全部招聘类型' }}<AppIcon name="chevron" :size="13" /></view></picker><button class="career-filter-toggle" :class="{ active: favoritesOnly }" :aria-pressed="favoritesOnly" @click="favoritesOnly = !favoritesOnly" role="button" tabindex="0">只看收藏</button></view>
        <view v-if="!filteredJobs.length" class="glass-panel career-empty"><AppIcon name="briefcase" :size="30" /><text>{{ jobs.length ? '没有符合筛选条件的岗位' : '还没有目标岗位' }}</text><text class="career-caption">{{ jobs.length ? '试试其他关键词，或清除当前筛选。' : '添加你已找到的岗位。' }}</text><button class="button secondary" @click="jobs.length ? clearJobFilters() : showJobForm()" role="button" tabindex="0">{{ jobs.length ? '清除筛选' : '添加目标岗位' }}</button></view>
        <view v-else class="career-job-grid"><view v-for="item in filteredJobs" :key="item.id" class="glass-panel career-job-card"><button class="career-job-content" @click="showJob(item)" role="button" tabindex="0"><view class="career-row"><text class="career-job-company">{{ item.company }}</text><text class="career-tag" :class="{ closed: !jobAcceptingPlans(item) }">{{ careerJobIsStale(item) && item.availability === 'open' ? '来源待复核' : jobAcceptingPlans(item) ? (item.origin === 'catalog' ? '以官网为准' : '可准备') : '已截止 / 关闭' }}</text></view><text class="career-job-title">{{ item.title }}</text><view class="career-tags"><text>{{ item.major }}</text><text>{{ item.location }}</text><text>{{ item.audience ? careerJobAudienceLabels[item.audience] : item.origin === 'personal' ? '个人添加' : '资料库' }}</text></view><text class="career-excerpt">{{ item.description.slice(0, 130) }}</text></button><view class="career-card-footer"><text>{{ item.deadline ? `截止 ${item.deadline}` : `${item.checkedAt ? '核对' : '更新'} ${date(item.checkedAt || item.updatedAt)}` }}</text><button class="text-button" :disabled="busy" :aria-pressed="favoriteSet.has(item.id)" @click="favoriteJob(item.id, !favoriteSet.has(item.id))" role="button" tabindex="0">{{ favoriteSet.has(item.id) ? '取消收藏' : '收藏岗位' }}<AppIcon :name="favoriteSet.has(item.id) ? 'check' : 'plus'" :size="14" /></button></view></view></view>
        </template>
      </template>

      <template v-else-if="section === 'materials'">
        <view class="career-section-heading"><view><text class="career-section-title">复习资料</text></view><text class="career-tag">{{ materials.length }} 份资料</text></view>
        <view class="glass-panel career-filters"><view class="career-search"><AppIcon name="search" :size="17" /><input v-model="materialQuery" placeholder="搜索资料、岗位或主题" :maxlength="100" aria-label="搜索复习资料" /></view><picker :range="materialMajors.map(value => value || '全部专业')" :value="Math.max(0, materialMajors.indexOf(materialMajor))" @change="pickMaterialMajor"><view class="career-picker">{{ materialMajor || '全部专业' }}<AppIcon name="chevron" :size="13" /></view></picker></view>
        <view v-if="!filteredMaterials.length" class="glass-panel career-empty"><AppIcon name="book" :size="30" /><text>{{ materials.length ? '没有找到相关资料' : state.catalogState === 'unavailable' ? '资料目录暂时无法读取' : '复习资料待补充' }}</text><text class="career-caption">{{ materials.length ? '可更换关键词或专业。' : state.catalogMessage }}</text><button v-if="materials.length" class="button secondary" @click="clearMaterialFilters" role="button" tabindex="0">清除筛选</button><button v-else-if="state.catalogState === 'unavailable'" class="button secondary" :disabled="loading || busy" @click="refreshWorkspace" role="button" tabindex="0">重新读取</button></view>
        <view v-else class="career-material-list"><button v-for="item in filteredMaterials" :key="item.id" class="glass-panel career-material" @click="showMaterial(item.id)" role="button" tabindex="0"><view class="career-material-icon"><AppIcon name="book" :size="24" /></view><view><text class="career-job-title">{{ item.title }}</text><text class="career-caption">{{ item.major }} · {{ item.role }}</text><text class="career-excerpt">{{ item.summary }}</text><text class="career-source">{{ item.sourceLabel }} · {{ date(item.updatedAt) }}</text></view><AppIcon name="chevron" :size="17" /></button></view>
      </template>

      <template v-else>
        <view class="career-section-heading"><view><text class="career-section-title">我的投递计划</text><text class="career-caption">每条计划保留简历快照，所有进度均由你手动确认。</text></view><button class="text-button" @click="selectSection('jobs')" role="button" tabindex="0">选择岗位<AppIcon name="arrow" :size="15" /></button></view>
        <view class="career-status-filters"><button :class="{ active: applicationFilter === '' }" @click="applicationFilter = ''" role="button" tabindex="0">全部 {{ applications.length }}</button><button :class="{ active: applicationFilter === 'active' }" @click="applicationFilter = 'active'" role="button" tabindex="0">投递与面试中</button><button v-for="value in allStatuses" :key="value" :class="{ active: applicationFilter === value }" @click="applicationFilter = value" role="button" tabindex="0">{{ applicationStatusLabels[value] }}</button></view>
        <view v-if="!filteredApplications.length" class="glass-panel career-empty"><AppIcon name="file" :size="30" /><text>{{ applications.length ? '这个阶段还没有记录' : '从一份投递计划开始' }}</text><text class="career-caption">选好岗位，核对要使用的简历版本，再保存计划。</text><button class="button secondary" @click="selectSection('jobs')" role="button" tabindex="0">去选择岗位</button></view>
        <view v-else class="career-application-list"><button v-for="item in filteredApplications" :key="item.id" class="glass-panel career-application" @click="showApplication(item)" role="button" tabindex="0"><view class="career-application-main"><text class="career-job-company">{{ item.jobSnapshot.company }}</text><text class="career-job-title">{{ item.jobSnapshot.title }}</text><text class="career-caption">{{ item.resumeSnapshot.title }} · V{{ item.resumeSnapshot.revision }} · {{ date(item.updatedAt) }}</text></view><view class="career-application-status"><text class="career-tag" :class="item.status">{{ applicationStatusLabels[item.status] }}</text><text>手动记录<AppIcon name="chevron" :size="12" /></text></view></button></view>
      </template>
    </template>

    <AppModal v-if="upgradeFeature && accessReady" title="升级会员解锁" @close="upgradeFeature = undefined">
      <view class="career-upgrade-icon"><AppIcon name="lock" :size="24" /></view>
      <text class="career-prose">“{{ workbenchFeatureNames[upgradeFeature] }}”需升级至{{ upgradePlanName }}后使用。</text>
      <view class="career-modal-footer"><button class="button secondary" @click="upgradeFeature = undefined" role="button" tabindex="0">暂不升级</button><button class="button primary" @click="confirmUpgrade" role="button" tabindex="0">查看会员<AppIcon name="arrow" :size="15" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'optimize' && a.canUse('resumeOptimization')" title="选择要优化的简历" subtitle="读取已保存版本，进入诊断和逐项审核" @close="closeModal">
      <text class="career-caption">优化建议需要对照原文审核，确认后才会应用到简历。</text>
      <view class="career-resume-toolbar"><text class="field-label">已保存的简历</text><button class="text-button" :disabled="resumeLoading" @click="refreshResumes" role="button" tabindex="0">{{ resumeLoading ? '读取中…' : '读取最新版本' }}</button></view>
      <picker v-if="savedResumes.length" :range="resumeLabels" :value="resumeIndex" :disabled="resumeLoading" @change="pickResume"><view class="career-picker career-resume-picker">{{ chosenResume ? `${chosenResume.title} · V${chosenResume.revision}` : '请选择简历' }}<AppIcon name="chevron" :size="15" /></view></picker>
      <view v-else class="career-inline-empty"><text>先保存一份自己的真实简历。</text><button class="button secondary" @click="createResume" role="button" tabindex="0">创建简历</button></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="button primary" :disabled="resumeLoading || !chosenResume || !!visibleError" @click="optimizeResume" role="button" tabindex="0">进入诊断与审核<AppIcon name="arrow" :size="15" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'clear-history' && accessReady" title="清理本机历史对话？" @close="closeModal">
      <text class="career-prose">将删除当前账号在这台设备上保存的求职助手历史对话，清理后无法恢复。</text>
      <view class="career-modal-footer"><button class="button secondary" @click="closeModal" role="button" tabindex="0">取消</button><button class="button danger" @click="clearHistory" role="button" tabindex="0">确认清理</button></view>
    </AppModal>

    <AppModal v-if="modal === 'job' && activeJob && a.canUse('companyJobs')" :title="activeJob.title" :subtitle="`${activeJob.company} · ${activeJob.major} · ${activeJob.location}`" wide @close="closeModal">
      <view class="career-detail-meta"><text class="career-tag">{{ activeJob.origin === 'personal' ? '个人添加的目标岗位' : '公司岗位资料库' }}</text><text class="career-caption">{{ activeJob.deadline ? `截止日期 ${activeJob.deadline}（北京时间）` : '未填写截止日期' }}</text></view>
      <view v-if="activeJob.companyOverview" class="career-detail-section"><text class="career-section-title">公司信息</text><text class="career-prose">{{ activeJob.companyOverview }}</text></view>
      <view class="career-detail-section"><text class="career-section-title">岗位描述</text><text class="career-prose">{{ activeJob.description }}</text></view>
      <view class="career-source-box"><text>来源：{{ activeJob.sourceLabel }} · {{ activeJob.checkedAt ? '核对' : '更新' }} {{ date(activeJob.checkedAt || activeJob.updatedAt) }}</text><button v-if="activeJob.sourceUrl" class="text-button" @click="copySource(activeJob.sourceUrl)" role="button" tabindex="0">复制来源链接<AppIcon name="copy" :size="14" /></button></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view v-if="!jobAcceptingPlans(activeJob)" class="career-preview"><AppIcon name="info" :size="16" /><text>{{ careerJobIsStale(activeJob) ? '来源超过 30 天未复核。请先查官网，确认后可添加为个人目标岗位。' : '该岗位已关闭或超过截止日期，不能新建投递计划。' }}</text></view>
      <view class="career-detail-actions"><button class="button secondary" :disabled="busy" @click="favoriteJob(activeJob.id, !favoriteSet.has(activeJob.id))" role="button" tabindex="0">{{ favoriteSet.has(activeJob.id) ? '取消收藏' : '收藏岗位' }}</button><button class="button secondary" :disabled="busy" @click="tailorJob(activeJob)" role="button" tabindex="0">对照岗位优化</button><button class="button primary" :disabled="busy || !jobAcceptingPlans(activeJob)" @click="beginPlan" role="button" tabindex="0">建立投递计划<AppIcon name="arrow" :size="16" /></button><button v-if="careerJobIsStale(activeJob)" class="button secondary" :disabled="busy" @click="copyToPersonalJob(activeJob)" role="button" tabindex="0">录入已核对的岗位</button></view>
      <view v-if="activeJob.origin === 'personal'" class="career-delete-line"><text>删除岗位前，请先删除关联投递记录。</text><button class="text-button career-danger" :disabled="busy" @click="askDeleteJob" role="button" tabindex="0">删除个人岗位</button></view>
    </AppModal>

    <AppModal v-if="modal === 'job-form' && a.canUse('companyJobs')" title="添加目标岗位" subtitle="仅本人账号可见" wide @close="closeModal">
      <view class="career-form-grid"><view><text class="field-label">公司名称</text><input v-model="jobForm.company" class="text-input" placeholder="填写公司全称" :maxlength="100" :disabled="busy" aria-label="公司名称" /></view><view><text class="field-label">岗位名称</text><input v-model="jobForm.title" class="text-input" placeholder="填写招聘岗位" :maxlength="100" :disabled="busy" aria-label="岗位名称" /></view><view><text class="field-label">专业方向</text><input v-model="jobForm.major" class="text-input" placeholder="例如：计算机、会计、机械" :maxlength="60" :disabled="busy" aria-label="专业方向" /></view><view><text class="field-label">工作地点</text><input v-model="jobForm.location" class="text-input" placeholder="城市或远程要求" :maxlength="100" :disabled="busy" aria-label="工作地点" /></view></view>
      <view class="career-form-field"><text class="field-label">岗位描述与要求</text><textarea v-model="jobForm.description" class="large-textarea career-description-input" placeholder="粘贴实际职责、任职要求等内容。" :maxlength="inputLimits.jobDescription" :disabled="busy" aria-label="岗位描述与要求" /></view>
      <view class="career-form-field"><text class="field-label">公司介绍（选填）</text><textarea v-model="jobForm.companyOverview" class="large-textarea career-note-input" placeholder="填写公司介绍" :maxlength="5000" :disabled="busy" aria-label="公司介绍" /></view>
      <view class="career-form-grid"><view><text class="field-label">来源链接（选填）</text><input v-model="jobForm.sourceUrl" class="text-input" placeholder="https://…" :maxlength="2000" :disabled="busy" aria-label="岗位来源链接" /></view><view><text class="field-label">截止日期（选填）</text><input v-model="jobForm.deadline" class="text-input" placeholder="YYYY-MM-DD" :maxlength="10" :disabled="busy" aria-label="岗位截止日期" /></view></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="button primary" :disabled="busy" @click="saveJob" role="button" tabindex="0">{{ busy ? '正在保存…' : '保存目标岗位' }}<AppIcon name="check" :size="16" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'plan-new' && activeJob && a.canUse('applications')" title="审核这次投递计划" :subtitle="`${activeJob.company} · ${activeJob.title}`" wide @close="closeModal">
      <view class="career-preview"><AppIcon name="shield" :size="17" /><text>仅保存计划和简历版本，不会代为投递。</text></view>
      <view class="career-resume-toolbar"><text class="field-label">选择已保存的简历</text><button class="text-button" :disabled="resumeLoading || busy" @click="refreshResumes" role="button" tabindex="0">{{ resumeLoading ? '读取中…' : '读取最新版本' }}</button></view>
      <picker v-if="savedResumes.length" :range="resumeLabels" :value="resumeIndex" :disabled="busy || resumeLoading" @change="pickResume"><view class="career-picker career-resume-picker">{{ chosenResume ? `${chosenResume.title} · V${chosenResume.revision}` : '请选择简历' }}<AppIcon name="chevron" :size="15" /></view></picker>
      <view v-else class="career-inline-empty"><text>先保存一份自己的真实简历，再建立计划。</text><button class="button secondary" :disabled="busy" @click="createResume" role="button" tabindex="0">创建简历</button></view>
      <template v-if="chosenResume"><text class="career-caption career-snapshot-caption">以下正文将作为本次计划的固定快照</text><text class="career-prose career-resume-snapshot">{{ chosenResume.text }}</text><button class="career-checkbox" role="checkbox" :aria-checked="resumeReviewed" :disabled="busy || resumeLoading" @click="resumeReviewed = !resumeReviewed" tabindex="0"><view class="career-check-square" :class="{ checked: resumeReviewed }"><AppIcon v-if="resumeReviewed" name="check" :size="13" /></view><text>我已核对这份 V{{ chosenResume.revision }} 简历的正文，确认使用真实内容建立计划。</text></button></template>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="text-button" :disabled="busy" @click="modal = 'job'" role="button" tabindex="0">返回岗位</button><button class="button primary" :disabled="busy || resumeLoading || !chosenResume || !resumeReviewed" @click="savePlan" role="button" tabindex="0">{{ busy ? '正在保存…' : '保存投递计划' }}<AppIcon name="check" :size="16" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'application' && activeApplication && a.canUse('applications')" :title="activeApplication.jobSnapshot.title" :subtitle="`${activeApplication.jobSnapshot.company} · 投递计划`" wide @close="closeModal">
      <view class="career-detail-meta"><text class="career-tag" :class="activeApplication.status">{{ applicationStatusLabels[activeApplication.status] }}</text><text class="career-caption">手动记录 · 更新 {{ date(activeApplication.updatedAt) }}</text></view>
      <view class="career-detail-section"><view class="career-row"><text class="career-section-title">本次使用的简历快照</text><text class="career-caption">{{ activeApplication.resumeSnapshot.title }} · V{{ activeApplication.resumeSnapshot.revision }}</text></view><text class="career-prose career-resume-snapshot">{{ activeApplication.resumeSnapshot.text }}</text></view>
      <view v-if="activeApplication.status === 'planned'" class="career-rebind">
        <text v-if="currentSnapshotChanged" class="career-caption career-warning">原简历已更新或不可用。记录已投递前，请选择最新保存的版本并重新核对。</text>
        <view class="career-resume-toolbar"><text class="field-label">更换计划中的简历版本</text><button class="text-button" :disabled="resumeLoading || busy" @click="refreshResumes" role="button" tabindex="0">{{ resumeLoading ? '读取中…' : '读取最新版本' }}</button></view>
        <picker v-if="savedResumes.length" :range="resumeLabels" :value="resumeIndex" :disabled="busy || resumeLoading" @change="pickResume"><view class="career-picker career-resume-picker">{{ chosenResume ? `${chosenResume.title} · V${chosenResume.revision}` : '请选择简历' }}<AppIcon name="chevron" :size="14" /></view></picker>
        <view v-else class="career-inline-empty"><text>当前没有可用简历，请先创建。</text><button class="button secondary" :disabled="busy" @click="createResume" role="button" tabindex="0">创建简历</button></view>
        <template v-if="canRebind && chosenResume"><text class="career-caption career-snapshot-caption">核对准备替换的正文</text><text class="career-prose career-resume-snapshot">{{ chosenResume.text }}</text><button class="career-checkbox" role="checkbox" :aria-checked="resumeReviewed" :disabled="busy || resumeLoading" @click="resumeReviewed = !resumeReviewed" tabindex="0"><view class="career-check-square" :class="{ checked: resumeReviewed }"><AppIcon v-if="resumeReviewed" name="check" :size="13" /></view><text>我已核对新的简历版本，确认用于本计划。</text></button><button class="button secondary" :disabled="busy || resumeLoading || !resumeReviewed" @click="rebindResume" role="button" tabindex="0">保存简历版本</button></template>
      </view>
      <view class="career-detail-section"><text class="field-label">跟进备注</text><textarea v-model="note" class="large-textarea career-note-input" placeholder="记录联系时间、面试准备和下一步安排。" :maxlength="2000" :disabled="busy" aria-label="投递跟进备注" /><view class="career-note-footer"><text>{{ note.length }} / 2000</text><button class="text-button" :disabled="busy || !noteDirty || noteConflict" @click="saveNote" role="button" tabindex="0">保存备注<AppIcon name="check" :size="14" /></button></view><view v-if="noteConflict" class="career-alert" role="alert"><text>这条记录已在其他操作中更新。你的备注草稿已保留，请先复制，再放弃本次修改以读取最新内容。</text></view><view v-if="noteDirty" class="career-note-draft-actions"><button class="text-button" :disabled="busy" @click="copyNote" role="button" tabindex="0">复制未保存备注</button><button class="text-button career-danger" :disabled="busy" @click="discardNote" role="button" tabindex="0">放弃本次备注修改</button></view></view>
      <view class="career-detail-section"><text class="career-section-title">手动更新进度</text><view v-if="applicationTransitions[activeApplication.status].length" class="career-status-actions"><button v-for="value in applicationTransitions[activeApplication.status]" :key="value" class="button secondary" :disabled="busy || (value === 'applied' && (currentSnapshotChanged || resumeLoading))" @click="askStatus(value)" role="button" tabindex="0">{{ value === 'applied' ? '我已自行投递' : `记录为${applicationStatusLabels[value]}` }}</button></view><text v-else class="career-caption">该记录已结束，可保留复盘备注或删除。</text></view>
      <view class="career-history"><text class="career-section-title">进度记录</text><view v-for="(event, index) in activeApplication.history" :key="`${event.at}-${index}`"><view class="career-history-dot" /><text>{{ applicationStatusLabels[event.status] }}</text><text>{{ date(event.at) }} · 用户记录</text></view></view>
      <view v-if="visibleError" class="career-alert" role="alert"><text>{{ visibleError }}</text><button class="text-button" :disabled="busy || loading" @click="refreshWorkspace" role="button" tabindex="0">重新读取记录</button></view>
      <view class="career-delete-line"><button class="text-button career-danger" :disabled="busy" @click="askDeleteApplication" role="button" tabindex="0">删除记录</button></view>
    </AppModal>

    <AppModal v-if="modal === 'material' && activeMaterial && a.canUse('studyMaterials')" :title="activeMaterial.title" :subtitle="`${activeMaterial.major} · ${activeMaterial.role}`" wide @close="closeModal">
      <text class="career-material-summary">{{ activeMaterial.summary }}</text>
      <view v-if="activeMaterial.attachment" class="career-source-box">
        <text>{{ activeMaterial.attachment.fileName }} · {{ Math.ceil(activeMaterial.attachment.bytes / 1024) }} KB</text>
        <template v-if="activeMaterial.attachment.format === 'mp4'">
          <video v-if="videoSource" :src="videoSource.url" class="career-material-video" controls playsinline @error="materialVideoError" />
          <button v-else class="text-button" :disabled="videoLoading" @click="openMaterialVideo" role="button" tabindex="0">
            {{ videoLoading ? (videoProgress === null ? '正在读取视频…' : `正在读取视频 ${videoProgress}%`) : '打开视频播放器' }}
          </button>
        </template>
        <template v-else>
          <button class="text-button" :disabled="openingMaterialFile" @click="openMaterialFile" role="button" tabindex="0">
            {{ openingMaterialFile ? '正在读取文件…' : '打开资料文件' }}
          </button>
          <text v-if="materialFileNotice" role="status">{{ materialFileNotice }}</text>
        </template>
      </view>
      <text v-if="!activeMaterial.attachment || activeMaterial.content !== careerFileFallbackText" class="career-prose career-material-content">{{ activeMaterial.content }}</text>
      <view class="career-source-box"><text>来源：{{ activeMaterial.sourceLabel }} · 整理 / 更新 {{ date(activeMaterial.updatedAt) }}</text><button v-if="activeMaterial.sourceUrl" class="text-button" @click="copySource(activeMaterial.sourceUrl)" role="button" tabindex="0">复制来源链接<AppIcon name="copy" :size="14" /></button></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
    </AppModal>

    <AppModal v-if="modal === 'confirm' && a.canUse(confirmation === 'delete-job' ? 'companyJobs' : 'applications')" :title="confirmation === 'status' ? '确认手动更新进度' : confirmation === 'delete-job' ? '删除这个个人岗位？' : '删除这条投递记录？'"  @close="cancelConfirmation">
      <template v-if="confirmation === 'status' && activeApplication"><text class="career-confirm-title">{{ activeApplication.jobSnapshot.company }} · {{ activeApplication.jobSnapshot.title }}</text><text class="career-prose">进度将从“{{ applicationStatusLabels[activeApplication.status] }}”更新为“{{ applicationStatusLabels[nextStatus] }}”。</text><button v-if="nextStatus === 'applied'" class="career-checkbox" role="checkbox" :aria-checked="manualSubmitted" :disabled="busy" @click="manualSubmitted = !manualSubmitted" tabindex="0"><view class="career-check-square" :class="{ checked: manualSubmitted }"><AppIcon v-if="manualSubmitted" name="check" :size="13" /></view><text>我已自行完成真实投递，并确认使用了计划中的简历版本。本操作仅保存进度记录。</text></button></template>
      <text v-else-if="confirmation === 'delete-job'" class="career-prose">将删除这个账号下的个人岗位及收藏。关联投递记录需要先单独删除。</text>
      <text v-else class="career-prose">将删除投递进度、备注及这条记录保存的简历快照，无法恢复。已经自行完成的外部投递不会因此撤回。</text>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="button secondary" :disabled="busy" @click="cancelConfirmation" role="button" tabindex="0">暂不修改</button><button class="button" :class="confirmation === 'status' ? 'primary' : 'danger'" :disabled="busy || (confirmation === 'status' && nextStatus === 'applied' && !manualSubmitted)" @click="confirmAction" role="button" tabindex="0">{{ busy ? '正在保存…' : confirmation === 'status' ? '确认保存进度' : '确认删除' }}</button></view>
    </AppModal>
  </view>
</template>

<style scoped>
.career-material-video { display: block; width: 100%; max-width: 100%; height: 300px; margin-top: 10px; background: #172724; }
@media(max-width:767px) { .career-material-video { height: 210px; } }
.career-identity { display: inline-block; margin-top: 4px; font-size: 12px; color: #65738a; background: #edf2f9; border-radius: 6px; padding: 3px 8px; }
.career-shortcuts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; margin-bottom: 18px; }.career-shortcut { width: 100%; display: flex; align-items: center; gap: 13px; padding: 19px 20px; border-radius: 15px; text-align: left; color: #26344a; }.career-shortcut > view:nth-child(2) { flex: 1; min-width: 0; font-size: 16px; }.career-shortcut-icon { height: 40px; width: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: #edf2fa; flex-shrink: 0; }.career-shortcut-tier { font-size: 11px; display: inline-block; padding: 2px 6px; margin-left: 8px; background: #edf1f7; color: #65738a; border-radius: 5px; }.career-shortcut .career-caption { font-size: 12px; margin-top: 3px; }
.career-tabs > button.locked { color: #8290a4; }.career-tabs > button > .app-icon { margin-right: 4px; opacity: .7; }.career-count.locked { background: rgba(247,249,252,.8); }.career-count.locked > text:first-child { color: #7c8a9e; font-size: 15px; font-weight: 500; line-height: 2.55; }.career-count.locked > .app-icon { opacity: .55; }.career-locked-footer { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-top: 11px; }.career-locked-footer .career-caption { font-size: 12px; margin: 0; }.career-locked-footer .text-button { font-size: 12px; white-space: nowrap; }.career-upgrade-icon { width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center; justify-content: center; background: #eef3fa; margin: 0 auto 19px; }
.career-panel { min-width: 0; padding-bottom: 18px; color: #536174; }
.career-heading,.career-row,.career-section-heading,.career-resume-toolbar,.career-modal-footer,.career-card-footer,.career-note-footer,.career-delete-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.career-heading { margin-bottom: 21px; align-items: flex-start; }.career-heading > view { min-width: 0; }
.career-eyebrow,.career-title,.career-subtitle,.career-caption,.career-job-title,.career-job-company,.career-excerpt,.career-source,.career-section-title { display: block; }
.career-eyebrow { font-size: 13px; color: #536174; letter-spacing: .5px; }.career-title { font-size: 27px; font-weight: 600; letter-spacing: -.6px; margin-top: 0; line-height: 1.5; }.career-subtitle { font-size: 14px; color: #1f2937; line-height: 1.8; margin-top: 8px; }.career-refresh { flex-shrink: 0; font-size: 14px; min-height: 39px; }
.career-preview,.career-notice,.career-alert { display: flex; align-items: flex-start; gap: 10px; padding: 14px 17px; border-radius: 13px; font-size: 14px; line-height: 1.8; margin-bottom: 18px; }.career-preview { background: #f4f6f9; border: 1px solid #d8dfe8; color: #536174; }.career-preview .app-icon,.career-notice .app-icon { margin-top: 3px; }.career-alert { color: #a9342b; border: 1px solid #e8bbb5; background: #fff1ef; }.career-alert > text,.career-notice > text { flex: 1; }.career-alert .text-button { flex-shrink: 0; color: #a9342b; }.career-notice { color: #246347; background: #edf6f1; border: 1px solid #d8dfe8; }.career-notice .icon-button { margin-left: auto; }
.career-tabs { display: grid; padding: 5px; background: var(--glass-surface); border: 1px solid var(--glass-line); border-radius: 15px; gap: 5px; margin: 0; box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); box-sizing: border-box; grid-template-columns: repeat(4,minmax(0,1fr)); width: 100%; min-width: 0; }.career-tabs > button { flex: 1; padding: 11px 8px; text-align: center; font-size: 15px; border-radius: 11px; color: #536174; white-space: normal; min-height: 42px; min-width: 0; overflow-wrap: anywhere; }.career-tabs > .active { color: #2458c5; background: #eaf0fc; box-shadow: none; }
.career-counts { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; margin-bottom: 20px; }.career-count { padding: 24px 21px; border-radius: 16px; position: relative; }.career-count > text { display: block; }.career-count > text:first-child { color: #1f2937; font-size: 32px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }.career-count > text:nth-child(2) { color: #536174; font-size: 14px; margin-top: 10px; }.career-count > .app-icon { position: absolute; right: 20px; top: 27px; opacity: .8; }
.career-section-title { font-size: 17px; font-weight: 560; color: #1f2937; line-height: 1.7; }
.career-section-heading { margin-bottom: 18px; }.career-caption { font-size: 14px; color: #536174; line-height: 1.8; margin-top: 5px; }.career-section-heading > .button { font-size: 14px; min-height: 41px; flex-shrink: 0; }.career-filters { display: flex; gap: 15px; padding: 13px 16px; align-items: center; margin-bottom: 20px; border-radius: 15px; }.career-search { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; }.career-search .app-icon { opacity: .8; }.career-search > input { width: 100%; font-size: 16px; height: 33px; }.career-picker { display: flex; align-items: center; justify-content: space-between; gap: 17px; font-size: 14px; color: #536174; padding: 9px 3px; }.career-filter-toggle { font-size: 14px; color: #536174; border: 1px solid #d8dfe8; border-radius: 9px; padding: 8px 11px; flex-shrink: 0; min-height: 36px; }.career-filter-toggle.active { color: #2458c5; background: #eaf0fc; border-color: #9eb3e3; }
.career-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; text-align: center; padding: 45px 25px; min-height: 240px; font-size: 16px; border-radius: 16px; }.career-empty > .app-icon { opacity: .8; }.career-empty .career-caption { max-width: 440px; margin: 0; }.career-empty .button { font-size: 14px; min-height: 39px; }
.career-job-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 17px; }.career-job-card { overflow: hidden; border-radius: 16px; display: flex; flex-direction: column; }.career-job-content { display: block; width: 100%; padding: 21px 22px 17px; flex: 1; }.career-job-company { color: #536174; font-size: 14px; line-height: 1.8; }.career-job-title { color: #1f2937; font-size: 18px; font-weight: 560; line-height: 1.7; margin: 7px 0; }.career-tag { display: inline-block; font-size: 12px; line-height: 1.6; color: #536174; background: #f4f6f9; padding: 4px 8px; border-radius: 7px; flex-shrink: 0; }.career-tag.closed,.career-tag.rejected,.career-tag.withdrawn { background: #f4f6f9; color: #536174; }.career-tag.interview,.career-tag.offer { background: #edf6f1; color: #246347; }.career-tag.applied { background: #f4f6f9; color: #536174; }.career-tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }.career-tags > text { font-size: 12px; padding: 3px 7px; border: 1px solid #d8dfe8; border-radius: 5px; color: #536174; }.career-excerpt { color: #536174; font-size: 14px; line-height: 1.9; white-space: pre-line; }.career-card-footer { padding: 14px 22px; border-top: 1px solid #d8dfe8; margin-top: auto; }.career-card-footer > text { font-size: 12px; color: #536174; }.career-card-footer > button { font-size: 14px; }
.career-material-list,.career-application-list { display: flex; flex-direction: column; gap: 13px; }.career-material { display: flex; gap: 18px; padding: 24px; align-items: center; width: 100%; border-radius: 16px; }.career-material > view:nth-child(2) { flex: 1; min-width: 0; }.career-material-icon { display: flex; align-items: center; justify-content: center; width: 47px; height: 53px; border-radius: 13px; background: #f4f6f9; flex-shrink: 0; }.career-material .career-job-title { margin: 0 0 4px; }.career-source { font-size: 13px; color: #536174; line-height: 1.8; margin-top: 11px; }
.career-status-filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }.career-status-filters > button { font-size: 14px; color: #536174; padding: 8px 12px; border: 1px solid #d8dfe8; border-radius: 9px; background: #fff; min-height: 36px; }.career-status-filters > .active { color: #2458c5; border-color: #9eb3e3; background: #eaf0fc; }.career-application { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 21px 23px; width: 100%; border-radius: 16px; }.career-application-main { min-width: 0; flex: 1; }.career-application .career-job-title { margin: 3px 0 6px; }.career-application-status { display: flex; flex-direction: column; align-items: flex-end; gap: 13px; flex-shrink: 0; }.career-application-status > text:last-child { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #536174; }
.career-detail-meta { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }.career-detail-section { margin: 23px 0; }.career-prose { display: block; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-size: 15px; color: #1f2937; line-height: 2; margin-top: 11px; }.career-source-box { margin: 22px 0; background: #f4f6f9; border: 1px solid #d8dfe8; border-radius: 10px; padding: 14px 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }.career-source-box > text { font-size: 13px; line-height: 1.8; color: #536174; }.career-source-box .text-button { font-size: 13px; }.career-detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; padding-top: 10px; }.career-detail-actions .button { font-size: 14px; min-height: 41px; }.career-delete-line { padding-top: 20px; margin-top: 22px; border-top: 1px solid #d8dfe8; }.career-delete-line > text { font-size: 13px; color: #536174; line-height: 1.8; }.career-delete-line > button { flex-shrink: 0; font-size: 13px; }.career-danger { color: #a9342b; }
.career-form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; }.career-form-field { margin: 20px 0; }.career-description-input { height: 210px; }.career-note-input { height: 110px; }.career-modal-footer { margin-top: 24px; justify-content: flex-end; }.career-modal-footer > text { font-size: 13px; line-height: 1.8; color: #536174; }.career-modal-footer .button { font-size: 14px; min-height: 41px; flex-shrink: 0; }.career-resume-toolbar { margin: 19px 0 10px; }.career-resume-toolbar .field-label { margin-bottom: 0; }.career-resume-toolbar .text-button { font-size: 13px; }.career-resume-picker { border: 1px solid #d8dfe8; border-radius: 10px; padding: 12px 14px; background: #f4f6f9; }.career-resume-snapshot { border: 1px solid #d8dfe8; background: #f4f6f9; padding: 16px 18px; border-radius: 12px; max-height: 330px; overflow-y: auto; font-size: 14px; }.career-snapshot-caption { margin-top: 18px; }.career-checkbox { display: flex; align-items: flex-start; gap: 10px; margin: 17px 0; text-align: left; font-size: 14px; line-height: 1.9; color: #536174; width: 100%; }.career-check-square { width: 19px; height: 19px; display: flex; align-items: center; justify-content: center; border: 1px solid #d8dfe8; border-radius: 5px; background: #fff; flex-shrink: 0; margin-top: 2px; }.career-check-square.checked { border-color: #9eb3e3; background: #eaf0fc; }.career-inline-empty { background: #f4f6f9; padding: 20px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 14px; color: #536174; line-height: 1.8; }.career-inline-empty .button { flex-shrink: 0; font-size: 14px; }.career-rebind { border-radius: 12px; border: 1px solid #d8dfe8; padding: 16px 18px; background: #f4f6f9; }.career-warning { color: #8a4b12; }.career-rebind > .button { font-size: 14px; min-height: 37px; }.career-note-footer { margin-top: 9px; }.career-note-footer > text { color: #536174; font-size: 12px; }.career-note-footer .text-button { font-size: 13px; }.career-note-draft-actions { display: flex; flex-wrap: wrap; gap: 15px; justify-content: flex-end; margin-top: 12px; }.career-note-draft-actions .text-button { font-size: 13px; }.career-status-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 13px; }.career-status-actions .button { font-size: 14px; min-height: 39px; padding: 9px 12px; }.career-history { margin-top: 25px; }.career-history > view { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 14px; color: #536174; }.career-history > view > text:last-child { margin-left: auto; font-size: 12px; color: #536174; }.career-history-dot { width: 6px; height: 6px; background: #536174; border-radius: 50%; }.career-material-summary { display: block; font-size: 15px; line-height: 1.9; color: #536174; margin-bottom: 21px; }.career-material-content { margin: 0; }.career-confirm-title { display: block; font-size: 16px; line-height: 1.8; color: #1f2937; margin-bottom: 12px; }
.career-tabs-wrap { display: block; width: 100%; min-width: 0; margin: 23px 0; border-radius: 15px; }
@media (max-width: 767px) {
  .career-shortcuts { grid-template-columns: minmax(0,1fr); gap: 10px; margin-bottom: 14px; }.career-shortcut { padding: 15px; }.career-count.locked > text:first-child { font-size: 13px; line-height: 2.55; }.career-locked-footer { flex-wrap: wrap; gap: 7px; }.career-locked-footer .text-button { margin-left: auto; }
  .career-title { font-size: 23px; margin-top: 0; }.career-heading { gap: 10px; align-items: center; margin-bottom: 16px; }.career-refresh { padding: 9px 10px; font-size: 13px; }.career-refresh .app-icon { display: none; }.career-counts { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-bottom: 16px; }.career-count { padding: 15px 14px; min-height: 94px; }.career-tabs { gap: 0; background: var(--glass-surface); border: 1px solid var(--glass-line); box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); display: grid; width: 100%; min-width: 0; padding: 4px; grid-template-columns: repeat(4,minmax(0,1fr)); }.career-tabs > button { font-size: 13px; padding: 10px 2px; flex: initial; min-height: 44px; white-space: normal; min-width: 0; overflow-wrap: anywhere; }.career-section-heading { align-items: flex-start; flex-wrap: wrap; gap: 13px; }.career-section-heading > view { flex: 1; min-width: 180px; }.career-job-grid { grid-template-columns: minmax(0,1fr); }.career-filters { flex-wrap: wrap; gap: 9px 14px; padding: 12px 14px; align-items: stretch; }.career-search { flex-basis: 100%; }.career-filters > picker { flex: 1; min-width: 0; }.career-job-content { padding: 21px 19px 17px; }.career-card-footer { padding: 13px 19px; flex-wrap: wrap; gap: 8px 12px; }.career-material { padding: 17px 14px; gap: 11px; align-items: flex-start; }.career-material-icon { width: 35px; height: 43px; border-radius: 10px; }.career-application { padding: 19px 16px; gap: 9px; align-items: flex-start; flex-wrap: wrap; }.career-application .career-job-title { font-size: 16px; }.career-caption,.career-excerpt,.career-subtitle,.career-preview,.career-alert,.career-notice,.career-source-box > text { font-size: 14px; }.career-form-grid { grid-template-columns: minmax(0,1fr); gap: 16px; }.career-detail-actions > .button { flex: 1; min-width: 120px; }.career-modal-footer { flex-wrap: wrap; gap: 15px; justify-content: flex-end; }.career-modal-footer > text { flex-basis: 100%; }.career-modal-footer > .button { margin-left: auto; }.career-delete-line { flex-wrap: wrap; gap: 11px; }.career-delete-line > button { margin-left: auto; }.career-resume-snapshot { max-height: 280px; padding: 14px; font-size: 15px; }.career-checkbox { font-size: 15px; }.career-rebind { padding: 15px 13px; }.career-inline-empty { flex-wrap: wrap; }.career-history > view { flex-wrap: wrap; }.career-history > view > text:last-child { margin-left: 0; }.career-tabs-wrap { margin: 16px 0; white-space: nowrap; }.career-count > text:first-child { font-size: 28px; }.career-count > text:nth-child(2) { font-size: 13px; margin-top: 7px; line-height: 1.6; }.career-count > .app-icon { right: 13px; top: 18px; }.career-search > input { font-size: 16px; min-width: 0; height: 40px; }.career-picker { min-height: 40px; overflow-wrap: anywhere; }.career-filter-toggle { min-height: 40px; white-space: nowrap; }.career-card-footer > text { min-width: 0; overflow-wrap: anywhere; }.career-card-footer > button { min-height: 40px; margin-left: auto; }.career-material > .app-icon:last-child { align-self: center; }.career-application-status { flex-direction: row; align-items: center; justify-content: space-between; width: 100%; gap: 10px; border-top: 1px solid #d8dfe8; padding-top: 10px; }.career-status-filters { gap: 7px; }.career-status-filters > button { min-height: 40px; padding: 8px 11px; }.career-resume-toolbar { align-items: flex-start; flex-wrap: wrap; gap: 7px 12px; }.career-note-footer { gap: 8px; flex-wrap: wrap; }.career-source-box { min-width: 0; overflow-wrap: anywhere; }.career-description-input { font-size: 16px; }.career-note-input { font-size: 16px; }
}
</style>
