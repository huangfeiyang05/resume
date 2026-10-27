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
      <view class="flow-step">03</view>
      <view class="layout-library-heading-copy">
        <text class="flow-card-title">简历布局</text>
        <text class="flow-card-subtitle">选好风格，查看完整排版或下载编辑。</text>
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
      <text>已预留个人信息与照片位，学历、技能、证书和经历分区展示。</text>
      <button class="layout-own-preview" @click="emit('previewResume')" role="button" tabindex="0">预览我的简历<AppIcon name="arrow" :size="14" /></button>
    </view>
  </view>

  <AppModal v-if="previewTemplate" :title="previewTemplate.name" subtitle="完整布局预览 · 个人信息、照片位与分区排版" wide @close="previewTemplate = undefined">
    <view class="layout-modal-toolbar">
      <text>{{ previewTemplate.description }}</text>
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
.resume-layout-library { margin-top: 22px; min-width: 0; }
.layout-library-heading { align-items: center; }
.layout-library-heading-copy { flex: 1; min-width: 0; }
.layout-library-count { flex-shrink: 0; padding: 5px 9px; border: 1px solid #dce8f2; border-radius: 7px; color: #68839f; background: #f4f9fd; font-size: 10px; white-space: nowrap; }
.layout-template-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
.layout-template-card { --layout-accent: #37414b; --layout-tint: #eef0f2; min-width: 0; overflow: hidden; border: 1px solid #e0e7ee; border-radius: 14px; background: #fff; transition: border-color .18s,box-shadow .18s; }
.layout-template-card.layout-modern { --layout-accent: #5087b3; --layout-tint: #eaf3fa; }
.layout-template-card.layout-business { --layout-accent: #17324d; --layout-tint: #e4eaf0; }
.layout-template-card.selected { border-color: var(--layout-accent); box-shadow: 0 0 0 1px var(--layout-accent),0 4px 15px #3e57730b; }
.layout-template-preview { display: block; position: relative; width: 100%; margin: 0; padding: 20px 24px; overflow: hidden; border: 0; border-radius: 0; background: var(--layout-tint); line-height: 0; cursor: pointer; }
.layout-template-preview::after,.layout-template-choice::after,.layout-view-button::after,.layout-download-button::after,.layout-own-preview::after { border: 0; }
.layout-template-preview:focus-visible,.layout-template-choice:focus-visible,.layout-view-button:focus-visible,.layout-download-button:focus-visible,.layout-own-preview:focus-visible { outline: 2px solid #5e8eb7; outline-offset: -3px; }
.layout-template-image { display: block; width: 100%; height: auto; border: 1px solid #dce3ea; box-sizing: border-box; background: #fff; box-shadow: 0 5px 14px #455f781c; }
.layout-template-choice { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; margin: 0; padding: 15px 15px 13px; border: 0; border-radius: 0; background: #fff; text-align: left; line-height: 1.5; cursor: pointer; }
.layout-template-title-copy { min-width: 0; }
.layout-template-name { display: block; color: #344455; font-size: 14px; font-weight: 600; letter-spacing: -.2px; }
.layout-template-caption { display: block; margin-top: 5px; color: #8190a0; font-size: 10px; }
.layout-selection-state { display: flex; align-items: center; flex-shrink: 0; gap: 5px; color: var(--layout-accent); font-size: 9px; }
.layout-radio { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; box-sizing: border-box; border: 1px solid #cdd7e0; border-radius: 50%; background: #fff; color: #fff; font-size: 10px; line-height: 1; }
.selected .layout-radio { border-color: var(--layout-accent); background: var(--layout-accent); }
.layout-template-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 0 15px; padding: 12px 0 14px; border-top: 1px solid #edf1f5; }
.layout-view-button,.layout-download-button,.layout-own-preview { display: flex; align-items: center; justify-content: center; gap: 5px; margin: 0; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; font-size: 11px; line-height: 1.5; white-space: nowrap; cursor: pointer; }
.layout-view-button { padding-left: 0; padding-right: 0; background: transparent; color: #6a7e92; }
.layout-download-button { background: #f0f6fc; border-color: #dce7f1; color: #4a6d8e; }
.layout-download-button[disabled] { opacity: .55; cursor: wait; }
.layout-library-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 17px; }
.layout-library-footer > text { color: #8391a1; font-size: 10px; line-height: 1.8; }
.layout-own-preview { flex-shrink: 0; color: #50799b; background: #f1f7fc; border-color: #e0eaf2; }
.layout-modal-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: 0 0 18px; }
.layout-modal-toolbar > text { color: #6e8197; font-size: 12px; line-height: 1.8; }
.layout-modal-actions { display: flex; gap: 9px; flex-shrink: 0; }
.layout-modal-actions .layout-download-button,.layout-modal-select { min-height: 39px; padding-left: 14px; padding-right: 14px; font-size: 12px; }
.layout-modal-select { border-color: #dce7f1; }
.layout-modal-document { padding: 18px; border: 1px solid #e1e8ef; border-radius: 12px; background: #eaf0f6; }
.layout-modal-image { display: block; width: 100%; height: auto; margin: 0 auto; background: #fff; box-shadow: 0 4px 17px #3e587223; }
@media (max-width: 1050px) and (min-width: 768px) {
  .layout-template-grid { gap: 11px; }
  .layout-template-preview { padding: 15px; }
  .layout-template-choice { padding: 13px 11px; }
  .layout-template-actions { margin: 0 11px; gap: 4px; }
  .layout-view-button,.layout-download-button { padding: 8px 5px; font-size: 10px; }
  .layout-selection-state > text { display: none; }
}
@media (max-width: 767px) {
  .resume-layout-library { margin-top: 18px; padding: 21px 15px 17px; }
  .layout-library-heading { margin-left: 5px; margin-right: 5px; gap: 8px; }
  .layout-library-heading-copy .flow-card-subtitle { font-size: 9px; line-height: 1.7; }
  .layout-library-count { padding: 4px 6px; font-size: 8px; }
  .layout-template-grid { gap: 8px; }
  .layout-template-card { border-radius: 10px; }
  .layout-template-preview { padding: 10px 6px; }
  .layout-template-choice { min-height: 65px; padding: 10px 7px; gap: 3px; }
  .layout-template-name { font-size: 11px; letter-spacing: -.3px; white-space: nowrap; }
  .layout-template-caption { margin-top: 4px; font-size: 8px; }
  .layout-radio { width: 13px; height: 13px; font-size: 8px; }
  .layout-selection-state > text { display: none; }
  .layout-template-actions { flex-direction: column; align-items: stretch; gap: 4px; margin: 0 7px; padding: 7px 0 8px; }
  .layout-view-button,.layout-download-button { min-height: 34px; padding: 5px 2px; gap: 3px; font-size: 9px; }
  .layout-library-footer { align-items: flex-start; flex-direction: column; gap: 10px; margin: 14px 3px 0; }
  .layout-library-footer > text { font-size: 9px; }
  .layout-own-preview { width: 100%; min-height: 39px; box-sizing: border-box; font-size: 11px; }
  .layout-modal-toolbar { align-items: flex-start; flex-wrap: wrap; gap: 12px; }
  .layout-modal-toolbar > text { width: 100%; }
  .layout-modal-actions { width: 100%; }
  .layout-modal-actions > button { flex: 1; }
  .layout-modal-document { margin: 0 -8px; padding: 8px; border-radius: 9px; }
}
@media (max-width: 370px) {
  .layout-library-count { display: none; }
  .layout-template-grid { gap: 6px; }
  .layout-template-choice { flex-wrap: wrap; }
  .layout-selection-state { margin-left: auto; }
}
</style>
