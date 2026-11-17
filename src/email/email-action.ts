const MAX_ACTION_URL_LENGTH = 2_000;
const MAX_ACTION_LABEL_LENGTH = 80;

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Returns an absolute URL only when it points into the workspace app itself. */
export function sanitizeAppActionUrl(value: unknown, appOrigin: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = decodeHtmlEntities(value.trim());
  if (!raw || raw.length > MAX_ACTION_URL_LENGTH) return null;
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(appOrigin);
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin.origin) return null;
  if (url.pathname === '/' && !url.search) return null;
  return url.toString();
}

function sanitizeActionLabel(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const label = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  if (!label) return undefined;
  return label.slice(0, MAX_ACTION_LABEL_LENGTH);
}

/**
 * Resolves the call-to-action for a client-composed email. Raw client HTML is never sent,
 * so the workspace button link is recovered from it and re-rendered in the branded template.
 */
export function resolveEmailAction(
  input: { actionUrl?: unknown; actionLabel?: unknown; html?: unknown },
  appOrigin: string,
): { actionUrl: string; actionLabel?: string } | null {
  const explicitUrl = sanitizeAppActionUrl(input.actionUrl, appOrigin);
  if (explicitUrl) {
    return { actionUrl: explicitUrl, actionLabel: sanitizeActionLabel(input.actionLabel) };
  }
  if (typeof input.html !== 'string') return null;
  const buttons = input.html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*\bclass\s*=\s*"[^"]*\bbutton\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  );
  for (const [, href, labelHtml] of buttons) {
    const actionUrl = sanitizeAppActionUrl(href, appOrigin);
    if (actionUrl) {
      return {
        actionUrl,
        actionLabel: sanitizeActionLabel(labelHtml?.replace(/<[^>]*>/g, '')),
      };
    }
  }
  return null;
}
