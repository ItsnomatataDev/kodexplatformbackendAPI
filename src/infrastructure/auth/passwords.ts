import argon2 from 'argon2';
export function validateInfrastructurePassword(
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length < 15 || value.length > 128)
    throw new Error('Password must contain 15–128 characters');
}
// Bound memory-hard operations independently of connection pooling; no unbounded work queue.
let hashing = 0;
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (hashing >= 2) throw new Error('Authentication capacity unavailable');
  hashing++;
  try {
    return await work();
  } finally {
    hashing--;
  }
}
export const hashPassword = (value: string) =>
  bounded(() =>
    argon2.hash(value, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    }),
  );
export const verifyPassword = async (hash: string, value: string) =>
  bounded(async () => {
    if (value.length > 128) return false;
    try {
      return await argon2.verify(hash, value);
    } catch {
      return false;
    }
  });
