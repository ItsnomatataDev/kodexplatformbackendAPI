export type BearerExtraction =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      code: 'MISSING_CREDENTIAL' | 'MALFORMED_CREDENTIAL';
      message: string;
    };

export function extractBearerToken(
  authorizationHeader: string | undefined,
): BearerExtraction {
  if (authorizationHeader == null || authorizationHeader.trim() === '') {
    return {
      ok: false,
      code: 'MISSING_CREDENTIAL',
      message: 'Authentication is required.',
    };
  }

  const match = /^Bearer (\S+)$/i.exec(authorizationHeader.trim());

  if (!match) {
    return {
      ok: false,
      code: 'MALFORMED_CREDENTIAL',
      message: 'The authentication credential is malformed.',
    };
  }

  return {
    ok: true,
    token: match[1],
  };
}
