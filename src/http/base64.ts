import { PayloadTooLargeError, ValidationError } from './errors.js';
import { maxBase64LengthForBytes } from './limits.js';

const STRICT_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function decodeStrictBase64(
  value: unknown,
  field: string,
  maxBytes: number,
): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} is required.`, { field });
  }

  if (value.length > maxBase64LengthForBytes(maxBytes)) {
    throw new PayloadTooLargeError('The attachment exceeds the maximum size.');
  }

  if (!STRICT_BASE64.test(value)) {
    throw new ValidationError(`${field} must be base64 encoded.`, { field });
  }

  const expectedBytes = decodedLength(value);
  if (expectedBytes <= 0) {
    throw new ValidationError(`${field} is required.`, { field });
  }

  if (expectedBytes > maxBytes) {
    throw new PayloadTooLargeError('The attachment exceeds the maximum size.');
  }

  const buffer = Buffer.from(value, 'base64');

  if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
    throw new PayloadTooLargeError('The attachment exceeds the maximum size.');
  }

  if (buffer.toString('base64') !== value) {
    throw new ValidationError(`${field} must be base64 encoded.`, { field });
  }

  return buffer;
}
