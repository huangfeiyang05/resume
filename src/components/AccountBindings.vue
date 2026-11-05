<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AuthCapabilities, AuthUser, BindEmailInput, BindPhoneInput } from '../../shared/auth';
import { PASSWORD_PATTERN, PASSWORD_RULE_MESSAGE } from '../../shared/auth';
import { normalizedPhone, useEmailChallenge, usePhoneChallenge } from '../services/auth';
import AppModal from './AppModal.vue';

const props = defineProps<{ user: AuthUser; capabilities?: AuthCapabilities; busy?: boolean; error?: string }>();
const emit = defineEmits<{ bindPhone: [input: BindPhoneInput]; bindEmail: [input: BindEmailInput]; clearError: [] }>();
const kind = ref<'phone' | 'email'>();
const phone = ref(''), email = ref(''), currentPassword = ref(''), password = ref(''), confirmation = ref(''), formError = ref('');
const phoneProof = usePhoneChallenge(), emailProof = useEmailChallenge(), accountProof = usePhoneChallenge();
const { code: phoneCode, busy: phoneSending, remaining: phoneRemaining } = phoneProof;
const { code: emailCode, busy: emailSending, remaining: emailRemaining } = emailProof;
const { code: accountCode, busy: accountSending, remaining: accountRemaining } = accountProof;
const hasPassword = computed(() => props.user.hasPassword ?? !!props.user.email);
const sending = computed(() => phoneSending.value || emailSending.value || accountSending.value);
const disabled = computed(() => !!props.busy || sending.value);
const errorMessage = computed(() => formError.value || phoneProof.error.value || emailProof.error.value || accountProof.error.value || props.error);
const maskedPhone = computed(() => props.user.phone ? `${props.user.phone.slice(0, 3)}****${props.user.phone.slice(-4)}` : '未绑定');
watch(phone, value => phoneProof.setTarget(value, 'bind-phone'));
watch(email, value => emailProof.setTarget(value, 'bind-email'));
function clear() {
  phone.value = ''; email.value = ''; currentPassword.value = ''; password.value = ''; confirmation.value = ''; formError.value = '';
  phoneProof.clearProof(); emailProof.clearProof(); accountProof.clearProof();
}
function open(next: 'phone' | 'email') {
  if (disabled.value || (next === 'phone' ? !!props.user.phone || !props.capabilities?.phone : !!props.user.email || !props.capabilities?.emailVerification)) return;
  clear(); emit('clearError'); kind.value = next;
  if (props.user.phone) accountProof.setTarget(props.user.phone, 'verify-account');
}
function close() { if (props.busy) return; kind.value = undefined; clear(); }
watch(() => [props.user.id, props.user.phone, props.user.email], (next, previous) => {
  if (!previous || next.some((value, index) => value !== previous[index])) { kind.value = undefined; clear(); }
});
async function sendTarget() {
  if (disabled.value) return;
  emit('clearError'); formError.value = '';
  if (kind.value === 'phone' && props.capabilities?.phone) { phoneProof.setTarget(phone.value, 'bind-phone'); await phoneProof.send(); }
  else if (kind.value === 'email' && props.capabilities?.emailVerification) { emailProof.setTarget(email.value, 'bind-email'); await emailProof.send(); }
}
async function sendAccount() {
  if (disabled.value || !props.capabilities?.phone || !props.user.phone) return;
  accountProof.setTarget(props.user.phone, 'verify-account'); await accountProof.send();
}
function submit() {
  if (disabled.value || !kind.value) return;
  formError.value = ''; emit('clearError');
  let identity: { currentPassword?: string; currentCode?: string; currentChallengeId?: string };
  if (hasPassword.value) {
    if (!currentPassword.value) { formError.value = '请填写当前账号密码以确认身份。'; return; }
    identity = { currentPassword: currentPassword.value };
  } else {
    if (!props.capabilities?.phone || !props.user.phone) { formError.value = '当前手机验证暂不可用，请稍后重试。'; return; }
    accountProof.setTarget(props.user.phone, 'verify-account');
    const proof = accountProof.proof(); if (!proof) return;
    identity = { currentCode: proof.code, currentChallengeId: proof.challengeId };
  }
  if (kind.value === 'phone') {
    if (!props.capabilities?.phone) return;
    phoneProof.setTarget(phone.value, 'bind-phone');
    const proof = phoneProof.proof(); if (!proof) return;
    emit('bindPhone', { phone: normalizedPhone(phone.value), ...proof, ...identity });
  } else {
    if (!props.capabilities?.emailVerification) return;
    if (!hasPassword.value && (!PASSWORD_PATTERN.test(password.value) || password.value !== confirmation.value)) {
      formError.value = password.value !== confirmation.value ? '两次输入的新密码不一致。' : PASSWORD_RULE_MESSAGE; return;
    }
    emailProof.setTarget(email.value, 'bind-email');
    const proof = emailProof.proof(); if (!proof) return;
    emit('bindEmail', { email: email.value.trim().toLowerCase(), ...proof, ...identity, ...(!hasPassword.value ? { password: password.value } : {}) });
  }
}
</script>

