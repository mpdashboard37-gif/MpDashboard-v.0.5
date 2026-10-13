const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteAdapter } = require('./sqlite-adapter');

const configPath = require.resolve('./config');
const environmentKeys = [
    'DATABASE_MODE',
    'DATABASE_URL',
    'DATABASE_SSL',
    'SQLITE_DB_PATH',
    'NODE_ENV',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME'
];

function loadConfig(sqlitePath = '') {
    const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    try {
        environmentKeys.forEach((key) => { delete process.env[key]; });
        Object.assign(process.env, {
            DATABASE_MODE: 'sqlite',
            DATABASE_URL: '',
            SQLITE_DB_PATH: sqlitePath
        });
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

test('uses the existing default SQLite database path when SQLITE_DB_PATH is unset', () => {
    const config = loadConfig();
    assert.equal(config.mode, 'sqlite');
    assert.equal(config.sqlitePath, path.join(__dirname, '..', 'crm.sqlite'));
});

test('resolves SQLITE_DB_PATH to an absolute path', (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-staging-path-'));
    context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const customPath = path.join(tempDirectory, 'staging.sqlite');

    const config = loadConfig(customPath);

    assert.equal(config.mode, 'sqlite');
    assert.equal(config.sqlitePath, path.resolve(customPath));
});

test('opens a disposable SQLite database at SQLITE_DB_PATH and creates its parent directory', (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-staging-path-'));
    context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const customPath = path.join(tempDirectory, 'nested', 'staging.sqlite');
    const config = loadConfig(customPath);

    assert.equal(fs.existsSync(path.dirname(customPath)), false);

    const database = new SqliteAdapter(config.sqlitePath);
    try {
        assert.equal(fs.existsSync(path.dirname(customPath)), true);
        assert.equal(database.prepare('SELECT 1 AS ready').get().ready, 1);
    } finally {
        database.close();
    }
});
