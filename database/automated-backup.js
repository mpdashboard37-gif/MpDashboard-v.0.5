const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createVerifiedCopy, inspectDatabase } = require('./backup-restore');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATTERN = /^crm-backup-\d{8}T\d{9}Z$/;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 365;

function isSameOrWithin(parentPath, candidatePath) {
    const relative = path.relative(parentPath, candidatePath);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256File(filePath) {
    const descriptor = fs.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead);
        return hash.digest('hex');
    } finally {
        fs.closeSync(descriptor);
    }
}

function fileManifest(directory) {
    const files = [];
    function walk(currentPath, relativePath = '') {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const sourcePath = path.join(currentPath, entry.name);
            const sourceStat = fs.lstatSync(sourcePath);
            if (sourceStat.isSymbolicLink() || (!sourceStat.isDirectory() && !sourceStat.isFile())) {
                throw new Error('Uploaded-file storage contains an unsupported filesystem entry.');
            }
            const name = path.join(relativePath, entry.name).split(path.sep).join('/');
            if (sourceStat.isDirectory()) {
                walk(sourcePath, name);
            } else {
                files.push({ name, size: sourceStat.size, modifiedAt: sourceStat.mtimeMs, sha256: sha256File(sourcePath) });
            }
        }
    }
    walk(directory);
    return files;
}

function copyFileTree(sourceDirectory, destinationDirectory) {
    fs.mkdirSync(destinationDirectory, { mode: 0o700 });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDirectory, entry.name);
        const destinationPath = path.join(destinationDirectory, entry.name);
        const sourceStat = fs.lstatSync(sourcePath);
        if (sourceStat.isSymbolicLink() || (!sourceStat.isDirectory() && !sourceStat.isFile())) {
            throw new Error('Uploaded-file storage contains an unsupported filesystem entry.');
        }
        if (sourceStat.isDirectory()) {
            copyFileTree(sourcePath, destinationPath);
        } else {
            fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
            if (process.platform !== 'win32') fs.chmodSync(destinationPath, 0o600);
        }
    }
}

