import type { AppEnvironment } from './environments.js';
import {
  isPlaceholderSecret,
  rejectKnownDevelopmentSecret,
} from './infrastructure-security.js';

export const emailProviders = ['unconfigured', 'smtp'] as const;
export type EmailProvider = (typeof emailProviders)[number];

export type UnconfiguredEmailDeliveryConfig = {
  provider: 'unconfigured';
};

export type SmtpEmailDeliveryConfig = {
  provider: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
};

export type EmailDeliveryConfig =
  | UnconfiguredEmailDeliveryConfig
  | SmtpEmailDeliveryConfig;

export type EmailDeliveryGuardInput = {
  appEnv: AppEnvironment;
  localInfrastructure: boolean;
  email: EmailDeliveryConfig;
};

function optional(env: NodeJS.Dict<string>, name: string): string {
  return env[name]?.trim() ?? '';
}

function requiredWhenSmtp(env: NodeJS.Dict<string>, name: string): string {
  const value = optional(env, name);

  if (!value) {
    throw new Error(`${name} is required when EMAIL_PROVIDER=smtp.`);
  }

  return value;
}

function smtpPortFromEnv(env: NodeJS.Dict<string>): number {
  const raw = optional(env, 'SMTP_PORT');
  const port = raw ? Number(raw) : 587;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port.');
  }

  return port;
}

function smtpSecureFromEnv(env: NodeJS.Dict<string>, port: number): boolean {
  const raw = optional(env, 'SMTP_SECURE');

  if (!raw) {
    return port === 465;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error('SMTP_SECURE must be true or false.');
}

function parseProvider(env: NodeJS.Dict<string>): EmailProvider {
  const raw = optional(env, 'EMAIL_PROVIDER').toLowerCase();

  if (!raw || raw === 'unconfigured') {
    return 'unconfigured';
  }

  if (raw === 'smtp') {
    return 'smtp';
  }

  throw new Error('EMAIL_PROVIDER must be unconfigured or smtp.');
}

export function parseEmailDeliveryConfig(
  env: NodeJS.Dict<string> = process.env,
): EmailDeliveryConfig {
  const provider = parseProvider(env);

  if (provider === 'unconfigured') {
    return { provider };
  }

  const port = smtpPortFromEnv(env);

  return {
    provider: 'smtp',
    host: requiredWhenSmtp(env, 'SMTP_HOST'),
    port,
    secure: smtpSecureFromEnv(env, port),
    username: requiredWhenSmtp(env, 'SMTP_USERNAME'),
    password: requiredWhenSmtp(env, 'SMTP_PASSWORD'),
    from: requiredWhenSmtp(env, 'SMTP_FROM'),
  };
}

export function emailDeliveryIsRequired(
  appEnv: AppEnvironment,
  localInfrastructure: boolean,
): boolean {
  if (appEnv === 'production') {
    return true;
  }

  return appEnv === 'staging' && !localInfrastructure;
}

export function assertEmailDeliveryConfigured(
  input: EmailDeliveryGuardInput,
): void {
  const required = emailDeliveryIsRequired(
    input.appEnv,
    input.localInfrastructure,
  );

  if (required && input.email.provider !== 'smtp') {
    throw new Error(
      input.appEnv === 'production'
        ? 'Production requires EMAIL_PROVIDER=smtp.'
        : 'Remote staging requires EMAIL_PROVIDER=smtp.',
    );
  }

  if (input.email.provider !== 'smtp') {
    return;
  }

  if (isPlaceholderSecret(input.email.password)) {
    throw new Error('SMTP_PASSWORD must be set to a non-placeholder secret.');
  }

  if (isPlaceholderSecret(input.email.username)) {
    throw new Error('SMTP_USERNAME must be set to a non-placeholder secret.');
  }

  if (input.appEnv === 'development') {
    return;
  }

  rejectKnownDevelopmentSecret('SMTP_USERNAME', input.email.username);
  rejectKnownDevelopmentSecret('SMTP_PASSWORD', input.email.password);
  rejectKnownDevelopmentSecret('SMTP_HOST', input.email.host);
  rejectKnownDevelopmentSecret('SMTP_FROM', input.email.from);
}
