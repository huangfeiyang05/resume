import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AliyunSmsSender, TencentSmsSender, createAcs3Authorization, createTc3Authorization, createSmsSender, loadSmsConfig } from '../server/sms.js';
import { HttpError } from '../server/errors.js';

const environment = {
  SMS_ENABLED: 'true', SMS_PROVIDER: 'aliyun', ALIYUN_SMS_ACCESS_KEY_ID: 'SyntheticSmsAccessKey', ALIYUN_SMS_ACCESS_KEY_SECRET: 'SyntheticSmsSecret',
  ALIYUN_SMS_SIGN_NAME: '合成验证码测试', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_123456789', SMS_CODE_SECRET: 'synthetic-code-secret-with-at-least-32-bytes',
};
const input = { phone: '13900000000', code: '012345', purpose: 'login' as const, expiresAt: '2026-11-05T06:00:00.000Z' };
const safeFailure = (error: unknown) => error instanceof HttpError && error.code === 'SMS_SEND_FAILED'
  && ![input.phone, input.code, environment.ALIYUN_SMS_ACCESS_KEY_ID, environment.ALIYUN_SMS_ACCESS_KEY_SECRET].some(secret => error.message.includes(secret));

test('SMS is disabled by default and enabled configuration fails closed without leaking values', async () => {
  assert.equal(loadSmsConfig({}).enabled, false);
  assert.equal(loadSmsConfig(environment).enabled, true);
  for (const key of Object.keys(environment)) {
    const values: NodeJS.ProcessEnv = { ...environment };
    if (key === 'SMS_ENABLED') values[key] = 'yes'; else delete values[key];
    assert.throws(() => loadSmsConfig(values), error => error instanceof Error && !Object.values(environment).some(value => error.message.includes(value)));
  }
  for (const patch of [{ ALIYUN_SMS_TEMPLATE_CODE: 'invalid' }, { SMS_CODE_SECRET: 'short' }, { ALIYUN_SMS_SIGN_NAME: 'bad\nname' }, { ALIYUN_SMS_ACCESS_KEY_SECRET: 'with space' }]) assert.throws(() => loadSmsConfig({ ...environment, ...patch }));
  let calls = 0;
  const sender = new AliyunSmsSender(loadSmsConfig({ SMS_PROVIDER: 'aliyun' }), async () => { calls++; return new Response('{}'); });
  await assert.rejects(sender.sendCode(input), error => error instanceof HttpError && error.code === 'SMS_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('ACS3 signature agrees with Alibaba Cloud official published fixed request and secret', () => {
  const authorization = createAcs3Authorization({
    method: 'POST', canonicalUri: '/', canonicalQuery: 'ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai',
    body: '', accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret',
    headers: {
      host: 'ecs.cn-shanghai.aliyuncs.com', 'x-acs-action': 'RunInstances', 'x-acs-version': '2014-05-26',
      'x-acs-date': '2023-10-26T10:22:32Z', 'x-acs-signature-nonce': '3156853299f313e23d1673dc12e1703d',
      'x-acs-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  assert.equal(authorization, 'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
});

test('SMS sends a single signed POST to the fixed official endpoint with sensitive values in the body', async () => {
  let calls = 0;
  const sender = new AliyunSmsSender(loadSmsConfig({ ...environment, ALIYUN_SMS_SECURITY_TOKEN: 'SyntheticTemporarySecurityToken' }), async (url, options) => {
    calls++;
    assert.equal(url, 'https://dysmsapi.aliyuncs.com/');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    const body = options?.body as string;
    const params = new URLSearchParams(body);
    assert.equal(params.get('PhoneNumbers'), input.phone);
    assert.equal(params.get('RegionId'), 'cn-hangzhou');
    assert.equal(params.get('SignName'), environment.ALIYUN_SMS_SIGN_NAME);
    assert.equal(params.get('TemplateCode'), environment.ALIYUN_SMS_TEMPLATE_CODE);
    assert.deepEqual(JSON.parse(params.get('TemplateParam')!), { code: input.code });
    assert.equal(params.has('purpose'), false);
    assert.equal(body.includes('+'), false, 'RFC3986 encoding must not turn spaces into plus');
    const headers = options?.headers as Record<string, string>;
    assert.equal(headers['x-acs-action'], 'SendSms');
    assert.equal(headers['x-acs-version'], '2017-05-25');
    assert.equal(headers['x-acs-content-sha256'], createHash('sha256').update(body).digest('hex'));
    assert.equal(headers['x-acs-security-token'], 'SyntheticTemporarySecurityToken');
    assert.match(headers.Authorization, /content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-security-token;x-acs-signature-nonce;x-acs-version,Signature=[a-f0-9]{64}$/);
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ Code: 'OK', BizId: 'synthetic-submission-not-delivery' }));
  });
  assert.equal(await sender.sendCode(input), undefined, 'submission must not invent a delivery receipt');
  assert.equal(calls, 1);
});

test('business errors, non-success HTTP, malformed payloads and network errors do not report success or expose upstream data', async () => {
  const responses = [
    () => new Response(JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: `${input.phone}:${input.code}` })),
    () => new Response(JSON.stringify({ Code: 'OK' }), { status: 500 }),
    () => new Response('not-json'), () => new Response('null'), () => new Response('[]'), () => new Response('{}'),
    () => new Response('{}', { headers: { 'Content-Length': '65537' } }),
    () => { throw new Error(`${input.phone}:${input.code}:${environment.ALIYUN_SMS_ACCESS_KEY_SECRET}`); },
  ];
  for (const response of responses) {
    let calls = 0;
    const sender = new AliyunSmsSender(loadSmsConfig(environment), async () => { calls++; return response(); });
    await assert.rejects(sender.sendCode(input), safeFailure);
    assert.equal(calls, 1, 'ambiguous failures must not automatically retry a potentially billable send');
  }
});

