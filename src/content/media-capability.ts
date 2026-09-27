import { createHash, randomBytes } from 'node:crypto';

export type MediaCapability = { organizationId: string; objectKey: string };

const TTL_MS = 60_000;

/** Process-local, opaque capabilities. They are deliberately short lived and object scoped. */
export class MediaCapabilityStore {
  private readonly entries = new Map<string, { value: MediaCapability; expiresAt: number }>();

  issue(value: MediaCapability, ttlMs = TTL_MS) {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    this.entries.set(this.key(token), { value, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consume(token: string): MediaCapability | null {
    this.prune();
    const key = this.key(token);
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private key(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export const mediaCapabilityStore = new MediaCapabilityStore();
