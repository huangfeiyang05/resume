import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMailConfig, SmtpMailSender } from '../server/mail.js';
import { HttpError } from '../server/errors.js';

const syntheticEnv = {
  MAIL_ENABLED: 'true', MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.163.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
  SMTP_USER: 'synthetic@example.test', SMTP_PASSWORD: 'synthetic-not-a-real-credential',
  MAIL_FROM: '简历有方 <synthetic@example.test>', MAIL_CODE_SECRET: 'a'.repeat(64),
};
const codeMail = { email: 'recipient@example.test', code: '123456', purpose: 'register' as const, expiresAt: '2026-10-25T01:00:00Z' };

test('SMTP configuration is server-only, disabled by default and requires authenticated TLS settings', () => {
  assert.equal(loadMailConfig({}).enabled, false);
  assert.equal(loadMailConfig(syntheticEnv).secure, true);
  for (const change of [
    { SMTP_PORT: '25' }, { SMTP_SECURE: 'false' }, { SMTP_PASSWORD: '' }, { MAIL_CODE_SECRET: '' },
    { MAIL_FROM: 'someone-else@example.test' }, { SMTP_USER: 'bad\r\naddress@example.test' }, { MAIL_PROVIDER: 'unknown' },
  ]) assert.throws(() => loadMailConfig({ ...syntheticEnv, ...change }));
  assert.equal(loadMailConfig({ ...syntheticEnv, SMTP_PORT: '587', SMTP_SECURE: 'false' }).secure, false);
});

test('SMTP verification authenticates without sending a message and disabled mail fails closed', async () => {
  let sent = 0, verified = 0;
  const transport = { verify: async () => { verified++; return true; }, sendMail: async () => { sent++; }, close() {} };
  await new SmtpMailSender(loadMailConfig(syntheticEnv), transport as never).verify();
  assert.equal(verified, 1); assert.equal(sent, 0);
  const disabled = new SmtpMailSender(loadMailConfig({}));
  await assert.rejects(() => disabled.verify(), error => error instanceof HttpError && error.code === 'MAIL_NOT_CONFIGURED');
  await assert.rejects(() => disabled.sendCode(codeMail), error => error instanceof HttpError && error.code === 'MAIL_NOT_CONFIGURED');
});

test('SMTP submission accepts only the requested recipient and never exposes upstream errors', async () => {
  let submitted: any;
  const transport = { verify: async () => true, sendMail: async (input: any) => { submitted = input; return { accepted: [codeMail.email] }; }, close() {} };
  const sender = new SmtpMailSender(loadMailConfig(syntheticEnv), transport as never);
  await sender.sendCode(codeMail);
  assert.equal(submitted.to, codeMail.email);
  assert.equal(submitted.from, syntheticEnv.MAIL_FROM);
  assert.ok(submitted.text.includes(codeMail.code));
  assert.equal(submitted.disableFileAccess, true); assert.equal(submitted.disableUrlAccess, true);
  transport.sendMail = async () => { throw new Error(`upstream private payload ${syntheticEnv.SMTP_PASSWORD} ${codeMail.code}`); };
  for (const operation of [() => sender.sendCode(codeMail), () => new SmtpMailSender(loadMailConfig(syntheticEnv), { ...transport, verify: transport.sendMail } as never).verify()]) {
    await assert.rejects(operation, error => error instanceof HttpError && !error.message.includes(syntheticEnv.SMTP_PASSWORD) && !error.message.includes(codeMail.code));
  }
  transport.sendMail = async () => ({ accepted: [] });
  await assert.rejects(() => sender.sendCode(codeMail), error => error instanceof HttpError && error.code === 'MAIL_DELIVERY_FAILED');
});

test('SMTP concurrency is bounded and a rejected request does not submit another email', async () => {
  let release!: () => void, sent = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = { verify: async () => true, sendMail: async () => { sent++; await gate; return { accepted: [codeMail.email] }; }, close() {} };
  const sender = new SmtpMailSender(loadMailConfig(syntheticEnv), transport as never);
  const first = sender.sendCode(codeMail), second = sender.sendCode(codeMail);
  await assert.rejects(() => sender.sendCode(codeMail), error => error instanceof HttpError && error.code === 'MAIL_BUSY');
  assert.equal(sent, 2); release(); await Promise.all([first, second]);
});
