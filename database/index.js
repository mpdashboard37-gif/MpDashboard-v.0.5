const config = require('./config');
const { SqliteAdapter } = require('./sqlite-adapter');
const { PostgresAdapter } = require('./postgres-adapter');

function createDatabase() {
    return config.mode === 'postgresql'
        ? new PostgresAdapter(config.postgresUrl, config.postgresSsl)
        : new SqliteAdapter(config.sqlitePath);
}

module.exports = { config, createDatabase, SqliteAdapter, PostgresAdapter };
