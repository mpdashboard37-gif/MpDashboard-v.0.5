const { normalizeIndianMobileNumber } = require('./mobile-number');
const { isValidLeadNumber, publicLeadNumber } = require('./lead-number');

function publicLeadNumberText(value) {
    return typeof value === 'string' ? value.replace(/\bINP-[0-9]+\b/g, (number) => publicLeadNumber(number) || 'Lead Number unavailable') : value;
}

class LeadService {
    constructor(repository, canAccessLead) {
        this.repository = repository;
        this.canAccessLead = canAccessLead;
    }

    normalize(bundle) {
        const { row, owner, followUps, communications, activities, notes, survey, documents, files, stageHistory, commercial } = bundle;
        let details = {};
        try { details = row.details_json ? JSON.parse(row.details_json) : {}; } catch (error) { details = {}; }
        const score = Number(row.lead_score || 0);
        const publicActivities = activities.map((activity) => ({ ...activity, title: publicLeadNumberText(activity.title), description: publicLeadNumberText(activity.description), previousValue: publicLeadNumberText(activity.previousValue), newValue: publicLeadNumberText(activity.newValue) }));
        return {
            leadId: row.id,
            leadNumber: publicLeadNumber(row.lead_number),
            leadNumberStatus: publicLeadNumber(row.lead_number) ? 'VALID' : 'NEEDS_REVIEW',
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
            leadScore: score,
            leadCategory: row.lead_category || (score >= 70 ? 'Hot' : score >= 50 ? 'Warm' : score >= 30 ? 'Cold' : 'Low'),
            hotDealPercentage: score,
            stageRequirements: [],
            followUps,
            communications,
            activities: publicActivities,
            notes,
            survey,
            siteSurvey: survey,
            documents,
            files,
            communication: communications,
            stageHistory,
            commercial
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
        const normalizedMobile = normalizeIndianMobileNumber(body.mobileNumber);
        if (!normalizedMobile) return { error: 'Enter a valid 10-digit Indian mobile number.', fields: ['mobileNumber'], status: 422 };
        const duplicate = await this.repository.findDuplicateMobile(normalizedMobile, '');
        if (duplicate) return { error: 'A lead with this mobile number already exists.', code: 'DUPLICATE_MOBILE', message: 'A lead with this mobile number already exists.', existingLead: duplicate, status: 409 };
        const duplicateEmail = await this.repository.findDuplicateEmail(String(body.email || '').trim());
        if (duplicateEmail) return { error: 'A lead with this email already exists.', status: 409 };
        const assignedEmployee = await this.repository.findActiveAssignee(body.assignedTo);
        if (!assignedEmployee) return { error: 'Please assign this lead to an active employee.', status: 422 };
        let id;
        do { id = `INP-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`; } while (await this.repository.findLeadId(id));
        const timestamp = dependencies.now();
        const details = { alternateNumber: body.alternateNumber || '', address: body.address || '', city: body.city || '', pincode: body.pincode || '', leadType: body.leadType || '', initialRequirement: body.initialRequirement || '', remarks: body.remarks || '', electricityBill: body.electricityBill || '', monthlyUnits: body.monthlyUnits || '', sanctionedLoad: body.sanctionedLoad || '', requiredSolarCapacity: body.requiredSolarCapacity || '', batteryRequirement: body.batteryRequirement || '', roofType: body.roofType || '', otherInitialRequirements: body.otherInitialRequirements || '' };
        const lead = { id, customerName: body.customerName.trim(), mobileNumber: body.mobileNumber.trim(), email: body.email || null, leadDate: body.leadDate, leadSource: body.leadSource, assignedTo: assignedEmployee.id, priority: body.leadPriority || 'Warm', location: details.city || body.location || null, createdBy: user.id, timestamp, activityId: dependencies.randomUUID(), notificationId: dependencies.randomUUID() };
        let created = false;
        for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
            try {
                await this.repository.database.transaction(async (tx) => {
                    const nextLeadNumber = (await this.repository.nextLeadNumber(tx)).nextNumber;
                    if (!isValidLeadNumber(nextLeadNumber)) {
                        const error = new Error('Lead number capacity has been reached.');
                        error.code = 'LEAD_NUMBER_CAPACITY';
                        throw error;
                    }
                    lead.leadNumber = nextLeadNumber;
                    await this.repository.createLead(tx, lead, details);
                });
                created = true;
            } catch (error) {
                if (error.code === 'LEAD_NUMBER_CAPACITY') return { error: error.message, status: 422 };
                const duplicateNumber = error.code === 'ER_DUP_ENTRY' || error.code === '23505' || /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(String(error.message || ''));
                if (!duplicateNumber || attempt === 4) return { error: 'Unable to create lead. Please try again.', status: 500 };
            }
        }
        return { lead: await this.get(user, id), status: 201 };
    }

