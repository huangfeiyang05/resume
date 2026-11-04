<script setup lang="ts">
import { ref } from 'vue';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';
import { resumeTemplates, type ResumeWordTemplate } from '../data/resumeTemplates';
import type { ResumeExportTemplate } from '../../shared/resume-layout';

defineProps<{ selectedLayout: ResumeExportTemplate; loadingId?: string }>();
const emit = defineEmits<{
  download: [template: ResumeWordTemplate];
  select: [template: ResumeWordTemplate];
  previewResume: [];
}>();
const previewTemplate = ref<ResumeWordTemplate>();

function choosePreviewLayout() {
  if (!previewTemplate.value) return;
  emit('select', previewTemplate.value);
  previewTemplate.value = undefined;
}
</script>

<template>
  <view id="template-section" class="glass-panel flow-card resume-layout-library">
    <view class="flow-card-heading layout-library-heading">
      <view class="layout-library-heading-copy">
        <text class="flow-card-title">简历布局</text>
      </view>
      <text class="layout-library-count">3 款布局</text>
    </view>

    <view class="layout-template-grid">
      <view v-for="item in resumeTemplates" :key="item.id" class="layout-template-card" :class="[`layout-${item.layout}`, { selected: selectedLayout === item.layout }]">
        <button class="layout-template-preview" :aria-label="`选择${item.name}布局`" :aria-pressed="selectedLayout === item.layout" @click="emit('select', item)" role="button" tabindex="0">
          <image class="layout-template-image" :src="item.previewUrl" mode="widthFix" :alt="`${item.name}完整预览，展示个人信息、照片位和各简历栏目`" :aria-label="`${item.name}完整简历预览`" />
        </button>

        <button class="layout-template-choice" :aria-label="`选择${item.name}，${item.caption}`" :aria-pressed="selectedLayout === item.layout" @click="emit('select', item)" role="button" tabindex="0">
          <view class="layout-template-title-copy">
            <text class="layout-template-name">{{ item.name }}</text>
            <text class="layout-template-caption">{{ item.caption }}</text>
          </view>
          <view class="layout-selection-state" aria-hidden="true"><view class="layout-radio">{{ selectedLayout === item.layout ? '✓' : '' }}</view><text v-if="selectedLayout === item.layout">已选</text></view>
        </button>

        <view class="layout-template-actions">
          <button class="layout-view-button" :aria-label="`查看${item.name}版式`" @click="previewTemplate = item" role="button" tabindex="0">查看版式<AppIcon name="arrow" :size="12" /></button>
          <button class="layout-download-button" :disabled="!!loadingId" :aria-label="`下载${item.name} Word 模板`" :aria-busy="loadingId === item.id" @click="emit('download', item)" role="button" tabindex="0"><AppIcon name="download" :size="13" />{{ loadingId === item.id ? '准备中…' : '下载 Word' }}</button>
        </view>
      </view>
    </view>

    <view class="layout-library-footer">
      <button class="layout-own-preview" @click="emit('previewResume')" role="button" tabindex="0">预览我的简历<AppIcon name="arrow" :size="14" /></button>
    </view>
  </view>

  <AppModal v-if="previewTemplate" :title="previewTemplate.name" subtitle="模板预览" wide @close="previewTemplate = undefined">
    <view class="layout-modal-toolbar">
      <view class="layout-modal-actions">
        <button class="layout-view-button layout-modal-select" @click="choosePreviewLayout" role="button" tabindex="0">使用此布局</button>
        <button class="layout-download-button" :disabled="!!loadingId" :aria-label="`下载${previewTemplate.name} Word 模板`" :aria-busy="loadingId === previewTemplate.id" @click="emit('download', previewTemplate)" role="button" tabindex="0"><AppIcon name="download" :size="15" />{{ loadingId === previewTemplate.id ? '准备中…' : '下载 Word' }}</button>
      </view>
    </view>
    <view class="layout-modal-document">
      <image class="layout-modal-image" :src="previewTemplate.previewUrl" mode="widthFix" :alt="`${previewTemplate.name}完整页面，包含个人信息、照片位、教育背景、技能、证书、经历与自我评价`" :aria-label="`${previewTemplate.name}完整页面预览`" />
    </view>
  </AppModal>
