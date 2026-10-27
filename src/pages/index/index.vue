<script setup lang="ts">
import AuthPanel from '../../components/AuthPanel.vue';
import WorkspacePanel from '../../components/WorkspacePanel.vue';
import { useAuth } from '../../services/auth';

const auth = useAuth();
const { user, signedIn, status, busy, operation, error, notice, capabilities } = auth;
</script>

<template>
  <view v-if="status === 'checking'" class="auth-loading"><image class="auth-logo" src="/static/brand/logo.png" mode="aspectFill" alt="简历有方 Logo" /><text>简历有方</text><view class="spinner" /><text class="auth-loading-description">正在确认登录状态…</text></view>
  <WorkspacePanel v-else-if="signedIn && user" :key="user.id" :user="user" :auth-busy="busy" :logout-busy="busy && operation === 'logout'" :logout-error="error" :verification-busy="busy && operation === 'verify'" :capabilities="capabilities" @logout="auth.signOut" @verify-email="auth.verifyEmail" />
  <AuthPanel v-else :busy="busy" :error="error" :notice="notice" :capabilities="capabilities" :restore-failed="status === 'unavailable'" @submit="auth.authenticate" @reset="auth.resetPassword" @retry="auth.restore" @clear-error="error = ''; notice = ''" />
</template>
