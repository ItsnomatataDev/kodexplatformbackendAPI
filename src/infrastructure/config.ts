import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
export type InfrastructureConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  origin: string;
  organizationId: string;
  tokenKey: Buffer;
  encryptionKeys: Record<string, Buffer>;
  activeKeyId: string;
  secure: boolean;
  idleSeconds: number;
  absoluteSeconds: number;
  freshSeconds: number;
  trustedProxyIps?: string[];
  challengeSeconds: number;
  now: () => Date;
};
export function readInfrastructureConfig(
  source = process.env,
): InfrastructureConfig {
  const required = (key: string) => {
    const value = source[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  if (source.INFRA_ENABLED !== 'true')
    throw new Error('Infrastructure runtime is disabled');
  const origin = new URL(required('INFRA_ORIGIN'));
  const dev = source.INFRA_LOCAL_HTTP === 'true';
  if (
    origin.origin !== required('INFRA_ORIGIN') ||
    (!dev && origin.protocol !== 'https:') ||
    (dev && !['localhost', '127.0.0.1'].includes(origin.hostname))
  )
    throw new Error('Invalid infrastructure origin');
  const secret = (name: string) =>
    source[`${name}_FILE`]
      ? readFileSync(source[`${name}_FILE`]!, 'utf8').trim()
      : required(name);
  const tokenKey = Buffer.from(secret('INFRA_TOKEN_KEY'), 'base64');
  const rawKeys = JSON.parse(secret('INFRA_MFA_KEYS')) as Record<
    string,
    string
  >;
  const encryptionKeys = Object.fromEntries(
    Object.entries(rawKeys).map(([id, key]) => [
      id,
      Buffer.from(key, 'base64'),
    ]),
  );
  const activeKeyId = required('INFRA_MFA_ACTIVE_KEY');
  if (
    tokenKey.length !== 32 ||
    !encryptionKeys[activeKeyId] ||
    Object.values(encryptionKeys).some(
      (k) => k.length !== 32 || k.equals(tokenKey),
    )
  )
    throw new Error('Distinct 32-byte infrastructure keys required');
  const seconds = (key: string, fallback: number) => {
    const n = Number(source[key] ?? fallback);
    if (!Number.isInteger(n) || n < 30 || n > 28800)
      throw new Error(`Invalid ${key}`);
    return n;
  };
  const organizationId = required('INFRA_ORGANIZATION_ID');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  )
    throw new Error('Invalid infrastructure organization');
  const host = source.INFRA_HOST ?? '127.0.0.1';
  if (dev && host !== '127.0.0.1')
    throw new Error('Local HTTP must bind loopback');
  const port = Number(source.INFRA_PORT ?? 3101);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid infrastructure port');
  const trustedProxyIps = (source.INFRA_TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (trustedProxyIps.some((ip) => !isIP(ip)))
    throw new Error('Trusted proxies must be exact IP addresses');
  return {
    trustedProxyIps,
    databaseUrl: required('INFRA_DATABASE_URL'),
    origin: origin.origin,
    host,
    port,
    organizationId,
    tokenKey,
    encryptionKeys,
    activeKeyId,
    secure: !dev,
    idleSeconds: seconds('INFRA_IDLE_SECONDS', 900),
    absoluteSeconds: seconds('INFRA_ABSOLUTE_SECONDS', 28800),
    freshSeconds: seconds('INFRA_FRESH_SECONDS', 300),
    challengeSeconds: 300,
    now: () => new Date(),
  };
}

// Provisioning has no session-signing or MFA encryption key dependency.
export type ProvisioningConfig = {
  databaseUrl: string;
  organizationId: string;
};
export function readProvisioningConfig(
  source = process.env,
): ProvisioningConfig {
  const databaseUrl = source.INFRA_PROVISION_DATABASE_URL;
  const organizationId = source.INFRA_ORGANIZATION_ID;
  if (
    !databaseUrl ||
    !organizationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  )
    throw new Error(
      'Dedicated provisioning database and organization required',
    );
  return { databaseUrl, organizationId };
}
