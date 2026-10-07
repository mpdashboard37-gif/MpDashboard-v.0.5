const express = require('express');
const crypto = require('node:crypto');
const { OPPORTUNITY_STAGES, normalizeOpportunityStage } = require('./pipeline-stages');

const MANAGER_ROLES = ['Admin/Owner', 'Sales Manager', 'GM/AGM'];

function sqliteize(sql) {
    return sql.replace(/\$\d+/g, '?');
}

function dbRun(db, sql, params = []) {
    if (db.query) return db.query(sql, params);
    return db.prepare(sqliteize(sql)).run(...params);
}

function dbAll(db, sql, params = []) {
    if (db.query) return db.query(sql, params).then((result) => result.rows || []);
    return db.prepare(sqliteize(sql)).all(...params);
}

function dbGet(db, sql, params = []) {
    if (db.query) return db.query(sql, params).then((result) => (result.rows && result.rows[0]) || null);
    return db.prepare(sqliteize(sql)).get(...params) || null;
}

function isManager(user) {
    return !!user && MANAGER_ROLES.includes(user.role);
}

function createLeadIfNeeded(db, user, payload) {
    const name = String(payload.name || '').trim();
    const phone = String(payload.phone || '').trim();
    const city = String(payload.city || payload.location || '').trim();
    if (!name || !phone) return null;

    const existing = dbGet(db, 'SELECT * FROM leads WHERE mobile_number = ? LIMIT 1', [phone]);
    if (existing) return existing;

    const timestamp = new Date().toISOString();
    const leadId = `INP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nextLeadNumber = dbGet(db, "SELECT COALESCE(MAX(CAST(lead_number AS INTEGER)), 100000) + 1 AS nextNumber FROM leads WHERE lead_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'", [])?.nextNumber || 100001;

    dbRun(db, `
        INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?)
    `, [leadId, String(nextLeadNumber).padStart(6, '0'), name, phone, payload.email || null, timestamp.slice(0, 10), payload.source || 'Pipeline', payload.assigned_to || user.id, payload.priority || 'Warm', city || null, user.id, timestamp, timestamp]);

    return dbGet(db, 'SELECT * FROM leads WHERE id = ?', [leadId]);
}

module.exports = function createPipelineRouter(db) {
    const router = express.Router();

    const requireAuth = (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
        return next();
    };

    const wrap = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            console.error('pipeline-api error:', error);
            res.status(500).json({ error: error.message || 'Server error.' });
        }
    };

    router.use(['/opportunities', '/followups', '/follow-ups'], express.json(), requireAuth);

    router.get('/opportunities', wrap(async (req, res) => {
        const user = req.user;
        const stage = req.query.stage || null;
        const q = req.query.q ? String(req.query.q).trim() : null;
        const clauses = [];
        const params = [];

        if (!isManager(user)) {
            clauses.push('o.assigned_to = ?');
            params.push(user.id);
        }
        if (stage) {
            clauses.push('o.stage = ?');
            params.push(stage);
        }
        if (q) {
            clauses.push('(l.customer_name LIKE ? OR l.mobile_number LIKE ? OR o.id LIKE ?)');
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = await dbAll(db, `
            SELECT o.*, l.customer_name AS customer, l.mobile_number AS phone, s.name AS owner_name
            FROM opportunities o
            JOIN leads l ON l.id = o.lead_id
            LEFT JOIN staff s ON s.id = o.assigned_to
            ${where}
            ORDER BY o.updated_at DESC
            LIMIT 200
        `, params);
        res.json(rows);
    }));

    router.post('/opportunities', wrap(async (req, res) => {
        const user = req.user;
        const payload = req.body || {};
        const { lead_id, stage, customer_name, system_capacity, estimated_value, assigned_to, probability, notes } = payload;

        let lead = null;
        if (lead_id) {
            lead = dbGet(db, 'SELECT * FROM leads WHERE id = ?', [lead_id]);
        } else {
            lead = createLeadIfNeeded(db, user, payload);
        }

        if (!lead) return res.status(400).json({ error: 'lead_id or name+phone are required.' });
        if (!isManager(user) && String(lead.assigned_to || '') !== String(user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const existing = dbGet(db, 'SELECT id FROM opportunities WHERE lead_id = ? LIMIT 1', [lead.id]);
        if (existing) return res.status(409).json({ error: 'This lead already has an opportunity.' });

        const oppId = `OPP-${Date.now()}`;
        const stageValue = normalizeOpportunityStage(stage) || 'Qualified';
        const ownerId = assigned_to || lead.assigned_to || user.id;
        const value = Number(estimated_value ?? 0);
        const now = new Date().toISOString();

        dbRun(db, `
            INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, probability, stage, status, created_by, created_at, updated_at, notes, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?)
        `, [oppId, lead.id, customer_name || lead.customer_name, system_capacity || null, value, ownerId, Number(probability || 0), stageValue, user.id, now, now, notes || null, payload.source || 'CRM']);

        dbRun(db, `INSERT INTO lead_stage_history (id, lead_id, stage, started_at, remarks) VALUES (?, ?, ?, ?, ?)`, [crypto.randomUUID(), lead.id, stageValue, now, 'Opportunity created']);

        const saved = dbGet(db, 'SELECT * FROM opportunities WHERE id = ?', [oppId]);
        res.status(201).json(saved);
    }));

    router.get('/opportunities/:id', wrap(async (req, res) => {
        const user = req.user;
        const opp = dbGet(db, `
            SELECT o.*, l.customer_name AS customer, l.mobile_number AS phone, s.name AS owner_name
            FROM opportunities o
            JOIN leads l ON l.id = o.lead_id
            LEFT JOIN staff s ON s.id = o.assigned_to
            WHERE o.id = ?
        `, [req.params.id]);

        if (!opp) return res.status(404).json({ error: 'Opportunity not found.' });
        if (!isManager(user) && String(opp.assigned_to || '') !== String(user.id)) return res.status(403).json({ error: 'Forbidden' });

        const history = await dbAll(db, `
            SELECT h.*, u.name AS by_name
            FROM lead_stage_history h
            LEFT JOIN staff u ON u.id = h.completed_by
            WHERE h.lead_id = ?
            ORDER BY datetime(h.started_at)
        `, [opp.lead_id]);

        const followups = await dbAll(db, 'SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY datetime(due_at) DESC', [opp.lead_id]);
        res.json({ ...opp, history, followups });
    }));

    router.patch('/opportunities/:id/stage', wrap(async (req, res) => {
        const user = req.user;
        const { stage } = req.body || {};
        const normalizedStage = normalizeOpportunityStage(stage);
        if (!normalizedStage) return res.status(400).json({ error: 'Invalid stage.' });

        const current = dbGet(db, 'SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
        if (!current) return res.status(404).json({ error: 'Opportunity not found.' });
        if (!isManager(user) && String(current.assigned_to || '') !== String(user.id)) return res.status(403).json({ error: 'Forbidden' });

        const timestamp = new Date().toISOString();
        dbRun(db, 'UPDATE opportunities SET stage = ?, updated_at = ? WHERE id = ?', [normalizedStage, timestamp, req.params.id]);
        dbRun(db, 'INSERT INTO lead_stage_history (id, lead_id, stage, started_at, completed_at, completed_by, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), current.lead_id, normalizedStage, timestamp, timestamp, user.id, 'Pipeline stage updated']);
        res.json({ ok: true, stage: normalizedStage });
    }));

    router.patch('/opportunities/:id/owner', wrap(async (req, res) => {
        if (!isManager(req.user)) return res.status(403).json({ error: 'Forbidden' });
        const { owner_id } = req.body || {};
        if (!owner_id) return res.status(400).json({ error: 'owner_id is required.' });
        dbRun(db, 'UPDATE opportunities SET assigned_to = ?, updated_at = ? WHERE id = ?', [owner_id, new Date().toISOString(), req.params.id]);
        const updated = dbGet(db, 'SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
        res.json(updated);
    }));

    router.get(['/followups', '/follow-ups', '/followups/today', '/follow-ups/today'], wrap(async (req, res) => {
        const user = req.user;
        const range = ['today', 'overdue', 'upcoming'].includes(req.query.range) ? req.query.range : 'today';
        const clauses = ["f.status IN ('Pending', 'Scheduled', 'Overdue')"];
        const params = [];

        if (!isManager(user)) {
            clauses.push('f.assigned_to = ?');
            params.push(user.id);
        }

        if (range === 'today') {
            clauses.push("date(f.due_at) = date('now')");
        } else if (range === 'overdue') {
            clauses.push("datetime(f.due_at) < datetime('now')");
        } else {
            clauses.push("date(f.due_at) > date('now')");
        }

        const rows = await dbAll(db, `
            SELECT f.*, l.customer_name AS customer_name, l.mobile_number, s.name AS owner_name, o.stage
            FROM follow_ups f
            JOIN leads l ON l.id = f.lead_id
            LEFT JOIN staff s ON s.id = f.assigned_to
            LEFT JOIN opportunities o ON o.lead_id = l.id
            WHERE ${clauses.join(' AND ')}
            ORDER BY datetime(f.due_at) ASC
        `, params);

        res.json(rows);
    }));

    router.post('/opportunities/:id/followups', wrap(async (req, res) => {
        const user = req.user;
        const { due_at, type, note } = req.body || {};
        if (!due_at) return res.status(400).json({ error: 'due_at is required.' });

        const opp = dbGet(db, 'SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
        if (!opp) return res.status(404).json({ error: 'Opportunity not found.' });
        if (!isManager(user) && String(opp.assigned_to || '') !== String(user.id)) return res.status(403).json({ error: 'Forbidden' });

        const followId = crypto.randomUUID();
        const now = new Date().toISOString();
        dbRun(db, `
            INSERT INTO follow_ups (id, lead_id, opportunity_id, assigned_to, due_at, type, note, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
        `, [followId, opp.lead_id, opp.id, opp.assigned_to || user.id, due_at, type || 'Call', note || null, user.id, now]);

        const saved = dbGet(db, 'SELECT * FROM follow_ups WHERE id = ?', [followId]);
        res.status(201).json(saved);
    }));

    router.patch('/followups/:id/done', wrap(async (req, res) => {
        const user = req.user;
        const now = new Date().toISOString();
        const item = dbGet(db, 'SELECT * FROM follow_ups WHERE id = ? AND (assigned_to = ? OR ? = 1)', [req.params.id, user.id, isManager(user) ? 1 : 0]);
        if (!item) return res.status(404).json({ error: 'Follow-up not found.' });
        dbRun(db, `UPDATE follow_ups SET status = 'Completed', completed_at = ?, completed_by = ? WHERE id = ?`, [now, user.id, req.params.id]);
        res.json({ ok: true });
    }));

    return router;
};