function protectDirectory(directoryPath, recursive = false) {
    if (process.platform === 'win32') {
        const account = execFileSync('whoami', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
        if (!account) throw new Error('Unable to determine the current Windows account for backup permissions.');
        const applyDirectoryAcl = (targetPath) => execFileSync('icacls', [
            targetPath, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)(F)`, '/Q'
        ], { stdio: 'ignore', windowsHide: true });
        const applyFileAcl = (targetPath) => execFileSync('icacls', [
            targetPath, '/inheritance:r', '/grant:r', `${account}:(F)`, '/Q'
        ], { stdio: 'ignore', windowsHide: true });

        if (recursive) {
            for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
                const entryPath = path.join(directoryPath, entry.name);
                if (entry.isSymbolicLink()) throw new Error('Backup directory contains an unsupported symbolic link.');
                if (entry.isDirectory()) protectDirectory(entryPath, true);
                else if (entry.isFile()) applyFileAcl(entryPath);
                else throw new Error('Backup directory contains an unsupported filesystem entry.');
            }
        }
        applyDirectoryAcl(directoryPath);
        return 'owner-only-acl';
    }

    if (recursive) {
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) protectDirectory(entryPath, true);
            else fs.chmodSync(entryPath, 0o600);
        }
    }
    fs.chmodSync(directoryPath, 0o700);
    if ((fs.statSync(directoryPath).mode & 0o777) !== 0o700) {
        throw new Error('Unable to restrict backup directory permissions.');
    }
    return 'owner-only-mode';
}

function validateRetentionDays(value) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
        throw new Error(`Backup retention must be an integer from 1 to ${MAX_RETENTION_DAYS} days.`);
    }
    return days;
}

function validateSnapshot(snapshotPath, expectedSnapshotName = path.basename(snapshotPath)) {
    const snapshotStat = fs.lstatSync(snapshotPath);
    if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) throw new Error('Backup snapshot must be a regular directory.');

    const expectedEntries = ['backup-manifest.json', 'crm-files', 'crm.sqlite'];
    const actualEntries = fs.readdirSync(snapshotPath).sort();
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
        throw new Error('Backup snapshot is incomplete or contains unexpected files.');
    }
    const manifestPath = path.join(snapshotPath, 'backup-manifest.json');
    const databasePath = path.join(snapshotPath, 'crm.sqlite');
    const uploadedFilesPath = path.join(snapshotPath, 'crm-files');
    const manifestStat = fs.lstatSync(manifestPath);
    const databaseStat = fs.lstatSync(databasePath);
    const uploadedFilesStat = fs.lstatSync(uploadedFilesPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
        || !databaseStat.isFile() || databaseStat.isSymbolicLink()
        || !uploadedFilesStat.isDirectory() || uploadedFilesStat.isSymbolicLink()) {
        throw new Error('Backup snapshot contains an unsupported filesystem entry.');
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error('Backup snapshot manifest is missing or invalid.');
    }
    if (!manifest || manifest.version !== 1 || manifest.snapshot !== expectedSnapshotName
        || !Array.isArray(manifest.files) || !manifest.database
        || typeof manifest.createdAt !== 'string'
        || !Number.isFinite(Date.parse(manifest.createdAt))
        || `crm-backup-${manifest.createdAt.replace(/[-:.]/g, '')}` !== expectedSnapshotName) {
        throw new Error('Backup snapshot manifest is incomplete or invalid.');
    }

    const databaseReport = inspectDatabase(databasePath);
    if (databaseReport.foreignKeyViolations !== 0
        || databaseReport.schemaHash !== manifest.database.schemaHash
        || databaseReport.tableCount !== manifest.database.tableCount
        || JSON.stringify(databaseReport.rowCounts) !== JSON.stringify(manifest.database.rowCounts)) {
        throw new Error('Backup database does not match its verification manifest.');
    }

    const copiedFiles = fileManifest(uploadedFilesPath);
    const expectedFiles = manifest.files.map((file) => {
        if (!file || typeof file.path !== 'string' || path.posix.isAbsolute(file.path)
            || file.path.split('/').some((part) => !part || part === '.' || part === '..')
            || !Number.isSafeInteger(file.size) || file.size < 0
            || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
            throw new Error('Backup snapshot file manifest contains an invalid entry.');
        }
        return { name: file.path, size: file.size, sha256: file.sha256 };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const actualFiles = copiedFiles.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
        throw new Error('Backup snapshot uploaded files are missing, corrupted, or unexpected.');
    }

    return {
        snapshot: expectedSnapshotName,
        integrity: 'ok',
        tableCount: databaseReport.tableCount,
        uploadedFileCount: actualFiles.length,
        uploadedBytes: actualFiles.reduce((total, file) => total + file.size, 0)
    };
}

function pruneExpiredSnapshots(backupRoot, now, retentionDays) {
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SNAPSHOT_PATTERN.test(entry.name)) continue;
        const snapshotPath = path.join(backupRoot, entry.name);
        if (fs.statSync(snapshotPath).mtimeMs < cutoff) {
            validateSnapshot(snapshotPath, entry.name);
            protectDirectory(snapshotPath, true);
            fs.rmSync(snapshotPath, { recursive: true, force: false });
        }
    }
}

function validateExistingSnapshots(backupRoot) {
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
        if (!entry.name.startsWith('crm-backup-')) continue;
        if (!entry.isDirectory() || !SNAPSHOT_PATTERN.test(entry.name)) {
            throw new Error('An existing backup entry has an invalid snapshot name or type.');
        }
        validateSnapshot(path.join(backupRoot, entry.name), entry.name);
    }
}

function findValidatedSnapshotForDate(backupRoot, dateKey) {
    const prefix = `crm-backup-${dateKey}T`;
    const matchingEntries = fs.readdirSync(backupRoot, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(prefix));
    for (const entry of matchingEntries) {
        if (!entry.isDirectory() || !SNAPSHOT_PATTERN.test(entry.name)) {
            throw new Error('An existing backup directory has an invalid snapshot name or type.');
        }
        validateSnapshot(path.join(backupRoot, entry.name), entry.name);
    }
    return matchingEntries.length > 0;
}

function createBackupSnapshot({
    databasePath,
    fileStorageRoot,
    backupRoot,
    retentionDays = DEFAULT_RETENTION_DAYS,
    now = new Date()
}) {
    const sourceDatabase = path.resolve(databasePath);
    const sourceFiles = path.resolve(fileStorageRoot);
    const destinationRoot = path.resolve(backupRoot);
    const retention = validateRetentionDays(retentionDays);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Backup date must be valid.');

    const databaseStat = fs.lstatSync(sourceDatabase);
    const filesStat = fs.lstatSync(sourceFiles);
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Database source must be a regular file.');
    if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) throw new Error('Uploaded-file source must be a regular directory.');
    if (isSameOrWithin(ROOT, destinationRoot)) throw new Error('Backup destination must be outside the application directory.');
    if (isSameOrWithin(destinationRoot, sourceDatabase)) throw new Error('Backup destination must not contain the source database.');
    if (isSameOrWithin(sourceFiles, sourceDatabase)) throw new Error('Database and uploaded-file source paths must be separate.');
    if (isSameOrWithin(destinationRoot, sourceFiles) || isSameOrWithin(sourceFiles, destinationRoot)) {
        throw new Error('Backup destination and uploaded-file source must be separate directory trees.');
    }

    fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
    const destinationStat = fs.lstatSync(destinationRoot);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) throw new Error('Backup destination must be a regular directory.');
    protectDirectory(destinationRoot);
    const actualDestinationRoot = fs.realpathSync(destinationRoot);
    if (isSameOrWithin(ROOT, actualDestinationRoot)
        || isSameOrWithin(actualDestinationRoot, sourceDatabase)
        || isSameOrWithin(sourceFiles, actualDestinationRoot)
        || isSameOrWithin(actualDestinationRoot, sourceFiles)) {
        throw new Error('Backup destination resolves to an unsafe or overlapping path.');
    }
    validateExistingSnapshots(destinationRoot);
    pruneExpiredSnapshots(destinationRoot, now, retention);
    const dateKey = now.toISOString().slice(0, 10).replace(/-/g, '');
    if (findValidatedSnapshotForDate(destinationRoot, dateKey)) {
        return { skipped: true, reason: 'A verified backup already exists for this UTC date.' };
    }

    const timestamp = now.toISOString().replace(/[-:.]/g, '');
    const snapshotName = `crm-backup-${timestamp}`;
    const finalDirectory = path.join(destinationRoot, snapshotName);
    const stagingDirectory = path.join(destinationRoot, `.${snapshotName}-${process.pid}.partial`);
    const sourceManifest = fileManifest(sourceFiles);
    fs.mkdirSync(stagingDirectory, { mode: 0o700 });

    try {
        const databaseResult = createVerifiedCopy(sourceDatabase, path.join(stagingDirectory, 'crm.sqlite'));
        const copiedFiles = path.join(stagingDirectory, 'crm-files');
        copyFileTree(sourceFiles, copiedFiles);
        const sourceManifestAfterCopy = fileManifest(sourceFiles);
        const copiedManifest = fileManifest(copiedFiles);
        const sourceFileSizesAndHashes = sourceManifest.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
        const copiedFileSizesAndHashes = copiedManifest.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
        if (JSON.stringify(sourceManifest) !== JSON.stringify(sourceManifestAfterCopy)
            || JSON.stringify(sourceFileSizesAndHashes) !== JSON.stringify(copiedFileSizesAndHashes)) {
            throw new Error('Uploaded files changed during backup or did not copy completely.');
        }

        const manifest = {
            version: 1,
            snapshot: snapshotName,
            createdAt: now.toISOString(),
            database: inspectDatabase(path.join(stagingDirectory, 'crm.sqlite')),
            files: copiedManifest.map(({ name, size, sha256 }) => ({ path: name, size, sha256 }))
        };
        fs.writeFileSync(path.join(stagingDirectory, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        const permissions = protectDirectory(stagingDirectory, true);
        validateSnapshot(stagingDirectory, snapshotName);
        fs.renameSync(stagingDirectory, finalDirectory);
        pruneExpiredSnapshots(destinationRoot, now, retention);
        return {
            skipped: false,
            snapshot: snapshotName,
            integrity: databaseResult.integrity,
            tableCount: databaseResult.tableCount,
            uploadedFileCount: copiedManifest.length,
            uploadedBytes: copiedManifest.reduce((total, file) => total + file.size, 0),
            permissions,
            retentionDays: retention
        };
    } catch (error) {
        if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
}

function readConfiguration() {
    const databaseConfig = require('./config');
    if (databaseConfig.mode !== 'sqlite') throw new Error('Automated backups require SQLite.');
    const backupRoot = String(process.env.CRM_BACKUP_ROOT || '').trim();
    if (!backupRoot) throw new Error('CRM_BACKUP_ROOT must point to a dedicated backup directory.');
    return {
        databasePath: databaseConfig.sqlitePath,
        fileStorageRoot: path.resolve(String(process.env.CRM_FILE_STORAGE_ROOT || path.join(ROOT, 'crm-files'))),
        backupRoot: path.resolve(backupRoot),
        retentionDays: process.env.CRM_BACKUP_RETENTION_DAYS
            ? validateRetentionDays(process.env.CRM_BACKUP_RETENTION_DAYS)
            : DEFAULT_RETENTION_DAYS
    };
}

function runOnce() {
    const result = createBackupSnapshot({ ...readConfiguration() });
    console.log(JSON.stringify({ result: result.skipped ? 'SKIPPED' : 'PASS', credentialsOrRowsPrinted: false, ...result }));
}

function startScheduledBackups() {
    let activeProcess = null;
    let stopped = false;
    const runCheck = () => {
        if (stopped || activeProcess) return;
        activeProcess = spawn(process.execPath, [__filename, 'once'], { stdio: 'inherit', windowsHide: true });
        activeProcess.once('error', (error) => {
            console.error('Automatic CRM backup could not start.', { errorType: error?.name || 'Error', errorCode: error?.code || null });
        });
        activeProcess.once('close', (code) => {
            activeProcess = null;
            if (code !== 0) console.error('Automatic CRM backup failed.', { exitCode: code });
        });
    };
    runCheck();
    const timer = setInterval(runCheck, CHECK_INTERVAL_MS);
    timer.unref();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

if (require.main === module) {
    try {
        if (process.argv[2] !== 'once' || process.argv.length !== 3) throw new Error('Usage: node database/automated-backup.js once.');
        runOnce();
    } catch (error) {
        console.error(JSON.stringify({ result: 'FAIL', errorType: error?.name || 'Error', errorCode: error?.code || null, credentialsOrRowsPrinted: false }));
        process.exitCode = 1;
    }
}

module.exports = { createBackupSnapshot, startScheduledBackups, validateRetentionDays, validateSnapshot };
