import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { UnauthorizedError } from '../http/errors.js';
import { isUuid } from './uuid.js';
import type {
  AccessTokenConfig,
  CredentialVerifier,
  VerifiedIdentity,
} from './verifier.js';

const SIGNING_ALGORITHM = 'HS256';

export class AccessTokenService implements CredentialVerifier {
  private readonly key: Uint8Array;

  constructor(private readonly config: AccessTokenConfig) {
    if (config.secret.length < 32) {
      throw new Error('AUTH_TOKEN_SECRET must be at least 32 characters.');
    }

    this.key = new TextEncoder().encode(config.secret);
  }

  async issue(
    userId: string,
    options: { expiresAt?: Date; sessionId?: string } = {},
  ): Promise<string> {
    if (!isUuid(userId)) {
      throw new Error('Access tokens can only be issued for UUID user ids.');
    }

    if (options.sessionId && !isUuid(options.sessionId)) {
      throw new Error('Access token session ids must be UUIDs.');
    }

    const token = new SignJWT({
      token_use: 'access',
      ...(options.sessionId ? { sid: options.sessionId } : {}),
    })
      .setProtectedHeader({
        alg: SIGNING_ALGORITHM,
        typ: 'JWT',
      })
      .setSubject(userId)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt();

    if (options.expiresAt) {
      token.setExpirationTime(options.expiresAt);
    } else {
      token.setExpirationTime(`${this.config.ttlSeconds}s`);
    }

    return token.sign(this.key);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: [SIGNING_ALGORITHM],
        clockTolerance: this.config.clockToleranceSeconds ?? 5,
      });

      if (payload.token_use !== 'access') {
        throw new UnauthorizedError(
          'INVALID_CREDENTIAL',
          'Authentication is required.',
        );
      }

      if (typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
        throw new UnauthorizedError(
          'INVALID_CREDENTIAL',
          'Authentication is required.',
        );
      }

      const sessionId =
        typeof payload.sid === 'string' && isUuid(payload.sid)
          ? payload.sid
          : undefined;

      return { userId: payload.sub, sessionId };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      if (error instanceof joseErrors.JWTExpired) {
        throw new UnauthorizedError(
          'EXPIRED_CREDENTIAL',
          'The access token has expired.',
        );
      }

      throw new UnauthorizedError(
        'INVALID_CREDENTIAL',
        'Authentication is required.',
      );
    }
  }
}
