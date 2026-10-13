const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');

const rootDir = __dirname;
const srcDb = path.join(rootDir, 'crm.sqlite');
const testDb = path.join(rootDir, 'crm.sqlite.role-check');
const port = 3023;

if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
fs.copyFileSync(srcDb, testDb);

const db = new DatabaseSync(testDb);
const hash = (password) => bcrypt.hashSync(password, 10);

const ensureUser = (user) => {
    const existing = db.prepare('SELECT id FROM staff WHERE id = ? OR login_id = ?').get(user.id, user.loginId);
    if (existing) {
        db.prepare('UPDATE staff SET name = ?, department = ?, designation = ?, login_id = ?, password_hash = ?, role = ?, status = ?, account_status = ?, manager_id = ? WHERE id = ?')
            .run(user.name, user.department, user.designation, user.loginId, hash(user.password), user.role, 'Active', 'ACTIVE', user.managerId || null, user.id);
        return;
    }
    db.prepare('INSERT INTO staff (id, employee_id, name, department, designation, login_id, password_hash, role, status, account_status, manager_id, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(user.id, user.employeeId, user.name, user.department, user.designation, user.loginId, hash(user.password), user.role, 'Active', 'ACTIVE', user.managerId || null, new Date().toISOString());
};

const now = new Date().toISOString();
ensureUser({ id: 'staff-admin-tmp', employeeId: 'EMP-ADMIN-TMP', name: 'Owner Admin', department: 'Administration', designation: 'Owner', loginId: 'admin.tmp@test.local', password: 'TempAdminPass!2026', role: 'Admin/Owner' });
ensureUser({ id: 'staff-mgr-1', employeeId: 'EMP-MGR-1', name: 'Manager One', department: 'Sales', designation: 'Sales Manager', loginId: 'manager.one@test.local', password: 'ManagerPass!123', role: 'Sales Manager' });
ensureUser({ id: 'staff-exec-1', employeeId: 'EMP-EXEC-1', name: 'Exec One', department: 'Sales', designation: 'Sales Executive', loginId: 'exec.one@test.local', password: 'ExecPass!123', role: 'Sales Executive', managerId: 'staff-mgr-1' });
ensureUser({ id: 'staff-exec-2', employeeId: 'EMP-EXEC-2', name: 'Exec Two', department: 'Sales', designation: 'Sales Executive', loginId: 'exec.two@test.local', password: 'OtherExec!123', role: 'Sales Executive', managerId: 'staff-mgr-1' });
ensureUser({ id: 'staff-tel-1', employeeId: 'EMP-TEL-1', name: 'Tele One', department: 'Sales', designation: 'Telecaller', loginId: 'tele.one@test.local', password: 'TelePass!123', role: 'Telecaller', managerId: 'staff-mgr-1' });

const leadInsert = (id, leadNumber, assignedTo, customerName) => {
    const existing = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
    if (!existing) {
        db.prepare(`INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, status, created_by, created_at, updated_at, details_json, lead_score, lead_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', 'Warm', 'Active', ?, ?, ?, ?, 0, 'Cold')`)
            .run(id, leadNumber, customerName, `99999${Math.floor(Math.random() * 9000 + 1000)}`, `${customerName.toLowerCase().replace(/\s+/g, '.')}@test.local`, '2026-01-01', 'Website', assignedTo, assignedTo, now, now, JSON.stringify({}));
    }
};
leadInsert('TEST-LEAD-OWN', 'INP-TEST-1001', 'staff-exec-1', 'Own Lead');
leadInsert('TEST-LEAD-OTHER', 'INP-TEST-1002', 'staff-exec-2', 'Other Lead');
leadInsert('TEST-LEAD-TEL', 'INP-TEST-1003', 'staff-tel-1', 'Tele Lead');

const child = spawn(process.execPath, ['-e', `const config = require('./database/config.js'); config.sqlitePath = ${JSON.stringify(testDb)}; require('./server.js');`], {
    cwd: rootDir,
    env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DATABASE_MODE: 'sqlite',
        SESSION_SECRET: 'integration-auth-check-secret',
        ADMIN_INITIAL_PASSWORD: 'TempAdminPass!2026',
        CORS_ORIGIN: `http://localhost:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => {
    childOutput += chunk.toString();
    process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
    childOutput += chunk.toString();
    process.stderr.write(chunk);
});

const waitForServer = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://localhost:${port}/api/auth/me`, { signal: AbortSignal.timeout(1500) });
            if (response.status === 401 || response.status === 200) return;
        } catch (error) {
            // wait and retry
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Server did not become ready in time.\n' + childOutput);
};

(async () => {
    try {
        await waitForServer();

        const call = async (path, options = {}) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
                const response = await fetch(`http://localhost:${port}${path}`, { ...options, signal: controller.signal });
                const text = await response.text();
                let body;
                try { body = JSON.parse(text); } catch (error) { body = text; }
                return { status: response.status, headers: response.headers, body };
            } finally {
                clearTimeout(timer);
            }
        };

        const login = async (loginId, password) => {
            const result = await call('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ loginId, password })
            });
            const cookies = result.headers.getSetCookie ? result.headers.getSetCookie() : (result.headers.get('set-cookie') || '');
            return { ...result, cookies: Array.isArray(cookies) ? cookies.join('; ') : String(cookies) };
        };

        const admin = await login('admin.tmp@test.local', 'TempAdminPass!2026');
        const manager = await login('manager.one@test.local', 'ManagerPass!123');
        const exec = await login('exec.one@test.local', 'ExecPass!123');
        const tele = await login('tele.one@test.local', 'TelePass!123');

        const checks = [];
        checks.push({ name: 'Admin can view other exec lead', result: (await call('/api/leads/TEST-LEAD-OTHER', { headers: { Cookie: admin.cookies } })).status === 200 ? 'PASS' : 'FAIL' });
        checks.push({ name: 'Exec can view own lead', result: (await call('/api/leads/TEST-LEAD-OWN', { headers: { Cookie: exec.cookies } })).status === 200 ? 'PASS' : 'FAIL' });
        checks.push({ name: 'Exec blocked from other exec lead', result: (await call('/api/leads/TEST-LEAD-OTHER', { headers: { Cookie: exec.cookies } })).status === 403 ? 'PASS' : 'FAIL' });
        checks.push({ name: 'Manager can view employee lead', result: (await call('/api/leads/TEST-LEAD-OWN', { headers: { Cookie: manager.cookies } })).status === 200 ? 'PASS' : 'FAIL' });
        checks.push({ name: 'Telecaller blocked from other lead', result: (await call('/api/leads/TEST-LEAD-OTHER', { headers: { Cookie: tele.cookies } })).status === 403 ? 'PASS' : 'FAIL' });

        const execPatch = await call('/api/leads/TEST-LEAD-OTHER', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: exec.cookies }, body: JSON.stringify({ customerName: 'Hacked' }) });
        checks.push({ name: 'Exec PATCH blocked on foreign lead', result: execPatch.status === 403 ? 'PASS' : `FAIL:${execPatch.status}` });

        const managerPatch = await call('/api/leads/TEST-LEAD-OWN', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: manager.cookies }, body: JSON.stringify({ customerName: 'Manager Edit' }) });
        checks.push({ name: 'Manager PATCH allowed on team lead', result: managerPatch.status === 200 ? 'PASS' : `FAIL:${managerPatch.status}` });

        console.log(JSON.stringify({ admin: admin.status, manager: manager.status, exec: exec.status, tele: tele.status, checks }, null, 2));
    } catch (error) {
        console.error('ROLE_CHECK_ERROR');
        console.error(String(error.stack || error));
        process.exitCode = 1;
    } finally {
        child.kill('SIGTERM');
        process.exit();
    }
})();
