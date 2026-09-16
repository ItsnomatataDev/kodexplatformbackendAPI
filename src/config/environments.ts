export const allowedEnvironments = [
  'development',
  'staging',
  'production',
] as const;

export type AppEnvironment = (typeof allowedEnvironments)[number];

export function isAppEnvironment(value: string): value is AppEnvironment {
  return allowedEnvironments.includes(value as AppEnvironment);
}

export function parseAppEnvironment(
  value: string | undefined,
): AppEnvironment {
  if (!value) {
    throw new Error(
      'APP_ENV is required and must be one of: development, staging, production.',
    );
  }

  if (!isAppEnvironment(value)) {
    throw new Error(
      `APP_ENV must be one of: ${allowedEnvironments.join(', ')}. Received: ${value}`,
    );
  }

  return value;
}
