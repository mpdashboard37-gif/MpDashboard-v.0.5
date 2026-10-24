const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { SqliteAdapter } = require('../database/sqlite-adapter');
const { LeadRepository } = require('../repositories/lead-repository');
const { canImportLeads, createBulkLeadImportService } = require('./bulk-lead-import-service');
const {
    IMPORT_COLUMNS,
    MAX_IMPORT_BYTES,
    assignRoundRobin,
    parseLeadFile,
    splitImportBatches,
    toSafeCsv,
    validateLeadRows
} = require('./lead-import');

function sheetBuffer(bookType, rows) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Leads');
    return XLSX.write(workbook, { type: 'buffer', bookType });
}

function validRow(rowNumber, overrides = {}) {
    return {
        rowNumber,
        'Customer Name': `Synthetic Customer ${rowNumber}`,
        'Contact Number': `9${String(rowNumber).padStart(9, '0')}`,
        'Email ID': `customer${rowNumber}@example.test`,
        'Customer Address': `Synthetic address ${rowNumber}`,
        Pincode: '560001',
        ...overrides
    };
}

test('parses CSV, XLSX, and XLS while preserving text-formatted contact and pincode values', () => {
    const source = [
        IMPORT_COLUMNS,
        ['Asha Synthetic', '9876543210', 'asha@example.test', '  Mysuru Road  ', '005601']
    ];
    const csv = Buffer.from('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\nAsha Synthetic,9876543210,asha@example.test,"  Mysuru Road  ",005601\r\n');
    for (const [buffer, filename] of [
        [csv, 'leads.csv'],
        [sheetBuffer('xlsx', source), 'leads.xlsx'],
        [sheetBuffer('xls', source), 'leads.xls']
    ]) {
        const rows = parseLeadFile(buffer, filename);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]['Contact Number'], '9876543210');
        assert.equal(rows[0].Pincode, '005601');
        assert.equal(rows[0]['Customer Address'], 'Mysuru Road');
    }
});

test('rejects unsupported or mislabeled formats, missing columns, and excessive rows', () => {
    assert.throws(() => parseLeadFile(Buffer.alloc(MAX_IMPORT_BYTES + 1), 'leads.csv'), /5 MB limit/);
    assert.throws(() => parseLeadFile(Buffer.from('hello'), 'leads.xlsx'), /contents do not match/);
    assert.throws(() => parseLeadFile(Buffer.from('a,b,c'), 'leads.txt'), /Unsupported file type/);
    const missing = sheetBuffer('xlsx', [['Customer Name', 'Contact Number'], ['A', '9876543210']]);
    assert.throws(() => parseLeadFile(missing, 'leads.xlsx'), /Missing required columns: Email ID, Customer Address, Pincode/);
    const tooManyRows = sheetBuffer('xlsx', [IMPORT_COLUMNS, ...Array.from({ length: 10001 }, (_, index) => [`Name ${index}`, '9876543210', '', '', ''])]);
    assert.throws(() => parseLeadFile(tooManyRows, 'leads.xlsx'), /10000 row limit/);
});

test('validates required fields, Indian mobile numbers, email, pincode, and existing duplicates', () => {
    const rows = validateLeadRows([
        validRow(2, { 'Contact Number': '1234' }),
        validRow(3, { 'Email ID': 'not-an-email', Pincode: '056001' }),
        validRow(4, { 'Contact Number': '+91 98765 43210' }),
        validRow(5, { 'Customer Name': '', 'Contact Number': '' })
    ], [{ mobile_number: '9876543210', email: 'existing@example.test' }]);
    assert.equal(rows[0].errors[0], 'Contact Number must be a valid 10-digit Indian mobile number.');
    assert.ok(rows[1].errors.includes('Email ID must be a valid email address.'));
    assert.ok(rows[1].errors.includes('Pincode must be a valid 6-digit Indian pincode.'));
    assert.equal(rows[2].duplicateReason, 'A lead with this contact number already exists.');
    assert.deepEqual(rows[3].errors, ['Customer Name is required.', 'Contact Number is required.']);
});

test('flags duplicate uploaded contacts and emails with spreadsheet row numbers', () => {
    const rows = validateLeadRows([
        validRow(2),
        validRow(3, { 'Contact Number': '+91 9000000002' }),
        validRow(4, { 'Contact Number': '9000000004', 'Email ID': 'customer2@example.test' })
    ]);
    assert.equal(rows[1].duplicateReason, 'Duplicate contact number within this file.');
    assert.equal(rows[2].duplicateReason, 'Duplicate email address within this file.');
    assert.equal(rows[1].rowNumber, 3);
});

test('limits database batches to 500 records at the 500/501 row boundary', () => {
    assert.deepEqual(splitImportBatches(Array.from({ length: 500 }, (_, index) => index)).map((batch) => batch.length), [500]);
    assert.deepEqual(splitImportBatches(Array.from({ length: 501 }, (_, index) => index)).map((batch) => batch.length), [500, 1]);
});

