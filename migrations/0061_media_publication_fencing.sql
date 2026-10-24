-- Each claim gets a globally increasing token. Never reset this sequence.
CREATE SEQUENCE media_platform.fencing_tokens AS bigint;
ALTER TABLE media_platform.jobs ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0;
ALTER TABLE media_platform.assets
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN hls_generation bigint,
  ADD COLUMN playback_generation bigint;
ALTER TABLE media_platform.variants ADD COLUMN generation bigint;
CREATE INDEX media_variants_generation ON media_platform.variants(asset_id, generation);
-- Existing v1 variants are retained for legacy delivery, not adopted as v2 publications.
