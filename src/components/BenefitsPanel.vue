<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MembershipQuote, MembershipState, NativePaymentParams, Plan, PlanId } from '../../shared/types';
import { membershipApi } from '../services/membership';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';

const membership = ref<MembershipState>();
const plans = ref<Plan[]>([]);
const loading = ref(true);
const error = ref('');
const quotaLoading = ref(false);
const quotaError = ref('');
const purchaseOpen = ref(false);
const selectedPlanId = ref<PlanId>('basic');
const quote = ref<MembershipQuote>();
const quoteLoading = ref(false);
const quoteError = ref('');
const paying = ref(false);
const paymentError = ref('');
const nativePayment = ref<NativePaymentParams>();
let miniProgram = false;
// #ifdef MP-WEIXIN
miniProgram = true;
// #endif
const iosDevice = (() => { try { return miniProgram && uni.getSystemInfoSync().platform === 'ios'; } catch { return false; } })();
const paidPlans = computed(() => plans.value.filter((plan) => plan.id !== 'free'));
const selectedPlan = computed(() => paidPlans.value.find((plan) => plan.id === selectedPlanId.value));
const selectedAmount = computed(() => quote.value?.amountCents ?? selectedPlan.value?.priceCents ?? null);
const canPay = computed(() => membership.value?.paymentAvailable === true && (!miniProgram || !iosDevice));
const rows: Array<{ key: keyof Plan['features']; label: string }> = [
  { key: 'templates', label: '模板简历' }, { key: 'optimization', label: '简历优化' },
  { key: 'aiQuota', label: 'AI 额度' },
  { key: 'companyJobs', label: '岗位信息' }, { key: 'studyMaterials', label: '复习资料' },
  { key: 'smartDelivery', label: '智能投递' },
];
const price = (cents: number | null) => cents === null ? '待定价' : cents === 0 ? '免费' : `¥${(cents / 100).toFixed(2)}`;
const upgradeCopy = computed(() => membership.value?.policy.upgrade.expiryBase === 'payment-time'
  ? '初级有效期内升高级补月价差额，支付成功后重算一个自然月；原剩余天数不叠加。'
  : '升级规则暂时不可用。');
const compactFeatures: Record<PlanId, string[]> = {
  free: ['基础模板', 'Word下载'],
  basic: ['基础模板', '简历优化', '标准周额度'],
  premium: ['初级权益', '更高周额度', '公司岗位', '复习资料', '投递管理'],
};
function cardFeatures(plan: Plan): string[] {
  if (plan.id === 'free') return [plan.features.templates, '填写、预览与下载 Word'];
  if (plan.id === 'basic') return ['包含基础简历模板', '简历优化 · 对照审核后确认应用', plan.features.aiQuota, '一个自然月 · 手动续费'];
  return ['包含初级会员全部权益', plan.features.aiQuota, '岗位筛选、收藏、官方招聘入口与复习资料', '投递计划与进度记录 · 用户手动更新'];
}

function quotaTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}（北京时间）`;
}
async function refreshQuota() {
  if (quotaLoading.value) return;
  quotaLoading.value = true;
  quotaError.value = '';
  try { membership.value = await membershipApi.current(); }
  catch (cause) { quotaError.value = cause instanceof Error ? cause.message : '额度暂时无法刷新，请稍后重试。'; }
  finally { quotaLoading.value = false; }
}
async function load() {
  if (!loading.value) loading.value = true;
  error.value = '';
  membership.value = undefined;
  try {
    const [current, availablePlans] = await Promise.all([membershipApi.current(), membershipApi.plans()]);
    membership.value = current;
    plans.value = availablePlans;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '权益信息暂时不可用，请重试。';
  } finally { loading.value = false; }
}
async function openPurchase(id: PlanId = 'basic') {
  if (!membership.value || !paidPlans.value.length) return;
  selectedPlanId.value = id === 'free' ? 'basic' : id;
  purchaseOpen.value = true;
  paymentError.value = '';
  nativePayment.value = undefined;
  await loadQuote();
}
function closePurchase() {
  purchaseOpen.value = false;
  nativePayment.value = undefined;
}
function selectPlan(id: PlanId) {
  selectedPlanId.value = id;
  paymentError.value = '';
  nativePayment.value = undefined;
  void loadQuote();
}
async function loadQuote() {
  if (!membership.value?.paymentAvailable || selectedPlanId.value === 'free') { quote.value = undefined; return; }
  quoteLoading.value = true;
  quoteError.value = '';
  try { quote.value = await membershipApi.quote(selectedPlanId.value); }
  catch (cause) { quoteError.value = cause instanceof Error ? cause.message : '价格暂时无法确认，请稍后重试。'; }
  finally { quoteLoading.value = false; }
}
function requestId() {
  const random = () => Math.random().toString(36).slice(2).padEnd(8, '0');
  return `pay_${Date.now().toString(36)}_${random()}${random()}`.slice(0, 32);
}
function loginCode(): Promise<string> {
  return new Promise((resolve, reject) => uni.login({
    provider: 'weixin',
    success: (result) => result.code ? resolve(result.code) : reject(new Error('微信登录未返回有效凭证。')),
    fail: () => reject(new Error('微信登录失败，请稍后重试。')),
  }));
}
function requestPayment(payment: { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const options = { provider: 'wxpay', ...payment, success: () => resolve(), fail: (error: unknown) => reject(new Error((error as { errMsg?: string })?.errMsg || '支付未完成。')) };
    uni.requestPayment(options as unknown as UniApp.RequestPaymentOptions);
  });
}
async function waitForPayment(orderId: string, attempts = 10): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!purchaseOpen.value) return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try { if ((await membershipApi.order(orderId)).status === 'paid') return true; } catch { /* keep polling while the callback lands */ }
  }
  return false;
}
async function payNative() {
  paymentError.value = '';
  nativePayment.value = undefined;
  try {
    const result = await membershipApi.checkout(selectedPlanId.value, requestId(), 'native');
    if (!result.native) throw new Error('扫码支付参数缺失，请稍后重试。');
    nativePayment.value = result.native;
    const confirmed = await waitForPayment(result.order.id, 120);
    await load();
    if (confirmed) {
      purchaseOpen.value = false;
      nativePayment.value = undefined;
      uni.showToast({ title: '支付成功', icon: 'success' });
    } else if (purchaseOpen.value) {
      paymentError.value = '二维码已过期或尚未收到支付结果。若已付款请稍后刷新权益，否则请重新获取二维码。';
    }
  } catch (cause) {
    paymentError.value = cause instanceof Error ? cause.message : '支付未完成，请稍后重试。';
  }
}
async function pay() {
  if (!membership.value?.paymentAvailable || !selectedPlan.value || paying.value) return;
  if (miniProgram && iosDevice) { paymentError.value = 'iOS 端暂不支持购买虚拟会员，请使用 Android 或后续开放的方式。'; return; }
  paying.value = true;
  paymentError.value = '';
  try {
    if (!miniProgram) { await payNative(); return; }
    const code = await loginCode();
    await membershipApi.bindWechat(code);
    const result = await membershipApi.checkout(selectedPlanId.value, requestId());
    if (!result.payment) throw new Error('支付参数缺失，请稍后重试。');
    await requestPayment(result.payment);
    const confirmed = await waitForPayment(result.order.id);
    await load();
    if (confirmed) {
      purchaseOpen.value = false;
      uni.showToast({ title: '支付成功', icon: 'success' });
    } else {
      paymentError.value = '支付已完成，权益正在确认中，请稍后刷新查看。';
    }
  } catch (cause) {
    paymentError.value = cause instanceof Error ? cause.message : '支付未完成，请稍后重试。';
  } finally { paying.value = false; }
}
onMounted(load);
</script>

<template>
  <view class="benefits-panel">
    <text class="benefits-preview-note">{{ membership?.paymentAvailable ? '微信支付已开启 · 一个自然月 · 手动续费' : (membership?.mode === 'active' ? '支付暂未开放' : '方案预览 · 支付暂未开放') }}</text>
    <view v-if="loading" class="glass-panel benefits-state" role="status" aria-live="polite"><view class="benefits-loading" /><text>正在读取你的权益…</text></view>
    <view v-else-if="error" class="glass-panel benefits-state" role="alert"><AppIcon name="info" :size="24" /><text>{{ error }}</text><button class="button secondary" @click="load" role="button" tabindex="0">重新加载</button></view>
    <template v-else-if="membership">
      <view class="glass-panel benefits-current">
        <view class="benefits-current-main"><view class="benefits-gem"><AppIcon name="crown" :size="27" /></view><view><text class="benefits-overline">我的当前权益</text><text class="benefits-current-name">{{ membership.currentPlanName }}</text></view></view>
        <button class="button primary benefits-upgrade" @click="openPurchase()" role="button" tabindex="0">查看会员方案<AppIcon name="arrow" :size="16" /></button>
      </view>

      <view class="glass-panel benefits-quota">
        <view class="benefits-quota-heading"><text class="benefits-quota-title">本周 AI 额度</text><button class="text-button" :disabled="quotaLoading" @click="refreshQuota" role="button" tabindex="0">{{ quotaLoading ? '正在刷新…' : '刷新额度' }}</button></view>
        <template v-if="membership.quota.status === 'active'">
          <text class="benefits-quota-value">剩余 {{ membership.quota.remainingPercent }}%</text>
          <view class="benefits-quota-track" role="progressbar" aria-label="本周 AI 剩余额度" :aria-valuenow="membership.quota.remainingPercent ?? 0" :aria-valuemin="0" :aria-valuemax="100"><view class="benefits-quota-fill" :style="{ width: `${membership.quota.remainingPercent}%` }" /></view>
          <text class="benefits-quota-detail">{{ membership.quota.resetsAt === membership.quota.expiresAt ? '本期额度有效至' : '下次刷新' }}：{{ quotaTime(membership.quota.resetsAt) }}</text>
          <text v-if="membership.quota.remainingPercent === 0" class="benefits-quota-detail">{{ membership.quota.resetsAt === membership.quota.expiresAt ? '本周 AI 额度已用完。' : '本周 AI 额度已用完，请等待额度刷新。' }}</text>
        </template>
        <template v-else><text class="benefits-quota-empty">{{ membership.quota.status === 'inactive' ? '会员已到期，AI 额度暂不可用' : 'AI 额度尚未启用' }}</text><text class="benefits-quota-detail">{{ membership.quota.status === 'inactive' ? '历史报告仍可查看，规则功能继续可用。' : '当前为权益预览，未发放会员额度。' }}</text></template>
        <text v-if="membership.quota.pending" class="benefits-quota-detail">有模型用量待确认，确认后更新剩余额度。</text>
        <text v-if="membership.quota.status === 'active'" class="benefits-quota-note">按实际模型用量计入周额度，已产生用量的超时或失败请求也会计入。查看报告、确认应用和规则功能不消耗 AI 额度。</text>
        <text v-if="quotaError" class="benefits-quota-error" role="alert">{{ quotaError }}</text>
      </view>

      <view class="benefits-section-heading"><text class="benefits-section-title">会员方案</text></view>
      <view class="benefits-plans">
        <view v-for="plan in plans" :key="plan.id" class="glass-panel benefit-plan" :class="{ current: plan.id === membership.currentPlanId }">
          <view class="benefit-plan-top"><text class="benefit-plan-name">{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="benefit-badge current">当前方案</text></view>
          <view class="benefit-price"><text class="benefit-price-number">{{ price(plan.priceCents) }}</text><text v-if="plan.durationMonths" class="benefit-period">/ {{ plan.periodLabel }}</text></view>
          <text v-if="plan.promotionLabel && plan.listPriceCents" class="benefit-promo">{{ plan.promotionLabel }} · 原价 {{ price(plan.listPriceCents) }}</text>
          <view class="benefit-card-list benefit-card-list-full"><view v-for="feature in cardFeatures(plan)" :key="feature"><AppIcon name="check" :size="13" /><text>{{ feature }}</text></view></view>
          <view class="benefit-card-list benefit-card-list-compact"><view v-for="feature in compactFeatures[plan.id]" :key="feature"><AppIcon name="check" :size="13" /><text>{{ feature }}</text></view></view>
          <button v-if="plan.id === membership.currentPlanId" class="button secondary benefit-plan-button current" :aria-label="`当前权益：${plan.name}`" disabled role="button"><text class="benefit-action-full">当前权益</text><text class="benefit-action-compact">当前</text></button>
          <button v-else class="button secondary benefit-plan-button" :aria-label="`查看${plan.name}方案详情`" @click="openPurchase(plan.id)" role="button" tabindex="0"><text class="benefit-action-full">查看方案</text><text class="benefit-action-compact">详情</text><AppIcon name="chevron" :size="13" /></button>
        </view>
      </view>

      <view class="benefits-section-heading comparison-heading"><text class="benefits-section-title">权益对比</text></view>
      <scroll-view scroll-x class="benefits-comparison-scroll"><view class="glass-panel benefits-comparison" role="table" aria-label="免费体验、初级会员与高级会员规划权益对比">
        <view class="benefits-comparison-row benefits-comparison-header" role="row"><view role="columnheader">权益</view><view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="columnheader"><text>{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="comparison-current-label">当前</text></view></view>
        <view v-for="row in rows" :key="row.key" class="benefits-comparison-row" role="row">
          <view class="comparison-feature-name" role="rowheader">{{ row.label }}</view>
          <view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="cell" :aria-label="`${row.label}，${plan.name}，${plan.features[row.key].trim() || '待确认'}${plan.id === membership.currentPlanId ? '，当前方案' : ''}`">
            <text class="comparison-value">{{ plan.features[row.key].trim() || '待确认' }}</text>
          </view>
        </view>
      </view></scroll-view>
    </template>

    <AppModal v-if="purchaseOpen && selectedPlan" title="会员方案" :subtitle="membership?.paymentAvailable ? (miniProgram ? '微信支付 · 一个自然月 · 手动续费' : '微信扫码支付 · 一个自然月 · 手动续费') : '当前为方案预览，支付暂未开放'" @close="closePurchase">
      <view class="benefits-checkout-options" role="radiogroup" aria-label="会员方案"><button v-for="plan in paidPlans" :key="plan.id" class="benefits-checkout-option" :class="{ selected: selectedPlanId === plan.id }" @click="selectPlan(plan.id)" role="radio" :aria-checked="selectedPlanId === plan.id" tabindex="0"><text>{{ plan.name }}</text><text>{{ price(plan.priceCents) }}</text></button></view>
      <view class="glass-panel benefits-checkout-summary"><view class="benefits-checkout-summary-heading"><view><text class="benefits-summary-name">{{ selectedPlan.name }}</text><text class="benefits-summary-period">{{ quoteLoading ? '正在确认价格…' : quoteError ? quoteError : (quote?.kind === 'upgrade' ? '升级补差价 · 支付后重算一个自然月' : '一个自然月 · 手动续费') }}</text></view><text class="benefits-summary-price">{{ price(selectedAmount) }}</text></view><view v-for="row in rows" :key="row.key" class="benefits-checkout-feature"><text>{{ row.label }}</text><text class="benefits-checkout-feature-value">{{ selectedPlan.features[row.key].trim() || '待确认' }}</text></view></view>
      <view class="benefits-checkout-message"><AppIcon name="info" :size="17" /><text>{{ upgradeCopy }}已到期按新购计算，不自动续费。</text></view>
      <view v-if="nativePayment" class="benefits-native-payment">
        <image class="benefits-native-qr" :src="nativePayment.qrCodeDataUrl" mode="aspectFit" aria-label="微信支付二维码" />
        <text class="benefits-native-title">请使用微信扫一扫支付 {{ price(selectedAmount) }}</text>
        <text class="benefits-native-note">{{ paying ? '正在等待扫码支付结果…' : '二维码有效期 2 小时，支付成功后自动开通。' }}</text>
      </view>
      <text v-if="paymentError" class="benefits-checkout-error" role="alert">{{ paymentError }}</text>
      <view class="benefits-checkout-footer"><text>{{ !membership?.paymentAvailable ? '支付未开放，不会扣费或开通会员。' : miniProgram && iosDevice ? 'iOS 端暂不支持购买虚拟会员。' : !miniProgram ? '请使用微信扫描二维码完成支付，权益到账后立即生效。' : '支付由微信安全处理，权益到账后立即生效。' }}</text>
        <button v-if="canPay" class="button primary" :disabled="paying || quoteLoading || !quote || !!quoteError" @click="pay" role="button">{{ paying ? '正在支付…' : (miniProgram ? `微信支付 ${price(selectedAmount)}` : nativePayment ? '重新获取二维码' : `微信扫码支付 ${price(selectedAmount)}`) }}</button>
        <button v-else class="button secondary" disabled role="button">{{ !membership?.paymentAvailable ? '支付暂未开放' : iosDevice ? 'iOS 暂不支持' : '暂不可支付' }}</button>
      </view>
    </AppModal>
  </view>
</template>

<style scoped>
.benefits-panel { min-width: 0; padding-bottom: 18px; }
.benefits-preview-note { display: block; color: #536174; font-size: 13px; margin-bottom: 16px; }
.benefits-current,.benefits-quota,.benefit-plan,.benefits-comparison,.benefits-state { background: var(--glass-surface); border: 1px solid var(--glass-line); border-radius: 14px; box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }
.benefits-current { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px; }
.benefits-current-main { display: flex; align-items: center; gap: 18px; min-width: 0; }
.benefits-gem { width: 54px; height: 54px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 12px; background: #edf2fb; color: #2458c5; }
.benefits-overline,.benefits-current-name { display: block; }
.benefits-overline { font-size: 13px; color: #536174; }
.benefits-current-name { margin-top: 5px; font-size: 24px; line-height: 1.4; font-weight: 650; color: #1f2937; }
.benefits-upgrade { border-radius: 10px; }
.benefits-quota { margin-top: 18px; padding: 24px 28px; }
.benefits-quota-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.benefits-quota-title { color: #1f2937; font-size: 16px; font-weight: 600; }
.benefits-quota-value { display: block; margin-top: 14px; color: #1f2937; font-size: 27px; font-weight: 650; line-height: 1.5; }
.benefits-quota-track { height: 8px; margin: 14px 0; border-radius: 8px; background: #e3e9f2; overflow: hidden; }
.benefits-quota-fill { height: 100%; border-radius: inherit; background: #2458c5; }
.benefits-quota-detail,.benefits-quota-note,.benefits-quota-empty,.benefits-quota-error { display: block; font-size: 13px; line-height: 1.8; color: #536174; }
.benefits-quota-empty { margin-top: 14px; font-size: 16px; color: #38465a; }
.benefits-quota-note { margin-top: 14px; }
.benefits-quota-error { margin-top: 12px; color: #a23636; }

.benefits-section-heading { margin: 32px 0 18px; }
.benefits-section-title { display: block; color: #1f2937; font-size: 20px; font-weight: 650; line-height: 1.5; }
.benefits-plans { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
.benefit-plan { padding: 24px 20px; display: flex; flex-direction: column; min-width: 0; position: relative; }
.benefit-plan.current { border-color: #2458c5; box-shadow: inset 0 3px 0 #2458c5, var(--glass-shadow); }
.benefit-plan-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.benefit-plan-name { font-size: 17px; font-weight: 650; color: #1f2937; line-height: 1.7; }
.benefit-badge { color: #2458c5; border: 1px solid #d4dff4; background: #edf2fb; border-radius: 6px; font-size: 12px; padding: 3px 7px; white-space: nowrap; }
.benefit-price { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; margin: 22px 0 24px; color: #1f2937; }
.benefit-promo { display: block; margin-top: -14px; margin-bottom: 18px; color: #b45309; font-size: 12px; line-height: 1.7; }
.benefit-price-number { font-size: 30px; font-weight: 650; line-height: 1.3; }
.benefit-period { color: #536174; font-size: 13px; }
.benefit-card-list { display: flex; flex-direction: column; gap: 14px; margin-bottom: 28px; flex: 1; }
.benefit-card-list > view { display: flex; gap: 9px; align-items: flex-start; font-size: 14px; color: #38465a; line-height: 1.8; }
.benefit-card-list .app-icon { flex-shrink: 0; margin-top: 5px; }
.benefit-card-list-compact,.benefit-action-compact { display: none; }
.benefit-plan-button { width: 100%; font-size: 14px; min-height: 42px; padding: 10px 12px; border-radius: 10px; }
.benefit-plan-button.current { color: #536174; opacity: 1; background: #f4f6f9; cursor: default; }
.benefits-comparison-scroll { display: block; width: 100%; min-width: 0; }
.benefits-comparison { width: 100%; min-width: 620px; overflow: hidden; }
.benefits-comparison-row { display: grid; grid-template-columns: .9fr repeat(3,minmax(0,1fr)); }
.benefits-comparison-row > view { display: flex; align-items: center; justify-content: center; min-width: 0; padding: 19px 14px; text-align: center; font-size: 14px; color: #38465a; line-height: 1.8; border-bottom: 1px solid #e2e7ef; overflow-wrap: anywhere; word-break: break-word; }
.benefits-comparison-row:last-child > view { border-bottom: 0; }
.benefits-comparison-row > view:first-child { justify-content: flex-start; padding-left: 22px; text-align: left; font-weight: 550; }
.benefits-comparison-header > view { font-size: 15px; font-weight: 600; color: #1f2937; background: rgba(244,249,255,.42); flex-direction: column; gap: 6px; }
.benefits-comparison-header > view:first-child { align-items: flex-start; justify-content: center; }
.benefits-comparison-row .current-column { background: rgba(222,234,255,.44); }
.comparison-value { display: block; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.comparison-current-label { color: #2458c5; font-size: 12px; border-radius: 4px; background: #e0e9f9; padding: 1px 7px; }
.benefits-state { min-height: 200px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; text-align: center; padding: 26px; font-size: 15px; color: #536174; }
.benefits-loading { width: 24px; height: 24px; border: 2px solid #d8dfe8; border-top-color: #2458c5; border-radius: 50%; animation: benefits-spin 1s linear infinite; }
@keyframes benefits-spin { to { transform: rotate(360deg); } }
.benefits-checkout-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin-bottom: 20px; }
.benefits-checkout-option { width: 100%; border: 1px solid #d8dfe8; border-radius: 10px; background: #fff; padding: 16px 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; color: #38465a; font-size: 15px; }
.benefits-checkout-option > text:last-child { font-size: 19px; font-weight: 600; }
.benefits-checkout-option.selected { background: #f0f4fc; border-color: #2458c5; color: #2458c5; }
.benefits-checkout-summary { padding: 22px; background: #f4f6f9; border: 1px solid #d8dfe8; border-radius: 14px; }
.benefits-checkout-summary-heading { display: flex; justify-content: space-between; gap: 14px; align-items: center; padding-bottom: 18px; margin-bottom: 7px; border-bottom: 1px solid #d8dfe8; }
.benefits-summary-name,.benefits-summary-period { display: block; }
.benefits-summary-name { font-size: 18px; font-weight: 600; color: #1f2937; }
.benefits-summary-period { font-size: 13px; color: #536174; margin-top: 7px; line-height: 1.7; }
.benefits-summary-price { font-size: 27px; font-weight: 600; color: #1f2937; white-space: nowrap; }
.benefits-checkout-feature { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; font-size: 14px; padding: 10px 0; line-height: 1.8; color: #38465a; }
.benefits-checkout-feature > text:first-child { color: #536174; flex-shrink: 0; }
.benefits-checkout-feature-value { flex: 1; min-width: 0; text-align: right; overflow-wrap: anywhere; }
.benefits-checkout-error { display: block; margin-top: 12px; color: #a23636; font-size: 13px; line-height: 1.8; }
.benefits-checkout-message { display: flex; gap: 10px; align-items: flex-start; padding: 14px 16px; margin-top: 18px; background: #f4f6f9; border: 1px solid #d8dfe8; border-radius: 10px; font-size: 14px; color: #536174; line-height: 1.8; }
.benefits-checkout-message .app-icon { margin-top: 4px; flex-shrink: 0; }
.benefits-native-payment { margin-top: 20px; padding: 18px; display: flex; flex-direction: column; align-items: center; gap: 10px; border: 1px solid #d8dfe8; border-radius: 12px; background: #fff; }
.benefits-native-qr { width: 220px; height: 220px; display: block; }
.benefits-native-title { font-size: 15px; color: #1f2937; line-height: 1.6; text-align: center; }
.benefits-native-note { font-size: 13px; color: #536174; line-height: 1.6; text-align: center; }
.benefits-checkout-footer { margin-top: 24px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.benefits-checkout-footer > text { font-size: 13px; color: #536174; line-height: 1.8; }
@media (max-width: 850px) { .benefits-plans { grid-template-columns: repeat(3,minmax(0,1fr)); }.benefit-plan { padding: 24px; }.benefit-plan-top { align-items: center; }.benefit-price { margin: 18px 0 22px; }.benefit-card-list { margin-bottom: 24px; } }
@media (max-width: 600px) { .benefits-quota { padding: 22px 20px; }.benefits-current { padding: 23px 20px; flex-direction: column; align-items: stretch; gap: 22px; }.benefits-current-main { gap: 14px; }.benefits-gem { width: 48px; height: 48px; }.benefits-current-name { font-size: 22px; }.benefits-upgrade { width: 100%; }.benefits-section-title { font-size: 19px; }.benefits-section-heading { margin-top: 28px; }.benefit-plan { padding: 22px 20px; }.benefits-checkout-summary { padding: 18px 16px; border: 1px solid #d8dfe8; border-radius: 14px; }.benefits-checkout-footer { align-items: stretch; flex-direction: column; gap: 15px; }.benefits-checkout-footer .button { width: 100%; } }
/* Keep compact plan cards on mobile; the full comparison can scroll horizontally. */
@media (max-width: 600px) {
  .benefits-plans { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }
  .benefit-plan { padding: 14px 8px 12px; border-radius: 12px; }
  .benefit-plan-top { flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 5px; min-height: 52px; }
  .benefit-plan-name { font-size: 14px; line-height: 1.6; white-space: normal; overflow-wrap: anywhere; }
  .benefit-badge { padding: 2px 5px; font-size: 12px; }
  .benefit-price { flex-direction: column; align-items: flex-start; gap: 4px; min-height: 54px; margin: 10px 0 14px; }
  .benefit-price-number { font-size: 20px; line-height: 1.4; }
  .benefit-period { font-size: 12px; line-height: 1.6; }
  .benefit-card-list-full,.benefit-action-full { display: none; }
  .benefit-card-list-compact { display: flex; gap: 8px; margin-bottom: 16px; }
  .benefit-card-list-compact > view { gap: 4px; font-size: 13px; line-height: 1.7; min-width: 0; }
  .benefit-card-list-compact .app-icon { display: none; }
  .benefit-card-list-compact text { min-width: 0; overflow-wrap: anywhere; }
  .benefit-action-compact { display: inline; }
  .benefit-plan-button { min-width: 0; min-height: 42px; padding: 9px 4px; gap: 4px; font-size: 13px; white-space: normal; }
}
@media (prefers-reduced-motion: reduce) { .benefits-loading { animation: none; } }
</style>
