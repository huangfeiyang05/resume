<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type { ApplicationStatus, CareerApplication, CareerJob, CareerJobInput, CareerRecruitmentPortal, CompanyRecord, Resume } from '../../shared/types';
import { inputLimits } from '../../shared/limits';
import { api } from '../services/api';
import { applicationStatusLabels, applicationTransitions, jobAcceptingPlans, useCareerWorkspace } from '../services/career';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';
import RecruitmentPortals from './RecruitmentPortals.vue';
import CompanyLibrary from './CompanyLibrary.vue';

const props = defineProps<{ resumes: Resume[] }>();
const emit = defineEmits<{ tailor: [job: CareerJob]; createResume: [] }>();
const c = useCareerWorkspace();
const { state, jobs, materials, portals, applications, favoriteJobIds, loading, busy, error, notice } = c;
type Section = 'overview' | 'jobs' | 'portals' | 'materials' | 'applications';
type Modal = 'job' | 'job-form' | 'plan-new' | 'application' | 'material' | 'confirm';
const tabs: Array<{ id: Section; title: string }> = [
  { id: 'overview', title: '工作台' }, { id: 'jobs', title: '公司与岗位' },
  { id: 'portals', title: '招聘入口' }, { id: 'materials', title: '复习资料' }, { id: 'applications', title: '投递计划' },
];
const section = ref<Section>('overview');
const companyView = ref<'companies' | 'jobs'>('companies');
const companyLibrary = ref<{ reload: () => Promise<void> }>();
const modal = ref<Modal>();
const selectedJobId = ref(''), selectedApplicationId = ref(''), selectedMaterialId = ref('');
const activeJob = computed(() => jobs.value.find(item => item.id === selectedJobId.value));
const activeApplication = computed(() => applications.value.find(item => item.id === selectedApplicationId.value));
const activeMaterial = computed(() => materials.value.find(item => item.id === selectedMaterialId.value));
const jobQuery = ref(''), materialQuery = ref(''), major = ref(''), materialMajor = ref('');
const favoritesOnly = ref(false), applicationFilter = ref<ApplicationStatus | '' | 'active'>('');
const localError = ref('');
const visibleError = computed(() => localError.value || error.value);
const jobMajors = computed(() => ['', ...Array.from(new Set(jobs.value.map(item => item.major))).sort()]);
const materialMajors = computed(() => ['', ...Array.from(new Set(materials.value.map(item => item.major))).sort()]);
const favoriteSet = computed(() => new Set(favoriteJobIds.value));
const filteredJobs = computed(() => {
  const query = jobQuery.value.trim().toLowerCase();
  return jobs.value.filter(item => (!major.value || item.major === major.value)
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
onUnmounted(() => { disposed = true; ++resumeRequest; });
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
function selectSection(next: Section) { section.value = next; resetError(); }
function showJob(item: CareerJob) { selectedJobId.value = item.id; modal.value = 'job'; resetError(); }
function showApplication(item: CareerApplication) {
  selectedApplicationId.value = item.id; note.value = item.note; noteBase.value = item.note; noteRevision.value = item.revision; noteConflict.value = false;
  selectedResumeId.value = item.resumeSnapshot.id; resumeReviewed.value = false;
  modal.value = 'application'; resetError(); void refreshResumes();
}
function showMaterial(id: string) { selectedMaterialId.value = id; modal.value = 'material'; resetError(); }
function showJobForm() { companyView.value = 'jobs'; modal.value = 'job-form'; resetError(); }
function refreshWorkspace() {
  if (section.value === 'jobs' && companyView.value === 'companies') void companyLibrary.value?.reload();
  else void c.load();
}
function addCompanyJob(company: CompanyRecord) {
  Object.assign(jobForm, { company: company.name, title: '', major: '', location: '', description: '', companyOverview: '', sourceUrl: '', deadline: '' });
  section.value = 'jobs'; showJobForm();
  notice.value = '已带入企业名称，请核对最新公告后填写具体岗位、地区、专业和要求。';
}
function addPortalJob(portal: CareerRecruitmentPortal) {
  Object.assign(jobForm, { company: portal.organization, title: '', major: portal.majors.length === 1 ? portal.majors[0] : '', location: '', description: '', companyOverview: '', sourceUrl: '', deadline: '' });
  section.value = 'jobs'; showJobForm();
  notice.value = '请从官方入口核对后填写具体岗位、地点和要求，来源链接填写该岗位的公告地址。';
}
function clearJobFilters() { jobQuery.value = ''; major.value = ''; favoritesOnly.value = false; }
function clearMaterialFilters() { materialQuery.value = ''; materialMajor.value = ''; }
function pickMajor(event: { detail: { value: string | number } }) { major.value = jobMajors.value[Number(event.detail.value)] || ''; }
function pickMaterialMajor(event: { detail: { value: string | number } }) { materialMajor.value = materialMajors.value[Number(event.detail.value)] || ''; }
function pickResume(event: { detail: { value: string | number } }) { selectedResumeId.value = savedResumes.value[Number(event.detail.value)]?.id || ''; }
async function refreshResumes() {
  const requestId = ++resumeRequest;
  resumeLoading.value = true;
  try {
    const result = await api.resumes();
    if (disposed || requestId !== resumeRequest) return;
    savedResumes.value = result;
    if (!result.some(item => item.id === selectedResumeId.value)) selectedResumeId.value = result[0]?.id || '';
  } catch (cause) { if (!disposed && requestId === resumeRequest) localError.value = cause instanceof Error ? cause.message : '无法读取最新简历，请重试。'; }
  finally { if (!disposed && requestId === resumeRequest) resumeLoading.value = false; }
}
async function saveJob() {
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
function tailorJob(item: CareerJob) { closeModal(); emit('tailor', item); }
function createResume() { closeModal(); emit('createResume'); }
function beginPlan() {
  if (!activeJob.value || !jobAcceptingPlans(activeJob.value)) return;
  selectedResumeId.value = savedResumes.value[0]?.id || ''; resumeReviewed.value = false;
  modal.value = 'plan-new'; resetError(); void refreshResumes();
}
async function savePlan() {
  resetError();
  const target = activeJob.value, selected = chosenResume.value;
  if (!target || !selected || !resumeReviewed.value || resumeLoading.value) { localError.value = '请先选择并核对已保存的简历版本。'; return; }
  const result = await c.createApplication({ jobId: target.id, resumeId: selected.id, resumeRevision: selected.revision });
  if (result && !disposed) { section.value = 'applications'; showApplication(result); }
}
async function saveNote() {
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
  const item = activeApplication.value, selected = chosenResume.value;
  if (!item || !selected || !resumeReviewed.value || !canRebind.value || resumeLoading.value) return;
  resetError();
  if (noteDirty.value) { localError.value = '请先保存或放弃未保存的备注，再更换简历版本。'; return; }
  const result = await c.updateApplication(item.id, { revision: item.revision, resumeId: selected.id, resumeRevision: selected.revision });
  if (result && !disposed) resumeReviewed.value = false;
}
function askStatus(value: ApplicationStatus) {
  if (!activeApplication.value || !applicationTransitions[activeApplication.value.status].includes(value)) return;
  if (noteDirty.value) { localError.value = '请先保存或放弃未保存的备注，再更新进度。'; return; }
  confirmation.value = 'status'; nextStatus.value = value; manualSubmitted.value = false; modal.value = 'confirm'; resetError();
}
function askDeleteApplication() { confirmation.value = 'delete-application'; modal.value = 'confirm'; resetError(); }
function askDeleteJob() { confirmation.value = 'delete-job'; modal.value = 'confirm'; resetError(); }
function cancelConfirmation() { if (!busy.value) { modal.value = confirmation.value === 'delete-job' ? 'job' : 'application'; resetError(); } }
async function confirmAction() {
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
      <view><text class="career-eyebrow">高级会员功能预览</text><text class="career-title">为目标岗位，一步步准备。</text><text class="career-subtitle">收藏机会、打磨简历，把每一次投递记录清楚。</text></view>
      <button class="button secondary career-refresh" :disabled="loading || busy" @click="refreshWorkspace" role="button" tabindex="0"><AppIcon name="undo" :size="15" />重新读取</button>
    </view>
    <view class="career-preview"><AppIcon name="info" :size="17" /><text>当前可体验求职工作台。复习资料和招聘入口可按专业查阅；投递进度由你手动记录，尚未开通自动代投，会员收费暂未开放。</text></view>
    <view v-if="visibleError && !modal" class="career-alert" role="alert"><text>{{ visibleError }}</text><button class="text-button" :disabled="busy || loading" @click="c.load" role="button" tabindex="0">重新读取</button></view>
    <view v-if="notice" class="career-notice" role="status" aria-live="polite"><AppIcon name="check" :size="16" /><text>{{ notice }}</text><button class="icon-button" aria-label="关闭提示" @click="notice = ''" role="button" tabindex="0"><AppIcon name="close" :size="14" /></button></view>
    <view v-if="loading && !state" class="glass-panel career-empty" role="status"><view class="spinner" /><text>正在读取你的求职工作台…</text></view>
    <view v-else-if="!state" class="glass-panel career-empty"><AppIcon name="briefcase" :size="28" /><text>工作台暂时无法读取</text><button class="button secondary" @click="c.load" role="button" tabindex="0">重试</button></view>
    <template v-else>
      <view class="career-tabs" role="tablist" aria-label="求职工作台功能"><button v-for="item in tabs" :key="item.id" :class="{ active: section === item.id }" :aria-selected="section === item.id" role="tab" @click="selectSection(item.id)" tabindex="0">{{ item.title }}</button></view>

      <template v-if="section === 'overview'">
        <view class="career-counts">
          <button class="glass-panel career-count" @click="section = 'jobs'; favoritesOnly = true" role="button" tabindex="0"><text>{{ counts.favorites }}</text><text>已收藏岗位</text><AppIcon name="briefcase" :size="20" /></button>
          <button class="glass-panel career-count" @click="section = 'applications'; applicationFilter = 'planned'" role="button" tabindex="0"><text>{{ counts.planned }}</text><text>待投递计划</text><AppIcon name="file" :size="20" /></button>
          <button class="glass-panel career-count" @click="section = 'applications'; applicationFilter = 'active'" role="button" tabindex="0"><text>{{ counts.active }}</text><text>投递与面试中</text><AppIcon name="clock" :size="20" /></button>
          <button class="glass-panel career-count" @click="section = 'applications'; applicationFilter = 'offer'" role="button" tabindex="0"><text>{{ counts.offer }}</text><text>收到录用</text><AppIcon name="check" :size="20" /></button>
        </view>
        <view class="glass-panel career-workflow">
          <text class="career-section-title">从找到岗位，到跟进结果。</text>
          <view class="career-step"><text>01</text><view><text>保存真实的目标岗位</text><text>岗位库等待补充时，也可以添加你已找到的公司和岗位。</text></view><button class="text-button" @click="showJobForm" role="button" tabindex="0">添加岗位<AppIcon name="plus" :size="14" /></button></view>
          <view class="career-step"><text>02</text><view><text>对照岗位，审核简历</text><text>使用已保存的简历进行优化，逐条核对真实内容后再建立计划。</text></view><button class="text-button" @click="section = 'jobs'; favoritesOnly = false" role="button" tabindex="0">查看岗位<AppIcon name="arrow" :size="14" /></button></view>
          <view class="career-step"><text>03</text><view><text>自行投递，记录进度</text><text>计划会保留当时的简历版本。完成外部投递后，再更新进度。</text></view><button class="text-button" @click="section = 'applications'; applicationFilter = ''" role="button" tabindex="0">查看计划<AppIcon name="arrow" :size="14" /></button></view>
        </view>
        <view class="glass-panel career-catalog-note"><AppIcon name="book" :size="23" /><view><text>{{ state.catalogState === 'unavailable' ? '资料目录暂时不可用' : state.catalogState === 'empty' ? '公司岗位资料与复习资料待补充' : '专业资料已可查阅' }}</text><text>{{ state.catalogMessage }}</text></view><button class="text-button" @click="section = 'materials'" role="button" tabindex="0">查看资料<AppIcon name="arrow" :size="14" /></button></view>
      </template>

      <template v-else-if="section === 'jobs'">
        <view class="career-status-filters" role="tablist" aria-label="企业与岗位视图"><button :class="{ active: companyView === 'companies' }" :aria-selected="companyView === 'companies'" @click="companyView = 'companies'" role="tab" tabindex="0">企业资料</button><button :class="{ active: companyView === 'jobs' }" :aria-selected="companyView === 'jobs'" @click="companyView = 'jobs'" role="tab" tabindex="0">目标岗位</button></view>
        <CompanyLibrary v-if="companyView === 'companies'" ref="companyLibrary" @add-job="addCompanyJob" />
        <template v-else>
        <view class="career-section-heading"><view><text class="career-section-title">公司与岗位</text><text class="career-caption">按专业整理机会，个人添加的岗位仅保存在你的账号中。</text></view><button class="button primary" :disabled="busy" @click="showJobForm" role="button" tabindex="0"><AppIcon name="plus" :size="16" />添加目标岗位</button></view>
        <view class="glass-panel career-filters"><view class="career-search"><AppIcon name="search" :size="17" /><input v-model="jobQuery" placeholder="搜索公司、岗位或地点" :maxlength="100" aria-label="搜索岗位" /></view><picker :range="jobMajors.map(value => value || '全部专业')" :value="Math.max(0, jobMajors.indexOf(major))" @change="pickMajor"><view class="career-picker">{{ major || '全部专业' }}<AppIcon name="chevron" :size="13" /></view></picker><button class="career-filter-toggle" :class="{ active: favoritesOnly }" :aria-pressed="favoritesOnly" @click="favoritesOnly = !favoritesOnly" role="button" tabindex="0">只看收藏</button></view>
        <view v-if="!filteredJobs.length" class="glass-panel career-empty"><AppIcon name="briefcase" :size="30" /><text>{{ jobs.length ? '没有符合筛选条件的岗位' : '还没有目标岗位' }}</text><text class="career-caption">{{ jobs.length ? '试试其他关键词，或清除当前筛选。' : '公司岗位库待补充。你可以先添加自己找到的真实岗位，开始准备。' }}</text><button class="button secondary" @click="jobs.length ? clearJobFilters() : showJobForm()" role="button" tabindex="0">{{ jobs.length ? '清除筛选' : '添加目标岗位' }}</button></view>
        <view v-else class="career-job-grid"><view v-for="item in filteredJobs" :key="item.id" class="glass-panel career-job-card"><button class="career-job-content" @click="showJob(item)" role="button" tabindex="0"><view class="career-row"><text class="career-job-company">{{ item.company }}</text><text class="career-tag" :class="{ closed: !jobAcceptingPlans(item) }">{{ jobAcceptingPlans(item) ? '可准备' : '已截止 / 关闭' }}</text></view><text class="career-job-title">{{ item.title }}</text><view class="career-tags"><text>{{ item.major }}</text><text>{{ item.location }}</text><text>{{ item.origin === 'personal' ? '个人添加' : '资料库' }}</text></view><text class="career-excerpt">{{ item.description.slice(0, 130) }}</text></button><view class="career-card-footer"><text>{{ item.deadline ? `截止 ${item.deadline}` : `更新 ${date(item.updatedAt)}` }}</text><button class="text-button" :disabled="busy" :aria-pressed="favoriteSet.has(item.id)" @click="c.favorite(item.id, !favoriteSet.has(item.id))" role="button" tabindex="0">{{ favoriteSet.has(item.id) ? '取消收藏' : '收藏岗位' }}<AppIcon :name="favoriteSet.has(item.id) ? 'check' : 'plus'" :size="14" /></button></view></view></view>
        </template>
      </template>

      <template v-else-if="section === 'materials'">
        <view class="career-section-heading"><view><text class="career-section-title">复习资料</text><text class="career-caption">按专业与岗位查阅，来源和资料整理日期随内容展示。</text></view><text class="career-tag">{{ materials.length }} 份资料</text></view>
        <view class="glass-panel career-filters"><view class="career-search"><AppIcon name="search" :size="17" /><input v-model="materialQuery" placeholder="搜索资料、岗位或主题" :maxlength="100" aria-label="搜索复习资料" /></view><picker :range="materialMajors.map(value => value || '全部专业')" :value="Math.max(0, materialMajors.indexOf(materialMajor))" @change="pickMaterialMajor"><view class="career-picker">{{ materialMajor || '全部专业' }}<AppIcon name="chevron" :size="13" /></view></picker></view>
        <view v-if="!filteredMaterials.length" class="glass-panel career-empty"><AppIcon name="book" :size="30" /><text>{{ materials.length ? '没有找到相关资料' : state.catalogState === 'unavailable' ? '资料目录暂时无法读取' : '复习资料待补充' }}</text><text class="career-caption">{{ materials.length ? '可更换关键词或专业。' : state.catalogMessage }}</text><button v-if="materials.length" class="button secondary" @click="clearMaterialFilters" role="button" tabindex="0">清除筛选</button><button v-else-if="state.catalogState === 'unavailable'" class="button secondary" :disabled="loading || busy" @click="c.load" role="button" tabindex="0">重新读取</button></view>
        <view v-else class="career-material-list"><button v-for="item in filteredMaterials" :key="item.id" class="glass-panel career-material" @click="showMaterial(item.id)" role="button" tabindex="0"><view class="career-material-icon"><AppIcon name="book" :size="24" /></view><view><text class="career-job-title">{{ item.title }}</text><text class="career-caption">{{ item.major }} · {{ item.role }}</text><text class="career-excerpt">{{ item.summary }}</text><text class="career-source">{{ item.sourceLabel }} · {{ date(item.updatedAt) }}</text></view><AppIcon name="chevron" :size="17" /></button></view>
      </template>

      <RecruitmentPortals v-else-if="section === 'portals'" :portals="portals" :catalog-state="state.catalogState" :catalog-message="state.catalogMessage" :loading="loading || busy" @add-job="addPortalJob" @retry="c.load" />

      <template v-else>
        <view class="career-section-heading"><view><text class="career-section-title">我的投递计划</text><text class="career-caption">每条计划保留简历快照，所有进度均由你手动确认。</text></view><button class="text-button" @click="section = 'jobs'" role="button" tabindex="0">选择岗位<AppIcon name="arrow" :size="15" /></button></view>
        <view class="career-status-filters"><button :class="{ active: applicationFilter === '' }" @click="applicationFilter = ''" role="button" tabindex="0">全部 {{ applications.length }}</button><button :class="{ active: applicationFilter === 'active' }" @click="applicationFilter = 'active'" role="button" tabindex="0">投递与面试中</button><button v-for="value in allStatuses" :key="value" :class="{ active: applicationFilter === value }" @click="applicationFilter = value" role="button" tabindex="0">{{ applicationStatusLabels[value] }}</button></view>
        <view v-if="!filteredApplications.length" class="glass-panel career-empty"><AppIcon name="file" :size="30" /><text>{{ applications.length ? '这个阶段还没有记录' : '从一份投递计划开始' }}</text><text class="career-caption">选好岗位，核对要使用的简历版本，再保存计划。</text><button class="button secondary" @click="section = 'jobs'" role="button" tabindex="0">去选择岗位</button></view>
        <view v-else class="career-application-list"><button v-for="item in filteredApplications" :key="item.id" class="glass-panel career-application" @click="showApplication(item)" role="button" tabindex="0"><view class="career-application-main"><text class="career-job-company">{{ item.jobSnapshot.company }}</text><text class="career-job-title">{{ item.jobSnapshot.title }}</text><text class="career-caption">{{ item.resumeSnapshot.title }} · V{{ item.resumeSnapshot.revision }} · {{ date(item.updatedAt) }}</text></view><view class="career-application-status"><text class="career-tag" :class="item.status">{{ applicationStatusLabels[item.status] }}</text><text>手动记录<AppIcon name="chevron" :size="12" /></text></view></button></view>
      </template>
    </template>

    <AppModal v-if="modal === 'job' && activeJob" :title="activeJob.title" :subtitle="`${activeJob.company} · ${activeJob.major} · ${activeJob.location}`" wide @close="closeModal">
      <view class="career-detail-meta"><text class="career-tag">{{ activeJob.origin === 'personal' ? '个人添加的目标岗位' : '公司岗位资料库' }}</text><text class="career-caption">{{ activeJob.deadline ? `截止日期 ${activeJob.deadline}（北京时间）` : '未填写截止日期，请自行核实' }}</text></view>
      <view v-if="activeJob.companyOverview" class="career-detail-section"><text class="career-section-title">公司信息</text><text class="career-prose">{{ activeJob.companyOverview }}</text></view>
      <view class="career-detail-section"><text class="career-section-title">岗位描述</text><text class="career-prose">{{ activeJob.description }}</text></view>
      <view class="career-source-box"><text>来源：{{ activeJob.sourceLabel }} · 更新 {{ date(activeJob.updatedAt) }}</text><button v-if="activeJob.sourceUrl" class="text-button" @click="copySource(activeJob.sourceUrl)" role="button" tabindex="0">复制来源链接<AppIcon name="copy" :size="14" /></button></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view v-if="!jobAcceptingPlans(activeJob)" class="career-preview"><AppIcon name="info" :size="16" /><text>该岗位已关闭或超过截止日期，不能新建投递计划。</text></view>
      <view class="career-detail-actions"><button class="button secondary" :disabled="busy" @click="c.favorite(activeJob.id, !favoriteSet.has(activeJob.id))" role="button" tabindex="0">{{ favoriteSet.has(activeJob.id) ? '取消收藏' : '收藏岗位' }}</button><button class="button secondary" :disabled="busy" @click="tailorJob(activeJob)" role="button" tabindex="0">对照岗位优化</button><button class="button primary" :disabled="busy || !jobAcceptingPlans(activeJob)" @click="beginPlan" role="button" tabindex="0">建立投递计划<AppIcon name="arrow" :size="16" /></button></view>
      <view v-if="activeJob.origin === 'personal'" class="career-delete-line"><text>删除岗位前，请先删除关联投递记录。</text><button class="text-button career-danger" :disabled="busy" @click="askDeleteJob" role="button" tabindex="0">删除个人岗位</button></view>
    </AppModal>

    <AppModal v-if="modal === 'job-form'" title="添加目标岗位" subtitle="填写你找到的真实公司和岗位，仅保存在你的账号中。" wide @close="closeModal">
      <view class="career-form-grid"><view><text class="field-label">公司名称</text><input v-model="jobForm.company" class="text-input" placeholder="填写公司全称" :maxlength="100" :disabled="busy" aria-label="公司名称" /></view><view><text class="field-label">岗位名称</text><input v-model="jobForm.title" class="text-input" placeholder="填写招聘岗位" :maxlength="100" :disabled="busy" aria-label="岗位名称" /></view><view><text class="field-label">专业方向</text><input v-model="jobForm.major" class="text-input" placeholder="例如：计算机、会计、机械" :maxlength="60" :disabled="busy" aria-label="专业方向" /></view><view><text class="field-label">工作地点</text><input v-model="jobForm.location" class="text-input" placeholder="城市或远程要求" :maxlength="100" :disabled="busy" aria-label="工作地点" /></view></view>
      <view class="career-form-field"><text class="field-label">岗位描述与要求</text><textarea v-model="jobForm.description" class="large-textarea career-description-input" placeholder="粘贴实际职责、任职要求等内容。" :maxlength="inputLimits.jobDescription" :disabled="busy" aria-label="岗位描述与要求" /></view>
      <view class="career-form-field"><text class="field-label">公司介绍（选填）</text><textarea v-model="jobForm.companyOverview" class="large-textarea career-note-input" placeholder="保留有来源的公司信息，不填写推测内容。" :maxlength="5000" :disabled="busy" aria-label="公司介绍" /></view>
      <view class="career-form-grid"><view><text class="field-label">来源链接（选填）</text><input v-model="jobForm.sourceUrl" class="text-input" placeholder="https://…" :maxlength="2000" :disabled="busy" aria-label="岗位来源链接" /></view><view><text class="field-label">截止日期（选填）</text><input v-model="jobForm.deadline" class="text-input" placeholder="YYYY-MM-DD" :maxlength="10" :disabled="busy" aria-label="岗位截止日期" /></view></view>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><text>保存后可收藏、对照优化并建立投递计划。</text><button class="button primary" :disabled="busy" @click="saveJob" role="button" tabindex="0">{{ busy ? '正在保存…' : '保存目标岗位' }}<AppIcon name="check" :size="16" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'plan-new' && activeJob" title="审核这次投递计划" :subtitle="`${activeJob.company} · ${activeJob.title}`" wide @close="closeModal">
      <view class="career-preview"><AppIcon name="shield" :size="17" /><text>保存计划会保留所选简历的当前版本，不会向公司发送内容。</text></view>
      <view class="career-resume-toolbar"><text class="field-label">选择已保存的简历</text><button class="text-button" :disabled="resumeLoading || busy" @click="refreshResumes" role="button" tabindex="0">{{ resumeLoading ? '读取中…' : '读取最新版本' }}</button></view>
      <picker v-if="savedResumes.length" :range="resumeLabels" :value="resumeIndex" :disabled="busy || resumeLoading" @change="pickResume"><view class="career-picker career-resume-picker">{{ chosenResume ? `${chosenResume.title} · V${chosenResume.revision}` : '请选择简历' }}<AppIcon name="chevron" :size="15" /></view></picker>
      <view v-else class="career-inline-empty"><text>先保存一份自己的真实简历，再建立计划。</text><button class="button secondary" :disabled="busy" @click="createResume" role="button" tabindex="0">创建简历</button></view>
      <template v-if="chosenResume"><text class="career-caption career-snapshot-caption">以下正文将作为本次计划的固定快照</text><text class="career-prose career-resume-snapshot">{{ chosenResume.text }}</text><button class="career-checkbox" role="checkbox" :aria-checked="resumeReviewed" :disabled="busy || resumeLoading" @click="resumeReviewed = !resumeReviewed" tabindex="0"><view class="career-check-square" :class="{ checked: resumeReviewed }"><AppIcon v-if="resumeReviewed" name="check" :size="13" /></view><text>我已核对这份 V{{ chosenResume.revision }} 简历的正文，确认使用真实内容建立计划。</text></button></template>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="text-button" :disabled="busy" @click="modal = 'job'" role="button" tabindex="0">返回岗位</button><button class="button primary" :disabled="busy || resumeLoading || !chosenResume || !resumeReviewed" @click="savePlan" role="button" tabindex="0">{{ busy ? '正在保存…' : '保存投递计划' }}<AppIcon name="check" :size="16" /></button></view>
    </AppModal>

    <AppModal v-if="modal === 'application' && activeApplication" :title="activeApplication.jobSnapshot.title" :subtitle="`${activeApplication.jobSnapshot.company} · 投递计划`" wide @close="closeModal">
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
      <view class="career-detail-section"><text class="career-section-title">手动更新进度</text><text class="career-caption">请根据自己已完成的真实操作和收到的结果更新。</text><view v-if="applicationTransitions[activeApplication.status].length" class="career-status-actions"><button v-for="value in applicationTransitions[activeApplication.status]" :key="value" class="button secondary" :disabled="busy || (value === 'applied' && (currentSnapshotChanged || resumeLoading))" @click="askStatus(value)" role="button" tabindex="0">{{ value === 'applied' ? '我已自行投递' : `记录为${applicationStatusLabels[value]}` }}</button></view><text v-else class="career-caption">该记录已结束，可保留复盘备注或删除。</text></view>
      <view class="career-history"><text class="career-section-title">进度记录</text><view v-for="(event, index) in activeApplication.history" :key="`${event.at}-${index}`"><view class="career-history-dot" /><text>{{ applicationStatusLabels[event.status] }}</text><text>{{ date(event.at) }} · 用户记录</text></view></view>
      <view v-if="visibleError" class="career-alert" role="alert"><text>{{ visibleError }}</text><button class="text-button" :disabled="busy || loading" @click="c.load" role="button" tabindex="0">重新读取记录</button></view>
      <view class="career-delete-line"><text>本记录不会自动跟踪招聘方反馈。</text><button class="text-button career-danger" :disabled="busy" @click="askDeleteApplication" role="button" tabindex="0">删除记录</button></view>
    </AppModal>

    <AppModal v-if="modal === 'material' && activeMaterial" :title="activeMaterial.title" :subtitle="`${activeMaterial.major} · ${activeMaterial.role}`" wide @close="closeModal">
      <text class="career-material-summary">{{ activeMaterial.summary }}</text><text class="career-prose career-material-content">{{ activeMaterial.content }}</text><view class="career-source-box"><text>来源：{{ activeMaterial.sourceLabel }} · 整理 / 更新 {{ date(activeMaterial.updatedAt) }}</text><button v-if="activeMaterial.sourceUrl" class="text-button" @click="copySource(activeMaterial.sourceUrl)" role="button" tabindex="0">复制来源链接<AppIcon name="copy" :size="14" /></button></view><view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
    </AppModal>

    <AppModal v-if="modal === 'confirm'" :title="confirmation === 'status' ? '确认手动更新进度' : confirmation === 'delete-job' ? '删除这个个人岗位？' : '删除这条投递记录？'" subtitle="核对后再保存。" @close="cancelConfirmation">
      <template v-if="confirmation === 'status' && activeApplication"><text class="career-confirm-title">{{ activeApplication.jobSnapshot.company }} · {{ activeApplication.jobSnapshot.title }}</text><text class="career-prose">进度将从“{{ applicationStatusLabels[activeApplication.status] }}”更新为“{{ applicationStatusLabels[nextStatus] }}”。</text><button v-if="nextStatus === 'applied'" class="career-checkbox" role="checkbox" :aria-checked="manualSubmitted" :disabled="busy" @click="manualSubmitted = !manualSubmitted" tabindex="0"><view class="career-check-square" :class="{ checked: manualSubmitted }"><AppIcon v-if="manualSubmitted" name="check" :size="13" /></view><text>我已自行完成真实投递，并确认使用了计划中的简历版本。本操作仅保存进度记录。</text></button></template>
      <text v-else-if="confirmation === 'delete-job'" class="career-prose">将删除这个账号下的个人岗位及收藏。关联投递记录需要先单独删除。</text>
      <text v-else class="career-prose">将删除投递进度、备注及这条记录保存的简历快照，无法恢复。已经自行完成的外部投递不会因此撤回。</text>
      <view v-if="visibleError" class="career-alert" role="alert">{{ visibleError }}</view>
      <view class="career-modal-footer"><button class="button secondary" :disabled="busy" @click="cancelConfirmation" role="button" tabindex="0">暂不修改</button><button class="button" :class="confirmation === 'status' ? 'primary' : 'danger'" :disabled="busy || (confirmation === 'status' && nextStatus === 'applied' && !manualSubmitted)" @click="confirmAction" role="button" tabindex="0">{{ busy ? '正在保存…' : confirmation === 'status' ? '确认保存进度' : '确认删除' }}</button></view>
    </AppModal>
  </view>
</template>

<style scoped>
.career-panel { min-width: 0; padding-bottom: 18px; color: #334b67; }
.career-heading,.career-row,.career-section-heading,.career-resume-toolbar,.career-modal-footer,.career-card-footer,.career-note-footer,.career-delete-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.career-heading { margin-bottom: 21px; align-items: flex-start; }.career-heading > view { min-width: 0; }
.career-eyebrow,.career-title,.career-subtitle,.career-caption,.career-job-title,.career-job-company,.career-excerpt,.career-source,.career-section-title { display: block; }
.career-eyebrow { font-size: 11px; color: #6d8cae; letter-spacing: .5px; }.career-title { font-size: 27px; font-weight: 600; letter-spacing: -.6px; margin-top: 10px; line-height: 1.5; }.career-subtitle { font-size: 12px; color: #748aa2; line-height: 1.8; margin-top: 8px; }.career-refresh { flex-shrink: 0; font-size: 12px; min-height: 39px; }
.career-preview,.career-notice,.career-alert { display: flex; align-items: flex-start; gap: 10px; padding: 14px 17px; border-radius: 13px; font-size: 12px; line-height: 1.8; margin-bottom: 18px; }.career-preview { background: #e7f2ffc7; border: 1px solid #ffffffc4; color: #607f9f; }.career-preview .app-icon,.career-notice .app-icon { margin-top: 3px; }.career-alert { color: #9b674f; border: 1px solid #edcfb9; background: #fff6ec; }.career-alert > text,.career-notice > text { flex: 1; }.career-alert .text-button { flex-shrink: 0; color: #9b674f; }.career-notice { color: #527b6c; background: #edf8f2; border: 1px solid #d6eadd; }.career-notice .icon-button { margin-left: auto; }
.career-tabs { display: flex; padding: 5px; background: #e5eff8aa; border: 1px solid #ffffffcc; border-radius: 15px; gap: 5px; margin: 23px 0; }.career-tabs > button { flex: 1; padding: 11px 8px; text-align: center; font-size: 13px; border-radius: 11px; color: #6d86a2; }.career-tabs > .active { color: #367bbd; background: #ffffffed; box-shadow: 0 2px 7px #4a739215; }
.career-counts { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; margin-bottom: 20px; }.career-count { padding: 24px 21px; border-radius: 18px; position: relative; }.career-count > text { display: block; }.career-count > text:first-child { color: #41678f; font-size: 32px; font-weight: 600; line-height: 1.2; }.career-count > text:nth-child(2) { color: #718aa4; font-size: 12px; margin-top: 10px; }.career-count > .app-icon { position: absolute; right: 20px; top: 27px; opacity: .5; }
.career-workflow { padding: 27px; border-radius: 19px; }.career-section-title { font-size: 16px; font-weight: 560; color: #3a526d; line-height: 1.7; }.career-step { display: flex; gap: 17px; align-items: center; padding-top: 24px; }.career-step > text { align-self: flex-start; font-size: 12px; color: #79a0c9; padding-top: 4px; }.career-step > view { flex: 1; min-width: 0; }.career-step > view > text { display: block; font-size: 13px; line-height: 1.8; }.career-step > view > text:last-child { font-size: 12px; color: #798da3; margin-top: 4px; }.career-step > button { flex-shrink: 0; font-size: 12px; }.career-catalog-note { display: flex; gap: 16px; align-items: center; padding: 23px; margin-top: 19px; border-radius: 18px; }.career-catalog-note > view { flex: 1; min-width: 0; }.career-catalog-note > view > text { display: block; font-size: 13px; line-height: 1.8; }.career-catalog-note > view > text:last-child { color: #7b8da2; font-size: 12px; margin-top: 5px; }.career-catalog-note > button { flex-shrink: 0; font-size: 12px; }
.career-section-heading { margin-bottom: 18px; }.career-caption { font-size: 12px; color: #7c8fa4; line-height: 1.8; margin-top: 5px; }.career-section-heading > .button { font-size: 12px; min-height: 41px; flex-shrink: 0; }.career-filters { display: flex; gap: 15px; padding: 13px 16px; align-items: center; margin-bottom: 20px; border-radius: 15px; }.career-search { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; }.career-search .app-icon { opacity: .55; }.career-search > input { width: 100%; font-size: 12px; height: 33px; }.career-picker { display: flex; align-items: center; justify-content: space-between; gap: 17px; font-size: 12px; color: #6984a1; padding: 9px 3px; }.career-filter-toggle { font-size: 12px; color: #7d92aa; border: 1px solid #dbe6f2; border-radius: 9px; padding: 8px 11px; flex-shrink: 0; }.career-filter-toggle.active { color: #397dbb; background: #eaf4ff; border-color: #a7cce9; }
.career-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; text-align: center; padding: 45px 25px; min-height: 240px; font-size: 15px; border-radius: 19px; }.career-empty > .app-icon { opacity: .6; }.career-empty .career-caption { max-width: 440px; margin: 0; }.career-empty .button { font-size: 12px; min-height: 39px; }
.career-job-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 17px; }.career-job-card { overflow: hidden; border-radius: 18px; display: flex; flex-direction: column; }.career-job-content { display: block; width: 100%; padding: 21px 22px 17px; flex: 1; }.career-job-company { color: #7b90a6; font-size: 12px; line-height: 1.8; }.career-job-title { color: #3a526e; font-size: 17px; font-weight: 560; line-height: 1.7; margin: 7px 0; }.career-tag { display: inline-block; font-size: 10px; line-height: 1.6; color: #5b89ae; background: #e7f3ff; padding: 4px 8px; border-radius: 7px; flex-shrink: 0; }.career-tag.closed,.career-tag.rejected,.career-tag.withdrawn { background: #edf0f3; color: #8b98a6; }.career-tag.interview,.career-tag.offer { background: #e6f5ed; color: #618e79; }.career-tag.applied { background: #edf0fd; color: #7a80b0; }.career-tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }.career-tags > text { font-size: 10px; padding: 3px 7px; border: 1px solid #e3ebf4; border-radius: 5px; color: #8094a9; }.career-excerpt { color: #748ba4; font-size: 12px; line-height: 1.9; white-space: pre-line; }.career-card-footer { padding: 14px 22px; border-top: 1px solid #e3ecf6; margin-top: auto; }.career-card-footer > text { font-size: 10px; color: #8c9bae; }.career-card-footer > button { font-size: 12px; }
.career-material-list,.career-application-list { display: flex; flex-direction: column; gap: 13px; }.career-material { display: flex; gap: 18px; padding: 24px; align-items: center; width: 100%; border-radius: 18px; }.career-material > view:nth-child(2) { flex: 1; min-width: 0; }.career-material-icon { display: flex; align-items: center; justify-content: center; width: 47px; height: 53px; border-radius: 13px; background: #e9f2fd; flex-shrink: 0; }.career-material .career-job-title { margin: 0 0 4px; }.career-source { font-size: 11px; color: #8b9bad; line-height: 1.8; margin-top: 11px; }
.career-status-filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }.career-status-filters > button { font-size: 12px; color: #7890aa; padding: 8px 12px; border: 1px solid #dce7f2; border-radius: 9px; background: #ffffff7a; }.career-status-filters > .active { color: #3c7cba; border-color: #a8c9e7; background: #eaf4ff; }.career-application { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 21px 23px; width: 100%; border-radius: 17px; }.career-application-main { min-width: 0; flex: 1; }.career-application .career-job-title { margin: 3px 0 6px; }.career-application-status { display: flex; flex-direction: column; align-items: flex-end; gap: 13px; flex-shrink: 0; }.career-application-status > text:last-child { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #8a9bb0; }
.career-detail-meta { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }.career-detail-section { margin: 23px 0; }.career-prose { display: block; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-size: 13px; color: #667d97; line-height: 2; margin-top: 11px; }.career-source-box { margin: 22px 0; background: #edf5fc; border: 1px solid #e2edf7; border-radius: 10px; padding: 14px 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }.career-source-box > text { font-size: 11px; line-height: 1.8; color: #7c91a8; }.career-source-box .text-button { font-size: 11px; }.career-detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; padding-top: 10px; }.career-detail-actions .button { font-size: 12px; min-height: 41px; }.career-delete-line { padding-top: 20px; margin-top: 22px; border-top: 1px solid #e4ebf4; }.career-delete-line > text { font-size: 11px; color: #8698ab; line-height: 1.8; }.career-delete-line > button { flex-shrink: 0; font-size: 11px; }.career-danger { color: #b18479; }
.career-form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; }.career-form-field { margin: 20px 0; }.career-description-input { height: 210px; }.career-note-input { height: 110px; }.career-modal-footer { margin-top: 24px; }.career-modal-footer > text { font-size: 11px; line-height: 1.8; color: #8799ad; }.career-modal-footer .button { font-size: 12px; min-height: 41px; flex-shrink: 0; }.career-resume-toolbar { margin: 19px 0 10px; }.career-resume-toolbar .field-label { margin-bottom: 0; }.career-resume-toolbar .text-button { font-size: 11px; }.career-resume-picker { border: 1px solid #dce7f3; border-radius: 10px; padding: 12px 14px; background: #f6faff; }.career-resume-snapshot { border: 1px solid #e4ecf4; background: #f7fafde8; padding: 16px 18px; border-radius: 12px; max-height: 330px; overflow-y: auto; font-size: 12px; }.career-snapshot-caption { margin-top: 18px; }.career-checkbox { display: flex; align-items: flex-start; gap: 10px; margin: 17px 0; text-align: left; font-size: 12px; line-height: 1.9; color: #677f99; width: 100%; }.career-check-square { width: 19px; height: 19px; display: flex; align-items: center; justify-content: center; border: 1px solid #bed1e5; border-radius: 5px; background: #fff; flex-shrink: 0; margin-top: 2px; }.career-check-square.checked { border-color: #7faed8; background: #dfedfb; }.career-inline-empty { background: #f3f8fd; padding: 20px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 12px; color: #7890a9; line-height: 1.8; }.career-inline-empty .button { flex-shrink: 0; font-size: 12px; }.career-rebind { border-radius: 12px; border: 1px solid #dfe9f3; padding: 16px 18px; background: #f4f9ff88; }.career-warning { color: #ac8464; }.career-rebind > .button { font-size: 12px; min-height: 37px; }.career-note-footer { margin-top: 9px; }.career-note-footer > text { color: #98a7b8; font-size: 10px; }.career-note-footer .text-button { font-size: 11px; }.career-note-draft-actions { display: flex; flex-wrap: wrap; gap: 15px; justify-content: flex-end; margin-top: 12px; }.career-note-draft-actions .text-button { font-size: 11px; }.career-status-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 13px; }.career-status-actions .button { font-size: 12px; min-height: 39px; padding: 9px 12px; }.career-history { margin-top: 25px; }.career-history > view { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12px; color: #778da6; }.career-history > view > text:last-child { margin-left: auto; font-size: 10px; color: #92a3b7; }.career-history-dot { width: 6px; height: 6px; background: #aac7df; border-radius: 50%; }.career-material-summary { display: block; font-size: 13px; line-height: 1.9; color: #8a9bae; margin-bottom: 21px; }.career-material-content { margin: 0; }.career-confirm-title { display: block; font-size: 14px; line-height: 1.8; color: #57718f; margin-bottom: 12px; }
@media (max-width: 700px) {
  .career-title { font-size: 23px; }.career-heading { gap: 10px; }.career-refresh { padding: 9px 10px; font-size: 11px; }.career-refresh .app-icon { display: none; }.career-counts { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 11px; }.career-count { padding: 21px; }.career-tabs { gap: 2px; }.career-tabs > button { font-size: 12px; padding: 11px 3px; }.career-workflow { padding: 22px 18px; }.career-step { gap: 10px; align-items: flex-start; flex-wrap: wrap; }.career-step > view { flex-basis: calc(100% - 40px); }.career-step > button { margin-left: 28px; }.career-catalog-note { flex-wrap: wrap; padding: 20px 18px; gap: 12px; }.career-catalog-note > view { flex-basis: calc(100% - 40px); }.career-catalog-note > button { margin-left: 36px; }.career-section-heading { align-items: flex-start; flex-wrap: wrap; gap: 13px; }.career-section-heading > view { flex: 1; min-width: 180px; }.career-job-grid { grid-template-columns: minmax(0,1fr); }.career-filters { flex-wrap: wrap; gap: 9px 14px; padding: 12px 14px; }.career-search { flex-basis: 100%; }.career-filters > picker { flex: 1; }.career-job-content { padding: 21px 19px 17px; }.career-card-footer { padding: 13px 19px; }.career-material { padding: 20px 16px; gap: 12px; }.career-material-icon { width: 35px; height: 43px; border-radius: 10px; }.career-application { padding: 19px 16px; gap: 9px; }.career-application .career-job-title { font-size: 15px; }.career-caption,.career-excerpt,.career-subtitle,.career-preview,.career-alert,.career-notice,.career-step > view > text:last-child,.career-source-box > text { font-size: 12px; }.career-form-grid { grid-template-columns: minmax(0,1fr); gap: 16px; }.career-detail-actions > .button { flex: 1; min-width: 120px; }.career-modal-footer { flex-wrap: wrap; gap: 15px; }.career-modal-footer > text { flex-basis: 100%; }.career-modal-footer > .button { margin-left: auto; }.career-delete-line { flex-wrap: wrap; gap: 11px; }.career-delete-line > button { margin-left: auto; }.career-resume-snapshot { max-height: 280px; padding: 14px; font-size: 13px; }.career-checkbox { font-size: 13px; }.career-rebind { padding: 15px 13px; }.career-inline-empty { flex-wrap: wrap; }.career-history > view { flex-wrap: wrap; }.career-history > view > text:last-child { margin-left: 0; }
}
</style>
