<script setup lang="ts">
import AuthPanel from '../../components/AuthPanel.vue';
import WorkspacePanel from '../../components/WorkspacePanel.vue';
import { useAuth } from '../../services/auth';
// #ifdef MP-WEIXIN
import { onShareAppMessage } from '@dcloudio/uni-app';

onShareAppMessage(() => ({
  title: '简历有方',
  path: '/pages/index/index',
  imageUrl: '/static/brand/logo.png',
}));
// #endif

const auth = useAuth();
const { user, signedIn, status, busy, operation, error, notice, capabilities } = auth;
</script>

<template>
  <view v-if="status === 'checking'" class="auth-loading"><image class="auth-logo" src="/static/brand/logo.png" mode="aspectFill" aria-label="简历有方 Logo" /><text>简历有方</text><view class="spinner" /><text class="auth-loading-description">正在确认登录状态…</text></view>
  <WorkspacePanel v-else-if="signedIn && user" :key="user.id" :user="user"
    :logout-busy="busy && operation === 'logout'" :logout-error="error" :verification-busy="busy && operation === 'verify'"
    :capabilities="capabilities" :binding-busy="busy" :save-profile="auth.updateProfile"
    @logout="auth.signOut" @verify-email="auth.verifyEmail" @bind-phone="auth.bindPhone" @bind-email="auth.bindEmail"
    @change-phone="auth.changePhone" @change-password="auth.changePassword"
    @bind-wechat-phone="auth.bindWechatPhone" @clear-auth-error="error = ''; notice = ''" />
  <AuthPanel v-else :busy="busy" :error="error" :notice="notice" :capabilities="capabilities" :restore-failed="status === 'unavailable'"
    @submit="auth.authenticate" @reset="auth.resetPassword" @phone="auth.authenticatePhone" @retry="auth.restore"
    @wechat="auth.signInWithWechat" @clear-error="error = ''; notice = ''" />
</template>
