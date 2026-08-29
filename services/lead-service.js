class LeadService {
    constructor(repository, canAccessLead) {
        this.repository = repository;
        this.canAccessLead = canAccessLead;
    }

    normalize(bundle) {
        const { row, owner, followUps, communications, activities, survey, documents, files, stageHistory } = bundle;
        let details = {};
        try { details = row.details_json ? JSON.parse(row.details_json) : {}; } catch (error) { details = {}; }
        return {
            leadId: row.id,
            leadNumber: row.lead_number || null,
            customerName: row.customer_name,
            mobileNumber: row.mobile_number,
            email: row.email,
            leadDate: row.lead_date,
            leadSource: row.lead_source,
            assignedTo: row.assigned_to,
            assignedEmployee: owner?.name || null,
            owner: owner ? { id: owner.id, name: owner.name, designation: owner.designation, role: owner.role, status: owner.status } : null,
            leadStage: row.stage,
            leadStatus: row.status,
            leadPriority: row.priority,
            location: row.location,
            createdBy: row.created_by,
            createdDate: row.created_at,
            updatedDate: row.updated_at,
            details,
            stageRequirements: [],
            followUps,
            communications,
            activities,
            survey,
            siteSurvey: survey,
            documents,
            files,
            communication: communications,
            stageHistory
        };
    }

    async list(user) {
        const rows = await this.repository.listRows();
        const visible = [];
        for (const row of rows) {
            if (await this.canAccessLead(user, row)) visible.push(this.normalize(await this.repository.getBundle(row.id)));
        }
        return visible;
    }

    async get(user, leadId) {
        const bundle = await this.repository.getBundle(leadId);
        if (!bundle) return null;
        if (!(await this.canAccessLead(user, bundle.row))) return { forbidden: true };
        return this.normalize(bundle);
    }

    async create(user, body, dependencies) {
        const required = ['customerName', 'mobileNumber', 'leadDate', 'leadSource', 'assignedTo'];
        const missing = required.filter((field) => !String(body[field] || '').trim());
        if (missing.length) return { error: 'Required fields are missing.', fields: missing, status: 422 };
        const duplicate = await this.repository.findDuplicate(body.mobileNumber.trim(), body.email || '');
        if (duplicate) return { error: 'A lead with this mobile number already exists.', existingLeadId: duplicate.id, status: 409 };
        const assignedEmployee = await this.repository.findActiveAssignee(body.assignedTo);
        if (!assignedEmployee) return { error: 'Please assign this lead to an active employee.', status: 422 };
        let id;
        do { id = `INP-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`; } while (await this.repository.findLeadId(id));
        const nextLeadNumber = (await this.repository.nextLeadNumber()).nextNumber;
        if (nextLeadNumber > 999999) return { error: 'Lead number capacity has been reached.', status: 422 };
        const timestamp = dependencies.now();
        const details = { alternateNumber: body.alternateNumber || '', address: body.address || '', city: body.city || '', pincode: body.pincode || '', leadType: body.leadType || '', initialRequirement: body.initialRequirement || '', remarks: body.remarks || '', electricityBill: body.electricityBill || '', monthlyUnits: body.monthlyUnits || '', sanctionedLoad: body.sanctionedLoad || '', requiredSolarCapacity: body.requiredSolarCapacity || '', batteryRequirement: body.batteryRequirement || '', roofType: body.roofType || '', otherInitialRequirements: body.otherInitialRequirements || '' };
        const lead = { id, leadNumber: String(nextLeadNumber).padStart(6, '0'), customerName: body.customerName.trim(), mobileNumber: body.mobileNumber.trim(), email: body.email || null, leadDate: body.leadDate, leadSource: body.leadSource, assignedTo: assignedEmployee.id, priority: body.leadPriority || 'Warm', location: details.city || body.location || null, createdBy: user.id, timestamp, activityId: dependencies.randomUUID(), notificationId: dependencies.randomUUID() };
        try {
            await this.repository.database.transaction((tx) => this.repository.createLead(tx, lead, details));
        } catch (error) {
            return { error: 'Unable to create lead. Please try again.', status: 500 };
        }
        return { lead: await this.get(user, id), status: 201 };
    }

    async update(user, lead, body, dependencies) {
        if (!String(body.customerName || '').trim() || !String(body.mobileNumber || '').trim()) return { error: 'Customer Name and Mobile Number are mandatory.', fields: ['customerName', 'mobileNumber'], status: 422 };
        const duplicate = await this.repository.findDuplicateMobile(body.mobileNumber.trim(), lead.id);
        if (duplicate) return { error: 'This customer already exists in CRM.', existingLeadId: duplicate.id, status: 409 };
        if (body.stage) return { error: 'Stages can only change through Mark Complete after validation.', status: 422 };
        const basicFieldsOnly = ['Booking', 'Installation', 'Completed'].includes(lead.stage);
        const editableFields = basicFieldsOnly ? ['customerName', 'mobileNumber', 'email', 'location', 'details'] : ['customerName', 'mobileNumber', 'email', 'leadSource', 'stage', 'leadPriority', 'location', 'details'];
        const unexpectedFields = Object.keys(body).filter((field) => !editableFields.includes(field));
        if (unexpectedFields.length) return { error: basicFieldsOnly ? 'Only basic contact details can be edited after Booking.' : 'Lead ID and creation date cannot be changed.', fields: unexpectedFields, status: 422 };
        const timestamp = dependencies.now();
        let existingDetails = {};
        try { existingDetails = lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { existingDetails = {}; }
        const next = { ...lead, ...body, details: { ...existingDetails, ...(body.details || {}) } };
        try {
            await this.repository.database.transaction((tx) => this.repository.updateLead(tx, lead.id, next, timestamp, user.id, Object.keys(body)));
        } catch (error) { return { error: 'Unable to update lead. Please try again.', status: 500 }; }
        return { lead: await this.get(user, lead.id), status: 200 };
    }

    async assign(user, lead, employee, previousOwner, dependencies) {
        const timestamp = dependencies.now();
        try {
            await this.repository.database.transaction((tx) => this.repository.assignLead(tx, lead.id, employee.id, timestamp, { userId: user.id, action: previousOwner === 'Unassigned' ? 'Assigned' : 'Reassigned', activityId: dependencies.randomUUID(), details: { previousOwner, newOwner: employee.name, assignedBy: user.name, description: `Lead ${lead.lead_number} assigned to ${employee.name}.` } }, { id: dependencies.randomUUID(), type: previousOwner === 'Unassigned' ? 'LEAD_ASSIGNED' : 'LEAD_REASSIGNED', message: `New lead assigned: Lead #${lead.lead_number} - ${lead.customer_name}.` }));
        } catch (error) { return { error: 'Unable to assign Lead. Please try again.', status: 500 }; }
        return { lead: await this.get(user, lead.id), status: 200 };
    }
}

module.exports = { LeadService };
