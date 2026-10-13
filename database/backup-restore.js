const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REQUIRED_TABLES = ['follow_ups', 'leads', 'sessions', 'staff', 'surveys'];

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteSqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function inspectDatabase(filePath) {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
        const integrityResults = database.prepare('PRAGMA integrity_check').all();
        if (!integrityResults.length || integrityResults.some((row) => row.integrity_check !== 'ok')) {
            throw new Error('SQLite integrity verification failed.');
        }

        const tableRows = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const tableNames = tableRows.map((row) => row.name);
        const missingTables = REQUIRED_TABLES.filter((name) => !tableNames.includes(name));
        if (missingTables.length) throw new Error('Source does not contain the required CRM SQLite tables.');

        const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
        const schemaHash = crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
        const rowCounts = {};
        for (const tableName of tableNames) {
            const table = quoteIdentifier(tableName);
            rowCounts[tableName] = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
        }
        const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
        if (foreignKeyViolations) throw new Error('SQLite foreign-key verification failed.');

        return { schemaHash, rowCounts, tableCount: tableNames.length, foreignKeyViolations };
    } finally {
        database.close();
    }
}

function protectFile(filePath) {
    if (process.platform === 'win32') {
        const account = execFileSync('whoami', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
        if (!account) throw new Error('Unable to determine the current Windows account for backup permissions.');
        execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${account}:(F)`], { stdio: 'ignore', windowsHide: true });
        return 'owner-only-acl';
    }

    fs.chmodSync(filePath, 0o600);
    const permissions = fs.statSync(filePath).mode & 0o777;
    if (permissions !== 0o600) throw new Error('Unable to restrict database file permissions.');
    return 'owner-only-mode';
}

function resolvePaths(sourceArgument, destinationArgument) {
    if (!sourceArgument || !destinationArgument) {
        throw new Error('Both --source and --destination are required.');
    }
    const sourcePath = path.resolve(sourceArgument);
    const destinationPath = path.resolve(destinationArgument);
    if (sourcePath === destinationPath) throw new Error('Source and destination must be different files.');
    if (!fs.statSync(sourcePath).isFile()) throw new Error('Source must be a regular SQLite database file.');
    if (fs.existsSync(destinationPath)) throw new Error('Destination already exists; refusing to overwrite it.');
    if (!fs.statSync(path.dirname(destinationPath)).isDirectory()) throw new Error('Destination directory must already exist.');
    if (fs.realpathSync(sourcePath) === path.join(fs.realpathSync(path.dirname(destinationPath)), path.basename(destinationPath))) {
        throw new Error('Source and destination must resolve to different files.');
    }
    return { sourcePath, destinationPath };
}

function createVerifiedCopy(sourcePath, destinationPath) {
    const source = path.resolve(sourcePath);
    const destination = path.resolve(destinationPath);
    const paths = resolvePaths(source, destination);
    const sourceReport = inspectDatabase(paths.sourcePath);
    const database = new DatabaseSync(paths.sourcePath, { readOnly: true });
    try {
        database.exec(`VACUUM INTO ${quoteSqlString(paths.destinationPath)}`);
    } finally {
        database.close();
    }

    const permissions = protectFile(paths.destinationPath);
    const destinationReport = inspectDatabase(paths.destinationPath);
    const sameSchema = sourceReport.schemaHash === destinationReport.schemaHash;
    const sameRows = JSON.stringify(sourceReport.rowCounts) === JSON.stringify(destinationReport.rowCounts);
    if (!sameSchema || !sameRows || destinationReport.foreignKeyViolations !== 0) {
        throw new Error('Copied database did not match the source verification results.');
    }
    return {
        integrity: 'ok',
        tableCount: destinationReport.tableCount,
        tableCountsMatch: true,
        foreignKeyViolations: destinationReport.foreignKeyViolations,
        permissions
    };
}

function parseArguments(argv) {
    const [operation, ...argumentsList] = argv;
    if (!['backup', 'restore'].includes(operation)) {
        throw new Error('Usage: node database/backup-restore.js <backup|restore> --source <sqlite-file> --destination <new-sqlite-file>.');
    }
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (argument === '--source' && argumentsList[index + 1]) options.source = argumentsList[++index];
        else if (argument === '--destination' && argumentsList[index + 1]) options.destination = argumentsList[++index];
        else throw new Error('Usage: node database/backup-restore.js <backup|restore> --source <sqlite-file> --destination <new-sqlite-file>.');
    }
    if (!options.source || !options.destination) throw new Error('Both --source and --destination are required.');
    return { operation, ...options };
}

function main(argv = process.argv.slice(2)) {
    const databaseConfig = require('./config');
    if (databaseConfig.mode !== 'sqlite') throw new Error('The CRM currently supports SQLite backups only; no database was changed.');
    const { operation, source, destination } = parseArguments(argv);
    const result = createVerifiedCopy(source, destination);
    console.log(JSON.stringify({ result: 'PASS', operation, ...result, credentialsOrRowsPrinted: false }));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(JSON.stringify({ result: 'FAIL', error: error.message, credentialsOrRowsPrinted: false }));
        process.exitCode = 1;
    }
}

module.exports = { createVerifiedCopy, inspectDatabase, parseArguments };
