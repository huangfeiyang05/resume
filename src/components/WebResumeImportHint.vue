<script setup lang="ts">
import { legalConfig } from '../config/legal';

defineProps<{ hasWebLogin: boolean }>();

function copyWebsite() {
  uni.setClipboardData({
    data: legalConfig.website,
    showToast: false,
    success: () => uni.showToast({ title: '已复制，请在浏览器打开', icon: 'none' }),
    fail: () => uni.showToast({ title: '复制失败，可长按网址复制', icon: 'none' }),
  });
}
</script>

<template>
  <view class="web-resume-import">
    <text class="web-resume-import-title">Word / PDF 网页导入</text>
    <view class="web-resume-import-address">
      <text class="web-resume-import-url" selectable>{{ legalConfig.website }}</text>
      <button class="text-button web-resume-import-copy" @click="copyWebsite" role="button" tabindex="0">复制网址</button>
    </view>
    <text class="web-resume-import-note">在手机或电脑浏览器打开，用同一账号登录。点「新建」上传并保存，回小程序点「我的」查看。</text>
    <text v-if="!hasWebLogin" class="web-resume-import-note">请先在小程序「我的 → 账号登录方式」绑定邮箱。</text>
  </view>
</template>

<style scoped>
.web-resume-import { margin-top: 12px; padding-top: 12px; border-top: 1px solid #d8e2ef; }
.web-resume-import-title { display: block; color: var(--ink); font-size: 14px; font-weight: 600; }
.web-resume-import-address { display: flex; align-items: center; gap: 8px 12px; }
.web-resume-import-url { flex: 1; min-width: 0; color: var(--blue); font-size: 13px; word-break: break-all; }
.web-resume-import-copy { flex-shrink: 0; min-height: 40px; white-space: nowrap; }
.web-resume-import-note { display: block; color: var(--muted); font-size: 13px; line-height: 1.7; }
.web-resume-import-note + .web-resume-import-note { margin-top: 4px; }
</style>
