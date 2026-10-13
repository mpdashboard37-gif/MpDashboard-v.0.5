const test = require('node:test');
const assert = require('node:assert/strict');
const { postgresPlaceholders } = require('./postgres-adapter');

test('converts positional placeholders outside SQL strings and comments', () => {
    const input = "SELECT ?, '?', \"?\", $$?$$, $tag$?$tag$ -- ?\n/* ? */ WHERE id = ?";
    const result = postgresPlaceholders(input);

    assert.equal(result.sql, "SELECT $1, '?', \"?\", $$?$$, $tag$?$tag$ -- ?\n/* ? */ WHERE id = $2");
    assert.equal(result.count, 2);
});

test('preserves escaped SQL quotes while converting placeholders', () => {
    const result = postgresPlaceholders("SELECT 'it''s ?', ? FROM \"quoted?table\"");

    assert.equal(result.sql, "SELECT 'it''s ?', $1 FROM \"quoted?table\"");
    assert.equal(result.count, 1);
});

test('reports a parameter-count mismatch before querying PostgreSQL', async () => {
    const adapter = Object.create(require('./postgres-adapter').PostgresAdapter.prototype);
    adapter.pool = { query: () => assert.fail('query must not run after a placeholder mismatch') };

    await assert.rejects(adapter.query('SELECT ?', []), /expected 1, received 0/);
});
