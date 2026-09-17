import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { test } from 'node:test';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import {
  CapturingEmailSender,
  createEmailSender,
  EmailDeliveryError,
  passwordResetDeliveryLogFields,
  SmtpEmailSender,
  UnconfiguredEmailSender,
} from '../src/auth/email.js';
import { LoginService } from '../src/auth/login.js';
import { MemoryAuthStore } from '../src/auth/memory-store.js';
import { PasswordService } from '../src/auth/password-service.js';
import { hashPassword } from '../src/auth/passwords.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { SessionService } from '../src/auth/sessions.js';
import type { AuthContext } from '../src/authorization/types.js';
import {
  assertEmailDeliveryConfigured,
  parseEmailDeliveryConfig,
  type SmtpEmailDeliveryConfig,
} from '../src/config/email-delivery.js';
import { logRedactCensor, logRedactPaths } from '../src/config/redaction.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  parseSmtpCapabilities,
  sendSmtpMail,
} from '../src/auth/smtp-transport.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const secret = 'test-only-access-token-secret-value!!';
const password = 'correct-horse-battery';
const smtpPassword = 'smtp-runtime-password-value';
const genericResetMessage =
  'If the account exists, password reset instructions will be sent.';

function smtpConfig(
  overrides: Partial<SmtpEmailDeliveryConfig> = {},
): SmtpEmailDeliveryConfig {
  return {
    provider: 'smtp',
    host: 'smtp.example',
    port: 587,
    secure: false,
    username: 'mailer',
    password: 'not-a-placeholder-secret',
    from: 'noreply@example.com',
    ...overrides,
  };
}

