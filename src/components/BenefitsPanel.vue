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
  ? '初级有效期内升高级，只补两档月价差额。服务端确认支付成功后立即生效，从升级时刻重新计算一个自然月，原剩余天数不叠加。'
  : '升级规则暂时不可用。');
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
        <view class="benefits-current-main"><view class="benefits-gem"><AppIcon name="sparkles" :size="27" /></view><view><text class="benefits-overline">我的当前权益</text><text class="benefits-current-name">{{ membership.currentPlanName }}</text><text class="benefits-current-copy">基础模板可使用，会员分级仍在预览，暂不按套餐限制体验。</text></view></view>
        <button class="button primary benefits-upgrade" @click="openPurchase()" role="button" tabindex="0">查看会员方案<AppIcon name="arrow" :size="16" /></button>
      </view>

      <view class="benefits-section-heading"><text class="benefits-section-title">从模板起步，为机会做好准备。</text><text class="benefits-section-copy">初级专注简历优化，高级增加分专业资料与精选投递。</text></view>
      <view class="benefits-plans">
        <view v-for="plan in plans" :key="plan.id" class="glass-panel benefit-plan" :class="{ current: plan.id === membership.currentPlanId }">
          <view class="benefit-plan-top"><text class="benefit-plan-name">{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="benefit-badge current">当前方案</text><text v-else-if="plan.highlight" class="benefit-badge">{{ plan.highlight }}</text></view>
          <view class="benefit-price"><text class="benefit-price-number">{{ price(plan.priceCents) }}</text><text v-if="plan.durationMonths" class="benefit-period">/ {{ plan.periodLabel }}</text></view>
          <text class="benefit-plan-description">{{ plan.description }}</text>
          <view class="benefit-card-list"><view v-for="feature in cardFeatures(plan)" :key="feature"><AppIcon name="check" :size="13" /><text>{{ feature }}</text></view></view>
          <button v-if="plan.id === membership.currentPlanId" class="button secondary benefit-plan-button current" disabled role="button">当前权益</button>
          <button v-else class="button secondary benefit-plan-button" @click="openPurchase(plan.id)" role="button" tabindex="0">查看方案<AppIcon name="chevron" :size="13" /></button>
        </view>
      </view>

      <view class="glass-panel benefits-policy"><text class="benefits-section-title">升级补差价，重新计算一个月。</text><text>{{ upgradeCopy }}</text><text>到期日按北京时间计算；次月没有对应日期时取月底同一时刻。同档续费从当前到期日顺延一个月，已到期则从支付成功时起算。不自动续费。</text></view>

      <view class="glass-panel benefits-policy"><text class="benefits-section-title">进入求职工作台</text><text>添加目标岗位、收藏机会，绑定已保存的简历版本建立投递计划，再手动记录投递和面试进度。可按专业查阅准备材料和官方招聘入口，具体岗位需核对当期公告。</text><button class="button primary" @click="emit('explore')" role="button" tabindex="0">体验主要功能<AppIcon name="arrow" :size="16" /></button></view>

      <view class="benefits-section-heading comparison-heading"><text class="benefits-section-title">每一项权益，都看得清楚。</text><text class="benefits-section-copy">以下为规划分级，价格与使用次数待定。工作台已开放功能预览，可查阅首批准备资料与官方招聘入口，自动代投尚未接入。</text></view>
      <view class="glass-panel benefits-comparison" role="table" aria-label="免费体验与两级会员规划权益对比">
        <view class="benefits-comparison-row benefits-comparison-header" role="row"><view role="columnheader">权益</view><view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="columnheader"><text>{{ plan.name }}</text><text v-if="plan.id === membership.currentPlanId" class="comparison-current-label">当前</text></view></view>
        <view v-for="row in rows" :key="row.key" class="benefits-comparison-row" role="row"><view class="comparison-feature-name" role="rowheader">{{ row.label }}</view><view v-for="plan in plans" :key="plan.id" :class="{ 'current-column': plan.id === membership.currentPlanId }" role="cell">{{ plan.features[row.key] }}</view></view>
      </view>
      <text class="benefits-capability-note">当前诊断能力以实际服务配置为准：未启用模型时使用本地规则，关键词仅表示文本覆盖；优化建议须核实事实后确认应用。会员方案不代表真实 AI 或投递服务已开放。</text>
    </template>

    <AppModal v-if="purchaseOpen && selectedPlan" title="选择适合自己的会员" subtitle="方案预览 · 价格待定 · 支付暂未开放" @close="purchaseOpen = false">
      <view class="benefits-checkout-options" role="radiogroup" aria-label="会员方案"><button v-for="plan in paidPlans" :key="plan.id" class="benefits-checkout-option" :class="{ selected: selectedPlanId === plan.id }" @click="selectPlan(plan.id)" role="radio" :aria-checked="selectedPlanId === plan.id" tabindex="0"><text>{{ plan.name }}</text><text>{{ price(plan.priceCents) }}</text></button></view>
      <view class="glass-panel benefits-checkout-summary"><view class="benefits-checkout-summary-heading"><view><text class="benefits-summary-name">{{ selectedPlan.name }}</text><text class="benefits-summary-period">一个自然月 · 手动续费</text></view><text class="benefits-summary-price">{{ price(selectedPlan.priceCents) }}</text></view><view v-for="row in rows" :key="row.key" class="benefits-checkout-feature"><text>{{ row.label }}</text><text>{{ selectedPlan.features[row.key] }}</text></view></view>
      <view class="benefits-checkout-message"><AppIcon name="info" :size="17" /><text>{{ upgradeCopy }}初级已到期时，按高级会员新购。</text></view>
      <view class="benefits-checkout-footer"><text>价格与优化次数待定，支付开放后才能开通会员。</text><button class="button secondary" disabled role="button">支付暂未开放</button></view>
    </AppModal>
  </view>
</template>

<style scoped>
.benefits-panel { min-width: 0; padding-bottom: 18px; }
.benefits-preview-note { display: block; color: #8294ab; font-size: 10px; margin-bottom: 15px; letter-spacing: .3px; }
.benefits-current,.benefit-plan,.benefits-comparison,.benefits-state,.benefits-checkout-summary { background: linear-gradient(135deg,#ffffffde,#f5faffaa); border: 1px solid #ffffffed; box-shadow: inset 0 1px 0 #fff,0 8px 25px #7285a50b; backdrop-filter: blur(20px) saturate(145%); border-radius: 19px; }
.benefits-current { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 27px 30px; background: radial-gradient(ellipse at 90% 0,#b9dcff55,transparent 60%),linear-gradient(130deg,#fffdfef0,#eaf5ff99); }
.benefits-current-main { display: flex; align-items: center; gap: 18px; min-width: 0; }
.benefits-gem { width: 59px; height: 59px; display: flex; align-items: center; justify-content: center; border-radius: 19px; background: linear-gradient(145deg,#ffffffed,#dbeeffb3); border: 1px solid #fff; box-shadow: inset 0 1px 4px #fff,0 6px 14px #4e88c918; }
.benefits-overline,.benefits-current-name,.benefits-current-copy { display: block; }
.benefits-overline { font-size: 10px; color: #7a8b9f; letter-spacing: .5px; }
.benefits-current-name { margin: 7px 0; font-size: 23px; font-weight: 600; letter-spacing: -.6px; color: #29374c; }
.benefits-current-copy { font-size: 10px; color: #8390a3; line-height: 1.8; }
.benefits-upgrade { border-radius: 12px; }
.benefits-section-heading { margin: 32px 0 17px; }
.benefits-section-title { display: block; color: #36445a; font-size: 17px; font-weight: 550; letter-spacing: -.3px; }
.benefits-section-copy { display: block; font-size: 10px; color: #8b99aa; margin-top: 8px; line-height: 1.8; }
.benefits-plans { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }
.benefit-plan { padding: 20px 18px; display: flex; flex-direction: column; min-width: 0; position: relative; }
.benefit-plan.current { border-color: #9acbf0b0; box-shadow: inset 0 1px 0 #fff,0 6px 20px #548bc510; background: linear-gradient(145deg,#fafdffff,#e8f4ffab); }
.benefit-plan-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 5px; min-height: 26px; flex-wrap: wrap; }
.benefit-plan-name { font-size: 13px; font-weight: 550; color: #43546b; }
.benefit-badge { color: #7f98b6; border: 1px solid #dce8f4; background: #f3f8fe; border-radius: 6px; font-size: 8px; padding: 3px 5px; white-space: nowrap; }
.benefit-badge.current { color: #2473bd; background: #e5f2ff; border-color: #cee5fa; }
.benefit-price { display: flex; align-items: baseline; gap: 2px; margin-top: 18px; color: #2c496b; white-space: nowrap; }
.benefit-currency { font-size: 17px; font-weight: 450; }.benefit-price-number { font-size: 33px; letter-spacing: -1px; font-weight: 600; }.benefit-period { color: #97a3b3; font-size: 9px; margin-left: 4px; }
.benefit-plan-description { font-size: 9px; color: #95a0af; line-height: 1.8; margin: 8px 0 17px; min-height: 32px; }
.benefit-card-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 23px; flex: 1; }
.benefit-card-list > view { display: flex; gap: 6px; align-items: flex-start; font-size: 10px; color: #73859b; line-height: 1.7; }.benefit-card-list .app-icon { opacity: .6; margin-top: 2px; }
.benefit-plan-button { width: 100%; font-size: 10px; min-height: 36px; padding: 9px 5px; border-radius: 10px; background: #ffffff8a; border-color: #d6e4f270; color: #5e7c9b; }.benefit-plan-button.current { color: #4e86b6; opacity: .8; cursor: default; }
.benefits-comparison { overflow: hidden; }
.benefits-comparison-row { display: grid; grid-template-columns: .9fr repeat(3,minmax(0,1fr)); }
.benefits-comparison-row > view { display: flex; align-items: center; justify-content: center; min-width: 0; padding: 17px 9px; text-align: center; font-size: 11px; color: #718299; line-height: 1.8; border-bottom: 1px solid #e6edf488; overflow-wrap: anywhere; word-break: break-word; }
.benefits-comparison-row:last-child > view { border-bottom: 0; }.benefits-comparison-row > view:first-child { justify-content: flex-start; padding-left: 21px; color: #6b7d94; text-align: left; }.benefits-comparison-header > view { font-size: 11px; font-weight: 550; color: #4b6481; flex-direction: column; gap: 5px; }.benefits-comparison-header > view:first-child { align-items: flex-start; justify-content: center; }.benefits-comparison-row .current-column { background: #e4f2ff60; color: #4777a7; }.comparison-current-label { color: #4487c2; font-size: 8px; border-radius: 4px; background: #ddecfb; padding: 1px 6px; }
.benefits-state { min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 17px; text-align: center; padding: 25px; font-size: 12px; color: #8594a9; }
.benefits-loading { width: 23px; height: 23px; border: 2px solid #dbe9f4; border-top-color: #72aae0; border-radius: 50%; animation: benefits-spin 1s linear infinite; }@keyframes benefits-spin { to { transform: rotate(360deg); } }
.benefits-checkout-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-bottom: 17px; }.benefits-checkout-option { border: 1px solid #e0eaf3; border-radius: 12px; background: #f7fafd; padding: 14px 8px; display: flex; flex-direction: column; align-items: center; gap: 7px; color: #8997a8; font-size: 11px; }.benefits-checkout-option > text:last-child { font-size: 16px; font-weight: 550; }.benefits-checkout-option.selected { background: #edf6ff; border-color: #84bdf1; color: #387fbf; box-shadow: inset 0 1px 0 #fff; }
.benefits-checkout-summary { padding: 21px; background: linear-gradient(140deg,#f5faff,#f9fbfdbb); border-color: #e4edf6; }.benefits-checkout-summary-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding-bottom: 17px; margin-bottom: 6px; border-bottom: 1px solid #e4edf5; }.benefits-summary-name,.benefits-summary-period { display: block; }.benefits-summary-name { font-size: 15px; font-weight: 550; color: #476582; }.benefits-summary-period { font-size: 9px; color: #8f9fb1; margin-top: 7px; line-height: 1.7; }.benefits-summary-price { font-size: 27px; font-weight: 550; color: #426f9c; white-space: nowrap; }.benefits-checkout-feature { display: flex; justify-content: space-between; align-items: flex-start; gap: 17px; font-size: 11px; padding: 9px 0; line-height: 1.8; color: #7890a8; }.benefits-checkout-feature > text:first-child { color: #899bad; flex-shrink: 0; }.benefits-checkout-feature > text:last-child { text-align: right; }
.benefits-checkout-message { display: flex; gap: 9px; align-items: flex-start; padding: 13px 15px; margin-top: 16px; background: #fff8ed; border: 1px solid #f1e3ca; border-radius: 10px; font-size: 11px; color: #9c825e; line-height: 1.8; }.benefits-checkout-message .app-icon { margin-top: 2px; opacity: .7; }
.benefits-checkout-footer { margin-top: 23px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }.benefits-checkout-footer > text { font-size: 9px; color: #9aa7b5; line-height: 1.8; }
.benefits-policy { padding: 23px; margin-top: 22px; background: linear-gradient(135deg,#f3f9ff,#fff); border: 1px solid #dae8f5; border-radius: 18px; }
.benefits-policy > text { display: block; font-size: 12px; line-height: 1.9; color: #647c97; margin-top: 10px; }
.benefits-policy > .benefits-section-title { color: #36445a; font-size: 16px; margin-top: 0; }
.benefits-capability-note { display: block; font-size: 11px; line-height: 1.9; color: #6f8197; margin-top: 17px; }
@media (max-width: 1100px) { .benefit-plan-description { min-height: 0; }.benefit-plan-top { min-height: 23px; } }
@media (max-width: 600px) { .benefits-current { padding: 21px 18px; flex-direction: column; align-items: flex-start; gap: 20px; }.benefits-current-main { gap: 13px; }.benefits-gem { width: 47px; height: 47px; border-radius: 15px; }.benefits-current-name { font-size: 21px; }.benefits-current-copy { font-size: 9px; }.benefits-upgrade { width: 100%; font-size: 11px; }.benefits-section-title { font-size: 15px; }.benefits-section-copy { font-size: 9px; }.benefits-plans { gap: 10px; }.benefit-plan { padding: 18px 12px; border-radius: 16px; }.benefit-plan-name { font-size: 12px; }.benefit-badge { font-size: 7px; padding: 2px 4px; }.benefit-price-number { font-size: 30px; }.benefit-currency { font-size: 15px; }.benefit-period { font-size: 8px; margin-left: 2px; }.benefit-plan-description { font-size: 8px; min-height: 29px; margin-bottom: 13px; }.benefit-card-list { gap: 9px; }.benefit-card-list > view { font-size: 9px; gap: 4px; }.benefits-comparison-row > view { font-size: 10px; padding: 12px 4px; line-height: 1.9; }.benefits-comparison-row > view:first-child { padding-left: 9px; }.benefits-comparison-header > view { font-size: 10px; padding-top: 15px; padding-bottom: 15px; }.comparison-current-label { font-size: 7px; }.benefits-comparison { border-radius: 15px; }.benefits-checkout-summary { padding: 17px 14px; }.benefits-checkout-footer { flex-wrap: wrap; }.benefits-checkout-footer > text { width: 100%; }.benefits-checkout-footer .button { width: 100%; }.benefits-checkout-option { font-size: 10px; padding: 12px 4px; } }
.benefits-section-copy,.benefits-current-copy,.benefit-plan-description,.benefit-period,.benefits-summary-period,.benefits-checkout-footer > text { color: #6f8197; }
.benefits-checkout-option { width: 100%; }.benefit-card-list > view { color: #5d738d; }
@media (max-width: 600px) {
 .benefits-plans { grid-template-columns: minmax(0,1fr); }.benefit-plan-top { min-height: 0; }.benefit-plan-description { min-height: 0; }.benefits-policy { padding: 20px 17px; }
 .benefits-preview-note,.benefits-overline,.benefits-current-copy,.benefits-section-copy,.benefit-period,.benefit-plan-description,.benefits-summary-period,.benefits-checkout-footer > text { font-size: 11px; }
 .benefits-upgrade { min-height: 46px; font-size: 14px; }.benefits-section-title { font-size: 17px; }.benefit-plan-name { font-size: 14px; }.benefit-badge { font-size: 9px; }.benefit-plan-top { min-height: 42px; }.benefit-card-list > view { font-size: 12px; }.benefit-plan-button { font-size: 12px; min-height: 40px; }.benefit-card-list .app-icon { flex-shrink: 0; }
 .benefits-checkout-feature { font-size: 12px; }.benefits-checkout-option { font-size: 12px; }.benefits-checkout-message { font-size: 12px; }.benefits-comparison-header > view { font-size: 11px; }
}
@media (prefers-reduced-motion: reduce) { .benefits-loading { animation: none; } }
</style>
