/** MinIO buckets for profile + organization branding assets. */
export const PROFILE_PICTURES_BUCKET = 'profile-pictures';
export const ORGANIZATION_BRANDING_BUCKET = 'organization-branding';

export const BRANDING_STORAGE_BUCKETS = [
  PROFILE_PICTURES_BUCKET,
  ORGANIZATION_BRANDING_BUCKET,
] as const;

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._\-()[\] ]+/g, '_').slice(0, 180) || 'file.bin';
}

export function profileAvatarObjectKey(params: {
  userId: string;
  filename: string;
}) {
  return `${params.userId}/${Date.now()}-${safeFilename(params.filename)}`;
}

export function organizationBrandingObjectKey(params: {
  organizationId: string;
  kind: 'logo' | 'favicon' | 'login_background';
  filename: string;
}) {
  return `${params.organizationId}/${params.kind}/${Date.now()}-${safeFilename(params.filename)}`;
}
