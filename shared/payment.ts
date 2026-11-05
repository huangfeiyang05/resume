import type { PaidPlanId, PlanId } from './membership.js';

export type PaymentOrderStatus = 'pending' | 'paid' | 'closed' | 'failed';

/** Client-safe order summary. It never contains WeChat secrets, openid or raw callback data. */
export interface PaymentOrder {
  id: string;
  planId: PaidPlanId;
  amountCents: number;
  status: PaymentOrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
}

/** Parameters passed to `uni.requestPayment` on the mini-program client. */
export interface WechatPaymentParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export interface CheckoutResult {
  order: PaymentOrder;
  payment: WechatPaymentParams;
}

/** Server-side quote used by the confirmation screen before an order is created. */
export interface MembershipQuote {
  planId: PaidPlanId;
  amountCents: number;
  listPriceCents?: number;
  promotionLabel?: string;
  kind: 'purchase' | 'renewal' | 'upgrade';
  currentPlanId: PlanId;
}

export interface WechatBindResult {
  bound: true;
  /** Masked openid for support/debugging; the full value never leaves the server. */
  openidMasked: string;
}
