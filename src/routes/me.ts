import { Hono } from 'hono';
import { readBodyWithLimit } from '../middleware/body-limit.js';
import { getAuth } from '../auth/middleware.js';
import type {
  PublicProfile,
  PublicProfilePatch,
} from '../auth/public-profile.js';
import {
  readPublicProfilePatch,
  rejectedProfileFields,
} from '../auth/public-profile.js';
import {
  ForbiddenError,
  PayloadTooLargeError,
  ValidationError,
} from '../http/errors.js';
import { streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import { rejectTenancyOverrides, readJsonBody } from '../organizations/http.js';
import {
  PROFILE_PICTURES_BUCKET,
  profileAvatarObjectKey,
} from '../organizations/buckets.js';
import { readOptionalString } from '../work/http.js';

export type MeRouteDependencies = {
  loadPublicProfile: (userId: string) => Promise<PublicProfile | null>;
  updatePublicProfile?: (
    userId: string,
    patch: PublicProfilePatch,
  ) => Promise<PublicProfile>;
  files?: FileStorage;
};

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

function serializeMe(
  auth: ReturnType<typeof getAuth>,
  profile: PublicProfile | null,
) {
  return {
    user: {
      id: auth.actor.userId,
      email: auth.actor.email,
      accountStatus: auth.actor.accountStatus,
      isActive: auth.actor.isActive,
    },
    profile: profile
      ? {
          fullName: profile.fullName,
          avatarUrl: profile.avatarUrl,
          jobTitle: profile.jobTitle,
          department: profile.department,
          employeeCode: profile.employeeCode,
          username: profile.username,
        }
      : null,
    membership: {
      organizationId: auth.membership.organizationId,
      officeId: auth.membership.officeId ?? null,
      roleKey: auth.membership.roleKey,
      status: auth.membership.status,
      isAdminRole: auth.membership.isAdminRole,
      isManagerRole: auth.membership.isManagerRole,
    },
    organization: {
      id: auth.organization.organizationId,
      status: auth.organization.status,
      accessStatus: auth.organization.accessStatus,
      isActive: auth.organization.isActive,
    },
  };
}

export function createMeRoutes(dependencies: MeRouteDependencies) {
  const me = new Hono();

  me.get('/', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const profile = await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json(serializeMe(auth, profile));
  });

  me.patch('/', async (c) => {
    const auth = getAuth(c);
    const body = await readJsonBody(c);

    const rejected = rejectedProfileFields(body);
    if (rejected.length > 0) {
      throw new ForbiddenError(
        'PROFILE_FIELD_REJECTED',
        'Profile updates cannot change organization, office, role, or account status.',
      );
    }

    rejectTenancyOverrides(auth, c, body);

    const patch = readPublicProfilePatch(body);
    const updater = dependencies.updatePublicProfile;

    const profile = updater
      ? await updater(auth.actor.userId, patch)
      : await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json(serializeMe(auth, profile));
  });

  me.post('/avatar/binary', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);
    const files = dependencies.files;
    if (!files) {
      throw new ValidationError('File storage is not configured.');
    }

    const rawLength = c.req.header('content-length');
    if (!rawLength) {
      throw new ValidationError('Content-Length is required for binary uploads.', {
        field: 'Content-Length',
      });
    }
    const sizeBytes = Number(rawLength);
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1) {
      throw new ValidationError('Content-Length must be a positive number.', {
        field: 'Content-Length',
      });
    }
    if (sizeBytes > MAX_AVATAR_BYTES) {
      throw new PayloadTooLargeError();
    }

    const filename = decodeURIComponent(
      c.req.query('filename') ?? c.req.header('x-kode-filename') ?? 'avatar.jpg',
    );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        200,
      ) ?? 'application/octet-stream';
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
      throw new ValidationError('Please choose a JPG, PNG, WebP, or GIF image.');
    }
    const body = Buffer.from(await readBodyWithLimit(c.req.raw, MAX_AVATAR_BYTES));
    if (body.length !== sizeBytes) {
      throw new ValidationError('The upload was incomplete. Please choose the image again.');
    }
    const objectKey = profileAvatarObjectKey({ userId: auth.actor.userId, filename });
    await files.ensureBucket?.(PROFILE_PICTURES_BUCKET);
    await files.putObject({
      bucket: PROFILE_PICTURES_BUCKET,
      objectKey,
      body,
      contentType,
    });

    const publicUrl = `/api/organization/avatar/file?objectKey=${encodeURIComponent(objectKey)}`;
    const updater = dependencies.updatePublicProfile;
    const profile = updater
      ? await updater(auth.actor.userId, { avatarUrl: publicUrl })
      : await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json(
      {
        ok: true,
        filePath: objectKey,
        publicUrl,
        ...serializeMe(auth, profile),
      },
      201,
    );
  });

  me.get('/avatar/file', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);
    const files = dependencies.files;
    if (!files) {
      throw new ValidationError('File storage is not configured.');
    }
    const objectKey = c.req.query('objectKey');
    if (!objectKey || !objectKey.startsWith(`${auth.actor.userId}/`)) {
      throw new ValidationError('objectKey is invalid.', { field: 'objectKey' });
    }
    return streamStoredMedia({
      files,
      bucket: PROFILE_PICTURES_BUCKET,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
      notFoundCode: 'AVATAR_NOT_FOUND',
      notFoundMessage: 'Avatar was not found.',
    });
  });

  return me;
}
