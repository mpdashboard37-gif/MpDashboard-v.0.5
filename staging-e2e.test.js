const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');

let tempDir;
let baseUrl;
let server;
let browser;
let context;
let page;
let testDb;
let serverStderr = '';
const credentials = Object.fromEntries(['managerA', 'managerB', 'execA', 'execB', 'telecaller'].map((role) => [role, {
    id: `e2e-${role}-${crypto.randomUUID()}`,
    loginId: `${role}.${crypto.randomUUID()}@test.invalid`,
    password: crypto.randomBytes(24).toString('base64url')
}]));

function freePort() {
    return new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const port = listener.address().port;
            listener.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function passwordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

async function browserLogin(browserPage, user, password = user.password) {
    await browserPage.goto(`${baseUrl}/login.html`);
    await browserPage.locator('#loginId').fill(user.loginId);
    await browserPage.locator('#password').fill(password);
    await browserPage.locator('#termsCheck').check();
    await browserPage.locator('#loginButton').click();
}

async function browserApi(browserPage, route, { method = 'GET', body } = {}) {
    return browserPage.evaluate(async ({ route, method, body }) => {
        const response = await fetch(route, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (error) { data = text; }
        return { status: response.status, data };
    }, { route, method, body });
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-crm-staging-e2e-'));
    testDb = path.join(tempDir, 'crm.sqlite');
    const uploadDir = path.join(tempDir, 'uploads');
    fs.mkdirSync(uploadDir);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const childSource = `require('./server.js');`;
    server = spawn(process.execPath, ['-e', childSource], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            DATABASE_MODE: 'sqlite',
            SQLITE_DB_PATH: testDb,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_PORT: '',
            DB_USER: '',
            DB_PASSWORD: '',
            DB_NAME: '',
            SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
            ADMIN_INITIAL_PASSWORD: crypto.randomBytes(24).toString('base64url'),
            PASSWORD_RESET_BASE_URL: `${baseUrl}/login.html`,
            CRM_FILE_STORAGE_ROOT: uploadDir,
            CORS_ORIGIN: baseUrl,
            GOOGLE_CLIENT_ID: '',
            GOOGLE_CLIENT_SECRET: '',
            GOOGLE_REDIRECT_URI: ''
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (chunk) => { serverStderr += chunk.toString(); });

    const deadline = Date.now() + 20000;
    let serverReady = false;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error('Isolated CRM server failed to start.');
        try {
            const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                serverReady = true;
                break;
            }
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    if (!serverReady) throw new Error('Timed out waiting for the isolated CRM server.');

    const database = new DatabaseSync(testDb);
    try {
        const now = new Date().toISOString();
        const addStaff = database.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, manager_id, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)');
        for (const role of ['managerA', 'managerB', 'execA', 'execB', 'telecaller']) {
            const user = credentials[role];
            const staffRole = role.startsWith('manager') ? 'Sales Manager' : role === 'telecaller' ? 'Telecaller' : 'Sales Executive';
            const managerId = role === 'execA' || role === 'telecaller' ? credentials.managerA.id : role === 'execB' ? credentials.managerB.id : null;
            addStaff.run(user.id, `E2E-${role}`, `Synthetic ${role}`, user.loginId, 'QA', staffRole, user.loginId, passwordHash(user.password), staffRole, 'Active', 'ACTIVE', managerId, now);
        }
        const addLead = database.prepare("INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, status, created_by, created_at, updated_at, details_json, lead_score, lead_category) VALUES (?, ?, ?, ?, ?, ?, 'Synthetic QA', ?, 'New', 'Warm', 'Active', ?, ?, ?, '{}', 0, 'Cold')");
        addLead.run('E2E-FOREIGN-LEAD', 'E2E-FOREIGN-001', 'Synthetic Foreign Lead', '9999980001', credentials.execB.loginId, '2026-10-12', credentials.execB.id, credentials.execB.id, now, now);
    } finally {
        database.close();
    }

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
});

