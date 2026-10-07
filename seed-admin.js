require('dotenv').config();

const crypto = require('node:crypto');

const ADMIN_ID = 'staff-admin';
const DEFAULT_LOGIN = 'varunkv@inpacepower.com';

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${derivedKey}`;
}

function usage() {
    console.error('Usage: node seed-admin.js "Name" email password   (password: 8+ characters)');
    process.exit(1);
}

async function seedSqlite({ name, email, password }) {
    const { DatabaseSync } = require('node:sqlite');
    const path = require('node:path');
    const db = new DatabaseSync(path.join(__dirname, 'crm.sqlite'));
    const hash = hashPassword(password);
    const now = new Date().toISOString();

    try {
        const existing = db.prepare('SELECT id FROM staff WHERE id = ? OR lower(login_id) = lower(?) OR lower(COALESCE(email, \'\')) = lower(?) LIMIT 1').get(ADMIN_ID, email, email);
        if (existing) {
            db.prepare(`
                UPDATE staff
                SET name = ?, email = ?, login_id = ?, password_hash = ?, role = 'Admin/Owner',
                    status = 'Active', account_status = 'ACTIVE', failed_login_attempts = 0,
                    blocked_until = NULL, locked_until = NULL, deactivated_at = NULL,
                    deactivation_reason = NULL
                WHERE id = ?
            `).run(name, email, email, hash, existing.id);
            console.log('Admin updated:', { id: existing.id, email, role: 'Admin/Owner' });
            return;
        }

        db.prepare(`
            INSERT INTO staff (
                id, employee_id, name, email, department, designation, login_id,
                password_hash, role, status, account_status, failed_login_attempts, created_at
            ) VALUES (?, ?, ?, ?, 'Administration', 'Owner', ?, ?, 'Admin/Owner', 'Active', 'ACTIVE', 0, ?)
        `).run(ADMIN_ID, 'EMP-001', name, email, email, hash, now);
        console.log('Admin ready:', { id: ADMIN_ID, email, role: 'Admin/Owner' });
    } finally {
        db.close();
    }
}

async function seedPostgres({ name, email, password }) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
    const hash = hashPassword(password);

    try {
        const result = await pool.query(`
            INSERT INTO staff (
                id, employee_id, name, email, department, designation, login_id,
                password_hash, role, status, account_status, failed_login_attempts
            ) VALUES ($1, 'EMP-001', $2, LOWER($3), 'Administration', 'Owner', LOWER($3), $4, 'Admin/Owner', 'Active', 'ACTIVE', 0)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                email = EXCLUDED.email,
                login_id = EXCLUDED.login_id,
                password_hash = EXCLUDED.password_hash,
                role = 'Admin/Owner',
                status = 'Active',
                account_status = 'ACTIVE',
                failed_login_attempts = 0,
                blocked_until = NULL,
                deactivated_at = NULL,
                deactivation_reason = NULL
            RETURNING id, email, role
        `, [ADMIN_ID, name, email, hash]);
        console.log('Admin ready:', result.rows[0]);
    } finally {
        await pool.end();
    }
}

(async () => {
    const [name, email, password] = process.argv.slice(2);
    if (!name || !email || !password || password.length < 8) usage();

    const details = { name: name.trim(), email: email.trim().toLowerCase(), password };
    if (!details.name || !details.email.includes('@')) usage();

    if (String(process.env.DATABASE_URL || '').trim()) {
        await seedPostgres(details);
    } else {
        await seedSqlite(details);
    }
})().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
