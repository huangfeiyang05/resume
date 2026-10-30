<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { CareerAssistantResult, CareerJob, CompanyRecord, Resume } from '../../shared/types';
import { useCareerAssistant } from '../services/careerAssistant';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ resumes: Resume[] }>();
const emit = defineEmits<{
  addCompany: [company: CompanyRecord]; createResume: [];
  tailorAssistantJob: [input: { job: CareerJob; resumeId?: string; revision?: number }];
  contextChange: [];
  optimize: [action: { resumeId: string; revision: number; targetRole: string }];
}>();
const assistant = useCareerAssistant();
const { selectedResume, updatedResume, requirements, messages, pendingMessage, loading, error, canRetry } = assistant;
const draft = ref(''), showResume = ref(false), notice = ref('');
const resumeOptions = computed(() => ['先不选简历', ...props.resumes.map(item => `${item.title} · V${item.revision}`)]);
const resumeIndex = computed(() => Math.max(0, props.resumes.findIndex(item => item.id === selectedResume.value?.id) + 1));
const quickPrompts = ['结合我的简历，找适合的企业方向', '优先找应届生可以准备的岗位', '帮我检查简历还缺哪些事实'];
watch(() => props.resumes, values => {
  if (!selectedResume.value) return;
  const latest = values.find(item => item.id === selectedResume.value?.id);
  if (!latest) { assistant.selectResume(); showResume.value = false; notice.value = '之前选择的简历已移除，请重新选择。'; }
  else assistant.noteResumeUpdate(latest);
}, { deep: true });
watch(() => [selectedResume.value?.id, selectedResume.value?.revision, requirements.value], () => emit('contextChange'), { flush: 'sync' });
onUnmounted(() => { emit('contextChange'); assistant.dispose(); });
function pickResume(event: { detail: { value: string | number } }) {
  assistant.selectResume(props.resumes[Number(event.detail.value) - 1]); showResume.value = false; notice.value = '';
}
function changeRequirements(event: unknown) {
  const input = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  const value = input.detail?.value ?? input.target?.value;
  if (typeof value === 'string') { assistant.setRequirements(value); notice.value = ''; }
}
async function send() { emit('contextChange'); const value = draft.value; if (await assistant.send(value)) { if (draft.value === value) draft.value = ''; } }
async function retry() { const value = pendingMessage.value; if (await assistant.retry()) { if (draft.value.trim() === value) draft.value = ''; } }
function reviewResume() { assistant.reviewUpdatedResume(); showResume.value = false; notice.value = '已选择核对后的简历版本，请重新发送问题。'; }
function copy(value: string) {
  uni.setClipboardData({ data: value, success: () => { notice.value = '链接已复制，请核对当前公告与招聘安排。'; }, fail: () => { notice.value = '复制失败，可手动复制卡片中的网址。'; } });
}
function companyTags(company: CompanyRecord) { return [...new Set([company.nature, ...company.industries, ...company.locations.slice(0, 4), ...company.directions.slice(0, 3)].filter(Boolean))]; }
function optimize(result: CareerAssistantResult) {
  if (loading.value || updatedResume.value || !result.action) return;
  const action = result.action;
  if (selectedResume.value?.id !== action.resumeId || selectedResume.value.revision !== action.revision) return;
  emit('optimize', { resumeId: action.resumeId, revision: action.revision, targetRole: action.targetRole });
}
function tailor(job: CareerJob) {
  if (loading.value || updatedResume.value) return;
  const resume = selectedResume.value;
  emit('tailorAssistantJob', { job, ...(resume ? { resumeId: resume.id, revision: resume.revision } : {}) });
}
function restart() { emit('contextChange'); assistant.reset(); draft.value = ''; notice.value = '已清空本次对话，简历和求职要求保留。'; }
</script>

