import { logger } from '../config/logger.js';

export type PasswordResetEmail = {
  to: string;
  resetToken: string;
};

export interface EmailSender {
  sendPasswordReset(message: PasswordResetEmail): Promise<void>;
}

export class UnconfiguredEmailSender implements EmailSender {
  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    const domain = message.to.includes('@')
      ? message.to.slice(message.to.lastIndexOf('@') + 1)
      : 'unknown';

    logger.info(
      {
        template: 'password_reset',
        toDomain: domain,
      },
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