    async update(user, lead, body, dependencies) {
        const payload = { ...(body || {}) };
        const detailsPatch = payload.details && typeof payload.details === 'object' ? { ...payload.details } : {};
        const topLevelDetailKeys = ['alternateNumber', 'alternatePhone', 'contactPersonName', 'whatsappNumber', 'customerType', 'company', 'country', 'address', 'city', 'district', 'state', 'areaLocality', 'pincode', 'googleMapsLocation', 'siteLocationSameAsCommunication', 'gstNo', 'panNo', 'preferredContactTime', 'communicationPreference', 'remarks', 'referredBy', 'interestedIn', 'electricityBill', 'monthlyUnits', 'existingSolar', 'decisionMaker', 'expectedRoiPeriod', 'systemType', 'systemCapacity', 'panelBrand', 'panelWattage', 'numberOfPanels', 'inverterBrand', 'inverterCapacity', 'structureType', 'batteryRequired', 'batteryCapacity', 'estimatedMonthlyGeneration', 'estimatedAnnualGeneration', 'estimatedMonthlySavings', 'estimatedAnnualSavings', 'netMetering', 'rooftopType', 'requiredSolarCapacity', 'estimatedGeneration', 'panelCount', 'panelType', 'inverterType', 'mountingStructure', 'batteryRequirement', 'leadType', 'initialRequirement', 'leadSource', 'leadPriority', 'location', 'customerName', 'mobileNumber', 'email'];
        for (const key of topLevelDetailKeys) {
            if (Object.prototype.hasOwnProperty.call(payload, key) && key !== 'leadSource' && key !== 'leadPriority' && key !== 'location' && key !== 'customerName' && key !== 'mobileNumber' && key !== 'email') {
                detailsPatch[key] = payload[key];
            }
        }

        const normalizedCustomerName = String(payload.customerName ?? lead.customer_name ?? '').trim();
        const normalizedMobileNumber = String(payload.mobileNumber ?? lead.mobile_number ?? '').trim();
        if (!normalizedCustomerName || !normalizedMobileNumber) return { error: 'Customer Name and Mobile Number are mandatory.', fields: ['customerName', 'mobileNumber'], status: 422 };
        const normalizedMobile = normalizeIndianMobileNumber(normalizedMobileNumber);
        if (!normalizedMobile && normalizedMobileNumber !== String(lead.mobile_number || '').trim()) return { error: 'Enter a valid 10-digit Indian mobile number.', fields: ['mobileNumber'], status: 422 };
        const duplicate = normalizedMobile ? await this.repository.findDuplicateMobile(normalizedMobile, lead.id) : null;
        if (duplicate) return { error: 'A lead with this mobile number already exists.', code: 'DUPLICATE_MOBILE', message: 'A lead with this mobile number already exists.', existingLead: duplicate, status: 409 };
        if (payload.stage) return { error: 'Stages can only change through Mark Complete after validation.', status: 422 };

        const timestamp = dependencies.now();
        let existingDetails = {};
        try { existingDetails = lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { existingDetails = {}; }

        const mergedDetails = { ...existingDetails, ...detailsPatch };
        const changes = [];
        const next = { ...lead, ...payload, details: mergedDetails };
        if (Object.prototype.hasOwnProperty.call(payload, 'customerName')) changes.push('customerName');
        if (Object.prototype.hasOwnProperty.call(payload, 'mobileNumber')) changes.push('mobileNumber');
        if (Object.prototype.hasOwnProperty.call(payload, 'email')) changes.push('email');
        if (Object.prototype.hasOwnProperty.call(payload, 'leadSource')) changes.push('leadSource');
        if (Object.prototype.hasOwnProperty.call(payload, 'leadPriority')) changes.push('leadPriority');
        if (Object.prototype.hasOwnProperty.call(payload, 'leadStatus')) changes.push('leadStatus');
        if (Object.prototype.hasOwnProperty.call(payload, 'location')) changes.push('location');
        if (Object.keys(detailsPatch).length || Object.prototype.hasOwnProperty.call(payload, 'details')) changes.push('details');

        if (!changes.length) return { error: 'No lead fields were supplied to update.', status: 422 };

        try {
            await this.repository.database.transaction((tx) => this.repository.updateLead(tx, lead.id, next, timestamp, user.id, changes));
        } catch (error) {
            return { error: 'Unable to update lead. Please try again.', status: 500 };
        }
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
