const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { after, before, test } = require('node:test');

let baseUrl;
let child;
let tempDir;
let logs = '';
let adminCookie;
let employeeCookie;
const adminPassword = `Synthetic-${crypto.randomBytes(24).toString('hex')}`;
const employeePassword = `Synthetic-${crypto.randomBytes(24).toString('hex')}`;
const leadId = 'synthetic-lead-database-id';
const leadNumber = 'INP-900001';

function freePort() {
    return new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const { port } = listener.address();
            listener.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function passwordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

async function login(loginId, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ loginId, password })
    });
    assert.equal(response.status, 200, `Login failed: ${await response.text()}`);
    return (response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function assignmentRequest(id, assignedTo, cookie = adminCookie) {
    return fetch(`${baseUrl}/api/leads/${encodeURIComponent(id)}/assignment`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ assignedTo })
    });
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-crm-lead-assignment-'));
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['-e', "require('./server.js');"], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            DATABASE_MODE: 'sqlite',
            SQLITE_DB_PATH: path.join(tempDir, 'crm.sqlite'),
            CRM_FILE_STORAGE_ROOT: path.join(tempDir, 'crm-files'),
            SESSION_SECRET: 'synthetic-lead-assignment-session-secret',
            ADMIN_INITIAL_PASSWORD: adminPassword,
            CORS_ORIGIN: baseUrl,
            GOOGLE_CLIENT_ID: '',
            GOOGLE_CLIENT_SECRET: '',
            PASSWORD_RESET_BASE_URL: `${baseUrl}/login.html`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Test server failed to start.\n${logs}`);
        try {
            const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                ready = true;
                break;
            }
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    if (!ready) throw new Error(`Timed out waiting for the test server.\n${logs}`);

    const database = new DatabaseSync(path.join(tempDir, 'crm.sqlite'));
    const timestamp = new Date().toISOString();
    const insertStaff = database.prepare(`INSERT INTO staff
        (id, employee_id, name, department, designation, login_id, password_hash, role, status, account_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertStaff.run('assignment-employee-a', 'SYN-A', 'Synthetic Sales A', 'Sales', 'Sales Executive', 'sales-a@test.invalid', passwordHash('unused-a'), 'Sales Executive', 'Active', 'ACTIVE', timestamp);
    insertStaff.run('assignment-employee-b', 'SYN-B', 'Synthetic Sales B', 'Sales', 'Sales Executive', 'sales-b@test.invalid', passwordHash('unused-b'), 'Sales Executive', 'Active', 'ACTIVE', timestamp);
    insertStaff.run('assignment-employee-c', 'SYN-C', 'Synthetic Sales C', 'Sales', 'Sales Executive', 'sales-c@test.invalid', passwordHash('unused-c'), 'Sales Executive', 'Active', 'ACTIVE', timestamp);
    insertStaff.run('assignment-disabled-account', 'SYN-D', 'Synthetic Disabled Account', 'Sales', 'Sales Executive', 'sales-d@test.invalid', passwordHash('unused-d'), 'Sales Executive', 'Active', 'DEACTIVATED', timestamp);
    insertStaff.run('assignment-inactive', 'SYN-I', 'Synthetic Inactive', 'Sales', 'Sales Executive', 'sales-i@test.invalid', passwordHash(employeePassword), 'Sales Executive', 'Inactive', 'DEACTIVATED', timestamp);
    insertStaff.run('assignment-engineer', 'SYN-E', 'Synthetic Engineer', 'Operations', 'Engineer', 'engineer@test.invalid', passwordHash('unused-e'), 'Engineer', 'Active', 'ACTIVE', timestamp);
    insertStaff.run('assignment-user', 'SYN-U', 'Synthetic Sales User', 'Sales', 'Sales Executive', 'assignment-user@test.invalid', passwordHash(employeePassword), 'Sales Executive', 'Active', 'ACTIVE', timestamp);
    database.prepare(`INSERT INTO leads
        (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
        .run(leadId, leadNumber, 'Synthetic Assignment Customer', '9876543210', 'assignment-customer@test.invalid', timestamp.slice(0, 10), 'Website', 'New', 'Warm', 'Synthetic Address', 'staff-admin', timestamp, timestamp);
    database.close();

    adminCookie = await login('varunkv@inpacepower.com', adminPassword);
    employeeCookie = await login('assignment-user@test.invalid', employeePassword);
});

after(async () => {
    if (child && child.exitCode === null) {
        const closed = new Promise((resolve) => child.once('close', resolve));
        child.kill('SIGTERM');
        await Promise.race([
            closed,
            new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
    }
    if (tempDir) {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});

test('assigns and reassigns a lead by database ID with durable owner details and idempotent retries', async () => {
    const employeesResponse = await fetch(`${baseUrl}/api/staff/assignable`, { headers: { Cookie: adminCookie } });
    assert.equal(employeesResponse.status, 200);
    const availableStaff = (await employeesResponse.json()).staff;
    assert.ok(availableStaff.some((employee) => employee.id === 'assignment-employee-a' && employee.name === 'Synthetic Sales A'));
    assert.equal(availableStaff.some((employee) => employee.id === 'assignment-disabled-account'), false);
    assert.equal(availableStaff.some((employee) => employee.id === 'assignment-inactive'), false);

    const byDisplayNumber = await fetch(`${baseUrl}/api/leads/${leadNumber}`, { headers: { Cookie: adminCookie } });
    assert.equal(byDisplayNumber.status, 200);
    const loadedLead = (await byDisplayNumber.json()).lead;
    assert.equal(loadedLead.leadId, leadId);
    assert.equal((await assignmentRequest(leadNumber, 'assignment-employee-a')).status, 404);

    const firstAssignment = await assignmentRequest(loadedLead.leadId, 'assignment-employee-a');
    assert.equal(firstAssignment.status, 200);
    const firstResult = (await firstAssignment.json()).lead;
    assert.equal(firstResult.assignedTo, 'assignment-employee-a');
    assert.equal(firstResult.assignedEmployee, 'Synthetic Sales A');
    assert.equal(firstResult.owner.id, 'assignment-employee-a');

    const persistedLead = await fetch(`${baseUrl}/api/leads/${leadId}`, { headers: { Cookie: adminCookie } }).then((response) => response.json());
    assert.equal(persistedLead.lead.assignedTo, 'assignment-employee-a');
    assert.equal(persistedLead.lead.assignedEmployee, 'Synthetic Sales A');

    const databasePath = path.join(tempDir, 'crm.sqlite');
    let database = new DatabaseSync(databasePath);
    const countsBeforeRetry = {
        audit: database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE record_type = 'lead' AND record_id = ? AND action IN ('Assigned', 'Reassigned')").get(leadId).count,
        notifications: database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE record_type = 'lead' AND record_id = ? AND type IN ('LEAD_ASSIGNED', 'LEAD_REASSIGNED')").get(leadId).count
    };
    database.close();

    const concurrentReassignments = await Promise.all([
        assignmentRequest(leadId, 'assignment-employee-b'),
        assignmentRequest(leadId, 'assignment-employee-b')
    ]);
    assert.deepEqual(concurrentReassignments.map((response) => response.status), [200, 200]);
    const concurrentResults = await Promise.all(concurrentReassignments.map((response) => response.json()));
    assert.ok(concurrentResults.some((result) => result.unchanged));
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE record_type = 'lead' AND record_id = ? AND action IN ('Assigned', 'Reassigned')").get(leadId).count, countsBeforeRetry.audit + 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE record_type = 'lead' AND record_id = ? AND type IN ('LEAD_ASSIGNED', 'LEAD_REASSIGNED')").get(leadId).count, countsBeforeRetry.notifications + 1);
    database.close();

    const repeatedAssignment = await assignmentRequest(leadId, 'assignment-employee-b');
    assert.equal(repeatedAssignment.status, 200);
    const repeatedResult = await repeatedAssignment.json();
    assert.equal(repeatedResult.unchanged, true);
    const reassignedLead = repeatedResult.lead;
    assert.equal(reassignedLead.assignedTo, 'assignment-employee-b');
    assert.equal(reassignedLead.assignedEmployee, 'Synthetic Sales B');
    assert.equal(reassignedLead.owner.name, 'Synthetic Sales B');
});

test('rejects invalid, inactive, ineligible, missing-lead, and unauthorized assignments', async () => {
    for (const [id, status] of [
        ['missing-lead', 404],
        [leadId, 422]
    ]) {
        const response = await assignmentRequest(id, id === leadId ? 'not-a-staff-id' : 'assignment-employee-a');
        assert.equal(response.status, status);
    }
    for (const staffId of ['assignment-inactive', 'assignment-disabled-account', 'assignment-engineer']) {
        const response = await assignmentRequest(leadId, staffId);
        assert.equal(response.status, 422, staffId);
    }
    const unauthorized = await assignmentRequest(leadId, 'assignment-employee-c', employeeCookie);
    assert.equal(unauthorized.status, 403);
    const hiddenLead = await fetch(`${baseUrl}/api/leads/${leadId}`, { headers: { Cookie: employeeCookie } });
    assert.equal(hiddenLead.status, 403);

    const unauthenticated = await fetch(`${baseUrl}/api/leads/${leadId}/assignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ assignedTo: 'assignment-employee-c' })
    });
    assert.equal(unauthenticated.status, 401);

    const refreshed = await fetch(`${baseUrl}/api/leads/${leadId}`, { headers: { Cookie: adminCookie } });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).lead.assignedTo, 'assignment-employee-b');
});

