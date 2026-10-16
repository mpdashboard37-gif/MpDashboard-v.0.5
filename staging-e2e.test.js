const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
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
let serverEnvironment;
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

async function startTestServer() {
    server = spawn(process.execPath, ['-e', "require('./server.js');"], {
        cwd: __dirname,
        env: serverEnvironment,
        stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (chunk) => { serverStderr += chunk.toString(); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`Isolated CRM server failed to start: ${serverStderr.slice(-1500)}`);
        try {
            const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) return;
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    throw new Error(`Timed out waiting for the isolated CRM server: ${serverStderr.slice(-1500)}`);
}

async function stopTestServer() {
    if (!server || server.exitCode !== null) return;
    server.kill('SIGTERM');
    const stopped = await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(() => resolve(false), 10000))
    ]);
    if (stopped === false) throw new Error('Isolated CRM test server did not stop cleanly.');
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

async function browserFile(browserPage, route) {
    return browserPage.evaluate(async (fileRoute) => {
        const response = await fetch(fileRoute, { credentials: 'same-origin' });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
            status: response.status,
            contentType: response.headers.get('Content-Type'),
            disposition: response.headers.get('Content-Disposition'),
            bytes: Array.from(bytes.slice(0, 8)),
            length: bytes.length
        };
    }, route);
}

async function browserBinary(browserPage, route, method = 'GET', includeBase64 = false) {
    return browserPage.evaluate(async ({ route, method, includeBase64 }) => {
        const response = await fetch(route, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined, body: method === 'POST' ? '{}' : undefined });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
            status: response.status,
            contentType: response.headers.get('Content-Type'),
            disposition: response.headers.get('Content-Disposition'),
            header: Array.from(bytes.slice(0, 4)),
            footer: new TextDecoder().decode(bytes.slice(-16)),
            pageCount: (new TextDecoder().decode(bytes).match(/\/Type\s*\/Page\b/g) || []).length,
            hasCrossReference: /startxref\s+\d+/.test(new TextDecoder().decode(bytes)),
            base64: includeBase64 ? btoa(String.fromCharCode(...bytes)) : undefined,
            length: bytes.length
        };
    }, { route, method, includeBase64 });
}

