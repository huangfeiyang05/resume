<script setup lang="ts">
import { legalConfig } from '../config/legal';

defineProps<{ hasWebLogin: boolean; phoneLoginAvailable: boolean }>();

function copyWebsite() {
  uni.setClipboardData({
    data: legalConfig.website,
    showToast: false,
    success: () => uni.showToast({ title: '网址已复制', icon: 'none' }),
    fail: () => uni.showToast({ title: '请长按网址复制', icon: 'none' }),
  });
}
</script>

<template>
  <view class="web-resume-import">
    <text v-if="hasWebLogin" class="web-resume-import-note">手机本地文件用网页版，登录同一账号。</text>
    <text v-else class="web-resume-import-note">手机本地文件用网页版，绑定{{ phoneLoginAvailable ? '邮箱或手机号' : '邮箱' }}后登录。</text>
    <view class="web-resume-import-address">
      <text class="web-resume-import-url" selectable>{{ legalConfig.website }}</text>
      <button class="web-resume-import-copy" @click="copyWebsite" role="button" tabindex="0"><text class="web-resume-import-copy-label">复制网址</text></button>
    </view>
  </view>
</template>

<style scoped>
.web-resume-import { margin-top: 8px; }
.web-resume-import-note { display: block; color: var(--muted); font-size: 12px; line-height: 1.5; }
.web-resume-import-address { display: flex; align-items: center; gap: 10px; }
.web-resume-import-url { min-width: 0; color: var(--blue); font-size: 12px; word-break: break-all; }
.web-resume-import-copy { display: inline-flex; align-items: center; flex-shrink: 0; min-height: 32px; padding: 0 4px; white-space: nowrap; }
.web-resume-import-copy-label { color: var(--blue); font-size: 12px; line-height: 1.5; }
</style>
