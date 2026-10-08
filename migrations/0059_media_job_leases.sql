BEGIN;

ALTER TABLE media_platform.jobs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS media_platform_jobs_expired_lease_idx
  ON media_platform.jobs (lease_expires_at)
  WHERE status = 'processing';

COMMENT ON COLUMN media_platform.jobs.lease_owner IS
  'Identifier of the worker instance currently processing the job.';

COMMENT ON COLUMN media_platform.jobs.lease_expires_at IS
  'Processing lease expiry. Active workers extend this periodically. Expired leases may be recovered.';

COMMIT;
