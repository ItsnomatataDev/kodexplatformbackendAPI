import { PayloadTooLargeError, ValidationError } from './errors.js';
import { FIELD_LIMITS } from './limits.js';

export function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required.`, { field });
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters.`, {
      field,
    });
  }

  return trimmed;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ValidationError('Invalid string field.', { field });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters.`, {
      field,
    });
  }

  return trimmed;
}

function metadataStats(
  value: unknown,
  depth: number,
): { depth: number; breadth: number } {
  if (value === null || typeof value !== 'object') {
    return { depth, breadth: 0 };
  }

  const entries = Array.isArray(value) ? value : Object.values(value);
  let maxDepth = depth;
  let maxBreadth = entries.length;

  for (const child of entries) {
    const nested = metadataStats(child, depth + 1);
    maxDepth = Math.max(maxDepth, nested.depth);
    maxBreadth = Math.max(maxBreadth, nested.breadth);
  }

  return { depth: maxDepth, breadth: maxBreadth };
}

export function optionalMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Metadata must be a JSON object.');
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ValidationError('Metadata must be a JSON object.');
  }

  if (serialized.length > FIELD_LIMITS.metadataMaxBytes) {
    throw new PayloadTooLargeError('Metadata exceeds the maximum size.');
  }

  const stats = metadataStats(value, 1);
  if (stats.depth > FIELD_LIMITS.metadataMaxDepth) {
    throw new ValidationError('Metadata is too deeply nested.');
  }

  if (stats.breadth > FIELD_LIMITS.metadataMaxBreadth) {
    throw new ValidationError('Metadata has too many keys or items.');
  }

  return value as Record<string, unknown>;
}
