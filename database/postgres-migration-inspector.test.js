const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const migrationScript = path.join(__dirname, '..', 'migrate-sqlite-to-postgres.js');

test('dry-run inspects an isolated SQLite fixture read-only and prints counts only', (context) => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-postgres-dry-run-'));
    context.after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
    const fixturePath = path.join(fixtureDirectory, 'fixture.sqlite');
    const fixture = new DatabaseSync(fixturePath);
    fixture.exec('CREATE TABLE synthetic_fixture (id TEXT PRIMARY KEY, label TEXT NOT NULL); INSERT INTO synthetic_fixture VALUES (\'fixture-id\', \'synthetic-only\');');
    fixture.close();
    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');

    const result = spawnSync(process.execPath, [migrationScript, '--dry-run', '--sqlite', fixturePath], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'read-only-dry-run');
    assert.equal(report.destinationConnected, false);
    assert.equal(report.writesPerformed, false);
    assert.deepEqual(report.tables, [{
        table: 'synthetic_fixture',
        columns: 2,
        primaryKeyColumns: ['id'],
        uniqueIndexes: 1,
        foreignKeys: 0,
        rows: 1
    }]);
    assert.equal(result.stdout.includes('synthetic-only'), false);
    const finalHash = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
    assert.equal(finalHash, originalHash);
});

test('refuses migration write mode without opening any database', () => {
    const result = spawnSync(process.execPath, [migrationScript], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only --dry-run is available/);
    assert.equal(result.stdout, '');
});
