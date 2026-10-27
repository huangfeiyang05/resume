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
  <AppModal title="简历版本记录" subtitle="对照历史内容，确认后保存为新版本。已有记录会保留，恢复后需要重新诊断。" wide @close="close">
    <view v-if="error" class="history-alert" role="alert"><text>{{ error }}</text><button class="text-button" :disabled="busy || loading" @click="h.load(resume.id)" role="button" tabindex="0">重新读取并核对</button></view>
    <view v-if="loading" class="history-empty" role="status"><view class="spinner" /><text>正在读取版本记录…</text></view>
    <template v-else-if="current">
      <text class="history-explanation">恢复会更新已保存的简历。当前设备上的未保存草稿会继续保留；之后编辑旧草稿时，需要核对最新版本再保存。</text>
      <view class="history-toolbar"><text class="subtle">{{ versions.length }} 条已保存记录 · 当前 V{{ current.revision }}</text><picker :range="versions.map(item => `V${item.revision} · ${sources[item.source]}`)" :value="Math.max(0, versions.findIndex(item => item.revision === selected?.revision))" :disabled="busy" @change="choose"><view class="history-picker">{{ selected ? `查看 V${selected.revision}` : '选择历史版本' }}<AppIcon name="chevron" :size="14" /></view></picker></view>
      <view v-if="detailLoading" class="history-empty" role="status"><text>正在读取历史正文…</text></view>
      <template v-else-if="selected">
        <view v-if="selected.source === 'baseline'" class="history-explanation">这是接入版本记录时保留的已知内容，更早的修订未留存，无法还原。</view>
        <view class="history-comparison">
          <view class="history-column"><view class="history-column-label">当前 V{{ current.revision }}<text>已保存正文</text></view><text class="history-name">{{ current.title }}</text><text class="subtle">目标岗位：{{ current.targetRole || '未设置' }}</text><text class="history-body">{{ current.text }}</text></view>
          <view class="history-column historical"><view class="history-column-label">历史 V{{ selected.revision }}<text>{{ sources[selected.source] }} · {{ date(selected.recordedAt) }}</text></view><text class="history-name">{{ selected.snapshot.title }}</text><text class="subtle">目标岗位：{{ selected.snapshot.targetRole || '未设置' }}</text><text class="history-body">{{ selected.snapshot.text }}</text></view>
        </view>
        <text v-if="sameContent" class="history-explanation">这条记录的名称、岗位和正文与当前一致，无需恢复。</text>
        <text v-else-if="incomplete" class="history-explanation">历史正文含待补充事实，请在编辑器中填写真实内容后保存。</text>
        <button v-else class="history-review" :disabled="busy" :aria-pressed="reviewed" @click="reviewed = !reviewed" role="button" tabindex="0"><AppIcon :name="reviewed ? 'check' : 'shield'" :size="18" /><text>我已核对两份内容，确认历史版本中的信息真实、完整，并同意将其保存为新版本。</text></button>
        <view class="modal-footer"><button class="button secondary" :disabled="busy" @click="close" role="button" tabindex="0">保留当前版本</button><button class="button primary" :disabled="busy || !reviewed || sameContent || incomplete" @click="restore" role="button" tabindex="0">{{ busy ? '正在保存…' : '确认恢复为新版本' }}<AppIcon name="undo" :size="16" /></button></view>
      </template>
      <view v-else-if="!error" class="history-empty"><text>暂无可读取的版本记录。</text></view>
    </template>
  </AppModal>
</template>

<style scoped>
.history-alert{padding:14px 16px;background:#fff5e6;color:#8a5714;border-radius:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}.history-empty{padding:40px 16px;display:flex;gap:12px;align-items:center;justify-content:center;color:#667085}.history-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.history-picker{display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid #dce2e8;border-radius:10px;color:#334155}.history-comparison{display:grid;grid-template-columns:1fr 1fr;gap:16px}.history-column{padding:18px;border:1px solid #e2e7ed;border-radius:14px;min-width:0;display:flex;flex-direction:column;gap:12px}.history-column.historical{background:#f6f9fc}.history-column-label{display:flex;flex-direction:column;gap:5px;font-size:15px;font-weight:600;color:#334155}.history-column-label text{font-size:12px;font-weight:400;color:#718096}.history-name{font-size:16px;font-weight:600;color:#172b4d}.history-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.8;color:#37475a;max-height:48vh;overflow-y:auto;display:block}.history-explanation{display:block;margin:14px 0;padding:13px 15px;border-radius:10px;background:#f2f5f8;color:#617184;font-size:13px;line-height:1.7}.history-review{display:flex;gap:10px;align-items:flex-start;text-align:left;margin:18px 0 0;padding:14px;border:1px solid #d8e2ee;border-radius:11px;background:#f5f9fe;color:#3a587c;font-size:13px;line-height:1.7}.history-review[aria-pressed=true]{border-color:#6d9ed7;background:#edf5ff}@media(max-width:680px){.history-comparison{grid-template-columns:1fr}.history-toolbar{align-items:flex-start;flex-wrap:wrap}.history-body{max-height:35vh}.history-column{padding:14px}}
</style>
