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
const { createBackupSnapshot, validateSnapshot } = require('./automated-backup');

let tempDir;
let sourcePath;
let backupPath;
let restoredPath;
let fileStorageRoot;
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

function createSyntheticSnapshot(backupRoot, date = '2026-10-28T12:00:00.000Z') {
    const result = createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot,
        retentionDays: 14,
        now: new Date(date)
    });
    assert.equal(result.skipped, false);
    return path.join(backupRoot, result.snapshot);
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-crm-backup-test-'));
    sourcePath = path.join(tempDir, 'crm-source.sqlite');
    backupPath = path.join(tempDir, 'backup', 'crm-backup.sqlite');
    restoredPath = path.join(tempDir, 'restore', 'crm-restored.sqlite');
    fileStorageRoot = path.join(tempDir, 'crm-files');
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
            CRM_FILE_STORAGE_ROOT: fileStorageRoot,
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

    fs.mkdirSync(path.join(fileStorageRoot, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(fileStorageRoot, 'documents', 'synthetic-upload.txt'), 'synthetic upload only');
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

test('automated snapshots include uploaded files, enforce retention, and preserve isolated source data', () => {
    const automaticRoot = path.join(tempDir, 'automatic-backups');
    const expiredSnapshot = createSyntheticSnapshot(automaticRoot, '2026-09-01T00:00:00.000Z');
    const snapshotDate = new Date('2026-10-28T12:00:00.000Z');
    const expiredAt = new Date(snapshotDate.getTime() - 15 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expiredSnapshot, expiredAt, expiredAt);

    const sourceHashBefore = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    const snapshot = createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot: automaticRoot,
        retentionDays: 14,
        now: snapshotDate
    });

    assert.equal(snapshot.skipped, false);
    assert.equal(snapshot.integrity, 'ok');
    assert.equal(snapshot.uploadedFileCount, 1);
    assert.equal(snapshot.uploadedBytes, Buffer.byteLength('synthetic upload only'));
    assert.equal(fs.existsSync(expiredSnapshot), false);
    const snapshotDirectory = path.join(automaticRoot, snapshot.snapshot);
    const verifiedSnapshot = validateSnapshot(snapshotDirectory);
    assert.equal(verifiedSnapshot.integrity, 'ok');
    assert.equal(verifiedSnapshot.uploadedFileCount, 1);
    const backedUpUpload = path.join(snapshotDirectory, 'crm-files', 'documents', 'synthetic-upload.txt');
    assert.equal(fs.readFileSync(backedUpUpload, 'utf8'), 'synthetic upload only');
    assert.equal(fs.readFileSync(path.join(fileStorageRoot, 'documents', 'synthetic-upload.txt'), 'utf8'), 'synthetic upload only');
    const backupManifest = JSON.parse(fs.readFileSync(path.join(snapshotDirectory, 'backup-manifest.json'), 'utf8'));
    assert.deepEqual(backupManifest.files, [{
        path: 'documents/synthetic-upload.txt',
        size: Buffer.byteLength('synthetic upload only'),
        sha256: crypto.createHash('sha256').update('synthetic upload only').digest('hex')
    }]);

    const repeat = createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot: automaticRoot,
        retentionDays: 14,
        now: snapshotDate
    });
    assert.equal(repeat.skipped, true);

    const restoredDatabase = path.join(tempDir, 'restore', 'automated-restored.sqlite');
    const restoredFiles = path.join(tempDir, 'restore', 'automated-crm-files');
    const restoreResult = createVerifiedCopy(path.join(snapshotDirectory, 'crm.sqlite'), restoredDatabase);
    assert.equal(restoreResult.integrity, 'ok');
    fs.cpSync(path.join(snapshotDirectory, 'crm-files'), restoredFiles, { recursive: true });
    assert.equal(fs.readFileSync(path.join(restoredFiles, 'documents', 'synthetic-upload.txt'), 'utf8'), 'synthetic upload only');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), sourceHashBefore);

    const cliRoot = path.join(tempDir, 'automated-cli-backups');
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'automated-backup.js'), 'once'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            DATABASE_MODE: 'sqlite',
            SQLITE_DB_PATH: sourcePath,
            CRM_FILE_STORAGE_ROOT: fileStorageRoot,
            CRM_BACKUP_ROOT: cliRoot,
            CRM_BACKUP_RETENTION_DAYS: '14'
        },
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(cli.status, 0, cli.stderr);
    const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.result, 'PASS');
    assert.equal(cliResult.integrity, 'ok');
    assert.equal(cliResult.uploadedFileCount, 1);
    assert.equal(cliResult.credentialsOrRowsPrinted, false);
    assert.doesNotMatch(cli.stdout, /Synthetic Backup|qa-backup/);
});

