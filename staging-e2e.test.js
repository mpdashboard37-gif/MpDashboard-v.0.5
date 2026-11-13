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
            imageCount: (new TextDecoder().decode(bytes).match(/\/Subtype\s*\/Image\b/g) || []).length,
            base64: includeBase64 ? btoa(Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, index) =>
                String.fromCharCode(...bytes.subarray(index * 0x8000, (index + 1) * 0x8000))).join('')) : undefined,
            length: bytes.length
        };
    }, { route, method, includeBase64 });
}

function extractPdfText(buffer) {
    return extractPdfPages(buffer).join('\n');
}

function extractPdfPages(buffer) {
    const source = buffer.toString('latin1');
    const objects = new Map([...source.matchAll(/(?:^|\n)(\d+)\s+\d+\s+obj\r?\n([\s\S]*?)\r?\nendobj/g)]
        .map((match) => [Number(match[1]), match[2]]));
    const pages = [...objects.values()].filter((body) => /\/Type\s*\/Page(?!s)\b/.test(body));
    return pages.map((page) => {
        const refs = [...page.matchAll(/\/Contents\s+(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
        const arrayMatch = page.match(/\/Contents\s*\[([\s\S]*?)\]/);
        if (arrayMatch) refs.push(...[...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1])));
        return refs.map((id) => {
            const object = objects.get(id);
            const streamMatch = object?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
            if (!object || !streamMatch) return '';
            try {
                const stream = Buffer.from(streamMatch[1], 'latin1');
                const content = /\/FlateDecode/.test(object.slice(0, streamMatch.index))
                    ? zlib.inflateSync(stream).toString('latin1')
                    : stream.toString('latin1');
                return [...content.matchAll(/<([0-9a-f]+)>/gi)]
                    .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
                    .join('');
            } catch (error) {
                return '';
            }
        }).join('\n');
    });
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
    assert.equal((await browserApi(page, '/api/settings')).status, 403);
    assert.equal((await browserApi(page, '/api/settings', {
        method: 'PATCH',
        body: { solarPricing: { tier3: 99999 } }
    })).status, 403);

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
    const dashboard = await browserApi(page, '/api/dashboard?period=today');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.metrics.totalLeads, 1);
    const analytics = await browserApi(page, '/api/dashboard/analytics?period=today');
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.analytics.stageFunnel.find((item) => item.label === 'New')?.value, 1);
    assert.equal(analytics.data.analytics.trends.length, 1);
    assert.equal((await browserApi(page, '/api/dashboard/analytics?period=invalid')).status, 400);
    const changedLead = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: { customerName: 'Synthetic Browser Lead Updated' } });
    assert.equal(changedLead.status, 200);
    const xssPayload = '<img src=x onerror="window.__crmXss=true">';
    await page.goto(`${baseUrl}/index.html`);
    await page.evaluate((payload) => {
        window.__crmXss = false;
        crmApi.search = async () => ({
            results: [{
                url: 'lead-details.html?lead=synthetic" onclick="window.__crmXss=true',
                recordType: payload,
                leadNumber: 'INP-900001',
                customerName: payload,
                status: payload
            }]
        });
    }, xssPayload);
    await page.locator('#leadSearchInput').fill('synthetic');
    const searchResult = page.locator('#leadSearchResults .search-result');
    await searchResult.waitFor();
    assert.equal(await searchResult.locator('img,script,[onerror],[onclick]').count(), 0);
    assert.match(await searchResult.innerText(), /<img src=x onerror="window\.__crmXss=true">/);
    assert.equal(await page.evaluate(() => window.__crmXss), false);

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    await page.waitForFunction(() => typeof renderActivityHistory === 'function' && document.getElementById('activityTimeline'));
    await page.evaluate((payload) => {
        window.__crmXss = false;
        record.activities = [{
            id: 'synthetic-xss-activity',
            activityType: 'UPDATE',
            title: payload,
            userName: payload,
            description: payload,
            relatedRecordId: payload,
            createdAt: new Date().toISOString()
        }];
        renderActivityHistory();
        openActivityModal();
    }, xssPayload);
    assert.equal(await page.locator('#activityTimeline img,[data-all-activity] img,[onerror]').count(), 0);
    assert.match(await page.locator('#activityTimeline').innerText(), /<img src=x onerror="window\.__crmXss=true">/);
    assert.equal(await page.evaluate(() => window.__crmXss), false);

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

