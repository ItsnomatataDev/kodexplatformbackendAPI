export type VerifiedIdentity = {
  userId: string;
  sessionId?: string;
};

export interface CredentialVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export type AccessTokenConfig = {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  clockToleranceSeconds?: number;
};