</template>

<style scoped>
.resume-layout-library { margin-top: 24px; min-width: 0; }
.layout-library-heading { align-items: center; }
.layout-library-heading-copy { flex: 1; min-width: 0; }
.layout-library-count { flex-shrink: 0; padding: 5px 9px; border: 1px solid #d8dfe8; border-radius: 6px; color: #536174; background: #f4f6f9; font-size: 13px; white-space: nowrap; }
.layout-template-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 18px; }
.layout-template-card { min-width: 0; overflow: hidden; border: 1px solid var(--glass-line); border-radius: 12px; background: var(--glass-surface); transition: border-color .18s; box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }
.layout-template-card.selected { border-color: #2458c5; box-shadow: 0 0 0 1px #2458c5, var(--glass-shadow); }
.layout-template-preview { display: block; position: relative; width: 100%; margin: 0; padding: 22px 24px; overflow: hidden; border: 0; border-radius: 0; background: rgba(232,240,250,.35); line-height: 0; cursor: pointer; }
.layout-template-preview::after,.layout-template-choice::after,.layout-view-button::after,.layout-download-button::after,.layout-own-preview::after { border: 0; }
.layout-template-preview:focus-visible,.layout-template-choice:focus-visible,.layout-view-button:focus-visible,.layout-download-button:focus-visible,.layout-own-preview:focus-visible { outline: 3px solid #2458c5; outline-offset: -3px; }
.layout-template-image { display: block; width: 100%; height: auto; border: 1px solid #d8dfe8; box-sizing: border-box; background: #fff; box-shadow: 0 3px 9px #18233712; }
.layout-template-choice { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; margin: 0; padding: 18px 17px 15px; border: 0; border-radius: 0; background: transparent; text-align: left; line-height: 1.6; cursor: pointer; }
.layout-template-title-copy { min-width: 0; }
.layout-template-name { display: block; color: #1f2937; font-size: 17px; font-weight: 600; }
.layout-template-caption { display: block; margin-top: 5px; color: #536174; font-size: 13px; }
.layout-selection-state { display: flex; align-items: center; flex-shrink: 0; gap: 6px; color: #2458c5; font-size: 12px; }
.layout-radio { display: flex; align-items: center; justify-content: center; width: 19px; height: 19px; box-sizing: border-box; border: 1px solid #aab5c5; border-radius: 50%; background: #fff; color: #fff; font-size: 13px; line-height: 1; }
.selected .layout-radio { border-color: #2458c5; background: #2458c5; }
.layout-template-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 17px; padding: 13px 0 16px; border-top: 1px solid #e2e7ef; }
.layout-view-button,.layout-download-button,.layout-own-preview { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 0; padding: 9px 11px; min-height: 40px; border: 1px solid transparent; border-radius: 8px; font-size: 14px; line-height: 1.5; white-space: nowrap; cursor: pointer; }
.layout-view-button { padding-left: 0; padding-right: 0; background: transparent; color: #2458c5; }
.layout-download-button { background: #f4f6f9; border-color: #d8dfe8; color: #38465a; }
.layout-download-button[disabled] { opacity: .6; cursor: wait; }
.layout-library-footer { display: flex; justify-content: flex-end; margin-top: 18px; }
.layout-own-preview { color: #2458c5; background: #edf2fb; border-color: #d4dff4; }
.layout-modal-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 18px; margin: 0 0 20px; }
.layout-modal-actions { display: flex; gap: 12px; }
.layout-modal-actions .layout-download-button,.layout-modal-select { min-height: 43px; padding-left: 16px; padding-right: 16px; font-size: 14px; }
.layout-modal-select { border-color: #d8dfe8; }
.layout-modal-document { padding: 20px; border: 1px solid #d8dfe8; border-radius: 12px; background: rgba(232,240,250,.35); }
.layout-modal-image { display: block; width: 100%; height: auto; margin: 0 auto; background: #fff; box-shadow: 0 3px 12px #18233716; }
@media (max-width: 1050px) and (min-width: 768px) { .layout-template-grid { gap: 14px; }.layout-template-preview { padding: 17px; background: rgba(232,240,250,.35); }.layout-template-choice { padding: 16px 13px; background: transparent; }.layout-template-actions { margin: 0 13px; gap: 5px; flex-direction: column; align-items: stretch; }.layout-view-button,.layout-download-button { padding: 9px 8px; }.layout-selection-state > text { display: none; } }
@media (max-width: 767px) {
 .resume-layout-library { margin-top: 20px; padding: 23px 18px 20px; }.layout-library-heading { gap: 10px; }.layout-library-count { padding: 4px 7px; font-size: 12px; }
 .layout-template-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }.layout-template-preview { padding: 14px 12px; background: rgba(232,240,250,.35); }.layout-template-choice { min-height: 80px; padding: 15px 12px; gap: 7px; align-items: flex-start; background: transparent; }.layout-template-name { font-size: 16px; }.layout-template-caption { font-size: 13px; }.layout-radio { width: 18px; height: 18px; margin-top: 4px; }.layout-selection-state > text { display: none; }
 .layout-template-actions { flex-direction: column; align-items: stretch; gap: 6px; margin: 0 12px; padding: 11px 0 13px; }.layout-view-button,.layout-download-button { min-height: 39px; padding: 7px 3px; font-size: 13px; }.layout-own-preview { width: 100%; min-height: 43px; }.layout-modal-actions { width: 100%; }.layout-modal-actions > button { flex: 1; }.layout-modal-document { margin: 0 -8px; padding: 10px; border-radius: 8px; background: rgba(232,240,250,.35); }
}
/* Phone cards keep the complete A4 thumbnail beside their actions. */
@media (max-width: 600px) {
  .resume-layout-library { padding: 20px 16px 17px; }
  .layout-library-heading { gap: 8px; margin-bottom: 16px; }
  .layout-library-count { padding: 4px 6px; }
  .layout-template-grid { grid-template-columns: minmax(0,1fr); gap: 12px; }
  .layout-template-card { display: grid; grid-template-columns: 96px minmax(0,1fr); grid-template-areas: "preview choice" "preview actions"; column-gap: 14px; row-gap: 12px; align-items: start; padding: 12px; }
  .layout-template-preview { grid-area: preview; align-self: start; width: 100%; padding: 0; border-radius: 5px; background: transparent; }
  .layout-template-image { width: 100%; height: auto; }
  .layout-template-choice { grid-area: choice; min-height: 0; padding: 1px 0 0; gap: 8px; align-items: flex-start; }
  .layout-template-title-copy { flex: 1; min-width: 0; }
  .layout-template-name { font-size: 16px; line-height: 1.55; }
  .layout-template-caption { margin-top: 4px; font-size: 13px; line-height: 1.6; }
  .layout-selection-state { margin-top: 2px; }
  .layout-radio { margin-top: 0; width: 19px; height: 19px; }
  .layout-template-actions { grid-area: actions; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 6px 8px; margin: 0; padding: 0; border-top: 0; min-width: 0; }
  .layout-view-button,.layout-download-button { min-height: 44px; padding: 8px; gap: 5px; font-size: 13px; }
  .layout-library-footer { margin-top: 14px; }
  .layout-own-preview { min-height: 44px; }
  .layout-modal-toolbar { margin-bottom: 14px; gap: 10px; }
  .layout-modal-actions { min-width: 0; flex-wrap: wrap; gap: 8px; }
  .layout-modal-actions > button { flex: 1 1 120px; min-width: 0; min-height: 44px; white-space: normal; text-align: center; }
  .layout-modal-document { margin: 0; padding: 7px; }
}
@media (max-width: 360px) {
  .resume-layout-library { padding-left: 12px; padding-right: 12px; }
  .layout-template-card { grid-template-columns: 80px minmax(0,1fr); column-gap: 11px; padding: 10px; }
  .layout-template-actions { gap: 4px 6px; }
  .layout-view-button,.layout-download-button { padding-left: 7px; padding-right: 7px; }
}
@media (prefers-reduced-motion: reduce) { .layout-template-card { transition: none; background: var(--glass-surface); border: 1px solid var(--glass-line); box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); } }
</style>
