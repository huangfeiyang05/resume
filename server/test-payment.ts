import type { AlipayGateway } from './alipay.js';

/** Only wired into an isolated test store. There are no network calls or payment credentials. */
export const testPaymentGateway: AlipayGateway = {
  async createPayment() { return { redirectUrl: 'https://simulated-payment.invalid/' }; },
  parseNotification() { throw new Error('A simulation does not accept provider notifications.'); },
  async submitRefund() { return 'succeeded'; },
  async queryRefund() { return 'succeeded'; },
};
