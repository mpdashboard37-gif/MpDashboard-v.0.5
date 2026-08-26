const assert = require('node:assert/strict');
const { createDatabase, config } = require('./index');

async function main() {
    assert.equal(config.mode, 'sqlite', 'Run this check with DATABASE_URL unset.');
    const database = createDatabase();
    try {
        assert.equal((await database.get('SELECT 1 AS value')).value, 1);
        const rows = await database.all('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', ['table']);
        assert.ok(rows.some((row) => row.name === 'leads'));
        const result = await database.transaction(async (transaction) => {
            await transaction.run('CREATE TEMP TABLE IF NOT EXISTS adapter_check (value TEXT)');
            await transaction.run('INSERT INTO adapter_check (value) VALUES (?)', ['ok']);
            return transaction.get('SELECT value FROM adapter_check LIMIT 1');
        });
        assert.equal(result.value, 'ok');
        console.log('SQLite adapter check passed.');
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(`Database adapter check failed: ${error.message}`);
    process.exitCode = 1;
});
