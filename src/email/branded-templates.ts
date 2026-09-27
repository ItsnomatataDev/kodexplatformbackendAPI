/**
 * Branded email shell ported from the Codex / Supabase Resend templates
 * (ITsNomatataWorkSpace supabase/functions/_shared/n8nNotificationEmail.ts).
 */

export const APP_NAME = "IT's Nomatata";
export const APP_URL = 'https://codex.itsnomatata.com';
export const LOGO_URL =
  'https://res.cloudinary.com/dnqjax5ut/image/upload/v1777032415/Codex-Hero-removebg-preview_klc0mh.png';

export const EMAIL_ORANGE = '#f97316';
export const EMAIL_INK = '#111827';
export const EMAIL_MUTED = '#6b7280';
export const EMAIL_BORDER = '#e5e7eb';
export const EMAIL_SURFACE = '#ffffff';
export const EMAIL_CANVAS = '#ffffff';

export const DEFAULT_EMAIL_FOOTER_NOTE =
  'You received this because you are a workspace member or submitted a request. You can manage notification preferences in your workspace settings.';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatEmailBodyText(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}

export function buildEmailCta(href: string, label = 'Open in workspace'): string {
  const safeHref = escapeHtml(href);
  return `<a href="${safeHref}"
       target="_blank"
       rel="noopener noreferrer"
       style="display:inline-block;background:${EMAIL_ORANGE};color:#000000;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;">
      ${escapeHtml(label)}
    </a>`;
}

export function buildEmailLayout(params: {
  section?: string;
  bodyHtml: string;
  footerNote?: string;
  title?: string;
  appUrl?: string;
}): string {
  const brandLine = (params.section ?? "IT'S NOMATATA").trim() || "IT'S NOMATATA";
  const docTitle = params.title ?? APP_NAME;
  const footerNote = params.footerNote ?? DEFAULT_EMAIL_FOOTER_NOTE;
  const appUrl = (params.appUrl ?? APP_URL).replace(/\/+$/, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(docTitle)}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_CANVAS};font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_CANVAS};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${EMAIL_SURFACE};border:1px solid ${EMAIL_BORDER};">
          <tr>
            <td align="center" style="padding:28px 28px 18px;background:${EMAIL_SURFACE};">
              <a href="${escapeHtml(appUrl)}" style="text-decoration:none;">
                <img
                  src="${LOGO_URL}"
                  alt="CODEX"
                  width="168"
                  border="0"
                  style="display:block;width:168px;max-width:56%;height:auto;margin:0 auto;"
                />
              </a>
              <p style="margin:14px 0 0;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${EMAIL_ORANGE};">
                ${escapeHtml(brandLine)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="height:3px;line-height:3px;font-size:0;background:${EMAIL_ORANGE};">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;background:${EMAIL_SURFACE};color:${EMAIL_INK};">
              ${params.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;background:${EMAIL_SURFACE};border-top:1px solid ${EMAIL_BORDER};">
              <p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:${EMAIL_MUTED};">
                ${escapeHtml(footerNote)}
              </p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${EMAIL_MUTED};">
                <a href="${escapeHtml(appUrl)}" style="color:${EMAIL_ORANGE};text-decoration:none;">${escapeHtml(appUrl)}</a>
                &nbsp;·&nbsp;${escapeHtml(APP_NAME)}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function firstNameFrom(fullNameOrEmail: string | null | undefined): string {
  const raw = (fullNameOrEmail ?? '').trim();
  if (!raw) return 'there';
  if (raw.includes('@')) {
    const local = raw.split('@')[0] ?? 'there';
    const token = local.split(/[._-]/)[0] || local;
    return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return raw.split(/\s+/)[0] || 'there';
}

export function buildPasswordResetEmail(params: {
  firstName: string;
  resetUrl: string;
  expiresMinutes: number;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const minutes = Math.max(1, Math.round(params.expiresMinutes));
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">Password reset</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${EMAIL_INK};">
      Hi ${escapeHtml(params.firstName)},
    </p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${EMAIL_INK};">
      We received a request to reset your Codex password. This link expires in
      <strong>${minutes} minutes</strong>.
    </p>
    <p style="margin:0 0 14px;">
      ${buildEmailCta(params.resetUrl, 'Reset password')}
    </p>
    <p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:${EMAIL_MUTED};word-break:break-all;">
      Or open this link:<br>
      <a href="${escapeHtml(params.resetUrl)}" target="_blank" rel="noopener noreferrer" style="color:${EMAIL_ORANGE};text-decoration:underline;">
        ${escapeHtml(params.resetUrl)}
      </a>
    </p>
    <p style="margin:0;font-size:12px;line-height:1.5;color:${EMAIL_MUTED};">
      If you did not request this, you can ignore this email. Your password will stay the same.
    </p>
  `;

  const html = buildEmailLayout({
    title: `Password Reset - ${APP_NAME}`,
    bodyHtml,
    appUrl: params.appUrl,
  });

  const text = [
    `Hi ${params.firstName},`,
    '',
    `We received a request to reset your Codex password. This link expires in ${minutes} minutes.`,
    '',
    params.resetUrl,
    '',
    'If you did not request this, you can ignore this email. Your password will stay the same.',
    '',
    params.appUrl ?? APP_URL,
    APP_NAME,
  ].join('\n');

  return {
    subject: `Password Reset - ${APP_NAME}`,
    html,
    text,
  };
}

/** Wrap a plain-text transactional message in the Codex HTML shell. */
export function buildBrandedTransactionalEmail(params: {
  title: string;
  firstName?: string;
  bodyText: string;
  actionUrl?: string;
  actionLabel?: string;
  appUrl?: string;
}): { html: string; text: string } {
  const greeting = params.firstName
    ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${EMAIL_INK};">Hi ${escapeHtml(params.firstName)},</p>`
    : '';
  const cta = params.actionUrl
    ? `<p style="margin:18px 0 0;">${buildEmailCta(params.actionUrl, params.actionLabel ?? 'Open in workspace')}</p>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">${escapeHtml(params.title)}</h1>
    ${greeting}
    <p style="margin:0;font-size:15px;line-height:1.6;color:${EMAIL_INK};">
      ${formatEmailBodyText(params.bodyText)}
    </p>
    ${cta}
  `;

  return {
    html: buildEmailLayout({
      title: `${params.title} - ${APP_NAME}`,
      bodyHtml,
      appUrl: params.appUrl,
    }),
    text: [
      params.firstName ? `Hi ${params.firstName},` : null,
      '',
      params.title,
      '',
      params.bodyText,
      params.actionUrl ? `\n${params.actionUrl}` : null,
      '',
      params.appUrl ?? APP_URL,
      APP_NAME,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  };
}
