import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';
import { wechatRecord } from './wechat-identity.js';

function unverified(): never {
  throw new HttpError(401, 'WECHAT_PUSH_UNVERIFIED', '微信消息推送未通过验证。');
}

function parseJson(value: string) {
  try { return wechatRecord(JSON.parse(value)); } catch { return unverified(); }
}

/** WeChat message push in JSON safe mode. The signature covers the entire ciphertext. */
export class WechatMessagePush {
  constructor(private readonly appid: string, private readonly token: string, private readonly aesKey: Buffer) {}

  private value(query: URLSearchParams, key: string, pattern: RegExp) {
    const [value, ...extra] = query.getAll(key);
    if (extra.length || !value || !pattern.test(value)) return unverified();
    return value;
  }

  private verify(query: URLSearchParams, key: string, encrypted?: string) {
    const signature = this.value(query, key, /^[a-f0-9]{40}$/);
    const timestamp = this.value(query, 'timestamp', /^\d{1,12}$/);
    const nonce = this.value(query, 'nonce', /^[A-Za-z0-9_-]{1,128}$/);
    const fields = [this.token, timestamp, nonce, ...(encrypted ? [encrypted] : [])];
    const expected = createHash('sha1').update(fields.sort().join('')).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) unverified();
  }

  challenge(query: URLSearchParams) {
    this.verify(query, 'signature');
    return this.value(query, 'echostr', /^[A-Za-z0-9_-]{1,256}$/);
  }

  decode(query: URLSearchParams, raw: string) {
    const { Encrypt: encrypted } = parseJson(raw);
    if (query.get('encrypt_type') !== 'aes' || typeof encrypted !== 'string'
      || encrypted.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) unverified();
    this.verify(query, 'msg_signature', encrypted);
    try {
      const decipher = createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.subarray(0, 16));
      decipher.setAutoPadding(false);
      const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
      const padding = padded.at(-1) ?? 0;
      if (padded.length < 32 || padded.length % 32 || padding < 1 || padding > 32
        || padded.subarray(-padding).some(value => value !== padding)) unverified();
      const plain = padded.subarray(0, -padding);
      if (plain.length < 20) unverified();
      const end = 20 + plain.readUInt32BE(16);
      if (end > plain.length || !plain.subarray(end).equals(Buffer.from(this.appid))) unverified();
      return parseJson(plain.toString('utf8', 20, end));
    } catch {
      return unverified();
    }
  }
}
