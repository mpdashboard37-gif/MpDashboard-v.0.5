-- Supabase PostgreSQL schema for the CRM.
-- Apply this only to a new/empty Supabase project. Do not run against crm.sqlite.
-- The application connects server-side with DATABASE_URL; frontend code never connects directly.

CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    department TEXT,
    designation TEXT,
    login_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Active',
    account_status TEXT NOT NULL DEFAULT 'ACTIVE',
    manager_id TEXT REFERENCES staff(id),
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    deactivated_at TIMESTAMPTZ,
    deactivation_reason TEXT,
    blocked_until TIMESTAMPTZ,
    reactivated_at TIMESTAMPTZ,
    reactivated_by TEXT REFERENCES staff(id),
    last_login_at TIMESTAMPTZ,
    last_logout_at TIMESTAMPTZ,
    auth_method TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
    request_data JSONB NOT NULL DEFAULT '{}'::jsonb, password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ, approved_by TEXT REFERENCES staff(id), rejected_at TIMESTAMPTZ,
    rejected_by TEXT REFERENCES staff(id), rejection_reason TEXT, eligible_again_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    user_json JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    lead_number TEXT UNIQUE,
    customer_name TEXT NOT NULL,
    mobile_number TEXT NOT NULL UNIQUE,
    email TEXT,
    lead_date DATE NOT NULL,
    lead_source TEXT NOT NULL,
    assigned_to TEXT REFERENCES staff(id),
    stage TEXT NOT NULL,
    priority TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    details_json JSONB,
    created_by TEXT NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS follow_ups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    due_at TIMESTAMPTZ NOT NULL,
    type TEXT NOT NULL,
    assigned_to TEXT NOT NULL REFERENCES staff(id),
    status TEXT NOT NULL DEFAULT 'Pending',
    task_status TEXT NOT NULL DEFAULT 'PENDING',
    task_title TEXT,
    notes TEXT,
    outcome TEXT,
    missed_reason TEXT,
    completed_at TIMESTAMPTZ,
    completed_by TEXT REFERENCES staff(id),
    task_completed_at TIMESTAMPTZ,
    task_completed_by TEXT REFERENCES staff(id),
    task_related_type TEXT,
    task_related_id TEXT,
    created_by TEXT NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_activities (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    user_id TEXT REFERENCES staff(id),
    related_record_type TEXT,
    related_record_id TEXT,
    previous_value TEXT,
    new_value TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_stage_history (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
    completed_by TEXT REFERENCES staff(id), duration_seconds INTEGER, remarks TEXT
);

CREATE TABLE IF NOT EXISTS opportunities (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL, system_capacity TEXT, estimated_value NUMERIC NOT NULL DEFAULT 0,
    assigned_to TEXT REFERENCES staff(id), expected_close_date DATE, probability NUMERIC NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'Qualified', lost_reason TEXT, status TEXT NOT NULL DEFAULT 'Active',
    closing_date DATE, closing_value NUMERIC, closing_remarks TEXT,
    created_by TEXT NOT NULL REFERENCES staff(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    survey_id TEXT, amount NUMERIC NOT NULL DEFAULT 0, discount NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Draft', created_by TEXT NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    survey_date TIMESTAMPTZ NOT NULL, assigned_to TEXT NOT NULL REFERENCES staff(id), customer TEXT NOT NULL,
    address TEXT NOT NULL, sanctioned_load TEXT NOT NULL, electricity_details TEXT NOT NULL, roof_information TEXT NOT NULL,
    feasibility TEXT, recommended_capacity TEXT NOT NULL, remarks TEXT, survey_type TEXT,
    status TEXT NOT NULL DEFAULT 'Scheduled', completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT, message TEXT NOT NULL, record_type TEXT, record_id TEXT,
    read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY, product TEXT NOT NULL UNIQUE, sku TEXT UNIQUE, category TEXT, subcategory TEXT,
    brand TEXT, model TEXT, specification TEXT, unit TEXT NOT NULL DEFAULT 'unit',
    purchase_price NUMERIC NOT NULL DEFAULT 0, selling_price NUMERIC NOT NULL DEFAULT 0,
    opening_stock NUMERIC NOT NULL DEFAULT 0, total_stock NUMERIC NOT NULL DEFAULT 0,
    available_stock NUMERIC NOT NULL DEFAULT 0, reserved_stock NUMERIC NOT NULL DEFAULT 0,
    issued_stock NUMERIC NOT NULL DEFAULT 0, damaged_stock NUMERIC NOT NULL DEFAULT 0,
    returned_stock NUMERIC NOT NULL DEFAULT 0, minimum_stock NUMERIC NOT NULL DEFAULT 0,
    maximum_stock NUMERIC NOT NULL DEFAULT 0, reorder_level NUMERIC NOT NULL DEFAULT 0,
    warehouse TEXT, rack_bin TEXT, supplier TEXT, warranty_information TEXT,
    requires_serial BOOLEAN NOT NULL DEFAULT false, requires_batch BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'Active', created_by TEXT REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_assigned_to_idx ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS follow_ups_lead_due_idx ON follow_ups(lead_id, due_at);
CREATE INDEX IF NOT EXISTS follow_ups_pending_due_idx ON follow_ups(due_at) WHERE task_status IN ('PENDING', 'OVERDUE');
CREATE INDEX IF NOT EXISTS activities_lead_created_idx ON lead_activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS surveys_status_date_idx ON surveys(status, survey_date);

-- proposals references surveys, so the relationship is added after both tables exist.
DO $$ BEGIN
    ALTER TABLE proposals ADD CONSTRAINT proposals_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES surveys(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The current CRM stores actionable tasks in follow_ups. This view exposes task-shaped
-- columns for integrations without creating a second task storage system.
CREATE OR REPLACE VIEW tasks AS
SELECT id, lead_id, assigned_to, task_title AS title, notes AS description,
       due_at::date AS due_date, due_at::time AS due_time, NULL::text AS priority,
       task_status AS status, task_completed_at AS completed_at, created_at, updated_at
FROM follow_ups;
