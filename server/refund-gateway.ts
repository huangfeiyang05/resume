export interface RefundTarget {
  id: string;
  outTradeNo: string;
  transactionId: string;
  amountCents: number;
}

export type GatewayRefundStatus = 'processing' | 'succeeded' | 'closed' | 'abnormal' | 'unknown';

/** Each operation verifies the channel response against the order, refund ID and amount. */
export interface RefundGateway {
  submitRefund(target: RefundTarget, notifyUrl?: string): Promise<GatewayRefundStatus>;
  queryRefund(target: RefundTarget): Promise<GatewayRefundStatus | 'not-found'>;
}

export interface WechatRefundNotification extends RefundTarget {
  status: GatewayRefundStatus;
}
