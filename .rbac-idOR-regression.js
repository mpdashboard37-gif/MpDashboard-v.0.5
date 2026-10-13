const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const rootDir = __dirname;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpace-rbac-'));
const testDb = path.join(testDir, 'crm.sqlite');
const testFileDir = path.join(testDir, 'crm-files');
fs.mkdirSync(testFileDir, { recursive: true });
const leadFileName = `rbac-test-${crypto.randomUUID()}.pdf`;
const surveyFileName = `rbac-test-${crypto.randomUUID()}.pdf`;
fs.writeFileSync(path.join(testFileDir, leadFileName), 'SYNTHETIC-LEAD-FILE-CONTENT', { flag: 'wx' });
fs.writeFileSync(path.join(testFileDir, surveyFileName), 'SYNTHETIC-SURVEY-FILE-CONTENT', { flag: 'wx' });
const checks = [];
const MAX_TEST_RUNTIME_MS = 90000;
const REQUEST_TIMEOUT_MS = 5000;
let activeChild = null;
let watchdog;
let currentPhase = 'initializing isolated test';
let capturedServerOutput = '';
const credentials = Object.fromEntries(['admin', 'managerA', 'managerB', 'execA', 'execB', 'telecaller'].map((role) => [role, {
    loginId: `${role}.${crypto.randomUUID()}@test.invalid`,
    password: crypto.randomBytes(24).toString('base64url')
}]));
credentials.admin.loginId = 'varunkv@inpacepower.com';

function hashTestPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function productionSecretGuardPasses() {
    const result = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV = 'production'; process.env.SESSION_SECRET = ''; require('./server.js');"], {
        cwd: rootDir,
        env: { ...process.env, NODE_ENV: 'production', DATABASE_MODE: 'sqlite', DATABASE_URL: '', DB_HOST: '', DB_PORT: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '', SQLITE_DB_PATH: path.join(testDir, 'production-guard.sqlite'), CRM_FILE_STORAGE_ROOT: path.join(testDir, 'production-guard-files'), ADMIN_INITIAL_PASSWORD: `Synthetic-${crypto.randomBytes(24).toString('hex')}`, SESSION_SECRET: '' },
        encoding: 'utf8',
        timeout: 5000
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return result.status !== 0 && output.includes('SESSION_SECRET must be set in production');
}

function productionGuardRejects(environment, expectedMessage) {
    const result = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV = 'production'; require('./server.js');"], {
        cwd: rootDir,
        env: {
            ...process.env,
            NODE_ENV: 'production', DATABASE_MODE: 'sqlite', DATABASE_URL: '', DB_HOST: '', DB_PORT: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '',
            SESSION_SECRET: 'synthetic-production-session-secret-long-enough', CORS_ORIGIN: 'https://crm.test.invalid',
            PASSWORD_RESET_BASE_URL: 'https://crm.test.invalid/login.html', EMAIL_HOST: 'mail.test.invalid', EMAIL_USER: 'synthetic-user', EMAIL_PASSWORD: 'synthetic-password',
            SQLITE_DB_PATH: path.join(testDir, 'production-guard.sqlite'),
            CRM_FILE_STORAGE_ROOT: path.join(testDir, 'production-guard-files'),
            ADMIN_INITIAL_PASSWORD: `Synthetic-${crypto.randomBytes(24).toString('hex')}`,
            ...environment
        },
        encoding: 'utf8',
        timeout: 5000
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return result.status !== 0 && output.includes(expectedMessage);
}
const ids = {
    admin: 'staff-admin', managerA: 'rbac-test-manager-a', managerB: 'rbac-test-manager-b',
    execA: 'rbac-test-exec-a', execB: 'rbac-test-exec-b', telecaller: 'rbac-test-telecaller',
    leadA: 'RBAC-TEST-LEAD-A', leadB: 'RBAC-TEST-LEAD-B', leadTelecaller: 'RBAC-TEST-LEAD-TELECALLER',
    leadSurvey: 'RBAC-TEST-LEAD-SURVEY', leadNoOpportunity: 'RBAC-TEST-LEAD-NO-OPP', leadDelete: 'RBAC-TEST-LEAD-DELETE',
    staffToDelete: 'rbac-test-staff-delete', opportunityA: 'RBAC-TEST-OPP-A',
    opportunityB: 'RBAC-TEST-OPP-B', foreignAssignmentLead: 'RBAC-TEST-LEAD-ASSIGN', orphanLead: 'RBAC-TEST-ORPHAN'
};

const getPort = () => new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
        const port = listener.address().port;
        listener.close((error) => error ? reject(error) : resolve(port));
    });
});

