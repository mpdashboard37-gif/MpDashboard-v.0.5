const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;

function parseArguments(argumentsList) {
    const options = { dryRun: false, sqlitePath: path.join(ROOT, 'crm.sqlite') };
    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (argument === '--dry-run') {
            options.dryRun = true;
        } else if (argument === '--sqlite' && argumentsList[index + 1]) {
            options.sqlitePath = path.resolve(argumentsList[++index]);
        } else {
            const error = new Error('Usage: node migrate-sqlite-to-postgres.js --dry-run [--sqlite <path>].');
            error.publicMessage = error.message;
            throw error;
        }
    }
    if (!options.dryRun) {
        const error = new Error('Only --dry-run is available. PostgreSQL writes are disabled until the full schema and asynchronous CRM route migration are implemented and reviewed.');
        error.publicMessage = error.message;
        throw error;
    }
    return options;
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function inspectSource(sqlitePath) {
    const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        return tables.map(({ name }) => {
            const identifier = quoteIdentifier(name);
            const columns = sqlite.prepare(`PRAGMA table_info(${identifier})`).all();
            const uniqueIndexes = sqlite.prepare(`PRAGMA index_list(${identifier})`).all().filter((index) => index.unique);
            const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list(${identifier})`).all();
            const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${identifier}`).get();
            return {
                table: name,
                columns: columns.length,
                primaryKeyColumns: columns.filter((column) => column.pk).map((column) => column.name),
                uniqueIndexes: uniqueIndexes.length,
                foreignKeys: foreignKeys.length,
                rows: Number(row.count)
            };
        });
    } finally {
        sqlite.close();
    }
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const tables = inspectSource(options.sqlitePath);
    const totalRows = tables.reduce((sum, table) => sum + table.rows, 0);
    console.log(JSON.stringify({
        mode: 'read-only-dry-run',
        source: 'SQLite schema and row counts only; no row values were read.',
        tableCount: tables.length,
        totalRows,
        tables,
        writesPerformed: false,
        destinationConnected: false
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error.publicMessage || `SQLite migration inspection stopped: ${error.code || error.name || 'unknown error'}`);
    process.exitCode = 1;
}