test('dashboard APIs return period-filtered metrics and permission-scoped groups', async (testContext) => {
    const dashboardUser = {
        id: `e2e-dashboard-${crypto.randomUUID()}`,
        loginId: `dashboard.${crypto.randomUUID()}@test.invalid`,
        password: crypto.randomBytes(24).toString('base64url')
    };
    const database = new DatabaseSync(testDb);
    const timestamp = new Date().toISOString();
    try {
        database.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, manager_id, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
            .run(dashboardUser.id, `E2E-DASH-${crypto.randomUUID()}`, 'Synthetic Dashboard Owner', dashboardUser.loginId, 'QA', 'Sales Executive', dashboardUser.loginId, passwordHash(dashboardUser.password), 'Sales Executive', 'Active', 'ACTIVE', null, timestamp);
    } finally {
        database.close();
    }

    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    testContext.after(() => ownerContext.close());
    testContext.after(() => ownerContext.close());
    await browserLogin(ownerPage, dashboardUser);
    await ownerPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await ownerPage.waitForFunction(() => document.querySelector('#periodAll')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await ownerPage.locator('.dashboard-date').innerText(), 'All Time');

    const emptyKpis = await browserApi(ownerPage, '/api/dashboard?period=today');
    assert.equal(emptyKpis.status, 200);
    assert.equal(emptyKpis.data.metrics.totalLeads, 0);
    assert.equal(emptyKpis.data.metrics.opportunities, 0);
    const emptyAnalytics = await browserApi(ownerPage, '/api/dashboard/analytics?period=today');
    assert.equal(emptyAnalytics.status, 200);
    assert.equal(emptyAnalytics.data.analytics.trends.length, 1);
    assert.equal(emptyAnalytics.data.analytics.trends[0].value, 0);
    const emptyGroups = await browserApi(ownerPage, '/api/dashboard/groups?period=today');
    assert.equal(emptyGroups.status, 200);
    assert.equal(emptyGroups.data.groups.newLeads.length, 0);
    assert.equal(emptyGroups.data.groups.hotDeals.length, 0);
    await ownerPage.waitForFunction(() => document.querySelector('#reportChart .report-empty')?.textContent.includes('No lead stage data'));
    for (const tab of ['stage', 'sources', 'priority', 'funnel', 'trend']) {
        await ownerPage.locator(`#reportTab-${tab}`).click();
        await ownerPage.waitForSelector('#reportChart .report-empty');
        assert.equal(await ownerPage.locator('#reportChart svg, #reportChart .report-donut, #reportChart .report-funnel').count(), 0);
    }
    await ownerPage.locator('#reportTab-stage').click();
    await ownerPage.locator('#periodAll').click();
    await ownerPage.waitForFunction(() => document.querySelector('#newTodaysFollowUpsBody .dashboard-empty td')?.textContent.includes('No follow-ups found for the selected period'));
    const emptyAllTimeCopy = await ownerPage.locator('#newTodaysFollowUpsBody .dashboard-empty td').innerText();
    assert.match(emptyAllTimeCopy, /No follow-ups found for the selected period/);

    const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const todayDate = new Date();
    todayDate.setHours(12, 0, 0, 0);
    const today = localDateKey(todayDate);
    const weekStart = new Date(todayDate);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekMarker = new Date(weekStart);
    if (localDateKey(weekMarker) === today) weekMarker.setDate(weekMarker.getDate() + 1);
    const monthMarker = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1, 12);
    if (localDateKey(monthMarker) === today) monthMarker.setDate(monthMarker.getDate() + 1);
    const outsideMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0, 12);
    const fixtureLeads = [
        { name: 'Synthetic dashboard hot', date: todayDate, source: 'Website', priority: 'Hot', score: 85, stage: 'New' },
        { name: 'Synthetic dashboard over-range', date: todayDate, source: 'Facebook', priority: 'Warm', score: 101, stage: 'New' },
        { name: 'Synthetic dashboard weekly', date: weekMarker, source: 'Referral', priority: 'Warm', score: 70, stage: 'Qualified' },
        { name: 'Synthetic dashboard monthly', date: monthMarker, source: 'Manual', priority: 'Cold', score: 69, stage: 'Contacted' },
        { name: 'Synthetic dashboard outside month', date: outsideMonth, source: 'Instagram', priority: 'Hot', score: 95, stage: 'New' }
    ];
    const insertedLeadIds = fixtureLeads.map(() => crypto.randomUUID());
    const insertedDates = fixtureLeads.map(({ date }) => localDateKey(date));
    const insertedMobiles = new Set();
    const fixtureDb = new DatabaseSync(testDb);
    try {
        const insertLead = fixtureDb.prepare(`INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, status, created_by, created_at, updated_at, details_json, lead_score, lead_category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, '{}', ?, ?)`);
        fixtureLeads.forEach((lead, index) => {
            let mobile;
            do { mobile = `96${crypto.randomInt(10000000, 99999999)}`; } while (insertedMobiles.has(mobile));
            insertedMobiles.add(mobile);
            const date = localDateKey(lead.date);
            const createdAt = `${date}T12:00:00`;
            insertLead.run(insertedLeadIds[index], `INP-${String(900200 + index).padStart(6, '0')}`, lead.name, mobile, `${index}@dashboard.test.invalid`, date, lead.source, dashboardUser.id, lead.stage, lead.priority, 'Synthetic dashboard test', dashboardUser.id, createdAt, createdAt, lead.score, lead.score >= 70 && lead.score <= 100 ? 'Hot' : 'Cold');
        });
        fixtureDb.prepare('INSERT INTO opportunities (id, lead_id, customer_name, estimated_value, probability, stage, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), insertedLeadIds[0], fixtureLeads[0].name, 125000, 85, 'Qualified', 'Active', dashboardUser.id, `${today}T12:00:00`, `${today}T12:00:00`);
        fixtureDb.prepare('INSERT INTO bookings (id, opportunity_id, lead_id, total_amount, booking_amount, booking_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), fixtureDb.prepare('SELECT id FROM opportunities WHERE lead_id = ?').get(insertedLeadIds[0]).id, insertedLeadIds[0], 125000, 25000, today, 'Confirmed', dashboardUser.id, `${today}T12:00:00`);
        fixtureDb.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('E2E-DASHBOARD-TODAY-FOLLOWUP', insertedLeadIds[0], `${today}T23:00:00`, 'Call', dashboardUser.id, 'Scheduled', 'Synthetic dashboard test', dashboardUser.id, timestamp, 'Synthetic dashboard follow-up', 'PENDING');
        fixtureDb.prepare('INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, recommended_capacity, remarks, status, survey_type, completion_data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('E2E-DASHBOARD-TODAY-SURVEY', insertedLeadIds[0], `${today}T20:00:00`, dashboardUser.id, fixtureLeads[0].name, 'Synthetic survey location', '5 kW', '{}', '{}', '5 kW', '', 'Scheduled', 'Rooftop PV', JSON.stringify({ propertyType: 'Residential', proposedSystemCapacity: '5 kW' }));
    } finally {
        fixtureDb.close();
    }

    const proposal = await browserApi(ownerPage, '/api/proposals', {
        method: 'POST',
        body: { leadId: insertedLeadIds[0], systemType: 'On-Grid', systemCapacity: 3, inverterCapacity: 3, validityDays: 15 }
    });
    assert.equal(proposal.status, 201);

    await ownerPage.locator('#periodAll').click();
    await ownerPage.waitForFunction(() =>
        document.querySelector('#newDashboardTotalLeads')?.textContent.trim() === '5'
        && document.querySelector('#reportChart .report-bar')
        && document.querySelectorAll('#newNewLeadsBody tr:not(.dashboard-empty) .dashboard-actions a').length >= 4
    );
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await ownerPage.locator('#dashboardWelcomeName').innerText(), 'Synthetic Dashboard Owner');
    assert.equal(await ownerPage.locator('#dashboardCurrentDate').getAttribute('datetime'), localDateKey(new Date()));
    assert.equal(await ownerPage.locator('.dashboard-overview .kpi-card').count(), 4);
    assert.equal(await ownerPage.locator('.dashboard-overview .kpi-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 4);
    const reportButtonCount = await ownerPage.locator('[data-report-tab]').count();
    const reportUrl = ownerPage.url();
    const reportTabs = [
        ['stage', 'Leads by Stage'],
        ['sources', 'Lead Sources'],
        ['priority', 'Lead Priority'],
        ['funnel', 'Leads Funnel'],
        ['trend', 'Leads Trend']
    ];
    const tabResults = [];
    for (const [tab, title] of reportTabs) {
        const button = ownerPage.locator(`[data-report-tab="${tab}"]`);
        await button.scrollIntoViewIfNeeded();
        const visible = await button.isVisible();
        const enabled = await button.isEnabled();
        await button.click();
        await ownerPage.waitForFunction((name) =>
            document.querySelector('[data-report-tab][aria-selected="true"]')?.dataset.reportTab === name,
            tab);
        await ownerPage.waitForTimeout(250);
        const result = await ownerPage.evaluate((name) => {
            const active = document.querySelector(`[data-report-tab="${name}"]`);
            const activeStyle = getComputedStyle(active);
            const container = document.querySelector('#reportChart');
            return {
                selected: active.getAttribute('aria-selected'),
                background: activeStyle.backgroundImage,
                shadow: activeStyle.boxShadow,
                title: document.querySelector('#reportChartTitle')?.textContent,
                chartCount: container.querySelectorAll('svg,.report-donut,.report-funnel').length,
                hasEmptyState: Boolean(container.querySelector('.report-empty'))
            };
        }, tab);
        tabResults.push({ tab, expectedTitle: title, visible, enabled, ...result });
    }
    await ownerPage.locator('#reportTab-stage').click();
    const allTimeDashboard = await ownerPage.evaluate(() => ({
        period: document.querySelector('.dashboard-date')?.textContent.trim(),
        leadCount: document.querySelector('#newDashboardTotalLeads')?.textContent.trim(),
        profileAvatar: document.querySelector('#profileButton img')?.src,
        sidebarAvatar: document.querySelector('#sidebarUserAvatar')?.src,
        stageValues: [...document.querySelectorAll('#reportChart .report-bar title')].map((node) => node.textContent),
        onlyOneChart: document.querySelectorAll('#reportChart svg, #reportChart .report-donut, #reportChart .report-funnel').length,
        newLeadActionLinks: document.querySelectorAll('#newNewLeadsBody tr:not(.dashboard-empty) .dashboard-actions a').length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    await ownerPage.locator('#reportTab-sources').click();
    await ownerPage.waitForSelector('#reportChart .report-donut');
    const sourceRows = await ownerPage.locator('#reportChart .report-legend-row').allInnerTexts();
    await ownerPage.locator('#reportTab-priority').click();
    await ownerPage.waitForSelector('#reportChart .report-donut');
    const priorityRows = await ownerPage.locator('#reportChart .report-legend-row').allInnerTexts();
    await ownerPage.locator('#reportTab-funnel').click();
    await ownerPage.waitForSelector('#reportChart .report-funnel-stage');
    const funnelRows = await ownerPage.locator('#reportChart .report-funnel-stage').evaluateAll((rows) =>
        rows.map((row) => [
            row.querySelector('.report-funnel-name')?.textContent,
            row.querySelector('.report-funnel-badge')?.textContent,
            row.querySelector('.report-funnel-percent')?.textContent
        ])
    );
    await ownerPage.locator('#reportTab-trend').click();
    await ownerPage.waitForSelector('#reportChart .report-trend-svg');
    const trendHasTooltips = await ownerPage.locator('#reportChart .report-trend-point title').count();
    for (const granularity of ['daily', 'weekly', 'monthly']) {
        await ownerPage.locator('#reportTrendGranularity').selectOption(granularity);
        assert.equal(await ownerPage.locator('#reportTrendGranularity').inputValue(), granularity);
        assert.ok(await ownerPage.locator('#reportChart .report-trend-svg').count());
    }

    assert.equal(reportButtonCount, 5);
    assert.equal(ownerPage.url(), reportUrl);
    for (const result of tabResults) {
        assert.equal(result.visible, true);
        assert.equal(result.enabled, true);
        assert.equal(result.selected, 'true');
        assert.equal(result.title, result.expectedTitle);
        assert.match(result.background, /linear-gradient/);
        assert.match(result.shadow, /128, 93, 255/);
        assert.equal(result.chartCount, 1);
        assert.equal(result.hasEmptyState, false);
    }
    assert.equal(allTimeDashboard.period, 'All Time');
    assert.equal(allTimeDashboard.leadCount, '5');
    assert.equal(allTimeDashboard.profileAvatar, allTimeDashboard.sidebarAvatar);
    assert.equal(allTimeDashboard.stageValues.find((value) => value.startsWith('New Lead:')), 'New Lead: 3 leads');
    assert.equal(allTimeDashboard.onlyOneChart, 1);
    assert.deepEqual(sourceRows.map((row) => row.split(/\s+/)[0]), ['Meta', 'Website', 'Referral', 'Telecalling', 'Other']);
    assert.deepEqual(priorityRows.map((row) => row.split(/\s+/)[0]), ['Hot', 'Warm', 'Cold']);
    assert.deepEqual(funnelRows.find(([label]) => label === 'New Lead'), ['New Lead', '3', '60.0%']);
    assert.deepEqual(funnelRows.find(([label]) => label === 'Contacted'), ['Contacted', '2', '40.0%']);
    assert.ok(trendHasTooltips > 0);
    assert.ok(allTimeDashboard.newLeadActionLinks >= 4);
    assert.equal(allTimeDashboard.newLeadActionLinks % 4, 0);
    assert.ok(allTimeDashboard.pageWidth <= allTimeDashboard.viewportWidth);

    await ownerPage.locator('#periodToday').click();
    await ownerPage.waitForFunction(() =>
        document.querySelector('#reportPeriodLabel')?.textContent === 'Today'
        && document.querySelector('#reportChartSummary')?.textContent === '2 leads'
    );
    await ownerPage.locator('#reportTab-stage').click();
    assert.equal(
        await ownerPage.locator('#reportChart .report-bar title').filter({ hasText: 'New Lead:' }).textContent(),
        'New Lead: 2 leads'
    );
    await ownerPage.locator('#periodAll').click();
    await ownerPage.waitForFunction(() => document.querySelector('#reportChartSummary')?.textContent === '5 leads');

    await ownerPage.setViewportSize({ width: 768, height: 1024 });
    const tabletDashboard = await ownerPage.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        reportTabsOverflow: getComputedStyle(document.querySelector('.report-tabs')).overflowX,
        reportTabCount: document.querySelectorAll('[data-report-tab]').length,
        kpiColumns: getComputedStyle(document.querySelector('.dashboard-overview .kpi-grid')).gridTemplateColumns.split(' ').length
    }));
    assert.ok(tabletDashboard.pageWidth <= tabletDashboard.viewportWidth);
    assert.equal(tabletDashboard.reportTabsOverflow, 'auto');
    assert.equal(tabletDashboard.reportTabCount, 5);
    assert.equal(tabletDashboard.kpiColumns, 2);

    await ownerPage.setViewportSize({ width: 390, height: 844 });
    const mobileDashboard = await ownerPage.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        menuHidden: document.querySelector('#crmSidebar')?.dataset.mobileOpen !== 'true',
        kpiColumns: getComputedStyle(document.querySelector('.dashboard-overview .kpi-grid')).gridTemplateColumns.split(' ').length
    }));
    assert.ok(mobileDashboard.pageWidth <= mobileDashboard.viewportWidth);
    assert.equal(mobileDashboard.menuHidden, true);
    assert.equal(mobileDashboard.kpiColumns, 1);
    await ownerPage.locator('#mobileNavToggle').click();
    assert.equal(await ownerPage.locator('#mobileNavToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await ownerPage.locator('#crmSidebar').isVisible(), true);
    await ownerPage.keyboard.press('Escape');
    assert.equal(await ownerPage.locator('#mobileNavToggle').getAttribute('aria-expanded'), 'false');

    const expectedCount = (startDate, endDate) => insertedDates.filter((date) => date >= startDate && date <= endDate).length;
    for (const period of ['all', 'today', 'week', 'month']) {
        const metrics = await browserApi(ownerPage, `/api/dashboard?period=${period}`);
        assert.equal(metrics.status, 200);
        assert.equal(metrics.data.metrics.totalLeads, expectedCount(metrics.data.startDate, metrics.data.endDate));
        assert.equal(metrics.data.period, period);
    }
    const allMetrics = await browserApi(ownerPage, '/api/dashboard?period=all');
    assert.equal(allMetrics.status, 200);
    assert.equal(allMetrics.data.period, 'all');
    assert.equal(allMetrics.data.metrics.totalLeads, fixtureLeads.length);
    const refreshedDashboard = ownerPage.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/dashboard' && url.searchParams.get('period') === 'all';
    });
    await ownerPage.locator('#refreshDashboardButton').click();
    assert.equal((await refreshedDashboard).status(), 200);
    await ownerPage.waitForFunction(() => !document.querySelector('#refreshDashboardButton')?.disabled);
    assert.equal(await ownerPage.locator('#newDashboardTotalLeads').innerText(), Number(allMetrics.data.metrics.totalLeads).toLocaleString());
    assert.equal(await ownerPage.locator('#newDashboardNewLeads').innerText(), Number(allMetrics.data.metrics.newLeads).toLocaleString());
    assert.equal(await ownerPage.locator('#newDashboardPipelineValue').innerText(), `₹${Number(allMetrics.data.metrics.pipelineValue).toLocaleString('en-IN')}`);
    assert.equal(await ownerPage.locator('#newDashboardConversionRate').innerText(), `${Number(allMetrics.data.metrics.conversionRate).toFixed(1)}%`);
    const allAnalytics = await browserApi(ownerPage, '/api/dashboard/analytics?period=all');
    assert.equal(allAnalytics.status, 200);
    assert.equal(allAnalytics.data.period, 'all');
    assert.equal(allAnalytics.data.analytics.trends.reduce((sum, item) => sum + item.value, 0), fixtureLeads.length);
    assert.equal(allAnalytics.data.analytics.stageFunnel.reduce((sum, item) => sum + item.value, 0), fixtureLeads.length);
    const priorityCounts = new Map(allAnalytics.data.analytics.leadPriority.map(({ label, value }) => [label, value]));
    assert.equal(priorityCounts.get('Hot'), 3);
    assert.equal(priorityCounts.get('Warm') || 0, 0);
    assert.equal(priorityCounts.get('Cold'), 2);
    const allGroups = await browserApi(ownerPage, '/api/dashboard/groups?period=all');
    assert.equal(allGroups.status, 200);
    assert.equal(allGroups.data.period, 'all');
    assert.equal(allGroups.data.groups.newLeads.length, 3);
    assert.equal(allGroups.data.groups.hotDeals.length, 3);
    assert.equal(allGroups.data.groups.todaysFollowUps.length, 1);
    assert.equal(allGroups.data.groups.scheduledSurveys.length, 1);
    assert.equal(allGroups.data.groups.pendingProposals.length, 1);
    const todayMetrics = await browserApi(ownerPage, '/api/dashboard?period=today');
    assert.equal(todayMetrics.data.metrics.opportunities, 1);
    assert.equal(todayMetrics.data.metrics.pipelineValue, 125000);
    assert.equal(todayMetrics.data.metrics.convertedLeads, 1);
    assert.equal(todayMetrics.data.metrics.conversionRate, 50);
    assert.equal(todayMetrics.data.metrics.hotLeads, 1);
    assert.equal(todayMetrics.data.metrics.todaysFollowUps, 1);
    assert.equal(todayMetrics.data.metrics.siteSurveys, 1);
    assert.equal(todayMetrics.data.metrics.pendingProposals, 1);

    const todayAnalytics = await browserApi(ownerPage, '/api/dashboard/analytics?period=today');
    assert.equal(todayAnalytics.data.analytics.stageFunnel.find((item) => item.label === 'New')?.value, 2);
    assert.equal(todayAnalytics.data.analytics.leadSources.find((item) => item.label === 'Website')?.value, 1);
    assert.equal(todayAnalytics.data.analytics.leadPriority.find((item) => item.label === 'Hot')?.value, 1);
    assert.equal(todayAnalytics.data.analytics.leadPriority.find((item) => item.label === 'Cold')?.value, 1);
    assert.equal(todayAnalytics.data.analytics.trends.length, 1);
    assert.equal(todayAnalytics.data.analytics.trends[0].value, 2);
    assert.equal((await browserApi(ownerPage, '/api/dashboard?period=invalid')).status, 400);

    const todayGroups = await browserApi(ownerPage, '/api/dashboard/groups?period=today');
    assert.equal(todayGroups.data.groups.newLeads.length, 2);
    assert.equal(todayGroups.data.groups.hotDeals.length, 1);
    assert.equal(todayGroups.data.groups.hotDeals[0].lead_score, 85);
    assert.equal(todayGroups.data.groups.todaysFollowUps.length, 1);
    assert.equal(todayGroups.data.groups.scheduledSurveys.length, 1);
    assert.equal(todayGroups.data.groups.scheduledSurveys[0].property_type, 'Residential');
    assert.equal(todayGroups.data.groups.pendingProposals.length, 1);
    assert.equal(todayGroups.data.groups.pendingProposals[0].proposal_id, proposal.data.proposal.id);
    assert.equal((await browserApi(ownerPage, '/api/dashboard/groups?period=bad')).status, 400);

    const foreignContext = await browser.newContext();
    const foreignPage = await foreignContext.newPage();
    await browserLogin(foreignPage, credentials.execB);
    await foreignPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const foreignGroups = await browserApi(foreignPage, '/api/dashboard/groups?period=today');
    assert.equal(foreignGroups.status, 200);
    assert.equal(foreignGroups.data.groups.newLeads.some((lead) => insertedLeadIds.includes(lead.lead_id)), false);
    assert.equal(foreignGroups.data.groups.hotDeals.some((lead) => insertedLeadIds.includes(lead.lead_id)), false);
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await browserLogin(adminPage, { loginId: 'varunkv@inpacepower.com', password: serverEnvironment.ADMIN_INITIAL_PASSWORD });
    await adminPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const adminGroups = await browserApi(adminPage, '/api/dashboard/groups?period=today');
    assert.equal(adminGroups.data.groups.hotDeals.some((lead) => insertedLeadIds.includes(lead.lead_id)), true);
    await foreignContext.close();
    await adminContext.close();
});

