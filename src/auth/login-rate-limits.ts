import type { AppEnvironment } from '../config/environments.js';

export type LoginRateLimitPolicy = {
  ipLimit: number;
  emailLimit: number;
  windowSeconds: number;
};

/**
 * Auth login rate limits.
 * Email quota is counted only on failed password attempts (not successful logins).
 */
export function loginRateLimits(appEnv: AppEnvironment): LoginRateLimitPolicy {
  if (appEnv === 'development') {
    return {
      ipLimit: 300,
      emailLimit: 50,
      windowSeconds: 300,
    };
  }

  // staging + production: stricter, but allow realistic mistypes
  return {
    ipLimit: 60,
    emailLimit: 12,
    windowSeconds: 900,
  };
}
