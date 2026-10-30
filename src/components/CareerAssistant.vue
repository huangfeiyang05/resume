<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
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
const draft = ref(''), showResume = ref(false), notice = ref(''), contextOpen = ref(false), scrollAnchor = ref('');
const resumeOptions = computed(() => ['先不选简历', ...props.resumes.map(item => `${item.title} · V${item.revision}`)]);
const resumeIndex = computed(() => Math.max(0, props.resumes.findIndex(item => item.id === selectedResume.value?.id) + 1));
const resumeLabel = computed(() => selectedResume.value ? `${selectedResume.value.title} · V${selectedResume.value.revision}` : '未选择（可选）');
const requirementLabel = computed(() => {
  const value = requirements.value.trim();
  if (!value) return '未填写，点此补充';
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
});
const turnCount = computed(() => Math.floor(messages.value.length / 2));
const quickPrompts = ['结合我的简历，找适合的企业方向', '优先找应届生可以准备的岗位', '帮我检查简历还缺哪些事实'];
watch(() => props.resumes, values => {
  if (!selectedResume.value) return;
  const latest = values.find(item => item.id === selectedResume.value?.id);
  if (!latest) { assistant.selectResume(); showResume.value = false; notice.value = '之前选择的简历已移除，请重新选择。'; }
  else assistant.noteResumeUpdate(latest);
}, { deep: true });
watch(() => [selectedResume.value?.id, selectedResume.value?.revision, requirements.value], () => emit('contextChange'), { flush: 'sync' });
watch([() => messages.value.length, () => loading.value, () => pendingMessage.value], async () => {
  await nextTick();
  scrollAnchor.value = loading.value ? 'msg-typing' : pendingMessage.value ? 'msg-pending' : messages.value.length ? `msg-${messages.value[messages.value.length - 1].id}` : 'msg-welcome';
}, { flush: 'post' });
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
async function quickAsk(prompt: string) {
  if (loading.value || updatedResume.value) return;
  emit('contextChange');
  if (!(await assistant.send(prompt))) draft.value = prompt;
}
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
    <view class="assistant-head">
      <view class="assistant-avatar assistant-avatar-head"><AppIcon name="sparkles" :size="25" /></view>
      <view class="assistant-head-main">
        <view class="assistant-title-row"><text class="assistant-title">求职助手</text><text class="assistant-mode">本地规则 · 对话模式</text></view>
        <text class="assistant-caption">读取你选择的简历文本，按明确条件检索企业资料、给出准备方向；未确认的条件会单独列出。</text>
      </view>
      <button class="assistant-reset" :disabled="loading" @click="restart" role="button" tabindex="0"><AppIcon name="undo" :size="13" />清空</button>
    </view>

    <view class="assistant-context">
      <view class="assistant-context-row">
        <picker class="assistant-chip-picker" :range="resumeOptions" :value="resumeIndex" @change="pickResume">
          <view class="assistant-chip"><AppIcon name="file" :size="14" /><text class="assistant-chip-label">简历</text><text class="assistant-chip-value">{{ resumeLabel }}</text><AppIcon name="chevron" :size="12" /></view>
        </picker>
        <button class="assistant-chip assistant-chip-button" @click="contextOpen = !contextOpen" role="button" tabindex="0"><AppIcon name="edit" :size="14" /><text class="assistant-chip-label">求职要求</text><text class="assistant-chip-value">{{ requirementLabel }}</text></button>
        <button class="assistant-context-toggle" @click="contextOpen = !contextOpen" role="button" tabindex="0">{{ contextOpen ? '收起' : '调整' }}<AppIcon name="chevron" :size="12" /></button>
      </view>
      <view v-if="contextOpen" class="assistant-context-editor">
        <view class="assistant-editor-head">
          <text class="assistant-small-title">对话背景</text>
          <view class="assistant-editor-links">
            <button v-if="selectedResume" class="text-button" @click="showResume = !showResume" role="button" tabindex="0">{{ showResume ? '收起简历' : '查看简历' }}</button>
            <button v-else-if="!resumes.length" class="text-button" @click="emit('createResume')" role="button" tabindex="0">先创建简历<AppIcon name="plus" :size="12" /></button>
          </view>
        </view>
        <view v-if="showResume && selectedResume" class="assistant-resume-preview"><text class="assistant-caption">本次对话使用 V{{ selectedResume.revision }}。{{ selectedResume.targetRole ? `简历目标：${selectedResume.targetRole}` : '简历尚未填写目标岗位' }}</text><text class="assistant-prose" selectable>{{ selectedResume.text }}</text></view>
        <textarea :value="requirements" @input="changeRequirements" class="assistant-requirements" :maxlength="2000" placeholder="例如：2027届计算机本科，优先杭州或上海，想做后端开发，接受中小型企业。也可以补充行业、学历、城市等条件。" aria-label="求职要求" />
        <text class="assistant-help">更换简历或修改要求会开始新对话。只在本项目内读取所选简历；本次对话不会自动修改简历。</text>
      </view>
    </view>

    <view v-if="updatedResume" class="assistant-version-review">
      <view class="assistant-version-head"><AppIcon name="info" :size="16" /><text class="assistant-small-title">请先核对更新后的简历 · V{{ updatedResume.revision }}</text></view>
      <text class="assistant-caption">{{ updatedResume.title }}{{ updatedResume.targetRole ? ` · ${updatedResume.targetRole}` : '' }}</text>
      <text class="assistant-prose assistant-conflict-text" selectable>{{ updatedResume.text }}</text>
      <button class="button secondary" @click="reviewResume" role="button" tabindex="0">已核对，使用此版本重新开始</button>
    </view>

    <view class="assistant-chat" aria-live="polite">
      <view class="assistant-chat-head"><text class="assistant-chat-title">对话</text><text class="assistant-chat-meta">{{ turnCount ? `${turnCount} 轮对话` : '新的对话' }}</text></view>
      <scroll-view class="assistant-stream" scroll-y :scroll-into-view="scrollAnchor" :scroll-with-animation="true">
        <view class="assistant-stream-inner">
        <view v-if="!messages.length && !pendingMessage" id="msg-welcome" class="assistant-welcome">
          <view class="assistant-welcome-avatar"><AppIcon name="sparkles" :size="30" /></view>
          <text class="assistant-welcome-title">你好，我是求职助手</text>
          <text class="assistant-welcome-text">告诉我你想找什么方向的工作。我会对照所选简历文本和你填写的要求，检索企业历史资料并给出准备建议。可以先用下面的问题开始，也可以直接输入。</text>
          <view class="assistant-prompts"><button v-for="prompt in quickPrompts" :key="prompt" :disabled="loading || !!updatedResume" @click="quickAsk(prompt)" role="button" tabindex="0"><AppIcon name="sparkles" :size="13" /><text>{{ prompt }}</text><AppIcon name="arrow" :size="12" /></button></view>
        </view>

        <view v-for="item in messages" :id="`msg-${item.id}`" :key="item.id" class="assistant-turn" :class="item.role">
          <view class="assistant-avatar" :class="item.role"><AppIcon :name="item.role === 'user' ? 'user' : 'sparkles'" :size="17" /></view>
          <view class="assistant-turn-body">
            <text class="assistant-message-label">{{ item.role === 'user' ? '你' : '求职助手 · 本地规则' }}</text>
            <view class="assistant-bubble"><text class="assistant-message-content" selectable>{{ item.content }}</text></view>
            <view v-if="item.result" class="assistant-result">
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
            </view>
          </view>
        </view>

        <view v-if="pendingMessage" id="msg-pending" class="assistant-turn user">
          <view class="assistant-avatar user"><AppIcon name="user" :size="17" /></view>
          <view class="assistant-turn-body"><text class="assistant-message-label">你{{ loading ? '' : ' · 尚未完成' }}</text><view class="assistant-bubble"><text class="assistant-message-content" selectable>{{ pendingMessage }}</text></view></view>
        </view>
        <view v-if="loading" id="msg-typing" class="assistant-turn assistant">
          <view class="assistant-avatar assistant"><AppIcon name="sparkles" :size="17" /></view>
          <view class="assistant-turn-body"><text class="assistant-message-label">求职助手 · 本地规则</text><view class="assistant-bubble assistant-bubble-pending"><view class="assistant-typing"><view></view><view></view><view></view></view><text class="assistant-typing-text">{{ selectedResume ? '正在核对所选简历与资料…' : '正在检索企业资料…' }}</text></view></view>
        </view>
        </view>
      </scroll-view>
    </view>

    <view v-if="error" class="assistant-error" role="alert"><text>{{ error }}</text><button v-if="canRetry" class="text-button" :disabled="loading" @click="retry" role="button" tabindex="0">重试这次提问<AppIcon name="undo" :size="13" /></button></view>
    <text v-if="notice" class="assistant-notice" role="status">{{ notice }}</text>

    <view class="assistant-composer">
      <textarea v-model="draft" :maxlength="2000" class="assistant-question" :disabled="!!updatedResume" placeholder="继续提问，例如：帮我找杭州的软件企业，并检查简历准备方向" aria-label="向求职助手提问" />
      <view class="assistant-composer-bar">
        <text class="assistant-composer-hint">{{ loading ? '正在查询，请稍候…' : '本地规则回答 · 重要条件请自行核对' }}</text>
        <text v-if="draft" class="assistant-count">{{ draft.length }}/2000</text>
        <button class="assistant-send" :disabled="loading || !draft.trim() || !!updatedResume" @click="send" aria-label="发送问题" role="button" tabindex="0"><text>发送</text></button>
      </view>
    </view>
    <text class="assistant-footer">企业库包含历史资料，收录与文本匹配不表示当前在招或录用可能性。请以企业最新公告为准；简历建议须对照审核、确认后应用。</text>
  </view>
