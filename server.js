const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const FILE_STORAGE_ROOT = path.join(ROOT, 'crm-files');
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword']);
const database = new DatabaseSync(path.join(ROOT, 'crm.sqlite'));
const sessions = new Map();
const sessionExpiries = new Map();
const googleStates = new Map();
const GOOGLE_ADMIN_EMAIL = 'luckyun269@gmail.com';
const STAGES = ['New', 'Working', 'Nurturing', 'Opportunity', 'Site Survey Scheduled', 'Site Survey Completed', 'Order Booked', 'Loan Process', 'Completed', 'Lost'];
const LEGACY_STAGE_MAP = { 'New Lead': 'New', Contacted: 'Working', Interested: 'Working', 'Follow-up': 'Nurturing', 'Survey Scheduled': 'Site Survey Scheduled', 'Survey Completed': 'Site Survey Completed', 'Proposal Sent': 'Opportunity', Negotiation: 'Opportunity', Booking: 'Order Booked', Installation: 'Order Booked', BESCOM: 'Order Booked', Commissioned: 'Order Booked' };
const ACTIVE_STAGE_FLOW = ['New', 'Working', 'Nurturing', 'Opportunity', 'Site Survey Scheduled', 'Site Survey Completed', 'Order Booked', 'Loan Process', 'Completed'];
const FOLLOW_UP_TYPES = ['Call', 'WhatsApp', 'Meeting', 'Site Visit', 'Proposal Discussion', 'Payment Follow-up', 'Other'];
const FOLLOW_UP_STATUSES = ['Pending', 'Completed', 'Rescheduled', 'Cancelled', 'Overdue'];
const ROLE_ACCESS = {
    'Admin/Owner': 'all',
    'Sales Manager': 'team',
    'GM/AGM': 'all',
    'Sales Executive': 'own',
    'Telecaller': 'own'
};

function hashPassword(value) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(String(value || ''), salt, 64).toString('hex');
    return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(value, storedHash) {
    const stored = String(storedHash || '');
    if (stored.startsWith('scrypt$')) {
        const [, salt, expected] = stored.split('$');
        if (!salt || !expected) return false;
        const actual = crypto.scryptSync(String(value || ''), salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
    }
    return crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(String(value || '')).digest('hex')), Buffer.from(stored));
}

function now() {
    return new Date().toISOString();
}

function initializeDatabase() {
    database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS staff (
            id TEXT PRIMARY KEY, employee_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            department TEXT, designation TEXT, login_id TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active',
            account_status TEXT NOT NULL DEFAULT 'ACTIVE', failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            deactivated_at TEXT, deactivation_reason TEXT, blocked_until TEXT, reactivated_at TEXT, reactivated_by TEXT,
            manager_id TEXT REFERENCES staff(id), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id),
            expires_at TEXT NOT NULL, used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, mobile_number TEXT NOT NULL UNIQUE,
            email TEXT, lead_date TEXT NOT NULL, lead_source TEXT NOT NULL, assigned_to TEXT,
            stage TEXT NOT NULL, priority TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'Active',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS follow_ups (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), due_at TEXT NOT NULL,
            type TEXT NOT NULL, assigned_to TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
            notes TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS surveys (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), survey_date TEXT NOT NULL,
            assigned_to TEXT NOT NULL, customer TEXT NOT NULL, address TEXT NOT NULL, sanctioned_load TEXT NOT NULL,
            electricity_details TEXT NOT NULL, roof_information TEXT NOT NULL, feasibility TEXT,
            recommended_capacity TEXT NOT NULL, remarks TEXT, status TEXT NOT NULL DEFAULT 'Scheduled', completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS survey_files (
            id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id), lead_id TEXT NOT NULL REFERENCES leads(id),
            category TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0,
            file_data TEXT, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, latitude TEXT, longitude TEXT
        );
        CREATE TABLE IF NOT EXISTS proposals (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), survey_id TEXT NOT NULL REFERENCES surveys(id),
            amount REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), proposal_id TEXT REFERENCES proposals(id),
            status TEXT NOT NULL DEFAULT 'Booked', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), total_amount REAL NOT NULL,
            paid_amount REAL NOT NULL DEFAULT 0, payment_date TEXT, notes TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS opportunities (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), customer_name TEXT NOT NULL,
            system_capacity TEXT, estimated_value REAL NOT NULL DEFAULT 0, assigned_to TEXT, expected_close_date TEXT,
            probability REAL NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'Qualified', lost_reason TEXT,
            status TEXT NOT NULL DEFAULT 'Active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookings (
            id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL UNIQUE REFERENCES opportunities(id), lead_id TEXT NOT NULL REFERENCES leads(id),
            total_amount REAL NOT NULL DEFAULT 0, booking_amount REAL NOT NULL DEFAULT 0, booking_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Confirmed', created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS installations (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id), status TEXT NOT NULL DEFAULT 'Pending',
            installation_date TEXT, team TEXT, materials TEXT, completion_report TEXT, remarks TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS commissioning (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id), status TEXT NOT NULL DEFAULT 'Documentation Pending',
            application_number TEXT, inspection_date TEXT, meter_status TEXT, commissioning_date TEXT, remarks TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), invoice_number TEXT NOT NULL UNIQUE,
            total_amount REAL NOT NULL DEFAULT 0, gst REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Unpaid', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory (
            id TEXT PRIMARY KEY, product TEXT NOT NULL UNIQUE, opening_stock REAL NOT NULL DEFAULT 0,
            available_stock REAL NOT NULL DEFAULT 0, low_stock_threshold REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), project_id TEXT,
            action TEXT NOT NULL, quantity REAL NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_categories (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, parent_name TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), action TEXT NOT NULL,
            quantity REAL NOT NULL, previous_stock REAL NOT NULL, new_stock REAL NOT NULL, user_id TEXT NOT NULL,
            reference_id TEXT, project_id TEXT, lead_id TEXT, batch_number TEXT, serial_numbers TEXT,
            warehouse TEXT, remarks TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_reservations (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), project_id TEXT,
            lead_id TEXT, order_id TEXT, quantity REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Reserved',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
        );
        CREATE TABLE IF NOT EXISTS material_requests (
            id TEXT PRIMARY KEY, project_id TEXT, lead_id TEXT, order_id TEXT, installation_date TEXT,
            requested_by TEXT NOT NULL, department TEXT, required_date TEXT, priority TEXT NOT NULL DEFAULT 'Medium',
            remarks TEXT, status TEXT NOT NULL DEFAULT 'Draft', rejection_reason TEXT, approved_by TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS material_request_items (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES material_requests(id), inventory_id TEXT NOT NULL REFERENCES inventory(id),
            required_quantity REAL NOT NULL, reserved_quantity REAL NOT NULL DEFAULT 0, issued_quantity REAL NOT NULL DEFAULT 0,
            returned_quantity REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS project_materials (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, lead_id TEXT, order_id TEXT, inventory_id TEXT NOT NULL REFERENCES inventory(id),
            required_quantity REAL NOT NULL, reserved_quantity REAL NOT NULL DEFAULT 0, issued_quantity REAL NOT NULL DEFAULT 0,
            returned_quantity REAL NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(project_id, inventory_id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL,
            record_type TEXT NOT NULL, record_id TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_stage_history (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), stage TEXT NOT NULL,
            started_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT, duration_seconds INTEGER,
            remarks TEXT
        );
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
            record_type TEXT, record_id TEXT, read_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_documents (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), document_type TEXT NOT NULL,
            file_name TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_notes (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), note TEXT NOT NULL,
            category TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quotations (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), proposal_id TEXT,
            subtotal REAL NOT NULL, discount REAL NOT NULL, gst REAL NOT NULL, total REAL NOT NULL,
            payment_terms TEXT, validity TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_communications (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), type TEXT NOT NULL,
            recipient TEXT, subject TEXT, message TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_activities (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), activity_type TEXT NOT NULL,
            title TEXT NOT NULL, description TEXT, user_id TEXT, related_record_type TEXT,
            related_record_id TEXT, previous_value TEXT, new_value TEXT, created_at TEXT NOT NULL
        );
    `);
    fs.mkdirSync(FILE_STORAGE_ROOT, { recursive: true });
    ['storage_path TEXT', 'original_file_name TEXT', 'mime_type TEXT', 'file_size INTEGER NOT NULL DEFAULT 0', "status TEXT NOT NULL DEFAULT 'UPLOADED'"].forEach((column) => { try { database.exec(`ALTER TABLE lead_documents ADD COLUMN ${column}`); } catch (error) { } });
    ['storage_path TEXT', 'original_file_name TEXT', "status TEXT NOT NULL DEFAULT 'UPLOADED'"].forEach((column) => { try { database.exec(`ALTER TABLE survey_files ADD COLUMN ${column}`); } catch (error) { } });
    database.prepare("SELECT id, file_name AS fileName, mime_type AS mimeType, file_size AS fileSize, file_data AS fileData FROM survey_files WHERE storage_path IS NULL AND file_data IS NOT NULL").all().forEach((file) => {
        try { const stored = saveUploadedFile(file); database.prepare("UPDATE survey_files SET storage_path = ?, original_file_name = ?, mime_type = ?, file_size = ?, status = 'UPLOADED', file_data = NULL WHERE id = ?").run(stored.storagePath, stored.originalFileName, stored.mimeType, stored.fileSize, file.id); } catch (error) { database.prepare("UPDATE survey_files SET status = 'FAILED' WHERE id = ?").run(file.id); }
    });
    try { database.exec('ALTER TABLE leads ADD COLUMN details_json TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN google_email TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN email TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN locked_until TEXT'); } catch (error) { }
    try { database.exec("ALTER TABLE staff ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ACTIVE'"); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN deactivated_at TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN deactivation_reason TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN blocked_until TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN reactivated_at TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN reactivated_by TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN last_login_at TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN last_logout_at TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE staff ADD COLUMN auth_method TEXT'); } catch (error) { }
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS staff_google_email_unique ON staff (google_email) WHERE google_email IS NOT NULL'); } catch (error) { }
    database.prepare("UPDATE staff SET account_status = CASE WHEN status = 'Active' THEN 'ACTIVE' ELSE 'DEACTIVATED' END WHERE account_status IS NULL OR account_status = ''").run();
    database.prepare("UPDATE staff SET google_email = ? WHERE login_id = 'admin' AND (google_email IS NULL OR google_email = '')").run(GOOGLE_ADMIN_EMAIL);
    try { database.exec('ALTER TABLE leads ADD COLUMN lead_number TEXT'); } catch (error) { }
    const leadsWithoutNumber = database.prepare("SELECT id FROM leads WHERE lead_number IS NULL OR lead_number NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' ORDER BY datetime(created_at), id").all();
    const assignLeadNumber = database.prepare('UPDATE leads SET lead_number = ? WHERE id = ?');
    leadsWithoutNumber.forEach((lead, index) => assignLeadNumber.run(String(100001 + index), lead.id));
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_lead_number_unique ON leads(lead_number)'); } catch (error) { }
    try { database.exec('ALTER TABLE opportunities ADD COLUMN closing_date TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE opportunities ADD COLUMN closing_value REAL'); } catch (error) { }
    try { database.exec('ALTER TABLE opportunities ADD COLUMN closing_remarks TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN survey_type TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN latitude TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN longitude TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN location_accuracy TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN location_captured_at TEXT'); } catch (error) { }
    try { database.exec('ALTER TABLE surveys ADD COLUMN completion_data_json TEXT'); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN completed_at TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN completed_by TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN outcome TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN missed_reason TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_title TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_status TEXT NOT NULL DEFAULT 'PENDING'"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_completed_at TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_completed_by TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_related_type TEXT"); } catch (error) { }
    try { database.exec("ALTER TABLE follow_ups ADD COLUMN task_related_id TEXT"); } catch (error) { }
    database.prepare("UPDATE follow_ups SET task_title = CASE type WHEN 'WhatsApp' THEN 'WhatsApp follow-up with customer' WHEN 'Call' THEN 'Call customer regarding solar proposal' WHEN 'Site Visit' THEN 'Site visit with customer' WHEN 'Meeting' THEN 'Meeting with customer' WHEN 'Proposal Discussion' THEN 'Follow up on quotation' WHEN 'Payment Follow-up' THEN 'Follow up on payment' ELSE 'Follow up with customer' END WHERE task_title IS NULL OR task_title = ''").run();
    database.prepare("UPDATE follow_ups SET task_status = CASE WHEN status = 'Completed' THEN 'COMPLETED' WHEN status = 'Cancelled' THEN 'CANCELLED' WHEN datetime(due_at) < datetime('now') THEN 'OVERDUE' ELSE 'PENDING' END").run();
    const inventoryColumns = [
        ['sku', 'TEXT'], ['category', 'TEXT'], ['subcategory', 'TEXT'], ['brand', 'TEXT'], ['model', 'TEXT'],
        ['specification', 'TEXT'], ['unit', "TEXT NOT NULL DEFAULT 'unit'"], ['purchase_price', 'REAL NOT NULL DEFAULT 0'],
        ['selling_price', 'REAL NOT NULL DEFAULT 0'], ['minimum_stock', 'REAL NOT NULL DEFAULT 0'], ['maximum_stock', 'REAL NOT NULL DEFAULT 0'],
        ['reorder_level', 'REAL NOT NULL DEFAULT 0'], ['total_stock', 'REAL NOT NULL DEFAULT 0'], ['reserved_stock', 'REAL NOT NULL DEFAULT 0'],
        ['issued_stock', 'REAL NOT NULL DEFAULT 0'], ['damaged_stock', 'REAL NOT NULL DEFAULT 0'], ['returned_stock', 'REAL NOT NULL DEFAULT 0'],
        ['warehouse', 'TEXT'], ['rack_bin', 'TEXT'], ['supplier', 'TEXT'], ['warranty_information', 'TEXT'],
        ['requires_serial', 'INTEGER NOT NULL DEFAULT 0'], ['requires_batch', 'INTEGER NOT NULL DEFAULT 0'],
        ['status', "TEXT NOT NULL DEFAULT 'Active'"], ['created_by', 'TEXT']
    ];
    inventoryColumns.forEach(([name, definition]) => { try { database.exec(`ALTER TABLE inventory ADD COLUMN ${name} ${definition}`); } catch (error) { } });
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS inventory_sku_unique ON inventory(sku) WHERE sku IS NOT NULL'); } catch (error) { }
    database.prepare("UPDATE inventory SET total_stock = CASE WHEN total_stock = 0 THEN opening_stock ELSE total_stock END, available_stock = CASE WHEN available_stock = 0 THEN opening_stock ELSE available_stock END WHERE total_stock = 0 OR available_stock = 0").run();
    database.prepare("UPDATE follow_ups SET status = 'Scheduled' WHERE status = 'Pending'").run();
    database.prepare('UPDATE leads SET stage = ? WHERE stage = ?').run('New', 'New Lead');
    Object.entries(LEGACY_STAGE_MAP).forEach(([legacy, current]) => database.prepare('UPDATE leads SET stage = ? WHERE stage = ?').run(current, legacy));
    const leadsWithoutHistory = database.prepare('SELECT id, stage, created_at FROM leads WHERE id NOT IN (SELECT lead_id FROM lead_stage_history)').all();
    const insertInitialHistory = database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at) VALUES (?, ?, ?, ?)');
    leadsWithoutHistory.forEach((lead) => insertInitialHistory.run(crypto.randomUUID(), lead.id, lead.stage, lead.created_at));
    const admin = database.prepare('SELECT id FROM staff WHERE login_id = ?').get('admin');
    if (!admin) {
        database.prepare(`INSERT INTO staff (id, employee_id, name, department, designation, login_id, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('staff-admin', 'EMP-001', 'Owner Admin', 'Administration', 'Owner', 'admin', hashPassword('admin123'), 'Admin/Owner', now());
    }
    const seedLeads = [
        ['INP-1001', 'Robert Fox', '+1 (555) 110-2345', 'robert.fox@gmail.com', '2026-08-01', 'Website', 'Rahul Verma', 'New Lead', 'High', 'Bangalore'],
        ['INP-1002', 'Jane Cooper', '+1 (555) 301-1188', 'jane.cooper@gmail.com', '2026-08-02', 'Referral', 'Neha Sharma', 'Contacted', 'Medium', 'Hyderabad'],
        ['INP-1003', 'Cody Fisher', '+1 (555) 224-5678', 'cody.fisher@gmail.com', '2026-08-03', 'Google Ads', 'Rahul Verma', 'Follow-up', 'High', 'Chennai'],
        ['INP-1004', 'Global Tech Inc.', '+1 (555) 900-1100', 'hello@globaltech.com', '2026-08-02', 'Outbound', 'Amit Nair', 'Proposal Sent', 'High', 'Pune'],
        ['INP-1005', 'Solar Solutions', '+1 (555) 900-2200', 'sales@solarsolutions.com', '2026-08-04', 'Inbound', 'Priya Shah', 'Survey Scheduled', 'Medium', 'Delhi'],
        ['INP-1006', 'Green Valley Estate', '+1 (617) 555-7661', 'greenvalley@gmail.com', '2026-08-05', 'Walk-in', 'Karan Iyer', 'Negotiation', 'High', 'Coimbatore'],
        ['INP-1007', 'Alex Thorne', '+1 (555) 012-3456', 'alex@thorne.com', '2026-08-06', 'Social Media', 'Neha Sharma', 'Interested', 'Low', 'Mumbai'],
        ['INP-1008', 'Sarah Jenkins', '+1 (555) 098-7654', 'sarah.jenkins@gmail.com', '2026-08-07', 'Website', 'Rahul Verma', 'Booking', 'High', 'Jaipur'],
        ['INP-1009', 'Michael Chen', '+1 (555) 234-5678', 'michael.chen@gmail.com', '2026-08-08', 'Referral', 'Priya Shah', 'Completed', 'High', 'Kochi'],
        ['INP-1010', 'North Ridge Homes', '+1 (702) 555-3344', 'north.ridge@example.com', '2026-08-09', 'Outbound', 'Karan Iyer', 'Lost', 'Medium', 'Visakhapatnam'],
        ['INP-1011', 'Harbor Logistics', '+1 (510) 555-6123', 'info@harborlogistics.com', '2026-08-10', 'Inbound', 'Amit Nair', 'Lost', 'Low', 'Vijayawada']
    ];
    const insertLead = database.prepare(`INSERT OR IGNORE INTO leads (id, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    seedLeads.forEach(([id, name, mobile, email, date, source, assignedTo, stage, priority, location]) => insertLead.run(id, name, mobile, email, date, source, 'staff-admin', stage, priority, location, 'staff-admin', date, date));
    const relatedTables = { 'follow-up': 'follow_ups', opportunity: 'opportunities', project: 'projects', survey: 'surveys', proposal: 'proposals', quotation: 'quotations', document: 'lead_documents', note: 'lead_notes', communication: 'lead_communications' };
    const oldEvents = database.prepare('SELECT a.*, s.name AS user_name FROM audit_logs a LEFT JOIN staff s ON s.id = a.user_id ORDER BY a.id').all();
    const insertActivity = database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    oldEvents.forEach((event) => {
        let leadId = event.record_type === 'lead' ? event.record_id : null;
        if (!leadId && relatedTables[event.record_type]) leadId = database.prepare(`SELECT lead_id AS id FROM ${relatedTables[event.record_type]} WHERE id = ?`).get(event.record_id)?.id;
        if (!leadId || !database.prepare('SELECT id FROM leads WHERE id = ?').get(leadId)) return;
        let details = {}; try { details = event.details ? JSON.parse(event.details) : {}; } catch (error) { details = {}; }
        const title = event.action === 'Created' && event.record_type === 'lead' ? 'Lead Created' : event.action;
        const exists = database.prepare('SELECT id FROM lead_activities WHERE related_record_type = ? AND related_record_id = ? AND title = ? LIMIT 1').get(event.record_type, event.record_id, title);
        if (!exists) insertActivity.run(crypto.randomUUID(), leadId, event.record_type === 'follow-up' ? 'Follow-ups' : event.record_type === 'communication' ? 'Communication' : event.record_type === 'lead' ? 'Lead' : event.record_type.charAt(0).toUpperCase() + event.record_type.slice(1), title, details.description || JSON.stringify(details), event.user_id, event.record_type, event.record_id, details.previous || details.previousStage || details.previousStatus || null, details.next || details.newStage || details.newStatus || null, event.created_at);
    });
}

function json(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    response.end(JSON.stringify(payload));
    return true;
}

function redirect(response, location) {
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    response.end();
    return true;
}

function parseBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk) => body += chunk);
        request.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error('Invalid JSON body.')); }
        });
        request.on('error', reject);
    });
}

function saveUploadedFile(file) {
    const fileName = String(file?.fileName || '').trim();
    const mimeType = String(file?.mimeType || '').toLowerCase();
    const fileData = String(file?.fileData || '');
    if (!fileName || fileName.length > 255 || /[\\/\0]/.test(fileName)) throw new Error('Invalid file name.');
    if (!ALLOWED_FILE_TYPES.has(mimeType)) throw new Error('Unsupported file type.');
    const match = fileData.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1].toLowerCase() !== mimeType) throw new Error('The uploaded file data is invalid.');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error('File size must be between 1 byte and 100 MB.');
    const storagePath = `${crypto.randomUUID()}${path.extname(fileName).toLowerCase()}`;
    fs.writeFileSync(path.join(FILE_STORAGE_ROOT, storagePath), buffer, { flag: 'wx' });
    return { storagePath, originalFileName: fileName, mimeType, fileSize: buffer.length };
}

function removeStoredFile(storagePath) {
    if (storagePath) { try { fs.unlinkSync(path.join(FILE_STORAGE_ROOT, storagePath)); } catch (error) { } }
}

function currentUser(request) {
    const authorizationToken = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const cookies = String(request.headers.cookie || '').split(';').map((cookie) => cookie.trim());
    const cookieToken = cookies.find((cookie) => cookie.startsWith('crm_session='))?.slice('crm_session='.length);
    const token = authorizationToken || cookieToken;
    const expiry = sessionExpiries.get(token);
    if (!token || !expiry || expiry <= Date.now()) {
        if (token) { sessions.delete(token); sessionExpiries.delete(token); }
        return null;
    }
    const user = sessions.get(token);
    if (!user) return null;
    const staff = database.prepare('SELECT account_status, status FROM staff WHERE id = ?').get(user.id);
    if (!staff || staff.account_status !== 'ACTIVE' || staff.status !== 'Active') {
        sessions.delete(token);
        sessionExpiries.delete(token);
        return null;
    }
    return user;
}

function requireUser(request, response) {
    const user = currentUser(request);
    if (!user) {
        json(response, 401, { error: 'Authentication required.' });
        return null;
    }
    return user;
}

function googleConfig(request) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`;
    return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}

function sessionUser(staff, authMethod) {
    return { id: staff.id, employeeId: staff.employee_id, name: staff.name, role: staff.role, department: staff.department, designation: staff.designation, authMethod };
}

function createSession(staff, authMethod, rememberMe = false) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, sessionUser(staff, authMethod));
    sessionExpiries.set(token, Date.now() + (rememberMe ? 30 * 24 : 8) * 60 * 60 * 1000);
    database.prepare('UPDATE staff SET last_login_at = ?, auth_method = ? WHERE id = ?').run(now(), authMethod, staff.id);
    return { token, user: sessionUser(staff, authMethod) };
}

