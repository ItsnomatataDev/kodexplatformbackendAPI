/** Ordinary authentication fixture. All identity/session state is disposable memory. */
export async function ordinaryFixture(role: 'it' | 'admin') {
  Object.assign(process.env, {
    APP_ENV: 'development',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_NAME: 'kode_platform',
    DATABASE_USER: 'kode',
    DATABASE_PASSWORD: 'test',
    AUTH_TOKEN_SECRET: 'dev-only-kode-platform-access-token-secret',
  });
  const [
    { createApp },
    { AccessTokenService },
    { MemoryAuthStore },
    { SessionService },
    { LoginService },
    { PasswordService },
    { MemoryRateLimiter },
  ] = await Promise.all([
    import('../src/app.js'),
    import('../src/auth/access-token.js'),
    import('../src/auth/memory-store.js'),
    import('../src/auth/sessions.js'),
    import('../src/auth/login.js'),
    import('../src/auth/password-service.js'),
    import('../src/auth/rate-limit.js'),
  ]);
  const userId = '11111111-1111-1111-1111-111111111111',
    orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const store = new MemoryAuthStore();
  const user = {
    userId,
    email: 'ordinary@example.test',
    emailNormalized: 'ordinary@example.test',
    isActive: true,
    accountStatus: 'active' as const,
    deletedAt: null,
    passwordHash: null,
  };
  store.seedUser(user);
  const context = {
    actor: {
      userId,
      email: user.email,
      isActive: true,
      accountStatus: 'active' as const,
      deletedAt: null,
    },
    membership: {
      membershipId: 'm',
      organizationId: orgId,
      officeId: null,
      roleId: 'r',
      roleKey: role,
      status: 'active' as const,
      isAdminRole: role === 'admin',
      isManagerRole: false,
      permissions: {},
    },
    organization: {
      organizationId: orgId,
      isActive: true,
      status: 'active' as const,
      accessStatus: 'active' as const,
    },
  };
  const resolve = async () => context;
  const secret = 'test-only-independent-ordinary-token-secret';
  const accessTokens = new AccessTokenService({
    secret,
    issuer: 'kode-test',
    audience: 'kode-test',
    ttlSeconds: 900,
  });
  const sessions = new SessionService({
    store,
    tokenSecret: secret,
    accessTokens,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    resolveAuthContext: resolve,
  });
  const auth = {
    verifier: accessTokens,
    resolveAuthContext: resolve,
    requireActiveSession: (id: string, uid: string) =>
      sessions.requireActiveSession(id, uid),
  };
  const app = createApp({
    auth,
    me: { loadPublicProfile: async () => null },
    authLifecycle: {
      auth,
      sessions,
      login: new LoginService({ store, sessions }),
      passwords: new PasswordService({
        store,
        sessions,
        tokenSecret: secret,
        passwordResetTtlSeconds: 1800,
        sendPasswordResetEmail: async () => {},
      }),
      rateLimiter: new MemoryRateLimiter(['test']),
      cookies: { secure: false, refreshMaxAgeSeconds: 3600 },
    },
  });
  const issued = await sessions.createAuthenticatedSession(userId);
  return {
    app,
    authorization: `Bearer ${issued.accessToken}`,
    refreshToken: issued.refreshToken,
  };
}