test('corrupted copied uploads fail validation and are not accepted as completed backups', () => {
    const backupRoot = path.join(tempDir, 'corrupted-backups');
    const snapshotDirectory = createSyntheticSnapshot(backupRoot, '2026-10-29T12:00:00.000Z');
    const copiedUpload = path.join(snapshotDirectory, 'crm-files', 'documents', 'synthetic-upload.txt');
    fs.writeFileSync(copiedUpload, 'corrupted synthetic upload');

    assert.throws(() => validateSnapshot(snapshotDirectory), /missing, corrupted, or unexpected/);
    assert.throws(() => createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot,
        retentionDays: 14,
        now: new Date('2026-10-29T13:00:00.000Z')
    }), /missing, corrupted, or unexpected/);
    assert.equal(fs.readFileSync(path.join(fileStorageRoot, 'documents', 'synthetic-upload.txt'), 'utf8'), 'synthetic upload only');
});

test('missing copied uploads fail snapshot validation', () => {
    const snapshotDirectory = createSyntheticSnapshot(path.join(tempDir, 'missing-upload-backups'), '2026-10-30T12:00:00.000Z');
    fs.unlinkSync(path.join(snapshotDirectory, 'crm-files', 'documents', 'synthetic-upload.txt'));
    assert.throws(() => validateSnapshot(snapshotDirectory), /missing, corrupted, or unexpected/);
});

test('incomplete and invalid same-day backup directories are rejected', () => {
    const backupRoot = path.join(tempDir, 'incomplete-backups');
    const incompleteSnapshot = path.join(backupRoot, 'crm-backup-20261031T120000000Z');
    fs.mkdirSync(incompleteSnapshot, { recursive: true });
    fs.writeFileSync(path.join(incompleteSnapshot, 'crm.sqlite'), 'synthetic incomplete database');

    assert.throws(() => createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot,
        retentionDays: 14,
        now: new Date('2026-10-31T13:00:00.000Z')
    }), /incomplete or contains unexpected files/);

    fs.rmSync(incompleteSnapshot, { recursive: true });
    fs.mkdirSync(path.join(backupRoot, 'crm-backup-20261031Tinvalid'));
    assert.throws(() => createBackupSnapshot({
        databasePath: sourcePath,
        fileStorageRoot,
        backupRoot,
        retentionDays: 14,
        now: new Date('2026-10-31T14:00:00.000Z')
    }), /invalid snapshot name/);
});

test('restore rejects a corrupted snapshot and restores only a verified synthetic snapshot', () => {
    const backupRoot = path.join(tempDir, 'restore-verification-backups');
    const snapshotDirectory = createSyntheticSnapshot(backupRoot, '2026-11-01T12:00:00.000Z');
    const snapshotDatabase = path.join(snapshotDirectory, 'crm.sqlite');
    const databaseHashBefore = crypto.createHash('sha256').update(fs.readFileSync(snapshotDatabase)).digest('hex');
    const validated = validateSnapshot(snapshotDirectory);
    assert.equal(validated.integrity, 'ok');

    const restoredDatabase = path.join(tempDir, 'restore', 'verified-snapshot.sqlite');
    const restored = createVerifiedCopy(snapshotDatabase, restoredDatabase);
    assert.equal(restored.integrity, 'ok');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(snapshotDatabase)).digest('hex'), databaseHashBefore);

    const restoredFiles = path.join(tempDir, 'restore', 'verified-snapshot-files');
    fs.cpSync(path.join(snapshotDirectory, 'crm-files'), restoredFiles, { recursive: true });
    assert.equal(fs.readFileSync(path.join(restoredFiles, 'documents', 'synthetic-upload.txt'), 'utf8'), 'synthetic upload only');
});
