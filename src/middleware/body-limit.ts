import { createMiddleware } from 'hono/factory';
import { PayloadTooLargeError, ValidationError } from '../http/errors.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export function getLimitedBodyText(c: {
  get: (key: 'limitedBodyText') => string | undefined;
}): string | undefined {
  return c.get('limitedBodyText');
}

export function bodyLimitMiddleware(maxBytes: number) {
  return createMiddleware(async (c, next) => {
    if (!BODY_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const declared = c.req.header('content-length');
    if (declared != null && declared !== '') {
      const size = Number(declared);
      if (!Number.isInteger(size) || size < 0) {
        throw new ValidationError('Invalid Content-Length header.');
      }

      if (size > maxBytes) {
        throw new PayloadTooLargeError();
      }
    }

    const body = await readBodyWithLimit(c.req.raw, maxBytes);
    c.set('limitedBodyText', new TextDecoder('utf8', { fatal: false }).decode(body));
    await next();
  });
}
