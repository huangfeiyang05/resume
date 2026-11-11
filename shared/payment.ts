import type { MembershipTermKind, PaidPlanId, PlanId } from './membership.js';

export const paymentOrderStatuses = ['pending', 'paid', 'closed', 'failed'] as const;
export type PaymentOrderStatus = typeof paymentOrderStatuses[number];
/** JSAPI is the legacy mini-program channel. Native and Alipay are for the website. */
export const paymentChannels = ['jsapi', 'native', 'alipay-page', 'alipay-wap', 'wechat-virtual'] as const;
export type PaymentChannel = typeof paymentChannels[number];
export type WechatVirtualDevice = 'ios' | 'other';
export const wechatVirtualIosMinimumCents = 100;
export interface PaymentMethods { wechat: boolean; alipay: boolean; wechatVirtual?: { ios: boolean } }

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

export interface WechatVirtualPaymentParams {
  mode: 'short_series_goods';
  signData: string;
  paySig: string;
  signature: string;
}

export interface WechatVirtualCheckoutProof { wechatCode: string; device: WechatVirtualDevice }

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
  virtual?: WechatVirtualPaymentParams;
}

/** Server-side quote used by the confirmation screen before an order is created. */
export interface MembershipQuote {
  planId: PaidPlanId;
  amountCents: number;
  listPriceCents?: number;
  promotionLabel?: string;
  kind: MembershipTermKind;
  currentPlanId: PlanId;
  /** Projected dates for an existing membership. An immediate upgrade starts on verified payment. */
  period?: { startsAt: string | null; expiresAt: string };
  /** Identifies the amount and dates reviewed on the confirmation screen. */
  reviewId?: string;
  /** A published virtual-payment product is configured for the exact plan and amount. */
  virtualProductAvailable?: boolean;
}

export interface WechatBindResult {
  bound: true;
  /** Masked openid for support/debugging; the full value never leaves the server. */
  openidMasked: string;
}
