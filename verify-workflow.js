const BASE = process.env.CRM_VERIFY_BASE_URL;
const ADMIN_LOGIN_ID = process.env.CRM_VERIFY_ADMIN_LOGIN_ID;
const ADMIN_PASSWORD = process.env.CRM_VERIFY_ADMIN_PASSWORD;
const disposableTargetConfirmed = process.env.CRM_VERIFY_DISPOSABLE_ENVIRONMENT === 'true';

if (!BASE || !ADMIN_LOGIN_ID || !ADMIN_PASSWORD || !disposableTargetConfirmed) {
    throw new Error('Set CRM_VERIFY_BASE_URL, CRM_VERIFY_ADMIN_LOGIN_ID, CRM_VERIFY_ADMIN_PASSWORD, and CRM_VERIFY_DISPOSABLE_ENVIRONMENT=true for a disposable test environment.');
}
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Workflow verification cannot run with NODE_ENV=production.');
}
let target;
try {
    target = new URL(BASE);
} catch (error) {
    throw new Error('CRM_VERIFY_BASE_URL must be a valid local URL.');
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Workflow verification is restricted to a local disposable CRM instance.');
}

function request(path, options = {}, cookie = null) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    return fetch(`${BASE}${path}`, { ...options, headers, credentials: 'same-origin' })
        .then(async (res) => {
            const text = await res.text();
            let body = {};
            try { body = text ? JSON.parse(text) : {}; } catch (err) { body = { raw: text }; }
            return { status: res.status, ok: res.ok, body, headers: res.headers };
        });
}

async function login(loginId, password) {
    const res = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password, rememberMe: false }) });
    if (!res.ok) throw new Error(`Login failed with status ${res.status}.`);
    return res.headers.get('set-cookie')?.split(';', 1)[0] || '';
}

function toIsoDate(date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
    const adminToken = await login(ADMIN_LOGIN_ID, ADMIN_PASSWORD);
    const now = Date.now();
    const empA = { employeeId: `EMP-VERIFY-A-${now}`, name: 'Employee A Verify', loginId: `empA.${now}@example.com`, password: `Synthetic-${now}-A`, role: 'Sales Executive', department: 'Sales', designation: 'Sales Executive', status: 'Active' };
    const empB = { employeeId: `EMP-VERIFY-B-${now}`, name: 'Employee B Verify', loginId: `empB.${now}@example.com`, password: `Synthetic-${now}-B`, role: 'Sales Executive', department: 'Sales', designation: 'Sales Executive', status: 'Active' };

    const createdA = await request('/api/staff', { method: 'POST', body: JSON.stringify(empA) }, adminToken);
    const createdB = await request('/api/staff', { method: 'POST', body: JSON.stringify(empB) }, adminToken);
    console.log('CREATE_STAFF', { A: createdA.status, B: createdB.status });

    const staffList = await request('/api/staff', {}, adminToken);
    const staff = staffList.body.staff || [];
    const empARecord = staff.find((s) => s.loginId === empA.loginId);
    const empBRecord = staff.find((s) => s.loginId === empB.loginId);

    if (!empARecord || !empBRecord) {
        throw new Error(`Employees not found. A=${!!empARecord}, B=${!!empBRecord}`);
    }

    const empAToken = await login(empA.loginId, empA.password);
    const empBToken = await login(empB.loginId, empB.password);

    const leadMobile = `+91${String(now).slice(-9)}`;
    const tomorrow = new Date(Date.now() + 86400000);
    const leadCreate = await request('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
            customerName: 'Verification Lead A',
            mobileNumber: leadMobile,
            leadDate: toIsoDate(new Date()),
            leadSource: 'Website',
            assignedTo: empARecord.id,
            leadPriority: 'Hot',
            location: 'Bengaluru',
            address: 'Bengaluru'
        })
    }, adminToken);

    const leadId = leadCreate.body?.lead?.leadId;
    console.log('CREATE_LEAD', { status: leadCreate.status, ok: leadCreate.ok, created: Boolean(leadId) });

    const groupsA = await request('/api/dashboard/groups', {}, empAToken);
    const groupsB = await request('/api/dashboard/groups', {}, empBToken);
    const newA = (groupsA.body?.groups?.newLeads || []).map((l) => l.lead_id || l.id || l.leadId);
    const newB = (groupsB.body?.groups?.newLeads || []).map((l) => l.lead_id || l.id || l.leadId);
    console.log('NEW_LEADS_A_B', { A: newA.includes(leadId), B: newB.includes(leadId) });

    const unauthorizedPatch = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify({ customerName: 'Should fail' }) }, empBToken);
    const unauthorizedStage = await request(`/api/leads/${encodeURIComponent(leadId)}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'Qualified' }) }, empBToken);
    const unauthorizedAssign = await request(`/api/leads/${encodeURIComponent(leadId)}/assignment`, { method: 'POST', body: JSON.stringify({ assignedTo: empBRecord.id }) }, empBToken);
    const unauthorizedDelete = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' }, empBToken);
    const unauth = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify({ customerName: 'No auth' }) });
    console.log('UNAUTH_CHECKS', {
        unauthorizedPatch: unauthorizedPatch.status,
        unauthorizedStage: unauthorizedStage.status,
        unauthorizedAssign: unauthorizedAssign.status,
        unauthorizedDelete: unauthorizedDelete.status,
        unauth: unauth.status,
    });

    const updateOwn = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify({ customerName: 'Verification Lead A Updated', location: 'Mysuru' }) }, empAToken);
    console.log('EMPLOYEE_UPDATE_OWN', { status: updateOwn.status, ok: updateOwn.ok });

    const stageOwn = await request(`/api/leads/${encodeURIComponent(leadId)}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'Qualified' }) }, empAToken);
    console.log('EMPLOYEE_STAGE_OWN', { status: stageOwn.status, ok: stageOwn.ok });

    const taskCreate = await request(`/api/leads/${encodeURIComponent(leadId)}/follow-ups`, {
        method: 'POST',
        body: JSON.stringify({ date: toIsoDate(tomorrow), time: '10:30', type: 'Call', notes: 'Task persistence verification' })
    }, empAToken);
    const taskId = taskCreate.body?.id;
    console.log('TASK_CREATE', { status: taskCreate.status, ok: taskCreate.ok, created: Boolean(taskId) });

    const taskList = await request('/api/tasks', {}, empAToken);
    console.log('TASK_LIST', { status: taskList.status });

    const dashboardAfterTask = await request('/api/dashboard/groups', {}, empAToken);
    const todayIds = (dashboardAfterTask.body?.groups?.todaysFollowUps || []).map((f) => f.id || f.follow_up_id || f.followUpId || f.taskId || f.lead_id);
    console.log('TODAY_FOLLOWUPS_AFTER_TASK', { taskPresent: todayIds.includes(taskId) });

    const relogged = await login(empA.loginId, empA.password);
    const dashboardAfterRelogin = await request('/api/dashboard/groups', {}, relogged);
    const leadAfterRelogin = await request(`/api/leads/${encodeURIComponent(leadId)}`, {}, relogged);
    console.log('RELOGIN_PERSISTENCE', { leadOk: leadAfterRelogin.ok, dashboardOk: dashboardAfterRelogin.ok });

    const adminDelete = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' }, adminToken);
    console.log('ADMIN_DELETE', { status: adminDelete.status, ok: adminDelete.ok });
}

main().catch((err) => {
    console.error('WORKFLOW_TEST_ERROR', err.name || 'Error');
    process.exit(1);
});
