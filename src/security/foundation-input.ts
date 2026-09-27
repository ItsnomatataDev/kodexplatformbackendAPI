import { ValidationError } from '../http/errors.js';
import { readRequiredText } from '../work/http.js';

const PROJECT_STATUS = new Set(['active', 'paused', 'retired']);
const ASSET_STATUS = new Set(['active', 'paused', 'quarantined', 'retired']);
const ENVIRONMENT = new Set(['development', 'staging', 'production']);
const CRITICALITY = new Set(['low', 'medium', 'high', 'critical']);
const ASSET_TYPE = new Set([
  'application',
  'api',
  'server',
  'database',
  'container',
  'service',
  'domain',
  'repository',
  'dependency',
  'other',
]);
const INTEGRATION_TYPE = new Set(['api', 'webhook', 'agent', 'provider']);
const SECRET_FIELDS = [
  'secret',
  'token',
  'api_key',
  'apiKey',
  'password',
  'credential',
  'credentials',
  'private_key',
  'privateKey',
];

export function rejectSecretFields(body: Record<string, unknown>) {
  for (const field of SECRET_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new ValidationError(
        `${field} cannot be stored on a security integration. Pass credential_ref, a reference to a secret held outside Kode.`,
        { field },
      );
    }
  }
}

function oneOf(value: string, allowed: Set<string>, field: string) {
  if (!allowed.has(value)) {
    throw new ValidationError(`${field} is not an allowed value.`, { field });
  }
  return value;
}

export function readSlug(value: unknown) {
  const slug = readRequiredText(value, 'slug', 80)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new ValidationError('slug is required.', { field: 'slug' });
  }
  return slug;
}

export function readEnvironment(value: unknown, fallback = 'production') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('environment is not an allowed value.', {
      field: 'environment',
    });
  }
  return oneOf(value, ENVIRONMENT, 'environment');
}

export function readCriticality(value: unknown, fallback = 'medium') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('criticality is not an allowed value.', {
      field: 'criticality',
    });
  }
  return oneOf(value, CRITICALITY, 'criticality');
}

export function readProjectStatus(value: unknown) {
  if (typeof value !== 'string') {
    throw new ValidationError('status is not an allowed value.', { field: 'status' });
  }
  return oneOf(value, PROJECT_STATUS, 'status');
}

export function readAssetStatus(value: unknown) {
  if (typeof value !== 'string') {
    throw new ValidationError('status is not an allowed value.', { field: 'status' });
  }
  return oneOf(value, ASSET_STATUS, 'status');
}

export function readAssetType(value: unknown, fallback = 'service') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('asset_type is not an allowed value.', {
      field: 'asset_type',
    });
  }
  return oneOf(value, ASSET_TYPE, 'asset_type');
}

export function readIntegrationType(value: unknown) {
  if (typeof value !== 'string') {
    throw new ValidationError('integration_type is required.', {
      field: 'integration_type',
    });
  }
  return oneOf(value, INTEGRATION_TYPE, 'integration_type');
}

export function readCredentialRef(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError('credential_ref must be a reference string.', {
      field: 'credential_ref',
    });
  }
  const ref = value.trim();
  if (ref.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref)) {
    throw new ValidationError(
      'credential_ref must be a short reference such as env:HAROLD_INGEST, not a secret.',
      { field: 'credential_ref' },
    );
  }
  return ref;
}