</template>

<style scoped>
.career-assistant{border-radius:24px;padding:25px 27px;min-width:0;overflow:hidden}
.assistant-head{display:flex;align-items:center;gap:13px;margin-bottom:16px}
.assistant-avatar{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex-shrink:0;border-radius:12px;background:linear-gradient(135deg,#eef6ff,#dbeaf9);border:1px solid #d6e6f5}
.assistant-avatar-head{width:52px;height:52px;border-radius:17px;background:linear-gradient(135deg,#e9f4ff,#d3e6fa);border-color:#cfe1f4;box-shadow:0 8px 22px #5a8cbe21}
.assistant-avatar.user{background:linear-gradient(135deg,#e8f4ee,#d6eadf);border-color:#cfe4d8}
.assistant-head-main{flex:1;min-width:0}
.assistant-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.assistant-title{font-size:20px;line-height:1.5;font-weight:600;color:#3f5976}
.assistant-mode{font-size:10px;line-height:1.7;color:#5c86ad;background:#eaf4fc;padding:4px 9px;border:1px solid #d8e8f6;border-radius:8px;flex-shrink:0}
.assistant-caption,.assistant-help,.assistant-footer{display:block;font-size:12px;color:#8297ad;line-height:1.9;overflow-wrap:anywhere}
.assistant-head .assistant-caption{margin-top:3px}
.assistant-reset{display:flex;align-items:center;gap:6px;flex-shrink:0;padding:8px 11px;font-size:11px;line-height:1.4;color:#8ba0b5;background:#f6fafd;border:1px solid #e3edf6;border-radius:10px}
.assistant-reset[disabled]{opacity:.45}
.assistant-context{padding:12px;background:linear-gradient(180deg,#f8fbff,#f2f8fd);border:1px solid #e2ebf4;border-radius:16px;margin-bottom:15px}
.assistant-context-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.assistant-chip-picker{max-width:100%;min-width:0}
.assistant-chip{display:flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:8px 11px;background:#fff;border:1px solid #dbe8f4;border-radius:10px;font-size:11px;line-height:1.5;color:#6d88a3;box-shadow:0 2px 8px #6084a60d}
.assistant-chip-button{text-align:left}
.assistant-chip-label{flex-shrink:0;font-size:10px;color:#9aacbf}
.assistant-chip-value{flex:1;min-width:0;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5d7a97}
.assistant-context-toggle{display:flex;align-items:center;gap:4px;margin-left:auto;padding:6px 4px;font-size:11px;line-height:1.4;color:#7c95ad}
.assistant-context-editor{margin-top:12px;padding-top:12px;border-top:1px dashed #dbe7f2}
.assistant-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
.assistant-editor-links{display:flex;align-items:center;gap:10px}
.assistant-small-title{display:block;font-size:11px;color:#6d88a3;line-height:1.9;margin-bottom:6px;font-weight:500}
.assistant-editor-head .assistant-small-title{margin-bottom:0}
.assistant-resume-preview{padding:12px 13px;background:#fff;border:1px solid #e0eaf4;border-radius:11px;margin-bottom:10px}
.assistant-prose{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.9;color:#6c859f;margin-top:9px;max-height:240px;overflow-y:auto;user-select:text;-webkit-user-select:text}
.assistant-requirements{width:100%;box-sizing:border-box;height:86px;padding:11px 12px;font-size:12px;color:#526f8d;line-height:1.85;background:#fff;border:1px solid #dbe8f4;border-radius:11px}
.assistant-help{font-size:10px;margin-top:8px;line-height:1.7}
.assistant-version-review{padding:14px 15px;background:#fff9ed;border:1px solid #edddc3;border-radius:12px;margin-bottom:15px}
.assistant-version-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.assistant-version-head .assistant-small-title{margin:0}
.assistant-version-review .button{font-size:11px;min-height:38px;margin-top:13px}
.assistant-conflict-text{max-height:220px}
.assistant-chat{position:relative;border:1px solid #e3edf6;border-radius:18px;background:linear-gradient(180deg,#f6fafe 0%,#fff 48%,#fbfdff 100%);overflow:hidden}
.assistant-chat-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid #eaf2f9}
.assistant-chat-title{font-size:10px;font-weight:600;letter-spacing:.12em;color:#7f9bb6}
.assistant-chat-meta{font-size:10px;color:#9daebe}
.assistant-stream{height:56vh;min-height:330px;max-height:620px;padding:0;box-sizing:border-box}
.assistant-stream-inner{padding:16px;box-sizing:border-box}
.assistant-welcome{max-width:560px;margin:0 auto;padding:10px 4px 20px;text-align:center}
.assistant-welcome-avatar{display:flex;align-items:center;justify-content:center;width:64px;height:64px;margin:10px auto 14px;border-radius:22px;background:linear-gradient(135deg,#eaf4ff,#d3e6fa);border:1px solid #cfe2f5;box-shadow:0 12px 28px #5a8cbe24}
.assistant-welcome-title{display:block;font-size:18px;font-weight:600;line-height:1.6;color:#44617f}
.assistant-welcome-text{display:block;margin-top:9px;font-size:12px;line-height:1.95;color:#8298ae;text-align:left}
.assistant-prompts{display:flex;flex-direction:column;gap:9px;margin-top:18px;text-align:left}
.assistant-prompts>button{display:flex;align-items:center;gap:9px;width:100%;padding:11px 13px;font-size:12px;line-height:1.6;color:#66829d;background:#fff;border:1px solid #dfe9f3;border-radius:12px;box-shadow:0 2px 10px #6084a60d;text-align:left}
.assistant-prompts>button>text{flex:1;min-width:0}
.assistant-prompts>button[disabled]{opacity:.5}
.assistant-turn{display:flex;align-items:flex-start;gap:10px;margin-bottom:18px;animation:assistant-rise .22s ease-out both}
.assistant-turn.user{flex-direction:row-reverse}
.assistant-turn-body{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:86%}
.assistant-turn.user .assistant-turn-body{align-items:flex-end}
.assistant-message-label{display:block;font-size:10px;line-height:1.5;color:#93a7ba}
.assistant-bubble{display:inline-block;max-width:100%;padding:11px 14px;background:#fff;border:1px solid #e2ebf4;border-radius:16px;border-bottom-left-radius:5px;box-shadow:0 4px 14px #5d82a60d}
.assistant-turn.user .assistant-bubble{background:linear-gradient(135deg,#4f8fd6,#3d79b8);border-color:#3d79b8;border-bottom-left-radius:16px;border-bottom-right-radius:5px}
.assistant-message-content{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.9;color:#5b7693;user-select:text;-webkit-user-select:text}
.assistant-turn.user .assistant-message-content{color:#fff}
.assistant-bubble-pending{display:flex;align-items:center;gap:10px;padding:12px 15px}
.assistant-typing{display:flex;align-items:center;gap:4px;flex-shrink:0}
.assistant-typing>view{width:6px;height:6px;border-radius:50%;background:#84a9cc;animation:assistant-typing 1.2s infinite ease-in-out}
.assistant-typing>view:nth-child(2){animation-delay:.15s}
.assistant-typing>view:nth-child(3){animation-delay:.3s}
.assistant-typing-text{font-size:11px;line-height:1.6;color:#8ba2b8}
.assistant-result{width:100%;margin-top:7px;padding:14px;background:#fff;border:1px solid #e3edf6;border-radius:14px;box-shadow:0 6px 20px #5d82a60d}
.assistant-result-binding{display:block;font-size:10px;color:#95a7ba;line-height:1.8}
.assistant-criteria,.assistant-unverified,.assistant-evidence{border-top:1px solid #e8eff7;padding-top:12px;margin-top:14px}
.assistant-criteria>text:last-child,.assistant-unverified>text:not(:first-child){display:block;font-size:11px;color:#8b9db0;line-height:1.9;overflow-wrap:anywhere}
.assistant-unverified>text:not(:first-child){color:#a38c6f}
.assistant-evidence>view{display:flex;align-items:flex-start;gap:10px;margin-top:8px;font-size:11px;line-height:1.9;color:#8b9caf}
.assistant-evidence>view>text:first-child{padding:1px 6px;background:#e8f2fb;border-radius:5px;color:#7595b0;flex-shrink:0}
.assistant-evidence>view>text:last-child{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.assistant-result-list{margin-top:17px}
.assistant-company{padding:15px 16px;border:1px solid #e3ecf5;border-radius:12px;background:#fbfdff;margin-top:10px}
.assistant-card-title{display:block;font-size:14px;color:#55718d;font-weight:500;line-height:1.8}
.assistant-tags{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}
.assistant-tags>text{font-size:10px;color:#7c98b0;background:#edf5fc;border-radius:5px;padding:3px 6px}
.assistant-company-summary{white-space:pre-wrap;margin-top:8px}
.assistant-link{padding-top:11px;margin-top:11px;border-top:1px solid #e9eff6}
.assistant-link>text{display:block;word-break:break-all;font-size:10px;color:#8fa6bb;line-height:1.9;user-select:text;-webkit-user-select:text}
.assistant-link .text-button,.assistant-card-action{font-size:11px;margin-top:8px}
.assistant-optimize{margin-top:16px;font-size:12px;min-height:40px}
.assistant-warning{display:block;color:#a78e6e;font-size:12px;line-height:1.8;margin-top:12px}
.assistant-error{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 14px;margin-top:12px;background:#fcf1ed;border:1px solid #f0ded7;border-radius:11px;font-size:12px;color:#ad8778;line-height:1.8}
.assistant-error .text-button{font-size:11px;flex-shrink:0}
.assistant-notice{display:block;padding:8px 11px;margin-top:10px;background:#f3f9f5;border:1px solid #dfeee5;border-radius:10px;font-size:11px;line-height:1.7;color:#7e9b8d}
.assistant-composer{margin-top:13px;padding:12px 13px 10px;background:#fff;border:1px solid #dbe8f4;border-radius:18px;box-shadow:0 12px 30px #5c84aa14}
.assistant-question{width:100%;height:62px;padding:1px 2px 0;box-sizing:border-box;font-size:13px;color:#526f8d;line-height:1.85;background:transparent}
.assistant-composer-bar{display:flex;align-items:center;gap:10px;margin-top:5px}
.assistant-composer-hint{flex:1;min-width:0;font-size:10px;line-height:1.6;color:#9bafc1}
.assistant-count{flex-shrink:0;font-size:10px;color:#a7b8c8}
.assistant-send{display:flex;align-items:center;justify-content:center;width:46px;height:46px;flex-shrink:0;border-radius:50%;background:linear-gradient(135deg,#4f8fd6,#3d79b8);color:#fff;border:none;padding:0;box-shadow:0 7px 18px #3e79b842}
.assistant-send>text{color:#fff;font-size:12px;line-height:1}
.assistant-send[disabled]{background:#e8f0f8;box-shadow:none}
.assistant-send[disabled]>text{color:#a8bccd}
.assistant-footer{font-size:10px;line-height:1.7;margin-top:11px;padding:0 3px;color:#9aabbd}
@keyframes assistant-typing{0%,100%{opacity:.35;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
@keyframes assistant-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
text[selectable]{user-select:text;-webkit-user-select:text}
@media(max-width:700px){
.career-assistant{padding:19px 15px;border-radius:21px}
.assistant-head{gap:10px;flex-wrap:wrap;margin-bottom:13px}
.assistant-avatar-head{width:42px;height:42px;border-radius:13px}
.assistant-title{font-size:17px}
.assistant-mode{font-size:9px}
.assistant-head .assistant-caption{font-size:10px;line-height:1.7}
.assistant-reset{font-size:10px;padding:7px 9px}
.assistant-context{padding:10px}
.assistant-context-row{gap:7px}
.assistant-chip{padding:7px 9px;flex:1}
.assistant-chip-picker{flex:1;min-width:0}
.assistant-chip-value{max-width:none}
.assistant-context-toggle{margin-left:0}
.assistant-context-editor{padding-top:10px}
.assistant-version-review{padding:12px}
.assistant-stream{height:54vh;min-height:300px}
.assistant-stream-inner{padding:13px}
.assistant-chat-head{padding:10px 13px}
.assistant-welcome{padding:6px 0 16px}
.assistant-welcome-avatar{width:56px;height:56px;border-radius:19px}
.assistant-welcome-title{font-size:17px}
.assistant-welcome-text{font-size:11px}
.assistant-turn-body{max-width:90%}
.assistant-message-content{font-size:12px}
.assistant-result{padding:12px}
.assistant-company{padding:13px 12px}
.assistant-evidence>view{flex-wrap:wrap;gap:4px}
.assistant-evidence>view>text:last-child{flex-basis:100%}
.assistant-resume-preview .assistant-prose{max-height:200px}
.assistant-composer{padding:11px 11px 9px}
.assistant-question{height:58px}
.assistant-composer-hint{font-size:9px}
.assistant-send{width:42px;height:42px}
}
</style>