<template>
  <view class="glass-panel career-assistant">
    <view class="assistant-heading">
      <view class="assistant-heading-main"><view class="assistant-symbol"><AppIcon name="sparkles" :size="23" /></view><view><text class="assistant-title">求职助手</text><text class="assistant-caption">带上简历和求职要求，一起筛选企业、准备岗位、检查简历。</text></view></view>
      <text class="assistant-engine">本地规则助手</text>
    </view>
    <view class="assistant-context">
      <view class="assistant-context-top"><text class="assistant-label">选择本人的已保存简历</text><button v-if="selectedResume" class="text-button" @click="showResume = !showResume" role="button" tabindex="0">{{ showResume ? '收起简历' : '查看简历' }}</button><button v-else-if="!resumes.length" class="text-button" @click="emit('createResume')" role="button" tabindex="0">先创建简历<AppIcon name="plus" :size="13" /></button></view>
      <picker :range="resumeOptions" :value="resumeIndex" @change="pickResume"><view class="assistant-resume-picker"><AppIcon name="file" :size="16" /><text>{{ selectedResume ? `${selectedResume.title} · V${selectedResume.revision}` : '先不选简历，也可以按要求查找企业' }}</text><AppIcon name="chevron" :size="13" /></view></picker>
      <view v-if="showResume && selectedResume" class="assistant-resume-preview"><text class="assistant-caption">本次对话使用 V{{ selectedResume.revision }}。{{ selectedResume.targetRole ? `简历目标：${selectedResume.targetRole}` : '简历尚未填写目标岗位' }}</text><text class="assistant-prose" selectable>{{ selectedResume.text }}</text></view>
      <text class="assistant-label assistant-requirement-label">求职要求</text>
      <textarea :value="requirements" @input="changeRequirements" class="assistant-requirements" :maxlength="2000" placeholder="例如：2027届计算机本科，优先杭州或上海，想做后端开发，接受中小型企业。也可以补充行业、学历、城市等条件。" aria-label="求职要求" />
      <text class="assistant-help">更换简历或修改要求会开始新对话。只在本项目内读取所选简历；本次对话不会自动修改简历。</text>
    </view>

    <view v-if="updatedResume" class="assistant-version-review">
      <text class="assistant-label">请先核对更新后的简历 · V{{ updatedResume.revision }}</text><text class="assistant-caption">{{ updatedResume.title }}{{ updatedResume.targetRole ? ` · ${updatedResume.targetRole}` : '' }}</text><text class="assistant-prose assistant-conflict-text" selectable>{{ updatedResume.text }}</text>
      <button class="button secondary" @click="reviewResume" role="button" tabindex="0">已核对，使用此版本重新开始</button>
    </view>

    <view class="assistant-conversation" aria-live="polite">
      <view v-if="!messages.length && !pendingMessage" class="assistant-welcome"><text>你希望找什么样的工作？</text><text class="assistant-caption">我会按所选简历的文本和你的要求查询企业资料，也可以继续对照目标岗位检查简历。未被资料确认的条件会单独列出。</text><view class="assistant-prompts"><button v-for="prompt in quickPrompts" :key="prompt" @click="draft = prompt" role="button" tabindex="0">{{ prompt }}<AppIcon name="arrow" :size="13" /></button></view></view>
      <view v-for="item in messages" :key="item.id" class="assistant-message" :class="item.role">
        <text class="assistant-message-label">{{ item.role === 'user' ? '你' : '求职助手 · 本地规则' }}</text><text class="assistant-message-content" selectable>{{ item.content }}</text>
        <template v-if="item.result">
          <text v-if="item.result.resume" class="assistant-result-binding">已对照：{{ item.result.resume.title }} · V{{ item.result.resume.revision }}</text>
          <view v-if="item.result.criteria.query || Object.values(item.result.criteria.filters).some(values => values.length)" class="assistant-criteria"><text class="assistant-small-title">本次检索条件</text><text selectable>{{ [item.result.criteria.query, ...Object.values(item.result.criteria.filters).flat()].filter(Boolean).join(' · ') }}</text></view>
          <view v-if="item.result.evidence.length" class="assistant-evidence"><text class="assistant-small-title">简历中的文本依据 · 仅表示文本覆盖</text><view v-for="(evidence, index) in item.result.evidence" :key="`${evidence.term}-${index}`"><text>{{ evidence.term }}</text><text selectable>{{ evidence.excerpt }}</text></view></view>
          <view v-if="item.result.criteria.unverifiedRequirements.length" class="assistant-unverified"><text class="assistant-small-title">还需要核对</text><text v-for="(requirement, index) in item.result.criteria.unverifiedRequirements" :key="index" selectable>· {{ requirement }}</text></view>
          <view v-if="item.result.companies.length" class="assistant-result-list">
            <text class="assistant-small-title">相关企业资料 · 共 {{ item.result.companyTotal }} 条，本次展示 {{ item.result.companies.length }} 条</text>
            <view v-for="company in item.result.companies" :key="company.id" class="assistant-company">
              <text class="assistant-card-title" selectable>{{ company.name }}</text><view class="assistant-tags"><text v-for="tag in companyTags(company)" :key="tag" selectable>{{ tag }}</text></view>
              <text class="assistant-caption assistant-company-summary" selectable>{{ company.summary }}</text>
              <view v-if="company.recruitmentUrl" class="assistant-link"><text selectable>{{ company.recruitmentUrl }}</text><button class="text-button" @click="copy(company.recruitmentUrl)" role="button" tabindex="0">复制招聘链接<AppIcon name="copy" :size="13" /></button></view>
              <button class="text-button assistant-card-action" @click="emit('addCompany', company)" role="button" tabindex="0">核对公告后录入岗位<AppIcon name="plus" :size="13" /></button>
            </view>
          </view>
          <view v-if="item.result.personalJobs.length" class="assistant-result-list"><text class="assistant-small-title">你保存的相关目标岗位</text><view v-for="job in item.result.personalJobs" :key="job.id" class="assistant-company"><text class="assistant-card-title" selectable>{{ job.company }} · {{ job.title }}</text><text class="assistant-caption" selectable>{{ job.location }} · {{ job.major }}</text><text class="assistant-caption assistant-company-summary" selectable>{{ job.description }}</text><view v-if="job.sourceUrl" class="assistant-link"><text selectable>{{ job.sourceUrl }}</text><button class="text-button" @click="copy(job.sourceUrl)" role="button" tabindex="0">复制岗位链接<AppIcon name="copy" :size="13" /></button></view><button class="text-button assistant-card-action" :disabled="loading || !!updatedResume" @click="tailor(job)" role="button" tabindex="0">对照此岗位检查简历<AppIcon name="arrow" :size="13" /></button></view></view>
          <text v-if="item.result.catalogState === 'unavailable'" class="assistant-warning">企业资料暂时无法读取，可稍后重新提问。</text><text v-else-if="item.result.catalogState === 'empty'" class="assistant-caption">企业资料库暂时为空，可以先添加自己找到的真实目标岗位。</text>
          <button v-if="item.result.action" class="button secondary assistant-optimize" :disabled="loading || !!updatedResume" @click="optimize(item.result)" role="button" tabindex="0">进入简历诊断与审核<AppIcon name="arrow" :size="15" /></button>
        </template>
      </view>
      <view v-if="pendingMessage" class="assistant-message user"><text class="assistant-message-label">你{{ loading ? ' · 正在查询' : ' · 尚未完成' }}</text><text class="assistant-message-content" selectable>{{ pendingMessage }}</text></view>
      <view v-if="loading" class="assistant-pending"><AppIcon name="search" :size="16" /><text>正在核对所选简历与资料…</text></view>
    </view>

    <view v-if="error" class="assistant-error" role="alert"><text>{{ error }}</text><button v-if="canRetry" class="text-button" :disabled="loading" @click="retry" role="button" tabindex="0">重试这次提问<AppIcon name="undo" :size="13" /></button></view>
    <text v-if="notice" class="assistant-notice" role="status">{{ notice }}</text>
    <view class="assistant-composer"><textarea v-model="draft" :maxlength="2000" class="assistant-question" placeholder="告诉我你的问题，例如：帮我找杭州的软件企业，并检查简历准备方向" aria-label="向求职助手提问" /><view class="assistant-composer-actions"><button class="text-button" :disabled="loading" @click="restart" role="button" tabindex="0">清空对话</button><button class="button primary" :disabled="loading || !draft.trim() || !!updatedResume" @click="send" role="button" tabindex="0">{{ loading ? '查询中' : '发送' }}<AppIcon name="arrow" :size="16" /></button></view></view>
    <text class="assistant-footer">企业库包含历史资料，收录与文本匹配不表示当前在招或录用可能性。请以企业最新公告为准；简历建议须对照审核、确认后应用。</text>
  </view>
