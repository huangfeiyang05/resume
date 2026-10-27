import { loadMailConfig, SmtpMailSender } from '../api/server/mail.js';
import { HttpError } from '../api/server/errors.js';
let sender;
try {
  sender = new SmtpMailSender(loadMailConfig());
  await sender.verify();
  console.log('SMTP connection and authentication verified. No email was sent.');
} catch (error) {
  console.error(error instanceof HttpError ? error.code : 'MAIL_CONFIG_INVALID');
  process.exitCode = 1;
} finally { sender?.close(); }
