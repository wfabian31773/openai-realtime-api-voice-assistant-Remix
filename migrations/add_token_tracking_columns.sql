-- Migration: Add token tracking columns to call_logs for accurate OpenAI cost calculation
-- Run this against the PRODUCTION database (Supabase)
-- Date: 2026-01-10

-- Add token tracking columns (all nullable to support existing records)
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS input_audio_tokens INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS output_audio_tokens INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS input_text_tokens INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS output_text_tokens INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS input_cached_tokens INTEGER;

-- Add cost estimation tracking
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cost_is_estimated BOOLEAN DEFAULT true;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cost_reconciled_at TIMESTAMP;

-- Verify columns were added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'call_logs' 
AND column_name IN (
  'input_audio_tokens', 
  'output_audio_tokens', 
  'input_text_tokens', 
  'output_text_tokens', 
  'input_cached_tokens', 
  'cost_is_estimated', 
  'cost_reconciled_at'
);
