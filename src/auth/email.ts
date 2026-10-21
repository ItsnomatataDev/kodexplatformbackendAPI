import type { EmailDeliveryConfig } from '../config/email-delivery.js';
import { logger } from '../config/logger.js';
import {
  buildPasswordResetEmail,
  buildInvitationEmail,
  firstNameFrom,
} from '../email/branded-templates.js';
import { sendSmtpMail, type SmtpMail } from './smtp-transport.js';

export type PasswordResetEmail = {
  to: string;
  resetToken: string;
  firstName?: string;
  expiresMinutes?: number;
};

export type InvitationEmail = Omit<PasswordResetEmail, 'resetToken'> & {
  organizationName: string;
  resetToken?: string;
  requiresApproval?: boolean;
};

export interface EmailSender {
  sendInvitation(message: InvitationEmail): Promise<void>;
  sendPasswordReset(message: PasswordResetEmail): Promise<void>;
}

export class EmailDeliveryError extends Error {
  constructor(cause?: unknown) {
    const detail =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : undefined;
    super(detail ? `EMAIL_DELIVERY_FAILED: ${detail}` : 'EMAIL_DELIVERY_FAILED');
    this.name = 'EmailDeliveryError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
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
  async sendInvitation(_message: InvitationEmail): Promise<void> {
    throw new EmailDeliveryError('Invitation email delivery is not configured.');
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    logger.warn(
      passwordResetDeliveryLogFields(message.to),
      'Password reset email not delivered; email provider is not configured.',
    );
    throw new EmailDeliveryError(
      'Email provider is not configured. Password reset cannot be delivered.',
    );
  }
}

export class CapturingEmailSender implements EmailSender {
  lastReset: PasswordResetEmail | undefined;
  lastInvitation: InvitationEmail | undefined;

  async sendInvitation(message: InvitationEmail): Promise<void> {
    this.lastInvitation = message;
  }

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
      appPublicUrl?: string;
      passwordResetTtlSeconds?: number;
    },
  ) {}

  async sendInvitation(message: InvitationEmail): Promise<void> {
    const appUrl = (this.options.appPublicUrl ?? '').replace(/\/+$/, '');
    if (!appUrl || !/^https?:\/\//i.test(appUrl)) {
      throw new EmailDeliveryError('APP_PUBLIC_URL is required to send invitation links.');
    }
    const setupUrl = message.resetToken
      ? `${appUrl}/reset-password?type=invite&token=${encodeURIComponent(message.resetToken)}`
      : `${appUrl}/login`;
    const branded = buildInvitationEmail({
      firstName: message.firstName ?? firstNameFrom(message.to),
      organizationName: message.organizationName,
      existingAccount: !message.resetToken,
      requiresApproval: message.requiresApproval,
      setupUrl,
      expiresMinutes: message.expiresMinutes ?? Math.max(1, Math.round((this.options.passwordResetTtlSeconds ?? 1800) / 60)),
      appUrl,
    });
    try {
      await this.options.deliver({ to: message.to, ...branded });
    } catch {
      // Do not expose SMTP responses, recipients, or setup tokens in logs.
      throw new EmailDeliveryError('Invitation email could not be sent.');
    }
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    const appPublicUrl = (this.options.appPublicUrl ?? '').replace(/\/+$/, '');
    if (!appPublicUrl) {
      throw new EmailDeliveryError(
        'APP_PUBLIC_URL is required to send password reset links.',
      );
    }
    const resetUrl = `${appPublicUrl}/reset-password?token=${encodeURIComponent(message.resetToken)}`;
    const expiresMinutes =
      message.expiresMinutes ??
      Math.max(
        1,
        Math.round((this.options.passwordResetTtlSeconds ?? 1_800) / 60),
      );
    const firstName = message.firstName ?? firstNameFrom(message.to);

    const branded = buildPasswordResetEmail({
      firstName,
      resetUrl,
      expiresMinutes,
      appUrl: appPublicUrl,
    });

    try {
      await this.options.deliver({
        to: message.to,
        subject: branded.subject,
        text: branded.text,
        html: branded.html,
      });
    } catch (error) {
      logger.warn(
        {
          ...passwordResetDeliveryLogFields(message.to),
          err: error instanceof Error ? error.message : String(error),
        },
        'Password reset email delivery failed.',
      );
      throw new EmailDeliveryError(error);
    }
  }
}

export function createEmailSender(
  config: EmailDeliveryConfig,
  options: {
    deliverSmtp?: SmtpDeliverFn;
    appPublicUrl?: string;
    passwordResetTtlSeconds?: number;
  } = {},
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
    appPublicUrl: options.appPublicUrl,
    passwordResetTtlSeconds: options.passwordResetTtlSeconds,
  });
}
