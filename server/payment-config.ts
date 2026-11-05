import { readFileSync } from 'node:fs';
import type { PaidPlanId } from '../shared/types.js';

export interface PriceConfig {
  priceCents: number;
  listPriceCents?: number;
  promotionLabel?: string;
}

export interface BillingPricing { basic: PriceConfig; premium: PriceConfig }

/**
 * Prices approved by the product owner on 2026-11-05:
 * basic ¥9.90 / month, premium ¥29.90 / month with a ¥24.90 first-purchase promotion.
 * The promotion is labelled "首充优惠": only a user with no paid order gets it; repeat payments use the list price.
 */
export const defaultPricing: BillingPricing = {
  basic: { priceCents: 990 },
  premium: { priceCents: 2490, listPriceCents: 2990, promotionLabel: '首充优惠' },
};

function cents(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer number of cents.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer number of cents.`);
  return parsed;
}

export function loadBillingPricing(env: NodeJS.ProcessEnv = process.env): BillingPricing {
  const basicPrice = cents(env.MEMBERSHIP_BASIC_PRICE_CENTS, defaultPricing.basic.priceCents, 'MEMBERSHIP_BASIC_PRICE_CENTS');
  const premiumPrice = cents(env.MEMBERSHIP_PREMIUM_PRICE_CENTS, defaultPricing.premium.priceCents, 'MEMBERSHIP_PREMIUM_PRICE_CENTS');
  const listPrice = cents(env.MEMBERSHIP_PREMIUM_LIST_PRICE_CENTS, defaultPricing.premium.listPriceCents!, 'MEMBERSHIP_PREMIUM_LIST_PRICE_CENTS');
  if (listPrice < premiumPrice) throw new Error('MEMBERSHIP_PREMIUM_LIST_PRICE_CENTS cannot be lower than the current premium price.');
  const label = env.MEMBERSHIP_PREMIUM_PROMOTION_LABEL ?? defaultPricing.premium.promotionLabel;
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 20)) throw new Error('MEMBERSHIP_PREMIUM_PROMOTION_LABEL is invalid.');
  return {
    basic: { priceCents: basicPrice },
    premium: listPrice > premiumPrice
      ? { priceCents: premiumPrice, listPriceCents: listPrice, promotionLabel: label ?? '首充优惠' }
      : { priceCents: premiumPrice },
  };
}

export interface PaymentConfig {
  appid: string;
  appSecret: string;
  mchid: string;
  merchantSerialNo: string;
  privateKeyPem: string;
  apiV3Key: string;
  platformPublicKeyPem: string;
  platformPublicKeyId?: string;
  notifyUrl: string;
}

export interface AlipayConfig {
  appId: string;
  sellerId?: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  gateway: string;
  notifyUrl: string;
  returnUrl: string;
}

const requiredVariables = [
  'WECHAT_PAY_MCHID', 'WECHAT_PAY_APPID', 'WECHAT_PAY_APP_SECRET', 'WECHAT_PAY_MERCHANT_SERIAL_NO',
  'WECHAT_PAY_PRIVATE_KEY_PATH', 'WECHAT_PAY_API_V3_KEY', 'WECHAT_PAY_PUBLIC_KEY_PATH', 'WECHAT_PAY_NOTIFY_URL',
] as const;

/** Returns undefined when no payment variables are present; refuses a partial production setup. */
export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig | undefined {
  const present = requiredVariables.filter(name => typeof env[name] === 'string' && env[name]!.trim() !== '');
  if (present.length === 0) return undefined;
  const missing = requiredVariables.filter(name => !present.includes(name));
  if (missing.length) throw new Error(`WeChat Pay configuration is incomplete: ${missing.join(', ')}.`);
  const appid = env.WECHAT_PAY_APPID!.trim();
  if (!/^wx[a-f0-9]{16}$/i.test(appid)) throw new Error('WECHAT_PAY_APPID is invalid.');
  const mchid = env.WECHAT_PAY_MCHID!.trim();
  if (!/^\d{6,32}$/.test(mchid)) throw new Error('WECHAT_PAY_MCHID is invalid.');
  const merchantSerialNo = env.WECHAT_PAY_MERCHANT_SERIAL_NO!.trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(merchantSerialNo)) throw new Error('WECHAT_PAY_MERCHANT_SERIAL_NO is invalid.');
  const apiV3Key = env.WECHAT_PAY_API_V3_KEY!;
  if (Buffer.byteLength(apiV3Key, 'utf8') !== 32) throw new Error('WECHAT_PAY_API_V3_KEY must be exactly 32 bytes.');
  const notifyUrl = env.WECHAT_PAY_NOTIFY_URL!.trim();
  let notify: URL;
  try { notify = new URL(notifyUrl); } catch { throw new Error('WECHAT_PAY_NOTIFY_URL is not a valid URL.'); }
  if (notify.protocol !== 'https:' || notify.hostname === 'localhost' || notify.hostname === '127.0.0.1') throw new Error('WECHAT_PAY_NOTIFY_URL must be a public HTTPS URL.');
  const privateKeyPem = readPem(env.WECHAT_PAY_PRIVATE_KEY_PATH!, 'WECHAT_PAY_PRIVATE_KEY_PATH', 'PRIVATE KEY');
  const platformPublicKeyPem = readPem(env.WECHAT_PAY_PUBLIC_KEY_PATH!, 'WECHAT_PAY_PUBLIC_KEY_PATH', 'PUBLIC KEY');
  const platformPublicKeyId = env.WECHAT_PAY_PUBLIC_KEY_ID?.trim();
  if (platformPublicKeyId !== undefined && !/^PUB_KEY_ID_[A-Za-z0-9]+$/.test(platformPublicKeyId)) throw new Error('WECHAT_PAY_PUBLIC_KEY_ID is invalid.');
  return { appid, appSecret: env.WECHAT_PAY_APP_SECRET!.trim(), mchid, merchantSerialNo, privateKeyPem, apiV3Key, platformPublicKeyPem, ...(platformPublicKeyId ? { platformPublicKeyId } : {}), notifyUrl: notify.toString() };
}

const defaultAlipayGateway = 'https://openapi.alipay.com/gateway.do';
const alipayRequiredVariables = [
  'ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY_PATH', 'ALIPAY_PUBLIC_KEY_PATH', 'ALIPAY_NOTIFY_URL', 'ALIPAY_RETURN_URL',
] as const;

/**
 * Alipay web checkout is optional and independent from WeChat Pay. A partial
 * configuration refuses to start, matching the WeChat Pay behavior.
 */
export function loadAlipayConfig(env: NodeJS.ProcessEnv = process.env): AlipayConfig | undefined {
  const present = alipayRequiredVariables.filter(name => typeof env[name] === 'string' && env[name]!.trim() !== '');
  if (present.length === 0) return undefined;
  const missing = alipayRequiredVariables.filter(name => !present.includes(name));
  if (missing.length) throw new Error(`Alipay configuration is incomplete: ${missing.join(', ')}.`);
  const appId = env.ALIPAY_APP_ID!.trim();
  if (!/^\d{8,32}$/.test(appId)) throw new Error('ALIPAY_APP_ID is invalid.');
  const sellerId = env.ALIPAY_SELLER_ID?.trim();
  if (sellerId !== undefined && !/^\d{8,32}$/.test(sellerId)) throw new Error('ALIPAY_SELLER_ID is invalid.');
  const gateway = (env.ALIPAY_GATEWAY ?? defaultAlipayGateway).trim();
  let gatewayUrl: URL;
  try { gatewayUrl = new URL(gateway); } catch { throw new Error('ALIPAY_GATEWAY is not a valid URL.'); }
  if (gatewayUrl.protocol !== 'https:') throw new Error('ALIPAY_GATEWAY must be an HTTPS URL.');
  const notifyUrl = publicHttpsUrl(env.ALIPAY_NOTIFY_URL!.trim(), 'ALIPAY_NOTIFY_URL');
  const returnUrl = publicHttpsUrl(env.ALIPAY_RETURN_URL!.trim(), 'ALIPAY_RETURN_URL');
  const privateKeyPem = readPem(env.ALIPAY_PRIVATE_KEY_PATH!, 'ALIPAY_PRIVATE_KEY_PATH', 'PRIVATE KEY');
  const alipayPublicKeyPem = readPem(env.ALIPAY_PUBLIC_KEY_PATH!, 'ALIPAY_PUBLIC_KEY_PATH', 'PUBLIC KEY');
  return { appId, ...(sellerId ? { sellerId } : {}), privateKeyPem, alipayPublicKeyPem, gateway, notifyUrl, returnUrl };
}

function publicHttpsUrl(value: string, variable: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${variable} is not a valid URL.`); }
  if (url.protocol !== 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') throw new Error(`${variable} must be a public HTTPS URL.`);
  return url.toString();
}

function readPem(path: string, variable: string, marker: string): string {
  let value: string;
  try { value = readFileSync(path, 'utf8'); } catch { throw new Error(`${variable} cannot be read.`); }
  if (!value.includes(`-----BEGIN ${marker}-----`) || !value.includes(`-----END ${marker}-----`)) throw new Error(`${variable} is not a PEM ${marker.toLowerCase()} file.`);
  return value;
}

export function planPricing(pricing: BillingPricing, planId: PaidPlanId): PriceConfig {
  return pricing[planId];
}