after(async () => {
    if (context) await context.close();
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
        server.kill('SIGTERM');
        const stopped = await Promise.race([
            new Promise((resolve) => server.once('exit', resolve)),
            new Promise((resolve) => setTimeout(() => resolve(false), 10000))
        ]);
        if (stopped === false) throw new Error('Isolated CRM test server did not stop cleanly.');
    }
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('disposable CRM browser workflow uses cookie sessions and enforces role permissions', async () => {
    await page.goto(`${baseUrl}/login.html`);
    await page.locator('#loginId').fill(credentials.execA.loginId);
    await page.locator('#password').fill('invalid-synthetic-password');
    await page.locator('#termsCheck').check();
    await page.locator('#loginButton').click();
    await page.locator('#loginMessage:not(.hidden)').waitFor();
    assert.match(await page.locator('#loginMessage').innerText(), /invalid|password/i);

    await browserLogin(page, credentials.execA);
    await page.waitForURL('**/index.html', { timeout: 10000 });
    assert.doesNotMatch(await page.evaluate(() => document.cookie), /crm_session=/);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => /api_token/i.test(key))), false);
    assert.equal((await browserApi(page, '/api/auth/me')).status, 200);

    for (const route of ['/lead-management.html', '/task-list.html', '/site-survey.html']) {
        await page.goto(`${baseUrl}${route}`);
        assert.equal(new URL(page.url()).pathname, route);
        assert.equal((await browserApi(page, '/api/auth/me')).status, 200);
    }

    const createdLead = await browserApi(page, '/api/leads', {
        method: 'POST',
        body: {
            customerName: 'Synthetic Browser Lead',
            mobileNumber: `98${crypto.randomInt(10000000, 99999999)}`,
            leadDate: new Date().toISOString().slice(0, 10),
            leadSource: 'Synthetic QA',
            assignedTo: credentials.execA.id,
            address: 'Synthetic browser test location'
        }
    });
    assert.equal(createdLead.status, 201);
    const leadId = createdLead.data?.lead?.leadId;
    assert.ok(leadId);
    const changedLead = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: { customerName: 'Synthetic Browser Lead Updated' } });
    assert.equal(changedLead.status, 200);
    await page.goto(`${baseUrl}/lead-management.html`);
    await page.getByText('Synthetic Browser Lead Updated', { exact: false }).first().waitFor({ timeout: 10000 });

    const futureDate = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const task = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/follow-ups`, {
        method: 'POST',
        body: { taskTitle: 'Synthetic browser task', date: futureDate(12), time: '10:00', type: 'Call', notes: 'synthetic' }
    });
    assert.equal(task.status, 201);
    assert.equal((await browserApi(page, '/api/tasks')).data?.tasks?.some((item) => item.taskId === task.data.id), true);
    assert.equal((await browserApi(page, `/api/tasks/${task.data.id}`, { method: 'PATCH', body: { title: 'Synthetic browser task updated', dueAt: `${futureDate(18)}T11:00` } })).status, 200);
    assert.equal((await browserApi(page, `/api/tasks/${task.data.id}/complete`, { method: 'POST' })).status, 200);

    const followUp = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/follow-ups`, {
        method: 'POST',
        body: { taskTitle: 'Synthetic browser follow-up', date: futureDate(13), time: '12:00', type: 'Meeting', notes: 'synthetic' }
    });
    assert.equal(followUp.status, 201);
    assert.equal((await browserApi(page, `/api/tasks/${followUp.data.id}`, { method: 'PATCH', body: { notes: 'updated synthetic follow-up' } })).status, 200);
    assert.equal((await browserApi(page, `/api/follow-ups/${followUp.data.id}/complete`, { method: 'POST', body: { remarks: 'synthetic completion' } })).status, 200);

    const surveyDate = `${futureDate(30)}T10:00`;
    const survey = await browserApi(page, '/api/surveys', {
        method: 'POST',
        body: { leadId, surveyDate, address: 'Synthetic browser survey location' }
    });
    assert.equal(survey.status, 201);
    const surveyId = survey.data?.surveyId;
    assert.equal((await browserApi(page, `/api/surveys/${surveyId}`)).status, 200);
    assert.equal((await browserApi(page, `/api/surveys/${surveyId}`, { method: 'PATCH', body: { notes: 'Updated synthetic survey' } })).status, 200);
    const workflowDatabase = new DatabaseSync(testDb);
    workflowDatabase.prepare("UPDATE leads SET stage = 'Site Survey Scheduled' WHERE id = ?").run(leadId);
    workflowDatabase.close();
    assert.equal((await browserApi(page, `/api/surveys/${surveyId}`, { method: 'PATCH', body: { status: 'Completed' } })).status, 422);
    const evidenceCategories = ['EAST_SIDE_PHOTO', 'WEST_SIDE_PHOTO', 'NORTH_SIDE_PHOTO', 'SOUTH_SIDE_PHOTO', 'ELECTRICITY_METER_PHOTO', 'ELECTRICITY_BILL', 'EARTHING_LOCATION_PHOTO', 'ROOF_PHOTO', 'ROOF_360_VIDEO'];
    for (const category of evidenceCategories) {
        const evidence = await browserApi(page, `/api/surveys/${surveyId}/files`, {
            method: 'POST',
            body: { category, files: [{ fileName: `browser-${category}.pdf`, mimeType: 'application/pdf', fileData: `data:application/pdf;base64,${Buffer.from('synthetic evidence').toString('base64')}` }] }
        });
        assert.equal(evidence.status, 201);
    }
    assert.equal((await browserApi(page, `/api/surveys/${surveyId}`, {
        method: 'PATCH',
        body: {
            status: 'Completed',
            data: {
                latitude: '12.9716', longitude: '77.5946', locationAccuracy: '5',
                electricityProvider: 'Synthetic Utility', consumerNumber: 'SYNTHETIC-CONSUMER',
                meterNumber: 'SYNTHETIC-METER', sanctionedLoad: '5', phase: 'Single',
                proposedCapacity: '5', systemType: 'On-grid', installationType: 'Rooftop',
                roofType: 'Concrete', roofArea: '100', usableRoofArea: '90',
                roofCondition: 'Good', shadowCondition: 'None', roofDirection: 'South',
                existingEarthing: 'Yes', earthingCondition: 'Good', roofAccess: 'Safe',
                engineerObservations: 'Synthetic inspection notes'
            }
        }
    })).status, 200);

    const fileData = `data:application/pdf;base64,${Buffer.from('%PDF browser fixture').toString('base64')}`;
    const upload = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`, {
        method: 'POST',
        body: { category: 'Other', files: [{ fileName: 'browser-fixture.pdf', mimeType: 'application/pdf', fileData }] }
    });
    assert.equal(upload.status, 201);
    const fileId = upload.data?.files?.[0]?.id;
    assert.ok(fileId);
    const download = await browserApi(page, `/api/files/${fileId}`);
    assert.equal(download.status, 200);
    assert.match(download.data, /%PDF browser fixture/);
    assert.equal((await browserApi(page, `/api/leads/${leadId}/files/${fileId}`, { method: 'DELETE' })).status, 403);

    const foreignContext = await browser.newContext();
    const foreignPage = await foreignContext.newPage();
    await browserLogin(foreignPage, credentials.execB);
    await foreignPage.waitForURL('**/index.html', { timeout: 10000 });
    assert.equal((await browserApi(foreignPage, `/api/leads/${leadId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/files/${fileId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/surveys/${surveyId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/leads/${leadId}/files`, {
        method: 'POST', body: { category: 'Other', files: [{ fileName: 'unauthorized.pdf', mimeType: 'application/pdf', fileData }] }
    })).status, 403);
    await foreignContext.close();

    await page.goto(`${baseUrl}/index.html`);
    await page.locator('.sidebar-logout-btn').click();
    await page.waitForURL('**/login.html', { timeout: 10000 });
    assert.equal((await browserApi(page, '/api/auth/me')).status, 401);
});

test('proposal workflow resolves the selected lead, saves once, and generates an in-CRM PDF', async (testContext) => {
    const proposalContext = await browser.newContext();
    const page = await proposalContext.newPage();
    testContext.after(() => proposalContext.close());
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await browserLogin(page, credentials.execA);
    await page.waitForURL('**/index.html', { timeout: 10000 });

    const createdLead = await browserApi(page, '/api/leads', {
        method: 'POST',
        body: {
            customerName: 'Synthetic Proposal Customer',
            mobileNumber: `98${crypto.randomInt(10000000, 99999999)}`,
            email: 'proposal-customer@test.invalid',
            leadDate: new Date().toISOString().slice(0, 10),
            leadSource: 'Synthetic Proposal QA',
            assignedTo: credentials.execA.id,
            address: '42 Synthetic Proposal Street',
            city: 'Bengaluru',
            pincode: '560001'
        }
    });
    assert.equal(createdLead.status, 201);
    const leadId = createdLead.data?.lead?.leadId;
    assert.ok(leadId);

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    const createProposalLink = page.locator('a[href^="proposal.html?create=1&leadId="]').first();
    await createProposalLink.waitFor({ state: 'visible', timeout: 10000 });
    await createProposalLink.click();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(new URL(page.url()).origin, baseUrl);
    assert.equal(new URL(page.url()).pathname, '/proposal.html');
    assert.equal(new URL(page.url()).searchParams.get('leadId'), leadId);
    await page.locator('#formView:not(.hidden)').waitFor();
    assert.equal(await page.locator('#leadSelect').inputValue(), leadId);
    const customerSummary = await page.locator('#customerFields').innerText();
    assert.match(customerSummary, /Synthetic Proposal Customer/);
    assert.match(customerSummary, /42 Synthetic Proposal Street/);
    assert.match(customerSummary, /560001/);
    assert.equal(await page.locator('[name="gst"]').getAttribute('readonly'), '');

    const missingLead = await browserApi(page, '/api/proposals', { method: 'POST', body: { systemCapacity: 3 } });
    const invalidLead = await browserApi(page, '/api/proposals', { method: 'POST', body: { leadId: 'SYNTHETIC-MISSING-LEAD', systemCapacity: 3 } });
    assert.equal(missingLead.status, 422);
    assert.equal(invalidLead.status, 404);

    for (const [capacity, rate, slab] of [
        [3, 75000, '3-4.99 kW'],
        [5, 68000, '5-7.99 kW'],
        [8, 60000, '8-9.99 kW'],
        [10, 55000, '10-15 kW'],
        [15, 55000, '10-15 kW']
    ]) {
        const pricing = await browserApi(page, `/api/proposals/pricing?capacity=${capacity}`);
        assert.equal(pricing.status, 200);
        assert.equal(pricing.data.pricing.rate, rate);
        assert.equal(pricing.data.pricing.slab, slab);
        assert.equal(pricing.data.pricing.gstRate, 5);
        assert.equal(pricing.data.pricing.gst, Math.round(pricing.data.pricing.subtotal * 5) / 100);
    }

    const foreignLead = await browserApi(page, '/api/proposals', {
        method: 'POST',
        body: { leadId: 'E2E-FOREIGN-LEAD', systemType: 'On-Grid', systemCapacity: 3, inverterCapacity: 3 }
    });
    assert.equal(foreignLead.status, 403);

    const pricingResponses = [];
    page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/proposals/pricing') pricingResponses.push(response.status());
    });
    const pricingRequestFailures = [];
    page.on('requestfailed', (request) => {
        if (new URL(request.url()).pathname === '/api/proposals/pricing') pricingRequestFailures.push(request.failure()?.errorText || 'request failed');
    });
    await page.locator('[name="systemCapacity"]').fill('3');
    await page.locator('[name="inverterCapacity"]').fill('3');
    await page.waitForFunction(() => document.querySelector('#pricingSource')?.textContent.includes('3-4.99 kW'), null, { timeout: 8000 }).catch(async () => {
        throw new Error(`Pricing UI did not update; source=${await page.locator('#pricingSource').innerText()}, toast=${await page.locator('#toast').innerText()}, responses=${JSON.stringify(pricingResponses)}, failed=${JSON.stringify(pricingRequestFailures)}`);
    });
    const saves = [];
    const saveBodies = [];
    page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/proposals' && response.request().method() === 'POST') {
            saves.push(response.status());
            response.json().then((body) => saveBodies.push(body)).catch(() => saveBodies.push({ error: 'non-JSON response' }));
        }
    });
    await page.locator('#saveButton').evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.startsWith('Saved '), null, { timeout: 10000 }).catch(async () => {
        await page.waitForTimeout(100);
        throw new Error(`Proposal save failed; toast=${await page.locator('#toast').innerText()}, statuses=${JSON.stringify(saves)}, responses=${JSON.stringify(saveBodies)}, server=${serverStderr.slice(-1500)}`);
    });
    await page.waitForFunction(() => Boolean(document.querySelector('[name="id"]')?.value));
    const proposalId = await page.locator('[name="id"]').inputValue();
    assert.ok(proposalId);
    assert.deepEqual(saves, [201]);

    const proposalResponse = await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}`);
    assert.equal(proposalResponse.status, 200);
    const proposal = proposalResponse.data.proposal;
    assert.equal(proposal.leadId, leadId);
    assert.equal(proposal.customerName, 'Synthetic Proposal Customer');
    assert.equal(proposal.contactNumber, createdLead.data.lead.mobileNumber);
    assert.equal(proposal.email, 'proposal-customer@test.invalid');
    assert.equal(proposal.address, '42 Synthetic Proposal Street');
    assert.equal(proposal.pincode, '560001');
    assert.equal(proposal.subtotal, 225000);
    assert.equal(proposal.gst, 11250);
    assert.equal(proposal.grossAmount, 236250);
    assert.equal(proposal.status, 'Draft');

    const pdf = await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}/pdf`, { method: 'POST', body: {} });
    assert.equal(pdf.status, 200);
    assert.match(pdf.data.pdfData, /^data:application\/pdf;base64,/);
    assert.equal(Buffer.from(pdf.data.pdfData.split(',')[1], 'base64').subarray(0, 4).toString(), '%PDF');

    await page.route(`**/api/proposals/${proposalId}`, async (route) => {
        if (route.request().method() === 'POST') {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save failure.' }) });
            return;
        }
        await route.continue();
    });
    await page.locator('#saveButton').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Synthetic save failure.');
    await page.unroute(`**/api/proposals/${proposalId}`);

    const proposals = await browserApi(page, `/api/proposals?q=${encodeURIComponent('Synthetic Proposal Customer')}`);
    assert.equal(proposals.data.proposals.filter((item) => item.leadId === leadId).length, 1);

    await page.goto(`${baseUrl}/proposal.html?create=1&leadId=E2E-FOREIGN-LEAD`);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('permission'));
    assert.equal(await page.locator('#leadSelect').inputValue(), '');
    assert.deepEqual(pageErrors, []);
    assert.doesNotMatch(serverStderr, /proposal.*(?:failed|error)/i);

    const foreignContext = await browser.newContext();
    const foreignPage = await foreignContext.newPage();
    await browserLogin(foreignPage, credentials.execB);
    await foreignPage.waitForURL('**/index.html', { timeout: 10000 });
    assert.equal((await browserApi(foreignPage, `/api/proposals/${encodeURIComponent(proposalId)}`)).status, 404);
    await foreignContext.close();
});
