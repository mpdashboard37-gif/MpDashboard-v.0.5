-- Adapt the pipeline to the existing CRM schema instead of creating duplicate tables.
-- This project already has: staff, leads, opportunities, follow_ups, lead_stage_history.
-- Add only the missing pipeline fields needed for role-aware sales tracking.

ALTER TABLE opportunities ADD COLUMN source TEXT;
ALTER TABLE opportunities ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium';
ALTER TABLE opportunities ADD COLUMN notes TEXT;

ALTER TABLE follow_ups ADD COLUMN opportunity_id TEXT;
UPDATE follow_ups SET opportunity_id = lead_id WHERE opportunity_id IS NULL;

ALTER TABLE follow_ups ADD COLUMN note TEXT;
UPDATE follow_ups SET note = notes WHERE note IS NULL;

-- Leave existing lead_stage_history in place; it is the real stage history table.
-- Keep the canonical lead/opportunity relationship via leads.id -> opportunities.lead_id.