</template>

<style scoped>
.career-assistant{border-radius:21px;padding:27px 29px;min-width:0}.assistant-heading,.assistant-heading-main,.assistant-context-top,.assistant-resume-picker,.assistant-composer-actions{display:flex;align-items:center;gap:13px}.assistant-heading{justify-content:space-between;align-items:flex-start;margin-bottom:23px}.assistant-heading-main{align-items:flex-start}.assistant-symbol{display:flex;align-items:center;justify-content:center;width:46px;height:46px;flex-shrink:0;border-radius:14px;background:#e3effd}.assistant-title{display:block;font-size:20px;line-height:1.5;font-weight:600;color:#3f5976}.assistant-caption,.assistant-help,.assistant-footer{display:block;font-size:12px;color:#8297ad;line-height:1.9;overflow-wrap:anywhere}.assistant-heading .assistant-caption{margin-top:4px}.assistant-engine{font-size:10px;line-height:1.7;color:#6a91b3;background:#eaf4fc;padding:5px 9px;border:1px solid #d9e8f5;border-radius:7px;flex-shrink:0}.assistant-context{padding:19px 20px;background:#f5f9fd9c;border:1px solid #e2ebf4;border-radius:14px}.assistant-context-top{justify-content:space-between;margin-bottom:9px}.assistant-label{display:block;font-size:12px;color:#5c7793;font-weight:500;line-height:1.8}.assistant-context-top>.text-button{font-size:11px}.assistant-resume-picker{background:#fff9;border:1px solid #dfe9f3;padding:12px 13px;border-radius:10px;font-size:12px;color:#718aa4;min-width:0}.assistant-resume-picker>text{flex:1;min-width:0;overflow-wrap:anywhere}.assistant-requirement-label{margin-top:17px;margin-bottom:9px}.assistant-requirements,.assistant-question{font-size:12px;color:#526f8d;line-height:1.9;width:100%;box-sizing:border-box}.assistant-requirements{height:85px;padding:12px 13px;background:#fff9;border:1px solid #dfe9f3;border-radius:10px}.assistant-help{font-size:10px;margin-top:10px}.assistant-resume-preview,.assistant-version-review{padding:15px;background:#f1f7fd;border:1px solid #dbe8f4;border-radius:10px;margin-top:13px}.assistant-prose{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.9;color:#6c859f;margin-top:10px;max-height:270px;overflow-y:auto;user-select:text;-webkit-user-select:text}.assistant-version-review{background:#fff9ed;border-color:#edddc3}.assistant-version-review .button{font-size:11px;min-height:38px;margin-top:15px}.assistant-conflict-text{max-height:250px}.assistant-conversation{margin:25px 0}.assistant-welcome{padding:13px 4px 5px}.assistant-welcome>text:first-child{display:block;font-size:17px;color:#597590;margin-bottom:10px}.assistant-welcome>.assistant-caption{max-width:650px}.assistant-prompts{display:flex;flex-wrap:wrap;gap:8px;margin-top:17px}.assistant-prompts>button{display:flex;align-items:center;gap:8px;padding:9px 11px;font-size:11px;text-align:left;border:1px solid #e0eaf3;background:#f4f9fd;border-radius:9px;color:#7895ae;line-height:1.7}.assistant-message{padding:20px 21px;background:#f7faff;border:1px solid #e2ebf4;border-radius:14px;margin:15px 0;min-width:0}.assistant-message.user{margin-left:12%;background:#edf5ff;border-color:#dce9f8}.assistant-message-label{display:block;font-size:10px;line-height:1.8;color:#8ba2b9;margin-bottom:7px}.assistant-message-content{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.95;color:#5d7895;user-select:text;-webkit-user-select:text}.assistant-result-binding{display:block;font-size:10px;color:#95a7ba;line-height:1.8;margin-top:11px}.assistant-small-title{display:block;font-size:11px;color:#6d88a3;line-height:1.9;margin-bottom:8px}.assistant-criteria,.assistant-unverified,.assistant-evidence{border-top:1px solid #e3ebf4;padding-top:13px;margin-top:16px}.assistant-criteria>text:last-child,.assistant-unverified>text:not(:first-child){display:block;font-size:11px;color:#8b9db0;line-height:1.9;overflow-wrap:anywhere}.assistant-unverified>text:not(:first-child){color:#a38c6f}.assistant-evidence>view{display:flex;align-items:flex-start;gap:10px;margin-top:8px;font-size:11px;line-height:1.9;color:#8b9caf}.assistant-evidence>view>text:first-child{padding:1px 6px;background:#e8f2fb;border-radius:5px;color:#7595b0;flex-shrink:0}.assistant-evidence>view>text:last-child{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.assistant-result-list{margin-top:19px}.assistant-company{padding:17px 18px;border:1px solid #e0eaf4;border-radius:11px;background:#fff9;margin-top:11px}.assistant-card-title{display:block;font-size:14px;color:#55718d;font-weight:500;line-height:1.8}.assistant-tags{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}.assistant-tags>text{font-size:10px;color:#7c98b0;background:#edf5fc;border-radius:5px;padding:3px 6px}.assistant-company-summary{white-space:pre-wrap;margin-top:9px}.assistant-link{padding-top:12px;margin-top:12px;border-top:1px solid #e7edf4}.assistant-link>text{display:block;word-break:break-all;font-size:10px;color:#8fa6bb;line-height:1.9;user-select:text;-webkit-user-select:text}.assistant-link .text-button,.assistant-card-action{font-size:11px;margin-top:8px}.assistant-optimize{margin-top:18px;font-size:12px;min-height:40px}.assistant-pending{display:flex;align-items:center;gap:9px;font-size:12px;color:#8aa1b8;padding:10px 6px}.assistant-warning{display:block;color:#a78e6e;font-size:12px;line-height:1.8;margin-top:13px}.assistant-error{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 15px;background:#fcf1ed;border:1px solid #f0ded7;border-radius:10px;font-size:12px;color:#ad8778;line-height:1.8;margin:15px 0}.assistant-error .text-button{font-size:11px;flex-shrink:0}.assistant-notice{display:block;font-size:11px;line-height:1.8;color:#7e9b8d;margin:13px 0}.assistant-composer{border:1px solid #dbe7f2;border-radius:13px;background:#fff9;padding:14px 15px 11px}.assistant-question{height:80px}.assistant-composer-actions{justify-content:space-between;margin-top:7px}.assistant-composer-actions>.text-button{font-size:10px;color:#99aabd}.assistant-composer-actions>.button{font-size:12px;min-height:37px;padding:8px 18px}.assistant-footer{font-size:10px;color:#9aabbd;margin-top:13px}text[selectable]{user-select:text;-webkit-user-select:text}
@media(max-width:700px){.career-assistant{padding:21px 17px}.assistant-heading{gap:9px;flex-wrap:wrap}.assistant-heading-main{gap:11px}.assistant-symbol{width:39px;height:39px;border-radius:11px}.assistant-title{font-size:18px}.assistant-heading .assistant-caption{font-size:11px}.assistant-engine{margin-left:50px;font-size:9px}.assistant-context{padding:16px 13px}.assistant-message{padding:17px 14px}.assistant-message.user{margin-left:5%}.assistant-company{padding:15px 13px}.assistant-prompts{flex-direction:column}.assistant-prompts>button{justify-content:space-between}.assistant-evidence>view{flex-wrap:wrap;gap:4px}.assistant-evidence>view>text:last-child{flex-basis:100%}.assistant-requirements{height:120px}.assistant-question{height:100px}.assistant-caption,.assistant-message-content{font-size:12px}}
</style>