test('keeps deterministic round-robin assignments across batch boundaries', () => {
    const staff = [{ id: 'C' }, { id: 'A' }, { id: 'B' }];
    const firstBatch = assignRoundRobin(Array.from({ length: 500 }, (_, index) => ({ rowNumber: index + 2 })), staff);
    const secondBatch = assignRoundRobin([{ rowNumber: 502 }], staff, firstBatch.length);
    assert.equal(firstBatch[0].assignedTo, 'A');
    assert.equal(firstBatch[1].assignedTo, 'B');
    assert.equal(firstBatch[2].assignedTo, 'C');
    assert.equal(secondBatch[0].assignedTo, 'C');
    assert.throws(() => assignRoundRobin([{ rowNumber: 2 }], []), /No eligible active sales employees/);
});

test('quotes and neutralizes spreadsheet formulas in exported issue reports', () => {
    const csv = toSafeCsv([{ rowNumber: 2, customerName: '=HYPERLINK("bad")', mobileNumber: '+123', email: '@sum', address: 'ok', pincode: '560001', errors: ['bad'] }]);
    assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
    assert.match(csv, /"'\+123"/);
    assert.match(csv, /"'@sum"/);
});

test('authorizes bulk imports only for the existing Admin/Owner role', () => {
    assert.equal(canImportLeads({ role: 'Admin/Owner' }), true);
    assert.equal(canImportLeads({ role: 'Sales Manager' }), false);
    assert.equal(canImportLeads({ role: 'Sales Executive' }), false);
    assert.equal(canImportLeads(null), false);
});

function createTestDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-lead-import-'));
    const database = new SqliteAdapter(path.join(directory, 'test.sqlite'));
    database.connection.exec(`
        CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT, designation TEXT, role TEXT, status TEXT, account_status TEXT);
        CREATE TABLE leads (
            id TEXT PRIMARY KEY, lead_number TEXT UNIQUE, customer_name TEXT NOT NULL, mobile_number TEXT NOT NULL UNIQUE,
            email TEXT, lead_date TEXT NOT NULL, lead_source TEXT NOT NULL, assigned_to TEXT, stage TEXT NOT NULL,
            priority TEXT, location TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            details_json TEXT, lead_score INTEGER, lead_category TEXT, monthly_bill REAL, property_type TEXT,
            roof_available TEXT, interested_in_solar TEXT, decision_maker TEXT, bengaluru_zone TEXT
        );
        CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, record_type TEXT, record_id TEXT, details TEXT, created_at TEXT);
        CREATE TABLE lead_activities (id TEXT PRIMARY KEY, lead_id TEXT, activity_type TEXT, title TEXT, description TEXT, user_id TEXT, related_record_type TEXT, related_record_id TEXT, created_at TEXT);
        CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, message TEXT, record_type TEXT, record_id TEXT, created_at TEXT);
        CREATE TABLE lead_imports (
            id TEXT PRIMARY KEY, user_id TEXT, status TEXT, source_filename TEXT, total_rows INTEGER,
            processed_rows INTEGER, created_count INTEGER, duplicate_count INTEGER, failed_count INTEGER,
            rows_json TEXT, error_message TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE lead_import_lock (id INTEGER PRIMARY KEY, job_id TEXT);
    `);
    return { directory, database };
}

function seedJob(database, rows, id = crypto.randomUUID()) {
    const timestamp = new Date().toISOString();
    database.prepare('INSERT INTO staff (id, name, designation, role, status, account_status) VALUES (?, ?, ?, ?, ?, ?)').run('importer', 'Synthetic Importer', 'Owner', 'Admin/Owner', 'Active', 'ACTIVE');
    for (const [employeeId, role, status, accountStatus] of [
        ['A', 'Sales Executive', 'Active', 'ACTIVE'],
        ['B', 'Sales Manager', 'Active', 'ACTIVE'],
        ['C', 'Telecaller', 'Active', 'ACTIVE']
    ]) {
        database.prepare('INSERT INTO staff (id, name, designation, role, status, account_status) VALUES (?, ?, ?, ?, ?, ?)').run(employeeId, employeeId, role, role, status, accountStatus);
    }
    const invalidCount = rows.filter((row) => row.errors?.length).length;
    const duplicateCount = rows.filter((row) => row.duplicateReason).length;
    database.prepare('INSERT INTO lead_imports (id, user_id, status, source_filename, total_rows, processed_rows, created_count, duplicate_count, failed_count, rows_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)')
        .run(id, 'importer', 'PROCESSING', 'synthetic.csv', rows.length, rows.filter((row) => !row.valid).length, duplicateCount, invalidCount, JSON.stringify(rows), timestamp, timestamp);
    database.prepare('INSERT INTO lead_import_lock (id, job_id) VALUES (1, ?)').run(id);
    return id;
}

