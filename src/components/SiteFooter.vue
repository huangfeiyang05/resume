<script setup lang="ts">
const legalLinks = [
  { label: '隐私政策', url: '/pages/legal/privacy' },
  { label: '用户协议', url: '/pages/legal/terms' },
  { label: '联系我们', url: '/pages/legal/contact' },
] as const;

function openLegal(url: string): void {
  uni.navigateTo({ url });
}

// #ifdef H5
function openFiling(): void {
  window.open('https://beian.miit.gov.cn/', '_blank', 'noopener,noreferrer');
}
// #endif
</script>

<template>
  <view class="site-footer" role="contentinfo">
    <view class="site-footer-legal">
      <template v-for="(link, index) in legalLinks" :key="link.url">
        <text v-if="index > 0" class="site-footer-divider" aria-hidden="true">·</text>
        <button class="site-footer-link" type="button" role="link" tabindex="0" @click="openLegal(link.url)">{{ link.label }}</button>
      </template>
    </view>
    <!-- #ifdef H5 -->
    <view class="site-footer-meta">
      <text class="site-footer-brand">简历有方</text>
      <text class="site-footer-divider" aria-hidden="true">·</text>
      <button class="site-footer-filing" type="button" role="link" tabindex="0" aria-label="鄂ICP备2026064006号-1，前往工业和信息化部备案管理系统" @click="openFiling">鄂ICP备2026064006号-1</button>
    </view>
    <!-- #endif -->
  </view>
</template>

<style scoped>
.site-footer { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 24px 16px 6px; color: var(--muted); font-size: 12px; line-height: 1.8; text-align: center; }
.site-footer-legal, .site-footer-meta { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 2px; }
.site-footer-brand, .site-footer-divider { color: var(--muted); }
.site-footer-link, .site-footer-filing { min-height: 0; margin: 0; padding: 2px 3px; background: transparent; color: var(--muted); font-size: 12px; line-height: 1.8; text-align: center; }
.site-footer-link:hover, .site-footer-link:focus-visible, .site-footer-filing:hover, .site-footer-filing:focus-visible { color: var(--blue); text-decoration: underline; }
</style>
