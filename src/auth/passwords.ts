import argon2 from 'argon2';
import { ValidationError } from '../http/errors.js';

export const ARGON2ID_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

export function validatePassword(
  password: string,
  email?: string | null,
): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      'Password must be at least 12 characters.',
    );
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      'Password must be at most 128 characters.',
    );
  }

  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    throw new ValidationError('Password cannot match the account email.');
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2ID_PARAMETERS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function isArgon2idHash(value: string): boolean {
  return value.startsWith('$argon2id$');
}