function authContext(userId: string, email: string): AuthContext {
  return {
    actor: {
      userId,
      email,
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: `membership-${userId}`,
      organizationId: orgA,
      roleId: 'role-1',
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: {},
    },
    organization: {
      organizationId: orgA,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

async function json(response: Response) {
  return response.json() as Promise<{
    message?: string;
    reset?: boolean;
    error?: { code?: string; message?: string };
  }>;
}

test('PB-05 production and remote staging fail closed without an email provider', () => {
  const unconfigured = parseEmailDeliveryConfig({});
  assert.equal(unconfigured.provider, 'unconfigured');

  assert.throws(
    () =>
      assertEmailDeliveryConfigured({
        appEnv: 'production',
        localInfrastructure: false,
        email: unconfigured,
      }),
    /Production requires EMAIL_PROVIDER=smtp/,
  );
  assert.throws(
    () =>
      assertEmailDeliveryConfigured({
        appEnv: 'staging',
        localInfrastructure: false,
        email: unconfigured,
      }),
    /Remote staging requires EMAIL_PROVIDER=smtp/,
  );
});

test('PB-05 development and loopback staging may use the unconfigured sender', () => {
  const unconfigured = { provider: 'unconfigured' as const };

  assert.doesNotThrow(() =>
    assertEmailDeliveryConfigured({
      appEnv: 'development',
      localInfrastructure: true,
      email: unconfigured,
    }),
  );
  assert.doesNotThrow(() =>
    assertEmailDeliveryConfigured({
      appEnv: 'staging',
      localInfrastructure: true,
      email: unconfigured,
    }),
  );
  assert.equal(
    createEmailSender(unconfigured) instanceof UnconfiguredEmailSender,
    true,
  );
});

test('PB-05 configured SMTP provider is selected and requires real credentials', () => {
  const parsed = parseEmailDeliveryConfig({
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USERNAME: 'mailer',
    SMTP_PASSWORD: 'not-a-placeholder-secret',
    SMTP_FROM: 'noreply@example.com',
  });

  assert.equal(parsed.provider, 'smtp');
  if (parsed.provider !== 'smtp') {
    throw new Error('expected smtp config');
  }

  assert.doesNotThrow(() =>
    assertEmailDeliveryConfigured({
      appEnv: 'production',
      localInfrastructure: false,
      email: parsed,
    }),
  );
  assert.equal(createEmailSender(parsed) instanceof SmtpEmailSender, true);

  assert.throws(
    () => parseEmailDeliveryConfig({ EMAIL_PROVIDER: 'smtp' }),
    /SMTP_HOST is required/,
  );
  assert.throws(
    () =>
      assertEmailDeliveryConfigured({
        appEnv: 'production',
        localInfrastructure: false,
        email: smtpConfig({ password: 'REPLACE_WITH_RUNTIME_SECRET' }),
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /SMTP_PASSWORD/);
      assert.equal(message.includes('REPLACE_WITH_RUNTIME_SECRET'), false);
      return true;
    },
  );
  assert.throws(
    () =>
      assertEmailDeliveryConfigured({
        appEnv: 'staging',
        localInfrastructure: false,
        email: smtpConfig({ password: 'kode_dev_password' }),
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /SMTP_PASSWORD/);
      assert.equal(message.includes('kode_dev_password'), false);
      return true;
    },
  );
});

test('PB-05 password reset log fields never include the token or address local part', () => {
  const fields = passwordResetDeliveryLogFields('user@example.com');
  assert.deepEqual(fields, {
    template: 'password_reset',
    toDomain: 'example.com',
  });
  assert.equal('resetToken' in fields, false);
  assert.equal(JSON.stringify(fields).includes('user@'), false);
});

test('PB-05 a new reset request invalidates the previous unused token only for that user', async () => {
  const store = new MemoryAuthStore();
  store.seedUser({
    userId: userA,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash: await hashPassword(password),
  });
  store.seedUser({
    userId: userB,
    email: 'other@example.com',
    emailNormalized: 'other@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash: await hashPassword(password),
  });

  const accessTokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/test',
    audience: 'kode-platform-api/test',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
  });
  const sessions = new SessionService({
    store,
    tokenSecret: secret,
    accessTokens,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    resolveAuthContext: async (userId) => {
      if (userId === userB) {
        return authContext(userB, 'other@example.com');
      }
      return authContext(userA, 'user@example.com');
    },
  });
  const email = new CapturingEmailSender();
  const passwords = new PasswordService({
    store,
    sessions,
    tokenSecret: secret,
    passwordResetTtlSeconds: 1_800,
    sendPasswordResetEmail: (message) => email.sendPasswordReset(message),
  });

  await passwords.requestPasswordReset('user@example.com');
  const firstToken = email.lastReset!.resetToken;
  await passwords.requestPasswordReset('other@example.com');
  const otherToken = email.lastReset!.resetToken;
  await passwords.requestPasswordReset('user@example.com');
  const secondToken = email.lastReset!.resetToken;

  await assert.rejects(
    () => passwords.confirmPasswordReset(firstToken, 'reset-password-1'),
    UnauthorizedError,
  );
  await passwords.confirmPasswordReset(secondToken, 'reset-password-1');
  await passwords.confirmPasswordReset(otherToken, 'reset-password-2');

  await assert.rejects(
    () => passwords.confirmPasswordReset(secondToken, 'reset-password-3'),
    UnauthorizedError,
  );
});

test('PB-05 provider failure does not leak secrets or account existence', async () => {
  const store = new MemoryAuthStore();
  store.seedUser({
    userId: userA,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash: await hashPassword(password),
  });

  const accessTokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/test',
    audience: 'kode-platform-api/test',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
  });
  const resolve = async (userId: string) => {
    if (userId !== userA) {
      throw new UnauthorizedError(
        'IDENTITY_NOT_FOUND',
        'The authenticated identity is no longer valid.',
      );
    }
    return authContext(userA, 'user@example.com');
  };
  const sessions = new SessionService({
    store,
    tokenSecret: secret,
    accessTokens,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    resolveAuthContext: resolve,
  });

  const chunks: string[] = [];
  const probeLogger = pino(
    {
      redact: {
        paths: [...logRedactPaths],
        censor: logRedactCensor,
      },
    },
    {
      write(chunk) {
        chunks.push(chunk);
      },
    },
  );
  probeLogger.warn(
    { SMTP_PASSWORD: smtpPassword, resetToken: 'should-not-appear' },
    'delivery probe',
  );

  const sender = createEmailSender(smtpConfig({ password: smtpPassword }), {
    deliverSmtp: async () => {
      throw new Error(`535 Authentication failed using ${smtpPassword}`);
    },
  });

  const auth = {
    verifier: accessTokens,
    resolveAuthContext: resolve,
    requireActiveSession: (sessionId: string, userId: string) =>
      sessions.requireActiveSession(sessionId, userId),
  };
  const app = createApp({
    auth,
    me: { loadPublicProfile: async () => null },
    authLifecycle: {
      auth,
      login: new LoginService({ store, sessions }),
      sessions,
      passwords: new PasswordService({
        store,
        sessions,
        tokenSecret: secret,
        passwordResetTtlSeconds: 1_800,
        sendPasswordResetEmail: (message) => sender.sendPasswordReset(message),
      }),
      rateLimiter: new MemoryRateLimiter(['test']),
      cookies: { secure: false, refreshMaxAgeSeconds: 3_600 },
    },
    corsOrigins: ['http://127.0.0.1:5173'],
  });

  const known = await json(
    await app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    }),
  );
  const unknown = await json(
    await app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com' }),
    }),
  );

  assert.equal(known.message, genericResetMessage);
  assert.equal(unknown.message, known.message);
  assert.equal(JSON.stringify(known).includes(smtpPassword), false);
  assert.equal(JSON.stringify(unknown).includes(smtpPassword), false);

  await assert.rejects(
    () =>
      sender.sendPasswordReset({
        to: 'user@example.com',
        resetToken: 'plaintext-reset-token',
      }),
    EmailDeliveryError,
  );

  const serializedLogs = chunks.join('');
  assert.equal(serializedLogs.includes(smtpPassword), false);
  assert.equal(serializedLogs.includes('should-not-appear'), false);
  assert.equal(serializedLogs.includes('plaintext-reset-token'), false);
});

