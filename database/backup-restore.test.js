const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

process.env.DATABASE_MODE = 'sqlite';
const { createVerifiedCopy, parseArguments } = require('./backup-restore');

let tempDir;
let sourcePath;
let backupPath;
let restoredPath;
let child;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function stopChild() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-crm-backup-test-'));
    sourcePath = path.join(tempDir, 'crm-source.sqlite');
    backupPath = path.join(tempDir, 'backup', 'crm-backup.sqlite');
    restoredPath = path.join(tempDir, 'restore', 'crm-restored.sqlite');
    fs.mkdirSync(path.dirname(backupPath));
    fs.mkdirSync(path.dirname(restoredPath));

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const childSource = `require('./server.js');`;
    child = spawn(process.execPath, ['-e', childSource], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            DATABASE_MODE: 'sqlite',
            SQLITE_DB_PATH: sourcePath,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_USER: '',
            DB_PASSWORD: '',
            DB_NAME: '',
            SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
            ADMIN_INITIAL_PASSWORD: `Synthetic-${crypto.randomBytes(20).toString('hex')}`,
            CRM_FILE_STORAGE_ROOT: path.join(tempDir, 'crm-files'),
            CORS_ORIGIN: baseUrl,
            GOOGLE_CLIENT_ID: '',
            GOOGLE_CLIENT_SECRET: ''
        },
        stdio: 'ignore'
    });

    let ready = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
        try {
            const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
            if (response.ok) {
                ready = true;
                break;
            }
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    if (!ready) throw new Error('Isolated CRM schema fixture did not initialize.');
    await stopChild();

    const database = new DatabaseSync(sourcePath);
    const now = new Date().toISOString();
    database.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('qa-backup-staff', 'QA-BACKUP-STAFF', 'Synthetic Backup Staff', 'backup@test.invalid', 'QA', 'Sales Executive', 'backup@test.invalid', 'synthetic-test-only-hash', 'Sales Executive', 'Active', 'ACTIVE', now);
    database.prepare("INSERT INTO leads (id, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'New', 'Warm', 'Active', ?, ?, ?)")
        .run('qa-backup-lead', 'Synthetic Backup Lead', '9999900011', 'lead@test.invalid', '2026-01-01', 'QA', 'qa-backup-staff', 'qa-backup-staff', now, now);
    database.prepare("INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at) VALUES (?, ?, ?, 'Call', ?, 'Pending', 'synthetic fixture', ?, ?)")
        .run('qa-backup-followup', 'qa-backup-lead', '2030-01-01T10:00', 'qa-backup-staff', 'qa-backup-staff', now);
    database.close();
});

after(async () => {
    await stopChild();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('backup and restore preserve a synthetic relationship in the initialized CRM schema', () => {
    const sourceHashBefore = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    const backup = createVerifiedCopy(sourcePath, backupPath);
    assert.equal(backup.integrity, 'ok');
    assert.equal(backup.tableCountsMatch, true);
    assert.equal(backup.foreignKeyViolations, 0);
    assert.match(backup.permissions, /^owner-only-/);

    const restored = createVerifiedCopy(backupPath, restoredPath);
    assert.equal(restored.integrity, 'ok');
    assert.equal(restored.tableCountsMatch, true);
    assert.equal(restored.foreignKeyViolations, 0);
    assert.match(restored.permissions, /^owner-only-/);

    const database = new DatabaseSync(restoredPath, { readOnly: true });
    const relationshipCount = database.prepare('SELECT COUNT(*) AS count FROM follow_ups f JOIN leads l ON l.id = f.lead_id JOIN staff s ON s.id = f.assigned_to WHERE f.id = ? AND l.id = ? AND s.id = ?')
        .get('qa-backup-followup', 'qa-backup-lead', 'qa-backup-staff').count;
    database.close();
    assert.equal(relationshipCount, 1);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), sourceHashBefore);
});

test('backup and restore require explicit distinct paths and never overwrite a destination', () => {
    assert.deepEqual(parseArguments(['backup', '--source', 'source.sqlite', '--destination', 'backup.sqlite']), {
        operation: 'backup',
        source: 'source.sqlite',
        destination: 'backup.sqlite'
    });
    assert.throws(() => parseArguments(['restore', '--source', 'backup.sqlite']), /required/);
    assert.throws(() => createVerifiedCopy(sourcePath, sourcePath), /different files/);

    const existingPath = path.join(tempDir, 'existing.sqlite');
    fs.writeFileSync(existingPath, 'do-not-overwrite');
    assert.throws(() => createVerifiedCopy(sourcePath, existingPath), /refusing to overwrite/);
    assert.equal(fs.readFileSync(existingPath, 'utf8'), 'do-not-overwrite');
});

test('restore CLI creates a separate protected destination and emits a sanitized result', () => {
    const cliDestination = path.join(tempDir, 'restore', 'crm-cli-restored.sqlite');
    const cli = spawnSync(process.execPath, [
        path.join(__dirname, 'backup-restore.js'),
        'restore',
        '--source',
        backupPath,
        '--destination',
        cliDestination
    ], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_MODE: 'sqlite' },
        encoding: 'utf8',
        timeout: 15000
    });

    assert.equal(cli.status, 0, cli.stderr);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.result, 'PASS');
    assert.equal(result.operation, 'restore');
    assert.equal(result.integrity, 'ok');
    assert.equal(result.foreignKeyViolations, 0);
    assert.equal(result.credentialsOrRowsPrinted, false);
    assert.doesNotMatch(cli.stdout, /Synthetic Backup|qa-backup/);
});
