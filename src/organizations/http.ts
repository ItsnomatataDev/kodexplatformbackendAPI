import { rejectClientUserOverride } from '../auth/account.js';
import { rejectClientOrganizationOverride } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { ValidationError } from '../http/errors.js';
import { getLimitedBodyText } from '../middleware/body-limit.js';

export async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
  get: (key: 'limitedBodyText') => string | undefined;
}) {
  try {
    const raw = getLimitedBodyText(c);
    const parsed =
      raw === undefined
        ? await c.req.json()
        : raw.length === 0
          ? {}
          : JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError('Request body must be valid JSON.');
    }
    throw error;
  }
}

export function rejectTenancyOverrides(
  auth: AuthContext,
  c: {
    req: {
      query: (name: string) => string | undefined;
      header: (name: string) => string | undefined;
    };
  },
  body: Record<string, unknown> = {},
) {
  const userCandidate =
    c.req.query('user_id') ??
    c.req.header('x-user-id') ??
    (typeof body.userId === 'string' ? body.userId : null) ??
    (typeof body.user_id === 'string' ? body.user_id : null);

  rejectClientUserOverride(auth, userCandidate);

  rejectClientOrganizationOverride(
    auth,
    c.req.query('organization_id') ??
      c.req.header('x-organization-id') ??
      (typeof body.organizationId === 'string' ? body.organizationId : null) ??
      (typeof body.organization_id === 'string' ? body.organization_id : null),
  );
}