test('PB-05 EHLO capability parsing detects STARTTLS and AUTH LOGIN', () => {
  assert.deepEqual(
    parseSmtpCapabilities(
      ['250-kode mock', '250-STARTTLS', '250 AUTH LOGIN PLAIN'].join('\n'),
    ),
    { startTls: true, authLogin: true },
  );
  assert.deepEqual(
    parseSmtpCapabilities('250-PIPELINING\n250 AUTH=LOGIN\n'),
    { startTls: false, authLogin: true },
  );
  assert.deepEqual(
    parseSmtpCapabilities('250-STARTTLS\n250 AUTH PLAIN\n'),
    { startTls: true, authLogin: false },
  );
  assert.deepEqual(parseSmtpCapabilities('250 PIPELINING'), {
    startTls: false,
    authLogin: false,
  });
});

type MockSmtpOptions = {
  implicitTls: boolean;
  advertiseStartTls: boolean;
  plaintextAuthLogin: boolean;
  tlsAuthLogin: boolean;
};

type MockSmtpServer = {
  port: number;
  ca: Buffer;
  commands: string[];
  close: () => Promise<void>;
};

function createMockTlsMaterial() {
  const directory = mkdtempSync(join(tmpdir(), 'kode-smtp-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  const configPath = join(directory, 'openssl.cnf');
  writeFileSync(
    configPath,
    [
      '[req]',
      'distinguished_name = req_distinguished_name',
      'x509_extensions = v3_req',
      'prompt = no',
      '[req_distinguished_name]',
      'CN = localhost',
      '[v3_req]',
      'subjectAltName = DNS:localhost',
      '',
    ].join('\n'),
  );

  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-config',
      configPath,
    ],
    { encoding: 'utf8' },
  );

  if (generated.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('Failed to create a test TLS certificate.');
  }

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function reply(socket: net.Socket, lines: string[]) {
  socket.write(`${lines.join('\r\n')}\r\n`);
}

function ehloReply(startTls: boolean, authLogin: boolean) {
  const capabilities = ['250-kode mock'];
  if (startTls) {
    capabilities.push('250-STARTTLS');
  }
  capabilities.push(authLogin ? '250 AUTH LOGIN' : '250 PIPELINING');
  return capabilities;
}

function attachSmtpSession(
  socket: net.Socket,
  options: MockSmtpOptions,
  commands: string[],
  tlsMaterial: { key: Buffer; cert: Buffer },
  secured: boolean,
) {
  let buffer = '';
  let mode: 'command' | 'auth' | 'data' = 'command';
  let authLines = 0;
  let current: net.Socket = socket;
  let tlsEnabled = secured;

  const recordCommand = (verb: string) => {
    commands.push(verb);
  };

  const handleLine = (line: string) => {
    if (mode === 'auth') {
      authLines += 1;
      if (authLines === 1) {
        reply(current, ['334 UGFzc3dvcmQ6']);
        return;
      }
      authLines = 0;
      mode = 'command';
      reply(current, ['235 2.7.0 Authentication succeeded']);
      return;
    }

    if (mode === 'data') {
      if (line === '.') {
        mode = 'command';
        reply(current, ['250 2.0.0 OK']);
      }
      return;
    }

    const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';
    if (verb === 'EHLO') {
      recordCommand('EHLO');
      reply(
        current,
        ehloReply(
          !tlsEnabled && options.advertiseStartTls,
          tlsEnabled ? options.tlsAuthLogin : options.plaintextAuthLogin,
        ),
      );
      return;
    }

    if (verb === 'STARTTLS') {
      recordCommand('STARTTLS');
      if (tlsEnabled || !options.advertiseStartTls) {
        reply(current, ['502 5.5.1 STARTTLS not available']);
        return;
      }

      current.removeListener('data', onData);
      current.write('220 2.0.0 Ready to start TLS\r\n', () => {
        const upgraded = new tls.TLSSocket(current, {
          isServer: true,
          secureContext: tls.createSecureContext({
            key: tlsMaterial.key,
            cert: tlsMaterial.cert,
          }),
        });
        tlsEnabled = true;
        current = upgraded;
        buffer = '';
        upgraded.on('secure', () => {
          upgraded.on('data', onData);
        });
      });
      return;
    }

    if (verb === 'AUTH') {
      recordCommand(line.toUpperCase().startsWith('AUTH LOGIN') ? 'AUTH LOGIN' : 'AUTH');
      mode = 'auth';
      authLines = 0;
      reply(current, ['334 VXNlcm5hbWU6']);
      return;
    }

    if (verb === 'MAIL') {
      recordCommand('MAIL');
      reply(current, ['250 2.1.0 OK']);
      return;
    }

    if (verb === 'RCPT') {
      recordCommand('RCPT');
      reply(current, ['250 2.1.5 OK']);
      return;
    }

    if (verb === 'DATA') {
      recordCommand('DATA');
      mode = 'data';
      reply(current, ['354 Start mail input']);
      return;
    }

    if (verb === 'QUIT') {
      recordCommand('QUIT');
      reply(current, ['221 2.0.0 Bye']);
    }
  };

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let separator: number;
    while ((separator = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      handleLine(line);
    }
  };

  reply(current, ['220 mock SMTP']);
  current.on('data', onData);
}

function listenMockSmtp(options: MockSmtpOptions): Promise<MockSmtpServer> {
  const tlsMaterial = createMockTlsMaterial();
  const commands: string[] = [];
  const server = options.implicitTls
    ? tls.createServer(
        {
          key: tlsMaterial.key,
          cert: tlsMaterial.cert,
        },
        (socket) =>
          attachSmtpSession(socket, options, commands, tlsMaterial, true),
      )
    : net.createServer((socket) =>
        attachSmtpSession(socket, options, commands, tlsMaterial, false),
      );

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Mock SMTP server did not bind a TCP port.'));
        return;
      }

      resolve({
        port: address.port,
        ca: tlsMaterial.cert,
        commands,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              tlsMaterial.cleanup();
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
    server.once('error', reject);
  });
}

