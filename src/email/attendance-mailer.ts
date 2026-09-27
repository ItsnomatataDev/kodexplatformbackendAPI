import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createEmailSender } from '../auth/email.js';
import { sendSmtpMail } from '../auth/smtp-transport.js';
import type { SmtpEmailDeliveryConfig } from '../config/email-delivery.js';
import {
  APP_URL,
  buildBrandedTransactionalEmail,
  buildEmailLayout,
  firstNameFrom,
} from './branded-templates.js';

export type SimpleEmail = {
  to: string;
  subject: string;
  text: string;
  /** Optional pre-built HTML body fragment (wrapped in the Codex shell). */
  htmlBody?: string;
  firstName?: string;
  actionUrl?: string;
  actionLabel?: string;
};

/**
 * Best-effort transactional email for attendance / notifications.
 * Always sends the Codex branded HTML shell used by the old Supabase Resend templates.
 */
export async function sendAttendanceEmail(message: SimpleEmail): Promise<boolean> {
  if (env.email.provider !== 'smtp') {
    logger.info(
      { toDomain: message.to.split('@')[1] ?? 'unknown', subject: message.subject },
      'Attendance email skipped; EMAIL_PROVIDER is not smtp.',
    );
    return false;
  }

  const appUrl = (env.appPublicUrl || APP_URL).replace(/\/+$/, '');
  const firstName = message.firstName ?? firstNameFrom(message.to);
  const branded = message.htmlBody
    ? {
        html: buildEmailLayout({
          title: message.subject,
          bodyHtml: message.htmlBody,
          appUrl,
        }),
        text: message.text,
      }
    : buildBrandedTransactionalEmail({
        title: message.subject,
        firstName,
        bodyText: message.text,
        actionUrl: message.actionUrl,
        actionLabel: message.actionLabel,
        appUrl,
      });

  try {
    await sendSmtpMail(env.email as SmtpEmailDeliveryConfig, {
      to: message.to,
      subject: message.subject,
      text: branded.text,
      html: branded.html,
    });
    return true;
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        subject: message.subject,
      },
      'Attendance email delivery failed.',
    );
    return false;
  }
}

/** Keep auth email factory imported so jobs share the same config surface. */
export function ensureEmailConfigLoaded() {
  return createEmailSender(env.email, {
    appPublicUrl: env.appPublicUrl || undefined,
    passwordResetTtlSeconds: env.auth.passwordResetTtlSeconds,
  });
}
