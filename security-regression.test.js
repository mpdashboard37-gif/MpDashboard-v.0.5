const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { LeadRepository } = require('./repositories/lead-repository');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

let baseUrl;
let child;
let logs = '';
let tempDir;
let syntheticPassword;
let syntheticAdminPassword;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dashboard-security-'));
  const fileStorageRoot = path.join(tempDir, 'crm-files');
  const databasePath = path.join(tempDir, 'crm.sqlite');
  syntheticAdminPassword = `Synthetic-${crypto.randomBytes(24).toString('hex')}`;

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const childSource = `require('./server.js');`;

  child = spawn(process.execPath, ['-e', childSource], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATABASE_MODE: 'sqlite',
      SQLITE_DB_PATH: databasePath,
      ADMIN_INITIAL_PASSWORD: syntheticAdminPassword,
      SESSION_SECRET: 'synthetic-test-session-secret-32-chars-long',
      CORS_ORIGIN: baseUrl,
      CRM_FILE_STORAGE_ROOT: fileStorageRoot,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      PASSWORD_RESET_BASE_URL: `${baseUrl}/login.html`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Failed to start test server.\n${logs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) {
      // Retry until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for the CRM test server.\n${logs}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('public frontend assets are served while sensitive paths remain blocked', async () => {
  const loginPage = await fetch(`${baseUrl}/login.html`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /Login Account|MP Dashboard/);

  const allowedJs = await fetch(`${baseUrl}/settings-ui.js`);
  assert.equal(allowedJs.status, 200);
  assert.match(await allowedJs.text(), /current_user|settings/i);

  for (const pathToCheck of ['/\.env', '/database/schema.sql', '/crm-files/safe.txt', '/mysql/schema.sql', '/repositories/notes.txt']) {
    const response = await fetch(`${baseUrl}${pathToCheck}`);
    assert.equal(response.status, 403, `${pathToCheck} should be blocked`);
  }
});

test('custom SQLite path initializes its synthetic Admin and upload directory', () => {
  const databasePath = path.join(tempDir, 'crm.sqlite');
  assert.equal(fs.existsSync(databasePath), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'crm-files')), true);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const admin = database.prepare("SELECT role, status, account_status, password_hash FROM staff WHERE id = 'staff-admin'").get();
    const leadCount = database.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
    assert.ok(admin);
    assert.equal(admin.role, 'Admin/Owner');
    assert.equal(admin.status, 'Active');
    assert.equal(admin.account_status, 'ACTIVE');
    const [, salt, expectedHash] = admin.password_hash.split('$');
    assert.equal(crypto.scryptSync(syntheticAdminPassword, salt, 64).toString('hex'), expectedHash);
    assert.equal(leadCount, 0);
  } finally {
    database.close();
  }
});