function revokeUserSessions(staffId) {
    for (const [token, user] of sessions.entries()) {
        if (user.id === staffId) {
            sessions.delete(token);
            sessionExpiries.delete(token);
        }
    }
}

function sessionCookie(token, rememberMe) {
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
    return `crm_session=${token}; HttpOnly; SameSite=Strict; Path=/;${rememberMe ? ` Max-Age=${maxAge};` : ''}`;
}

function canAccess(user, lead) {
    const access = ROLE_ACCESS[user.role] || 'own';
    if (access === 'all') return true;
    if (access === 'team') {
        const assigned = database.prepare('SELECT manager_id FROM staff WHERE id = ?').get(lead.assigned_to);
        return lead.assigned_to === user.id || assigned?.manager_id === user.id;
    }
    return lead.assigned_to === user.id || lead.created_by === user.id;
}

function canEditLead(user, lead) {
    const allowedRoles = ['Admin/Owner', 'GM/AGM', 'Sales Manager'];
    return allowedRoles.includes(user.role) || (user.role === 'Sales Executive' && lead.assigned_to === user.id);
}

function canAssignLead(user) {
    return ['Admin/Owner', 'GM/AGM', 'Sales Manager'].includes(user.role);
}

function canAddFollowUp(user, lead) {
    return canAccess(user, lead) && (canAssignLead(user) || lead.assigned_to === user.id);
}

function audit(user, action, recordType, recordId, details = {}) {
    database.prepare('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, action, recordType, recordId, JSON.stringify(details), now());
    const leadId = recordType === 'lead' ? recordId : database.prepare(`SELECT lead_id AS id FROM ${recordType === 'follow-up' ? 'follow_ups' : recordType === 'opportunity' ? 'opportunities' : recordType === 'project' ? 'projects' : recordType === 'survey' ? 'surveys' : recordType === 'proposal' ? 'proposals' : recordType === 'quotation' ? 'quotations' : recordType === 'document' ? 'lead_documents' : recordType === 'note' ? 'lead_notes' : recordType === 'communication' ? 'lead_communications' : 'lead_activities'} WHERE id = ?`).get(recordId)?.id;
    if (!leadId) return;
    const type = recordType === 'follow-up' ? 'Follow-ups' : recordType === 'communication' ? (action.includes('whatsapp') ? 'WhatsApp' : action.includes('email') ? 'Email' : 'Calls') : recordType === 'lead' ? 'Lead' : recordType.charAt(0).toUpperCase() + recordType.slice(1);
    const title = action === 'Created' && recordType === 'lead' ? 'Lead Created' : action === 'Reassigned' ? 'Lead Reassigned' : `${recordType === 'follow-up' ? 'Follow-up' : recordType.charAt(0).toUpperCase() + recordType.slice(1)} ${action}`;
    database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), leadId, type, title, details.description || JSON.stringify(details), user.id, recordType, recordId, details.previous || details.previousStage || details.previousStatus || null, details.next || details.newStage || details.newStatus || null, now());
}

