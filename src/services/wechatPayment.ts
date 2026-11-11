import type { WechatVirtualPaymentParams } from '../../shared/types';

interface VirtualPaymentCall extends WechatVirtualPaymentParams {
  success(): void;
  fail(error: { errCode?: number; errMsg?: string }): void;
}
declare const wx: { requestVirtualPayment?: (options: VirtualPaymentCall) => void };

export class WechatPaymentClientError extends Error {
  constructor(readonly result: 'cancelled' | 'rejected' | 'unknown', message: string) { super(message); }
}

export function wechatVirtualSupported() {
  // #ifdef MP-WEIXIN
  return typeof wx !== 'undefined' && typeof wx.requestVirtualPayment === 'function';
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

export function requestWechatVirtualPayment(params: WechatVirtualPaymentParams): Promise<void> {
  // #ifdef MP-WEIXIN
  if (typeof wx !== 'undefined' && wx.requestVirtualPayment) {
    const invoke = wx.requestVirtualPayment.bind(wx);
    return new Promise((resolve, reject) => {
      const unknown = () => reject(new WechatPaymentClientError('unknown', '支付结果待确认。'));
      const timeout = setTimeout(unknown, 120_000);
      try {
        invoke({ ...params, success: () => { clearTimeout(timeout); resolve(); }, fail: error => {
          clearTimeout(timeout);
          const code = error?.errCode;
          if (code === -2 || /\bcancel\b/i.test(error?.errMsg ?? '')) {
            reject(new WechatPaymentClientError('cancelled', '已取消支付。'));
          } else if (code !== undefined && [1001, -15005, -15006, -15007, -15010, -15013, -15014, -15016, -15018].includes(code)) {
            reject(new WechatPaymentClientError('rejected', '微信暂时无法发起这笔支付，请稍后重试。'));
          } else unknown();
        } });
      } catch {
        clearTimeout(timeout);
        unknown();
      }
    });
  }
  // #endif
  return Promise.reject(new WechatPaymentClientError('rejected', '当前微信版本暂不支持虚拟支付。'));
}
