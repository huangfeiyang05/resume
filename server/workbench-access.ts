import type { WorkbenchAccess, WorkbenchFeature } from '../shared/workbench.js';
import { workbenchFeatureNames, workbenchPermissions, workbenchRequiredPlan } from '../shared/workbench.js';
import { HttpError } from './errors.js';
import type { JsonStore } from './store.js';

/** Only persisted, currently effective server membership records grant workbench access. */
export async function getWorkbenchAccess(store: JsonStore, userId: string, now = new Date()): Promise<WorkbenchAccess> {
  try {
    const database = await store.read();
    const membership = database.memberships.find(record => record.userId === userId
      && Date.parse(record.startsAt) <= now.getTime() && now.getTime() < Date.parse(record.expiresAt));
    const planId = membership?.planId ?? 'free';
    return { planId, expiresAt: membership?.expiresAt ?? null, features: workbenchPermissions(planId) };
  } catch {
    // An unavailable ledger is not evidence that the account has no membership.
    throw new HttpError(503, 'WORKBENCH_ACCESS_UNAVAILABLE', '暂时无法查询工作台会员权限，请稍后重试。');
  }
}

export async function assertWorkbenchFeature(store: JsonStore, userId: string, feature: WorkbenchFeature, now = new Date()): Promise<WorkbenchAccess> {
  const access = await getWorkbenchAccess(store, userId, now);
  if (!access.features[feature]) {
    const plan = workbenchRequiredPlan[feature] === 'basic' ? '初级' : '高级';
    throw new HttpError(403, 'WORKBENCH_MEMBERSHIP_REQUIRED', `${workbenchFeatureNames[feature]}需升级${plan}会员解锁。`);
  }
  return access;
}
