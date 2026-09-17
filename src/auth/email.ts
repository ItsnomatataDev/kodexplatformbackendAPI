import type { EmailDeliveryConfig } from '../config/email-delivery.js';
import { logger } from '../config/logger.js';
import { sendSmtpMail, type SmtpMail } from './smtp-transport.js';

export type PasswordResetEmail = {
  to: string;
  resetToken: string;
};

export interface EmailSender {
  sendPasswordReset(message: PasswordResetEmail): Promise<void>;
}

export class EmailDeliveryError extends Error {
  constructor() {
    super('EMAIL_DELIVERY_FAILED');
    this.name = 'EmailDeliveryError';
  }
}

export function emailDomain(address: string): string {
  return address.includes('@')
    ? address.slice(address.lastIndexOf('@') + 1)
    : 'unknown';
}

export function passwordResetDeliveryLogFields(to: string) {
  return {
    template: 'password_reset' as const,
    toDomain: emailDomain(to),
  };
}

export class UnconfiguredEmailSender implements EmailSender {
  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    logger.info(
      passwordResetDeliveryLogFields(message.to),
      'Password reset email not delivered; email provider is not configured.',
    );
  }
}

export class CapturingEmailSender implements EmailSender {
  lastReset: PasswordResetEmail | undefined;

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    this.lastReset = message;
  }
}

export type SmtpDeliverFn = (mail: SmtpMail) => Promise<void>;

export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly options: {
      from: string;
      deliver: SmtpDeliverFn;
    },
  ) {}

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    try {
      await this.options.deliver({
        to: message.to,
        subject: 'Reset your password',
        text: [
          'Use this token to reset your password.',
          'It expires soon and can be used only once.',
          '',
          message.resetToken,
        ].join('\n'),
      });
    } catch {
      logger.warn(
        passwordResetDeliveryLogFields(message.to),
        'Password reset email delivery failed.',
      );
      throw new EmailDeliveryError();
    }
  }
}

export function createEmailSender(
  config: EmailDeliveryConfig,
  options: { deliverSmtp?: SmtpDeliverFn } = {},
): EmailSender {
  if (config.provider === 'unconfigured') {
    return new UnconfiguredEmailSender();
  }

  const deliver =
    options.deliverSmtp ??
    ((mail: SmtpMail) => sendSmtpMail(config, mail));

  return new SmtpEmailSender({
    from: config.from,
    deliver,
  });
}
