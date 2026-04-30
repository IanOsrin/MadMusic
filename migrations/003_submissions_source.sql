-- Add source column to track where a submission came from
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
