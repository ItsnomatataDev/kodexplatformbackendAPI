-- Align payslip batch schema with the admin delivery surface and security checks.

ALTER TABLE documents.payslip_batches
  DROP CONSTRAINT IF EXISTS payslip_batches_status_check;

ALTER TABLE documents.payslip_batches
  ADD CONSTRAINT payslip_batches_status_check
  CHECK (status IN (
    'draft',
    'ready',
    'processing',
    'delivered',
    'partial_failed',
    'failed',
    'cancelled'
  ));

ALTER TABLE documents.payslip_batches
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE documents.payslip_batches
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE documents.payslip_batch_items
  ADD COLUMN IF NOT EXISTS employee_email TEXT;

ALTER TABLE documents.payslip_batch_items
  ADD COLUMN IF NOT EXISTS employee_name TEXT;

ALTER TABLE documents.payslip_batch_items
  ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE documents.payslip_batch_items
  ADD COLUMN IF NOT EXISTS match_status TEXT;

UPDATE documents.payslip_batch_items
SET match_status = COALESCE(match_status, status, 'unmatched')
WHERE match_status IS NULL;

ALTER TABLE documents.payslip_batch_items
  ALTER COLUMN match_status SET DEFAULT 'unmatched';

ALTER TABLE documents.payslip_batch_items
  ALTER COLUMN match_status SET NOT NULL;

ALTER TABLE documents.payslip_batch_items
  DROP CONSTRAINT IF EXISTS payslip_batch_items_status_check;

ALTER TABLE documents.payslip_batch_items
  DROP CONSTRAINT IF EXISTS payslip_batch_items_match_status_check;

ALTER TABLE documents.payslip_batch_items
  ADD CONSTRAINT payslip_batch_items_match_status_check
  CHECK (match_status IN (
    'pending',
    'matched',
    'unmatched',
    'duplicate',
    'delivered',
    'failed',
    'skipped'
  ));