function notify(userId, type, message, recordType, recordId) {
    if (!userId) return;
    database.prepare('INSERT INTO notifications (id, user_id, type, message, record_type, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), userId, type, message, recordType, recordId, now());
}

function normalizeLead(row) {
    if (!row) return null;
    let details = {};
    const owner = row.assigned_to ? database.prepare('SELECT id, name, designation, role, status FROM staff WHERE id = ?').get(row.assigned_to) : null;
    try { details = row.details_json ? JSON.parse(row.details_json) : {}; } catch (error) { details = {}; }
    const followUps = database.prepare('SELECT f.id, f.lead_id AS leadId, f.type, f.due_at AS dueAt, f.assigned_to AS assignedTo, s.name AS assignedEmployee, f.status, f.task_status AS taskStatus, f.task_title AS taskTitle, f.notes, f.created_by AS createdBy, f.created_at AS createdAt, f.completed_at AS completedAt, f.completed_by AS completedBy, f.task_completed_at AS taskCompletedAt, f.task_completed_by AS taskCompletedBy, f.outcome, f.missed_reason AS missedReason FROM follow_ups f LEFT JOIN staff s ON s.id = f.assigned_to WHERE f.lead_id = ? ORDER BY datetime(f.due_at) DESC').all(row.id);
    const communications = database.prepare('SELECT c.id, c.lead_id AS leadId, c.type, c.recipient, c.subject, c.message, c.status, c.created_by AS createdBy, s.name AS createdByName, c.created_at AS createdAt FROM lead_communications c LEFT JOIN staff s ON s.id = c.created_by WHERE c.lead_id = ? ORDER BY datetime(c.created_at) DESC').all(row.id);
    const activities = database.prepare('SELECT a.id, a.lead_id AS leadId, a.activity_type AS activityType, a.title, a.description, a.user_id AS userId, s.name AS userName, s.role AS userRole, a.related_record_type AS relatedRecordType, a.related_record_id AS relatedRecordId, a.previous_value AS previousValue, a.new_value AS newValue, a.created_at AS createdAt FROM lead_activities a LEFT JOIN staff s ON s.id = a.user_id WHERE a.lead_id = ? ORDER BY datetime(a.created_at) DESC').all(row.id);
    const survey = database.prepare('SELECT s.*, st.name AS assignedEngineer FROM surveys s LEFT JOIN staff st ON st.id = s.assigned_to WHERE s.lead_id = ?').get(row.id) || null;
    const surveyFiles = survey ? database.prepare("SELECT id, category, file_name AS fileName, original_file_name AS originalFileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt, status, latitude, longitude FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(uploaded_at) DESC").all(survey.id) : [];
    if (survey) survey.files = surveyFiles;
    const documents = database.prepare("SELECT id, document_type AS documentType, file_name AS fileName, original_file_name AS originalFileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, created_at AS createdAt, status FROM lead_documents WHERE lead_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(created_at) DESC").all(row.id);
    const files = [...documents.map((file) => ({ ...file, category: file.documentType, uploadedAt: file.createdAt, relatedType: 'lead' })), ...surveyFiles.map((file) => ({ ...file, relatedType: 'survey' }))];
    return { leadId: row.id, leadNumber: row.lead_number || null, customerName: row.customer_name, mobileNumber: row.mobile_number, email: row.email, leadDate: row.lead_date, leadSource: row.lead_source, assignedTo: row.assigned_to, assignedEmployee: owner?.name || null, owner: owner ? { id: owner.id, name: owner.name, designation: owner.designation, role: owner.role, status: owner.status } : null, leadStage: row.stage, leadStatus: row.status, leadPriority: row.priority, location: row.location, createdBy: row.created_by, createdDate: row.created_at, updatedDate: row.updated_at, details, stageRequirements: stageMissing(row, {}), followUps, communications, activities, survey, siteSurvey: survey, documents, files, communication: communications, stageHistory: database.prepare('SELECT stage, started_at AS startedAt, completed_at AS completedAt, completed_by AS completedBy, duration_seconds AS durationSeconds, remarks FROM lead_stage_history WHERE lead_id = ? ORDER BY datetime(started_at)').all(row.id) };
}

function stageMissing(lead, body) {
    const details = (() => { try { return lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { return {}; } })();
    const missing = [];
    const has = (field, fallback = '') => String(body[field] ?? details[field] ?? fallback).trim();
    const hasInteraction = database.prepare("SELECT id FROM lead_communications WHERE lead_id = ? AND status IN ('Attempted', 'Completed', 'Initiated') LIMIT 1").get(lead.id) || database.prepare("SELECT id FROM follow_ups WHERE lead_id = ? AND status IN ('Completed', 'Scheduled', 'Pending') AND task_status NOT IN ('CANCELLED', 'DELETED') LIMIT 1").get(lead.id);
    const requestedFollowUp = body.nextFollowUpDate && body.nextFollowUpTime && `${body.nextFollowUpDate}T${body.nextFollowUpTime}` > new Date().toISOString();
    const futureFollowUp = database.prepare("SELECT id FROM follow_ups WHERE lead_id = ? AND status IN ('Pending', 'Scheduled') AND datetime(due_at) > datetime('now') LIMIT 1").get(lead.id) || requestedFollowUp;
    if (['Working', 'Nurturing'].includes(lead.stage) && body.outcome === 'Lost') {
        if (!has('lostReason')) missing.push('Lost Reason');
        if (!has('remarks')) missing.push('Lost Remarks');
    }
    if (lead.stage === 'New') {
        if (!lead.assigned_to) missing.push('Assigned salesperson');
        if (!lead.customer_name) missing.push('Customer Name');
        if (!lead.mobile_number) missing.push('Mobile Number');
        if (!lead.lead_source) missing.push('Lead Source');
        if (!hasInteraction && !futureFollowUp) missing.push('First contact attempt or follow-up scheduled');
    } else if (lead.stage === 'Working') {
    } else if (lead.stage === 'Nurturing') {
    } else if (lead.stage === 'Opportunity') {
        ['requirement', 'systemCapacity', 'estimatedValue', 'expectedCloseDate'].forEach((field) => { if (!has(field)) missing.push(field); });
        if (!has('siteSurveyRequired')) missing.push('Site survey requirement');
        if (!has('customerAgreesSurvey')) missing.push('Customer agreement to survey');
    } else if (lead.stage === 'Site Survey Scheduled') {
        const survey = database.prepare('SELECT * FROM surveys WHERE lead_id = ?').get(lead.id);
        if (!survey) missing.push('Survey ID', 'Survey date', 'Survey time', 'Surveyor', 'Site address', 'Survey status');
        else {
            const requiredFields = [['latitude', 'Latitude'], ['longitude', 'Longitude'], ['locationAccuracy', 'Location accuracy'], ['electricityProvider', 'Electricity provider'], ['consumerNumber', 'Consumer number'], ['meterNumber', 'Meter number'], ['sanctionedLoad', 'Sanctioned load'], ['phase', 'Phase'], ['proposedCapacity', 'Proposed system capacity'], ['systemType', 'System type'], ['installationType', 'Installation type'], ['roofType', 'Roof type'], ['roofArea', 'Roof area'], ['usableRoofArea', 'Usable roof area'], ['roofCondition', 'Roof condition'], ['shadowCondition', 'Shadow condition'], ['roofDirection', 'Roof direction'], ['existingEarthing', 'Existing earthing'], ['earthingCondition', 'Earthing condition'], ['roofAccess', 'Roof access'], ['engineerObservations', 'Engineer observations']];
            requiredFields.forEach(([field, label]) => { if (!has(field)) missing.push(label); });
            if (!survey.id) missing.push('Survey ID');
            if (!survey.survey_date) missing.push('Survey date and time');
            if (!survey.assigned_to) missing.push('Surveyor');
            if (!survey.address) missing.push('Site address');
            let files = [];
            try { files = Array.isArray(body.surveyFiles) ? body.surveyFiles : JSON.parse(body.surveyFiles || '[]'); } catch (error) { files = []; }
            const existingCategories = new Set(database.prepare("SELECT category FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL").all(survey.id).map((file) => file.category));
            files.forEach((file) => existingCategories.add(file.category));
            ['EAST_SIDE_PHOTO', 'WEST_SIDE_PHOTO', 'NORTH_SIDE_PHOTO', 'SOUTH_SIDE_PHOTO', 'ELECTRICITY_METER_PHOTO', 'ELECTRICITY_BILL', 'EARTHING_LOCATION_PHOTO', 'ROOF_PHOTO', 'ROOF_360_VIDEO'].forEach((category) => { if (!existingCategories.has(category)) missing.push(category); });
        }
    } else if (lead.stage === 'Site Survey Completed') {
        const survey = database.prepare("SELECT * FROM surveys WHERE lead_id = ? AND status = 'Completed'").get(lead.id);
        if (!survey) missing.push('Survey completed');
        else {
            ['sanctioned_load', 'electricity_details', 'roof_information', 'recommended_capacity', 'remarks'].forEach((field) => { if (!String(survey[field] || '').trim() || survey[field] === 'Pending') missing.push(field); });
            if (!survey.feasibility) missing.push('Site feasibility');
            if (survey.feasibility === 'Site Not Feasible') missing.push('Site feasibility');
        }
        if (!database.prepare('SELECT id FROM proposals WHERE lead_id = ?').get(lead.id)) missing.push('Proposal or quotation');
    } else if (lead.stage === 'Order Booked') {
        const booking = database.prepare('SELECT * FROM bookings WHERE lead_id = ?').get(lead.id);
        const project = database.prepare('SELECT * FROM projects WHERE lead_id = ?').get(lead.id);
        if (!booking && !project) missing.push('Booking/Order ID', 'Proposal or quotation', 'Final project value', 'Booking date', 'Booking amount/status', 'Salesperson', 'Customer confirmation');
    } else if (lead.stage === 'Loan Process') {
        if (body.loanRequired !== false) {
            ['financeProvider', 'loanApplicationNumber', 'loanApplicationDate', 'loanAmount', 'loanDocuments', 'loanStatus'].forEach((field) => { if (!has(field)) missing.push(field); });
        }
    } else if (lead.stage === 'Completed') {
        const completedProject = database.prepare("SELECT projects.id FROM projects JOIN commissioning ON commissioning.project_id = projects.id WHERE projects.lead_id = ? AND commissioning.status IN ('Commissioned', 'Completed')").get(lead.id);
        if (!completedProject) missing.push('Installation', 'Commissioning', 'Project completion confirmation');
        if (!database.prepare('SELECT id FROM lead_documents WHERE lead_id = ?').get(lead.id)) missing.push('Required documents');
    }
    return missing;
}

function completeStage(user, lead, body) {
    const missing = stageMissing(lead, body);
    if (missing.length) return { missing };
    const timestamp = now();
    const currentIndex = ACTIVE_STAGE_FLOW.indexOf(lead.stage);
    let nextStage = lead.stage === 'Working' ? ({ Nurturing: 'Nurturing', Opportunity: 'Opportunity', Lost: 'Lost' }[body.outcome] || 'Nurturing') : lead.stage === 'Nurturing' ? ({ Working: 'Working', Opportunity: 'Opportunity', Lost: 'Lost' }[body.outcome] || 'Working') : lead.stage === 'Order Booked' && body.loanRequired !== false ? 'Loan Process' : lead.stage === 'Order Booked' ? 'Completed' : ACTIVE_STAGE_FLOW[currentIndex + 1];
    if (lead.stage === 'Working' && !nextStage || lead.stage === 'Nurturing' && !nextStage) return { missing: ['A valid next-stage outcome'] };
    if (lead.stage === 'Lost') return { missing: ['Lost leads cannot be completed'] };
    if (!nextStage) return { missing: ['Final completion requirements'] };
    if (nextStage === 'Lost' && !String(body.lostReason || '').trim()) return { missing: ['Lost Reason'] };
    const currentHistory = database.prepare('SELECT id, started_at FROM lead_stage_history WHERE lead_id = ? AND stage = ? AND completed_at IS NULL ORDER BY datetime(started_at) DESC LIMIT 1').get(lead.id, lead.stage);
    const storedPaths = [];
    database.exec('BEGIN');
    try {
        const surveyForCompletion = lead.stage === 'Site Survey Scheduled' ? database.prepare('SELECT id FROM surveys WHERE lead_id = ?').get(lead.id) : null;
        if (surveyForCompletion) {
            let surveyFiles = [];
            try { surveyFiles = Array.isArray(body.surveyFiles) ? body.surveyFiles : JSON.parse(body.surveyFiles || '[]'); } catch (error) { surveyFiles = []; }
            const completionData = { ...body };
            delete completionData.surveyFiles;
            database.prepare('UPDATE surveys SET latitude = ?, longitude = ?, location_accuracy = ?, location_captured_at = ?, completion_data_json = ?, sanctioned_load = ?, electricity_details = ?, roof_information = ?, recommended_capacity = ?, remarks = ?, status = ?, completed_at = ? WHERE id = ?').run(body.latitude, body.longitude, body.locationAccuracy, body.locationCapturedAt || timestamp, JSON.stringify(completionData), body.sanctionedLoad, JSON.stringify({ provider: body.electricityProvider, consumerNumber: body.consumerNumber, meterNumber: body.meterNumber, phase: body.phase }), JSON.stringify({ roofType: body.roofType, roofArea: body.roofArea, usableRoofArea: body.usableRoofArea, roofCondition: body.roofCondition, shadowCondition: body.shadowCondition, roofDirection: body.roofDirection }), body.proposedCapacity, body.engineerObservations, 'Completed', timestamp, surveyForCompletion.id);
            const insertFile = database.prepare('INSERT INTO survey_files (id, survey_id, lead_id, category, file_name, mime_type, file_size, file_data, uploaded_by, uploaded_at, latitude, longitude, storage_path, original_file_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            surveyFiles.forEach((file) => { const stored = saveUploadedFile(file); storedPaths.push(stored.storagePath); insertFile.run(crypto.randomUUID(), surveyForCompletion.id, lead.id, file.category, stored.originalFileName, stored.mimeType, stored.fileSize, null, user.id, timestamp, body.latitude, body.longitude, stored.storagePath, stored.originalFileName, 'UPLOADED'); });
            const linkedTask = database.prepare("SELECT id FROM follow_ups WHERE task_related_type = 'survey' AND task_related_id = ?").get(surveyForCompletion.id);
            if (linkedTask) database.prepare("UPDATE follow_ups SET status = 'Completed', task_status = 'COMPLETED', task_completed_at = ?, task_completed_by = ?, completed_at = ?, completed_by = ? WHERE id = ?").run(timestamp, user.id, timestamp, user.id, linkedTask.id);
        }
        if (currentHistory) database.prepare('UPDATE lead_stage_history SET completed_at = ?, completed_by = ?, duration_seconds = ?, remarks = ? WHERE id = ?').run(timestamp, user.id, Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(currentHistory.started_at)) / 1000)), body.remarks || null, currentHistory.id);
        database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), lead.id, nextStage, timestamp);
        const details = (() => { try { return lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { return {}; } })();
        const updatedDetails = { ...details, ...body, surveyFiles: undefined, ...(nextStage === 'Lost' ? { lostReason: body.lostReason, lostDate: timestamp, lostBy: user.id } : {}) };
        if (nextStage === 'Opportunity' && !database.prepare('SELECT id FROM opportunities WHERE lead_id = ?').get(lead.id)) database.prepare('INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, expected_close_date, probability, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`OPP-${lead.id}`, lead.id, lead.customer_name, body.systemCapacity || details.systemCapacity || null, Number(body.estimatedValue || details.estimatedValue || 0), lead.assigned_to, body.expectedCloseDate || details.expectedCloseDate || null, Number(body.probability || details.probability || 0), 'Qualified', user.id, timestamp, timestamp);
        database.prepare('UPDATE leads SET stage = ?, status = ?, details_json = ?, updated_at = ? WHERE id = ?').run(nextStage, nextStage === 'Lost' ? 'Lost' : lead.status, JSON.stringify(updatedDetails), timestamp, lead.id);
        const savedLead = database.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id);
        if (!savedLead || savedLead.stage !== nextStage) throw new Error('Stage update verification failed.');
        audit(user, 'Stage completed', 'lead', lead.id, { previous: lead.stage, next: nextStage, remarks: body.remarks || null });
        if (surveyForCompletion) audit(user, 'Completed', 'survey', surveyForCompletion.id, { description: 'Site survey completed with mandatory evidence and location.' });
        if (lead.assigned_to) notify(lead.assigned_to, 'stage-changed', `Lead ${lead.id} moved to ${nextStage}.`, 'lead', lead.id);
        database.exec('COMMIT');
        return { nextStage };
    } catch (error) {
        database.exec('ROLLBACK');
        storedPaths.forEach(removeStoredFile);
        throw error;
    }
}

function accessibleLeadIds(user) {
    return database.prepare('SELECT id FROM leads ORDER BY created_at DESC').all().filter((lead) => canAccess(user, lead)).map((lead) => lead.id);
}

function markOverdueFollowUps() {
    database.prepare(`UPDATE follow_ups SET status = 'Overdue', task_status = 'OVERDUE' WHERE status IN ('Scheduled', 'Pending') AND task_status = 'PENDING' AND datetime(due_at) < datetime('now')`).run();
}

function taskTitle(type) {
    return ({ WhatsApp: 'WhatsApp follow-up with customer', Call: 'Call customer regarding solar proposal', 'Site Visit': 'Site visit with customer', Meeting: 'Meeting with customer', 'Proposal Discussion': 'Follow up on quotation', 'Payment Follow-up': 'Follow up on payment' })[type] || 'Follow up with customer';
}

function taskRow(row) {
    const status = row.task_status || (row.status === 'Completed' ? 'COMPLETED' : row.status === 'Overdue' ? 'OVERDUE' : 'PENDING');
    return { taskId: row.id, followUpId: row.id, leadId: row.lead_id, leadNumber: row.lead_number || null, leadName: row.customer_name, taskType: row.type, taskTitle: row.task_title || taskTitle(row.type), notes: row.notes || '', dueAt: row.due_at, createdAt: row.created_at, createdBy: row.created_by, assignedTo: row.assigned_to, assignedEmployee: row.assigned_employee || null, status, completedAt: row.task_completed_at || row.completed_at || null, completedBy: row.task_completed_by || row.completed_by || null, relatedRecordType: row.task_related_type || null, relatedRecordId: row.task_related_id || null };
}

function accessibleTaskRows(user) {
    return database.prepare(`SELECT f.*, l.lead_number, l.customer_name, s.name AS assigned_employee FROM follow_ups f JOIN leads l ON l.id = f.lead_id LEFT JOIN staff s ON s.id = f.assigned_to ORDER BY datetime(f.due_at) ASC`).all().filter((row) => canAccess(user, { assigned_to: row.assigned_to, created_by: row.created_by })).map(taskRow);
}

function canViewInventory(user) {
    return user && user.role !== 'Telecaller';
}

