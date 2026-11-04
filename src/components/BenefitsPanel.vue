<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MembershipPreview, Plan, PlanId } from '../../shared/types';
import { membershipApi } from '../services/membership';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';

const emit = defineEmits<{ explore: [] }>();
const membership = ref<MembershipPreview>();
const plans = ref<Plan[]>([]);
const loading = ref(true);
const error = ref('');
const purchaseOpen = ref(false);
const selectedPlanId = ref<PlanId>('basic');
const paidPlans = computed(() => plans.value.filter((plan) => plan.id !== 'free'));
const selectedPlan = computed(() => paidPlans.value.find((plan) => plan.id === selectedPlanId.value));
const rows: Array<{ key: keyof Plan['features']; label: string }> = [
  { key: 'templates', label: '模板简历' }, { key: 'optimization', label: '简历优化' },
  { key: 'companyJobs', label: '公司与岗位信息' }, { key: 'studyMaterials', label: '复习资料' },
  { key: 'smartDelivery', label: '智能投递' },
];
const price = (cents: number | null) => cents === null ? '待定价' : cents === 0 ? '免费' : `¥${(cents / 100).toFixed(2)}`;
const upgradeCopy = computed(() => membership.value?.policy.upgrade.expiryBase === 'payment-time'
  ? '初级有效期内升高级补月价差额，支付成功后重算一个自然月；原剩余天数不叠加。'
  : '升级规则暂时不可用。');
