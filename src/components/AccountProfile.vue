<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { accountNicknameMaxLength, isAccountNickname, type AccountProfileInput, type AuthUser } from '../../shared/auth';
import { isMiniProgramClient, loadAccountAvatar } from '../services/api';
// #ifdef MP-WEIXIN
import { prepareWechatAvatar } from '../utils/accountAvatar';
import WechatPrivacyConsent from './WechatPrivacyConsent.vue';
// #endif
// #ifdef H5
import { prepareBrowserAvatar } from '../utils/accountAvatar';
// #endif
import AppModal from './AppModal.vue';

const props = defineProps<{
  user: AuthUser;
  busy?: boolean;
  saveProfile: (input: AccountProfileInput) => Promise<boolean>;
  error?: string;
}>();
const emit = defineEmits<{ clearError: [] }>();
const displayName = computed(() => props.user.nickname || props.user.email
  || (props.user.phone ? props.user.phone.slice(0, 3) + '****' + props.user.phone.slice(-4) : props.user.wechat ? '微信用户' : '当前账号'));
const avatarUrl = ref('');
const open = ref(false);
const nickname = ref('');
const pendingAvatar = ref<{ data: string; preview: string } | null>();
const error = ref('');
const preparing = ref(false);
const privacyAllowed = ref(false);
let avatarLoad = 0;
let avatarEdit = 0;
let releaseAvatar: (() => void) | undefined;
const disabled = computed(() => !!props.busy || preparing.value);
const preview = computed(() => pendingAvatar.value === null ? '' : pendingAvatar.value?.preview || avatarUrl.value);
watch(() => props.user.avatarId, async id => {
  const sequence = ++avatarLoad;
  releaseAvatar?.();
  releaseAvatar = undefined;
  avatarUrl.value = '';
  if (!id) return;
  try {
    const file = await loadAccountAvatar(id);
    if (sequence !== avatarLoad) { file.release(); return; }
    releaseAvatar = file.release;
    avatarUrl.value = file.url;
  } catch { /* Keep the default avatar if the private image is unavailable. */ }
}, { immediate: true });
onUnmounted(() => { ++avatarLoad; ++avatarEdit; releaseAvatar?.(); });

function edit() {
  emit('clearError');
  nickname.value = props.user.nickname ?? '';
  pendingAvatar.value = undefined;
  privacyAllowed.value = false;
  error.value = '';
  open.value = true;
}
function resetEditor() {
  ++avatarEdit;
  open.value = false;
  preparing.value = false;
  pendingAvatar.value = undefined;
  emit('clearError');
}
function close() {
  if (!props.busy) resetEditor();
}
async function prepare(path: string, read: (path: string) => Promise<string>, showPath = false) {
  if (disabled.value || !open.value) return;
  const sequence = ++avatarEdit;
  preparing.value = true;
  error.value = '';
  try {
    const data = await read(path);
    if (sequence === avatarEdit && open.value) pendingAvatar.value = { data, preview: showPath ? path : 'data:image/jpeg;base64,' + data };
  } catch (cause) {
    if (sequence === avatarEdit && open.value) error.value = cause instanceof Error ? cause.message : '头像暂时无法读取。';
  } finally { if (sequence === avatarEdit) preparing.value = false; }
}
function chooseWechatAvatar(event: { detail?: { avatarUrl?: string } }) {
  // #ifdef MP-WEIXIN
  if (event.detail?.avatarUrl && privacyAllowed.value) void prepare(event.detail.avatarUrl, prepareWechatAvatar, true);
  // #endif
}
function chooseBrowserAvatar() {
  // #ifdef H5
  if (disabled.value) return;
  const sequence = ++avatarEdit;
  uni.chooseImage({
    count: 1, sourceType: ['album'], sizeType: ['original'],
    success: result => { if (sequence === avatarEdit && result.tempFilePaths[0]) void prepare(result.tempFilePaths[0], prepareBrowserAvatar); },
  });
  // #endif
}
async function save() {
  if (disabled.value || !open.value) return;
  error.value = '';
  const name = nickname.value.trim().normalize('NFC');
  if (name && !isAccountNickname(name)) { error.value = '昵称需为 1 至 24 个字符。'; return; }
  const avatar = pendingAvatar.value;
  const input: AccountProfileInput = { nickname: name || null, ...(avatar !== undefined ? { avatar: avatar?.data ?? null } : {}) };
  if (await props.saveProfile(input)) resetEditor();
}
const miniProgram = isMiniProgramClient();
</script>

<template>
  <view class="account-profile">
    <view class="account-profile-avatar">
      <image v-if="avatarUrl" :src="avatarUrl" class="account-profile-image" mode="aspectFill" aria-label="个人头像" @error="avatarUrl = ''" />
      <text v-else>YF</text>
    </view>
    <view class="account-profile-detail">
      <text class="account-profile-name">{{ displayName }}</text>
      <slot />
      <button class="text-button account-profile-edit" :disabled="busy" @click="edit">编辑头像和昵称</button>
    </view>
    <AppModal v-if="open" title="编辑个人资料" subtitle="头像和昵称只用于显示你的账号资料。" @close="close">
      <view class="account-profile-form">
        <view class="account-profile-controls">
          <view class="account-profile-avatar">
            <image v-if="preview" :src="preview" class="account-profile-image" mode="aspectFill" aria-label="头像预览" />
            <text v-else>YF</text>
          </view>
          <!-- #ifdef MP-WEIXIN -->
          <button v-if="privacyAllowed" class="button secondary" open-type="chooseAvatar" :disabled="disabled" @chooseavatar="chooseWechatAvatar">选择头像</button>
          <!-- #endif -->
          <!-- #ifdef H5 -->
          <button class="button secondary" :disabled="disabled" @click="chooseBrowserAvatar">选择头像</button>
          <!-- #endif -->
          <button v-if="preview" class="text-button" :disabled="disabled" @click="pendingAvatar = null">移除头像</button>
        </view>
        <!-- #ifdef MP-WEIXIN -->
        <WechatPrivacyConsent @allowed="privacyAllowed = $event" />
        <!-- #endif -->
        <text class="field-label">昵称</text>
        <input class="text-input" :type="miniProgram && privacyAllowed ? 'nickname' : 'text'" v-model="nickname"
          :maxlength="accountNicknameMaxLength * 2" :disabled="disabled" placeholder="填写昵称" aria-label="昵称" />
        <text v-if="preparing" role="status">正在读取头像…</text>
        <text v-if="error || props.error" class="account-profile-error" role="alert">{{ error || props.error }}</text>
      </view>
      <view class="modal-footer">
        <button class="button secondary" :disabled="busy" @click="close">取消</button>
        <button class="button primary" :disabled="disabled" @click="save">{{ busy ? '正在保存…' : '保存资料' }}</button>
      </view>
    </AppModal>
  </view>
</template>

<style scoped>
.account-profile { display: flex; align-items: flex-start; gap: 12px; flex: 1; min-width: 0; }
.account-profile-detail { min-width: 0; }
.account-profile-name { display: block; color: var(--ink); font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.account-profile-avatar { flex: 0 0 44px; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; border: 1px solid #fff; color: var(--muted); background: #eff3fa; font-size: 13px; }
.account-profile-image { width: 100%; height: 100%; display: block; }
.account-profile-edit { min-height: 30px; padding: 0; color: var(--blue); font-size: 13px; }
.account-profile-form { display: flex; flex-direction: column; gap: 10px; }
.account-profile-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.account-profile-error { color: #b42318; font-size: 13px; }
@media (max-width: 767px) { .account-profile { grid-column: 1 / -1; } }
</style>