test('response body limit applies even without a content-length header', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; },
  });
  const sender = new AliyunSmsSender(loadSmsConfig(environment), async () => new Response(body));
  await assert.rejects(sender.sendCode(input), safeFailure);
  assert.equal(cancelled, true);
});

test('SMS request timeout aborts once and does not retry', async () => {
  let calls = 0, aborted = false;
  const sender = new AliyunSmsSender(loadSmsConfig(environment), async (_url, options) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic timeout with private upstream content')); }, { once: true }));
  }, 5);
  await assert.rejects(sender.sendCode(input), safeFailure);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('invalid destination/code/purpose/expiry is rejected before a provider request', async () => {
  let calls = 0;
  const sender = new AliyunSmsSender(loadSmsConfig(environment), async () => { calls++; return new Response('{"Code":"OK"}'); });
  for (const patch of [{ phone: '+8613900000000' }, { phone: '13900000000,13800000000' }, { code: '1' }, { code: '1234567' }, { purpose: 'marketing' }, { expiresAt: 'invalid' }]) {
    await assert.rejects(sender.sendCode({ ...input, ...patch } as typeof input), error => error instanceof HttpError && error.code === 'INVALID_SMS_INPUT');
  }
  assert.equal(calls, 0);
});

const tencentEnvironment = {
  SMS_ENABLED: 'true', SMS_PROVIDER: 'tencent', SMS_CODE_SECRET: 'synthetic-tencent-code-secret-at-least-32-bytes',
  TENCENT_SMS_SECRET_ID: 'AKIDSyntheticSmsTestOnly', TENCENT_SMS_SECRET_KEY: 'SyntheticTencentSecretKeyForTests',
  TENCENT_SMS_SDK_APP_ID: '1400006666', TENCENT_SMS_SIGN_NAME: '合成短信测试', TENCENT_SMS_TEMPLATE_ID: '1234567',
};
const tencentResponse = (Code = 'Ok', PhoneNumber = `+86${input.phone}`) => new Response(JSON.stringify({ Response: { SendStatusSet: [{ Code, PhoneNumber, SerialNo: 'synthetic-accepted-not-delivered' }], RequestId: 'synthetic-request' } }));

test('Tencent configuration is the disabled default and requires provider-specific approved settings when enabled', async () => {
  const config = loadSmsConfig({});
  assert.equal(config.provider, 'tencent');
  assert.equal(config.enabled, false);
  const sender = createSmsSender(config, async () => { throw new Error('Must never dispatch'); });
  assert.ok(sender instanceof TencentSmsSender);
  await assert.rejects(sender.sendCode(input), error => error instanceof HttpError && error.code === 'SMS_NOT_CONFIGURED');
  assert.equal(loadSmsConfig(tencentEnvironment).enabled, true);
  assert.ok(createSmsSender(loadSmsConfig({ ...environment })) instanceof AliyunSmsSender);
  for (const key of ['TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY', 'TENCENT_SMS_SDK_APP_ID', 'TENCENT_SMS_SIGN_NAME', 'TENCENT_SMS_TEMPLATE_ID', 'SMS_CODE_SECRET']) {
    const values: NodeJS.ProcessEnv = { ...tencentEnvironment }; delete values[key];
    assert.throws(() => loadSmsConfig(values), error => error instanceof Error && !Object.values(tencentEnvironment).some(value => error.message.includes(value)));
  }
  for (const patch of [{ SMS_PROVIDER: 'unknown' }, { TENCENT_SMS_SECRET_ID: 'invalid' }, { TENCENT_SMS_SDK_APP_ID: 'bad' }, { TENCENT_SMS_TEMPLATE_ID: 'SMS_1' }, { TENCENT_SMS_REGION: 'http://invalid' }, { TENCENT_SMS_TOKEN: 'bad\ntoken' }]) assert.throws(() => loadSmsConfig({ ...tencentEnvironment, ...patch }));
});

test('TC3 signature matches Tencent Cloud published fixed request, UTC date and derived signing keys', () => {
  // Fixed sample from https://cloud.tencent.com/document/product/382/38768 (placeholder secret is literal).
  const body = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  assert.equal(createHash('sha256').update(body).digest('hex'), '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064');
  const signature = createTc3Authorization({ body, timestamp: 1551113065, host: 'cvm.tencentcloudapi.com', service: 'cvm', action: 'DescribeInstances', secretId: 'AKID********************************', secretKey: '********************************' });
  assert.equal(signature, 'TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f');
});

test('Tencent sends one signed POST to fixed official endpoint, E.164 destination and only code template parameter', async () => {
  let calls = 0;
  const config = loadSmsConfig({ ...tencentEnvironment, TENCENT_SMS_TOKEN: 'SyntheticTencentTemporaryToken' });
  const sender = createSmsSender(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://sms.tencentcloudapi.com/');
    assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error');
    const body = options?.body as string;
    assert.deepEqual(JSON.parse(body), { PhoneNumberSet: [`+86${input.phone}`], SmsSdkAppId: '1400006666', SignName: '合成短信测试', TemplateId: '1234567', TemplateParamSet: [input.code] });
    const headers = options?.headers as Record<string, string>;
    assert.equal(headers['X-TC-Action'], 'SendSms'); assert.equal(headers['X-TC-Version'], '2021-01-11');
    assert.equal(headers['X-TC-Region'], 'ap-guangzhou'); assert.equal(headers['X-TC-Token'], 'SyntheticTencentTemporaryToken');
    assert.equal(headers.Authorization, createTc3Authorization({ body, timestamp: Number(headers['X-TC-Timestamp']), host: 'sms.tencentcloudapi.com', service: 'sms', action: 'SendSms', secretId: tencentEnvironment.TENCENT_SMS_SECRET_ID, secretKey: tencentEnvironment.TENCENT_SMS_SECRET_KEY }));
    return tencentResponse();
  });
  assert.equal(await sender.sendCode(input), undefined);
  assert.equal(calls, 1);
});

