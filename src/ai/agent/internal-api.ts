import { randomBytes } from 'node:crypto';
import type { AuthContext } from '../../authorization/types.js';

export const KODEX_INTERNAL_HEADER = 'x-kodex-internal';

const grants = new Map<string, AuthContext>();

/** Single-use, in-process only: the grant exists for the duration of one internal request. */
export function claimInternalAuth(token: string | undefined | null) {
  if (!token) return null;
  const auth = grants.get(token);
  if (!auth) return null;
  grants.delete(token);
  return auth;
}

export type ApiResult = {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
};

export type InternalApi = (
  auth: AuthContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
) => Promise<ApiResult>;

type FetchApp = { fetch(request: Request): Response | Promise<Response> };

export function createInternalApi(app: FetchApp): InternalApi {
  return async (auth, method, path, body) => {
    const token = randomBytes(32).toString('base64url');
    grants.set(token, auth);
    try {
      const response = await app.fetch(
        new Request(`http://kodex.internal/api${path}`, {
          method,
          headers: {
            [KODEX_INTERNAL_HEADER]: token,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return {
        status: response.status,
        ok: response.ok,
        body: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      };
    } finally {
      grants.delete(token);
    }
  };
}

export function apiErrorMessage(result: ApiResult) {
  const error = result.body.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof result.body.message === 'string' && result.body.message.trim()) {
    return result.body.message.trim();
  }
  if (result.status === 403) return 'Your role is not allowed to do that.';
  if (result.status === 404) return 'That record was not found.';
  if (result.status === 429) return 'Too many changes in a short time. Try again in a minute.';
  return `The request failed (${result.status}).`;
}