function extractPdfText(buffer) {
    const source = buffer.toString('latin1');
    const text = [];
    for (const marker of source.matchAll(/stream\r?\n/g)) {
        const start = marker.index + marker[0].length;
        const end = source.indexOf('endstream', start);
        if (end < 0) continue;
        const stream = Buffer.from(source.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
        try {
            const content = zlib.inflateSync(stream).toString('latin1');
            text.push([...content.matchAll(/<([0-9a-f]+)>/gi)].map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join(''));
        } catch (error) { }
    }
    return text.join('\n');
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-crm-staging-e2e-'));
    testDb = path.join(tempDir, 'crm.sqlite');
    const uploadDir = path.join(tempDir, 'uploads');
    fs.mkdirSync(uploadDir);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverEnvironment = {
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
    };
    await startTestServer();

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
    await stopTestServer();
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
    await page.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
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
    await foreignPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    assert.equal((await browserApi(foreignPage, `/api/leads/${leadId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/files/${fileId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/surveys/${surveyId}`)).status, 403);
    assert.equal((await browserApi(foreignPage, `/api/leads/${leadId}/files`, {
        method: 'POST', body: { category: 'Other', files: [{ fileName: 'unauthorized.pdf', mimeType: 'application/pdf', fileData }] }
    })).status, 403);
    await foreignContext.close();

    await page.goto(`${baseUrl}/index.html`);
    await page.locator('.sidebar-logout-btn').click();
    await page.waitForURL('**/login.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    assert.equal((await browserApi(page, '/api/auth/me')).status, 401);
});

test('proposal workflow resolves the selected lead, saves once, and generates an in-CRM PDF', async (testContext) => {
    const proposalContext = await browser.newContext();
    const page = await proposalContext.newPage();
    testContext.after(() => proposalContext.close());
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await browserLogin(page, credentials.execA);
    await page.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });

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
    await page.waitForFunction((expectedLeadId) => document.querySelector('#leadSelect')?.value === expectedLeadId, leadId);
    assert.equal(await page.locator('#leadSelect').inputValue(), leadId);
    const customerSummary = await page.locator('#customerFields').innerText();
    assert.match(customerSummary, /Synthetic Proposal Customer/);
    assert.match(customerSummary, /42 Synthetic Proposal Street/);
    assert.match(customerSummary, /560001/);
    assert.equal(await page.locator('[name="gst"]').getAttribute('readonly'), '');
    const generateButton = page.locator('#generateProposalButton');
    await generateButton.waitFor({ state: 'visible' });
    assert.match(await generateButton.innerText(), /Generate Proposal/);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await generateButton.scrollIntoViewIfNeeded();
        const buttonBounds = await generateButton.boundingBox();
        assert.ok(buttonBounds && buttonBounds.width > 0 && buttonBounds.height > 0);
        assert.ok(buttonBounds.y + buttonBounds.height <= viewport.height);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await generateButton.click();
    assert.equal(await page.locator('[name="systemCapacity"]').evaluate((input) => input.validity.valueMissing), true);
    assert.notEqual(await page.locator('[name="systemCapacity"]').evaluate((input) => input.validationMessage), '');
    assert.equal(await page.locator('#generateStatus').innerText(), '');

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
    await page.locator('[name="panelBrand"]').fill('Synthetic Panel Co');
    await page.locator('[name="panelWattage"]').fill('550');
    await page.locator('[name="panelCount"]').fill('6');
    await page.locator('[name="inverterBrand"]').fill('Synthetic Inverter Co');
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
    assert.equal(proposal.panelBrand, 'Synthetic Panel Co');
    assert.equal(proposal.inverterBrand, 'Synthetic Inverter Co');
    assert.equal(proposal.status, 'Draft');

    await page.route(`**/api/proposals/${proposalId}/pdf`, async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic generation failure.' }) });
    });
    const downloadNames = [];
    page.on('download', (event) => { downloadNames.push(event.suggestedFilename()); });
    await generateButton.click();
    await page.waitForFunction(() => document.querySelector('#generateStatus')?.textContent === 'Synthetic generation failure.');
    assert.equal(await generateButton.isEnabled(), true);
    assert.deepEqual(downloadNames, []);
    const filesAfterFailure = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
    assert.equal(filesAfterFailure.data.files.some((file) => file.proposalId === proposalId), false);
    await page.unroute(`**/api/proposals/${proposalId}/pdf`);

    const pdfResponses = [];
    const pdfResponseHeaders = [];
    page.on('response', (response) => {
        if (new URL(response.url()).pathname === `/api/proposals/${proposalId}/pdf`) {
            pdfResponses.push(response.status());
            pdfResponseHeaders.push(response.headers());
        }
    });
    const downloadPromise = page.waitForEvent('download');
    await generateButton.evaluate((button) => { button.click(); button.click(); });
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^Proposal_.*\.pdf$/, `download=${download.suggestedFilename()}, seen=${JSON.stringify(downloadNames)}, status=${await page.locator('#generateStatus').innerText()}, headers=${JSON.stringify(pdfResponseHeaders)}`);
    assert.equal(await download.failure(), null);
    await page.waitForURL(`**/lead-details.html?lead=${encodeURIComponent(leadId)}*`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    assert.deepEqual(pdfResponses, [200]);
    await page.locator('#activity-panel-tab-files[aria-selected="true"]').waitFor();

    const leadFiles = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
    const proposalFiles = leadFiles.data.files.filter((file) => file.proposalId === proposalId);
    assert.equal(proposalFiles.length, 1);
    const proposalFile = proposalFiles[0];
    assert.equal(proposalFile.category, 'Proposal');
    assert.equal(proposalFile.mimeType, 'application/pdf');
    assert.ok(proposalFile.fileSize > 1000);
    assert.match(proposalFile.fileName, new RegExp(`^Proposal_${createdLead.data.lead.leadNumber}_`));
    const proposalFileRow = page.locator('#documentsTable tr').filter({ hasText: proposalFile.fileName });
    await proposalFileRow.waitFor({ state: 'visible' });
    assert.equal(await proposalFileRow.locator('td').nth(2).innerText(), 'Proposal');
    const viewResponse = await browserBinary(page, `/api/leads/${encodeURIComponent(leadId)}/files/${encodeURIComponent(proposalFile.id)}`);
    assert.equal(viewResponse.status, 200);
    assert.equal(viewResponse.contentType, 'application/pdf');
    assert.match(viewResponse.disposition, /^inline;/);
    assert.deepEqual(viewResponse.header, [37, 80, 68, 70]);
    assert.ok(viewResponse.length > 1000);
    assert.match(viewResponse.footer, /%%EOF/);
    assert.ok(viewResponse.pageCount >= 10);
    assert.equal(viewResponse.hasCrossReference, true);
    const pdfTextBuffer = await browserBinary(page, `/api/leads/${encodeURIComponent(leadId)}/files/${encodeURIComponent(proposalFile.id)}`, 'GET', true);
    const proposalPdfText = extractPdfText(Buffer.from(pdfTextBuffer.base64, 'base64'));
    assert.match(proposalPdfText, /Synthetic Proposal Customer/);
    assert.match(proposalPdfText, /42 Synthetic Proposal Street/);
    assert.match(proposalPdfText, /Synthetic Panel Co/);
    assert.match(proposalPdfText, /Synthetic Inverter Co/);
    assert.match(proposalPdfText, /Inverter Size/);
    assert.match(proposalPdfText, /INPACE ENERGY/);
    assert.match(proposalPdfText, /GST @ 5%/);
    assert.match(proposalPdfText, /2,25,000/);
    assert.match(proposalPdfText, /2,36,250/);
    assert.equal(pdfResponseHeaders[0]['content-type'], 'application/pdf');
    assert.match(pdfResponseHeaders[0]['content-disposition'], /^attachment;/);
    assert.equal(pdfResponseHeaders[0]['x-crm-file-id'], proposalFile.id);
    assert.equal(pdfResponseHeaders[0]['x-crm-file-url'], `/api/files/${encodeURIComponent(proposalFile.id)}?download=1`);
    const downloadResponse = await browserBinary(page, `/api/files/${encodeURIComponent(proposalFile.id)}?download=1`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.disposition, /^attachment;/);
    assert.deepEqual(downloadResponse.header, [37, 80, 68, 70]);
    const idempotentPdf = await browserBinary(page, `/api/proposals/${encodeURIComponent(proposalId)}/pdf`, 'POST');
    assert.equal(idempotentPdf.status, 200);
    assert.deepEqual(idempotentPdf.header, [37, 80, 68, 70]);
    assert.equal((await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`)).data.files.filter((file) => file.proposalId === proposalId).length, 1);

    await page.reload();
    await page.locator('#activity-panel-tab-files[aria-selected="true"]').waitFor();
    await page.locator('#documentsTable').getByText(proposalFile.fileName).waitFor({ state: 'visible' });
    await stopTestServer();
    await startTestServer();
    await page.reload();
    await page.locator('#activity-panel-tab-files[aria-selected="true"]').waitFor();
    await page.locator('#documentsTable').getByText(proposalFile.fileName).waitFor({ state: 'visible' });
    const fileAfterRestart = await browserBinary(page, `/api/files/${encodeURIComponent(proposalFile.id)}`);
    assert.equal(fileAfterRestart.status, 200);
    assert.deepEqual(fileAfterRestart.header, [37, 80, 68, 70]);

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
    await foreignPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    assert.equal((await browserApi(foreignPage, `/api/proposals/${encodeURIComponent(proposalId)}`)).status, 404);
    assert.equal((await browserApi(foreignPage, `/api/files/${encodeURIComponent(proposalFile.id)}`)).status, 403);
    await foreignContext.close();
});
