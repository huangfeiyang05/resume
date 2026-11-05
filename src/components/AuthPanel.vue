<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AuthCapabilities, EmailPasswordInput, ResetPasswordInput, PhoneLoginInput } from '../../shared/auth';
import { PASSWORD_MAX_LENGTH } from '../../shared/auth';
import { useEmailChallenge, usePhoneChallenge, normalizedPhone, validateAuthForm, type AuthMode } from '../services/auth';
import AppIcon from './AppIcon.vue';
import SiteFooter from './SiteFooter.vue';

const props = defineProps<{ busy: boolean; error: string; notice?: string; capabilities?: AuthCapabilities; restoreFailed?: boolean }>();
const emit = defineEmits<{
  submit: [mode: 'login' | 'register', input: EmailPasswordInput];
  reset: [input: ResetPasswordInput];
  phone: [input: PhoneLoginInput];
  retry: [];
  clearError: [];
}>();
const mode = ref<AuthMode>('login');
const method = ref<'email' | 'phone'>('email');
const phone = ref('');
const sms = usePhoneChallenge();
const { code: smsCode, busy: smsBusy, error: smsError, message: smsMessage, remaining: smsRemaining } = sms;
watch(phone, value => sms.setTarget(value, 'login'));
function changeMethod(next: 'email' | 'phone') {
  if (props.busy || smsBusy.value || codeBusy.value) return;
  method.value = next; password.value = ''; confirmation.value = ''; formError.value = '';
  sms.clearProof(); challenge.clearProof(); emit('clearError');
}
async function sendSms() {
  if (!props.capabilities?.phone || props.busy) return;
  sms.setTarget(phone.value, 'login'); emit('clearError'); await sms.send();
}
function submitPhone() {
  if (!props.capabilities?.phone || props.busy || smsBusy.value) return;
  sms.setTarget(phone.value, 'login');
  const proof = sms.proof();
  if (proof) emit('phone', { phone: normalizedPhone(phone.value), ...proof });
}
const email = ref('');
const password = ref('');
const confirmation = ref('');
const formError = ref('');
const challenge = useEmailChallenge();
const { code, busy: codeBusy, error: codeError, message: codeMessage, remaining } = challenge;
const needsCode = computed(() => mode.value === 'reset' || (mode.value === 'register' && props.capabilities?.emailVerification === true));
const message = computed(() => formError.value || codeError.value || props.error);
const title = computed(() => mode.value === 'login' ? '欢迎回来' : mode.value === 'register' ? '创建你的账号' : '找回密码');
const submitLabel = computed(() => mode.value === 'login' ? '登录' : mode.value === 'register' ? '注册并登录' : '设置新密码');
const submitting = computed(() => props.busy || codeBusy.value);
const strength = computed(() => {
  const value = password.value;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  if (value.length >= 12) score += 1;
  const level = Math.max(1, Math.min(3, score));
  return { level, label: level === 1 ? '弱' : level === 2 ? '中' : '强' };
});
function inputValue(event: Event): string {
  const payload = event as unknown as { detail?: { value?: string }; target?: { value?: string } | null };
  return payload.detail?.value ?? payload.target?.value ?? '';
}
function onPasswordInput(event: Event) {
  if (mode.value === 'login') return;
  password.value = inputValue(event).replace(/[^\x21-\x7e]/g, '').slice(0, PASSWORD_MAX_LENGTH);
}
function onConfirmationInput(event: Event) {
  confirmation.value = inputValue(event).replace(/[^\x21-\x7e]/g, '').slice(0, PASSWORD_MAX_LENGTH);
}
function syncTarget() { challenge.setTarget(email.value, mode.value === 'reset' ? 'reset-password' : 'register'); }
watch([email, mode], syncTarget);
watch(() => props.notice, value => {
  if (!value) return;
  mode.value = 'login'; password.value = ''; confirmation.value = ''; formError.value = ''; challenge.clearProof();
});
function changeMode(next: AuthMode) {
  if (submitting.value || (next === 'reset' && !props.capabilities?.passwordReset)) return;
  mode.value = next; password.value = ''; confirmation.value = ''; formError.value = ''; challenge.clearProof(); emit('clearError'); syncTarget();
}
async function sendCode() {
  if (props.busy || (mode.value === 'register' ? !props.capabilities?.emailVerification : !props.capabilities?.passwordReset)) return;
  formError.value = ''; emit('clearError'); syncTarget(); await challenge.send();
}
function submit() {
  if (submitting.value) return;
  formError.value = validateAuthForm(mode.value, email.value, password.value, confirmation.value);
  if (formError.value) return;
  syncTarget();
  const proof = needsCode.value ? challenge.proof() : undefined;
  if (needsCode.value && !proof) return;
  if (mode.value === 'reset') {
    if (!props.capabilities?.passwordReset || !proof) return;
    emit('reset', { email: email.value.trim(), password: password.value, ...proof });
  } else {
    if (mode.value === 'register' && !props.capabilities) { formError.value = '正在确认注册方式，请稍后重试。'; return; }
    emit('submit', mode.value, { email: email.value.trim(), password: password.value, ...proof });
  }
}
</script>

