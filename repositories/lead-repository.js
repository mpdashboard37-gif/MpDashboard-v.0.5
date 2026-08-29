class LeadRepository {
    constructor(database) {
        this.database = database;
    }

    listRows() {
        return this.database.all('SELECT * FROM leads ORDER BY created_at DESC');
    }

    getRow(leadId) {
        return this.database.get('SELECT * FROM leads WHERE id = ?', [leadId]);
    }

    getOwner(assignedTo) {
        return assignedTo ? this.database.get('SELECT id, name, designation, role, status FROM staff WHERE id = ?', [assignedTo]) : null;
    }

    getFollowUps(leadId) {
        return this.database.all('SELECT f.id, f.lead_id AS leadId, f.type, f.due_at AS dueAt, f.assigned_to AS assignedTo, s.name AS assignedEmployee, f.status, f.task_status AS taskStatus, f.task_title AS taskTitle, f.notes, f.created_by AS createdBy, f.created_at AS createdAt, f.completed_at AS completedAt, f.completed_by AS completedBy, f.task_completed_at AS taskCompletedAt, f.task_completed_by AS taskCompletedBy, f.outcome, f.missed_reason AS missedReason FROM follow_ups f LEFT JOIN staff s ON s.id = f.assigned_to WHERE f.lead_id = ? ORDER BY datetime(f.due_at) DESC', [leadId]);
    }

    getCommunications(leadId) {
        return this.database.all('SELECT c.id, c.lead_id AS leadId, c.type, c.recipient, c.subject, c.message, c.status, c.created_by AS createdBy, s.name AS createdByName, c.created_at AS createdAt FROM lead_communications c LEFT JOIN staff s ON s.id = c.created_by WHERE c.lead_id = ? ORDER BY datetime(c.created_at) DESC', [leadId]);
    }

    getActivities(leadId) {
        return this.database.all('SELECT a.id, a.lead_id AS leadId, a.activity_type AS activityType, a.title, a.description, a.user_id AS userId, s.name AS userName, s.role AS userRole, a.related_record_type AS relatedRecordType, a.related_record_id AS relatedRecordId, a.previous_value AS previousValue, a.new_value AS newValue, a.created_at AS createdAt FROM lead_activities a LEFT JOIN staff s ON s.id = a.user_id WHERE a.lead_id = ? ORDER BY datetime(a.created_at) DESC', [leadId]);
    }

    getNotes(leadId) {
        return this.database.all('SELECT n.id, n.note, n.category, n.created_by AS createdBy, s.name AS createdByName, n.created_at AS createdAt FROM lead_notes n LEFT JOIN staff s ON s.id = n.created_by WHERE n.lead_id = ? ORDER BY datetime(n.created_at) DESC', [leadId]);
    }

    getSurvey(leadId) {
        return this.database.get('SELECT s.*, st.name AS assignedEngineer FROM surveys s LEFT JOIN staff st ON st.id = s.assigned_to WHERE s.lead_id = ?', [leadId]) || null;
    }

    getSurveyFiles(surveyId) {
        return this.database.all("SELECT id, category, file_name AS fileName, original_file_name AS originalFileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt, status, latitude, longitude FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(uploaded_at) DESC", [surveyId]);
    }

    getDocuments(leadId) {
        return this.database.all("SELECT id, document_type AS documentType, file_name AS fileName, original_file_name AS originalFileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, created_at AS createdAt, status FROM lead_documents WHERE lead_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(created_at) DESC", [leadId]);
    }

    getStageHistory(leadId) {
        return this.database.all('SELECT stage, started_at AS startedAt, completed_at AS completedAt, completed_by AS completedBy, duration_seconds AS durationSeconds, remarks FROM lead_stage_history WHERE lead_id = ? ORDER BY datetime(started_at)', [leadId]);
    }

    getCommercial(leadId) {
        return Promise.all([
            this.database.all('SELECT * FROM proposals WHERE lead_id = ? ORDER BY datetime(created_at) DESC', [leadId]),
            this.database.all('SELECT * FROM quotations WHERE lead_id = ? ORDER BY datetime(created_at) DESC', [leadId]),
            this.database.all('SELECT b.* FROM bookings b WHERE b.lead_id = ? ORDER BY datetime(b.created_at) DESC', [leadId]),
            this.database.all('SELECT pr.*, i.status AS installation_status, c.status AS commissioning_status FROM projects pr LEFT JOIN installations i ON i.project_id = pr.id LEFT JOIN commissioning c ON c.project_id = pr.id WHERE pr.lead_id = ?', [leadId]),
            this.database.all('SELECT py.* FROM payments py JOIN projects pr ON pr.id = py.project_id WHERE pr.lead_id = ? ORDER BY datetime(py.created_at) DESC', [leadId])
        ]).then(([proposals, quotations, bookings, projects, payments]) => ({ proposals, quotations, bookings, projects, payments }));
    }

    findDuplicate(mobileNumber, email) {
        return this.database.get('SELECT id FROM leads WHERE mobile_number = ? OR (email IS NOT NULL AND email <> ? AND email = ?)', [mobileNumber, '', email || '']);
    }

    findActiveAssignee(assignedTo) {
        return this.database.get("SELECT id FROM staff WHERE id = ? AND status = 'Active'", [assignedTo]);
    }

    findLeadId(id) {
        return this.database.get('SELECT id FROM leads WHERE id = ?', [id]);
    }

    nextLeadNumber() {
        return this.database.get("SELECT COALESCE(MAX(CAST(lead_number AS INTEGER)), 100000) + 1 AS nextNumber FROM leads WHERE lead_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'");
    }

    async createLead(tx, lead, details) {
        await tx.run('INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [lead.id, lead.leadNumber, lead.customerName, lead.mobileNumber, lead.email, lead.leadDate, lead.leadSource, lead.assignedTo, 'New', lead.priority, lead.location, lead.createdBy, lead.timestamp, lead.timestamp, JSON.stringify(details)]);
        await tx.run('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [lead.createdBy, 'Created', 'lead', lead.id, JSON.stringify({ stage: 'New', assignedTo: lead.assignedTo }), lead.timestamp]);
        await tx.run('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [lead.activityId, lead.id, 'Lead', 'Lead Created', 'Lead created through CRM.', lead.createdBy, 'lead', lead.id, lead.timestamp]);
        await tx.run('INSERT INTO notifications (id, user_id, type, message, record_type, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [lead.notificationId, lead.assignedTo, 'lead-assigned', `New lead ${lead.id} assigned to you.`, 'lead', lead.id, lead.timestamp]);
    }

    findDuplicateMobile(mobileNumber, leadId) {
        return this.database.get('SELECT id FROM leads WHERE mobile_number = ? AND id <> ?', [mobileNumber, leadId]);
    }

    async updateLead(tx, leadId, next, timestamp, userId, changedFields) {
        await tx.run('UPDATE leads SET customer_name = ?, mobile_number = ?, email = ?, lead_source = ?, assigned_to = ?, stage = ?, priority = ?, location = ?, details_json = ?, updated_at = ? WHERE id = ?', [next.customerName || next.customer_name, next.mobileNumber || next.mobile_number, next.email || null, next.leadSource || next.lead_source, next.assignedTo || next.assigned_to, next.stage, next.leadPriority || next.priority, next.location || null, JSON.stringify(next.details || {}), timestamp, leadId]);
        await tx.run('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, 'Updated', 'lead', leadId, JSON.stringify({ changedFields }), timestamp]);
    }

    async assignLead(tx, leadId, employeeId, timestamp, auditDetails, notification) {
        const update = await tx.run('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?', [employeeId, timestamp, leadId]);
        const saved = await tx.get('SELECT assigned_to FROM leads WHERE id = ?', [leadId]);
        if (update.changes !== 1 || saved?.assigned_to !== employeeId) throw new Error('Lead assignment verification failed.');
        await tx.run('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [auditDetails.userId, auditDetails.action, 'lead', leadId, JSON.stringify(auditDetails.details), timestamp]);
        await tx.run('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [auditDetails.activityId, leadId, 'Lead', auditDetails.action, auditDetails.details.description, auditDetails.userId, 'lead', leadId, timestamp]);
        await tx.run('INSERT INTO notifications (id, user_id, type, message, record_type, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [notification.id, employeeId, notification.type, notification.message, 'lead', leadId, timestamp]);
    }

    async getBundle(leadId) {
        const row = await this.getRow(leadId);
        if (!row) return null;
        const [owner, followUps, communications, activities, notes, survey, documents, stageHistory, commercial] = await Promise.all([
            this.getOwner(row.assigned_to),
            this.getFollowUps(leadId),
            this.getCommunications(leadId),
            this.getActivities(leadId),
            this.getNotes(leadId),
            this.getSurvey(leadId),
            this.getDocuments(leadId),
            this.getStageHistory(leadId),
            this.getCommercial(leadId)
        ]);
        const surveyFiles = survey ? await this.getSurveyFiles(survey.id) : [];
        if (survey) survey.files = surveyFiles;
        const files = [...documents.map((file) => ({ ...file, category: file.documentType, uploadedAt: file.createdAt, relatedType: 'lead' })), ...surveyFiles.map((file) => ({ ...file, relatedType: 'survey' }))];
        return { row, owner, followUps, communications, activities, notes, survey, surveyFiles, documents, files, stageHistory, commercial };
    }
}

module.exports = { LeadRepository };
