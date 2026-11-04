<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: string; align?: 'center' | 'end' }>(), { align: 'center' });
// This describes plan copy only; it never checks or grants account entitlements.
const display = computed(() => {
  const value = props.value.trim();
  if (!value) return { state: 'pending', label: '待确认', icon: '—', detail: '' };
  if (value === '不包含') return { state: 'excluded', label: '不包含', icon: '—', detail: '' };
  return { state: 'included', label: '包含', icon: '✓', detail: value.replace(/^包含/, '').trim() };
});
</script>

<template>
  <view class="plan-feature-value" :class="{ 'align-end': align === 'end' }">
    <view class="feature-status" :class="display.state"><text class="feature-status-icon" aria-hidden="true">{{ display.icon }}</text><text>{{ display.label }}</text></view>
    <text v-if="display.detail" class="feature-detail">{{ display.detail }}</text>
  </view>
</template>

<style scoped>
.plan-feature-value { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; max-width: 100%; width: 100%; }
.plan-feature-value.align-end { align-items: flex-end; text-align: right; }
.feature-status { display: inline-flex; align-items: center; justify-content: center; gap: 5px; max-width: 100%; box-sizing: border-box; border: 1px solid #d6dee8; border-radius: 20px; padding: 3px 8px; font-size: 13px; font-weight: 600; line-height: 1.6; white-space: nowrap; background: rgba(235,240,246,.84); color: #5b687b; }
.feature-status.included { color: #146447; background: rgba(226,245,235,.88); border-color: #b4d9c5; }
.feature-status-icon { font-size: 14px; font-weight: 700; line-height: 1; }
.feature-detail { display: block; min-width: 0; max-width: 100%; color: #46566e; font-size: 14px; line-height: 1.75; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
@media (max-width: 600px) {
  .feature-status { gap: 4px; padding: 3px 6px; font-size: 12px; }
  .feature-status-icon { font-size: 12px; }
}
</style>