test('Tencent HTTP200 failures, incorrect per-number result, oversized body and transport errors are sanitized without retries', async () => {
  for (const response of [
    () => tencentResponse('FailedOperation.TemplateParamSetNotMatchApprovedTemplate'),
    () => tencentResponse('Ok', '+8613800000000'),
    () => new Response(JSON.stringify({ Response: { Error: { Code: 'AuthFailure', Message: `${input.phone}:${input.code}` } } })),
    () => new Response(JSON.stringify({ Response: { SendStatusSet: [] } })),
    () => new Response(JSON.stringify({ Response: { SendStatusSet: [{ Code: 'Ok', PhoneNumber: `+86${input.phone}` }, { Code: 'Ok' }] } })),
    () => new Response('not-json'), () => new Response('null'),
    () => new Response('{}', { status: 500 }),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
    () => { throw new Error(`${tencentEnvironment.TENCENT_SMS_SECRET_KEY}:${input.phone}:${input.code}`); },
  ]) {
    let calls = 0;
    const sender = createSmsSender(loadSmsConfig(tencentEnvironment), async () => { calls++; return response(); });
    await assert.rejects(sender.sendCode(input), error => safeFailure(error) && !(error as Error).message.includes(tencentEnvironment.TENCENT_SMS_SECRET_KEY));
    assert.equal(calls, 1);
  }
});

test('Tencent timeout aborts and invalid input never triggers a send', async () => {
  let calls = 0, aborted = false;
  const sender = createSmsSender(loadSmsConfig(tencentEnvironment), async (_url, options) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic timeout')); }, { once: true }));
  }, 5);
  await assert.rejects(sender.sendCode(input), safeFailure);
  assert.equal(calls, 1); assert.equal(aborted, true);
  await assert.rejects(sender.sendCode({ ...input, phone: '+8613900000000' }), error => error instanceof HttpError && error.code === 'INVALID_SMS_INPUT');
  assert.equal(calls, 1);
});
