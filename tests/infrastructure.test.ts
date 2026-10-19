import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, verify } from 'otplib';
import { randomBytes } from 'node:crypto';
import {
  readInfrastructureConfig,
  readProvisioningConfig,
} from '../src/infrastructure/config.js';
import {
  digest,
  seal,
  unseal,
  equal,
} from '../src/infrastructure/crypto/secrets.js';
import {
  validateInfrastructurePassword,
  hashPassword,
  verifyPassword,
} from '../src/infrastructure/auth/passwords.js';
import { validatePermissions } from '../src/infrastructure/authorization/permissions.js';
const source = {
  INFRA_ENABLED: 'true',
  INFRA_LOCAL_HTTP: 'true',
  INFRA_ORIGIN: 'http://localhost:5173',
  INFRA_DATABASE_URL: 'postgres://local',
  INFRA_ORGANIZATION_ID: 'ae975c01-c044-4c5d-b5b5-4b6a06b55957',
  INFRA_TOKEN_KEY: randomBytes(32).toString('base64'),
  INFRA_MFA_KEYS: JSON.stringify({ v1: randomBytes(32).toString('base64') }),
  INFRA_MFA_ACTIVE_KEY: 'v1',
};
test('configuration is opt-in, isolated and restricts insecure development to loopback', () => {
  assert.throws(() => readInfrastructureConfig({}));
  assert.throws(() =>
    readInfrastructureConfig({ ...source, INFRA_ORIGIN: 'http://example.com' }),
  );
  assert.throws(() =>
    readInfrastructureConfig({ ...source, INFRA_HOST: '0.0.0.0' }),
  );
  assert.throws(() =>
    readInfrastructureConfig({
      ...source,
      INFRA_MFA_KEYS: JSON.stringify({ v1: source.INFRA_TOKEN_KEY }),
    }),
  );
});
test('encrypted MFA is authenticated, account-bound and supports key ring rotation', () => {
  const c = readInfrastructureConfig(source),
    box = seal(c, 'a', 'TOP SECRET');
  assert.equal(unseal(c, 'a', box), 'TOP SECRET');
  assert.throws(() => unseal(c, 'b', box));
  assert.throws(() =>
    unseal(c, 'a', { ...box, tag: randomBytes(16).toString('base64') }),
  );
  assert.equal(
    unseal(
      {
        ...c,
        activeKeyId: 'v2',
        encryptionKeys: { ...c.encryptionKeys, v2: randomBytes(32) },
      },
      'a',
      box,
    ),
    'TOP SECRET',
  );
  assert.notEqual(digest(c, 'session', 'x'), digest(c, 'challenge', 'x'));
  assert.equal(equal('a', 'é'), false);
});
test('independent password and permission policy', async () => {
  assert.throws(() => validateInfrastructurePassword('four'));
  validateInfrastructurePassword(' fifteen characters ');
  assert.throws(() => validatePermissions(['admin']));
  assert.throws(() => validatePermissions(['infra.database.write']));
  const hash = await hashPassword('distinct infrastructure password');
  assert.equal(
    await verifyPassword(hash, 'distinct infrastructure password'),
    true,
  );
  assert.equal(await verifyPassword(hash, 'wrong'), false);
});
test('maintained TOTP implementation matches RFC 6238 vectors and replay/skew policy', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [epoch, token] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ] as const)
    assert.equal(await generate({ secret, epoch, digits: 8 }), token);
  const epoch = 1800000000,
    token = await generate({ secret, epoch });
  assert.equal(
    (await verify({ secret, token, epoch: epoch + 30, epochTolerance: 30 }))
      .valid,
    true,
  );
  assert.equal(
    (await verify({ secret, token, epoch: epoch + 60, epochTolerance: 30 }))
      .valid,
    false,
  );
  assert.equal(
    (await verify({ secret, token, epoch, afterTimeStep: epoch / 30 })).valid,
    false,
  );
});

test('provisioning configuration never reads or returns runtime keys', () => {
  const config = readProvisioningConfig({
    INFRA_PROVISION_DATABASE_URL: 'postgres://operator',
    INFRA_ORGANIZATION_ID: source.INFRA_ORGANIZATION_ID,
    INFRA_MFA_KEYS_FILE: '/path/that/must/not/be/read',
    INFRA_TOKEN_KEY_FILE: '/also/not/read',
  });
  assert.deepEqual(Object.keys(config).sort(), [
    'databaseUrl',
    'organizationId',
  ]);
});

test('ingress bounds source churn, concurrency and per-peer requests without unbounded storage', async () => {
  const { IngressLimiter } =
    await import('../src/infrastructure/auth/ingress.js');
  const limiter = new IngressLimiter();
  const instant = Date.now();
  for (let i = 0; i < 600; i++) {
    const gate = limiter.enter(`peer:${i}`, instant);
    assert.equal(gate.allowed, true);
    gate.release();
  }
  assert.equal(limiter.enter('new-peer', instant).allowed, false);
  const concurrency = new IngressLimiter();
  const slots = Array.from({ length: 16 }, (_, i) =>
    concurrency.enter(`peer:${i}`, instant),
  );
  assert.equal(concurrency.enter('extra', instant).allowed, false);
  for (const slot of slots) slot.release();
  const peers = new IngressLimiter();
  for (let i = 0; i < 120; i++) {
    const gate = peers.enter('same-peer', instant);
    assert.equal(gate.allowed, true);
    gate.release();
  }
  assert.equal(peers.enter('same-peer', instant).allowed, false);
});