test('commits 501 records once with round-robin continuity and accurate final progress, including concurrent workers', async (t) => {
    const { directory, database } = createTestDatabase();
    t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const id = seedJob(database, Array.from({ length: 501 }, (_, index) => {
        const raw = validRow(index + 2);
        return { ...validateLeadRows([raw])[0] };
    }));
    const repository = new SqliteAdapter(path.join(directory, 'test.sqlite'));
    const leadRepository = new LeadRepository(repository);
    const firstWorker = createBulkLeadImportService(repository, leadRepository);
    const secondWorker = createBulkLeadImportService(repository, leadRepository);
    await Promise.all([firstWorker.process(id), secondWorker.process(id)]);
    await secondWorker.process(id);
    const job = await repository.get('SELECT * FROM lead_imports WHERE id = ?', [id]);
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.total_rows, 501);
    assert.equal(job.processed_rows, 501);
    assert.equal(job.created_count, 501);
    assert.equal(job.duplicate_count, 0);
    assert.equal(job.failed_count, 0);
    assert.equal((await repository.get('SELECT COUNT(*) AS count FROM leads')).count, 501);
    const assignments = await repository.all('SELECT customer_name, assigned_to FROM leads ORDER BY CAST(substr(customer_name, 20) AS INTEGER)');
    assert.equal(assignments.length, 501);
    assert.deepEqual(assignments.slice(0, 3).map((row) => row.assigned_to), ['A', 'B', 'C']);
    assert.equal(assignments[500].assigned_to, 'C');
    assert.equal(await repository.get('SELECT id FROM lead_import_lock WHERE job_id = ?', [id]), undefined);
    await repository.close();
});

test('records a partial outcome when there are invalid and duplicate rows', async (t) => {
    const { directory, database } = createTestDatabase();
    t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const good = validateLeadRows([validRow(2)])[0];
    const invalid = { ...validateLeadRows([validRow(3, { 'Contact Number': '123' })])[0], outcome: 'failed' };
    const duplicate = { ...validateLeadRows([validRow(4)])[0], duplicateReason: 'A lead with this contact number already exists.', valid: false, outcome: 'duplicate' };
    const id = seedJob(database, [good, invalid, duplicate]);
    const repository = new SqliteAdapter(path.join(directory, 'test.sqlite'));
    await createBulkLeadImportService(repository, new LeadRepository(repository)).process(id);
    const job = await repository.get('SELECT status, total_rows, processed_rows, created_count, duplicate_count, failed_count FROM lead_imports WHERE id = ?', [id]);
    assert.deepEqual({ ...job }, { status: 'PARTIAL', total_rows: 3, processed_rows: 3, created_count: 1, duplicate_count: 1, failed_count: 1 });
    await repository.close();
});

test('rolls back a failed batch without counting uncommitted leads as successful', async (t) => {
    const { directory, database } = createTestDatabase();
    t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const id = seedJob(database, [validateLeadRows([validRow(2)])[0]]);
    const repository = new SqliteAdapter(path.join(directory, 'test.sqlite'));
    const leadRepository = new LeadRepository(repository);
    let failFirstTransaction = true;
    const failingRepository = {
        get: (...args) => repository.get(...args),
        run: (...args) => repository.run(...args),
        all: (...args) => repository.all(...args),
        transaction: (work) => {
            if (failFirstTransaction) {
                failFirstTransaction = false;
                return repository.transaction(async (tx) => {
                    await work(tx);
                    throw new Error('synthetic transaction failure');
                });
            }
            return repository.transaction(work);
        }
    };
    await createBulkLeadImportService(failingRepository, leadRepository).process(id);
    const job = await repository.get('SELECT status, created_count, failed_count FROM lead_imports WHERE id = ?', [id]);
    assert.deepEqual({ ...job }, { status: 'PARTIAL', created_count: 0, failed_count: 1 });
    assert.equal((await repository.get('SELECT COUNT(*) AS count FROM leads')).count, 0);
    await repository.close();
});

test('fails rows clearly when no active sales employees are available', async (t) => {
    const { directory, database } = createTestDatabase();
    t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const id = seedJob(database, [validateLeadRows([validRow(2)])[0]]);
    database.prepare("UPDATE staff SET status = 'Inactive' WHERE id IN ('A', 'B', 'C')").run();
    const repository = new SqliteAdapter(path.join(directory, 'test.sqlite'));
    await createBulkLeadImportService(repository, new LeadRepository(repository)).process(id);
    const job = await repository.get('SELECT status, created_count, failed_count, error_message FROM lead_imports WHERE id = ?', [id]);
    assert.equal(job.status, 'PARTIAL');
    assert.equal(job.created_count, 0);
    assert.equal(job.failed_count, 1);
    assert.match(job.error_message, /No eligible active sales employees/);
    await repository.close();
});