const waitForServer = async (baseUrl, child, output) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.closed) throw new Error(`Test server exited early (code ${child.closeCode ?? 'unknown'}). ${output()}`);
        try {
            const response = await fetch(`${baseUrl}/api/opportunities`, { signal: AbortSignal.timeout(1000) });
            if (response.status === 401) return;
        } catch (error) { }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Test server did not start. ${output()}`);
};

async function main() {
    const port = await getPort();
    let logs = '';
    currentPhase = 'starting isolated server';
    const childSource = `console.log('Isolated CRM test server booting.'); process.on('uncaughtException', error => { console.error('Isolated server startup error:', error.message); process.exit(1); }); process.on('unhandledRejection', error => { console.error('Isolated server startup rejection:', error?.message || 'unknown error'); process.exit(1); }); require('./server.js');`;
    const child = spawn(process.execPath, ['-e', childSource], {
        cwd: rootDir,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            DATABASE_MODE: 'sqlite',
            SQLITE_DB_PATH: testDb,
            DATABASE_URL: '',
            DB_HOST: '', DB_PORT: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '',
            EMAIL_HOST: '', EMAIL_USER: '', EMAIL_PASSWORD: '',
            SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
            ADMIN_INITIAL_PASSWORD: credentials.admin.password,
            PASSWORD_RESET_BASE_URL: 'https://reset.invalid/reset',
            CRM_FILE_STORAGE_ROOT: testFileDir,
            CORS_ORIGIN: `http://localhost:${port}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChild = child;
    child.closed = false;
    child.closeCode = null;
    child.on('error', (error) => process.stderr.write(`Unable to launch isolated server: ${error.message}\n`));
    child.on('close', (code) => { child.closed = true; child.closeCode = code; });
    const capture = (chunk) => {
        const text = chunk.toString();
        logs += text;
        capturedServerOutput = `${capturedServerOutput}${text}`.slice(-5000);
        process.stdout.write(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        currentPhase = 'waiting for isolated server';
        await waitForServer(baseUrl, child, () => logs);
        currentPhase = 'seeding synthetic fixtures';
        const db = new DatabaseSync(testDb);
        const now = new Date().toISOString();
        const staff = [
            ['managerA', 'Sales Manager', null], ['managerB', 'Sales Manager', null],
            ['execA', 'Sales Executive', ids.managerA], ['execB', 'Sales Executive', ids.managerB], ['telecaller', 'Telecaller', ids.managerA]
        ];
        for (const [key, role, managerId] of staff) {
            const user = credentials[key];
            db.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, manager_id, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
                .run(ids[key], `RBAC-${key}`, `RBAC ${key}`, user.loginId, 'Sales', role, user.loginId, hashTestPassword(user.password), role, 'Active', 'ACTIVE', managerId, now);
        }
        db.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(ids.staffToDelete, 'RBAC-DELETE-STAFF', 'RBAC Delete Target', 'delete.target@test.invalid', 'Sales', 'Sales Executive', 'delete.target@test.invalid', hashTestPassword('SyntheticDeleteTarget77'), 'Sales Executive', 'Active', 'ACTIVE', now);
        const insertLead = db.prepare("INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, status, created_by, created_at, updated_at, details_json, lead_score, lead_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', 'Warm', 'Active', ?, ?, ?, '{}', 0, 'Cold')");
        insertLead.run(ids.leadA, 'INP-RBAC-1001', 'RBAC Own Lead', '9999910001', credentials.execA.loginId, '2026-01-01', 'Test', ids.execA, ids.execA, now, now);
        insertLead.run(ids.leadB, 'INP-RBAC-1002', 'RBAC Foreign Lead', '9999910002', credentials.execB.loginId, '2026-01-01', 'Test', ids.execB, ids.execB, now, now);
        insertLead.run(ids.leadTelecaller, 'INP-RBAC-1006', 'RBAC Telecaller Lead', '9999910007', credentials.telecaller.loginId, '2026-01-01', 'Test', ids.telecaller, ids.telecaller, now, now);
        insertLead.run(ids.leadSurvey, 'INP-RBAC-1007', 'RBAC Survey Workflow Lead', '9999910008', credentials.execA.loginId, '2026-01-01', 'Test', ids.execA, ids.execA, now, now);
        insertLead.run(ids.foreignAssignmentLead, 'INP-RBAC-1003', 'RBAC Assignment Lead', '9999910003', credentials.execA.loginId, '2026-01-01', 'Test', ids.execA, ids.execA, now, now);
        insertLead.run(ids.leadNoOpportunity, 'INP-RBAC-1004', 'RBAC Assignment Attempt Lead', '9999910004', credentials.execA.loginId, '2026-01-01', 'Test', ids.execA, ids.execA, now, now);
        insertLead.run(ids.leadDelete, 'INP-RBAC-1005', 'RBAC Delete Target Lead', '9999910006', credentials.execA.loginId, '2026-01-01', 'Test', ids.execA, ids.execA, now, now);
        db.prepare("INSERT INTO opportunities (id, lead_id, customer_name, estimated_value, assigned_to, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
            .run(ids.opportunityA, ids.leadA, 'RBAC Own Opportunity', ids.execA, ids.execA, now, now);
        db.prepare("INSERT INTO opportunities (id, lead_id, customer_name, estimated_value, assigned_to, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
            .run(ids.opportunityB, ids.leadB, 'RBAC Foreign Opportunity', ids.execB, ids.execB, now, now);
        db.prepare("INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, 'Call', ?, 'Pending', 'test fixture', ?, ?, 'Test follow-up', 'PENDING')")
            .run('RBAC-TEST-FOLLOWUP-B', ids.leadB, '2035-01-01T10:00', ids.execB, ids.execB, now);
        const insertSurvey = db.prepare("INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, recommended_capacity, remarks, status, survey_type, completion_data_json) VALUES (?, ?, ?, ?, ?, ?, 'Pending', '{}', '{}', '', 'synthetic test', 'Scheduled', 'Site Survey', '{}')");
        insertSurvey.run('RBAC-TEST-SURVEY-A', ids.leadA, '2035-01-01T10:00', ids.execA, 'RBAC Own Lead', 'Synthetic address');
        insertSurvey.run('RBAC-TEST-SURVEY-B', ids.leadB, '2035-01-02T10:00', ids.execB, 'RBAC Foreign Lead', 'Synthetic address');
        db.prepare("INSERT INTO survey_files (id, survey_id, lead_id, category, file_name, mime_type, file_size, uploaded_by, uploaded_at, storage_path, original_file_name, status) VALUES (?, ?, ?, 'Other Documents', 'synthetic.pdf', 'application/pdf', 1, ?, ?, ?, 'synthetic.pdf', 'UPLOADED')")
            .run('RBAC-TEST-SURVEY-FILE-B', 'RBAC-TEST-SURVEY-B', ids.leadB, ids.execB, now, surveyFileName);
        db.prepare("INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status) VALUES (?, ?, 'Other', 'synthetic.pdf', ?, ?, ?, 'synthetic.pdf', 'application/pdf', 1, 'UPLOADED')")
            .run('RBAC-TEST-LEAD-FILE-B', ids.leadB, ids.execB, now, leadFileName);
        const insertProposal = db.prepare("INSERT INTO proposal_records (id, proposal_number, lead_id, customer_name, contact_number, proposal_date, system_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-01-01', 'On-Grid', ?, ?, ?)");
        insertProposal.run('RBAC-TEST-PROPOSAL-A', 'RBAC-IP-TEST-001', ids.leadA, 'RBAC Own Lead', '9999910001', ids.execA, now, now);
        insertProposal.run('RBAC-TEST-PROPOSAL-B', 'RBAC-IP-TEST-002', ids.leadB, 'RBAC Foreign Lead', '9999910002', ids.execB, now, now);
        db.prepare("INSERT INTO projects (id, lead_id, status, created_at, updated_at) VALUES (?, ?, 'Booked', ?, ?)")
            .run('RBAC-TEST-PROJECT-A', ids.leadA, now, now);
        db.prepare("INSERT INTO projects (id, lead_id, status, created_at, updated_at) VALUES (?, ?, 'Booked', ?, ?)")
            .run('RBAC-TEST-PROJECT-B', ids.leadB, now, now);
        db.prepare("INSERT INTO payments (id, project_id, total_amount, paid_amount, created_by, created_at) VALUES (?, ?, 100, 0, ?, ?)")
            .run('RBAC-TEST-PAYMENT-B', 'RBAC-TEST-PROJECT-B', ids.execB, now);
        db.close();

        const call = async (route, { role, method = 'GET', body, headers: extraHeaders = {} } = {}) => {
            currentPhase = `${method} ${route}`;
            const headers = { ...extraHeaders };
            if (role) headers.Cookie = role.cookie;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            try {
                const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
                const text = await response.text();
                let data;
                try { data = JSON.parse(text); } catch (error) { data = text; }
                return { status: response.status, data, headers: response.headers };
            } catch (error) {
                throw new Error(`${method} ${route} request failed: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
            }
        };
        currentPhase = 'logging in synthetic roles';
        for (const user of Object.values(credentials)) {
            const response = await call('/api/auth/login', { method: 'POST', body: { loginId: user.loginId, password: user.password } });
            if (response.status !== 200) throw new Error(`Synthetic account login failed (${response.status}).`);
            const cookie = response.headers?.get?.('set-cookie');
            user.cookie = cookie ? cookie.split(';', 1)[0] : '';
            user.cookieHttpOnly = /;\s*httponly/i.test(cookie || '');
            user.cookieSameSite = /;\s*samesite=lax/i.test(cookie || '');
            user.cookieSecure = /;\s*secure(?:;|$)/i.test(cookie || '');
            if (!user.cookie) throw new Error('Session cookie was not issued.');
        }

        const check = (name, actual, expected) => checks.push({ name, expected, actual, result: actual === expected ? 'PASS' : 'FAIL' });
        check('Session cookie is HttpOnly', credentials.execA.cookieHttpOnly, true);
        check('Session cookie uses SameSite=Lax', credentials.execA.cookieSameSite, true);
        check('Plain HTTP test session does not claim Secure transport', credentials.execA.cookieSecure, false);
        const forgedProxyLogin = await call('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: { loginId: credentials.managerB.loginId, password: credentials.managerB.password } });
        check('Untrusted forwarded-protocol header cannot mark cookie Secure', /;\s*secure(?:;|$)/i.test(forgedProxyLogin.headers.get('set-cookie') || ''), false);
        const headersProbe = await call('/api/auth/me', { role: credentials.execA });
        check('Security response includes nosniff header', headersProbe.headers.get('x-content-type-options'), 'nosniff');
        check('Security response includes frame protection', headersProbe.headers.get('x-frame-options'), 'DENY');
        check('Express version header is disabled', headersProbe.headers.has('x-powered-by'), false);
        check('Anonymous lead request requires authentication', (await call('/api/leads')).status, 401);
        check('Executive reads own lead', (await call(`/api/leads/${ids.leadA}`, { role: credentials.execA })).status, 200);
        check('Executive cannot read another lead by ID', (await call(`/api/leads/${ids.leadB}`, { role: credentials.execA })).status, 403);
        check('Manager reads team lead', (await call(`/api/leads/${ids.leadA}`, { role: credentials.managerA })).status, 200);
        check('Manager cannot read another team lead by ID', (await call(`/api/leads/${ids.leadB}`, { role: credentials.managerA })).status, 403);
        check('Executive updates own lead', (await call(`/api/leads/${ids.leadA}`, { role: credentials.execA, method: 'PATCH', body: { customerName: 'RBAC Own Lead Updated' } })).status, 200);
        check('Executive cannot update another lead by ID', (await call(`/api/leads/${ids.leadB}`, { role: credentials.execA, method: 'PATCH', body: { customerName: 'Unauthorized Change' } })).status, 403);
        check('Executive cannot change lead owner in request body', (await call(`/api/leads/${ids.leadA}`, { role: credentials.execA, method: 'PATCH', body: { customerName: 'Unauthorized Owner Change', assignedTo: ids.execB } })).status, 403);
        check('Anonymous file download requires authentication', (await call('/api/files/RBAC-TEST-LEAD-FILE-B')).status, 401);
        check('Anonymous pipeline request requires authentication', (await call('/api/opportunities')).status, 401);
        const roleLeads = {};
        for (const role of ['admin', 'managerA', 'execA', 'telecaller']) {
            const response = await call('/api/leads', { role: credentials[role] });
            roleLeads[role] = (response.data?.leads || []).map((lead) => lead.leadId || lead.id);
            check(`${role} lead list request succeeds`, response.status, 200);
        }
        check('Admin lead list includes both teams', roleLeads.admin.includes(ids.leadA) && roleLeads.admin.includes(ids.leadB), true);
        check('Manager lead list includes own team only', roleLeads.managerA.includes(ids.leadA) && !roleLeads.managerA.includes(ids.leadB), true);
        check('Executive lead list includes assigned leads only', roleLeads.execA.includes(ids.leadA) && !roleLeads.execA.includes(ids.leadB), true);
        check('Telecaller lead list includes own assigned lead only', roleLeads.telecaller.includes(ids.leadTelecaller) && !roleLeads.telecaller.includes(ids.leadA), true);
        check('Telecaller cannot read another employee lead by ID', (await call(`/api/leads/${ids.leadA}`, { role: credentials.telecaller })).status, 403);
        check('Admin sees foreign opportunity', (await call('/api/opportunities/RBAC-TEST-OPP-B', { role: credentials.admin })).status, 200);
        check('Executive sees own opportunity', (await call(`/api/opportunities/${ids.opportunityA}`, { role: credentials.execA })).status, 200);
        check('Executive cannot view another team opportunity', (await call(`/api/opportunities/${ids.opportunityB}`, { role: credentials.execA })).status, 404);
        check('Manager views opportunity in own team', (await call(`/api/opportunities/${ids.opportunityA}`, { role: credentials.managerA })).status, 200);
        check('Manager cannot view another team opportunity by ID', (await call(`/api/opportunities/${ids.opportunityB}`, { role: credentials.managerA })).status, 404);
        const createdOpportunity = await call('/api/opportunities', { role: credentials.execA, method: 'POST', body: { lead_id: ids.foreignAssignmentLead, assigned_to: ids.execA, estimated_value: 10 } });
        check('Executive creates opportunity for own lead', createdOpportunity.status, 201);
        const createdOpportunityId = createdOpportunity.data?.id;
        check('Executive updates own opportunity stage', (await call(`/api/opportunities/${createdOpportunityId}/stage`, { role: credentials.execA, method: 'PATCH', body: { stage: 'Proposal' } })).status, 200);
        check('Executive cannot change another opportunity stage by ID', (await call(`/api/opportunities/${ids.opportunityB}/stage`, { role: credentials.execA, method: 'PATCH', body: { stage: 'Proposal' } })).status, 404);
        check('Executive creates follow-up on own opportunity', (await call(`/api/opportunities/${createdOpportunityId}/followups`, { role: credentials.execA, method: 'POST', body: { due_at: '2035-01-03T10:00', type: 'Call', note: 'synthetic test' } })).status, 201);

        const managerList = await call('/api/opportunities', { role: credentials.managerA });
        const visibleIds = (managerList.data || []).map((row) => row.id);
        check('Manager list excludes another manager team', visibleIds.includes(ids.opportunityB), false);
        const managerFollowups = await call('/api/follow-ups?range=upcoming', { role: credentials.managerA });
        const followups = Array.isArray(managerFollowups.data) ? managerFollowups.data : [];
        check('Manager follow-ups exclude another manager team', followups.some((row) => row.id === 'RBAC-TEST-FOLLOWUP-B'), false);
        check('Manager cannot complete another team follow-up', (await call('/api/followups/RBAC-TEST-FOLLOWUP-B/done', { role: credentials.managerA, method: 'PATCH' })).status, 404);
        check('Manager can complete team follow-up', (await call('/api/followups/RBAC-TEST-FOLLOWUP-B/done', { role: credentials.managerB, method: 'PATCH' })).status, 200);
        check('Manager cannot reassign own opportunity outside team', (await call(`/api/opportunities/${ids.opportunityA}/owner`, { role: credentials.managerA, method: 'PATCH', body: { owner_id: ids.execB } })).status, 403);

        const taskDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        const nextTaskDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
        const missingTask = await call(`/api/leads/${ids.leadA}/follow-ups`, { role: credentials.execA, method: 'POST', body: { taskTitle: '', date: taskDate, time: '10:00', type: 'Call' } });
        check('Task creation enforces required title', missingTask.status, 422);
        const taskCreate = await call(`/api/leads/${ids.leadA}/follow-ups`, {
            role: credentials.execA, method: 'POST',
            body: { taskTitle: 'Synthetic workflow task', date: taskDate, time: '10:00', type: 'Call', notes: 'synthetic fixture' }
        });
        check('Assigned executive creates task for own lead', taskCreate.status, 201);
        const taskId = taskCreate.data?.id;
        const taskList = await call('/api/tasks', { role: credentials.execA });
        check('Task assignee can view created task', (taskList.data?.tasks || []).some((task) => task.taskId === taskId), true);
        check('Other-team manager task list excludes assigned task', ((await call('/api/tasks', { role: credentials.managerB })).data?.tasks || []).some((task) => task.taskId === taskId), false);
        check('Other-team manager cannot edit task', (await call(`/api/tasks/${taskId}`, { role: credentials.managerB, method: 'PATCH', body: { notes: 'unauthorized' } })).status, 403);
        const unauthorizedTaskReassignment = await call(`/api/tasks/${taskId}`, { role: credentials.execA, method: 'PATCH', body: { assignedTo: ids.execB } });
        check('Executive cannot reassign task to another user', unauthorizedTaskReassignment.status, 403);
        check('Manager cannot reassign task outside own team', (await call(`/api/tasks/${taskId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.execB } })).status, 403);
        check('Manager can reassign task within own team', (await call(`/api/tasks/${taskId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.telecaller } })).status, 200);
        check('Manager can restore task to assigned employee', (await call(`/api/tasks/${taskId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.execA } })).status, 200);
        const taskUpdate = await call(`/api/tasks/${taskId}`, { role: credentials.execA, method: 'PATCH', body: { title: 'Synthetic task edited', notes: 'updated synthetic notes' } });
        check('Task assignee edits own task', taskUpdate.status, 200);
        const taskReschedule = await call(`/api/tasks/${taskId}`, { role: credentials.execA, method: 'PATCH', body: { dueAt: `${nextTaskDate}T11:00` } });
        check('Task assignee reschedules own task', taskReschedule.status, 200);
        check('Manager cannot reschedule task across teams', (await call(`/api/tasks/${taskId}`, { role: credentials.managerB, method: 'PATCH', body: { dueAt: `${nextTaskDate}T12:00` } })).status, 403);
        check('Task assignee completes own task', (await call(`/api/tasks/${taskId}/complete`, { role: credentials.execA, method: 'POST' })).status, 200);
        const completedTaskList = await call('/api/tasks', { role: credentials.execA });
        check('Completed task appears with completed state', (completedTaskList.data?.tasks || []).find((task) => task.taskId === taskId)?.status, 'COMPLETED');

        const followUpCreate = await call(`/api/leads/${ids.leadA}/follow-ups`, {
            role: credentials.execA, method: 'POST',
            body: { taskTitle: 'Synthetic workflow follow-up', date: taskDate, time: '12:00', type: 'Meeting', notes: 'synthetic fixture' }
        });
        check('Assigned executive creates follow-up for own lead', followUpCreate.status, 201);
        const followUpId = followUpCreate.data?.id;
        check('Follow-up appears in task list', ((await call('/api/tasks', { role: credentials.execA })).data?.tasks || []).some((task) => task.taskId === followUpId), true);
        check('Cross-team user cannot update follow-up', (await call(`/api/tasks/${followUpId}`, { role: credentials.managerB, method: 'PATCH', body: { notes: 'unauthorized' } })).status, 403);
        check('Follow-up assignee updates follow-up', (await call(`/api/tasks/${followUpId}`, { role: credentials.execA, method: 'PATCH', body: { notes: 'updated follow-up notes' } })).status, 200);
        const completedFollowUp = await call(`/api/follow-ups/${followUpId}/complete`, { role: credentials.execA, method: 'POST', body: { remarks: 'synthetic completion', nextAction: 'synthetic next step' } });
        check('Follow-up assignee completes follow-up', completedFollowUp.status, 200);
        const rescheduleSource = await call(`/api/leads/${ids.leadA}/follow-ups`, {
            role: credentials.execA, method: 'POST',
            body: { taskTitle: 'Synthetic reschedule source', date: taskDate, time: '13:00', type: 'Call' }
        });
        check('Follow-up completion requires remarks or next action', (await call(`/api/follow-ups/${rescheduleSource.data?.id}/complete`, { role: credentials.execA, method: 'POST', body: {} })).status, 422);
        const followUpReschedule = await call(`/api/follow-ups/${rescheduleSource.data?.id}/reschedule`, {
            role: credentials.execA, method: 'POST', body: { date: nextTaskDate, time: '13:00', type: 'Call', note: 'synthetic reschedule' }
        });
        check('Follow-up assignee reschedules follow-up', followUpReschedule.status, 200);
        check('Cross-team user cannot reschedule follow-up', (await call(`/api/follow-ups/${rescheduleSource.data?.id}/reschedule`, { role: credentials.managerB, method: 'POST', body: { date: nextTaskDate, time: '14:00' } })).status, 403);

        const assignmentAttempt = await call('/api/opportunities', {
            role: credentials.execA,
            method: 'POST',
            body: { lead_id: ids.leadNoOpportunity, assigned_to: ids.execB, estimated_value: 10 }
        });
        check('Executive cannot assign opportunity to another user', assignmentAttempt.status, 403);
        const leadAssignmentAttempt = await call('/api/leads', {
            role: credentials.execA,
            method: 'POST',
            body: { customerName: 'RBAC Assignment Attempt', mobileNumber: '9999910005', leadDate: '2026-01-01', leadSource: 'Test', assignedTo: ids.execB }
        });
        check('Executive cannot assign a new lead to another user', leadAssignmentAttempt.status, 403);
        check('Executive cannot reassign existing lead', (await call(`/api/leads/${ids.foreignAssignmentLead}/assignment`, { role: credentials.execA, method: 'POST', body: { assignedTo: ids.execB } })).status, 403);
        check('Executive cannot edit another user task by ID', (await call('/api/tasks/RBAC-TEST-FOLLOWUP-B', { role: credentials.execA, method: 'PATCH', body: { notes: 'unauthorized synthetic edit' } })).status, 403);
        const orphanAttempt = await call('/api/opportunities', {
            role: credentials.execA,
            method: 'POST',
            body: { name: 'RBAC Orphan Lead', phone: '9999910004', assigned_to: ids.execB }
        });
        check('Unauthorized pipeline lead assignment is rejected', orphanAttempt.status, 403);
        const verifyDb = new DatabaseSync(testDb);
        const rejectedLeadCount = verifyDb.prepare("SELECT COUNT(*) AS count FROM leads WHERE customer_name IN ('RBAC Orphan Lead', 'RBAC Assignment Attempt')").get().count;
        const rejectedOpportunityCount = verifyDb.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE lead_id = ?').get(ids.leadNoOpportunity).count;
        verifyDb.close();
        check('Rejected create requests do not persist unauthorized leads', rejectedLeadCount, 0);
        check('Rejected assignment does not create an opportunity', rejectedOpportunityCount, 0);
        check('Telecaller cannot access CRM settings', (await call('/api/settings', { role: credentials.telecaller })).status, 403);
        check('Admin settings access remains permitted', (await call('/api/settings', { role: credentials.admin })).status, 200);
        check('Manager cannot view staff management', (await call('/api/staff', { role: credentials.managerA })).status, 403);
        check('Admin can view staff management', (await call('/api/staff', { role: credentials.admin })).status, 200);
        check('Manager cannot view access requests', (await call('/api/admin/access-requests', { role: credentials.managerA })).status, 403);
        check('Protected Admin can view access requests', (await call('/api/admin/access-requests', { role: credentials.admin })).status, 200);
        check('Telecaller cannot view audit logs', (await call('/api/settings/audit-logs', { role: credentials.telecaller })).status, 403);
        check('Admin can view audit logs', (await call('/api/settings/audit-logs', { role: credentials.admin })).status, 200);
        check('Telecaller cannot view inventory information', (await call('/api/inventory/dashboard', { role: credentials.telecaller })).status, 403);
        check('Profile role injection does not grant privileges', (await call('/api/profile', { role: credentials.execA, method: 'PATCH', body: { role: 'Admin/Owner', managerId: ids.managerB } })).status, 200);
        check('Executive can view inventory before role downgrade', (await call('/api/inventory/dashboard', { role: credentials.execA })).status, 200);
        check('Admin can change synthetic employee role', (await call(`/api/staff/${ids.execA}`, { role: credentials.admin, method: 'PATCH', body: { role: 'Telecaller' } })).status, 200);
        check('Existing session immediately enforces role downgrade', (await call('/api/inventory/dashboard', { role: credentials.execA })).status, 403);
        const roleSessionDb = new DatabaseSync(testDb);
        const persistedSession = roleSessionDb.prepare('SELECT user_json FROM sessions WHERE staff_id = ? ORDER BY created_at DESC LIMIT 1').get(ids.execA);
        roleSessionDb.close();
        check('Updated session cache persists current role', JSON.parse(persistedSession?.user_json || '{}').role, 'Telecaller');
        check('Admin can restore synthetic employee role', (await call(`/api/staff/${ids.execA}`, { role: credentials.admin, method: 'PATCH', body: { role: 'Sales Executive' } })).status, 200);
        check('Existing session regains permitted role after restoration', (await call('/api/inventory/dashboard', { role: credentials.execA })).status, 200);
        check('Executive cannot permanently delete synthetic lead', (await call(`/api/leads/${ids.leadDelete}`, { role: credentials.execA, method: 'DELETE' })).status, 403);

        check('Executive reads own survey', (await call('/api/surveys/RBAC-TEST-SURVEY-A', { role: credentials.execA })).status, 200);
        check('Executive cannot read another survey by ID', (await call('/api/surveys/RBAC-TEST-SURVEY-B', { role: credentials.execA })).status, 403);
        check('Executive cannot edit another survey by ID', (await call('/api/surveys/RBAC-TEST-SURVEY-B', { role: credentials.execA, method: 'PATCH', body: { notes: 'unauthorized synthetic edit' } })).status, 403);
        check('Executive updates own survey', (await call('/api/surveys/RBAC-TEST-SURVEY-A', { role: credentials.execA, method: 'PATCH', body: { notes: 'authorized synthetic update' } })).status, 200);
        check('Other-team manager cannot read survey by ID', (await call('/api/surveys/RBAC-TEST-SURVEY-B', { role: credentials.managerA })).status, 403);
        check('Survey creation requires a lead', (await call('/api/surveys', { role: credentials.execA, method: 'POST', body: {} })).status, 422);
        const workflowSurveyDate = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 16);
        check('Executive cannot request survey for another team lead', (await call('/api/surveys', { role: credentials.execA, method: 'POST', body: { leadId: ids.leadB, surveyDate: workflowSurveyDate } })).status, 403);
        check('Executive cannot assign requested survey to another employee', (await call('/api/surveys', { role: credentials.execA, method: 'POST', body: { leadId: ids.leadSurvey, surveyDate: workflowSurveyDate, assignedTo: ids.execB } })).status, 403);
        const createdSurvey = await call('/api/surveys', {
            role: credentials.managerA, method: 'POST',
            body: { leadId: ids.leadSurvey, surveyDate: workflowSurveyDate, assignedTo: ids.execA, address: 'Synthetic survey address', notes: 'Synthetic survey' }
        });
        check('Manager creates and assigns survey within own team', createdSurvey.status, 201);
        const workflowSurveyId = createdSurvey.data?.surveyId;
        check('Assigned surveyor views created survey', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA })).status, 200);
        check('Other-team executive cannot view created survey', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execB })).status, 403);
        check('Assigned surveyor edits own survey', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA, method: 'PATCH', body: { notes: 'Updated synthetic survey' } })).status, 200);
        const unauthorizedSurveyAssignment = await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.execB } });
        check('Manager cannot assign survey outside own team', unauthorizedSurveyAssignment.status, 403);
        check('Manager can assign survey within own team', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.telecaller } })).status, 200);
        check('Manager restores survey to synthetic executive', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.managerA, method: 'PATCH', body: { assignedTo: ids.execA } })).status, 200);
        const surveyRescheduleDate = new Date(Date.now() + 52 * 86400000).toISOString().slice(0, 16);
        check('Manager reschedules survey in team', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.managerA, method: 'PATCH', body: { surveyDate: surveyRescheduleDate, reschedule: true } })).status, 200);
        check('Survey completion requires required site data and evidence', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA, method: 'PATCH', body: { status: 'Completed' } })).status, 422);
        check('Incomplete survey remains rescheduled after rejected completion', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA })).data?.survey?.status, 'Rescheduled');
        const surveyWorkflowLeadDb = new DatabaseSync(testDb);
        surveyWorkflowLeadDb.prepare("UPDATE leads SET stage = 'Site Survey Scheduled' WHERE id = ?").run(ids.leadSurvey);
        surveyWorkflowLeadDb.close();
        const incompleteStageCompletion = await call(`/api/leads/${ids.leadSurvey}`, { role: credentials.execA, method: 'PATCH', body: { action: 'complete-stage' } });
        check('Survey workflow rejects stage completion without required fields and evidence', incompleteStageCompletion.status, 422);
        const surveyStageCheckDb = new DatabaseSync(testDb);
        const surveyStageAfterRejection = surveyStageCheckDb.prepare('SELECT stage FROM leads WHERE id = ?').get(ids.leadSurvey)?.stage;
        surveyStageCheckDb.close();
        check('Rejected survey completion leaves lead stage unchanged', surveyStageAfterRejection, 'Site Survey Scheduled');
        const surveyEvidenceCategories = ['EAST_SIDE_PHOTO', 'WEST_SIDE_PHOTO', 'NORTH_SIDE_PHOTO', 'SOUTH_SIDE_PHOTO', 'ELECTRICITY_METER_PHOTO', 'ELECTRICITY_BILL', 'EARTHING_LOCATION_PHOTO', 'ROOF_PHOTO', 'ROOF_360_VIDEO'];
        let evidenceUploadStatus = 201;
        for (const category of surveyEvidenceCategories) {
            const uploaded = await call(`/api/surveys/${workflowSurveyId}/files`, {
                role: credentials.execA, method: 'POST',
                body: { category, files: [{ fileName: `synthetic-${category}.pdf`, mimeType: 'application/pdf', fileData: `data:application/pdf;base64,${Buffer.from('%PDF synthetic evidence').toString('base64')}` }] }
            });
            if (uploaded.status !== 201) evidenceUploadStatus = uploaded.status;
        }
        check('Assigned surveyor uploads all required synthetic evidence categories', evidenceUploadStatus, 201);
        const requiredSurveyData = {
            latitude: '12.9716', longitude: '77.5946', locationAccuracy: '5',
            electricityProvider: 'Synthetic Utility', consumerNumber: 'SYNTHETIC-CONSUMER',
            meterNumber: 'SYNTHETIC-METER', sanctionedLoad: '5', phase: 'Single',
            proposedCapacity: '5', systemType: 'On-grid', installationType: 'Rooftop',
            roofType: 'Concrete', roofArea: '100', usableRoofArea: '90',
            roofCondition: 'Good', shadowCondition: 'None', roofDirection: 'South',
            existingEarthing: 'Yes', earthingCondition: 'Good', roofAccess: 'Safe',
            engineerObservations: 'Synthetic inspection notes'
        };
        check('Assigned surveyor completes survey with all required fields and evidence', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA, method: 'PATCH', body: { status: 'Completed', data: requiredSurveyData } })).status, 200);
        check('Completed survey is visible with completed status', (await call(`/api/surveys/${workflowSurveyId}`, { role: credentials.execA })).data?.survey?.status, 'Completed');

        check('Telecaller cannot access survey files', (await call('/api/surveys/RBAC-TEST-SURVEY-A/files', { role: credentials.telecaller })).status, 403);
        check('Executive cannot list another survey files', (await call('/api/surveys/RBAC-TEST-SURVEY-B/files', { role: credentials.execA })).status, 403);
        check('Lead file collection denies foreign lead', (await call(`/api/leads/${ids.leadB}/files`, { role: credentials.execA })).status, 403);
        check('Lead file download denies foreign record ID', (await call('/api/files/RBAC-TEST-LEAD-FILE-B', { role: credentials.execA })).status, 403);
        check('Survey file download denies foreign record ID', (await call('/api/files/RBAC-TEST-SURVEY-FILE-B', { role: credentials.execA })).status, 403);
        const authorizedLeadFile = await call('/api/files/RBAC-TEST-LEAD-FILE-B', { role: credentials.execB });
        check('Authorized lead owner downloads synthetic file bytes', authorizedLeadFile.status === 200 && authorizedLeadFile.data.includes('SYNTHETIC-LEAD-FILE-CONTENT'), true);
        const authorizedSurveyFile = await call('/api/files/RBAC-TEST-SURVEY-FILE-B', { role: credentials.execB });
        check('Authorized survey owner downloads synthetic file bytes', authorizedSurveyFile.status === 200 && authorizedSurveyFile.data.includes('SYNTHETIC-SURVEY-FILE-CONTENT'), true);
        const syntheticPdf = { fileName: 'synthetic-upload.pdf', mimeType: 'application/pdf', fileData: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 synthetic fixture').toString('base64')}` };
        const validUpload = await call(`/api/leads/${ids.leadA}/files`, {
            role: credentials.execA, method: 'POST',
            body: { category: 'Other', files: [syntheticPdf] }
        });
        check('Authorized owner uploads valid synthetic PDF', validUpload.status, 201);
        const uploadedFileId = validUpload.data?.files?.[0]?.id;
        const uploadedDownload = await call(`/api/files/${uploadedFileId}`, { role: credentials.execA });
        check('Authorized owner downloads uploaded file', uploadedDownload.status === 200 && uploadedDownload.data.includes('%PDF-1.4 synthetic fixture'), true);
        check('Cross-team user cannot download uploaded file', (await call(`/api/files/${uploadedFileId}`, { role: credentials.execB })).status, 403);
        check('Non-admin cannot permanently delete uploaded file', (await call(`/api/leads/${ids.leadA}/files/${uploadedFileId}`, { role: credentials.execA, method: 'DELETE' })).status, 403);
        check('Cross-team user cannot delete uploaded file', (await call(`/api/leads/${ids.leadA}/files/${uploadedFileId}`, { role: credentials.execB, method: 'DELETE' })).status, 403);
        check('Cross-team user cannot upload to lead', (await call(`/api/leads/${ids.leadA}/files`, { role: credentials.execB, method: 'POST', body: { category: 'Other', files: [syntheticPdf] } })).status, 403);
        const invalidUpload = await call(`/api/leads/${ids.leadA}/files`, {
            role: credentials.execA, method: 'POST',
            body: { category: 'Other', files: [{ fileName: 'malware.exe', mimeType: 'application/x-msdownload', fileData: 'data:application/x-msdownload;base64,TVpY' }] }
        });
        check('Invalid file type is rejected', invalidUpload.status, 422);
        const oversizedPayload = { category: 'Other', files: [{ fileName: 'oversized.pdf', mimeType: 'application/pdf', fileData: `data:application/pdf;base64,${'A'.repeat(1024 * 1024)}` }] };
        const oversizedResponse = await call(`/api/leads/${ids.leadA}/files`, { role: credentials.execA, method: 'POST', body: oversizedPayload });
        check('Oversized upload is rejected with payload-too-large status', oversizedResponse.status, 413);
        check('CRM test server remains responsive after oversized upload', (await call('/api/health')).status, 200);
        check('Admin permanently deletes synthetic uploaded file', (await call(`/api/leads/${ids.leadA}/files/${uploadedFileId}`, { role: credentials.admin, method: 'DELETE' })).status, 200);
        check('Deleted synthetic upload can no longer be downloaded', (await call(`/api/files/${uploadedFileId}`, { role: credentials.execA })).status, 404);
        check('Manager can view team proposal', (await call('/api/proposals/RBAC-TEST-PROPOSAL-A', { role: credentials.managerA })).status, 200);
        check('Executive cannot view foreign proposal by ID', (await call('/api/proposals/RBAC-TEST-PROPOSAL-B', { role: credentials.execA })).status, 404);
        check('Executive cannot generate foreign proposal PDF', (await call('/api/proposals/RBAC-TEST-PROPOSAL-B/pdf', { role: credentials.execA, method: 'POST', body: {} })).status, 404);
        check('Executive can generate own proposal PDF', (await call('/api/proposals/RBAC-TEST-PROPOSAL-A/pdf', { role: credentials.execA, method: 'POST', body: {} })).status, 200);
        check('Executive cannot update foreign project by ID', (await call('/api/projects/RBAC-TEST-PROJECT-B', { role: credentials.execA, method: 'PATCH', body: { status: 'Design' } })).status, 403);
        check('Executive cannot add payment to foreign project', (await call('/api/projects/RBAC-TEST-PROJECT-B/payments', { role: credentials.execA, method: 'POST', body: { totalAmount: 100, paidAmount: 0 } })).status, 403);
        check('Executive can add payment to own project', (await call('/api/projects/RBAC-TEST-PROJECT-A/payments', { role: credentials.execA, method: 'POST', body: { totalAmount: 100, paidAmount: 0 } })).status, 201);
        check('Admin can update project', (await call('/api/projects/RBAC-TEST-PROJECT-B', { role: credentials.admin, method: 'PATCH', body: { status: 'Design' } })).status, 200);
        check('Admin can reassign lead', (await call(`/api/leads/${ids.foreignAssignmentLead}/assignment`, { role: credentials.admin, method: 'POST', body: { assignedTo: ids.execB } })).status, 200);
        check('Admin can reassign opportunity owner', (await call(`/api/opportunities/${ids.opportunityA}/owner`, { role: credentials.admin, method: 'PATCH', body: { owner_id: ids.execB } })).status, 200);
        const roleCheckDb = new DatabaseSync(testDb);
        const execRoleAfterInjection = roleCheckDb.prepare('SELECT role FROM staff WHERE id = ?').get(ids.execA)?.role;
        roleCheckDb.close();
        check('Profile role injection leaves backend role unchanged', execRoleAfterInjection, 'Sales Executive');

        const resetLogStart = logs.length;
        check('Password reset request uses non-enumerating response', (await call('/api/auth/forgot-password', { method: 'POST', body: { loginId: credentials.execA.loginId } })).status, 200);
        const resetLogs = logs.slice(resetLogStart);
        check('Password reset log omits token and reset URL', /token\s*=|reset\.invalid/i.test(resetLogs), false);
        check('Password reset log identifies synthetic account safely', resetLogs.includes(`staffId: '${ids.execA}'`), true);
        const unknownReset = await call('/api/auth/forgot-password', { method: 'POST', body: { loginId: 'unknown-user@test.invalid' } });
        check('Unknown password reset request has same response', unknownReset.status, 200);
        const resetDb = new DatabaseSync(testDb);
        const resetFixtureExists = Boolean(resetDb.prepare('SELECT id FROM staff WHERE id = ?').get(ids.execA));
        const resetRowCount = resetDb.prepare('SELECT COUNT(*) AS count FROM password_reset_tokens WHERE staff_id = ?').get(ids.execA).count;
        const resetRow = resetDb.prepare('SELECT expires_at, token_hash FROM password_reset_tokens WHERE staff_id = ? ORDER BY expires_at DESC LIMIT 1').get(ids.execA);
        const validResetToken = 'synthetic-valid-reset-token-not-a-secret';
        const expiredResetToken = 'synthetic-expired-reset-token-not-a-secret';
        const adminResetToken = 'synthetic-admin-reset-token-not-a-secret';
        const tokenDigest = (value) => crypto.createHash('sha256').update(value).digest('hex');
        const insertResetToken = resetDb.prepare('INSERT INTO password_reset_tokens (token_hash, staff_id, expires_at) VALUES (?, ?, ?)');
        insertResetToken.run(tokenDigest(validResetToken), ids.execA, new Date(Date.now() + 10 * 60 * 1000).toISOString());
        insertResetToken.run(tokenDigest(expiredResetToken), ids.execB, new Date(Date.now() - 60 * 1000).toISOString());
        insertResetToken.run(tokenDigest(adminResetToken), ids.admin, new Date(Date.now() + 10 * 60 * 1000).toISOString());
        resetDb.close();
        check('Password reset synthetic account exists', resetFixtureExists, true);
        check('Password reset creates exactly one synthetic token row', resetRowCount, 1);
        const resetHashValid = Boolean(/^[a-f0-9]{64}$/.test(resetRow?.token_hash || ''));
        const resetExpiryValid = Boolean(resetRow && Date.parse(resetRow.expires_at) > Date.now() && Date.parse(resetRow.expires_at) <= Date.now() + 31 * 60 * 1000);
        check('Password reset token remains stored as a SHA-256 hash', resetHashValid, true);
        check('Password reset token expiry remains within 30 minutes', resetExpiryValid, true);
        const newPassword = `SyntheticReset${crypto.randomBytes(8).toString('hex')}7`;
        const resetBody = { token: validResetToken, newPassword, confirmPassword: newPassword };
        check('Valid reset token changes synthetic account password', (await call('/api/auth/reset-password', { method: 'POST', body: resetBody })).status, 200);
        const sessionsAfterResetDb = new DatabaseSync(testDb);
        const sessionsAfterReset = sessionsAfterResetDb.prepare('SELECT COUNT(*) AS count FROM sessions WHERE staff_id = ?').get(ids.execA).count;
        sessionsAfterResetDb.close();
        check('Password reset atomically removes persisted sessions', sessionsAfterReset, 0);
        check('Reset token cannot be used twice', (await call('/api/auth/reset-password', { method: 'POST', body: resetBody })).status, 400);
        check('Expired reset token is rejected', (await call('/api/auth/reset-password', { method: 'POST', body: { token: expiredResetToken, newPassword, confirmPassword: newPassword } })).status, 400);
        check('Protected Admin password cannot be reset', (await call('/api/auth/reset-password', { method: 'POST', body: { token: adminResetToken, newPassword, confirmPassword: newPassword } })).status, 400);
        check('Malformed reset password is rejected', (await call('/api/auth/reset-password', { method: 'POST', body: { token: 'synthetic-invalid-token', newPassword: 'short', confirmPassword: 'short' } })).status, 422);
        check('Reset revokes prior account sessions', (await call('/api/auth/me', { role: credentials.execA })).status, 401);
        const resetLogin = await call('/api/auth/login', { method: 'POST', body: { loginId: credentials.execA.loginId, password: newPassword } });
        check('Reset password authenticates successfully', resetLogin.status, 200);
        const verifyResetDb = new DatabaseSync(testDb);
        const consumedToken = verifyResetDb.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash = ?').get(tokenDigest(validResetToken));
        const savedPasswordHash = verifyResetDb.prepare('SELECT password_hash FROM staff WHERE id = ?').get(ids.execA)?.password_hash;
        verifyResetDb.close();
        check('Successfully used reset token is marked used', Boolean(consumedToken?.used_at), true);
        check('Reset password is stored as an application password hash', Boolean(savedPasswordHash?.startsWith('scrypt$')), true);

        check('Unauthenticated lead deletion is denied', (await call(`/api/leads/${ids.leadDelete}`, { method: 'DELETE' })).status, 401);
        check('Non-admin lead deletion is denied', (await call(`/api/leads/${ids.leadDelete}`, { role: credentials.managerA, method: 'DELETE' })).status, 403);
        check('Admin deletes synthetic lead', (await call(`/api/leads/${ids.leadDelete}`, { role: credentials.admin, method: 'DELETE' })).status, 200);
        check('Non-admin proposal deletion is denied', (await call('/api/proposals/RBAC-TEST-PROPOSAL-B', { role: credentials.execB, method: 'DELETE' })).status, 403);
        check('Admin deletes synthetic proposal', (await call('/api/proposals/RBAC-TEST-PROPOSAL-B', { role: credentials.admin, method: 'DELETE' })).status, 200);
        check('Non-admin lead-file deletion is denied', (await call(`/api/leads/${ids.leadB}/files/RBAC-TEST-LEAD-FILE-B`, { role: credentials.execB, method: 'DELETE' })).status, 403);
        check('Admin deletes synthetic lead file', (await call(`/api/leads/${ids.leadB}/files/RBAC-TEST-LEAD-FILE-B`, { role: credentials.admin, method: 'DELETE' })).status, 200);
        check('Non-admin survey-file deletion is denied', (await call('/api/surveys/RBAC-TEST-SURVEY-B/files/RBAC-TEST-SURVEY-FILE-B', { role: credentials.execB, method: 'DELETE' })).status, 403);
        check('Admin deletes synthetic survey file', (await call('/api/surveys/RBAC-TEST-SURVEY-B/files/RBAC-TEST-SURVEY-FILE-B', { role: credentials.admin, method: 'DELETE' })).status, 200);
        check('Non-admin staff deletion is denied', (await call(`/api/staff/${ids.staffToDelete}`, { role: credentials.managerA, method: 'DELETE' })).status, 403);
        check('Admin cannot delete protected permanent account', (await call('/api/staff/staff-admin', { role: credentials.admin, method: 'DELETE' })).status, 403);
        check('Admin deletes synthetic staff account', (await call(`/api/staff/${ids.staffToDelete}`, { role: credentials.admin, method: 'DELETE' })).status, 200);
        const deletionDb = new DatabaseSync(testDb);
        const deletedLeadCount = deletionDb.prepare('SELECT COUNT(*) AS count FROM leads WHERE id = ?').get(ids.leadDelete).count;
        const deletedProposalCount = deletionDb.prepare('SELECT COUNT(*) AS count FROM proposal_records WHERE id = ?').get('RBAC-TEST-PROPOSAL-B').count;
        const deletedStaffCount = deletionDb.prepare('SELECT COUNT(*) AS count FROM staff WHERE id = ?').get(ids.staffToDelete).count;
        deletionDb.close();
        check('Authorized deletes remove only synthetic target records', deletedLeadCount + deletedProposalCount + deletedStaffCount, 0);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            check(`Reset invalid-token attempt ${attempt + 1} remains generic`, (await call('/api/auth/reset-password', { method: 'POST', body: { token: 'synthetic-invalid-token', newPassword, confirmPassword: newPassword } })).status, 400);
        }
        check('Password reset attempts are rate limited', (await call('/api/auth/reset-password', { method: 'POST', body: { token: 'synthetic-invalid-token', newPassword, confirmPassword: newPassword } })).status, 429);

        currentPhase = 'checking production startup guards';
        check('Production startup refuses missing session secret', productionSecretGuardPasses(), true);
        check('Production startup refuses missing CORS allowlist', productionGuardRejects({ CORS_ORIGIN: '' }, 'CORS_ORIGIN must contain at least one trusted HTTPS origin'), true);
        check('Production startup refuses insecure CORS origins', productionGuardRejects({ CORS_ORIGIN: 'http://crm.test.invalid' }, 'CORS_ORIGIN must contain only valid HTTPS origins'), true);
        check('Production startup requires HTTPS reset URL and mail settings', productionGuardRejects({ PASSWORD_RESET_BASE_URL: '', EMAIL_HOST: '', EMAIL_USER: '', EMAIL_PASSWORD: '' }, 'Production password reset requires an HTTPS PASSWORD_RESET_BASE_URL'), true);

        const failed = checks.some((item) => item.result !== 'PASS');
        currentPhase = 'reporting API assertions';
        console.log(JSON.stringify({ outcome: failed ? 'FAIL' : 'PASS', exitCode: failed ? 1 : 0, assertionCount: checks.length, isolatedDatabase: true, syntheticRecordsOnly: true, checks }, null, 2));
        if (checks.some((item) => item.result !== 'PASS')) process.exitCode = 1;
    } finally {
        if (child.exitCode === null) {
            let exitTimer;
            const exited = new Promise((resolve) => {
                child.once('exit', resolve);
                exitTimer = setTimeout(resolve, 3000);
            });
            child.kill('SIGTERM');
            await exited;
            clearTimeout(exitTimer);
        }
        activeChild = null;
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

watchdog = setTimeout(() => {
    const timedOutChild = activeChild;
    if (timedOutChild && timedOutChild.exitCode === null) {
        timedOutChild.once('close', () => fs.rmSync(testDir, { recursive: true, force: true }));
        timedOutChild.kill('SIGKILL');
    } else {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    console.error(JSON.stringify({ outcome: 'NOT TESTED', exitCode: 1, reason: `Isolated RBAC test exceeded its 90-second time limit during ${currentPhase}.`, checks }, null, 2));
    process.exitCode = 1;
}, MAX_TEST_RUNTIME_MS);

main().catch((error) => {
    console.error(JSON.stringify({ outcome: 'NOT TESTED', exitCode: 1, reason: error.message, serverClosed: activeChild?.closed || false, serverExitCode: activeChild?.closeCode ?? null, capturedServerOutput, checks }, null, 2));
    process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));