const compactFeatures: Record<PlanId, string[]> = {
  free: ['基础模板', 'Word下载'],
  basic: ['基础模板', '简历优化', '手动续费'],
  premium: ['初级权益', '公司岗位', '复习资料', '投递管理'],
};
function cardFeatures(plan: Plan): string[] {
  if (plan.id === 'free') return [plan.features.templates, '填写、预览与下载 Word'];
  if (plan.id === 'basic') return ['包含基础简历模板', '简历优化 · 对照审核后确认应用', '一个自然月 · 手动续费'];
  return ['包含初级会员全部权益', '岗位筛选、收藏、官方招聘入口与复习资料', '投递计划与进度记录 · 用户手动更新'];
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
function openPurchase(id: PlanId = 'basic') {
  if (!membership.value || !paidPlans.value.length) return;
  selectedPlanId.value = id === 'free' ? 'basic' : id;
  purchaseOpen.value = true;
}
function selectPlan(id: PlanId) {
  selectedPlanId.value = id;
}
onMounted(load);
</script>

<template>
  <view class="benefits-panel">
    <text class="benefits-preview-note">方案预览 · 支付暂未开放</text>
    <view v-if="loading" class="glass-panel benefits-state" role="status" aria-live="polite"><view class="benefits-loading" /><text>正在读取你的权益…</text></view>
    <view v-else-if="error" class="glass-panel benefits-state" role="alert"><AppIcon name="info" :size="24" /><text>{{ error }}</text><button class="button secondary" @click="load" role="button" tabindex="0">重新加载</button></view>
    <template v-else-if="membership">
      <view class="glass-panel benefits-current">
        <view class="benefits-current-main"><view class="benefits-gem"><AppIcon name="crown" :size="27" /></view><view><text class="benefits-overline">我的当前权益</text><text class="benefits-current-name">{{ membership.currentPlanName }}</text></view></view>
        <button class="button primary benefits-upgrade" @click="openPurchase()" role="button" tabindex="0">查看会员方案<AppIcon name="arrow" :size="16" /></button>
      </view>

      <view class="benefits-section-heading"><text class="benefits-section-title">会员方案</text></view>
      <view class="benefits-plans">
        <view v-for="plan in plans" :key="plan.id" class="glass-panel benefit-plan" :class="{ current: plan.id === membership.currentPlanId }">
          <view class="benefit-plan-top"><text class="benefit-plan-name">{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="benefit-badge current">当前方案</text></view>
          <view class="benefit-price"><text class="benefit-price-number">{{ price(plan.priceCents) }}</text><text v-if="plan.durationMonths" class="benefit-period">/ {{ plan.periodLabel }}</text></view>
          <view class="benefit-card-list benefit-card-list-full"><view v-for="feature in cardFeatures(plan)" :key="feature"><AppIcon name="check" :size="13" /><text>{{ feature }}</text></view></view>
          <view class="benefit-card-list benefit-card-list-compact"><view v-for="feature in compactFeatures[plan.id]" :key="feature"><AppIcon name="check" :size="13" /><text>{{ feature }}</text></view></view>
          <button v-if="plan.id === membership.currentPlanId" class="button secondary benefit-plan-button current" :aria-label="`当前权益：${plan.name}`" disabled role="button"><text class="benefit-action-full">当前权益</text><text class="benefit-action-compact">当前</text></button>
          <button v-else class="button secondary benefit-plan-button" :aria-label="`查看${plan.name}方案详情`" @click="openPurchase(plan.id)" role="button" tabindex="0"><text class="benefit-action-full">查看方案</text><text class="benefit-action-compact">详情</text><AppIcon name="chevron" :size="13" /></button>
        </view>
      </view>


      <view class="glass-panel benefits-workspace"><view><text class="benefits-section-title">求职工作台</text><text>管理岗位、简历与投递进度。</text></view><button class="button primary" @click="emit('explore')" role="button" tabindex="0">进入工作台<AppIcon name="arrow" :size="16" /></button></view>

      <view class="benefits-section-heading comparison-heading"><text class="benefits-section-title">权益对比</text></view>
      <view class="glass-panel benefits-comparison" role="table" aria-label="免费体验与两级会员规划权益对比">
        <view class="benefits-comparison-row benefits-comparison-header" role="row"><view role="columnheader">权益</view><view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="columnheader"><text>{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="comparison-current-label">当前</text></view></view>
        <view v-for="row in rows" :key="row.key" class="benefits-comparison-row" role="row">
          <view class="comparison-feature-name" role="rowheader">{{ row.label }}</view>
          <view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="cell" :aria-label="`${row.label}，${plan.name}，${plan.features[row.key]}${plan.id === membership.currentPlanId ? '，当前方案' : ''}`">
            <view class="comparison-plan-label" aria-hidden="true"><text>{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="comparison-current-label">当前</text></view>
            <text class="comparison-value">{{ plan.features[row.key] }}</text>
          </view>
        </view>
      </view>
    </template>

    <AppModal v-if="purchaseOpen && selectedPlan" title="会员方案" subtitle="价格待定，支付未开放" @close="purchaseOpen = false">
      <view class="benefits-checkout-options" role="radiogroup" aria-label="会员方案"><button v-for="plan in paidPlans" :key="plan.id" class="benefits-checkout-option" :class="{ selected: selectedPlanId === plan.id }" @click="selectPlan(plan.id)" role="radio" :aria-checked="selectedPlanId === plan.id" tabindex="0"><text>{{ plan.name }}</text><text>{{ price(plan.priceCents) }}</text></button></view>
      <view class="glass-panel benefits-checkout-summary"><view class="benefits-checkout-summary-heading"><view><text class="benefits-summary-name">{{ selectedPlan.name }}</text><text class="benefits-summary-period">一个自然月 · 手动续费</text></view><text class="benefits-summary-price">{{ price(selectedPlan.priceCents) }}</text></view><view v-for="row in rows" :key="row.key" class="benefits-checkout-feature"><text>{{ row.label }}</text><text>{{ selectedPlan.features[row.key] }}</text></view></view>
      <view class="benefits-checkout-message"><AppIcon name="info" :size="17" /><text>{{ upgradeCopy }}已到期按新购计算，不自动续费。</text></view>
      <view class="benefits-checkout-footer"><text>支付未开放，不会扣费或开通会员。</text><button class="button secondary" disabled role="button">支付暂未开放</button></view>
    </AppModal>
  </view>
</template>

<style scoped>
.benefits-panel { min-width: 0; padding-bottom: 18px; }
.benefits-preview-note { display: block; color: #536174; font-size: 13px; margin-bottom: 16px; }
.benefits-current,.benefit-plan,.benefits-comparison,.benefits-state,.benefits-workspace { background: var(--glass-surface); border: 1px solid var(--glass-line); border-radius: 14px; box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }
.benefits-current { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px; }
.benefits-current-main { display: flex; align-items: center; gap: 18px; min-width: 0; }
.benefits-gem { width: 54px; height: 54px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 12px; background: #edf2fb; color: #2458c5; }
.benefits-overline,.benefits-current-name { display: block; }
.benefits-overline { font-size: 13px; color: #536174; }
.benefits-current-name { margin-top: 5px; font-size: 24px; line-height: 1.4; font-weight: 650; color: #1f2937; }
.benefits-upgrade { border-radius: 10px; }
.benefits-section-heading { margin: 32px 0 18px; }
.benefits-section-title { display: block; color: #1f2937; font-size: 20px; font-weight: 650; line-height: 1.5; }
.benefits-plans { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
.benefit-plan { padding: 24px 20px; display: flex; flex-direction: column; min-width: 0; position: relative; }
.benefit-plan.current { border-color: #2458c5; box-shadow: inset 0 3px 0 #2458c5, var(--glass-shadow); }
.benefit-plan-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.benefit-plan-name { font-size: 17px; font-weight: 650; color: #1f2937; line-height: 1.7; }
.benefit-badge { color: #2458c5; border: 1px solid #d4dff4; background: #edf2fb; border-radius: 6px; font-size: 12px; padding: 3px 7px; white-space: nowrap; }
.benefit-price { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; margin: 22px 0 24px; color: #1f2937; }
.benefit-price-number { font-size: 30px; font-weight: 650; line-height: 1.3; }
.benefit-period { color: #536174; font-size: 13px; }
.benefit-card-list { display: flex; flex-direction: column; gap: 14px; margin-bottom: 28px; flex: 1; }
.benefit-card-list > view { display: flex; gap: 9px; align-items: flex-start; font-size: 14px; color: #38465a; line-height: 1.8; }
.benefit-card-list .app-icon { flex-shrink: 0; margin-top: 5px; }
.benefit-card-list-compact,.benefit-action-compact { display: none; }
.benefit-plan-button { width: 100%; font-size: 14px; min-height: 42px; padding: 10px 12px; border-radius: 10px; }
.benefit-plan-button.current { color: #536174; opacity: 1; background: #f4f6f9; cursor: default; }
.benefits-workspace { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 26px; margin-top: 24px; }
.benefits-workspace > view > text:last-child { display: block; color: #536174; font-size: 14px; line-height: 1.8; margin-top: 7px; }
.benefits-comparison { width: 100%; min-width: 0; overflow: hidden; }
.comparison-plan-label { display: none; }
.comparison-value { display: block; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.benefits-comparison-row { display: grid; grid-template-columns: .9fr repeat(3,minmax(0,1fr)); }
.benefits-comparison-row > view { display: flex; align-items: center; justify-content: center; min-width: 0; padding: 19px 14px; text-align: center; font-size: 14px; color: #38465a; line-height: 1.8; border-bottom: 1px solid #e2e7ef; overflow-wrap: anywhere; word-break: break-word; }
.benefits-comparison-row:last-child > view { border-bottom: 0; }
.benefits-comparison-row > view:first-child { justify-content: flex-start; padding-left: 22px; text-align: left; font-weight: 550; }
.benefits-comparison-header > view { font-size: 15px; font-weight: 600; color: #1f2937; background: rgba(244,249,255,.42); flex-direction: column; gap: 6px; }
.benefits-comparison-header > view:first-child { align-items: flex-start; justify-content: center; }
.benefits-comparison-row .current-column { background: rgba(222,234,255,.44); }
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
.benefits-checkout-feature > text:last-child { text-align: right; }
.benefits-checkout-message { display: flex; gap: 10px; align-items: flex-start; padding: 14px 16px; margin-top: 18px; background: #f4f6f9; border: 1px solid #d8dfe8; border-radius: 10px; font-size: 14px; color: #536174; line-height: 1.8; }
.benefits-checkout-message .app-icon { margin-top: 4px; flex-shrink: 0; }
.benefits-checkout-footer { margin-top: 24px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.benefits-checkout-footer > text { font-size: 13px; color: #536174; line-height: 1.8; }
@media (max-width: 850px) { .benefits-plans { grid-template-columns: repeat(3,minmax(0,1fr)); }.benefit-plan { padding: 24px; }.benefit-plan-top { align-items: center; }.benefit-price { margin: 18px 0 22px; }.benefit-card-list { margin-bottom: 24px; } }
@media (max-width: 600px) { .benefits-current { padding: 23px 20px; flex-direction: column; align-items: stretch; gap: 22px; }.benefits-current-main { gap: 14px; }.benefits-gem { width: 48px; height: 48px; }.benefits-current-name { font-size: 22px; }.benefits-upgrade { width: 100%; }.benefits-section-title { font-size: 19px; }.benefits-section-heading { margin-top: 28px; }.benefit-plan { padding: 22px 20px; }.benefits-workspace { padding: 23px 20px; align-items: stretch; flex-direction: column; gap: 18px; }.benefits-workspace .button { width: 100%; }.benefits-checkout-summary { padding: 18px 16px; border: 1px solid #d8dfe8; border-radius: 14px; }.benefits-checkout-footer { align-items: stretch; flex-direction: column; gap: 15px; }.benefits-checkout-footer .button { width: 100%; } }
/* Each mobile feature shows all three plans in place, with no horizontal scroller. */
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
  .benefits-comparison { overflow: visible; background: transparent; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
  .benefits-comparison-row { grid-template-columns: repeat(3,minmax(0,1fr)); margin-bottom: 12px; border: 1px solid var(--glass-line); border-radius: 12px; overflow: hidden; background: var(--glass-surface); box-shadow: var(--glass-shadow); backdrop-filter: blur(20px) saturate(135%); -webkit-backdrop-filter: blur(20px) saturate(135%); }
  .benefits-comparison-row:last-child { margin-bottom: 0; }
  .benefits-comparison-row > view { flex-direction: column; justify-content: flex-start; padding: 12px 8px; border-bottom: 0; font-size: 14px; line-height: 1.8; min-width: 0; white-space: normal; }
  .benefits-comparison-row > .comparison-feature-name:first-child { grid-column: 1 / -1; align-items: flex-start; padding: 11px 12px; border-bottom: 1px solid #d8dfe8; background: rgba(244,249,255,.42); color: #1f2937; font-size: 15px; font-weight: 600; }
  .comparison-plan-label { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 3px 4px; width: 100%; min-height: 43px; margin-bottom: 8px; font-size: 13px; line-height: 1.5; font-weight: 600; color: #536174; }
  .current-column .comparison-plan-label { color: #2458c5; }
  .comparison-plan-label .comparison-current-label { padding: 1px 5px; font-weight: 500; }
  .comparison-value { width: 100%; }
  /* Keep the table's complete column headers available to assistive technology. */
  .benefits-comparison-header { position: absolute; width: 1px; height: 1px; padding: 0; margin: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) { .benefits-loading { animation: none; } }
</style>