test('lead details proposal generation persists entered fields, supports edit/view, and renders terms last', async (testContext) => {
    const proposalContext = await browser.newContext();
    const page = await proposalContext.newPage();
    testContext.after(() => proposalContext.close());
    await browserLogin(page, credentials.execA);
    await page.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });

    const createdLead = await browserApi(page, '/api/leads', {
        method: 'POST',
        body: {
            customerName: 'Synthetic Generated Proposal Customer',
            mobileNumber: `97${crypto.randomInt(10000000, 99999999)}`,
            email: 'generated-proposal@test.invalid',
            leadDate: new Date().toISOString().slice(0, 10),
            leadSource: 'Synthetic Generated Proposal QA',
            assignedTo: credentials.execA.id,
            address: '84 Synthetic Proposal Road',
            city: 'Bengaluru',
            pincode: '560002'
        }
    });
    assert.equal(createdLead.status, 201);
    const leadId = createdLead.data.lead.leadId;
    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    await page.locator('#proposalSection').waitFor({ state: 'visible' });
    for (const width of [320, 375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => ({
            viewportWidth: document.documentElement.clientWidth,
            pageWidth: document.documentElement.scrollWidth,
            workspaceColumns: getComputedStyle(document.querySelector('.lead-workspace')).gridTemplateColumns
        }));
        assert.ok(layout.pageWidth <= layout.viewportWidth + 1, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
        if (width <= 1023) assert.equal(layout.workspaceColumns.split(' ').length, 1);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const action of ['edit-lead', 'assign-lead', 'convert-lead', 'delete-lead', 'proposal']) {
        assert.equal(await page.locator(`.lead-header-actions [data-action="${action}"]`).count(), 1);
    }
    assert.equal(await page.locator('.lead-header-actions #headerSurveyAction').count(), 1);
    assert.match(await page.locator('#headerSurveyAction').innerText(), /Schedule Survey/);
    assert.equal(await page.locator('.lead-header-actions [data-action="delete-lead"]').isVisible(), false);
    assert.equal(await page.locator('.lead-header-actions [data-action="assign-lead"]').isVisible(), false);
    const termsToggle = page.locator('[aria-controls="bescomSectionContent"]');
    assert.equal(await termsToggle.getAttribute('aria-expanded'), 'true');
    await termsToggle.click();
    assert.equal(await termsToggle.getAttribute('aria-expanded'), 'false');
    await termsToggle.click();

    const headings = await page.locator('main section h2').allTextContents();
    assert.ok(headings.indexOf('Proposal & Quotation') < headings.indexOf('Installation & Operations'));
    assert.ok(headings.indexOf('Installation & Operations') < headings.indexOf('BESCOM Information'));
    assert.ok(headings.indexOf('BESCOM Information') < headings.indexOf('Terms & Conditions'));
    assert.equal(await page.locator('main section').last().locator('h2').innerText(), 'Terms & Conditions');

    await page.evaluate(() => openGenerateProposalModal());
    const legacyModal = page.locator('#proposalGeneratorModal');
    await legacyModal.locator('#proposalGeneratorForm').waitFor({ state: 'visible' });
    await legacyModal.locator('[name="systemType"][value="Hybrid"]').check();
    await legacyModal.locator('[name="pricingType"][value="Subsidy"]').check();
    await legacyModal.locator('[name="systemCapacity"]').fill('8');
    await legacyModal.locator('[name="inverterCapacity"]').selectOption('7.5');
    await legacyModal.locator('[name="panelCount"]').fill('16');
    await legacyModal.locator('[name="inverterPhase"]').selectOption('Three Phase');
    await legacyModal.locator('[name="extraBattery"]').check();
    await page.waitForFunction(() => document.querySelector('#proposalGeneratorModal [name="totalAmount"]')?.value === '720000');
    await page.waitForFunction(() => document.querySelector('#pricingBreakdown')?.textContent.includes('11,29,500'));
    const legacyPreview = await legacyModal.locator('#pricingBreakdown').innerText();
    assert.match(legacyPreview, /Base hybrid system price \(GST inclusive\)\s+₹7,20,000/);
    assert.match(legacyPreview, /Three-phase additional charge\s+₹35,000/);
    assert.match(legacyPreview, /Extra battery charge\s+₹1,15,000/);
    assert.match(legacyPreview, /Hybrid subsidy per-panel charge \(16 panels\)\s+₹2,40,000/);
    assert.match(legacyPreview, /GST @ 5% on applicable additional charges\s+₹19,500/);
    assert.match(legacyPreview, /Final payable amount\s+₹11,29,500/);

    const unverifiedPricing = await browserApi(page, '/api/proposals/pricing?capacity=8&systemType=On-Grid&basePriceOverride=522720');
    const verifiedPricing = await browserApi(page, '/api/proposals/pricing?capacity=8&systemType=On-Grid&basePriceOverride=522720&subsidyEligibilityVerified=true');
    assert.equal(unverifiedPricing.data.pricing.subsidy, 0);
    assert.equal(verifiedPricing.data.pricing.subsidy, 78000);
    assert.equal(verifiedPricing.data.pricing.finalAmount, unverifiedPricing.data.pricing.finalAmount);
    assert.equal(verifiedPricing.data.pricing.netInvestment, verifiedPricing.data.pricing.finalAmount - 78000);

    const mismatchedCustomer = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/generate-proposal`, {
        method: 'POST',
        body: { customerName: 'Different Synthetic Customer', contactNumber: createdLead.data.lead.mobileNumber, customerEmail: 'generated-proposal@test.invalid' }
    });
    assert.equal(mismatchedCustomer.status, 409);
    const unauthorizedProposal = await browserApi(page, '/api/leads/E2E-FOREIGN-LEAD/generate-proposal', {
        method: 'POST', body: { customerName: 'Synthetic Generated Proposal Customer' }
    });
    assert.equal(unauthorizedProposal.status, 403);

    const legacyGenerationPromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/leads/${encodeURIComponent(leadId)}/generate-proposal` && response.request().method() === 'POST'
    );
    await legacyModal.locator('#generateProposalBtn').click();
    const legacyGenerationResponse = await legacyGenerationPromise;
    assert.equal(legacyGenerationResponse.status(), 200);
    const legacyGeneration = await legacyGenerationResponse.json();
    const legacySaved = (await browserApi(page, `/api/proposals/${encodeURIComponent(legacyGeneration.proposalId)}`)).data.proposal;
    const legacyFiles = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
    const legacyProposalFiles = legacyFiles.data.files.filter((file) => file.proposalId === legacyGeneration.proposalId);
    assert.equal(legacyProposalFiles.length, 1);
    assert.equal(legacyProposalFiles[0].mimeType, 'application/pdf');
    assert.ok(legacyProposalFiles[0].fileSize > 1000);
    assert.equal(legacyGeneration.pdfFileId, legacyProposalFiles[0].id);
    assert.equal(legacyGeneration.document.id, legacyProposalFiles[0].id);
    assert.equal(legacyGeneration.document.leadId, leadId);
    assert.equal(legacyGeneration.document.proposalId, legacyGeneration.proposalId);
    assert.equal(Object.hasOwn(legacyGeneration, 'pdfData'), false);
    const legacyPdfDownload = await browserBinary(page, `/api/files/${encodeURIComponent(legacyGeneration.pdfFileId)}?download=1`, 'GET', true);
    assert.equal(legacyPdfDownload.status, 200);
    assert.match(legacyPdfDownload.disposition, /^attachment;/);
    assert.deepEqual(legacyPdfDownload.header, [37, 80, 68, 70]);
    assert.equal(legacySaved.pricing.hybridBasePrice, 720000);
    assert.equal(legacySaved.pricing.hybridSubsidyCharge, 240000);
    assert.equal(legacySaved.pricing.hybridThreePhaseCharge, 35000);
    assert.equal(legacySaved.pricing.hybridExtraBatteryCharge, 115000);
    assert.equal(legacySaved.pricing.gst, 53785.71);
    assert.equal(legacySaved.grossAmount, 1129500);
    assert.equal(legacySaved.finalAmount, 1129500);
    const legacyPdfText = extractPdfText(Buffer.from(legacyPdfDownload.base64, 'base64'));
    assert.match(legacyPdfText, /Inpace Power Pvt Ltd/);
    assert.match(legacyPdfText, /https:\/\/inpacepowers\.com/);
    assert.doesNotMatch(legacyPdfText, /inpaceenergy\.com/i);
    assert.doesNotMatch(legacyPdfText, /sales@inpaceenergy\.com/i);
    assert.match(legacyPdfText, /Hybrid system price \(incl\. GST\)Rs\. 7,20,000/);
    assert.match(legacyPdfText, /Per-panel hybrid chargeRs\. 2,40,000/);
    assert.match(legacyPdfText, /Three-phase chargeRs\. 35,000/);
    assert.match(legacyPdfText, /Extra battery chargeRs\. 1,15,000/);
    assert.match(legacyPdfText, /GST on additional chargesRs\. 19,500/);
    assert.match(legacyPdfText, /Gross AmountRs\. 11,29,500/);
    assert.match(legacyPdfText, /Final PayableRs\. 11,29,500/);
    const savedLegacyPdf = await browserBinary(page, `/api/proposals/${encodeURIComponent(legacyGeneration.proposalId)}/pdf`, 'POST', true);
    assert.equal(savedLegacyPdf.status, 200);
    const savedLegacyPdfText = extractPdfText(Buffer.from(savedLegacyPdf.base64, 'base64'));
    const filesAfterRepeatPdf = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
    assert.equal(filesAfterRepeatPdf.data.files.filter((file) => file.proposalId === legacyGeneration.proposalId).length, 1);
    assert.match(savedLegacyPdfText, /Inpace Power Pvt Ltd/);
    assert.match(savedLegacyPdfText, /https:\/\/inpacepowers\.com/);
    assert.doesNotMatch(savedLegacyPdfText, /inpaceenergy\.com/i);
    assert.match(savedLegacyPdfText, /Hybrid system price \(incl\. GST\)Rs\. 7,20,000/);
    assert.match(savedLegacyPdfText, /GST on additional chargesRs\. 19,500/);
    assert.match(savedLegacyPdfText, /Gross AmountRs\. 11,29,500/);
    assert.match(savedLegacyPdfText, /Final PayableRs\. 11,29,500/);

    const filesBeforeSaveFailure = new Set(fs.readdirSync(path.join(tempDir, 'uploads')));
    const failureDatabase = new DatabaseSync(testDb);
    failureDatabase.exec(`CREATE TRIGGER synthetic_proposal_document_failure
        BEFORE INSERT ON lead_documents
        WHEN NEW.document_type = 'Proposal' AND NEW.proposal_record_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'synthetic proposal document failure'); END;`);
    failureDatabase.close();
    const proposalsBeforeFailure = new DatabaseSync(testDb, { readOnly: true });
    const proposalCountBeforeFailure = proposalsBeforeFailure.prepare('SELECT COUNT(*) AS count FROM proposal_records').get().count;
    proposalsBeforeFailure.close();
    try {
        const failedPersistence = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/generate-proposal`, {
            method: 'POST',
            body: {
                customerName: 'Synthetic Generated Proposal Customer',
                contactNumber: createdLead.data.lead.mobileNumber,
                customerEmail: 'generated-proposal@test.invalid',
                customerAddress: '84 Synthetic Proposal Road',
                pincode: '560002',
                systemSize: 8,
                inverterSize: 7.5,
                structureType: 'RCC',
                systemType: 'On-Grid',
                proposalDate: new Date().toISOString().slice(0, 10),
                pricingType: 'Non-Subsidy',
                totalAmount: 522720,
                validityDays: 30
            }
        });
        assert.equal(failedPersistence.status, 500);
        const afterFailureDatabase = new DatabaseSync(testDb, { readOnly: true });
        assert.equal(afterFailureDatabase.prepare('SELECT COUNT(*) AS count FROM proposal_records').get().count, proposalCountBeforeFailure);
        afterFailureDatabase.close();
        assert.deepEqual(new Set(fs.readdirSync(path.join(tempDir, 'uploads'))), filesBeforeSaveFailure);
    } finally {
        const removeFailureTrigger = new DatabaseSync(testDb);
        removeFailureTrigger.exec('DROP TRIGGER IF EXISTS synthetic_proposal_document_failure');
        removeFailureTrigger.close();
    }

    const generation = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/generate-proposal`, {
        method: 'POST',
        body: {
            customerName: 'Synthetic Generated Proposal Customer',
            contactNumber: createdLead.data.lead.mobileNumber,
            customerEmail: 'generated-proposal@test.invalid',
            customerAddress: '84 Synthetic Proposal Road',
            pincode: '560002',
            systemSize: 8,
            inverterSize: 7.5,
            structureType: 'RCC',
            systemType: 'Hybrid',
            proposalDate: new Date().toISOString().slice(0, 10),
            pricingType: 'Non-Subsidy',
            totalAmount: 522720,
            validityDays: 30,
            addOns: ['Monitoring', 'O&M'],
            inverterPhase: 'Three Phase',
            batterySize: '10 kWh',
            discomWork: 'Net-metering coordination',
            omDuration: '5 years'
        }
    });
    assert.equal(generation.status, 200);
    assert.ok(generation.data.proposalId);
    const savedResponse = await browserApi(page, `/api/proposals/${encodeURIComponent(generation.data.proposalId)}`);
    assert.equal(savedResponse.status, 200);
    const saved = savedResponse.data.proposal;
    assert.equal(saved.leadId, leadId);
    assert.equal(saved.customerName, 'Synthetic Generated Proposal Customer');
    assert.equal(saved.systemType, 'Hybrid');
    assert.equal(saved.systemCapacity, 8);
    assert.equal(saved.inverterCapacity, 7.5);
    assert.equal(saved.grossAmount, 559470, JSON.stringify(saved.pricing));
    assert.equal(saved.finalAmount, 559470);
    assert.equal(saved.pricing.validityDays, 30);
    assert.deepEqual(saved.pricing.addons, ['Monitoring', 'O&M']);
    assert.equal(saved.pricing.inverterPhase, 'Three Phase');
    assert.equal(saved.pricing.hybridThreePhaseCharge, 35000);
    assert.equal(saved.pricing.batterySize, '10 kWh');
    assert.equal(saved.pricing.discomWork, 'Net-metering coordination');
    assert.equal(saved.pricing.omDuration, '5 years');

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    const proposalCard = page.locator('#proposalSection article').filter({ hasText: saved.proposalNumber });
    await proposalCard.waitFor({ state: 'visible' });
    assert.match(await proposalCard.innerText(), /30 days/);
    assert.match(await proposalCard.innerText(), /Monitoring, O&M/);
    assert.match(await proposalCard.innerText(), /Net-metering coordination/);
    assert.equal(await proposalCard.locator('a[href^="proposal.html?view="]').count(), 1);
    assert.equal(await proposalCard.locator('a[href^="proposal.html?edit="]').count(), 1);

    await proposalCard.locator('a[href^="proposal.html?view="]').click();
    await page.waitForURL('**/proposal.html?view=*');
    await page.getByText(`Solar Proposal ${saved.proposalNumber}`).waitFor({ state: 'visible' });
    await page.goto(`${baseUrl}/proposal.html?edit=${encodeURIComponent(saved.id)}`);
    await page.locator('#formView:not(.hidden)').waitFor();
    await page.waitForFunction((expectedId) => document.querySelector('[name="id"]')?.value === expectedId, saved.id);
    assert.equal(await page.locator('#pageTitle').innerText(), 'Edit Solar Proposal');
    assert.equal(await page.locator('[name="id"]').inputValue(), saved.id);
    assert.equal(await page.locator('[name="validityDays"]').inputValue(), '30');
    await page.locator('#saveButton').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.startsWith('Saved '), null, { timeout: 10000 });
    const proposals = await browserApi(page, `/api/proposals?q=${encodeURIComponent(saved.proposalNumber)}`);
    assert.equal(proposals.data.proposals.filter((item) => item.id === saved.id && item.leadId === leadId).length, 1);

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    await page.locator('#proposalSection').getByText(saved.proposalNumber).waitFor({ state: 'visible' });
    const persisted = await browserApi(page, `/api/proposals/${encodeURIComponent(saved.id)}`);
    assert.equal(persisted.data.proposal.pricing.validityDays, 30);
    assert.deepEqual(persisted.data.proposal.pricing.addons, ['Monitoring', 'O&M']);

    await page.goto(`${baseUrl}/index.html`);
    await page.locator('.sidebar-logout-btn').click();
    await page.waitForURL('**/login.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await browserLogin(page, credentials.execA);
    await page.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`);
    await page.locator('#proposalSection').getByText(saved.proposalNumber).waitFor({ state: 'visible' });
    const afterLogin = await browserApi(page, `/api/proposals/${encodeURIComponent(saved.id)}`);
    assert.equal(afterLogin.data.proposal.leadId, leadId);
    assert.deepEqual(afterLogin.data.proposal.pricing.addons, ['Monitoring', 'O&M']);
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

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}`, { waitUntil: 'domcontentloaded' });
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
    assert.equal(await page.locator('#pageTitle').innerText(), 'Create Solar Proposal');
    const customerSummary = await page.locator('#customerFields').innerText();
    assert.match(customerSummary, /Synthetic Proposal Customer/);
    assert.match(customerSummary, /42 Synthetic Proposal Street/);
    assert.match(customerSummary, /560001/);
    await page.waitForFunction(() => document.querySelector('#summaryCustomer')?.textContent === 'Synthetic Proposal Customer');
    assert.match(await page.locator('#summaryLeadStatus').innerText(), /INP-.*New.*Owner: Synthetic execA/);
    assert.equal(await page.locator('[name="gst"]').getAttribute('readonly'), '');
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopProposalLayout = await page.evaluate(() => ({
        columns: getComputedStyle(document.querySelector('.proposal-workspace')).gridTemplateColumns.split(' ').length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        summaryPosition: getComputedStyle(document.querySelector('.proposal-summary')).position
    }));
    assert.equal(desktopProposalLayout.columns, 2);
    assert.ok(desktopProposalLayout.pageWidth <= desktopProposalLayout.viewportWidth + 1);
    assert.equal(desktopProposalLayout.summaryPosition, 'sticky');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileProposalLayout = await page.evaluate(() => ({
        columns: getComputedStyle(document.querySelector('.proposal-workspace')).gridTemplateColumns.split(' ').length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        summaryOpen: document.querySelector('#liveProposalSummary').open
    }));
    assert.equal(mobileProposalLayout.columns, 1);
    assert.ok(mobileProposalLayout.pageWidth <= mobileProposalLayout.viewportWidth + 1);
    await page.waitForFunction(() => !document.querySelector('#liveProposalSummary').open);
    assert.equal(await page.locator('#liveProposalSummary').evaluate((summary) => summary.open), false);
    const generateButton = page.locator('#generateProposalButton');
    await generateButton.waitFor({ state: 'visible' });
    assert.match(await generateButton.innerText(), /Generate Proposal/);
    assert.equal(await page.locator('#previewButton').isVisible(), true);
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
        [4, 75000, '3-4.99 kW'],
        [5, 68000, '5-7.99 kW'],
        [6, 68000, '5-7.99 kW'],
        [7, 68000, '5-7.99 kW'],
        [8, 60000, '8-9.99 kW'],
        [9, 60000, '8-9.99 kW'],
        [10, 55000, '10-15 kW'],
        [12, 55000, '10-15 kW'],
        [15, 55000, '10-15 kW']
    ]) {
        const pricing = await browserApi(page, `/api/proposals/pricing?capacity=${capacity}`);
        assert.equal(pricing.status, 200);
        assert.equal(pricing.data.pricing.rate, rate);
        assert.equal(pricing.data.pricing.slab, slab);
        assert.equal(pricing.data.pricing.gstRate, 5);
        assert.equal(pricing.data.pricing.gst, Math.round(pricing.data.pricing.subtotal * 5) / 100);
        assert.equal(pricing.data.pricing.grossAmount, capacity * rate);
        assert.equal(pricing.data.pricing.discount, Math.round(capacity * rate * 5) / 100);
        assert.equal(pricing.data.pricing.finalAmount, pricing.data.pricing.grossAmount - pricing.data.pricing.discount);
    }

    for (const [capacity, rate] of [[3, 75000], [4, 75000], [5, 68000], [6, 68000], [7, 68000], [8, 60000], [9, 60000]]) {
        const pricing = await browserApi(page, `/api/proposals/pricing?capacity=${capacity}&pricingType=Subsidy`);
        assert.equal(pricing.status, 200);
        assert.equal(pricing.data.pricing.rate, rate);
        assert.equal(pricing.data.pricing.pricingType, 'Configured contract price');
        assert.equal(pricing.data.pricing.grossAmount, capacity * rate);
        assert.equal(pricing.data.pricing.discount, Math.round(capacity * rate * 5) / 100);
        assert.equal(pricing.data.pricing.subsidy, 0);
    }
    assert.equal((await browserApi(page, '/api/proposals/pricing?capacity=10&pricingType=Subsidy')).status, 200);

    const unverifiedSubsidy = await browserApi(page, '/api/proposals', {
        method: 'POST',
        body: { leadId, systemType: 'On-Grid', systemCapacity: 3, inverterCapacity: 3, pricingType: 'Subsidy', panelCount: 6 }
    });
    assert.equal(unverifiedSubsidy.status, 201);
    assert.equal(unverifiedSubsidy.data.proposal.grossAmount, 225000);
    assert.equal(unverifiedSubsidy.data.proposal.finalAmount, 213750);
    assert.equal(unverifiedSubsidy.data.proposal.subsidy, 0);

    const verifiedSubsidy = await browserApi(page, '/api/proposals', {
        method: 'POST',
        body: {
            leadId, systemType: 'On-Grid', systemCapacity: 3, inverterCapacity: 3,
            pricingType: 'Subsidy', panelCount: 6, subsidyEligibilityReviewed: true, subsidyEligibilityVerified: true
        }
    });
    assert.equal(verifiedSubsidy.status, 201);
    assert.equal(verifiedSubsidy.data.proposal.grossAmount, 225000);
    assert.equal(verifiedSubsidy.data.proposal.finalAmount, 213750);
    assert.equal(verifiedSubsidy.data.proposal.subsidy, 78000);
    assert.equal(verifiedSubsidy.data.proposal.netInvestment, 135750);

    for (const [capacity, rate, batteryConfiguration] of [
        [5, 97000, 'Single Battery'],
        [7, 97000, 'Single Battery'],
        [8, 90000, 'Single Battery'],
        [9, 90000, 'Single Battery'],
        [10, 90000, 'Double Battery']
    ]) {
        const pricing = await browserApi(page, `/api/proposals/pricing?capacity=${capacity}&systemType=Hybrid&panelCount=16`);
        assert.equal(pricing.status, 200);
        assert.equal(pricing.data.pricing.rate, rate);
        assert.equal(pricing.data.pricing.batteryConfiguration, batteryConfiguration);
        assert.equal(pricing.data.pricing.discount, 0);
        assert.equal(pricing.data.pricing.negotiableMessage, 'Contact GM for final pricing');
    }
    const hybridCharges = await browserApi(page, '/api/proposals/pricing?capacity=8&systemType=Hybrid&pricingType=Subsidy&panelCount=16&inverterPhase=Three%20Phase&extraBattery=true');
    assert.equal(hybridCharges.data.pricing.hybridSubsidyCharge, 240000);
    assert.equal(hybridCharges.data.pricing.hybridThreePhaseCharge, 35000);
    assert.equal(hybridCharges.data.pricing.hybridExtraBatteryCharge, 115000);
    assert.equal(hybridCharges.data.pricing.grossAmount, 1129500);

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
    await page.waitForFunction(() => document.querySelector('#summaryCapacity')?.textContent === '3 kW');
    assert.equal(await page.locator('#summaryPanel').innerText(), 'Synthetic Panel Co');
    assert.equal(await page.locator('#summaryInverter').innerText(), 'Synthetic Inverter Co');
    assert.equal(await page.locator('#summaryFinalPrice').innerText(), await page.locator('#finalAmount').innerText());
    const finalPriceBeforeBenefit = await page.locator('#finalAmount').innerText();
    await page.locator('[data-subsidy-eligibility]').check();
    await page.waitForFunction(() => document.querySelector('#summarySubsidy')?.textContent.includes('₹78,000'));
    assert.equal(await page.locator('#finalAmount').innerText(), finalPriceBeforeBenefit);
    await page.locator('[data-subsidy-eligibility]').uncheck();
    await page.waitForFunction(() => document.querySelector('#summarySubsidy')?.textContent === 'Not applied');
    await page.locator('[data-add-component="solarPanels"]').click();
    await page.locator('#equipmentConfiguration [data-component-index="0"][data-component-field="model"]').fill('Synthetic Panel Model');
    await page.locator('#equipmentConfiguration [data-component-index="0"][data-component-field="technicalSpecification"]').fill('Synthetic 550 Wp module');
    await page.locator('#equipmentConfiguration [data-component-index="0"][data-component-field="rating"]').fill('550 W');
    await page.locator('#equipmentConfiguration [data-component-index="0"][data-component-field="brand"]').fill('Configured Synthetic Panel Co');
    assert.equal(await page.locator('[name="panelBrand"]').inputValue(), 'Configured Synthetic Panel Co');
    await page.locator('#equipmentConfiguration [data-component-index="0"][data-component-field="quantity"]').fill('6');
    assert.equal(await page.locator('[name="panelCount"]').inputValue(), '6');
    await page.locator('[data-add-component="inverter"]').click();
    await page.locator('#equipmentConfiguration [data-component-index="1"][data-component-field="model"]').fill('Synthetic Inverter Model');
    await page.locator('#equipmentConfiguration [data-component-index="1"][data-component-field="technicalSpecification"]').fill('Synthetic 3 kW inverter');
    await page.locator('#equipmentConfiguration [data-component-index="1"][data-component-field="brand"]').fill('Configured Synthetic Inverter Co');
    assert.equal(await page.locator('[name="inverterBrand"]').inputValue(), 'Configured Synthetic Inverter Co');
    await page.locator('#equipmentConfiguration [data-component-index="1"][data-component-field="quantity"]').fill('1');
    await page.locator('[data-add-component="battery"]').click();
    assert.equal(await page.locator('#equipmentConfiguration .equipment-row').count(), 3);
    await page.locator('#equipmentConfiguration [data-remove-component="2"]').click();
    assert.equal(await page.locator('#equipmentConfiguration .equipment-row').count(), 2);

    const projectAmountAfterMetrics = await page.locator('#finalAmount').evaluate((element) => Number(element.textContent.replace(/[^\d]/g, '')));
    await page.locator('[name="bookingAmount"]').fill(String(Math.round(projectAmountAfterMetrics * 0.3 * 100) / 100));
    await page.locator('#structuredPaymentSchedule > summary').click();
    await page.locator('#structuredPaymentSchedule').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#structuredPaymentSchedule')?.open === true);
    for (const [label, percentage, booking] of [['Booking', '30', true], ['Delivery', '60', false], ['Commissioning', '10', false]]) {
        await page.locator('#addPaymentMilestone').click();
        const row = page.locator('#paymentScheduleRows > div').last();
        await row.locator('[data-milestone-label]').fill(label);
        await row.locator('[data-milestone-type]').selectOption('percentage');
        await row.locator('[data-milestone-value]').fill(percentage);
        if (booking) await row.locator('[data-milestone-booking]').check();
    }
    assert.match(await page.locator('#summaryPaymentSchedule').innerText(), /3 structured milestones/);

    const previewSideEffects = [];
    page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'POST' && (pathname === '/api/proposals' || /\/api\/proposals\/[^/]+\/pdf$/.test(pathname))) {
            previewSideEffects.push(`${request.method()} ${pathname}`);
        }
    });
    await page.locator('#previewButton').click();
    const previewModal = page.locator('#modalContent');
    await previewModal.getByText('Payment milestones').waitFor();
    assert.match(await previewModal.innerText(), /Configured Synthetic Panel Co/);
    assert.match(await previewModal.innerText(), /Configured Synthetic Inverter Co/);
    assert.match(await previewModal.innerText(), /Booking: 30% · ₹64,125/);
    assert.equal(await previewModal.locator('[data-preview-pdf], [data-preview-send]').count(), 0);
    assert.deepEqual(previewSideEffects, []);
    await previewModal.locator('[data-close]').first().click();

    await page.locator('[name="dailyGenerationKwh"]').fill('16');
    await page.locator('[name="monthlyGenerationKwh"]').fill('480');
    await page.locator('[name="annualGenerationKwh"]').fill('5760');
    await page.locator('[name="monthlySavings"]').fill('1000');
    await page.locator('[name="annualSavings"]').fill('12000');
    await page.locator('[name="savingsAssumptions"]').fill('Synthetic test estimate for persistence and PDF rendering.');
    await page.locator('[name="performanceInputsVerified"]').check();
    await page.waitForFunction(() => document.querySelector('#paybackEstimate')?.textContent.includes('years'));
    const uiPricing = (await browserApi(page, '/api/proposals/pricing?capacity=3&systemType=On-Grid')).data.pricing;
    assert.equal(await page.locator('#summarySubtotal').innerText(), `₹${Math.round(uiPricing.subtotal).toLocaleString('en-IN')}`);
    assert.equal(await page.locator('#summaryGst').innerText(), `₹${Math.round(uiPricing.gst).toLocaleString('en-IN')}`);
    assert.equal(await page.locator('#summaryDiscount').innerText(), `₹${Math.round(uiPricing.discount).toLocaleString('en-IN')}`);
    assert.equal(await page.locator('#summaryFinalPrice').innerText(), `₹${Math.round(uiPricing.finalAmount).toLocaleString('en-IN')}`);
    assert.equal(await page.locator('#summaryNet').innerText(), `₹${Math.round(uiPricing.netInvestment).toLocaleString('en-IN')}`);

    const projectAmount = await page.locator('#finalAmount').evaluate((element) => Number(element.textContent.replace(/[^\d]/g, '')));
    await page.locator('[name="bookingAmount"]').fill(String(Math.round(projectAmount * 0.3 * 100) / 100));
    assert.match(await page.locator('#summaryPaymentSchedule').innerText(), /3 structured milestones/);
    await page.locator('#previewButton').click();
    const proposalPreview = page.locator('#modalContent');
    await proposalPreview.getByText('Payment milestones').waitFor();
    assert.match(await proposalPreview.innerText(), /Configured Synthetic Panel Co/);
    assert.match(await proposalPreview.innerText(), /Configured Synthetic Inverter Co/);
    assert.match(await proposalPreview.innerText(), /Booking: 30% · ₹64,125/);
    assert.equal(await proposalPreview.locator('[data-preview-pdf], [data-preview-send]').count(), 0);
    assert.deepEqual(previewSideEffects, []);
    await proposalPreview.locator('[data-close]').first().click();

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
        const invalidFields = await page.locator('#proposalForm :invalid').evaluateAll((fields) => fields.map((field) => ({ name: field.name, value: field.value, message: field.validationMessage })));
        throw new Error(`Proposal save failed; toast=${await page.locator('#toast').innerText()}, invalid=${JSON.stringify(invalidFields)}, pageErrors=${JSON.stringify(pageErrors)}, statuses=${JSON.stringify(saves)}, responses=${JSON.stringify(saveBodies)}, server=${serverStderr.slice(-1500)}`);
    });
    await page.waitForFunction(() => Boolean(document.querySelector('[name="id"]')?.value));
    const proposalId = await page.locator('[name="id"]').inputValue();
    assert.ok(proposalId);
    assert.deepEqual(saves, [201]);

    const proposalResponse = await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}`);
    assert.equal(proposalResponse.status, 200);
    const proposal = proposalResponse.data.proposal;
    assert.equal(proposal.subsidyEligibilityVerified, false, JSON.stringify({ verified: proposal.subsidyEligibilityVerified, subsidy: proposal.subsidy, pricing: proposal.pricing }));
    assert.equal(proposal.subsidy, 0);
    assert.equal(proposal.leadId, leadId);
    assert.equal(proposal.customerName, 'Synthetic Proposal Customer');
    assert.equal(proposal.contactNumber, createdLead.data.lead.mobileNumber);
    assert.equal(proposal.email, 'proposal-customer@test.invalid');
    assert.equal(proposal.address, '42 Synthetic Proposal Street');
    assert.equal(proposal.pincode, '560001');
    assert.equal(proposal.subtotal, 214285.71);
    assert.equal(proposal.gst, 10714.29);
    assert.equal(proposal.grossAmount, 225000);
    assert.equal(proposal.discount, 11250);
    assert.equal(proposal.finalAmount, 213750);
    assert.equal(proposal.panelBrand, 'Configured Synthetic Panel Co');
    assert.equal(proposal.inverterBrand, 'Configured Synthetic Inverter Co');
    assert.equal(proposal.bookingAmount, 64125);
    assert.deepEqual(proposal.paymentSchedule.map(({ label, type, value, amount, isBooking }) => ({ label, type, value, amount, isBooking })), [
        { label: 'Booking', type: 'percentage', value: 30, amount: 64125, isBooking: true },
        { label: 'Delivery', type: 'percentage', value: 60, amount: 128250, isBooking: false },
        { label: 'Commissioning', type: 'percentage', value: 10, amount: 21375, isBooking: false }
    ]);
    assert.deepEqual(proposal.pricing.componentConfiguration.map(({ category, brand, model, quantity }) => ({ category, brand, model, quantity })), [
        { category: 'solarPanels', brand: 'Configured Synthetic Panel Co', model: 'Synthetic Panel Model', quantity: 6 },
        { category: 'inverter', brand: 'Configured Synthetic Inverter Co', model: 'Synthetic Inverter Model', quantity: 1 }
    ]);
    assert.deepEqual(proposal.pricing.projectMetrics, {
        dailyGenerationKwh: 16,
        monthlyGenerationKwh: 480,
        annualGenerationKwh: 5760,
        savingsAssumptions: 'Synthetic test estimate for persistence and PDF rendering.',
        performanceInputsVerified: true,
        paybackYears: 213750 / 12000
    });
    assert.equal(proposal.status, 'Draft');

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await browserLogin(adminPage, {
        loginId: 'varunkv@inpacepower.com',
        password: serverEnvironment.ADMIN_INITIAL_PASSWORD
    });
    await adminPage.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const settingsResponse = await browserApi(adminPage, '/api/settings');
    assert.equal(settingsResponse.status, 200);
    const originalPricing = settingsResponse.data.settings.solarPricing;
    const changedPricing = { ...originalPricing, tier3: originalPricing.tier3 + 1000 };
    const settingsUpdate = await browserApi(adminPage, '/api/settings', {
        method: 'PATCH',
        body: { solarPricing: changedPricing }
    });
    assert.equal(settingsUpdate.status, 200);
    assert.equal(settingsUpdate.data.settings.solarPricing.tier3, changedPricing.tier3);

    const historicalProposal = (await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}`)).data.proposal;
    assert.equal(historicalProposal.subtotal, proposal.subtotal);
    assert.equal(historicalProposal.gst, proposal.gst);
    assert.equal(historicalProposal.grossAmount, proposal.grossAmount);
    assert.equal(historicalProposal.discount, proposal.discount);
    assert.equal(historicalProposal.finalAmount, proposal.finalAmount);
    assert.equal(historicalProposal.pricing.rate, proposal.pricing.rate);
    const historicalPdf = await browserBinary(page, `/api/proposals/${encodeURIComponent(proposalId)}/pdf`, 'POST', true);
    assert.equal(historicalPdf.status, 200, `Historical proposal PDF failed: ${serverStderr.slice(-1500)}`);
    const historicalPdfText = extractPdfText(Buffer.from(historicalPdf.base64, 'base64'));
    assert.match(historicalPdfText, /2,25,000/);
    assert.doesNotMatch(historicalPdfText, /2,28,000/);
    const restoredSettings = await browserApi(adminPage, '/api/settings', {
        method: 'PATCH',
        body: { solarPricing: originalPricing }
    });
    assert.equal(restoredSettings.status, 200);

    const hybridResponse = await browserApi(page, '/api/proposals', {
        method: 'POST',
        body: {
            leadId,
            systemType: 'Hybrid',
            systemCapacity: 8,
            pricingType: 'Subsidy',
            panelCount: 16,
            inverterPhase: 'Three Phase',
            extraBattery: true,
            inverterCapacity: 8,
            batteryRequired: true,
            batteryCapacity: 10,
            validityDays: 15,
            discount: 0
        }
    });
    assert.equal(hybridResponse.status, 201);
    const hybridProposal = hybridResponse.data.proposal;
    assert.equal(hybridProposal.subtotal, 1075714.29);
    assert.equal(hybridProposal.gst, 53785.71);
    assert.equal(hybridProposal.grossAmount, 1129500);
    assert.equal(hybridProposal.discount, 0);
    assert.equal(hybridProposal.finalAmount, 1129500);
    assert.equal(hybridProposal.netInvestment, 1129500);

    const negotiatedResponse = await browserApi(page, '/api/proposals', {
        method: 'POST',
        body: {
            leadId,
            systemType: 'On-Grid',
            systemCapacity: 3,
            pricingType: 'Non-Subsidy',
            panelCount: 6,
            inverterCapacity: 3,
            validityDays: 15,
            discount: 1000,
            discountOverride: true
        }
    });
    assert.equal(negotiatedResponse.status, 201);
    assert.equal(negotiatedResponse.data.proposal.discount, 1000);
    assert.equal(negotiatedResponse.data.proposal.finalAmount, 224000);

    const hybridPage = await proposalContext.newPage();
    const frontendSession = await page.evaluate(() => localStorage.getItem('solarflow_crm_current_user') || sessionStorage.getItem('solarflow_crm_current_user'));
    assert.ok(frontendSession);
    await hybridPage.goto(`${baseUrl}/robots.txt`);
    await hybridPage.evaluate((session) => localStorage.setItem('solarflow_crm_current_user', session), frontendSession);
    await hybridPage.goto(`${baseUrl}/proposal.html?view=${encodeURIComponent(hybridProposal.id)}`);
    const hybridPreview = hybridPage.locator('#modalContent');
    await hybridPage.waitForFunction(() => {
        const modal = document.querySelector('#modal');
        return modal && !modal.classList.contains('hidden');
    }, null, { timeout: 10000 }).catch(async () => {
        throw new Error(`Hybrid preview did not open at ${hybridPage.url()}. Page: ${(await hybridPage.locator('body').innerText()).slice(0, 1200)}`);
    });
    const hybridPreviewText = await hybridPreview.innerText();
    assert.match(hybridPreviewText, /Subtotal\s+₹10,75,714/);
    assert.match(hybridPreviewText, /GST\s+₹53,786/);
    assert.match(hybridPreviewText, /Gross Amount\s+₹11,29,500/);
    assert.match(hybridPreviewText, /Final Payable\s+₹11,29,500/);
    assert.match(hybridPreviewText, /Base hybrid system price \(GST inclusive\)\s+₹7,20,000/);
    assert.match(hybridPreviewText, /Three-phase additional charge\s+₹35,000/);
    assert.match(hybridPreviewText, /Extra battery charge\s+₹1,15,000/);
    assert.match(hybridPreviewText, /Hybrid subsidy per-panel charge \(16 panels\)\s+₹2,40,000/);
    assert.match(hybridPreviewText, /GST @ 5% on applicable additional charges\s+₹19,500/);
    const hybridPdf = await browserBinary(hybridPage, `/api/proposals/${encodeURIComponent(hybridProposal.id)}/pdf`, 'POST', true);
    assert.equal(hybridPdf.status, 200);
    const hybridPdfText = extractPdfText(Buffer.from(hybridPdf.base64, 'base64'));
    assert.equal(hybridPdf.pageCount, 12);
    assert.ok(hybridPdf.imageCount >= 6, 'The Hybrid proposal should also embed the official logo and representative photographs.');
    assert.match(hybridPdfText, /7,20,000/);
    assert.match(hybridPdfText, /2,40,000/);
    assert.match(hybridPdfText, /35,000/);
    assert.match(hybridPdfText, /1,15,000/);
    assert.match(hybridPdfText, /19,500/);
    assert.match(hybridPdfText, /10,75,714/);
    assert.match(hybridPdfText, /53,785\.71/);
    assert.match(hybridPdfText, /11,29,500/);
    const hybridPdfPages = extractPdfPages(Buffer.from(hybridPdf.base64, 'base64'));
    assert.match(hybridPdfPages[5], /Hybrid inverter/);
    assert.match(hybridPdfPages[5], /BATTERY STORAGE/);

    await page.locator('#previewButton').click();
    const previewText = await page.locator('#modalContent').innerText();
    assert.match(previewText, /Subtotal\s+₹2,14,286/);
    assert.match(previewText, /GST\s+₹10,714/);
    assert.match(previewText, /Gross Amount\s+₹2,25,000/);
    assert.match(previewText, /Discount\s+₹11,250/);
    assert.match(previewText, /Final Payable\s+₹2,13,750/);
    await page.locator('#modalContent [data-close]').first().click();

    const filesBeforeFailure = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
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
    assert.deepEqual(
        filesAfterFailure.data.files.map((file) => file.id),
        filesBeforeFailure.data.files.map((file) => file.id)
    );
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
    assert.equal(viewResponse.pageCount, 12, `Expected 12 physical proposal pages, received ${viewResponse.pageCount}.`);
    assert.ok(viewResponse.imageCount >= 6, 'The official logo and representative proposal photographs should be embedded in the PDF.');
    assert.equal(viewResponse.hasCrossReference, true);
    const pdfTextBuffer = await browserBinary(page, `/api/leads/${encodeURIComponent(leadId)}/files/${encodeURIComponent(proposalFile.id)}`, 'GET', true);
    const pdfBytes = Buffer.from(pdfTextBuffer.base64, 'base64');
    const officialLogoBytes = fs.readFileSync(path.join(__dirname, 'assets', 'inpace-power-logo.jpeg'));
    assert.ok(pdfBytes.includes(officialLogoBytes), 'The PDF should contain the exact official JPEG logo bytes.');
    for (const assetName of ['solar-rooftop.jpeg', 'solar-modules.jpeg', 'solar-inverter.jpeg', 'mounting-structure.jpeg', 'support-engineer.jpeg']) {
        const imageBytes = fs.readFileSync(path.join(__dirname, 'assets', 'proposal-assets', assetName));
        assert.ok(pdfBytes.includes(imageBytes), `The PDF should contain the exact ${assetName} JPEG bytes.`);
    }
    const proposalPdfPages = extractPdfPages(pdfBytes);
    const proposalPdfText = proposalPdfPages.join('\n');
    const proposalPageHeadings = [
        /SOLAR POWER PROPOSAL/,
        /Welcome/,
        /Project Overview & Benefits/,
        /Premium Components and Strong Adherence to Safety Norms/,
        /Operations & Maintenance/,
        /Proposed System Design \/ Technical Details/,
        /Payment Option and Terms/,
        /After-Sales Service/,
        /Scope of Work/,
        /Commercial Proposal/,
        /Bill of Materials/,
        /Customer Acceptance & Closing/
    ];
    assert.equal(proposalPdfPages.length, 12);
    proposalPdfPages.forEach((pageText, index) => {
        assert.match(pageText, proposalPageHeadings[index], `Proposal section ${index + 1} is missing from its expected page.`);
        assert.match(pageText, new RegExp(`${index + 1}\\s*\\/\\s*12`), `Page number ${index + 1} is missing from its content page.`);
        assert.ok(pageText.trim().length > 100, `Proposal page ${index + 1} contains only header/footer text.`);
    });
    assert.match(proposalPdfPages[1], /LEAD NUMBERINP-/);
    assert.doesNotMatch(proposalPdfPages[9], /Estimated PM Surya Ghar benefit/);
    assert.match(proposalPdfPages[3], /DOCUMENTATION \/ APPROVAL REQUIRED/);
    assert.match(proposalPdfPages[4], /not a guaranteed result/);
    assert.match(proposalPdfPages[5], /Configured Synthetic Inverter Co/);
    assert.match(proposalPdfPages[5], /3 kW/);
    assert.match(proposalPdfPages[6], /CRM-SAVED PAYMENT SCHEDULE/);
    assert.match(proposalPdfPages[6], /COMPANY-PROVIDED REFERENCE TERMS/);
    assert.match(proposalPdfPages[6], /BOOKING AMOUNT.*64,125/);
    assert.match(proposalPdfPages[7], /OEM VERIFICATION REQUIRED BEFORE CUSTOMER RELEASE/);
    assert.match(proposalPdfPages[8], /To be confirmed/);
    assert.match(proposalPdfPages[10], /Synthetic Panel Model/);
    assert.match(proposalPdfPages[10], /Synthetic Inverter Model/);
    assert.match(proposalPdfPages[10], /Representative stock photos do not identify selected models/);
    assert.match(proposalPdfPages[11], /CUSTOMER ACCEPTANCE/);
    assert.match(proposalPdfPages[2], /DAILY GENERATION\s*16 kWh/);
    assert.match(proposalPdfPages[2], /ANNUAL GENERATION\s*5760 kWh/);
    assert.match(proposalPdfPages[2], /MONTHLY SAVINGS\s*Rs\. 1,000/);
    assert.match(proposalPdfPages[2], /12,000/);
    assert.match(proposalPdfPages[2], /Synthetic test estimate for persistence and PDF rendering/);
    assert.match(proposalPdfPages[2], /17\.8 years/);
    assert.match(proposalPdfPages[9], /Other ChargesRs\. 0/);

    const verifiedSubsidyPdf = await browserBinary(page, `/api/proposals/${encodeURIComponent(verifiedSubsidy.data.proposal.id)}/pdf`, 'POST', true);
    assert.equal(verifiedSubsidyPdf.status, 200);
    assert.equal(verifiedSubsidyPdf.pageCount, 12);
    const verifiedSubsidyPages = extractPdfPages(Buffer.from(verifiedSubsidyPdf.base64, 'base64'));
    assert.match(verifiedSubsidyPages[9], /Estimated PM Surya Ghar benefit/);
    assert.match(verifiedSubsidyPages[9], /78,000/);
    assert.match(verifiedSubsidyPages[9], /official approval/);
    assert.match(proposalPdfText, /Synthetic Proposal Customer/);
    assert.match(proposalPdfText, /42 Synthetic Proposal Street/);
    assert.match(proposalPdfText, /Configured Synthetic Panel Co/);
    assert.match(proposalPdfText, /Configured Synthetic Inverter Co/);
    assert.match(proposalPdfText, /Inpace Power Pvt Ltd/);
    assert.match(proposalPdfText, /https:\/\/inpacepowers\.com/);
    assert.doesNotMatch(proposalPdfText, /www\.inpaceenergy\.com|(?<!@)inpaceenergy\.com/i);
    assert.match(proposalPdfText, /GST @ 5%/);
    assert.match(proposalPdfText, /2,14,285\.71/);
    assert.match(proposalPdfText, /10,714/);
    assert.match(proposalPdfText, /2,25,000/);
    assert.match(proposalPdfText, /11,250/);
    assert.match(proposalPdfText, /2,13,750/);
    assert.equal(pdfResponseHeaders[0]['content-type'], 'application/pdf');
    assert.match(pdfResponseHeaders[0]['content-disposition'], /^attachment;/);
    assert.equal(pdfResponseHeaders[0]['x-crm-file-id'], proposalFile.id);
    assert.equal(pdfResponseHeaders[0]['x-crm-file-url'], `/api/files/${encodeURIComponent(proposalFile.id)}?download=1`);
    const downloadResponse = await browserBinary(page, `/api/files/${encodeURIComponent(proposalFile.id)}?download=1`, 'GET', true);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.disposition, /^attachment;/);
    assert.deepEqual(downloadResponse.header, [37, 80, 68, 70]);
    const originalPdfHash = crypto.createHash('sha256').update(Buffer.from(downloadResponse.base64, 'base64')).digest('hex');
    const revisedResponse = await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}/duplicate`, { method: 'POST' });
    assert.equal(revisedResponse.status, 201, JSON.stringify(revisedResponse.data));
    const revisedProposal = revisedResponse.data.proposal;
    assert.equal(revisedProposal.parentProposalId, proposalId);
    assert.equal(revisedProposal.versionNumber, 2);
    assert.equal(revisedProposal.leadId, leadId);
    const filesAfterRevision = await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`);
    assert.equal(filesAfterRevision.data.files.filter((file) => file.proposalId === proposalId).length, 1);
    assert.equal(filesAfterRevision.data.files.filter((file) => file.proposalId === revisedProposal.id).length, 0);
    const originalPdfAfterRevision = await browserBinary(page, `/api/files/${encodeURIComponent(proposalFile.id)}?download=1`, 'GET', true);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(originalPdfAfterRevision.base64, 'base64')).digest('hex'), originalPdfHash);
    const idempotentPdf = await browserBinary(page, `/api/proposals/${encodeURIComponent(proposalId)}/pdf`, 'POST');
    assert.equal(idempotentPdf.status, 200);
    assert.deepEqual(idempotentPdf.header, [37, 80, 68, 70]);
    assert.equal((await browserApi(page, `/api/leads/${encodeURIComponent(leadId)}/files`)).data.files.filter((file) => file.proposalId === proposalId).length, 1);

    await page.goto(`${baseUrl}/proposal.html?edit=${encodeURIComponent(proposalId)}`);
    await page.locator('#formView:not(.hidden)').waitFor();
    await page.waitForFunction(() => document.querySelector('#structuredPaymentSchedule')?.open === true);
    const removeMilestoneButtons = page.locator('#paymentScheduleRows [data-remove-milestone]');
    while (await removeMilestoneButtons.count()) await removeMilestoneButtons.first().click();
    assert.equal(await page.locator('[name="paymentSchedule"]').isDisabled(), true);
    assert.equal(await page.locator('[name="paymentTerms"]').inputValue(), '30% booking, 60% delivery, 10% commissioning');
    const updateRoute = `**/api/proposals/${proposalId}`;
    await page.route(updateRoute, async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic draft update failure.' }) });
    }, { times: 1 });
    await page.locator('#saveButton').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Synthetic draft update failure.');
    assert.match(await page.locator('#toast').getAttribute('class'), /border-red-200/);
    assert.equal((await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}`)).data.proposal.paymentSchedule.length, 3);
    await page.unroute(updateRoute);
    await page.locator('#saveButton').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.startsWith('Saved '), null, { timeout: 10000 });
    const updatedProposal = (await browserApi(page, `/api/proposals/${encodeURIComponent(proposalId)}`)).data.proposal;
    assert.deepEqual(updatedProposal.paymentSchedule, []);
    assert.equal(updatedProposal.bookingAmount, 64125);
    assert.equal(updatedProposal.payment_terms, '30% booking, 60% delivery, 10% commissioning');
    await adminContext.close();

    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(leadId)}#files`);
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
    const leadProposals = proposals.data.proposals.filter((item) => item.leadId === leadId);
    assert.equal(leadProposals.length, 6);
    assert.deepEqual(new Set(leadProposals.map((item) => item.id)), new Set([
        proposalId,
        revisedProposal.id,
        unverifiedSubsidy.data.proposal.id,
        verifiedSubsidy.data.proposal.id,
        hybridProposal.id,
        negotiatedResponse.data.proposal.id
    ]));

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