const resetMail = {
  to: 'user@example.com',
  subject: 'Reset your password',
  text: 'opaque-reset-token',
};

test('PB-05 implicit TLS SMTP sends mail when AUTH LOGIN is advertised', async () => {
  const server = await listenMockSmtp({
    implicitTls: true,
    advertiseStartTls: false,
    plaintextAuthLogin: false,
    tlsAuthLogin: true,
  });

  try {
    await sendSmtpMail(
      smtpConfig({
        host: 'localhost',
        port: server.port,
        secure: true,
      }),
      resetMail,
      { ca: server.ca },
    );
    assert.deepEqual(
      server.commands.filter((command) =>
        ['EHLO', 'STARTTLS', 'AUTH LOGIN', 'MAIL', 'DATA'].includes(command),
      ),
      ['EHLO', 'AUTH LOGIN', 'MAIL', 'DATA'],
    );
    assert.equal(server.commands.includes('STARTTLS'), false);
  } finally {
    await server.close();
  }
});

test('PB-05 STARTTLS SMTP upgrades, EHLO again, then AUTH LOGIN', async () => {
  const server = await listenMockSmtp({
    implicitTls: false,
    advertiseStartTls: true,
    plaintextAuthLogin: true,
    tlsAuthLogin: true,
  });

  try {
    await sendSmtpMail(
      smtpConfig({
        host: 'localhost',
        port: server.port,
        secure: false,
      }),
      resetMail,
      { ca: server.ca },
    );
    assert.deepEqual(
      server.commands.filter((command) =>
        ['EHLO', 'STARTTLS', 'AUTH LOGIN'].includes(command),
      ),
      ['EHLO', 'STARTTLS', 'EHLO', 'AUTH LOGIN'],
    );
  } finally {
    await server.close();
  }
});

