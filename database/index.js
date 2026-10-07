const config = require('./config');
const { SqliteAdapter } = require('./sqlite-adapter');
const { PostgresAdapter } = require('./postgres-adapter');
const { MySqlAdapter } = require('./mysql-adapter');

function createDatabase() {
    if (config.mode === 'mysql') return new MySqlAdapter(config.mysql);
    if (config.mode === 'postgresql') return new PostgresAdapter(config.postgresUrl, config.postgresSsl);
    return new SqliteAdapter(config.sqlitePath);
}

module.exports = { config, createDatabase, SqliteAdapter, PostgresAdapter, MySqlAdapter };
