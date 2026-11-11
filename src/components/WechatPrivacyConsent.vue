<script setup lang="ts">
import { onMounted, ref } from 'vue';

const emit = defineEmits<{ allowed: [value: boolean] }>();
const state = ref<'checking' | 'needs-consent' | 'allowed' | 'unavailable'>('checking');
const error = ref('');

declare const wx: {
  getPrivacySetting?: (options: { success: (result: { needAuthorization: boolean }) => void; fail: () => void }) => void;
  openPrivacyContract?: (options: { fail: () => void }) => void;
};

function allow() {
  state.value = 'allowed';
  emit('allowed', true);
}
function check() {
  // #ifdef MP-WEIXIN
  state.value = 'checking';
  if (typeof wx !== 'undefined' && wx.getPrivacySetting) {
    wx.getPrivacySetting({
      success: result => { if (result.needAuthorization) state.value = 'needs-consent'; else allow(); },
      fail: () => { state.value = 'unavailable'; },
    });
    return;
  }
  // #endif
  state.value = 'unavailable';
}
function readPolicy() {
  // #ifdef MP-WEIXIN
  wx.openPrivacyContract?.({ fail: () => { error.value = '微信隐私保护指引暂时无法打开。'; } });
  // #endif
}
onMounted(check);
</script>

<template>
  <view v-if="state === 'needs-consent'" class="privacy-consent">
    <button class="text-button" @click="readPolicy">查看微信小程序隐私保护指引</button>
    <button class="text-button" open-type="agreePrivacyAuthorization" @agreeprivacyauthorization="allow">同意隐私保护指引</button>
    <text v-if="error" role="alert">{{ error }}</text>
  </view>
  <view v-else-if="state === 'unavailable'" class="privacy-consent">
    <text>暂时无法确认微信隐私授权。</text>
    <button class="text-button" @click="check">重试</button>
  </view>
</template>

<style scoped>
.privacy-consent { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 13px; color: var(--muted); }
.privacy-consent .text-button { min-height: 34px; font-size: 13px; color: var(--blue); }
</style>
