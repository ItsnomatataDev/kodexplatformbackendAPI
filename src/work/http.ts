import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { isUuid } from '../auth/uuid.js';
import {
  rejectClientOrganizationOverride,
} from '../authorization/organization.js';
import { getLimitedBodyText } from '../middleware/body-limit.js';
import { optionalText, requiredText } from '../http/fields.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import type { WorkStore } from './store.js';

export async function readJson(c: {
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

export function readOptionalString(
  value: unknown,
  field = 'value',
  maxLength = 4_000,
): string | null | undefined {
  return optionalText(value, field, maxLength);
}

export function readRequiredText(
  value: unknown,
  field: string,
  maxLength = 4_000,
): string {
  return requiredText(value, field, maxLength);
}

export function readOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer.`);
  }

  return value;
}

export function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean.`);
  }

  return value;
}

export function readOptionalTimestamp(
  value: unknown,
  field: string,
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO 8601 timestamp.`);
  }

  return new Date(value);
}

export function requireId(value: string | undefined, field: string): string {
  if (!value || !isUuid(value)) {
    throw new ValidationError(`${field} must be a UUID.`);
  }

  return value;
}

export function requireUuidValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ValidationError(`${field} must be a UUID.`, { field });
  }

  return value;
}

export function rejectIdentityOverrides(
  auth: ReturnType<typeof getAuth>,
  c: {
    req: {
      query: (name: string) => string | undefined;
      header: (name: string) => string | undefined;
    };
  },
  body: Record<string, unknown> = {},
) {
  const identityCandidates = [
    c.req.query('user_id'),
    c.req.header('x-user-id'),
    body.createdBy,
    body.created_by,
    body.assignedBy,
    body.assigned_by,
    body.actorId,
    body.actor_id,
    body.uploadedBy,
    body.uploaded_by,
    body.submittedBy,
    body.submitted_by,
    body.reviewedBy,
    body.reviewed_by,
    body.archivedBy,
    body.archived_by,
  ];

  for (const candidate of identityCandidates) {
    rejectClientUserOverride(
      auth,
      typeof candidate === 'string' ? candidate : null,
    );
  }

  rejectClientOrganizationOverride(
    auth,
    c.req.query('organization_id') ??
      c.req.header('x-organization-id') ??
      (typeof body.organizationId === 'string' ? body.organizationId : null) ??
      (typeof body.organization_id === 'string' ? body.organization_id : null),
  );
}

export async function requireCardInOrganization(
  store: WorkStore,
  organizationId: string,
  cardId: string,
) {
  const card = await store.getCardById(organizationId, cardId);

  if (!card) {
    throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
  }

  return card;
}

export async function requireOrganizationMember(
  store: WorkStore,
  organizationId: string,
  userId: string,
) {
  const member = await store.getOrganizationMember(organizationId, userId);

  if (!member) {
    throw new NotFoundError(
      'MEMBER_NOT_FOUND',
      'The user was not found in this organization.',
    );
  }

  return member;
}

export function assertCommentOwner(
  auth: ReturnType<typeof getAuth>,
  authorUserId: string | null,
) {
  if (auth.membership.isAdminRole) {
    return;
  }

  if (authorUserId !== auth.actor.userId) {
    throw new ForbiddenError(
      'NOT_OWNER',
      'Only the comment author can update this comment.',
    );
  }
}