<template>
  <view class="glass-panel account-bindings">
    <text class="bindings-title">账号登录方式</text>
    <view class="binding-row"><view><text class="binding-label">手机号</text><text class="binding-value">{{ maskedPhone }}{{ user.phoneVerified ? ' · 已验证' : '' }}</text></view><button v-if="!user.phone" class="text-button" :disabled="disabled || !capabilities?.phone" @click="open('phone')" role="button">{{ capabilities?.phone ? '绑定手机号' : '短信绑定暂未开放' }}</button><text v-else class="binding-status">已绑定</text></view>
    <view class="binding-row"><view><text class="binding-label">邮箱</text><text class="binding-value">{{ user.email || '未绑定' }}{{ user.emailVerified ? ' · 已验证' : '' }}</text></view><button v-if="!user.email" class="text-button" :disabled="disabled || !capabilities?.emailVerification" @click="open('email')" role="button">{{ capabilities?.emailVerification ? '绑定邮箱' : '邮箱绑定暂未开放' }}</button><text v-else class="binding-status">已绑定</text></view>
    <text class="binding-note">绑定后，两种方式均登录当前账号并使用同一份资料。已属于其他账号的手机号或邮箱不能直接绑定，也不会自动合并资料。</text>
  </view>
  <AppModal v-if="kind" :title="kind === 'phone' ? '绑定手机号' : '绑定邮箱'" subtitle="验证新的登录方式，并确认当前账号身份。" @close="close">
    <view class="binding-form">
      <template v-if="kind === 'phone'"><text class="field-label">新绑定的中国大陆手机号</text><input v-model="phone" class="text-input" type="text" inputmode="tel" autocomplete="tel" :maxlength="20" :disabled="disabled" placeholder="输入手机号" aria-label="要绑定的手机号" /><text class="field-label">新手机号验证码</text><view class="binding-code-row"><input v-model="phoneCode" class="text-input" type="text" inputmode="numeric" autocomplete="one-time-code" :maxlength="6" :disabled="disabled" placeholder="6 位数字验证码" aria-label="新手机号验证码" /><button class="button secondary" :disabled="disabled || phoneRemaining > 0" @click="sendTarget" role="button">{{ phoneSending ? '正在发送…' : phoneRemaining > 0 ? `${phoneRemaining} 秒后重发` : '获取验证码' }}</button></view><text v-if="phoneProof.message.value" class="binding-note" role="status">{{ phoneProof.message.value }}</text></template>
      <template v-else><text class="field-label">新绑定的邮箱</text><input v-model="email" class="text-input" type="text" inputmode="email" autocomplete="email" :maxlength="254" :disabled="disabled" placeholder="输入邮箱地址" aria-label="要绑定的邮箱" /><text class="field-label">新邮箱验证码</text><view class="binding-code-row"><input v-model="emailCode" class="text-input" type="text" inputmode="numeric" autocomplete="one-time-code" :maxlength="6" :disabled="disabled" placeholder="6 位数字验证码" aria-label="新邮箱验证码" /><button class="button secondary" :disabled="disabled || emailRemaining > 0" @click="sendTarget" role="button">{{ emailSending ? '正在发送…' : emailRemaining > 0 ? `${emailRemaining} 秒后重发` : '获取验证码' }}</button></view><text v-if="emailProof.message.value" class="binding-note" role="status">{{ emailProof.message.value }}</text></template>
      <template v-if="hasPassword"><text class="field-label">当前账号密码</text><input v-model="currentPassword" class="text-input" password type="text" autocomplete="current-password" :maxlength="128" :disabled="disabled" placeholder="确认当前账号身份" aria-label="当前账号密码" /></template>
      <template v-else><text class="field-label">当前手机号验证 · {{ maskedPhone }}</text><view class="binding-code-row"><input v-model="accountCode" class="text-input" type="text" inputmode="numeric" :maxlength="6" :disabled="disabled" placeholder="当前手机号收到的验证码" aria-label="当前手机号验证码" /><button class="button secondary" :disabled="disabled || accountRemaining > 0 || !capabilities?.phone" @click="sendAccount" role="button">{{ accountSending ? '正在发送…' : accountRemaining > 0 ? `${accountRemaining} 秒后重发` : '验证当前手机' }}</button></view><text v-if="accountProof.message.value" class="binding-note" role="status">{{ accountProof.message.value }}</text><text class="field-label">设置邮箱登录密码</text><input v-model="password" class="text-input" password type="text" autocomplete="new-password" :maxlength="16" :disabled="disabled" placeholder="6 至 16 位，字母/数字/符号" aria-label="新的邮箱登录密码" /><text class="field-label">确认新密码</text><input v-model="confirmation" class="text-input" password type="text" autocomplete="new-password" :maxlength="16" :disabled="disabled" placeholder="再次输入新密码" aria-label="确认新密码" /></template>
      <text v-if="errorMessage" class="binding-error" role="alert">{{ errorMessage }}</text>
      <view class="modal-footer"><button class="button secondary" :disabled="busy" @click="close" role="button">取消</button><button class="button primary" :disabled="disabled" @click="submit" role="button">{{ busy ? '正在绑定…' : '确认绑定' }}</button></view>
    </view>
  </AppModal>
</template>

<style scoped>
.account-bindings { padding: 20px 24px; margin-bottom: 20px; border-radius: 14px; }
.bindings-title { display: block; font-size: 17px; color: #1f2937; font-weight: 600; margin-bottom: 8px; }
.binding-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid #e5eaf1; }
.binding-label,.binding-value { display: block; font-size: 14px; line-height: 1.8; }
.binding-label { color: #536174; }.binding-value { color: #1f2937; overflow-wrap: anywhere; }.binding-status,.binding-note { color: #536174; font-size: 13px; line-height: 1.8; }.binding-note { display: block; margin-top: 12px; }
.binding-form { display: flex; flex-direction: column; gap: 12px; }.binding-form .field-label { margin-top: 7px; }.binding-code-row { display: flex; gap: 10px; align-items: center; }.binding-code-row .text-input { flex: 1; min-width: 0; }.binding-code-row .button { flex-shrink: 0; font-size: 13px; }.binding-error { color: #a23636; font-size: 14px; line-height: 1.8; }
@media(max-width:600px) { .account-bindings { padding: 16px; }.binding-row { align-items: flex-start; }.binding-code-row { flex-wrap: wrap; }.binding-code-row .button { width: 100%; } }
</style>
