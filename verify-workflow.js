const BASE = 'http://localhost:3000';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./crm.sqlite');

function request(path, options = {}, token = null) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${BASE}${path}`, { ...options, headers, credentials: 'same-origin' })
        .then(async (res) => {
            const text = await res.text();
            let body = {};
            try { body = text ? JSON.parse(text) : {}; } catch (err) { body = { raw: text }; }
            return { status: res.status, ok: res.ok, body };
        });
}

async function login(loginId, password) {
    const res = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password, rememberMe: false }) });
    if (!res.ok) throw new Error(`${loginId} login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token;
}

function toIsoDate(date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
    const adminToken = await login('varunkv@inpacepower.com', 'Admin@12345');
    const now = Date.now();
    const empA = { employeeId: `EMP-VERIFY-A-${now}`, name: 'Employee A Verify', loginId: `empA.${now}@example.com`, password: 'Passw0rd!A', role: 'Sales Executive', department: 'Sales', designation: 'Sales Executive', status: 'Active' };
    const empB = { employeeId: `EMP-VERIFY-B-${now}`, name: 'Employee B Verify', loginId: `empB.${now}@example.com`, password: 'Passw0rd!B', role: 'Sales Executive', department: 'Sales', designation: 'Sales Executive', status: 'Active' };

    const createdA = await request('/api/staff', { method: 'POST', body: JSON.stringify(empA) }, adminToken);
    const createdB = await request('/api/staff', { method: 'POST', body: JSON.stringify(empB) }, adminToken);
    console.log('CREATE_STAFF', { A: createdA.status, B: createdB.status, ABody: createdA.body, BBody: createdB.body });

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
    console.log('CREATE_LEAD', { status: leadCreate.status, ok: leadCreate.ok, leadId, body: leadCreate.body });

    const dbLead = db.prepare('SELECT id, assigned_to, customer_name, stage, created_at FROM leads WHERE id = ?').get(leadId);
    console.log('DB_OWNER', dbLead);

    const groupsA = await request('/api/dashboard/groups', {}, empAToken);
    const groupsB = await request('/api/dashboard/groups', {}, empBToken);
    const newA = (groupsA.body?.groups?.newLeads || []).map((l) => l.lead_id || l.id || l.leadId);
    const newB = (groupsB.body?.groups?.newLeads || []).map((l) => l.lead_id || l.id || l.leadId);
    console.log('NEW_LEADS_A_B', { A: newA.includes(leadId), B: newB.includes(leadId), AIds: newA, BIds: newB });

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
        patchBody: unauthorizedPatch.body,
        stageBody: unauthorizedStage.body,
        assignBody: unauthorizedAssign.body,
        deleteBody: unauthorizedDelete.body,
        unauthBody: unauth.body
    });

    const updateOwn = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify({ customerName: 'Verification Lead A Updated', location: 'Mysuru' }) }, empAToken);
    console.log('EMPLOYEE_UPDATE_OWN', { status: updateOwn.status, ok: updateOwn.ok, body: updateOwn.body });

    const stageOwn = await request(`/api/leads/${encodeURIComponent(leadId)}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'Qualified' }) }, empAToken);
    console.log('EMPLOYEE_STAGE_OWN', { status: stageOwn.status, ok: stageOwn.ok, body: stageOwn.body });

    const taskCreate = await request(`/api/leads/${encodeURIComponent(leadId)}/follow-ups`, {
        method: 'POST',
        body: JSON.stringify({ date: toIsoDate(tomorrow), time: '10:30', type: 'Call', notes: 'Task persistence verification' })
    }, empAToken);
    const taskId = taskCreate.body?.id;
    console.log('TASK_CREATE', { status: taskCreate.status, ok: taskCreate.ok, taskId, body: taskCreate.body });

    const taskList = await request('/api/tasks', {}, empAToken);
    console.log('TASK_LIST', { status: taskList.status, body: taskList.body });

    const dashboardAfterTask = await request('/api/dashboard/groups', {}, empAToken);
    const todayIds = (dashboardAfterTask.body?.groups?.todaysFollowUps || []).map((f) => f.id || f.follow_up_id || f.followUpId || f.taskId || f.lead_id);
    console.log('TODAY_FOLLOWUPS_AFTER_TASK', { taskId, todayIds });

    const relogged = await login(empA.loginId, empA.password);
    const dashboardAfterRelogin = await request('/api/dashboard/groups', {}, relogged);
    const leadAfterRelogin = await request(`/api/leads/${encodeURIComponent(leadId)}`, {}, relogged);
    console.log('RELOGIN_PERSISTENCE', { leadOk: leadAfterRelogin.ok, dashboardOk: dashboardAfterRelogin.ok, leadBody: leadAfterRelogin.body, taskListBody: dashboardAfterRelogin.body });

    const adminDelete = await request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' }, adminToken);
    console.log('ADMIN_DELETE', { status: adminDelete.status, ok: adminDelete.ok, body: adminDelete.body });
}

main().catch((err) => {
    console.error('WORKFLOW_TEST_ERROR', err.stack || err.message || err);
    process.exit(1);
});
