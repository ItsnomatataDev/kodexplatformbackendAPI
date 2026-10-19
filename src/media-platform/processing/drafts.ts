import { randomUUID } from 'node:crypto';
import type { MediaVariantDraftStore } from '../store.js';
import type { MediaVariant, UpsertMediaVariantInput, UpdateMediaVariantStatusInput } from '../types.js';

/** Private to one processing attempt; database publication happens only after all uploads finish. */
export class MediaVariantDrafts implements MediaVariantDraftStore {
  private readonly variants = new Map<string, MediaVariant>();
  constructor(private readonly generation: string) {}
  async upsertVariant(input: UpsertMediaVariantInput): Promise<MediaVariant> {
    const existing = this.variants.get(input.objectKey);
    const result: MediaVariant = {
      ...input, id: existing?.id ?? randomUUID(), generation: this.generation,
      width: input.width ?? null, height: input.height ?? null, bitrateBps: input.bitrateBps ?? null,
      codec: input.codec ?? null, container: input.container ?? null, sizeBytes: input.sizeBytes ?? null,
      createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date(),
    };
    this.variants.set(input.objectKey,result);
    return result;
  }
  async updateVariantStatus(input: UpdateMediaVariantStatusInput): Promise<MediaVariant | null> {
    const value = [...this.variants.values()].find(v=>v.id===input.variantId);
    if (!value) return null;
    value.status=input.status;
    return value;
  }
  ready(): UpsertMediaVariantInput[] {
    const variants = [...this.variants.values()];
    if (!variants.length || variants.some(v=>v.status!=='ready')) throw new Error('media_publication_incomplete');
    return variants;
  }
}