test('PB-05 SMTP does not authenticate over plaintext when STARTTLS is absent', async () => {
  const server = await listenMockSmtp({
    implicitTls: false,
    advertiseStartTls: false,
    plaintextAuthLogin: true,
    tlsAuthLogin: false,
  });

  try {
    await assert.rejects(
      () =>
        sendSmtpMail(
          smtpConfig({
            host: 'localhost',
            port: server.port,
            secure: false,
          }),
          resetMail,
        ),
      /STARTTLS is required/,
    );
    assert.equal(server.commands.includes('AUTH LOGIN'), false);
    assert.equal(server.commands.includes('STARTTLS'), false);
  } finally {
    await server.close();
  }
});

test('PB-05 SMTP fails safely when AUTH LOGIN is not advertised', async () => {
  const implicit = await listenMockSmtp({
    implicitTls: true,
    advertiseStartTls: false,
    plaintextAuthLogin: false,
    tlsAuthLogin: false,
  });

  try {
    await assert.rejects(
      () =>
        sendSmtpMail(
          smtpConfig({
            host: 'localhost',
            port: implicit.port,
            secure: true,
          }),
          resetMail,
          { ca: implicit.ca },
        ),
      /AUTH LOGIN is not available/,
    );
    assert.equal(implicit.commands.includes('AUTH LOGIN'), false);
  } finally {
    await implicit.close();
  }

  const startTls = await listenMockSmtp({
    implicitTls: false,
    advertiseStartTls: true,
    plaintextAuthLogin: false,
    tlsAuthLogin: false,
  });

  try {
    await assert.rejects(
      () =>
        sendSmtpMail(
          smtpConfig({
            host: 'localhost',
            port: startTls.port,
            secure: false,
          }),
          resetMail,
          { ca: startTls.ca },
        ),
      /AUTH LOGIN is not available/,
    );
    assert.deepEqual(
      startTls.commands.filter((command) =>
        ['EHLO', 'STARTTLS', 'AUTH LOGIN'].includes(command),
      ),
      ['EHLO', 'STARTTLS', 'EHLO'],
    );
  } finally {
    await startTls.close();
  }
});

