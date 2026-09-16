import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDevelopmentBootstrap,
  bootstrapDevelopmentPassword,
  parseBootstrapCommandLine,
} from '../src/auth/bootstrap-password.js';
import { MemoryAuthStore } from '../src/auth/memory-store.js';
import { isArgon2idHash, verifyPassword } from '../src/auth/passwords.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../src/http/errors.js';

const userId = '11111111-1111-1111-1111-111111111111';
const password = 'correct-horse-battery';

function seedStore(passwordHash: string | null = null) {
  const store = new MemoryAuthStore();
  store.seedUser({
    userId,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash,
  });
  return store;
}

test('bootstrap refuses to run outside development', async () => {
  const store = seedStore();

  assert.throws(
    () => assertDevelopmentBootstrap('staging'),
    /APP_ENV=development/,
  );
  assert.throws(
    () => assertDevelopmentBootstrap('production'),
    /APP_ENV=development/,
  );
  assert.throws(
    () => assertDevelopmentBootstrap('test'),
    /APP_ENV=development/,
  );

  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'production',
        userId,
        password,
        store,
      }),
    /APP_ENV=development/,
  );
  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'staging',
        userId,
        password,
        store,
      }),
    /APP_ENV=development/,
  );
});

test('CLI parser never accepts a password argument', () => {
  assert.throws(
    () => parseBootstrapCommandLine(['--user-id', userId, '--password', 'secret']),
    /command-line arguments/,
  );
  assert.throws(
    () => parseBootstrapCommandLine(['--password=secret', '--user-id', userId]),
    /command-line arguments/,
  );
  assert.throws(
    () => parseBootstrapCommandLine(['--user-id', userId, '-p', 'secret']),
    /command-line arguments/,
  );
  assert.throws(
    () => parseBootstrapCommandLine(['--user-id', userId, 'literal-password']),
    /Usage/,
  );
  assert.deepEqual(parseBootstrapCommandLine(['--user-id', userId, '--force']), {
    userId,
    force: true,
  });
});

test('bootstrap requires an existing identity user and does not create one', async () => {
  const store = new MemoryAuthStore();

  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'development',
        userId,
        password,
        store,
      }),
    (error: unknown) =>
      error instanceof NotFoundError && error.code === 'IDENTITY_NOT_FOUND',
  );
});

test('bootstrap stores an Argon2id hash without changing identity fields', async () => {
  const store = seedStore();
  let usedTransaction = false;

  const result = await bootstrapDevelopmentPassword({
    appEnv: 'development',
    userId,
    password,
    store,
    withTransaction: async (work) => {
      usedTransaction = true;
      return work({} as never);
    },
  });

  const identity = await store.findLoginIdentityById(userId);
  assert.equal(usedTransaction, true);
  assert.equal(result.userId, userId);
  assert.equal(result.email, 'user@example.com');
  assert.equal(result.replaced, false);
  assert.equal('password' in result, false);
  assert.equal('passwordHash' in result, false);
  assert.equal(identity?.email, 'user@example.com');
  assert.equal(identity?.isActive, true);
  assert.equal(identity?.accountStatus, 'active');
  assert.equal(isArgon2idHash(identity?.passwordHash ?? ''), true);
  assert.equal(await verifyPassword(identity!.passwordHash!, password), true);
});

test('bootstrap requires --force before replacing an existing credential', async () => {
  const store = seedStore('existing-hash');

  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'development',
        userId,
        password,
        store,
      }),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.code === 'PASSWORD_CREDENTIAL_EXISTS',
  );

  const replaced = await bootstrapDevelopmentPassword({
    appEnv: 'development',
    userId,
    password,
    force: true,
    store,
  });

  const identity = await store.findLoginIdentityById(userId);
  assert.equal(replaced.replaced, true);
  assert.equal(identity?.passwordHash === 'existing-hash', false);
  assert.equal(await verifyPassword(identity!.passwordHash!, password), true);
});

test('bootstrap reuses the shared password policy', async () => {
  const store = seedStore();

  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'development',
        userId,
        password: 'short',
        store,
      }),
    (error: unknown) => error instanceof ValidationError,
  );

  await assert.rejects(
    () =>
      bootstrapDevelopmentPassword({
        appEnv: 'development',
        userId,
        password: 'user@example.com',
        store,
      }),
    (error: unknown) => error instanceof ValidationError,
  );
});