test('Google login callback no longer relies on a bearer token in the URL', async () => {
  const html = await fetch(`${baseUrl}/login.html`).then((response) => response.text());
  const apiClient = fs.readFileSync(path.join(__dirname, 'crm-api.js'), 'utf8');
  assert.doesNotMatch(html, /authToken/);
  assert.doesNotMatch(html, /Authorization:\s*`Bearer\s*\$\{authToken\}`/);
  assert.doesNotMatch(html, /setItem\(['"]solarflow_crm_api_token['"]/);
  assert.match(apiClient, /credentials:\s*'same-origin'/);
  assert.doesNotMatch(apiClient, /Authorization\s*=\s*`Bearer/);
});

test('all CRM pages avoid legacy browser bearer-token storage and headers', () => {
  const pageFiles = fs.readdirSync(__dirname).filter((file) => file.endsWith('.html'));
  const frontendFiles = new Set([...pageFiles, 'crm-api.js']);
  const legacyTokenRead = /(?:localStorage|sessionStorage)\.getItem\(\s*['"]solarflow_crm_api_token['"]/;
  const legacyTokenWrite = /(?:localStorage|sessionStorage)\.setItem\(\s*['"]solarflow_crm_api_token['"]/;
  const bearerHeader = /Authorization\s*[:=][^;\n]{0,120}Bearer/i;

  assert.ok(pageFiles.length > 0);
  for (const pageFile of pageFiles) {
    const html = fs.readFileSync(path.join(__dirname, pageFile), 'utf8');
    for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"]/gi)) {
      if (/^(?:[a-z]+:)?\/\//i.test(src) || /^(?:data|blob):/i.test(src)) continue;
      const localSrc = src.split(/[?#]/, 1)[0].replace(/^\//, '');
      if (!localSrc.endsWith('.js')) continue;
      const localPath = path.resolve(__dirname, localSrc);
      assert.ok(localPath.startsWith(`${__dirname}${path.sep}`), `${pageFile} has an out-of-root script reference`);
      assert.ok(fs.existsSync(localPath), `${pageFile} references a missing script`);
      frontendFiles.add(path.relative(__dirname, localPath));
    }
  }

  for (const file of frontendFiles) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, legacyTokenRead, `${file} must not read a browser-stored bearer token`);
    assert.doesNotMatch(source, legacyTokenWrite, `${file} must not write a browser-stored bearer token`);
    assert.doesNotMatch(source, bearerHeader, `${file} must not send a bearer authorization header`);
  }
});

test('login, authenticated API requests, logout, and session invalidation use the HttpOnly cookie', async () => {
  const databasePath = path.join(tempDir, 'crm.sqlite');
  const database = new DatabaseSync(databasePath);
  const salt = crypto.randomBytes(16).toString('hex');
  syntheticPassword = `Synthetic-${crypto.randomBytes(24).toString('hex')}`;
  const passwordHash = `scrypt$${salt}$${crypto.scryptSync(syntheticPassword, salt, 64).toString('hex')}`;
  database.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run('security-test-user', 'SECURITY-TEST-USER', 'Synthetic Security Test', 'security-test@test.invalid', 'QA', 'Sales Executive', 'security-test@test.invalid', passwordHash, 'Sales Executive', 'Active', 'ACTIVE', new Date().toISOString());
  database.close();

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    credentials: 'same-origin',
    body: JSON.stringify({ loginId: 'security-test@test.invalid', password: syntheticPassword })
  });
  const loginResult = await loginResponse.json();
  const cookieHeader = loginResponse.headers.get('set-cookie') || '';
  const cookie = cookieHeader.split(';', 1)[0];

  assert.equal(loginResponse.status, 200);
  assert.deepEqual(Object.keys(loginResult).sort(), ['user']);
  assert.match(cookieHeader, /;\s*HttpOnly/i);
  assert.match(cookieHeader, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(JSON.stringify(loginResult), /token|secret|password/i);

  const userResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie }, credentials: 'same-origin' });
  assert.equal(userResponse.status, 200);
  assert.equal((await userResponse.json()).user.id, 'security-test-user');

  const leadsResponse = await fetch(`${baseUrl}/api/leads`, { headers: { Cookie: cookie }, credentials: 'same-origin' });
  assert.equal(leadsResponse.status, 200);

  const importResponse = await fetch(`${baseUrl}/api/lead-imports/preview`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'synthetic.csv' },
    body: Buffer.from('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\nSynthetic Customer,9876543210,,,')
  });
  assert.equal(importResponse.status, 403);
  const importDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(importDatabase.prepare('SELECT COUNT(*) AS count FROM lead_imports').get().count, 0);
  } finally {
    importDatabase.close();
  }

  const bearerOnlyResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer synthetic-bearer-marker' }
  });
  assert.equal(bearerOnlyResponse.status, 401);

  const invalidLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ loginId: 'security-test@test.invalid', password: 'incorrect-synthetic-password' })
  });
  assert.equal(invalidLoginResponse.status, 401);

  const csrfResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' },
    body: JSON.stringify({ loginId: 'security-test@test.invalid', password: syntheticPassword })
  });
  assert.ok(csrfResponse.status < 200 || csrfResponse.status >= 300);
  assert.equal(csrfResponse.headers.has('set-cookie'), false);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl },
    credentials: 'same-origin'
  });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie') || '', /Max-Age=0/);

  const invalidatedResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie }, credentials: 'same-origin' });
  assert.equal(invalidatedResponse.status, 401);
  assert.doesNotMatch(logs, new RegExp(syntheticPassword));
  assert.doesNotMatch(logs, /synthetic-bearer-marker/);
});

test('Admin/Owner can preview and process a persistent import without creating leads on upload', async () => {
  const databasePath = path.join(tempDir, 'crm.sqlite');
  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ loginId: 'varunkv@inpacepower.com', password: syntheticAdminPassword })
  });
  assert.equal(adminLogin.status, 200);
  const cookie = (adminLogin.headers.get('set-cookie') || '').split(';', 1)[0];
  const upload = async (csv) => fetch(`${baseUrl}/api/lead-imports/preview`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'synthetic.csv' },
    body: Buffer.from(csv)
  });
  const poll = async (id) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/lead-imports/${id}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const { job } = await response.json();
      if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the synthetic lead import.');
  };

  const previewResponse = await upload('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\nSynthetic Bulk Customer,9876543211,bulk-import@example.test,"Synthetic Address",560001\r\n');
  assert.equal(previewResponse.status, 201);
  const preview = await previewResponse.json();
  assert.equal(preview.validRows, 1);
  const beforeStart = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(beforeStart.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 0);
  } finally {
    beforeStart.close();
  }

  const startResponse = await fetch(`${baseUrl}/api/lead-imports/${preview.previewId}/start`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(startResponse.status, 202);
  const completed = await poll(preview.previewId);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.processedRows, 1);
  assert.equal(completed.createdCount, 1);
  const imported = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const lead = imported.prepare('SELECT customer_name, mobile_number, lead_source, stage, assigned_to FROM leads WHERE mobile_number = ?').get('9876543211');
    assert.equal(lead.customer_name, 'Synthetic Bulk Customer');
    assert.equal(lead.lead_source, 'Website');
    assert.equal(lead.stage, 'New');
    assert.equal(lead.assigned_to, 'security-test-user');
  } finally {
    imported.close();
  }

  const invalidResponse = await upload('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\n"=HYPERLINK(""bad"")",123,not-an-email,,005601\r\n');
  assert.equal(invalidResponse.status, 201);
  const invalidPreview = await invalidResponse.json();
  assert.equal(invalidPreview.validRows, 0);
  const validationReport = await fetch(`${baseUrl}/api/lead-imports/${invalidPreview.previewId}/errors`, { headers: { Cookie: cookie } });
  assert.equal(validationReport.status, 200);
  assert.match(await validationReport.text(), /"'=HYPERLINK/);
  const invalidStart = await fetch(`${baseUrl}/api/lead-imports/${invalidPreview.previewId}/start`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(invalidStart.status, 202);
  const partial = await poll(invalidPreview.previewId);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.createdCount, 0);
  assert.equal(partial.failedCount, 1);
  const report = await fetch(`${baseUrl}/api/lead-imports/${invalidPreview.previewId}/errors`, { headers: { Cookie: cookie } });
  assert.equal(report.status, 200);
  assert.match(await report.text(), /"'=HYPERLINK/);
});

test('a second import start is rejected while a persisted import lock is held', async () => {
  const databasePath = path.join(tempDir, 'crm.sqlite');
  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ loginId: 'varunkv@inpacepower.com', password: syntheticAdminPassword })
  });
  assert.equal(adminLogin.status, 200);
  const cookie = (adminLogin.headers.get('set-cookie') || '').split(';', 1)[0];
  const upload = async (csv) => fetch(`${baseUrl}/api/lead-imports/preview`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'synthetic.csv' },
    body: Buffer.from(csv)
  });
  const firstPreviewResponse = await upload('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\nSynthetic First Job,9000099998,first-job@example.test,Address,560001\r\n');
  assert.equal(firstPreviewResponse.status, 201);
  const firstPreview = await firstPreviewResponse.json();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE lead_imports SET status = 'PROCESSING' WHERE id = ?").run(firstPreview.previewId);
  database.prepare('INSERT INTO lead_import_lock (id, job_id) VALUES (1, ?)').run(firstPreview.previewId);
  database.close();
  const waitingPreviewResponse = await upload('Customer Name,Contact Number,Email ID,Customer Address,Pincode\r\nWaiting Customer,9000099999,waiting@example.test,Address,560001\r\n');
  assert.equal(waitingPreviewResponse.status, 201);
  const waitingPreview = await waitingPreviewResponse.json();
  const secondStart = await fetch(`${baseUrl}/api/lead-imports/${waitingPreview.previewId}/start`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(secondStart.status, 409);
  const cleanupDatabase = new DatabaseSync(databasePath);
  cleanupDatabase.prepare('DELETE FROM lead_import_lock WHERE id = 1').run();
  cleanupDatabase.prepare('DELETE FROM lead_imports WHERE id IN (?, ?)').run(firstPreview.previewId, waitingPreview.previewId);
  cleanupDatabase.close();
});

test('request logs redact OAuth and other sensitive query values', async () => {
  const markers = [
    'synthetic-oauth-code-marker',
    'synthetic-oauth-state-marker',
    'synthetic-access-token-marker',
    'synthetic-client-secret-marker',
    'synthetic-query-password-marker'
  ];
  const response = await fetch(`${baseUrl}/api/auth/google/callback?code=${markers[0]}&state=${markers[1]}&access_token=${markers[2]}&clientSecret=${markers[3]}&password=${markers[4]}`, {
    redirect: 'manual'
  });
  assert.equal(response.status, 302);

  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const marker of markers) assert.equal(logs.includes(marker), false);
  assert.match(logs, /%5BREDACTED%5D/);
});

test('lead lookup prefers an exact ID match before a lead number fallback', async () => {
  const calls = [];
  const database = {
    get(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes(' OR ')) {
        return { id: 'INP-900001', lead_number: 'INP-3558087', customer_name: 'Wrong record' };
      }
      if (sql === 'SELECT * FROM leads WHERE id = ? LIMIT 1') {
        return params[0] === 'INP-3558087' ? { id: 'INP-3558087', lead_number: 'INP-100001', customer_name: 'Exact ID match' } : null;
      }
      if (sql === 'SELECT * FROM leads WHERE lead_number = ? LIMIT 1') {
        return { id: 'INP-900001', lead_number: 'INP-3558087', customer_name: 'Lead number fallback' };
      }
      return null;
    },
    all() { return []; }
  };

  const repo = new LeadRepository(database);
  const lead = await repo.getRow('INP-3558087');

  assert.equal(lead.id, 'INP-3558087');
  assert.equal(lead.customer_name, 'Exact ID match');
  assert.deepEqual(calls.map((entry) => entry.sql), ['SELECT * FROM leads WHERE id = ? LIMIT 1']);
});
