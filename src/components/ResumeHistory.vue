<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import type { Resume, RestoreResumeResult, ResumeVersionSource } from '../../shared/types';
import AppModal from './AppModal.vue';
import AppIcon from './AppIcon.vue';
import { useResumeHistory } from '../services/resumeHistory';

const props = defineProps<{ resume: Resume }>();
const emit = defineEmits<{ close: []; restored: [result: RestoreResumeResult] }>();
const h = useResumeHistory();
const { current, versions, selected, loading, detailLoading, busy, reviewed, error, sameContent, incomplete } = h;
const sources: Record<ResumeVersionSource, string> = { created: '首次保存', edited: '编辑保存', suggestion: '采纳建议', restored: '恢复保存', baseline: '历史记录起点' };
function date(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? `${new Date(time + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16)} 北京时间` : '时间未知';
}
watch(() => props.resume.id, id => { void h.load(id); }, { immediate: true });
onUnmounted(h.dispose);
function close() { if (!busy.value) emit('close'); }
function choose(event: { detail: { value: string | number } }) {
  const item = versions.value[Number(event.detail.value)];
  if (item) void h.choose(item.revision);
}
async function restore() { const result = await h.restore(); if (result) emit('restored', result); }
</script>

<template>
  <AppModal title="简历版本记录" subtitle="核对内容后，恢复为新版本。" wide @close="close">
    <view v-if="error" class="history-alert" role="alert"><text>{{ error }}</text><button class="text-button" :disabled="busy || loading" @click="h.load(resume.id)" role="button" tabindex="0">重新读取并核对</button></view>
    <view v-if="loading" class="history-empty" role="status"><view class="spinner" /><text>正在读取版本记录…</text></view>
    <template v-else-if="current">
      <view class="history-toolbar"><text class="subtle">{{ versions.length }} 条已保存记录 · 当前 V{{ current.revision }}</text><picker :range="versions.map(item => `V${item.revision} · ${sources[item.source]}`)" :value="Math.max(0, versions.findIndex(item => item.revision === selected?.revision))" :disabled="busy" @change="choose"><view class="history-picker">{{ selected ? `查看 V${selected.revision}` : '选择历史版本' }}<AppIcon name="chevron" :size="14" /></view></picker></view>
      <view v-if="detailLoading" class="history-empty" role="status"><text>正在读取历史正文…</text></view>
      <template v-else-if="selected">
        <view v-if="selected.source === 'baseline'" class="history-explanation">更早版本未留存，当前记录是历史起点。</view>
        <view class="history-comparison">
          <view class="history-column"><view class="history-column-label">当前 V{{ current.revision }}<text>已保存正文</text></view><text class="history-name">{{ current.title }}</text><text class="subtle">目标岗位：{{ current.targetRole || '未设置' }}</text><text class="history-body">{{ current.text }}</text></view>
          <view class="history-column historical"><view class="history-column-label">历史 V{{ selected.revision }}<text>{{ sources[selected.source] }} · {{ date(selected.recordedAt) }}</text></view><text class="history-name">{{ selected.snapshot.title }}</text><text class="subtle">目标岗位：{{ selected.snapshot.targetRole || '未设置' }}</text><text class="history-body">{{ selected.snapshot.text }}</text></view>
        </view>
        <text v-if="sameContent" class="history-explanation">与当前版本一致，无需恢复。</text>
        <text v-else-if="incomplete" class="history-explanation">历史正文含待确认事实，请先在编辑器中补全。</text>
        <button v-else class="history-review" :disabled="busy" :aria-pressed="reviewed" @click="reviewed = !reviewed" role="button" tabindex="0"><AppIcon :name="reviewed ? 'check' : 'shield'" :size="18" /><text>已核对历史内容真实、完整，同意恢复为新版本。</text></button>
        <view class="modal-footer"><button class="button secondary" :disabled="busy" @click="close" role="button" tabindex="0">保留当前版本</button><button class="button primary" :disabled="busy || !reviewed || sameContent || incomplete" @click="restore" role="button" tabindex="0">{{ busy ? '正在保存…' : '确认恢复为新版本' }}<AppIcon name="undo" :size="16" /></button></view>
      </template>
      <view v-else-if="!error" class="history-empty"><text>暂无可读取的版本记录。</text></view>
    </template>
  </AppModal>
</template>

<style scoped>
.history-alert { padding: 15px 17px; border: 1px solid #e5cba7; background: #fff6e8; color: #7a4c13; border-radius: 10px; display: flex; gap: 14px; align-items: center; justify-content: space-between; margin-bottom: 18px; font-size: 14px; line-height: 1.8; }
.history-empty { padding: 42px 18px; display: flex; gap: 13px; align-items: center; justify-content: center; color: #536174; font-size: 15px; }
.history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
.history-toolbar > text { color: #536174; font-size: 14px; }
.history-picker { display: flex; align-items: center; gap: 14px; min-height: 44px; padding: 11px 15px; border: 1px solid #d8dfe8; background: #fff; border-radius: 10px; color: #1f2937; font-size: 14px; }
.history-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.history-column { padding: 22px; border: 1px solid var(--glass-line); background: var(--glass-surface); border-radius: 12px; min-width: 0; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }
.history-column.historical { background: rgba(232,242,255,.48); }
.history-column-label { display: flex; flex-direction: column; gap: 7px; font-size: 17px; font-weight: 600; color: #1f2937; }
.history-column-label text { font-size: 13px; font-weight: 400; color: #536174; line-height: 1.7; }
.history-name { font-size: 18px; font-weight: 600; color: #1f2937; line-height: 1.6; }
.history-column > .subtle { font-size: 14px; color: #536174; }
.history-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 16px; line-height: 1.9; color: #38465a; max-height: 48vh; overflow-y: auto; display: block; }
.history-explanation { display: block; margin: 16px 0; padding: 14px 16px; border: 1px solid #d8dfe8; border-radius: 10px; background: #f4f6f9; color: #536174; font-size: 14px; line-height: 1.8; }
.history-review { display: flex; gap: 11px; align-items: flex-start; text-align: left; margin: 20px 0 0; padding: 16px; border: 1px solid #d8dfe8; border-radius: 10px; background: #fff; color: #38465a; font-size: 15px; line-height: 1.8; }
.history-review .app-icon { margin-top: 4px; }
.history-review[aria-pressed=true] { border-color: #2458c5; background: #edf2fb; color: #2458c5; }
@media(max-width:680px) { .history-comparison { grid-template-columns: 1fr; }.history-toolbar,.history-alert { align-items: flex-start; flex-wrap: wrap; }.history-body { max-height: 35vh; font-size: 15px; }.history-column { padding: 18px; background: var(--glass-surface); border: 1px solid var(--glass-line); box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }.history-review { font-size: 14px; } }
</style>