function canManageInventory(user) {
    return user && ['Admin/Owner', 'GM/AGM', 'Sales Manager'].includes(user.role);
}

function inventoryItem(row) {
    if (!row) return null;
    return { ...row, requiresSerial: Boolean(row.requires_serial), requiresBatch: Boolean(row.requires_batch), availableStock: Math.max(0, Number(row.total_stock || 0) - Number(row.reserved_stock || 0) - Number(row.issued_stock || 0) + Number(row.returned_stock || 0)), reservedStock: Number(row.reserved_stock || 0), issuedStock: Number(row.issued_stock || 0), damagedStock: Number(row.damaged_stock || 0), totalStock: Number(row.total_stock || 0) };
}

function inventoryDashboard() {
    const items = database.prepare('SELECT * FROM inventory ORDER BY product').all().map(inventoryItem);
    const today = new Date().toISOString().slice(0, 10);
    const movementCount = (action) => database.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_movements WHERE action = ? AND date(created_at) = ?').get(action, today).total;
    return {
        totalItems: items.length,
        totalStockQuantity: items.reduce((sum, item) => sum + item.totalStock, 0),
        availableStock: items.reduce((sum, item) => sum + item.availableStock, 0),
        reservedStock: items.reduce((sum, item) => sum + item.reservedStock, 0),
        issuedStock: items.reduce((sum, item) => sum + item.issuedStock, 0),
        lowStockItems: items.filter((item) => item.availableStock > 0 && item.availableStock <= Number(item.minimum_stock || item.low_stock_threshold || 0)).length,
        outOfStockItems: items.filter((item) => item.availableStock <= 0).length,
        damagedStock: items.reduce((sum, item) => sum + item.damagedStock, 0),
        returnedStock: items.reduce((sum, item) => sum + Number(item.returned_stock || 0), 0),
        totalInventoryValue: items.reduce((sum, item) => sum + item.totalStock * Number(item.purchase_price || 0), 0),
        stockInToday: movementCount('Stock In'),
        stockOutToday: movementCount('Stock Out'),
        pendingMaterialRequests: database.prepare("SELECT COUNT(*) AS count FROM material_requests WHERE status IN ('Submitted', 'Pending Approval')").get().count
    };
}

function writeInventoryMovement({ item, action, quantity, user, referenceId = null, projectId = null, leadId = null, batchNumber = null, serialNumbers = [], warehouse = null, remarks = null }) {
    const previous = inventoryItem(database.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id));
    const timestamp = now();
    const movementId = referenceId || `INV-${Date.now()}-${crypto.randomInt(100, 999)}`;
    let total = previous.totalStock;
    let reserved = previous.reservedStock;
    let issued = previous.issuedStock;
    let damaged = previous.damagedStock;
    let returned = Number(previous.returned_stock || 0);
    if (action === 'Stock In') total += quantity;
    if (action === 'Stock Out') issued += quantity;
    if (action === 'Return Good') { issued = Math.max(0, issued - quantity); returned += quantity; }
    if (action === 'Damage') { damaged += quantity; total = Math.max(0, total - quantity); }
    const available = Math.max(0, total - reserved - issued + returned);
    database.prepare('UPDATE inventory SET total_stock = ?, reserved_stock = ?, issued_stock = ?, damaged_stock = ?, returned_stock = ?, available_stock = ?, updated_at = ? WHERE id = ?').run(total, reserved, issued, damaged, returned, available, timestamp, item.id);
    database.prepare('INSERT INTO inventory_movements (id, inventory_id, action, quantity, previous_stock, new_stock, user_id, reference_id, project_id, lead_id, batch_number, serial_numbers, warehouse, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(movementId, item.id, action, quantity, previous.availableStock, available, user.id, referenceId, projectId, leadId, batchNumber, JSON.stringify(serialNumbers), warehouse, remarks, timestamp);
    database.prepare('INSERT INTO inventory_transactions (id, inventory_id, project_id, action, quantity, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(movementId, item.id, projectId, action, quantity, user.id, timestamp);
    if (leadId) database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), leadId, 'Inventory', `${quantity} ${item.product} - ${action}`, JSON.stringify({ quantity, referenceId, projectId, itemId: item.id }), user.id, 'inventory', movementId, timestamp);
    return { movementId, previousStock: previous.availableStock, newStock: available };
}

