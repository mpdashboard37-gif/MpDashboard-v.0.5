const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteAdapter } = require('./sqlite-adapter');

const configPath = require.resolve('./config');
const environmentKeys = ['DATABASE_MODE', 'DATABASE_URL', 'DATABASE_SSL', 'SQLITE_DB_PATH', 'NODE_ENV', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

function loadConfig(environment) {
    const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    try {
        environmentKeys.forEach((key) => { delete process.env[key]; });
        Object.assign(process.env, environment);
        delete require.cache[configPath];
        return require('./config');
    } finally {
        environmentKeys.forEach((key) => {
            if (previous.get(key) === undefined) delete process.env[key];
            else process.env[key] = previous.get(key);
        });
        delete require.cache[configPath];
    }
}

test('requires a PostgreSQL URL when PostgreSQL mode is selected', () => {
    assert.throws(
        () => loadConfig({ DATABASE_MODE: 'postgresql' }),
        /DATABASE_URL is required when DATABASE_MODE=postgresql/
    );
});

test('validates PostgreSQL URL scheme without including its value in errors', () => {
    const url = 'https://sensitive.invalid/not-a-database';
    assert.throws(
        () => loadConfig({ DATABASE_MODE: 'postgresql', DATABASE_URL: url }),
        (error) => error.message.includes('postgres://') && !error.message.includes(url)
    );
});

test('enables verified TLS by default for PostgreSQL', () => {
    const config = loadConfig({ DATABASE_MODE: 'postgresql', DATABASE_URL: 'postgresql://db.example.invalid/crm' });
    assert.equal(config.postgresSsl, true);
    assert.equal(config.postgresUrl.startsWith('postgresql://'), true);
});

test('rejects disabled PostgreSQL TLS in production', () => {
    assert.throws(
        () => loadConfig({ DATABASE_MODE: 'postgresql', DATABASE_URL: 'postgresql://db.example.invalid/crm', DATABASE_SSL: 'false', NODE_ENV: 'production' }),
        /DATABASE_SSL must be enabled for PostgreSQL in production/
    );
});

test('preserves the default SQLite database path when SQLITE_DB_PATH is absent', () => {
    const config = loadConfig({ DATABASE_MODE: 'sqlite' });
    assert.equal(config.mode, 'sqlite');
    assert.equal(config.sqlitePath, path.join(__dirname, '..', 'crm.sqlite'));
});

test('resolves SQLITE_DB_PATH and creates its parent before opening SQLite', (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sqlite-path-test-'));
    context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const customPath = path.join(tempDirectory, 'nested', 'staging.sqlite');
    const relativeCustomPath = path.relative(process.cwd(), customPath);
    const config = loadConfig({ DATABASE_MODE: 'sqlite', SQLITE_DB_PATH: relativeCustomPath });

    assert.equal(config.mode, 'sqlite');
    assert.equal(config.sqlitePath, path.resolve(customPath));
    assert.equal(fs.existsSync(path.dirname(customPath)), false);

    const database = new SqliteAdapter(config.sqlitePath);
    try {
        assert.equal(fs.existsSync(path.dirname(customPath)), true);
        assert.equal(database.prepare('SELECT 1 AS ready').get().ready, 1);
    } finally {
        database.close();
    }
});

test('requires explicit existing production SQLite and upload paths', () => {
    const { assertProductionStorage } = loadConfig({ DATABASE_MODE: 'sqlite' });
    assert.throws(() => assertProductionStorage({
        NODE_ENV: 'production',
        DATABASE_MODE: 'sqlite'
    }), /explicit SQLITE_DB_PATH and CRM_FILE_STORAGE_ROOT/);
});

test('rejects a missing, empty, corrupt, or uninitialized production SQLite database', (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-production-storage-test-'));
    context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const { assertProductionStorage } = loadConfig({ DATABASE_MODE: 'sqlite' });
    const fileStorageRoot = path.join(tempDirectory, 'crm-files');
    fs.mkdirSync(fileStorageRoot);
    const databasePath = path.join(tempDirectory, 'crm.sqlite');
    const environment = { NODE_ENV: 'production', DATABASE_MODE: 'sqlite', SQLITE_DB_PATH: databasePath, CRM_FILE_STORAGE_ROOT: fileStorageRoot };

    assert.throws(() => assertProductionStorage(environment), /must already exist/);

    fs.writeFileSync(databasePath, '');
    assert.throws(() => assertProductionStorage(environment), /existing database file/);

    fs.writeFileSync(databasePath, 'not a SQLite database');
    assert.throws(() => assertProductionStorage(environment));
});

test('accepts a valid synthetic production SQLite database read-only', (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-production-storage-test-'));
    context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const { assertProductionStorage } = loadConfig({ DATABASE_MODE: 'sqlite' });
    const fileStorageRoot = path.join(tempDirectory, 'crm-files');
    fs.mkdirSync(fileStorageRoot);
    const databasePath = path.join(tempDirectory, 'crm.sqlite');
    const fixture = new DatabaseSync(databasePath);
    fixture.exec(`
        CREATE TABLE staff (id TEXT PRIMARY KEY);
        CREATE TABLE leads (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY);
        CREATE TABLE lead_documents (id TEXT PRIMARY KEY);
        CREATE TABLE survey_files (id TEXT PRIMARY KEY);
    `);
    fixture.close();
    const databaseBytesBefore = fs.readFileSync(databasePath);

    assert.equal(assertProductionStorage({
        NODE_ENV: 'production',
        DATABASE_MODE: 'sqlite',
        SQLITE_DB_PATH: databasePath,
        CRM_FILE_STORAGE_ROOT: fileStorageRoot
    }), true);
    assert.deepEqual(fs.readFileSync(databasePath), databaseBytesBefore);
    assert.throws(() => assertProductionStorage({
        NODE_ENV: 'production',
        DATABASE_MODE: 'sqlite',
        SQLITE_DB_PATH: databasePath,
        CRM_FILE_STORAGE_ROOT: path.join(tempDirectory, 'missing-files')
    }), /must already exist/);
});
