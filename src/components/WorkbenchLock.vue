<script setup lang="ts">
import { computed } from 'vue';
import type { WorkbenchFeature } from '../../shared/types';
import { workbenchFeatureNames, workbenchRequiredPlan } from '../../shared/workbench';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ feature: WorkbenchFeature }>();
const emit = defineEmits<{ unlock: [] }>();
const name = computed(() => workbenchFeatureNames[props.feature]);
const plan = computed(() => workbenchRequiredPlan[props.feature] === 'basic' ? '初级会员' : '高级会员');
</script>

<template>
  <button class="glass-panel workbench-lock" :aria-label="`${name}，需升级至${plan}解锁`" @click="emit('unlock')" role="button" tabindex="0">
    <view class="workbench-lock-preview" aria-hidden="true">
      <view class="lock-preview-bar" /><view class="lock-preview-line short" />
      <view class="lock-preview-cards"><view v-for="item in 3" :key="item"><view class="lock-preview-dot" /><view class="lock-preview-line" /><view class="lock-preview-line short" /><view class="lock-preview-line" /></view></view>
      <view class="lock-preview-line" /><view class="lock-preview-line short" />
    </view>
    <view class="workbench-lock-cover">
      <view class="workbench-lock-icon"><AppIcon name="lock" :size="22" /></view>
      <text class="workbench-lock-title">{{ name }}</text>
      <text class="workbench-lock-description">升级至{{ plan }}，解锁此功能</text>
      <view class="workbench-lock-action">查看会员<AppIcon name="arrow" :size="14" /></view>
    </view>
  </button>
</template>

<style scoped>
.workbench-lock { display: block; position: relative; width: 100%; min-height: 305px; overflow: hidden; padding: 25px; border-radius: 18px; text-align: left; color: #536174; }
.workbench-lock-preview { filter: blur(3px); opacity: .34; pointer-events: none; user-select: none; }
.lock-preview-bar,.lock-preview-line { height: 11px; border-radius: 7px; background: #b5c0d0; width: 86%; margin-bottom: 13px; }.lock-preview-bar { width: 35%; height: 19px; margin-bottom: 20px; }.lock-preview-line.short { width: 57%; }
.lock-preview-cards { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 15px; margin: 21px 0; }.lock-preview-cards > view { padding: 16px; border: 1px solid #bbc7d8; border-radius: 12px; background: #f4f7fb; }.lock-preview-dot { width: 28px; height: 28px; background: #aabbd4; border-radius: 9px; margin-bottom: 16px; }
.workbench-lock-cover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; background: rgba(248,250,253,.63); padding: 24px; gap: 10px; box-sizing: border-box; }.workbench-lock-icon { display: flex; align-items: center; justify-content: center; height: 48px; width: 48px; border-radius: 16px; background: rgba(255,255,255,.9); border: 1px solid #dee5ef; }.workbench-lock-title { display: block; color: #26344a; font-size: 19px; font-weight: 600; }.workbench-lock-description { font-size: 14px; line-height: 1.8; text-align: center; }.workbench-lock-action { display: flex; align-items: center; gap: 7px; color: #2458c5; font-size: 14px; margin-top: 5px; }
@media(max-width:767px) { .workbench-lock { padding: 19px; min-height: 290px; }.lock-preview-cards { gap: 10px; }.lock-preview-cards > view { padding: 12px; }.workbench-lock-title { font-size: 18px; } }
</style>