async function handleInventoryApi(request, response, url, user) {
    if (!url.pathname.startsWith('/api/inventory')) return false;
    if (!canViewInventory(user)) { json(response, 403, { error: 'You do not have permission to view Inventory.' }); return true; }
    if (request.method === 'GET' && url.pathname === '/api/inventory/dashboard') return json(response, 200, { dashboard: inventoryDashboard() });
    if (request.method === 'GET' && url.pathname === '/api/inventory/items') return json(response, 200, { items: database.prepare('SELECT * FROM inventory ORDER BY product').all().map(inventoryItem) });
    if (request.method === 'GET' && url.pathname === '/api/inventory/categories') return json(response, 200, { categories: database.prepare('SELECT * FROM inventory_categories ORDER BY name').all() });
    if (request.method === 'GET' && url.pathname === '/api/inventory/history') {
        const rows = database.prepare('SELECT m.*, i.product, i.sku, s.name AS user_name FROM inventory_movements m JOIN inventory i ON i.id = m.inventory_id LEFT JOIN staff s ON s.id = m.user_id ORDER BY datetime(m.created_at) DESC LIMIT 250').all();
        return json(response, 200, { history: rows });
    }
    if (request.method === 'GET' && url.pathname === '/api/inventory/material-requests') {
        return json(response, 200, { requests: database.prepare('SELECT r.*, s.name AS requested_by_name FROM material_requests r LEFT JOIN staff s ON s.id = r.requested_by ORDER BY datetime(r.created_at) DESC').all() });
    }
    if (request.method === 'GET' && url.pathname === '/api/inventory/projects') {
        const projects = database.prepare('SELECT p.id AS projectId, p.lead_id AS leadId, l.customer_name AS customerName, p.status FROM projects p JOIN leads l ON l.id = p.lead_id ORDER BY datetime(p.created_at) DESC').all().filter((project) => { const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.leadId); return canAccess(user, lead); });
        return json(response, 200, { projects });
    }
    if (!canManageInventory(user)) { json(response, 403, { error: 'You do not have permission to modify Inventory.' }); return true; }
    if (request.method === 'POST' && url.pathname === '/api/inventory/items') {
        const body = await parseBody(request);
        if (!String(body.product || '').trim() || !String(body.sku || '').trim()) return json(response, 422, { error: 'Product Name and SKU are required.' });
        if (database.prepare('SELECT id FROM inventory WHERE sku = ? OR product = ?').get(body.sku.trim(), body.product.trim())) return json(response, 409, { error: 'Item ID/SKU or Product already exists.' });
        const id = body.itemId || `INV-${Date.now()}`;
        database.prepare(`INSERT INTO inventory (id, product, sku, category, subcategory, brand, model, specification, unit, purchase_price, selling_price, minimum_stock, maximum_stock, reorder_level, total_stock, available_stock, warehouse, rack_bin, supplier, warranty_information, requires_serial, requires_batch, status, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`).run(id, body.product.trim(), body.sku.trim(), body.category || null, body.subcategory || null, body.brand || null, body.model || null, body.specification || null, body.unit || 'unit', Number(body.purchasePrice || 0), Number(body.sellingPrice || 0), Number(body.minimumStock || 0), Number(body.maximumStock || 0), Number(body.reorderLevel || 0), body.warehouse || null, body.rackBin || null, body.supplier || null, body.warrantyInformation || null, body.requiresSerial ? 1 : 0, body.requiresBatch ? 1 : 0, user.id, now());
        return json(response, 201, { item: inventoryItem(database.prepare('SELECT * FROM inventory WHERE id = ?').get(id)) });
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/categories') {
        const body = await parseBody(request); if (!String(body.name || '').trim()) return json(response, 422, { error: 'Category name is required.' });
        const id = crypto.randomUUID(); database.prepare('INSERT INTO inventory_categories (id, name, parent_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, body.name.trim(), body.parentName || null, user.id, now()); return json(response, 201, { id });
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/stock-in') {
        const body = await parseBody(request); const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(body.itemId); const quantity = Number(body.quantity);
        if (!item || !Number.isFinite(quantity) || quantity <= 0) return json(response, 422, { error: 'Valid item and quantity are required.' });
        database.exec('BEGIN'); try { const movement = writeInventoryMovement({ item, action: 'Stock In', quantity, user, referenceId: body.stockInId || `SIN-${Date.now()}`, batchNumber: body.batchNumber, serialNumbers: body.serialNumbers || [], warehouse: body.warehouse, remarks: body.remarks }); database.exec('COMMIT'); return json(response, 201, movement); } catch (error) { database.exec('ROLLBACK'); return json(response, 500, { error: 'Stock In could not be recorded.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/stock-out') {
        const body = await parseBody(request); const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(body.itemId); const quantity = Number(body.quantity); const current = inventoryItem(item);
        if (!item || !Number.isFinite(quantity) || quantity <= 0) return json(response, 422, { error: 'Valid item and quantity are required.' });
        if (quantity > current.availableStock) return json(response, 422, { error: 'INSUFFICIENT STOCK', required: quantity, available: current.availableStock, shortage: quantity - current.availableStock });
        database.exec('BEGIN'); try { const movement = writeInventoryMovement({ item, action: 'Stock Out', quantity, user, referenceId: body.stockOutId || `SOUT-${Date.now()}`, projectId: body.projectId, leadId: body.leadId, serialNumbers: body.serialNumbers || [], warehouse: body.warehouse, remarks: body.remarks }); database.exec('COMMIT'); return json(response, 201, movement); } catch (error) { database.exec('ROLLBACK'); return json(response, 500, { error: 'Stock Out could not be recorded.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/material-requests') {
        const body = await parseBody(request); if (!Array.isArray(body.items) || !body.items.length) return json(response, 422, { error: 'At least one material is required.' });
        const requestId = body.requestId || `MR-${Date.now()}`; const timestamp = now(); database.exec('BEGIN'); try { database.prepare('INSERT INTO material_requests (id, project_id, lead_id, order_id, installation_date, requested_by, department, required_date, priority, remarks, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(requestId, body.projectId || null, body.leadId || null, body.orderId || null, body.installationDate || null, user.id, body.department || null, body.requiredDate || null, body.priority || 'Medium', body.remarks || null, body.status === 'Submitted' ? 'Submitted' : 'Draft', timestamp, timestamp); const insert = database.prepare('INSERT INTO material_request_items (id, request_id, inventory_id, required_quantity) VALUES (?, ?, ?, ?)'); body.items.forEach((item) => insert.run(crypto.randomUUID(), requestId, item.itemId, Number(item.quantity))); database.exec('COMMIT'); return json(response, 201, { requestId }); } catch (error) { database.exec('ROLLBACK'); return json(response, 422, { error: 'Material request could not be created.' }); }
    }
    const requestMatch = url.pathname.match(/^\/api\/inventory\/material-requests\/([^/]+)$/);
    if (requestMatch && request.method === 'PATCH') {
        const requestId = decodeURIComponent(requestMatch[1]);
        const body = await parseBody(request);
        const status = body.status;
        if (!['Approved', 'Rejected', 'Cancelled'].includes(status)) return json(response, 422, { error: 'Invalid request status.' });
        if (status === 'Rejected' && !String(body.rejectionReason || '').trim()) return json(response, 422, { error: 'Rejection reason is required.' });
        const materialRequest = database.prepare('SELECT * FROM material_requests WHERE id = ?').get(requestId);
        if (!materialRequest) return json(response, 404, { error: 'Material request not found.' });
        if (status === 'Approved') {
            const requestedItems = database.prepare('SELECT * FROM material_request_items WHERE request_id = ?').all(requestId);
            database.exec('BEGIN');
            try {
                requestedItems.forEach((requested) => {
                    const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(requested.inventory_id);
                    const current = inventoryItem(item);
                    if (!item || requested.required_quantity > current.availableStock) throw new Error(`INSUFFICIENT STOCK for ${item?.product || requested.inventory_id}`);
                    const reserved = current.reservedStock + Number(requested.required_quantity);
                    database.prepare('UPDATE inventory SET reserved_stock = ?, available_stock = ?, updated_at = ? WHERE id = ?').run(reserved, Math.max(0, current.totalStock - reserved - current.issuedStock + Number(item.returned_stock || 0)), now(), item.id);
                    database.prepare('UPDATE material_request_items SET reserved_quantity = ? WHERE id = ?').run(requested.required_quantity, requested.id);
                    database.prepare('INSERT INTO inventory_movements (id, inventory_id, action, quantity, previous_stock, new_stock, user_id, reference_id, project_id, lead_id, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), item.id, 'Reservation', requested.required_quantity, current.availableStock, Math.max(0, current.availableStock - requested.required_quantity), user.id, requestId, materialRequest.project_id, materialRequest.lead_id, 'Material request approved', now());
                });
                database.prepare('UPDATE material_requests SET status = ?, rejection_reason = NULL, approved_by = ?, updated_at = ? WHERE id = ?').run(status, user.id, now(), requestId);
                database.exec('COMMIT');
            } catch (error) { database.exec('ROLLBACK'); return json(response, 422, { error: error.message }); }
        } else database.prepare('UPDATE material_requests SET status = ?, rejection_reason = ?, approved_by = ?, updated_at = ? WHERE id = ?').run(status, body.rejectionReason || null, user.id, now(), requestId);
        return json(response, 200, { success: true });
    }
    return json(response, 404, { error: 'Inventory route not found.' });
}

async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/auth/google/config') {
        return json(response, 200, { configured: Boolean(googleConfig(request)) });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/google/start') {
        const config = googleConfig(request);
        if (!config) return json(response, 503, { error: 'Google Sign-In is not configured on the CRM server.' });
        const state = crypto.randomBytes(24).toString('hex');
        googleStates.set(state, Date.now() + 10 * 60 * 1000);
        const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorization.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
        return redirect(response, authorization.toString());
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/google/callback') {
        const config = googleConfig(request);
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const stateExpiry = state && googleStates.get(state);
        googleStates.delete(state);
        if (!config || !stateExpiry || stateExpiry < Date.now() || !code) return redirect(response, '/login.html?authError=Unable%20to%20complete%20Google%20authentication.');
        try {
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }) });
            if (!tokenResponse.ok) throw new Error('Google token exchange failed.');
            const tokenBody = await tokenResponse.json();
            const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokenBody.access_token}` } });
            if (!profileResponse.ok) throw new Error('Google profile lookup failed.');
            const profile = await profileResponse.json();
            const email = String(profile.email || '').trim().toLowerCase();
            if (!email || profile.email_verified !== true) throw new Error('Google email is not verified.');
            let staff = database.prepare('SELECT * FROM staff WHERE lower(google_email) = ?').get(email);
            if (!staff && email === GOOGLE_ADMIN_EMAIL) staff = database.prepare("SELECT * FROM staff WHERE login_id = 'admin'").get();
            if (!staff) { console.warn('Unauthorized Google login:', email); return redirect(response, '/login.html?authError=Your%20Google%20account%20is%20not%20registered%20as%20an%20active%20CRM%20employee.'); }
            if (staff.status !== 'Active' || staff.account_status !== 'ACTIVE') { audit({ id: staff.id }, 'Google Login Denied', 'staff', staff.id, { email, status: staff.status, accountStatus: staff.account_status, result: 'DENIED' }); return redirect(response, `/login.html?authError=${encodeURIComponent('Your account has been deactivated. Please contact your administrator to continue.')}`); }
            if (!staff.google_email) database.prepare('UPDATE staff SET google_email = ? WHERE id = ?').run(email, staff.id);
            const session = createSession(staff, 'Google');
            audit(session.user, 'Google Login Successful', 'staff', staff.id, { email, method: 'Google' });
            return redirect(response, `/login.html?authToken=${encodeURIComponent(session.token)}`);
        } catch (error) {
            console.error('Google authentication failed:', error.message);
            return redirect(response, '/login.html?authError=Unable%20to%20sign%20in%20with%20Google.%20Please%20try%20again.');
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseBody(request);
        const loginId = String(body.loginId || '').trim().toLowerCase();
        const password = String(body.password || '');
        const staff = database.prepare('SELECT * FROM staff WHERE lower(login_id) = ? OR lower(COALESCE(email, \'\')) = ?').get(loginId, loginId);
        const securityDetails = { email: staff?.email || staff?.google_email || loginId, ipAddress: request.socket.remoteAddress || null, userAgent: request.headers['user-agent'] || null, result: 'DENIED' };
        if (staff && staff.account_status === 'PENDING') return json(response, 403, { code: 'ACCOUNT_PENDING', title: 'Approval Pending', error: 'Your account is pending admin approval. Please wait.' });
        if (staff && staff.account_status === 'DECLINED') {
            const blockedUntil = staff.blocked_until ? Date.parse(staff.blocked_until) : 0;
            if (blockedUntil > Date.now()) return json(response, 403, { code: 'ACCOUNT_DECLINED', title: 'Account Declined', error: `Your account was declined. You can try again after ${new Date(blockedUntil).toLocaleString()}.` });
            return json(response, 403, { code: 'ACCOUNT_DECLINED', title: 'Account Declined', error: 'Your account was declined. Please submit a new request.' });
        }
        if (staff && (staff.account_status !== 'ACTIVE' || staff.status !== 'Active')) {
            audit({ id: staff.id }, 'Login Denied - Account Deactivated', 'staff', staff.id, { ...securityDetails, accountStatus: staff.account_status, reason: staff.deactivation_reason || 'Account is not active.' });
            return json(response, 423, { code: 'ACCOUNT_DEACTIVATED', title: 'Account Deactivated', error: 'Your account has been deactivated. Please contact your administrator to continue.' });
        }
        const valid = staff && verifyPassword(password, staff.password_hash);
        if (!valid) {
            if (staff) {
                database.exec('BEGIN IMMEDIATE');
                try {
                    const current = database.prepare('SELECT failed_login_attempts, account_status, status FROM staff WHERE id = ?').get(staff.id);
                    if (!current || current.account_status !== 'ACTIVE' || current.status !== 'Active') {
                        database.exec('ROLLBACK');
                        return json(response, 423, { code: 'ACCOUNT_DEACTIVATED', title: 'Account Deactivated', error: 'Your account has been deactivated. Please contact your administrator to continue.' });
                    }
                    const attempts = Number(current.failed_login_attempts || 0) + 1;
                    const deactivated = attempts >= 5;
                    const timestamp = now();
                    database.prepare('UPDATE staff SET failed_login_attempts = ?, account_status = ?, status = ?, deactivated_at = ?, deactivation_reason = ?, locked_until = NULL WHERE id = ?').run(attempts, deactivated ? 'DEACTIVATED' : 'ACTIVE', deactivated ? 'Inactive' : 'Active', deactivated ? timestamp : null, deactivated ? '5 failed login attempts' : null, staff.id);
                    database.exec('COMMIT');
                    audit({ id: staff.id }, deactivated ? 'Account Automatically Deactivated' : `Login Failed - Attempt ${attempts}`, 'staff', staff.id, { ...securityDetails, attempt: attempts, reason: deactivated ? '5 failed login attempts' : 'Invalid credentials' });
                    if (deactivated) {
                        revokeUserSessions(staff.id);
                        return json(response, 423, { code: 'ACCOUNT_DEACTIVATED', title: 'Account Deactivated', error: 'Your account has been deactivated after 5 unsuccessful login attempts. Please contact your administrator to continue.' });
                    }
                } catch (error) {
                    database.exec('ROLLBACK');
                    console.error('Login security update failed:', error.message);
                    return json(response, 500, { error: 'Unable to sign in. Please try again.' });
                }
            }
            return json(response, 401, { error: 'Invalid email or password. Please try again.' });
        }
        database.prepare('UPDATE staff SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(staff.id);
        if (!staff.password_hash.startsWith('scrypt$')) database.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(password), staff.id);
        const session = createSession(staff, 'Employee', body.rememberMe === true);
        const user = session.user;
        audit(user, 'Login Successful', 'staff', staff.id, { ...securityDetails, result: 'SUCCESS' });
        response.setHeader('Set-Cookie', sessionCookie(session.token, body.rememberMe === true));
        return json(response, 200, { token: session.token, user });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
        const body = await parseBody(request);
        const loginId = String(body.loginId || '').trim().toLowerCase();
        const staff = database.prepare('SELECT id, email, google_email FROM staff WHERE lower(login_id) = ? OR lower(COALESCE(email, \'\')) = ?').get(loginId, loginId);
        if (staff && (staff.email || staff.google_email)) {
            const token = crypto.randomBytes(32).toString('hex');
            database.prepare('INSERT INTO password_reset_tokens (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run(hashPassword(token), staff.id, new Date(Date.now() + 30 * 60 * 1000).toISOString());
            if (process.env.PASSWORD_RESET_BASE_URL) console.info(`Password reset link queued for ${staff.id}: ${process.env.PASSWORD_RESET_BASE_URL}?token=${token}`);
        }
        return json(response, 200, { message: 'If that account exists, we have sent a password reset link to its registered email.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/signup') {
        const body = await parseBody(request);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
            return json(response, 422, { error: 'Please provide a valid name, email, and strong password.' });
        }
        const existing = database.prepare("SELECT * FROM staff WHERE lower(email) = ? OR lower(login_id) = ?").get(email, email);
        if (existing) {
            if (existing.account_status === 'DECLINED' && existing.blocked_until && Date.parse(existing.blocked_until) > Date.now()) return json(response, 429, { error: 'You cannot create a new account. Please wait 24 hours.' });
            if (existing.account_status === 'DECLINED') {
                database.prepare("UPDATE staff SET name = ?, password_hash = ?, account_status = 'PENDING', status = 'Inactive', failed_login_attempts = 0, blocked_until = NULL, deactivated_at = NULL, deactivation_reason = NULL WHERE id = ?").run(name, hashPassword(password), existing.id);
                return json(response, 201, { success: true, message: 'Account created! Awaiting admin approval.' });
            }
            return json(response, 409, { error: 'This email is already registered. Please log in.' });
        }
        const id = crypto.randomUUID();
        const employeeId = `EMP-${Date.now()}`;
        try {
            database.prepare(`INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Inactive', 'PENDING', ?)`)
                .run(id, employeeId, name, email, 'Sales', 'Sales Executive', email, hashPassword(password), 'Sales Executive', now());
            database.prepare("SELECT id FROM staff WHERE role = 'Admin/Owner' AND account_status = 'ACTIVE'").all().forEach((admin) => notify(admin.id, 'NEW_SIGNUP', `New signup request from ${name} (${email}). Please review.`, 'staff', id));
            audit({ id }, 'Signup Request Created', 'staff', id, { email, result: 'PENDING' });
        } catch (error) {
            return json(response, 409, { error: 'This email is already registered. Please log in.' });
        }
        return json(response, 201, { success: true, message: 'Account created! Awaiting admin approval.' });
    }

    const user = requireUser(request, response);
    if (!user) return;
    markOverdueFollowUps();

    if (await handleInventoryApi(request, response, url, user)) return;

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        audit(user, 'Logout', 'staff', user.id);
        database.prepare('UPDATE staff SET last_logout_at = ? WHERE id = ?').run(now(), user.id);
        const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(request.headers.cookie || '').split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith('crm_session='))?.slice('crm_session='.length);
        sessions.delete(token);
        sessionExpiries.delete(token);
        response.setHeader('Set-Cookie', 'crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        return json(response, 200, { user });
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (fileMatch && request.method === 'GET') {
        const fileId = decodeURIComponent(fileMatch[1]);
        const file = database.prepare("SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath FROM lead_documents WHERE id = ? AND status = 'UPLOADED' UNION ALL SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath FROM survey_files WHERE id = ? AND status = 'UPLOADED'").get(fileId, fileId);
        const lead = file && database.prepare('SELECT * FROM leads WHERE id = ?').get(file.leadId);
        if (!file || !lead || !canAccess(user, lead)) return json(response, 403, { error: 'Access denied.' });
        const storagePath = path.basename(String(file.storagePath || ''));
        const storedPath = path.join(FILE_STORAGE_ROOT, storagePath);
        if (!storagePath || !fs.existsSync(storedPath)) return json(response, 404, { error: 'Stored file is unavailable.' });
        const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
        response.writeHead(200, { 'Content-Type': file.mimeType || 'application/octet-stream', 'Content-Length': fs.statSync(storedPath).size, 'Content-Disposition': `${disposition}; filename="${String(file.fileName || 'download').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(storedPath).pipe(response);
        return;
    }

    const historyMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/history$/);
    if (historyMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(historyMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to view this lead history.' });
        const activities = database.prepare('SELECT a.*, s.name AS user_name, s.role AS user_role FROM lead_activities a LEFT JOIN staff s ON s.id = a.user_id WHERE a.lead_id = ? ORDER BY datetime(a.created_at) DESC').all(leadId);
        const followUps = database.prepare('SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY datetime(due_at) DESC').all(leadId);
        const communications = database.prepare('SELECT * FROM lead_communications WHERE lead_id = ? ORDER BY datetime(created_at) DESC').all(leadId);
        return json(response, 200, { activities, followUps, communications, counts: { activities: activities.length, followUps: followUps.length, communications: communications.length } });
    }

    if (request.method === 'GET' && url.pathname === '/api/staff/assignable') {
        return json(response, 200, { staff: database.prepare("SELECT id, employee_id AS employeeId, name, role, department FROM staff WHERE status = 'Active' ORDER BY name").all() });
    }

    if (url.pathname === '/api/staff' && request.method === 'GET') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can view employee management.' });
        return json(response, 200, { staff: database.prepare("SELECT id, employee_id AS employeeId, name, email, department, designation, login_id AS loginId, google_email AS googleEmail, role, status, account_status AS accountStatus, failed_login_attempts AS failedLoginAttempts, last_login_at AS lastLogin, last_logout_at AS lastLogout, deactivated_at AS deactivatedAt, deactivation_reason AS deactivatedReason, blocked_until AS blockedUntil, reactivated_at AS reactivatedAt, reactivated_by AS reactivatedBy, auth_method AS authMethod, manager_id AS managerId, created_at AS joiningDate FROM staff ORDER BY name").all() });
    }

    if (url.pathname === '/api/staff' && request.method === 'POST') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can create employees.' });
        const body = await parseBody(request);
        const required = ['employeeId', 'name', 'loginId', 'password', 'role'];
        const missing = required.filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: 'Required employee fields are missing.', fields: missing });
        const id = crypto.randomUUID();
        try {
            database.prepare(`INSERT INTO staff (id, employee_id, name, department, designation, login_id, password_hash, role, status, manager_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, body.employeeId, body.name, body.department || null, body.designation || body.role, body.loginId, hashPassword(body.password), body.role, body.status || 'Active', body.managerId || null, now());
        } catch (error) {
            return json(response, 409, { error: 'Employee ID or Login ID already exists.' });
        }
        audit(user, 'Created', 'staff', id, { employeeId: body.employeeId });
        return json(response, 201, { id });
    }

    if (url.pathname === '/api/opportunities' && request.method === 'GET') {
        const rows = database.prepare("SELECT opportunities.*, leads.assigned_to AS lead_owner FROM opportunities JOIN leads ON leads.id = opportunities.lead_id ORDER BY opportunities.updated_at DESC").all().filter((opportunity) => canAccess(user, { assigned_to: opportunity.lead_owner, created_by: opportunity.created_by }));
        return json(response, 200, { opportunities: rows });
    }

    if (url.pathname === '/api/opportunities' && request.method === 'POST') {
        const body = await parseBody(request);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(body.leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this opportunity.' });
        if (lead.stage !== 'Opportunity') return json(response, 422, { error: 'Complete the Opportunity stage before creating an opportunity record.' });
        if (database.prepare('SELECT id FROM opportunities WHERE lead_id = ?').get(lead.id)) return json(response, 409, { error: 'This lead already has an opportunity.' });
        const opportunityId = body.opportunityId || `OPP-${Date.now()}`;
        database.prepare('INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, expected_close_date, probability, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(opportunityId, lead.id, lead.customer_name, body.systemCapacity || null, Number(body.estimatedValue || 0), lead.assigned_to, body.expectedCloseDate || null, Number(body.probability || 0), 'Qualified', user.id, now(), now());
        audit(user, 'Created', 'opportunity', opportunityId, { leadId: lead.id });
        return json(response, 201, { opportunityId });
    }

    const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)$/);
    if (opportunityMatch && request.method === 'PATCH') {
        const opportunityId = decodeURIComponent(opportunityMatch[1]);
        const opportunity = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(opportunityId);
        if (!opportunity) return json(response, 404, { error: 'Opportunity not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(opportunity.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this opportunity.' });
        const body = await parseBody(request);
        const allowedStages = ['Qualified', 'Survey Pending', 'Survey Completed', 'Proposal', 'Negotiation', 'Decision Pending', 'Won', 'Lost'];
        if (!allowedStages.includes(body.stage)) return json(response, 422, { error: 'Invalid opportunity stage.' });
        if (body.stage === 'Lost' && !String(body.lostReason || '').trim()) return json(response, 422, { error: 'Lost Reason is required.' });
        database.prepare('UPDATE opportunities SET stage = ?, lost_reason = ?, status = ?, closing_date = ?, closing_value = ?, closing_remarks = ?, updated_at = ? WHERE id = ?').run(body.stage, body.lostReason || opportunity.lost_reason, body.stage === 'Lost' ? 'Archived' : 'Active', body.closingDate || null, body.closingValue || null, body.closingRemarks || null, now(), opportunityId);
        audit(user, body.stage === 'Lost' ? 'Archived' : 'Status changed', 'opportunity', opportunityId, { previousStage: opportunity.stage, newStage: body.stage, lostReason: body.lostReason || null });
        if (body.stage === 'Won') notify(lead.assigned_to, 'opportunity-won', `Opportunity ${opportunityId} is won and ready for booking.`, 'opportunity', opportunityId);
        return json(response, 200, { opportunityId, stage: body.stage });
    }

    const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
    if (staffMatch && request.method === 'PATCH') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can update employees.' });
        const staffId = decodeURIComponent(staffMatch[1]);
        const body = await parseBody(request);
        const existing = database.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
        if (!existing) return json(response, 404, { error: 'Employee not found.' });
        const requestedAccountStatus = body.accountStatus || (body.status === 'Active' ? 'ACTIVE' : body.status === 'Inactive' ? 'DEACTIVATED' : null);
        if (requestedAccountStatus) {
            if (!['ACTIVE', 'DEACTIVATED', 'DECLINED', 'SUSPENDED', 'PENDING'].includes(requestedAccountStatus)) return json(response, 422, { error: 'Invalid account status.' });
            const timestamp = now();
            const isActive = requestedAccountStatus === 'ACTIVE';
            const isDeclined = requestedAccountStatus === 'DECLINED';
            const reason = body.reason || (isDeclined ? 'Declined by administrator' : 'Deactivated by administrator');
            const blockedUntil = isDeclined ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
            database.prepare('UPDATE staff SET account_status = ?, status = ?, failed_login_attempts = ?, blocked_until = ?, deactivated_at = ?, deactivation_reason = ?, reactivated_at = ?, reactivated_by = ? WHERE id = ?').run(requestedAccountStatus, isActive ? 'Active' : 'Inactive', isActive ? 0 : Number(existing.failed_login_attempts || 0), blockedUntil, isActive ? null : (existing.deactivated_at || timestamp), isActive ? null : reason, isActive ? timestamp : existing.reactivated_at, isActive ? user.id : existing.reactivated_by, staffId);
            if (!isActive) revokeUserSessions(staffId);
            if (isActive) notify(staffId, 'APPROVED', 'Your account has been approved! You can now log in.', 'staff', staffId);
            if (isDeclined) notify(staffId, 'DECLINED', 'Your account was declined. You can try again after 24 hours.', 'staff', staffId);
            audit(user, isActive ? 'Account Reactivated' : isDeclined ? 'Account Declined' : 'Account Manually Deactivated', 'staff', staffId, { adminId: user.id, reason, blockedUntil, result: 'SUCCESS' });
            return json(response, 200, { success: true, message: isActive ? 'Account Reactivated' : isDeclined ? 'User declined successfully.' : 'Account Deactivated' });
        }
        if (body.password) database.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), staffId);
        if (body.googleEmail !== undefined) {
            const email = String(body.googleEmail || '').trim().toLowerCase() || null;
            if (email && database.prepare('SELECT id FROM staff WHERE lower(google_email) = ? AND id <> ?').get(email, staffId)) return json(response, 409, { error: 'Google account is already linked to another employee.' });
            database.prepare('UPDATE staff SET google_email = ? WHERE id = ?').run(email, staffId);
            audit(user, email ? 'Google Account Linked' : 'Google Account Unlinked', 'staff', staffId, { email });
        }
        if (body.status || body.name || body.department || body.role || body.managerId) database.prepare('UPDATE staff SET name = COALESCE(?, name), department = COALESCE(?, department), role = COALESCE(?, role), designation = COALESCE(?, designation), status = COALESCE(?, status), manager_id = COALESCE(?, manager_id) WHERE id = ?').run(body.name || null, body.department || null, body.role || null, body.designation || null, body.status || null, body.managerId || null, staffId);
        audit(user, body.status ? 'Status changed' : body.password ? 'Password reset' : 'Updated', 'staff', staffId, { fields: Object.keys(body) });
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const today = new Date().toISOString().slice(0, 10);
        const period = url.searchParams.get('period') || 'all';
        const periodStart = period === 'week' ? "date('now', 'weekday 1', '-7 days')" : period === 'month' ? "date('now', 'start of month')" : period === 'quarter' ? "date('now', 'start of month', '-' || ((cast(strftime('%m', 'now') as integer) - 1) % 3) || ' months')" : period === 'year' ? "date('now', 'start of year')" : null;
        const dateClause = periodStart ? ` AND date(l.created_at) >= ${periodStart}` : '';
        const opportunityDateClause = periodStart ? ` AND date(created_at) >= ${periodStart}` : '';
        const count = (query, params = []) => database.prepare(query).get(...params).count || 0;
        const totalLeads = count(`SELECT COUNT(*) AS count FROM leads l WHERE l.id IN (${placeholders})${dateClause}`, ids);
        const convertedLeads = count(`SELECT COUNT(DISTINCT l.id) AS count FROM leads l JOIN bookings b ON b.lead_id = l.id WHERE l.id IN (${placeholders})${dateClause} AND b.status = 'Confirmed'`, ids);
        const cycle = database.prepare(`SELECT AVG((julianday(b.created_at) - julianday(l.created_at))) AS average FROM leads l JOIN bookings b ON b.lead_id = l.id WHERE l.id IN (${placeholders})${dateClause} AND b.status = 'Confirmed'`).get(...ids).average;
        const myLeads = ids.filter((id) => database.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(id)?.assigned_to === user.id).length;
        return json(response, 200, {
            metrics: {
                totalLeads,
                newLeads: count(`SELECT COUNT(*) AS count FROM leads l WHERE l.id IN (${placeholders}) AND l.stage = 'New Lead'${dateClause}`, ids),
                convertedLeads,
                conversionRate: totalLeads ? (convertedLeads / totalLeads) * 100 : 0,
                averageCycleDays: cycle === null ? null : cycle,
                myLeads,
                todaysFollowUps: count(`SELECT COUNT(*) AS count FROM follow_ups WHERE lead_id IN (${placeholders}) AND date(due_at) = ? AND status IN ('Pending', 'Scheduled')`, [...ids, today]),
                overdueFollowUps: count(`SELECT COUNT(*) AS count FROM follow_ups WHERE lead_id IN (${placeholders}) AND status = 'Overdue'`, ids),
                todaysSurveys: count(`SELECT COUNT(*) AS count FROM surveys WHERE lead_id IN (${placeholders}) AND survey_date = ? AND status IN ('Scheduled', 'Assigned', 'In Progress')`, [...ids, today]),
                upcomingSurveys: count(`SELECT COUNT(*) AS count FROM surveys WHERE lead_id IN (${placeholders}) AND survey_date > ? AND status IN ('Scheduled', 'Assigned', 'In Progress')`, [...ids, today]),
                opportunities: count(`SELECT COUNT(*) AS count FROM opportunities WHERE lead_id IN (${placeholders}) AND status = 'Active' AND stage NOT IN ('Won', 'Lost')`, ids),
                pipelineValue: database.prepare(`SELECT COALESCE(SUM(estimated_value), 0) AS total FROM opportunities WHERE lead_id IN (${placeholders}) AND status = 'Active' AND stage NOT IN ('Won', 'Lost')${opportunityDateClause}`).get(...ids).total,
                proposals: count(`SELECT COUNT(*) AS count FROM proposals WHERE lead_id IN (${placeholders}) AND status NOT IN ('Rejected', 'Expired')`, ids),
                bookings: count(`SELECT COUNT(*) AS count FROM bookings WHERE lead_id IN (${placeholders})`, ids),
                installationPending: count(`SELECT COUNT(*) AS count FROM installations JOIN projects ON projects.id = installations.project_id WHERE projects.lead_id IN (${placeholders}) AND installations.status = 'Pending'`, ids),
                installationInProgress: count(`SELECT COUNT(*) AS count FROM installations JOIN projects ON projects.id = installations.project_id WHERE projects.lead_id IN (${placeholders}) AND installations.status = 'In Progress'`, ids),
                commissioningPending: count(`SELECT COUNT(*) AS count FROM commissioning JOIN projects ON projects.id = commissioning.project_id WHERE projects.lead_id IN (${placeholders}) AND commissioning.status <> 'Completed'`, ids),
                paymentsPending: count(`SELECT COUNT(*) AS count FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders}) AND paid_amount < total_amount`, ids),
                revenue: database.prepare(`SELECT COALESCE(SUM(paid_amount), 0) AS total FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders})`).get(...ids).total,
                outstandingAmount: database.prepare(`SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS total FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders})`).get(...ids).total
            }
        });
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
        const tasks = accessibleTaskRows(user);
        return json(response, 200, { tasks, counts: { all: tasks.length, upcoming: tasks.filter((task) => task.status === 'PENDING' && new Date(task.dueAt) >= new Date()).length, today: tasks.filter((task) => task.status === 'PENDING' && task.dueAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length, overdue: tasks.filter((task) => task.status === 'OVERDUE').length, completed: tasks.filter((task) => task.status === 'COMPLETED').length, cancelled: tasks.filter((task) => task.status === 'CANCELLED').length } });
    }

    if (request.method === 'GET' && url.pathname === '/api/surveys') {
        const surveys = database.prepare('SELECT s.*, l.lead_number, l.customer_name, l.mobile_number, l.location, l.stage, st.name AS assigned_engineer FROM surveys s JOIN leads l ON l.id = s.lead_id LEFT JOIN staff st ON st.id = s.assigned_to ORDER BY datetime(s.survey_date) ASC').all().filter((survey) => canAccess(user, { assigned_to: survey.assigned_to, created_by: user.id }));
        return json(response, 200, { surveys });
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'PATCH') {
        const taskId = decodeURIComponent(taskMatch[1]);
        const task = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead || !canAddFollowUp(user, lead)) return json(response, 403, { error: 'You do not have permission to update this task.' });
        const body = await parseBody(request);
        const changes = [];
        const values = [];
        if (body.title !== undefined) { changes.push('task_title = ?'); values.push(String(body.title).trim() || taskTitle(task.type)); }
        if (body.notes !== undefined) { changes.push('notes = ?'); values.push(String(body.notes)); }
        if (body.dueAt !== undefined) { if (!String(body.dueAt).trim()) return json(response, 422, { error: 'Due date and time are required.' }); changes.push('due_at = ?'); values.push(body.dueAt); }
        if (body.assignedTo !== undefined) { const employee = database.prepare("SELECT id FROM staff WHERE id = ? AND status = 'Active'").get(body.assignedTo); if (!employee) return json(response, 422, { error: 'Select an active assigned employee.' }); changes.push('assigned_to = ?'); values.push(body.assignedTo); }
        if (body.status === 'CANCELLED') { changes.push("task_status = 'CANCELLED'"); changes.push("status = 'Cancelled'"); }
        if (body.status === 'PENDING') { changes.push("task_status = 'PENDING'"); changes.push("status = 'Scheduled'"); }
        if (!changes.length) return json(response, 422, { error: 'No task changes were provided.' });
        values.push(taskId);
        database.prepare(`UPDATE follow_ups SET ${changes.join(', ')} WHERE id = ?`).run(...values);
        const action = body.status === 'CANCELLED' ? 'Cancelled' : body.dueAt ? 'Rescheduled' : 'Updated';
        audit(user, action, 'follow-up', taskId, { description: `Task ${action.toLowerCase()}.`, previousDueAt: task.due_at, nextDueAt: body.dueAt || task.due_at });
        return json(response, 200, { task: taskRow(database.prepare('SELECT f.*, l.lead_number, l.customer_name, s.name AS assigned_employee FROM follow_ups f JOIN leads l ON l.id = f.lead_id LEFT JOIN staff s ON s.id = f.assigned_to WHERE f.id = ?').get(taskId)) });
    }

    const surveyRecordMatch = url.pathname.match(/^\/api\/surveys\/([^/]+)$/);
    if (surveyRecordMatch && request.method === 'PATCH') {
        const surveyId = decodeURIComponent(surveyRecordMatch[1]);
        const survey = database.prepare('SELECT * FROM surveys WHERE id = ?').get(surveyId);
        const lead = survey && database.prepare('SELECT * FROM leads WHERE id = ?').get(survey.lead_id);
        if (!survey || !lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this site survey.' });
        const body = await parseBody(request);
        const nextStatus = body.status || survey.status;
        if (!['Scheduled', 'Completed', 'Cancelled'].includes(nextStatus)) return json(response, 422, { error: 'Invalid site survey status.' });
        const assignedTo = body.assignedTo || survey.assigned_to;
        const engineer = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(assignedTo);
        if (!engineer) return json(response, 422, { error: 'The selected survey engineer is not active or does not exist.', fields: ['assignedTo'] });
        const dueAt = body.dueAt || body.surveyDate || survey.survey_date;
        const timestamp = now();
        const relatedTask = database.prepare("SELECT * FROM follow_ups WHERE task_related_type = 'survey' AND task_related_id = ?").get(surveyId);
        database.exec('BEGIN');
        try {
            database.prepare('UPDATE surveys SET survey_date = ?, assigned_to = ?, address = ?, remarks = ?, survey_type = ?, status = ?, completed_at = ? WHERE id = ?').run(dueAt, engineer.id, body.address || survey.address, body.remarks || survey.remarks, body.type || survey.survey_type, nextStatus, nextStatus === 'Completed' ? (survey.completed_at || timestamp) : null, surveyId);
            if (nextStatus === 'Completed') database.prepare("UPDATE leads SET stage = 'Site Survey Completed', updated_at = ? WHERE id = ?").run(timestamp, lead.id);
            if (relatedTask) {
                const taskStatus = nextStatus === 'Completed' ? 'COMPLETED' : nextStatus === 'Cancelled' ? 'CANCELLED' : 'PENDING';
                database.prepare('UPDATE follow_ups SET due_at = ?, assigned_to = ?, notes = ?, status = ?, task_status = ?, task_completed_at = ?, task_completed_by = ? WHERE id = ?').run(dueAt, engineer.id, body.remarks || survey.remarks, nextStatus === 'Completed' ? 'Completed' : nextStatus === 'Cancelled' ? 'Cancelled' : 'Scheduled', taskStatus, nextStatus === 'Completed' ? (relatedTask.task_completed_at || timestamp) : null, nextStatus === 'Completed' ? (relatedTask.task_completed_by || user.id) : null, relatedTask.id);
            }
            const action = nextStatus === 'Completed' ? 'Completed' : nextStatus === 'Cancelled' ? 'Cancelled' : dueAt !== survey.survey_date ? 'Rescheduled' : 'Updated';
            audit(user, action, 'survey', surveyId, { previousDate: survey.survey_date, nextDate: dueAt, engineer: engineer.name, description: `Site survey ${action.toLowerCase()}.` });
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Site survey update failed:', error);
            return json(response, 500, { error: 'Unable to update site survey. No changes were saved.' });
        }
        return json(response, 200, { surveyId, status: nextStatus, assignedEngineer: engineer.name, dueAt });
    }

    const completeTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (completeTaskMatch && request.method === 'POST') {
        const taskId = decodeURIComponent(completeTaskMatch[1]);
        const task = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead || !canAddFollowUp(user, lead)) return json(response, 403, { error: 'You do not have permission to complete this task.' });
        const timestamp = now();
        database.prepare("UPDATE follow_ups SET status = 'Completed', task_status = 'COMPLETED', completed_at = COALESCE(completed_at, ?), completed_by = COALESCE(completed_by, ?), task_completed_at = ?, task_completed_by = ? WHERE id = ?").run(timestamp, user.id, timestamp, user.id, taskId);
        audit(user, 'Completed', 'follow-up', taskId, { status: 'COMPLETED', description: `Task completed by ${user.name}.` });
        return json(response, 200, { status: 'COMPLETED', completedAt: timestamp });
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard/groups') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const today = new Date().toISOString().slice(0, 10);
        const query = (sql, params = ids) => database.prepare(sql).all(...params);
        const groups = {
            todaysFollowUps: query(`SELECT f.id, l.id AS lead_id, l.customer_name, l.mobile_number, time(f.due_at) AS due_time FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE l.id IN (${placeholders}) AND date(f.due_at) = ? AND f.status IN ('Pending', 'Scheduled') AND l.stage NOT IN ('Lost', 'Completed') AND l.status = 'Active' ORDER BY datetime(f.due_at)`, [...ids, today]),
            newLeads: query(`SELECT id AS lead_id, customer_name, lead_source, stage FROM leads WHERE id IN (${placeholders}) AND stage = 'New' AND status = 'Active' ORDER BY datetime(created_at) DESC`, ids),
            hotDeals: query(`SELECT o.id AS opportunity_id, l.id AS lead_id, l.customer_name, o.estimated_value, o.probability, l.priority FROM opportunities o JOIN leads l ON l.id = o.lead_id WHERE l.id IN (${placeholders}) AND o.status = 'Active' AND o.stage NOT IN ('Lost', 'Won') AND l.stage NOT IN ('Lost', 'Completed') AND (l.priority IN ('Hot', 'High') OR o.probability >= 70 OR o.stage IN ('Negotiation', 'Decision Pending')) ORDER BY o.estimated_value DESC, o.probability DESC`, ids),
            scheduledSurveys: query(`SELECT s.id AS survey_id, l.id AS lead_id, l.customer_name, s.survey_date, s.survey_type, s.status FROM surveys s JOIN leads l ON l.id = s.lead_id WHERE l.id IN (${placeholders}) AND s.status = 'Scheduled' AND l.stage = 'Site Survey Scheduled' ORDER BY datetime(s.survey_date)`, ids),
            futureInterested: query(`SELECT l.id AS lead_id, l.customer_name, l.mobile_number, l.priority, l.stage, MIN(f.due_at) AS next_follow_up FROM leads l JOIN follow_ups f ON f.lead_id = l.id WHERE l.id IN (${placeholders}) AND l.status = 'Active' AND l.stage = 'Nurturing' AND f.status IN ('Pending', 'Scheduled') AND date(f.due_at) > ? GROUP BY l.id ORDER BY datetime(next_follow_up)`, [...ids, today])
        };
        return json(response, 200, { groups, generatedAt: now() });
    }

    if (request.method === 'GET' && url.pathname === '/api/search') {
        const query = String(url.searchParams.get('q') || '').trim();
        if (!query) return json(response, 200, { results: [] });
        const term = `%${query}%`;
        const results = database.prepare(`SELECT l.id, l.customer_name, l.mobile_number, l.email, l.stage, l.assigned_to, s.name AS assigned_employee FROM leads l LEFT JOIN staff s ON s.id = l.assigned_to WHERE (l.id LIKE ? OR l.customer_name LIKE ? OR l.mobile_number LIKE ? OR l.email LIKE ?) ORDER BY l.updated_at DESC LIMIT 25`).all(term, term, term, term).filter((lead) => canAccess(user, lead)).map((lead) => ({ recordType: 'Lead', id: lead.id, customerName: lead.customer_name, status: lead.stage, assignedEmployee: lead.assigned_employee || 'Unassigned', url: `lead-details.html?lead=${encodeURIComponent(lead.id)}` }));
        return json(response, 200, { results });
    }

    if (request.method === 'GET' && url.pathname === '/api/leads') {
        const rows = database.prepare('SELECT * FROM leads ORDER BY created_at DESC').all().filter((lead) => canAccess(user, lead));
        return json(response, 200, { leads: rows.map(normalizeLead) });
    }

    if (request.method === 'POST' && url.pathname === '/api/leads') {
        const body = await parseBody(request);
        const required = ['customerName', 'mobileNumber', 'leadDate', 'leadSource', 'assignedTo'];
        const missing = required.filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: 'Required fields are missing.', fields: missing });
        const duplicate = database.prepare('SELECT id FROM leads WHERE mobile_number = ? OR (email IS NOT NULL AND email <> ? AND email = ?)').get(body.mobileNumber.trim(), '', body.email || '');
        if (duplicate) return json(response, 409, { error: 'A lead with this mobile number already exists.', existingLeadId: duplicate.id });
        const assignedEmployee = database.prepare("SELECT id FROM staff WHERE id = ? AND status = 'Active'").get(body.assignedTo);
        if (!assignedEmployee) return json(response, 422, { error: 'Please assign this lead to an active employee.' });
        let id;
        do { id = `INP-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`; } while (database.prepare('SELECT id FROM leads WHERE id = ?').get(id));
        const nextLeadNumber = database.prepare("SELECT COALESCE(MAX(CAST(lead_number AS INTEGER)), 100000) + 1 AS nextNumber FROM leads WHERE lead_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'").get().nextNumber;
        if (nextLeadNumber > 999999) return json(response, 422, { error: 'Lead number capacity has been reached.' });
        const timestamp = now();
        const details = { alternateNumber: body.alternateNumber || '', address: body.address || '', city: body.city || '', pincode: body.pincode || '', leadType: body.leadType || '', initialRequirement: body.initialRequirement || '', remarks: body.remarks || '', electricityBill: body.electricityBill || '', monthlyUnits: body.monthlyUnits || '', sanctionedLoad: body.sanctionedLoad || '', requiredSolarCapacity: body.requiredSolarCapacity || '', batteryRequirement: body.batteryRequirement || '', roofType: body.roofType || '', otherInitialRequirements: body.otherInitialRequirements || '' };
        database.exec('BEGIN');
        try {
            database.prepare(`INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, String(nextLeadNumber).padStart(6, '0'), body.customerName.trim(), body.mobileNumber.trim(), body.email || null, body.leadDate, body.leadSource, assignedEmployee.id, 'New', body.leadPriority || 'Warm', details.city || body.location || null, user.id, timestamp, timestamp, JSON.stringify(details));
            audit(user, 'Created', 'lead', id, { stage: 'New', assignedTo: assignedEmployee.id });
            notify(assignedEmployee.id, 'lead-assigned', `New lead ${id} assigned to you.`, 'lead', id);
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            return json(response, 500, { error: 'Unable to create lead. Please try again.' });
        }
        return json(response, 201, { lead: normalizeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(id)) });
    }

    const leadMatch = url.pathname.match(/^\/api\/leads\/([^/]+)$/);
    if (leadMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(leadMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to view this lead.' });
        return json(response, 200, { lead: normalizeLead(lead) });
    }
    const leadActionMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/actions$/);
    if (leadActionMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(leadActionMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to act on this lead.' });
        const body = await parseBody(request);
        const action = body.action;
        const timestamp = now();
        if (action === 'complete-stage') {
            const result = completeStage(user, lead, body);
            if (result.missing) return json(response, 422, { error: 'Cannot complete this stage. Please complete:', missing: result.missing });
            return json(response, 200, { success: true, previousStage: lead.stage, stage: result.nextStage });
        }
        if (action === 'stage') return json(response, 422, { error: 'Stages can only change through Mark Complete after validation.' });
        if (action === 'status') {
            const statuses = ['Active', 'In Progress', 'On Hold', 'Converted', 'Lost', 'Closed'];
            if (!statuses.includes(body.value)) return json(response, 422, { error: 'Invalid lead status.' });
            if (body.value === 'Lost' && !String(body.reason || '').trim()) return json(response, 422, { error: 'Lost Reason is required.' });
            database.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').run(body.value, timestamp, leadId);
            audit(user, 'Status changed', 'lead', leadId, { previous: lead.status, next: body.value, reason: body.reason || null });
            return json(response, 200, { success: true });
        }
        if (action === 'schedule-survey') {
            if (!['Opportunity', 'Site Survey Scheduled'].includes(lead.stage)) return json(response, 422, { error: 'A survey can only be scheduled from the Opportunity or Site Survey Scheduled stage.' });
            const required = ['date', 'time', 'type', 'surveyor', 'address', 'remarks'];
            const missing = required.filter((field) => !String(body[field] || '').trim());
            if (missing.length) return json(response, 422, { error: 'Survey date, time, type, surveyor, address, and remarks are required.', fields: missing });
            const surveyor = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(body.surveyor);
            if (!surveyor) return json(response, 422, { error: 'The selected survey engineer is not active or does not exist.', fields: ['surveyor'] });
            const existingSurvey = database.prepare("SELECT id FROM surveys WHERE lead_id = ? AND status NOT IN ('Cancelled', 'Completed')").get(leadId);
            if (existingSurvey) return json(response, 409, { error: 'This lead already has an active site survey.', surveyId: existingSurvey.id });
            const surveyId = `SUR-${Date.now()}-${Math.floor(Math.random() * 100)}`;
            const taskId = crypto.randomUUID();
            const timestamp = now();
            database.exec('BEGIN');
            try {
                database.prepare('INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, recommended_capacity, remarks, status, survey_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(surveyId, leadId, `${body.date}T${body.time}`, surveyor.id, lead.customer_name, body.address.trim(), 'Pending', 'Pending', 'Pending', 'Pending', body.remarks.trim(), 'Scheduled', body.type);
                database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status, task_related_type, task_related_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(taskId, leadId, `${body.date}T${body.time}`, 'Site Visit', surveyor.id, 'Scheduled', body.remarks.trim(), user.id, timestamp, `Site Survey - ${lead.customer_name}`, 'PENDING', 'survey', surveyId);
                audit(user, 'Scheduled', 'survey', surveyId, { date: body.date, time: body.time, engineer: surveyor.name, description: `Site survey scheduled for ${body.date} at ${body.time}.` });
                audit(user, 'Created', 'follow-up', taskId, { relatedRecordType: 'survey', relatedRecordId: surveyId, description: `Task created for site survey on ${body.date} at ${body.time}.` });
                notify(surveyor.id, 'survey-assigned', `Survey ${surveyId} assigned for lead ${leadId}.`, 'lead', leadId);
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                console.error('Site survey transaction failed:', error);
                return json(response, 500, { error: 'Unable to schedule site survey. No survey or task was saved.' });
            }
            return json(response, 201, { surveyId, taskId, leadNumber: lead.lead_number, assignedEngineer: surveyor.name, status: 'Scheduled' });
        }
        if (action === 'document') {
            if (!String(body.fileName || '').trim() || !String(body.documentType || '').trim() || !body.fileData) return json(response, 422, { error: 'Document type and file are required.' });
            const documentId = `DOC-${Date.now()}`;
            const stored = saveUploadedFile(body);
            try {
                database.prepare('INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(documentId, leadId, body.documentType, stored.originalFileName, user.id, timestamp, stored.storagePath, stored.originalFileName, stored.mimeType, stored.fileSize, 'UPLOADED');
            } catch (error) { removeStoredFile(stored.storagePath); throw error; }
            audit(user, 'Uploaded', 'document', documentId, { fileName: body.fileName, description: `Document uploaded: ${body.fileName}.` });
            return json(response, 201, { documentId });
        }
        if (action === 'note') {
            if (!String(body.note || '').trim()) return json(response, 422, { error: 'Note text is required.' });
            const noteId = `NOTE-${Date.now()}`;
            database.prepare('INSERT INTO lead_notes (id, lead_id, note, category, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(noteId, leadId, body.note, body.category || 'Internal', user.id, timestamp);
            audit(user, 'Added', 'note', noteId, { description: 'Note added to the lead.' });
            return json(response, 201, { noteId });
        }
        if (action === 'quotation') {
            const values = ['subtotal', 'discount', 'gst'].map((field) => Number(body[field]));
            if (values.some((value) => !Number.isFinite(value) || value < 0)) return json(response, 422, { error: 'Quotation amounts must be valid non-negative numbers.' });
            const [subtotal, discount, gst] = values;
            const total = subtotal - discount + gst;
            if (total < 0) return json(response, 422, { error: 'Quotation total cannot be negative.' });
            const quotationId = `QT-${leadId}-${Date.now()}`;
            database.prepare('INSERT INTO quotations (id, lead_id, proposal_id, subtotal, discount, gst, total, payment_terms, validity, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(quotationId, leadId, body.proposalId || null, subtotal, discount, gst, total, body.paymentTerms || '', body.validity || '', user.id, timestamp);
            audit(user, 'Created', 'quotation', quotationId, { total, description: `Quotation ${quotationId} created.` });
            return json(response, 201, { quotationId, total });
        }
        if (['call', 'whatsapp', 'email'].includes(action)) {
            if (action === 'email' && !lead.email) return json(response, 422, { error: 'No email address is available for this lead.' });
            const communicationId = `COM-${Date.now()}`;
            const status = action === 'email' ? 'Attempted' : 'Initiated';
            database.prepare('INSERT INTO lead_communications (id, lead_id, type, recipient, subject, message, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(communicationId, leadId, action, action === 'email' ? lead.email : lead.mobile_number, body.subject || null, body.message || null, status, user.id, timestamp);
            audit(user, `${action} initiated`, 'communication', communicationId, { leadId, status, description: `${action} communication initiated.` });
            return json(response, 201, { communicationId, status, recipient: action === 'email' ? lead.email : lead.mobile_number });
        }
        return json(response, 422, { error: 'Unsupported lead action.' });
    }
    if (leadMatch && request.method === 'PATCH') {
        const leadId = decodeURIComponent(leadMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canEditLead(user, lead)) return json(response, 403, { error: 'You do not have permission to edit this lead.' });
        const body = await parseBody(request);
        if (body.stage) return json(response, 422, { error: 'Stages can only change through Mark Complete after validation.' });
        if (!String(body.customerName || '').trim() || !String(body.mobileNumber || '').trim()) return json(response, 422, { error: 'Customer Name and Mobile Number are mandatory.', fields: ['customerName', 'mobileNumber'] });
        const duplicate = database.prepare('SELECT id FROM leads WHERE mobile_number = ? AND id <> ?').get(body.mobileNumber.trim(), leadId);
        if (duplicate) return json(response, 409, { error: 'This customer already exists in CRM.', existingLeadId: duplicate.id });
        const basicFieldsOnly = ['Booking', 'Installation', 'Completed'].includes(lead.stage);
        const editableFields = basicFieldsOnly ? ['customerName', 'mobileNumber', 'email', 'location'] : ['customerName', 'mobileNumber', 'email', 'leadSource', 'stage', 'leadPriority', 'location'];
        const unexpectedFields = Object.keys(body).filter((field) => !editableFields.includes(field));
        if (unexpectedFields.length) return json(response, 422, { error: basicFieldsOnly ? 'Only basic contact details can be edited after Booking.' : 'Lead ID and creation date cannot be changed.', fields: unexpectedFields });
        if (body.stage && body.stage !== lead.stage) {
            database.prepare('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(user.id, 'Stage changed', 'lead', leadId, JSON.stringify({ previousStage: lead.stage, newStage: body.stage }), now());
        }
        const next = { ...lead, ...body };
        database.prepare(`UPDATE leads SET customer_name = ?, mobile_number = ?, email = ?, lead_source = ?, assigned_to = ?, stage = ?, priority = ?, location = ?, updated_at = ? WHERE id = ?`)
            .run(next.customerName || next.customer_name, next.mobileNumber || next.mobile_number, next.email || null, next.leadSource || next.lead_source, next.assignedTo || next.assigned_to, next.stage || lead.stage, next.leadPriority || next.priority, next.location || null, now(), leadId);
        audit(user, 'Updated', 'lead', leadId, { changedFields: Object.keys(body) });
        if (body.assignedTo && body.assignedTo !== lead.assigned_to) {
            audit(user, 'Reassigned', 'lead', leadId, { previous: lead.assigned_to, next: body.assignedTo });
            notify(body.assignedTo, 'lead-assigned', `Lead ${leadId} was assigned to you.`, 'lead', leadId);
        }
        return json(response, 200, { lead: normalizeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId)) });
    }

    const assignMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/assignment$/);
    if (assignMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(assignMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAssignLead(user)) return json(response, 403, { error: 'Sales Executives cannot assign leads.' });
        const body = await parseBody(request);
        if (!String(body.assignedTo || '').trim()) return json(response, 422, { error: 'Please select an active employee.' });
        const employee = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(body.assignedTo);
        if (!employee) return json(response, 422, { error: 'Select an active assigned employee.' });
        if (employee.id === lead.assigned_to) return json(response, 422, { error: 'This employee already owns the lead.' });
        const previousOwner = lead.assigned_to ? database.prepare('SELECT name FROM staff WHERE id = ?').get(lead.assigned_to)?.name : 'Unassigned';
        const timestamp = now();
        database.exec('BEGIN');
        try {
            const update = database.prepare('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?').run(employee.id, timestamp, leadId);
            if (update.changes !== 1 || database.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(leadId)?.assigned_to !== employee.id) throw new Error('Lead assignment verification failed.');
            audit(user, previousOwner === 'Unassigned' ? 'Assigned' : 'Reassigned', 'lead', leadId, { previousOwner, newOwner: employee.name, assignedBy: user.name, description: `Lead ${lead.lead_number} assigned to ${employee.name}.` });
            notify(employee.id, previousOwner === 'Unassigned' ? 'LEAD_ASSIGNED' : 'LEAD_REASSIGNED', `New lead assigned: Lead #${lead.lead_number} - ${lead.customer_name}.`, 'lead', leadId);
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            return json(response, 500, { error: 'Unable to assign Lead. Please try again.' });
        }
        return json(response, 200, { lead: normalizeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId)) });
    }

    const followUpMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/follow-ups$/);
    if (followUpMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(followUpMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAddFollowUp(user, lead)) return json(response, 403, { error: 'Only the assigned employee or a manager can add follow-ups.' });
        const body = await parseBody(request);
        const missing = ['date', 'time', 'type', 'assignedTo'].filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: 'Follow-up date, time, type, and assigned employee are required.', fields: missing });
        if (!FOLLOW_UP_TYPES.includes(body.type)) return json(response, 422, { error: 'Invalid follow-up type.' });
        const id = crypto.randomUUID();
        database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, leadId, `${body.date}T${body.time}`, body.type, body.assignedTo, 'Scheduled', body.notes || null, user.id, now(), body.taskTitle || taskTitle(body.type), 'PENDING');
        audit(user, 'Created', 'follow-up', id, { leadId, description: `Follow-up scheduled for ${body.date} at ${body.time}.` });
        notify(body.assignedTo, 'follow-up-due', `Follow-up scheduled for lead ${leadId}.`, 'lead', leadId);
        return json(response, 201, { id });
    }

    const completeFollowUpMatch = url.pathname.match(/^\/api\/follow-ups\/([^/]+)\/complete$/);
    if (completeFollowUpMatch && request.method === 'POST') {
        const followUpId = decodeURIComponent(completeFollowUpMatch[1]);
        const followUp = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(followUpId);
        const lead = followUp && database.prepare('SELECT * FROM leads WHERE id = ?').get(followUp.lead_id);
        if (!followUp || !lead || !canAddFollowUp(user, lead)) return json(response, 403, { error: 'Only the assigned employee or a manager can complete this follow-up.' });
        const body = await parseBody(request);
        if (!String(body.remarks || '').trim() || !String(body.nextAction || '').trim()) return json(response, 422, { error: 'Remarks and next action are required to complete a follow-up.', fields: ['remarks', 'nextAction'] });
        database.prepare('UPDATE follow_ups SET status = ?, task_status = ?, notes = ?, outcome = ?, completed_at = ?, completed_by = ?, task_completed_at = ?, task_completed_by = ? WHERE id = ?').run('Completed', 'COMPLETED', `${body.remarks.trim()} | Next action: ${body.nextAction.trim()}`, body.outcome || body.customerResponse || null, now(), user.id, now(), user.id, followUpId);
        audit(user, 'Completed', 'follow-up', followUpId, { status: 'Completed', remarks: body.remarks.trim(), nextAction: body.nextAction.trim(), description: `Follow-up completed. Outcome: ${body.outcome || body.customerResponse || 'Recorded'}.` });
        return json(response, 200, { status: 'Completed' });
    }

    const surveyMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/survey$/);
    if (surveyMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(surveyMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this survey.' });
        const body = await parseBody(request);
        if (!['Site Survey Scheduled', 'Opportunity'].includes(lead.stage)) return json(response, 422, { error: 'Survey updates are only allowed for an active survey workflow.' });
        if (body.status === 'Completed' && lead.stage !== 'Site Survey Scheduled') return json(response, 422, { error: 'Schedule the survey before completing it.' });
        const existingSurvey = database.prepare('SELECT * FROM surveys WHERE lead_id = ?').get(leadId);
        let leadDetails = {};
        try { leadDetails = lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { leadDetails = {}; }
        const inherited = { customer: lead.customer_name, address: leadDetails.address || lead.location, ...existingSurvey };
        const surveyData = { ...inherited, ...body };
        const required = ['customer', 'address', 'surveyDate', 'sanctionedLoad', 'electricityDetails', 'roofInformation', 'recommendedCapacity', 'remarks'];
        const missing = required.filter((field) => !String(surveyData[field] || '').trim() || surveyData[field] === 'Pending');
        if (body.status === 'Completed' && missing.length) return json(response, 422, { error: 'Survey cannot be completed until required information is provided.', fields: missing });
        if (body.feasibility === 'Site Not Feasible' && !String(body.remarks || '').trim()) return json(response, 422, { error: 'A reason is required when the site is not feasible.', fields: ['remarks'] });
        const status = body.status === 'Completed' ? 'Completed' : 'Scheduled';
        const existing = existingSurvey?.id;
        if (existing) database.prepare(`UPDATE surveys SET survey_date = ?, assigned_to = ?, customer = ?, address = ?, sanctioned_load = ?, electricity_details = ?, roof_information = ?, feasibility = ?, recommended_capacity = ?, remarks = ?, status = ?, completed_at = ? WHERE lead_id = ?`).run(surveyData.surveyDate, surveyData.assignedTo, surveyData.customer, surveyData.address, surveyData.sanctionedLoad, surveyData.electricityDetails, surveyData.roofInformation, surveyData.feasibility || null, surveyData.recommendedCapacity, surveyData.remarks, status, status === 'Completed' ? now() : null, leadId);
        else database.prepare(`INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, feasibility, recommended_capacity, remarks, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), leadId, surveyData.surveyDate, surveyData.assignedTo, surveyData.customer, surveyData.address, surveyData.sanctionedLoad, surveyData.electricityDetails, surveyData.roofInformation, surveyData.feasibility || null, surveyData.recommendedCapacity, surveyData.remarks, status);
        const nextStage = status === 'Completed' ? 'Site Survey Completed' : lead.stage;
        if (status === 'Completed') database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(nextStage, now(), leadId);
        const surveyRecord = database.prepare('SELECT id FROM surveys WHERE lead_id = ?').get(leadId);
        audit(user, status === 'Completed' ? 'Completed' : 'Updated', 'survey', surveyRecord?.id, { stage: nextStage, description: status === 'Completed' ? 'Site survey completed.' : 'Site survey updated.' });
        notify(body.assignedTo, 'survey-assigned', `Site survey ${status.toLowerCase()} for lead ${leadId}.`, 'lead', leadId);
        return json(response, 200, { stage: nextStage });
    }

    const proposalMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/proposals$/);
    if (proposalMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(proposalMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        const survey = database.prepare("SELECT * FROM surveys WHERE lead_id = ? AND status = 'Completed'").get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this proposal.' });
        if (!survey || lead.stage !== 'Site Survey Completed') return json(response, 422, { error: 'Proposal can be created only after the survey is completed.' });
        const body = await parseBody(request);
        const proposalId = body.proposalId || `PROP-${Date.now()}`;
        database.prepare('INSERT INTO proposals (id, lead_id, survey_id, amount, discount, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(proposalId, leadId, survey.id, Number(body.amount || 0), Number(body.discount || 0), 'Sent', user.id, now());
        audit(user, 'Created', 'proposal', proposalId, { leadId, surveyId: survey.id });
        return json(response, 201, { proposalId, stage: lead.stage });
    }

    const bookingMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/booking$/);
    if (bookingMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(bookingMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this booking.' });
        if (lead.stage !== 'Site Survey Completed') return json(response, 422, { error: 'Booking is allowed only after a feasible completed site survey.' });
        const body = await parseBody(request);
        const proposal = database.prepare('SELECT * FROM proposals WHERE id = ? AND lead_id = ?').get(body.proposalId, leadId);
        if (!proposal) return json(response, 422, { error: 'Booking must be created from a valid proposal.' });
        const existing = database.prepare('SELECT id FROM projects WHERE lead_id = ?').get(leadId);
        if (existing) return json(response, 409, { error: 'This lead already has a project.', projectId: existing.id });
        const projectId = body.projectId || `PROJ-${Date.now()}`;
        database.prepare('INSERT INTO projects (id, lead_id, proposal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, leadId, proposal.id, 'Booked', now(), now());
        database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run('Order Booked', now(), leadId);
        audit(user, 'Created', 'project', projectId, { leadId, proposalId: proposal.id });
        return json(response, 201, { projectId, stage: 'Order Booked' });
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && request.method === 'PATCH') {
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) return json(response, 404, { error: 'Project not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this project.' });
        const body = await parseBody(request);
        const projectStages = ['Booked', 'Design', 'Material', 'Installation Scheduled', 'Installation', 'Installed', 'BESCOM', 'Commissioning', 'Completed'];
        if (!projectStages.includes(body.status)) return json(response, 422, { error: 'Invalid project status.' });
        if (body.status === 'BESCOM' && project.status !== 'Installed') return json(response, 422, { error: 'Only installed projects can move to BESCOM.' });
        database.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(body.status, now(), projectId);
        const leadStage = body.status === 'BESCOM' ? 'BESCOM' : body.status === 'Commissioning' ? 'Commissioned' : body.status === 'Completed' ? 'Completed' : body.status === 'Installation' || body.status === 'Installed' ? 'Installation' : lead.stage;
        database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(leadStage, now(), lead.id);
        audit(user, 'Status changed', 'project', projectId, { previousStatus: project.status, newStatus: body.status, remarks: body.remarks || '' });
        return json(response, 200, { projectId, status: body.status, leadStage });
    }

    const paymentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/payments$/);
    if (paymentMatch && request.method === 'POST') {
        const projectId = decodeURIComponent(paymentMatch[1]);
        const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) return json(response, 404, { error: 'Project not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to add payment.' });
        const body = await parseBody(request);
        const totalAmount = Number(body.totalAmount);
        const paidAmount = Number(body.paidAmount);
        if (!Number.isFinite(totalAmount) || !Number.isFinite(paidAmount) || totalAmount < 0 || paidAmount < 0) return json(response, 422, { error: 'Payment amounts must be valid non-negative numbers.' });
        if (paidAmount > totalAmount && user.role !== 'Admin/Owner') return json(response, 422, { error: 'Paid amount cannot exceed total amount.' });
        const paymentId = crypto.randomUUID();
        database.prepare('INSERT INTO payments (id, project_id, total_amount, paid_amount, payment_date, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(paymentId, projectId, totalAmount, paidAmount, body.paymentDate || now().slice(0, 10), body.notes || null, user.id, now());
        audit(user, 'Payment added', 'project', projectId, { paymentId, totalAmount, paidAmount, pendingAmount: totalAmount - paidAmount });
        return json(response, 201, { paymentId, totalAmount, paidAmount, pendingAmount: totalAmount - paidAmount });
    }

    const auditMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/audit$/);
    if (auditMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(auditMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to view this audit history.' });
        return json(response, 200, { events: database.prepare('SELECT audit_logs.*, staff.name AS user_name FROM audit_logs LEFT JOIN staff ON staff.id = audit_logs.user_id WHERE record_id = ? ORDER BY created_at DESC').all(leadId) });
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications') {
        return json(response, 200, { notifications: database.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(user.id) });
    }

    const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notificationMatch && request.method === 'POST') {
        const notificationId = decodeURIComponent(notificationMatch[1]);
        database.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), notificationId, user.id);
        return json(response, 200, { success: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/read-all') {
        database.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/profile') {
        const profile = database.prepare('SELECT id, employee_id AS employeeId, name, department, designation, role, status, manager_id AS managerId, created_at AS joiningDate FROM staff WHERE id = ?').get(user.id);
        if (!profile) return json(response, 404, { error: 'Unable to load profile.' });
        return json(response, 200, { profile });
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/password') {
        const body = await parseBody(request);
        const staff = database.prepare('SELECT password_hash FROM staff WHERE id = ?').get(user.id);
        if (!staff || !verifyPassword(body.currentPassword, staff.password_hash)) return json(response, 422, { error: 'Current password is incorrect.' });
        if (!String(body.newPassword || '').match(/^(?=.*[A-Za-z])(?=.*\d).{8,}$/)) return json(response, 422, { error: 'New password must be at least 8 characters and include a letter and number.' });
        if (body.newPassword !== body.confirmPassword) return json(response, 422, { error: 'New password and confirmation do not match.' });
        database.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), user.id);
        audit(user, 'Password changed', 'staff', user.id);
        return json(response, 200, { message: 'Password changed successfully.' });
    }

    return json(response, 404, { error: 'API route not found.' });
}

function serveStatic(request, response, url) {
    let requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(ROOT, requested));
    if (!filePath.startsWith(ROOT)) return json(response, 403, { error: 'Forbidden.' });
    fs.readFile(filePath, (error, content) => {
        if (error) return json(response, 404, { error: 'File not found.' });
        const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'X-Robots-Tag': 'noindex, nofollow, noarchive'
        });
        response.end(content);
    });
}

initializeDatabase();
http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
        else serveStatic(request, response, url);
    } catch (error) {
        console.error(error);
        json(response, 500, { error: error.message || 'Internal server error.' });
    }
}).listen(PORT, () => console.log(`INPACE POWER CRM server running at http://localhost:${PORT}`));
