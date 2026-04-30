ALTER TABLE submissions ADD COLUMN IF NOT EXISTS format_flag TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS format_override_reason TEXT;