test('Admin assignment works from a display-number URL on mobile and persists the actual database ID', async () => {
    const assignmentLeadId = 'E2E-ASSIGNMENT-DATABASE-ID';
    const assignmentLeadNumber = 'INP-900099';
    const timestamp = new Date().toISOString();
    const database = new DatabaseSync(testDb);
    database.prepare(`INSERT INTO leads
        (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, status, created_by, created_at, updated_at, details_json, lead_score, lead_category)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '{}', 0, 'Cold')`)
        .run(assignmentLeadId, assignmentLeadNumber, 'Synthetic Assignment Browser Customer', '9999980099', 'assignment-browser@test.invalid', timestamp.slice(0, 10), 'Synthetic QA', 'New', 'Warm', 'Active', 'staff-admin', timestamp, timestamp);
    database.close();

    const admin = {
        loginId: 'varunkv@inpacepower.com',
        password: serverEnvironment.ADMIN_INITIAL_PASSWORD
    };
    await browserLogin(page, admin);
    await page.waitForURL('**/index.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/lead-details.html?lead=${encodeURIComponent(assignmentLeadNumber)}`);
    const assignButton = page.locator('[data-action="assign-lead"]').first();
    await assignButton.waitFor({ state: 'visible', timeout: 10000 });
    const desktopButtonBounds = await assignButton.boundingBox();
    assert.ok(desktopButtonBounds && desktopButtonBounds.width > 0 && desktopButtonBounds.height > 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await assignButton.isVisible());
    const mobileButtonBounds = await assignButton.boundingBox();
    assert.ok(mobileButtonBounds && mobileButtonBounds.width > 0 && mobileButtonBounds.height > 0);
    await assignButton.click();

    const modal = page.locator('#leadActionModal:not(.hidden)');
    await modal.waitFor({ state: 'visible' });
    const select = modal.locator('select[name="assignedTo"]');
    await select.waitFor({ state: 'visible' });
    const employeeOption = select.locator(`option[value="${credentials.execA.id}"]`);
    assert.equal(await employeeOption.textContent(), 'Synthetic execA (Sales Executive)');
    await select.selectOption(credentials.execA.id);
    const saveButton = modal.locator('button[type="submit"]');
    const modalBounds = await modal.boundingBox();
    assert.ok(modalBounds && modalBounds.width <= 390);
    assert.equal(await saveButton.innerText(), 'Save Assignment');

    const assignmentRequestPromise = page.waitForRequest((request) => {
        const requestUrl = new URL(request.url());
        return request.method() === 'POST' && requestUrl.pathname.endsWith('/assignment');
    });
    await saveButton.click();
    const request = await assignmentRequestPromise;
    assert.equal(new URL(request.url()).pathname, `/api/leads/${assignmentLeadId}/assignment`);
    assert.deepEqual(JSON.parse(request.postData()), { assignedTo: credentials.execA.id });
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction((owner) => document.querySelector('#leadOwner')?.textContent.trim() === owner, 'Synthetic execA');
    await page.reload();
    await page.waitForFunction((owner) => document.querySelector('#leadOwner')?.textContent.trim() === owner, 'Synthetic execA');

    const verifyDb = new DatabaseSync(testDb, { readOnly: true });
    assert.equal(verifyDb.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(assignmentLeadId).assigned_to, credentials.execA.id);
    verifyDb.close();
});
