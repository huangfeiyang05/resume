<script setup lang="ts">
import SiteFooter from './SiteFooter.vue';

defineProps<{ title: string; updatedAt: string }>();

function goHome(): void {
  uni.reLaunch({ url: '/pages/index/index' });
}

function goBack(): void {
  const stack = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  if (stack.length > 1) {
    uni.navigateBack();
    return;
  }
  uni.reLaunch({ url: '/pages/index/index' });
}
</script>

<template>
  <view class="legal-page">
    <view class="legal-topbar">
      <button class="legal-back" type="button" role="button" tabindex="0" @click="goBack"><text aria-hidden="true">←</text><text>返回</text></button>
      <button class="legal-brand" type="button" role="button" tabindex="0" @click="goHome"><image class="legal-brand-logo" src="/static/brand/logo.png" mode="aspectFill" aria-label="简历有方 Logo" /><text>简历有方</text></button>
      <view class="legal-topbar-spacer" />
    </view>
    <view class="legal-shell">
      <view class="glass-panel legal-document">
        <text class="legal-title">{{ title }}</text>
        <text class="legal-meta">更新日期：{{ updatedAt }} · 生效日期：{{ updatedAt }}</text>
        <slot />
      </view>
      <SiteFooter />
    </view>
  </view>
</template>