test('a database failure rolls back ownership, audit, and notification without a success response', async () => {
    const databasePath = path.join(tempDir, 'crm.sqlite');
    let database = new DatabaseSync(databasePath);
    const countsBefore = {
        audits: database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE record_type = 'lead' AND record_id = ? AND action = 'Reassigned'").get(leadId).count,
        notifications: database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE record_type = 'lead' AND record_id = ?").get(leadId).count
    };
    database.exec(`CREATE TRIGGER synthetic_assignment_audit_failure
        BEFORE INSERT ON audit_logs
        WHEN NEW.record_type = 'lead' AND NEW.record_id = '${leadId}' AND NEW.action = 'Reassigned'
        BEGIN SELECT RAISE(ABORT, 'synthetic assignment audit failure'); END;`);
    database.close();

    const failed = await assignmentRequest(leadId, 'assignment-employee-c');
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /Unable to assign Lead/);

    database = new DatabaseSync(databasePath, { readOnly: true });
    const saved = database.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(leadId);
    assert.equal(saved.assigned_to, 'assignment-employee-b');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE record_type = 'lead' AND record_id = ? AND action = 'Reassigned'").get(leadId).count, countsBefore.audits);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE record_type = 'lead' AND record_id = ?").get(leadId).count, countsBefore.notifications);
    database.close();

    database = new DatabaseSync(databasePath);
    database.exec('DROP TRIGGER synthetic_assignment_audit_failure');
    database.close();
});

test('lead details canonicalizes a display lead number to the database ID before assignment', () => {
    const source = fs.readFileSync(path.join(__dirname, 'lead-details.html'), 'utf8');
    assert.match(source, /let leadId = String\(new URLSearchParams\(window\.location\.search\)\.get\('lead'\)/);
    assert.match(source, /leadId = String\(stored\.leadId \|\| leadId\)/);
    assert.match(source, /crmApi\.assignLead\(leadId, selectedId\)/);
    assert.match(source, /formElement\.dataset\.submitting === 'true'/);
});