<template>
  <view class="auth-page">
    <view class="auth-brand"><image class="auth-logo" src="/static/brand/logo.png" mode="aspectFill" alt="简历有方 Logo" /><text>简历有方</text></view>
    <view class="auth-layout">
      <view class="auth-intro">
        <text class="auth-intro-title">{{ '简历与求职，\n一处管理。' }}</text>
        <text class="auth-intro-description">整理简历、查找企业、记录投递。</text>
      </view>
      <view class="glass-panel auth-card">
        <view class="auth-mode-switch" role="tablist" aria-label="选择登录方式"><button :class="{ active: method === 'email' }" :aria-selected="method === 'email'" :disabled="busy || smsBusy || codeBusy" role="tab" @click="changeMethod('email')">邮箱</button><button :class="{ active: method === 'phone' }" :aria-selected="method === 'phone'" :disabled="busy || smsBusy || codeBusy" role="tab" @click="changeMethod('phone')">手机验证码</button></view>
        <template v-if="method === 'email'">
        <view v-if="mode !== 'reset'" class="auth-mode-switch" role="tablist" aria-label="选择登录或注册"><button :class="{ active: mode === 'login' }" :aria-selected="mode === 'login'" :disabled="submitting" role="tab" tabindex="0" @click="changeMode('login')">登录</button><button :class="{ active: mode === 'register' }" :aria-selected="mode === 'register'" :disabled="submitting" role="tab" tabindex="0" @click="changeMode('register')">注册</button></view>
        <button v-else class="text-button auth-back" :disabled="submitting" role="button" tabindex="0" @click="changeMode('login')">返回登录</button>
        <text class="auth-title">{{ title }}</text>
        <text v-if="mode === 'reset'" class="auth-description">使用已验证的邮箱重设密码。</text>
        <view v-if="notice && mode === 'login'" class="auth-success" role="status"><AppIcon name="check" :size="16" /><text>{{ notice }}</text></view>
        <view class="auth-form">
          <text class="field-label">邮箱地址</text><input v-model="email" class="text-input auth-input" type="text" inputmode="email" autocomplete="email" placeholder="输入你的邮箱" :maxlength="254" :disabled="busy" aria-label="邮箱地址" @confirm="submit" />
          <view v-if="needsCode" class="auth-field"><text class="field-label">邮箱验证码</text><view class="auth-code-row"><input v-model="code" class="text-input auth-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字验证码" :maxlength="6" :disabled="submitting" aria-label="邮箱验证码" @confirm="submit" /><button class="button secondary auth-code-send" :disabled="submitting || remaining > 0" role="button" tabindex="0" @click="sendCode">{{ codeBusy ? '正在发送…' : remaining > 0 ? `${remaining} 秒后重发` : '获取验证码' }}</button></view><text v-if="codeMessage" class="auth-code-message" role="status">{{ codeMessage }}</text></view>
          <view class="auth-field"><view class="auth-label-row"><text class="field-label">{{ mode === 'reset' ? '新密码' : '密码' }}</text><button v-if="mode === 'login' && capabilities?.passwordReset" class="text-button auth-forgot" :disabled="submitting" role="button" tabindex="0" @click="changeMode('reset')">忘记密码？</button><view v-if="mode !== 'login' && password" class="password-strength" :data-level="strength.level"><view class="strength-bars"><view v-for="segment in 3" :key="segment" class="strength-segment" :class="{ on: strength.level >= segment }" /></view><text>{{ strength.label }}</text></view></view><input v-model="password" class="text-input auth-input" password type="text" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :placeholder="mode === 'login' ? '输入密码' : '6 至 16 位，字母/数字/符号'" :maxlength="mode === 'login' ? 128 : PASSWORD_MAX_LENGTH" :disabled="submitting" aria-label="密码" @input="onPasswordInput" @confirm="submit" /></view>
          <view v-if="mode !== 'login'" class="auth-field"><text class="field-label">确认密码</text><input v-model="confirmation" class="text-input auth-input" password type="text" autocomplete="new-password" placeholder="再次输入密码" :maxlength="PASSWORD_MAX_LENGTH" :disabled="submitting" aria-label="确认密码" @input="onConfirmationInput" @confirm="submit" /></view>
          <text v-if="mode === 'reset'" class="auth-reset-note">邮箱未验证时，请先用原密码登录，在“我的”中完成验证。</text>
          <view v-if="message" class="auth-error" role="alert"><AppIcon name="info" :size="16" /><text>{{ message }}</text></view>
          <button class="button primary full-width auth-submit" :disabled="submitting || (mode === 'register' && !capabilities)" role="button" tabindex="0" @click="submit"><view v-if="busy" class="spinner" /><text>{{ busy ? '正在提交…' : submitLabel }}</text><AppIcon v-if="!busy" name="arrow" :size="17" /></button>
          <button v-if="restoreFailed" class="text-button auth-retry" :disabled="submitting" role="button" tabindex="0" @click="emit('retry')">重新检查登录状态</button>
        </view>
        </template>
        <template v-else>
          <text class="auth-title">手机验证码登录</text>
          <text class="auth-description">未注册的手机号验证后将创建账号。已有邮箱账号请先用邮箱登录，再绑定手机号以保留原有资料。</text>
          <view class="auth-form">
            <text class="field-label">中国大陆手机号</text>
            <input v-model="phone" class="text-input auth-input" type="text" inputmode="tel" autocomplete="tel" placeholder="输入手机号" :maxlength="20" :disabled="busy || smsBusy" aria-label="手机号" />
            <view class="auth-field"><text class="field-label">短信验证码</text><view class="auth-code-row"><input v-model="smsCode" class="text-input auth-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字验证码" :maxlength="6" :disabled="busy || smsBusy || !capabilities?.phone" aria-label="短信验证码" @confirm="submitPhone" /><button class="button secondary auth-code-send" :disabled="busy || smsBusy || smsRemaining > 0 || !capabilities?.phone" @click="sendSms" role="button">{{ smsBusy ? '正在发送…' : smsRemaining > 0 ? `${smsRemaining} 秒后重发` : '获取验证码' }}</button></view><text v-if="smsMessage" class="auth-code-message" role="status">{{ smsMessage }}</text></view>
            <text v-if="!capabilities?.phone" class="auth-reset-note">短信登录暂未开放，请使用邮箱登录。</text>
            <view v-if="smsError || error" class="auth-error" role="alert"><AppIcon name="info" :size="16" /><text>{{ smsError || error }}</text></view>
            <button class="button primary full-width auth-submit" :disabled="busy || smsBusy || !capabilities?.phone" @click="submitPhone" role="button"><view v-if="busy" class="spinner" /><text>{{ busy ? '正在登录…' : '验证并登录' }}</text></button>
            <button v-if="restoreFailed" class="text-button auth-retry" :disabled="busy" @click="emit('retry')" role="button">重新检查登录状态</button>
          </view>
        </template>
      </view>
    </view>
    <SiteFooter />
  </view>
</template>
