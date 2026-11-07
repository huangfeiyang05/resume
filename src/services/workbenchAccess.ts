import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { PaidPlanId, PlanId, WorkbenchAccess, WorkbenchFeature } from '../../shared/types';
import { workbenchFeatures, workbenchPermissions, workbenchRequiredPlan } from '../../shared/workbench';
import { ApiError, request } from './api';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const planNames: Record<PlanId, string> = { free: '免费用户', basic: '初级会员', premium: '高级会员' };

/** An invalid or contradictory response must never grant a client capability. */
export function validateWorkbenchAccess(value: unknown): WorkbenchAccess {
  if (!record(value) || !['free', 'basic', 'premium'].includes(value.planId as string) || !record(value.features)) {
    throw new ApiError('工作台权限信息无效，请重新读取。', 'INVALID_WORKBENCH_ACCESS', 502);
  }
  const planId = value.planId as PlanId, expected = workbenchPermissions(planId);
  const validExpiry = planId === 'free' ? value.expiresAt === null
    : typeof value.expiresAt === 'string' && value.expiresAt.length <= 50 && Number.isFinite(Date.parse(value.expiresAt));
  if (!validExpiry || Object.keys(value.features).length !== workbenchFeatures.length
    || !workbenchFeatures.every(feature => value.features && (value.features as Record<string, unknown>)[feature] === expected[feature])) {
    throw new ApiError('工作台权限信息无效，请重新读取。', 'INVALID_WORKBENCH_ACCESS', 502);
  }
  return { planId, expiresAt: value.expiresAt as string | null, features: { ...expected } };
}

export const workbenchAccessApi = {
  async read(): Promise<WorkbenchAccess> {
    return validateWorkbenchAccess(await request<unknown>('/membership/workbench'));
  },
};
export type WorkbenchAccessDecision = { status: 'allowed' }
  | { status: 'upgrade'; planId: PaidPlanId; feature: WorkbenchFeature }
  | { status: 'loading' | 'error' };

export function useWorkbenchAccess(options: { autoLoad?: boolean; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const access = ref<WorkbenchAccess>();
  const loading = ref(true), error = ref(''), clock = ref(now());
  let disposed = false, requestId = 0, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = computed(() => !!access.value && !loading.value && !error.value);
  const planId = computed<PlanId>(() => {
    const current = access.value;
    if (!current || (current.expiresAt !== null && Date.parse(current.expiresAt) <= clock.value)) return 'free';
    return current.planId;
  });
  const planName = computed(() => ready.value ? planNames[planId.value] : '');
  function refreshClock() { clock.value = now(); }
  function canUse(feature: WorkbenchFeature) {
    return ready.value && !!access.value?.features[feature]
      && (planId.value === 'premium' || (planId.value === 'basic' && workbenchRequiredPlan[feature] === 'basic'));
  }
  function check(feature: WorkbenchFeature): WorkbenchAccessDecision {
    refreshClock();
    if (loading.value) return { status: 'loading' };
    if (!ready.value) return { status: 'error' };
    return canUse(feature) ? { status: 'allowed' } : { status: 'upgrade', planId: workbenchRequiredPlan[feature], feature };
  }
  function scheduleExpiry() {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const expiresAt = access.value?.expiresAt;
    if (!expiresAt || disposed) return;
    const remaining = Date.parse(expiresAt) - now();
    if (remaining <= 0) { refreshClock(); return; }
    expiryTimer = setTimeout(() => { refreshClock(); scheduleExpiry(); }, Math.min(remaining, 2_147_483_647));
  }
  async function load(): Promise<boolean> {
    if (disposed) return false;
    const currentRequest = ++requestId;
    // Re-checking must not leave a previously paid account locally unlocked.
    access.value = undefined; loading.value = true; error.value = '';
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    try {
      const result = await workbenchAccessApi.read();
      if (disposed || currentRequest !== requestId) return false;
      access.value = result; refreshClock(); scheduleExpiry();
      return true;
    } catch (cause) {
      if (!disposed && currentRequest === requestId) error.value = cause instanceof Error ? cause.message : '无法读取工作台权限，请重试。';
      return false;
    } finally { if (!disposed && currentRequest === requestId) loading.value = false; }
  }
  function dispose() {
    disposed = true; ++requestId;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    access.value = undefined;
  }
  if (options.autoLoad !== false) { onMounted(load); onUnmounted(dispose); }
  return { access, loading, error, ready, planId, planName, canUse, check, load, refreshClock, dispose };
}
