import type { PaidPlanId, PlanId } from './membership.js';

export type PaymentOrderStatus = 'pending' | 'paid' | 'closed' | 'failed';
/** jsapi/native: WeChat Pay; alipay-page/alipay-wap: Alipay web checkout on H5. */
export type PaymentChannel = 'jsapi' | 'native' | 'alipay-page' | 'alipay-wap';

/** Client-safe order summary. It never contains WeChat secrets, openid or raw callback data. */
export interface PaymentOrder {
  id: string;
  planId: PaidPlanId;
  amountCents: number;
  status: PaymentOrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
  /** jsapi: mini-program payment; native: WeChat scan code on H5. */
  channel: PaymentChannel;
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

/** Parameters rendered as a QR code for H5 WeChat scan payment. */
export interface NativePaymentParams {
  /** Raw `code_url` from WeChat Pay; never displayed directly. */
  codeUrl: string;
  /** SVG data URL generated on the server, safe to render as an image. */
  qrCodeDataUrl: string;
  expiresAt: string;
}

/** Redirect target for Alipay page/wap checkout. The URL is signed on the server. */
export interface AlipayPaymentParams {
  redirectUrl: string;
}

export interface CheckoutResult {
  order: PaymentOrder;
  /** Present for mini-program JSAPI payments. */
  payment?: WechatPaymentParams;
  /** Present for H5 Native scan payments. */
  native?: NativePaymentParams;
  /** Present for Alipay page/wap payments. */
  alipay?: AlipayPaymentParams;
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
