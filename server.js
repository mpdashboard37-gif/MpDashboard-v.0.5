const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { config: databaseConfig, createDatabase, assertProductionStorage } = require('./database');
const { LeadRepository } = require('./repositories/lead-repository');
const { LeadService } = require('./services/lead-service');
const { calculateLeadScore, getLeadCategory, getLeadScoreSnapshot } = require('./services/lead-score');
const { normalizeIndianMobileNumber, maskIndianMobileNumber } = require('./services/mobile-number');
const { SQLITE_LEAD_NUMBER_GLOB, isValidLeadNumber, nextLeadNumber, publicLeadNumber } = require('./services/lead-number');
const { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseLeadFile, toSafeCsv, validateLeadRows } = require('./services/lead-import');
const { asPublicStatus, canImportLeads, createBulkLeadImportService } = require('./services/bulk-lead-import-service');
const { canViewSurvey, canEditSurvey, canCreateSurveyRequest, canAssignSurvey } = require('./services/survey-permissions');
const createPipelineRouter = require('./pipeline-api');
const { OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_ALIASES, normalizeOpportunityStage } = require('./pipeline-stages');
const { FIXED_SUBSIDY_BENEFIT, getProposalPricingSlab: getConfiguredProposalPricingSlab, migrateLegacySolarPricing, proposalCommercialLines, proposalPricing: calculateConfiguredProposalPricing } = require('./services/proposal-pricing');
const { validatePaymentSchedule } = require('./services/payment-schedule');
const { normalizeProposalConfiguration, getProposalConfigurationWarnings } = require('./services/proposal-configuration');
const equipmentCatalogueSeed = require('./services/equipment-catalogue-seed');
const {
    normalizeEquipmentCatalogueEntry,
    isSelectableCatalogueEntry
} = require('./services/equipment-catalogue');

dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
const SAFE_STATIC_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.txt', '.xml']);
const PUBLIC_STATIC_PATHS = new Set([
    '/', '/index.html', '/login.html', '/sign-up.html', '/settings.html', '/staff.html', '/lead-management.html', '/bulk-lead-import.html', '/lead-details.html', '/inventory.html', '/pipeline.html', '/proposal.html', '/site-survey.html', '/task-list.html', '/crm-api.js', '/settings-ui.js', '/services/proposal-configuration.js', '/services/equipment-catalogue.js', '/robots.txt', '/favicon.ico'
]);
const PUBLIC_STATIC_PREFIXES = ['/assets/', '/images/', '/css/', '/js/', '/fonts/', '/media/'];
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET && NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production before starting the CRM.');
}
if (NODE_ENV === 'production' && SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
}
function normalizeOrigin(origin) {
    return String(origin || '').trim().replace(/\/$/, '').toLowerCase();
}
function sanitizeRequestTarget(target) {
    const requestTarget = String(target || '');
    try {
        const parsed = new URL(requestTarget, 'http://localhost');
        for (const key of new Set(parsed.searchParams.keys())) {
            parsed.searchParams.set(key, '[REDACTED]');
        }
        return `${parsed.pathname}${parsed.search}`;
    } catch (error) {
        return requestTarget.split(/[?#]/, 1)[0];
    }
}
function safeErrorType(error) {
    return error?.name || 'Error';
}
const configuredClientOrigins = (process.env.CORS_ORIGIN || '').split(/[;,\n]/).map(normalizeOrigin).filter(Boolean);
const localClientOrigins = NODE_ENV === 'production' ? [] : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const CLIENT_ORIGINS = new Set([...configuredClientOrigins, ...localClientOrigins]);
if (NODE_ENV === 'production' && configuredClientOrigins.length === 0) {
    throw new Error('CORS_ORIGIN must contain at least one trusted HTTPS origin in production.');
}
if (NODE_ENV === 'production' && configuredClientOrigins.some((origin) => {
    try { return new URL(origin).protocol !== 'https:'; } catch (error) { return true; }
})) {
    throw new Error('CORS_ORIGIN must contain only valid HTTPS origins in production.');
}
if (NODE_ENV === 'production') {
    const resetBaseUrl = String(process.env.PASSWORD_RESET_BASE_URL || '').trim();
    const mailConfigured = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].every((key) => String(process.env[key] || '').trim());
    let resetUrlIsHttps = false;
    try { resetUrlIsHttps = new URL(resetBaseUrl).protocol === 'https:'; } catch (error) { }
    if (!resetUrlIsHttps || !mailConfigured) {
        throw new Error('Production password reset requires an HTTPS PASSWORD_RESET_BASE_URL and configured email delivery.');
    }
}
const FILE_STORAGE_ROOT = path.resolve(String(process.env.CRM_FILE_STORAGE_ROOT || path.join(ROOT, 'crm-files')));
const DATABASE_MODE = databaseConfig.mode;
if (NODE_ENV === 'production' && DATABASE_MODE === 'sqlite') assertProductionStorage();
if (DATABASE_MODE === 'postgresql') {
    throw new Error('PostgreSQL mode is not ready: CRM API routes still require synchronous SQLite operations. Startup stopped before database initialization; no data was changed.');
}
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/webm', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const database = createDatabase();
const repository = createDatabase();
const leadRepository = new LeadRepository(repository);
const leadService = new LeadService(leadRepository, canAccessLeadAsync);
const bulkLeadImportService = createBulkLeadImportService(repository, leadRepository);
const sessions = new Map();
const sessionExpiries = new Map();
const googleStates = new Map();
let mailTransport;
const GOOGLE_ADMIN_EMAIL = 'varunkv@inpacepower.com';
const PERMANENT_ADMIN_ID = 'staff-admin';
const PERMANENT_ADMIN_LOGIN = 'varunkv@inpacepower.com';
const STAGES = ['New', 'Contacted', 'Qualified', 'Site Survey', 'Survey Scheduled', 'Survey Completed', 'Negotiation', 'Converted'];
const LEGACY_STAGE_MAP = { 'New Lead': 'New', Working: 'Contacted', Nurturing: 'Qualified', Opportunity: 'Negotiation', 'Site Survey Scheduled': 'Survey Scheduled', 'Site Survey Completed': 'Survey Completed', 'Survey Scheduled': 'Survey Scheduled', 'Survey Completed': 'Survey Completed', Negotiation: 'Negotiation', Booking: 'Converted', Installation: 'Converted', BESCOM: 'Converted', Commissioned: 'Converted', Completed: 'Converted', Converted: 'Converted', Lost: 'Lost' };
const ACTIVE_STAGE_FLOW = ['New', 'Contacted', 'Qualified', 'Site Survey', 'Survey Scheduled', 'Survey Completed', 'Negotiation', 'Converted'];
const FOLLOW_UP_TYPES = ['Call', 'WhatsApp', 'Meeting', 'Site Visit', 'Proposal Discussion', 'Payment Follow-up', 'Other'];
const FOLLOW_UP_STATUSES = ['Pending', 'Completed', 'Rescheduled', 'Cancelled', 'Overdue'];
const PM_SURYA_GHAR_SUBSIDY = FIXED_SUBSIDY_BENEFIT;
const SETTINGS_DEFAULTS = {
    myProfile: {
        fullName: 'Owner Admin',
        email: 'varunkv@inpacepower.com',
        phone: '',
        role: 'Admin/Owner',
        timezone: 'Asia/Kolkata',
        language: 'English',
        signature: ''
    },
    security: {
        requireMfa: false,
        sessionTimeoutMinutes: 60,
        autoLockAfterFailedAttempts: 5,
        passwordPolicy: 'Strong',
        allowSelfSignup: false,
        requireManagerApproval: true,
        hideSensitiveFields: true,
        auditRetentionDays: 365
    },
    notifications: {
        emailAlerts: true,
        whatsappAlerts: false,
        taskReminders: true,
        leadAssignments: true,
        newSignupAlerts: true,
        digestFrequency: 'Daily'
    },
    staffManagement: {
        defaultRole: 'Sales Executive',
        autoAssignTeams: true,
        onboardingWorkflow: 'Manual approval',
        maxOpenTasksPerStaff: 20,
        managerNotifications: true
    },
    rolesPermissions: {
        adminAccess: 'Full',
        salesManagerAccess: 'Team',
        salesExecutiveAccess: 'Own leads',
        telecallerAccess: 'Own leads',
        allowViewDeletedRecords: false
    },
    signupRequests: {
        autoApproval: false,
        approvalWindowHours: 24,
        emailOnApproval: true,
        emailOnRejection: true,
        pendingReviewCount: 0
    },
    leadSettings: {
        defaultSource: 'Website',
        autoAssignLeads: true,
        duplicateCheck: true,
        captureAlternateContact: true,
        allowManualStageEdit: true
    },
    pipelineStages: {
        defaultStage: 'New',
        stages: ['New', 'Contacted', 'Qualified', 'Site Survey', 'Survey Scheduled', 'Survey Completed', 'Negotiation', 'Converted', 'Lost'],
        stageColors: {
            New: '#2563eb',
            Contacted: '#0ea5e9',
            Qualified: '#10b981',
            'Site Survey': '#f59e0b',
            'Survey Scheduled': '#f97316',
            'Survey Completed': '#8b5cf6',
            Negotiation: '#ec4899',
            Converted: '#22c55e',
            Lost: '#ef4444'
        }
    },
    locations: {
        defaultRegion: 'Bengaluru',
        territoryMapping: 'City wise',
        allowGeoCapture: true,
        allowMultipleLocations: true
    },
    tasksFollowUps: {
        defaultFollowUpDays: 2,
        reminderLeadTimeMinutes: 30,
        defaultTaskType: 'Call',
        allowRecurringTaskTemplates: true,
        taskAutoEscalation: true
    },
    activitySettings: {
        trackLeadNotes: true,
        trackTeamActivities: true,
        logSystemEvents: true,
        preserveActivityHistory: true,
        historyRetentionDays: 365
    },
    solarPanels: {
        defaultBrand: 'RenewSys',
        allowedWattage: ['540W', '550W', '560W', '600W'],
        keepStockByBrand: true,
        warrantyDays: 365
    },
    inverters: {
        defaultBrand: 'Sungrow',
        allowedPhases: ['Single Phase', 'Three Phase'],
        lowFrequencyWarning: true,
        warrantyDays: 365
    },
    batteries: {
        defaultBrand: 'Luminous',
        chemistry: 'Lithium Ion',
        enableBatterySizing: true,
        warrantyDays: 1800
    },
    structures: {
        defaultType: 'Rooftop',
        allowedTypes: ['Rooftop', 'Ground Mount', 'Carport', 'Hybrid'],
        autoLoadCheck: true,
        corrosionProtection: true
    },
    solarPricing: {
        currency: 'INR',
        gstRate: 5,
        salesCommissionRate: 5,
        tier3: 75000,
        tier5: 68000,
        tier8: 60000,
        tier10: 55000,
        subsidyTier3: 80000,
        subsidyTier5: 75000,
        subsidyTier8: 65000,
        hybridTier5: 97000,
        hybridTier8: 90000,
        hybridTier10: 90000,
        hybridThreePhaseCharge: 35000,
        hybridExtraBatteryCharge: 115000,
        hybridSubsidyPerPanel: 15000,
        onGridDiscountRate: 5,
        financeMaxInstallmentMonths: 24
    },
    proposalSettings: {
        autoGeneratePdf: true,
        defaultValidityDays: 30,
        requireCustomerApproval: true,
        includeTermsAtFooter: true,
        allowRevisionTracking: true
    },
    paymentSettings: {
        defaultPaymentTerms: '50% advance, 50% on installation',
        allowPartialPayments: true,
        requireInvoiceNumber: true,
        paymentReminderDays: [7, 3, 1],
        bankDetailsEnabled: true
    },
    termsConditions: {
        standardText: 'This proposal is valid for 30 days from the date of issue.',
        showOnProposal: true,
        requireCustomerAccept: true,
        version: 'v1.0'
    },
    emailSettings: {
        enabled: false,
        smtpHost: '',
        smtpPort: 587,
        smtpUser: '',
        smtpPassword: '',
        fromAddress: '',
        sendLeadAlerts: true,
        sendTaskReminders: true
    },
    whatsappSettings: {
        enabled: false,
        apiKey: '',
        senderNumber: '',
        sendLeadMessages: true,
        sendTaskMessages: true
    },
    siteSurveySettings: {
        requireGeoTag: true,
        requireInspectionNotes: true,
        defaultStatus: 'Scheduled',
        fileCategoryLabels: ['Roof', 'Meter', 'Main DB', 'Customer docs'],
        allowMultipleSurveyFiles: true
    },
    fileManagement: {
        maxUploadSizeMb: 100,
        allowedTypes: ['jpg', 'png', 'pdf', 'zip', 'docx'],
        keepOriginalNames: true,
        virusScan: false,
        autoArchiveDays: 30
    },
    companyProfile: {
        companyName: 'INPACE POWER',
        companyShortName: 'INPACE',
        registrationNumber: '',
        gstNumber: '',
        address: '',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'India',
        phone: '+91-8618196685',
        email: 'sales@inpaceenergy.com',
        website: 'www.inpaceenergy.com'
    },
    branding: {
        primaryColor: '#2563eb',
        secondaryColor: '#0f172a',
        accentColor: '#f59e0b',
        logoUrl: '',
        darkModeEnabled: false,
        useBrandColorsOnReports: true
    },
    numbering: {
        leadPrefix: 'LP',
        proposalPrefix: 'PROP',
        invoicePrefix: 'INV',
        projectPrefix: 'PJ',
        nextProposalNumber: 7001,
        nextInvoiceNumber: 10001
    },
    importExport: {
        lastExportAt: '',
        exportFormat: 'CSV',
        batchSize: 500,
        allowCsvImport: true,
        allowExcelImport: true,
        backupOnExport: true
    },
    databaseBackup: {
        autoBackupEnabled: true,
        backupFrequency: 'Daily',
        retentionDays: 30,
        lastBackupAt: '',
        storageLocation: 'Local CRM backup folder'
    },
    integrations: {
        webhookUrl: '',
        apiKey: '',
        enableZapier: false,
        enableGoogleSync: false,
        enableWhatsAppSync: false,
        enableCrmApi: true
    },
    dashboardSettings: {
        defaultView: 'Overview',
        widgets: ['Pipeline', 'Tasks', 'Inventory'],
        showKpis: true,
        showLeadTrend: true,
        showTasksByOwner: true
    },
    auditLogs: {
        enabled: true,
        retentionDays: 365,
        showUserActivities: true,
        showSystemEvents: true,
        recentLimit: 200
    },
    errorLogs: {
        enabled: true,
        alertOnCriticalErrors: true,
        sampleLimit: 200,
        storeDetails: true
    },
    systemInfo: {
        environment: 'development',
        databaseMode: 'sqlite',
        appDirectory: '',
        lastHealthCheck: '',
        uptimeSeconds: 0
    }
};

function getProposalPricingSlab(systemSize) {
    return getConfiguredProposalPricingSlab(systemSize, migrateLegacySolarPricing(readSettingsRecord().solarPricing));
}

function calculateProposalPricing(systemSize, pricingType, values = {}) {
    const pricing = calculateConfiguredProposalPricing(systemSize, migrateLegacySolarPricing(readSettingsRecord().solarPricing), {
        ...values,
        systemType: values.systemType || 'On-Grid',
        pricingType: pricingType || 'Non-Subsidy'
    });
    if (!pricing) return null;
    return {
        ...pricing,
        applicableRate: pricing.rate,
        baseAmount: pricing.subtotal,
        panelAmount: pricing.solarPanels,
        inverterAmount: pricing.inverter,
        acdbAmount: pricing.acdbDcdb + pricing.earthing + pricing.cables + pricing.installation + pricing.otherCharges,
        gstAmount: pricing.gst,
        calculatedTotal: pricing.grossAmount,
        grossTotal: pricing.grossAmount,
        subsidyAmount: pricing.subsidy
    };
}

const ROLE_ACCESS = {
    'Admin/Owner': 'all',
    'Sales Manager': 'team',
    'GM/AGM': 'all',
    'Sales Executive': 'own',
    'Telecaller': 'own'
};

function hashPassword(value) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(String(value || ''), salt, 64).toString('hex');
    return `scrypt$${salt}$${derivedKey}`;
}

function passwordPolicyError(value) {
    const password = String(value || '');
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return 'Password must be at least 8 characters and include an uppercase letter and a number.';
    }
    return null;
}

function verifyPassword(value, storedHash) {
    const stored = String(storedHash || '');
    if (stored.startsWith('scrypt$')) {
        const [, salt, expected] = stored.split('$');
        if (!salt || !expected) return false;
        const actual = crypto.scryptSync(String(value || ''), salt, 64).toString('hex');
        const actualBuffer = Buffer.from(actual, 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');
        if (actualBuffer.length !== expectedBuffer.length) return false;
        return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    }
    if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
        try {
            return bcrypt.compareSync(String(value || ''), stored);
        } catch (error) {
            return false;
        }
    }
    const expected = Buffer.from(stored || '', 'hex');
    const actual = Buffer.from(crypto.createHash('sha256').update(String(value || '')).digest('hex'), 'hex');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(actual, expected);
}

function now() {
    return new Date().toISOString();
}

function getMailTransport() {
    if (mailTransport !== undefined) return mailTransport;
    if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        mailTransport = null;
        return mailTransport;
    }
    mailTransport = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT || 587),
        secure: String(process.env.EMAIL_SECURE || '').toLowerCase() === 'true' || Number(process.env.EMAIL_PORT) === 465,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    });
    return mailTransport;
}

async function sendEmail(message) {
    const transport = getMailTransport();
    if (!transport) {
        console.warn('Email delivery is not configured; notification skipped:', message.subject);
        return false;
    }
    await transport.sendMail({ from: process.env.EMAIL_FROM || process.env.EMAIL_USER, ...message });
    return true;
}

function publicLoginUrl(request) {
    if (process.env.CRM_LOGIN_URL) return process.env.CRM_LOGIN_URL;
    const protocol = request.secure || request.socket.encrypted ? 'https' : 'http';
    return `${protocol}://${request.headers.host || `localhost:${PORT}`}/login.html`;
}

function accessRequestDetails(requestRecord) {
    let details = {};
    try { details = requestRecord.request_data ? JSON.parse(requestRecord.request_data) : {}; } catch (error) { details = {}; }
    return { name: requestRecord.full_name, email: requestRecord.email, phone: requestRecord.phone || details.phone || '', ...details };
}

function sendAccessRequestEmail(request, accessRequest) {
    const details = accessRequestDetails(accessRequest);
    const subject = `New MP Dashboard CRM Access Request - ${details.name}`;
    return sendEmail({
        to: process.env.ACCESS_REQUEST_TO || PERMANENT_ADMIN_LOGIN,
        cc: process.env.ACCESS_REQUEST_CC || 'luckyun269@gmail.com',
        subject,
        text: `New CRM access request received.\n\nRequest ID: ${accessRequest.id}\nApplicant: ${details.name}\nEmail: ${details.email}\nPhone: ${details.phone || 'Not provided'}\nRequest Date: ${accessRequest.created_at}\nStatus: Pending Admin Approval\n\nPlease open MP Dashboard -> Staff -> CRM Access Requests to review this request.\nAvailable actions: APPROVE or REJECT.\n\nThe applicant password is intentionally omitted.`
    });
}

function sendDecisionEmail(request, accessRequest, approved, rejectionReason = '') {
    const details = accessRequestDetails(accessRequest);
    if (!details.email) return Promise.resolve(false);
    const loginUrl = publicLoginUrl(request);
    const text = approved
        ? `Your MP Dashboard CRM access request has been approved.\n\nName: ${details.name}\nLogin email: ${details.email}\nCRM login URL: ${loginUrl}\n\nLog in using the password you created during signup.`
        : `Your request for MP Dashboard CRM access was not approved at this time.\n\nName: ${details.name}\nEmail: ${details.email}\nEligible to submit another request after: ${accessRequest.eligible_again_at}${rejectionReason ? `\n\nMessage: ${rejectionReason}` : ''}`;
    return sendEmail({ to: details.email, subject: approved ? 'MP Dashboard CRM Access Approved' : 'MP Dashboard CRM Access Request Update', text });
}

function generateProposalPDFLegacy(proposalData) {
    return new Promise((resolve, reject) => {
        try {
            const companyName = 'Inpace Power Pvt Ltd';
            const companyWebsite = 'https://inpacepowers.com';
            const logoPath = path.resolve(ROOT, 'assets', 'inpace-power-logo.jpeg');
            const rooftopPhotoPath = path.resolve(ROOT, 'assets', 'solar-rooftop.jpeg');
            if (!fs.existsSync(logoPath)) throw new Error('The official Inpace Power logo is unavailable.');
            const doc = new PDFDocument({
                size: 'A4',
                margin: { top: 108, bottom: 24, left: 46, right: 46 },
                bufferPages: true
            });

            const chunks = [];
            let physicalPageCount = 1;
            doc.on('pageAdded', () => { physicalPageCount += 1; });
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                try {
                    const pdfBuffer = Buffer.concat(chunks);
                    const pageCount = physicalPageCount;
                    if (pageCount !== 12) throw new Error(`Proposal PDF must contain exactly 12 pages; generated ${pageCount}.`);
                    resolve(pdfBuffer.toString('base64'));
                } catch (error) {
                    reject(error);
                }
            });
            doc.on('error', reject);

            const pricing = proposalData.pricing || {};
            const colors = {
                navy: '#102d50', navyDark: '#0b2039', blue: '#315b7d', orange: '#f58220',
                green: '#27865c', ink: '#26364a', muted: '#64748b', line: '#d9e1e7',
                paleBlue: '#f4f7fa', paleOrange: '#fff3e8', paleGreen: '#edf7f1', white: '#ffffff',
                soft: '#f4f7fa'
            };
            const pageWidth = doc.page.width;
            const pageHeight = doc.page.height;
            const left = 46;
            const right = pageWidth - 46;
            const contentWidth = right - left;
            const contentBottom = pageHeight - 77;
            const footerY = pageHeight - 50;
            const pageHeadings = [
                'COVER', 'PROJECT OVERVIEW', 'WHY SOLAR WITH INPACE POWER', 'OUR KEY EQUIPMENT',
                'SYSTEM DESIGN & CONFIGURATION', 'SOLAR SYSTEM ARCHITECTURE',
                'PANEL & INVERTER SPECIFICATIONS', 'OTHER COMPONENT SPECIFICATIONS',
                'COMPLETE BILL OF MATERIALS', 'COMMERCIALS, GENERATION & SAVINGS',
                'PAYMENT, WARRANTY & SUPPORT', 'SCOPE, TERMS & ACCEPTANCE'
            ];
            const addons = Array.isArray(proposalData.addons) ? proposalData.addons.filter(Boolean) : [];
            const proposalNumber = proposalData.proposalNumber || proposalData.proposalReference;
            const eligibilityVerified = proposalData.subsidyEligibilityVerified === true
                || proposalData.subsidyEligibilityVerified === 1
                || pricing.subsidyEligibilityVerified === true;
            const subsidyAmount = Number(proposalData.subsidyAmount ?? pricing.subsidyAmount ?? pricing.subsidy ?? 0);
            let currentPage = 1;

            const cleanText = (value, fallback = 'Not provided') => {
                if (value === undefined || value === null || String(value).trim() === '') return fallback;
                return String(value).trim();
            };
            const numberValue = (value) => {
                const number = Number(value);
                return Number.isFinite(number) ? number : null;
            };
            const currency = (value, zeroIsMissing = false) => {
                const amount = numberValue(value);
                if (amount === null || (zeroIsMissing && amount === 0)) return 'Not provided';
                return `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)}`;
            };
            function writeText(value, x, y, width, options = {}) {
                const text = cleanText(value);
                const fontSize = options.size || 10;
                const lineGap = options.lineGap ?? 2;
                doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(options.color || colors.ink);
                const height = doc.heightOfString(text, { width, fontSize, lineGap });
                if (y < 0 || y + height > contentBottom) {
                    throw new Error(`Proposal content overflow on page ${currentPage}: ${text.slice(0, 48)}`);
                }
                doc.text(text, x, y, { width, lineGap, align: options.align || 'left' });
                return y + height;
            }

            function drawChrome(pageNumber) {
                doc.fillColor(colors.navyDark).rect(0, 0, pageWidth, 8).fill();
                doc.fillColor(colors.orange).rect(0, 8, pageWidth * 0.22, 3).fill();
                doc.image(logoPath, left, 16, { fit: [54, 56], align: 'center', valign: 'center' });
                writeHeaderText(companyName, left + 66, 24, 250, { size: 11, bold: true, color: colors.navy });
                writeHeaderText(companyWebsite, left + 66, 43, 250, { size: 8, color: colors.blue });
                writeHeaderText(pageHeadings[pageNumber - 1], right - 235, 34, 235, { size: 8, bold: true, color: colors.muted, align: 'right' });
                doc.strokeColor(colors.line).lineWidth(0.7).moveTo(left, 84).lineTo(right, 84).stroke();
                doc.strokeColor(colors.line).lineWidth(0.7).moveTo(left, footerY - 8).lineTo(right, footerY - 8).stroke();
                writeFooterText(`${pageNumber} / 12`, left, footerY, 80, { size: 8, color: colors.muted });
                writeFooterText(companyWebsite, right - 230, footerY, 230, { size: 8, color: colors.blue, align: 'right' });
                doc.x = left;
                doc.y = 108;
            }

            function writeHeaderText(value, x, y, width, options = {}) {
                doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 9).fillColor(options.color || colors.ink);
                doc.text(cleanText(value), x, y, { width, lineBreak: false, align: options.align || 'left' });
            }

            function writeFooterText(value, x, y, width, options = {}) {
                doc.font('Helvetica').fontSize(options.size || 8).fillColor(options.color || colors.muted);
                doc.text(cleanText(value), x, y, { width, lineBreak: false, align: options.align || 'left' });
            }

            function startPage(pageNumber) {
                if (pageNumber > 1) doc.addPage();
                currentPage = pageNumber;
                drawChrome(pageNumber);
            }

            function drawSectionTitle(kicker, titleText, subtitle = '') {
                writeText(kicker.toUpperCase(), left, 104, contentWidth, { size: 8, bold: true, color: colors.orange });
                writeText(titleText, left, 120, contentWidth, { size: 21, bold: true, color: colors.navy });
                if (subtitle) writeText(subtitle, left, 151, contentWidth, { size: 9, color: colors.muted });
                doc.strokeColor(colors.orange).lineWidth(2).moveTo(left, 176).lineTo(left + 54, 176).stroke();
                return 194;
            }

            function drawCard(x, y, width, height, options = {}) {
                doc.roundedRect(x, y, width, height, 7)
                    .fillAndStroke(options.fill || colors.white, options.stroke || colors.line);
            }

            function drawField(label, value, x, y, width, height = 60, options = {}) {
                drawCard(x, y, width, height, { fill: options.fill || colors.white, stroke: options.stroke || colors.line });
                writeText(label.toUpperCase(), x + 12, y + 10, width - 24, { size: 7.5, bold: true, color: colors.muted });
                const valueText = cleanText(value);
                const valueSize = options.valueSize || 10;
                const availableHeight = height - 27;
                let fitSize = valueSize;
                while (fitSize > 7 && doc.heightOfString(valueText, { width: width - 24, fontSize: fitSize, lineGap: 1 }) > availableHeight) fitSize -= 0.5;
                if (doc.heightOfString(valueText, { width: width - 24, fontSize: fitSize, lineGap: 1 }) > availableHeight) {
                    throw new Error(`Proposal field does not fit on page ${currentPage}: ${label}`);
                }
                writeText(valueText, x + 12, y + 25, width - 24, { size: fitSize, bold: options.bold !== false, color: options.valueColor || colors.ink, lineGap: 1 });
            }

            function drawTable(rows, x, y, widths, options = {}) {
                const tableWidth = widths.reduce((total, width) => total + width, 0);
                const headerHeight = options.headerHeight || 25;
                doc.roundedRect(x, y, tableWidth, headerHeight, 5).fill(colors.navy);
                writeText(options.headers?.[0] || 'Description', x + 10, y + 7, widths[0] - 18, { size: 8, bold: true, color: colors.white });
                writeText(options.headers?.[1] || 'Amount', x + widths[0] + 8, y + 7, widths[1] - 16, { size: 8, bold: true, color: colors.white, align: 'right' });
                let currentY = y + headerHeight;
                rows.forEach((row, index) => {
                    const label = cleanText(row[0]);
                    const value = cleanText(row[1]);
                    doc.font('Helvetica').fontSize(8.5);
                    const labelHeight = doc.heightOfString(label, { width: widths[0] - 20, lineGap: 1 });
                    const valueHeight = doc.heightOfString(value, { width: widths[1] - 20, lineGap: 1 });
                    const rowHeight = Math.max(options.rowHeight || 23, Math.max(labelHeight, valueHeight) + 12);
                    if (currentY + rowHeight > contentBottom) throw new Error(`Proposal table overflow on page ${currentPage}.`);
                    const isEmphasis = options.emphasisRows?.includes(label) || /^(Gross Amount|Final Payable|TOTAL PRICE INCLUDING GST|Contract price)$/i.test(label);
                    const fill = isEmphasis ? colors.paleOrange : index % 2 ? colors.soft : colors.white;
                    doc.rect(x, currentY, tableWidth, rowHeight).fill(fill);
                    writeText(label, x + 10, currentY + 6, widths[0] - 20, { size: 8.5, bold: isEmphasis, color: isEmphasis ? colors.navy : colors.ink, lineGap: 1 });
                    writeText(value, x + widths[0] + 8, currentY + 6, widths[1] - 18, { size: 8.5, bold: isEmphasis, color: isEmphasis ? colors.navy : colors.ink, align: 'right', lineGap: 1 });
                    currentY += rowHeight;
                });
                doc.strokeColor(colors.line).lineWidth(0.6).rect(x, y, tableWidth, currentY - y).stroke();
                return currentY;
            }

            function drawMultiColumnTable(headers, rows, x, y, widths, options = {}) {
                const tableWidth = widths.reduce((total, width) => total + width, 0);
                const fontSize = options.fontSize || 7;
                const lineGap = options.lineGap ?? 1;
                const headerHeight = options.headerHeight || 27;
                doc.fillColor(colors.navy).rect(x, y, tableWidth, headerHeight).fill();
                let columnX = x;
                headers.forEach((header, index) => {
                    writeText(header, columnX + 4, y + 6, widths[index] - 8, {
                        size: options.headerFontSize || 7,
                        bold: true,
                        color: colors.white,
                        lineGap
                    });
                    columnX += widths[index];
                });
                let currentY = y + headerHeight;
                rows.forEach((row, rowIndex) => {
                    const values = headers.map((_, columnIndex) => cleanText(row[columnIndex], '—'));
                    const measuredHeights = values.map((value, columnIndex) => {
                        doc.font(options.boldRows?.includes(rowIndex) ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
                        return doc.heightOfString(value, { width: widths[columnIndex] - 8, fontSize, lineGap });
                    });
                    const rowHeight = Math.max(options.minRowHeight || 18, Math.max(...measuredHeights) + 8);
                    if (currentY + rowHeight > contentBottom) {
                        throw new Error(`Proposal table overflow on page ${currentPage}; reduce long BOM values or component rows.`);
                    }
                    doc.fillColor(rowIndex % 2 ? colors.soft : colors.white).rect(x, currentY, tableWidth, rowHeight).fill();
                    columnX = x;
                    values.forEach((value, columnIndex) => {
                        writeText(value, columnX + 4, currentY + 4, widths[columnIndex] - 8, {
                            size: fontSize,
                            bold: options.boldRows?.includes(rowIndex),
                            color: colors.ink,
                            lineGap
                        });
                        columnX += widths[columnIndex];
                    });
                    currentY += rowHeight;
                });
                doc.strokeColor(colors.line).lineWidth(0.6).rect(x, y, tableWidth, currentY - y).stroke();
                return currentY;
            }

            function drawParagraph(label, value, x, y, width, maxHeight, options = {}) {
                writeText(label.toUpperCase(), x, y, width, { size: 8, bold: true, color: options.labelColor || colors.muted });
                const text = cleanText(value);
                let fontSize = options.size || 10;
                while (fontSize > 7 && doc.heightOfString(text, { width, fontSize, lineGap: 2 }) > maxHeight) fontSize -= 0.5;
                const measuredHeight = doc.heightOfString(text, { width, fontSize, lineGap: 2 });
                if (measuredHeight > maxHeight || y + 16 + measuredHeight > contentBottom) {
                    throw new Error(`Proposal text does not fit on page ${currentPage}: ${label}`);
                }
                writeText(text, x, y + 15, width, { size: fontSize, color: options.color || colors.ink, lineGap: 2 });
            }

            function sectionIntro(text, x = left, y = 194, width = contentWidth) {
                return writeText(text, x, y, width, { size: 10, color: colors.ink, lineGap: 4 });
            }

            function gridFields(fields, columns = 2, startY = 220, rowHeight = 62, gap = 12) {
                const columnWidth = (contentWidth - gap * (columns - 1)) / columns;
                fields.forEach(([label, value], index) => {
                    const row = Math.floor(index / columns);
                    const column = index % columns;
                    drawField(label, value, left + column * (columnWidth + gap), startY + row * (rowHeight + gap), columnWidth, rowHeight);
                });
            }

            function nextPage(pageNumber) {
                startPage(pageNumber);
            }

            // 1. Cover
            startPage(1);
            doc.image(logoPath, left + 8, 118, { fit: [132, 132], align: 'center', valign: 'center' });
            writeText('INPACE POWER PVT LTD', left + 160, 143, contentWidth - 160, { size: 10, bold: true, color: colors.orange });
            writeText('SOLAR POWER PROPOSAL', left + 160, 165, contentWidth - 160, { size: 23, bold: true, color: colors.navy });
            writeText(`${cleanText(proposalData.systemType)} rooftop solar system`, left + 160, 201, contentWidth - 160, { size: 12, color: colors.blue });
            if (fs.existsSync(rooftopPhotoPath)) {
                doc.image(rooftopPhotoPath, left, 254, { fit: [contentWidth, 142], align: 'center', valign: 'center' });
            }
            doc.fillColor(colors.paleBlue).roundedRect(left, 414, contentWidth, 94, 10).fill();
            doc.fillColor(colors.orange).rect(left, 414, 6, 94).fill();
            writeText('PREPARED FOR', left + 22, 430, contentWidth - 44, { size: 8, bold: true, color: colors.muted });
            writeText(cleanText(proposalData.customerName), left + 22, 450, contentWidth - 44, { size: 20, bold: true, color: colors.navy });
            const coverFields = [
                ['Proposal number', cleanText(proposalNumber)],
                ['Proposal date', cleanText(proposalData.proposalDate)],
                ['Version', cleanText(proposalData.versionNumber)],
                ['System capacity', proposalData.systemCapacity ? `${proposalData.systemCapacity} kW` : 'Not provided']
            ];
            gridFields(coverFields, 2, 526, 56, 10);
            drawCard(left, 666, contentWidth, 72, { fill: colors.navy });
            writeText('PROJECT LOCATION', left + 18, 680, 170, { size: 7.5, bold: true, color: '#b8cbd9' });
            writeText(cleanText([proposalData.address, proposalData.city, proposalData.pincode].filter(Boolean).join(', ')), left + 18, 700, contentWidth - 36, { size: 10, bold: true, color: colors.white });
            writeText(companyName, left, 746, contentWidth, { size: 8, bold: true, color: colors.navy, align: 'right' });

            // 2. Welcome
            nextPage(2);
            drawSectionTitle('Project overview', 'Project Overview', 'Customer and project details recorded in the CRM.');
            sectionIntro(`Dear ${cleanText(proposalData.customerName)},`);
            drawParagraph('Proposal overview', `This proposal from ${companyName} records the selected solar system configuration, project price, available generation and savings inputs, payment information, and terms entered for this project.`, left, 238, contentWidth, 78, { size: 10 });
            drawParagraph('Data basis', 'Customer and project-specific details below are taken from the CRM proposal and selected lead. Information not provided in those records is identified as Not provided.', left, 345, contentWidth, 62, { size: 10 });
            gridFields([
                ['Customer', proposalData.customerName], ['Contact number', proposalData.contactNumber],
                ['Email', proposalData.customerEmail], ['Lead number', proposalData.leadNumber],
                ['Proposal number', proposalNumber], ['Proposal date', proposalData.proposalDate],
                ['System type', proposalData.systemType], ['System capacity', proposalData.systemCapacity ? `${proposalData.systemCapacity} kW` : 'Not provided']
            ], 3, 450, 62, 12);

            const componentConfiguration = Array.isArray(proposalData.componentConfiguration)
                ? proposalData.componentConfiguration
                : Array.isArray(pricing.componentConfiguration) ? pricing.componentConfiguration : [];
            const componentLabels = new Map([
                ['solarPanels', 'Solar panels'], ['inverter', 'Inverter'], ['battery', 'Battery and accessories'],
                ['structure', 'Mounting structure'], ['dcCable', 'DC solar cables'], ['acCable', 'AC cables'],
                ['dcdb', 'DCDB'], ['acdb', 'ACDB'], ['mcbMccb', 'MCB / MCCB'], ['spd', 'DC and AC SPD'],
                ['earthing', 'Earthing system'], ['lightningProtection', 'Lightning protection'],
                ['connectors', 'Solar connectors'], ['junctionBoxes', 'Junction boxes'],
                ['cableTrayConduit', 'Cable trays and conduits'], ['monitoring', 'Monitoring and communication'],
                ['installationAccessories', 'Other installation accessories']
            ]);
            const batteryRequired = proposalData.batteryRequired === true || proposalData.batteryRequired === 1;
            const projectMetrics = pricing.projectMetrics || {};
            function componentsFor(categories) {
                return componentConfiguration.filter((component) => categories.includes(component.category));
            }
            function componentSpecs(components) {
                return components.map((component) => [
                    componentLabels.get(component.category) || component.category,
                    component.brand,
                    component.model,
                    component.technicalSpecification,
                    component.rating,
                    component.sizeCapacity,
                    component.warranty
                ]);
            }
            function drawSpecTable(rows, y, maxHeight = 470) {
                if (!rows.length) {
                    drawField('Technical specifications', 'Not provided in the saved proposal.', left, y, contentWidth, 64);
                    return y + 64;
                }
                return drawMultiColumnTable(
                    ['Component', 'Brand', 'Model', 'Technical specification', 'Rating', 'Size / capacity', 'Warranty'],
                    rows,
                    left,
                    y,
                    [65, 48, 52, 126, 62, 74, contentWidth - 427],
                    { fontSize: 6.5, headerFontSize: 6.3, minRowHeight: 20, headerHeight: 30, lineGap: 0.5 }
                );
            }
            function drawDiagramBox(label, x, y, width, height, fill = colors.white) {
                doc.roundedRect(x, y, width, height, 6).fillAndStroke(fill, colors.navy);
                doc.font('Helvetica-Bold').fontSize(8).fillColor(colors.navy);
                doc.text(label, x + 5, y + 10, { width: width - 10, height: height - 20, align: 'center', valign: 'center', lineGap: 2 });
            }
            function drawArrow(x1, y1, x2, y2) {
                doc.strokeColor(colors.orange).lineWidth(2).moveTo(x1, y1).lineTo(x2, y2).stroke();
                const direction = x2 >= x1 ? 1 : -1;
                doc.fillColor(colors.orange).moveTo(x2, y2).lineTo(x2 - direction * 7, y2 - 4).lineTo(x2 - direction * 7, y2 + 4).fill();
            }
            function configuredComponents() {
                const rows = componentConfiguration.map((component) => ({
                    ...component,
                    component: `${componentLabels.get(component.category) || component.category}${component.inclusionStatus && component.inclusionStatus !== 'included' ? ` (${component.inclusionStatus})` : ''}`
                }));
                const hasCategory = (category) => rows.some((component) => component.category === category);
                if (!hasCategory('solarPanels') && (proposalData.panelBrand || proposalData.panelWattage || proposalData.panelCount)) {
                    rows.push({ category: 'solarPanels', component: 'Solar panels', brand: proposalData.panelBrand, model: '', technicalSpecification: '', rating: proposalData.panelWattage ? `${proposalData.panelWattage} W` : '', sizeCapacity: '', quantity: proposalData.panelCount, unit: 'pcs', inclusionStatus: 'included' });
                }
                if (!hasCategory('inverter') && (proposalData.inverterBrand || proposalData.inverterCapacity)) {
                    rows.push({ category: 'inverter', component: 'Inverter', brand: proposalData.inverterBrand, model: '', technicalSpecification: '', rating: '', sizeCapacity: proposalData.inverterCapacity ? `${proposalData.inverterCapacity} kW` : '', quantity: 1, unit: 'pcs', inclusionStatus: 'included' });
                }
                if (!hasCategory('structure') && proposalData.structureType) {
                    rows.push({ category: 'structure', component: 'Mounting structure', brand: '', model: '', technicalSpecification: proposalData.structureType, rating: '', sizeCapacity: '', quantity: 1, unit: 'set', inclusionStatus: 'included' });
                }
                return rows;
            }

            // 3. Why solar
            nextPage(3);
            drawSectionTitle('Project benefits', 'Why Solar with Inpace Power', 'Potential benefits depend on site conditions, the selected equipment and utility rules.');
            const benefitGap = 12;
            const benefitWidth = (contentWidth - benefitGap) / 2;
            [
                ['Lower electricity bills', 'A correctly designed solar system can offset a portion of grid electricity use. Actual savings depend on consumption, tariffs, system output and applicable export rules.'],
                ['Renewable energy', 'Solar generation uses sunlight, a renewable energy source. Actual production varies with weather, shading, orientation and maintenance.'],
                ['Greater energy independence', 'On-site generation can reduce reliance on grid energy during production hours. Backup capability is not implied unless the selected system and battery configuration support it.'],
                ['System monitoring', addons.some((item) => /monitor/i.test(item)) ? 'Monitoring is listed among the selected proposal add-ons.' : 'Monitoring is not listed as an included add-on in this proposal.'],
                ['Project-specific installation', 'Installation scope, schedule and workmanship terms are only those explicitly recorded in this proposal.']
            ].forEach(([title, copy], index) => {
                const column = index % 2;
                const row = Math.floor(index / 2);
                const x = left + column * (benefitWidth + benefitGap);
                const y = 210 + row * 150;
                drawCard(x, y, benefitWidth, 132, { fill: row % 2 ? colors.paleBlue : colors.white });
                writeText(title, x + 14, y + 14, benefitWidth - 28, { size: 11, bold: true, color: colors.navy });
                drawParagraph('Project note', copy, x + 14, y + 42, benefitWidth - 28, 72, { size: 8.5 });
            });

            // 4. Key equipment
            nextPage(4);
            drawSectionTitle('Selected equipment', 'Our Key Equipment', 'Only the project configuration saved with this proposal is identified below.');
            const equipmentGroups = [
                ['solarPanels', 'Solar modules'],
                ['inverter', 'Inverter'],
                ['structure', 'Mounting structure'],
                ['dcCable', 'DC cables']
            ];
            equipmentGroups.forEach(([category, title], index) => {
                const item = componentConfiguration.find((component) => component.category === category && component.inclusionStatus !== 'excluded');
                const fallback = category === 'solarPanels' ? proposalData.panelBrand
                    : category === 'inverter' ? proposalData.inverterBrand
                        : '';
                const x = left + (index % 2) * (contentWidth / 2 + 6);
                const y = 214 + Math.floor(index / 2) * 210;
                const width = (contentWidth - 12) / 2;
                drawCard(x, y, width, 188, { fill: index % 2 ? colors.paleBlue : colors.white });
                writeText(title, x + 14, y + 14, width - 28, { size: 11, bold: true, color: colors.navy });
                drawParagraph('Brand', item?.brand || fallback, x + 14, y + 48, width - 28, 30, { size: 9 });
                drawParagraph('Model', item?.model, x + 14, y + 88, width - 28, 30, { size: 9 });
                drawParagraph('Specification', item?.technicalSpecification, x + 14, y + 128, width - 28, 44, { size: 8 });
            });

            // 5. System design
            nextPage(5);
            drawSectionTitle('System design', 'System Design & Configuration', 'Ratings and quantities are shown as saved; missing values are not estimated.');
            const designWarnings = Array.isArray(pricing.configurationWarnings) ? pricing.configurationWarnings : [];
            gridFields([
                ['System type', proposalData.systemType],
                ['System capacity', proposalData.systemCapacity ? `${proposalData.systemCapacity} kW` : 'Not provided'],
                ['Solar panel brand', proposalData.panelBrand],
                ['Panel wattage', numberValue(proposalData.panelWattage) > 0 ? `${proposalData.panelWattage} W` : 'Not provided'],
                ['Panel count', numberValue(proposalData.panelCount) > 0 ? proposalData.panelCount : 'Not provided'],
                ['Inverter brand / model', `${cleanText(proposalData.inverterBrand)} / ${cleanText(componentConfiguration.find((item) => item.category === 'inverter')?.model)}`],
                ['Inverter AC capacity', numberValue(proposalData.inverterCapacity) > 0 ? `${proposalData.inverterCapacity} kW` : 'Not provided'],
                ['Structure', proposalData.structureType],
                ['Battery', batteryRequired ? `${numberValue(proposalData.batteryCapacity) > 0 ? `${proposalData.batteryCapacity} kWh` : 'Capacity not provided'}` : 'Not selected'],
                ['Net metering', proposalData.netMetering === undefined ? 'Not provided' : proposalData.netMetering ? 'Required' : 'Not required'],
                ['DC panel capacity check', numberValue(proposalData.panelWattage) > 0 && numberValue(proposalData.panelCount) > 0 ? `${(proposalData.panelWattage * proposalData.panelCount / 1000).toFixed(2)} kW DC (calculated from entered values)` : 'Not calculated'],
                ['DC / AC ratio review', numberValue(proposalData.inverterCapacity) > 0 && numberValue(proposalData.panelWattage) > 0 && numberValue(proposalData.panelCount) > 0 ? `${(proposalData.panelWattage * proposalData.panelCount / 1000 / proposalData.inverterCapacity).toFixed(2)} (review against selected equipment datasheets)` : 'Not calculated']
            ], 2, 205, 56, 8);
            if (designWarnings.length) {
                drawParagraph('Engineering and data review warnings', designWarnings.join('\n'), left, 626, contentWidth, 94, { size: 7.5, labelColor: colors.orange });
            }

            // 6. Solar architecture
            nextPage(6);
            drawSectionTitle('Electrical concept', 'Solar System Architecture', 'Conceptual flow only; final single-line design must be verified for the selected equipment and site.');
            const diagramY = 320;
            const boxHeight = 64;
            const boxWidth = 68;
            const boxGap = (contentWidth - boxWidth * 6) / 5;
            const diagramLabels = [
                ['PV array', proposalData.panelCount ? `${proposalData.panelCount} modules` : 'Modules not specified'],
                ['DCDB', 'DC protection'],
                ['Inverter', proposalData.inverterBrand || 'Model not specified'],
                ['ACDB', 'AC protection'],
                ['Consumer load', 'Site distribution'],
                ['Grid / meter', proposalData.netMetering ? 'Net metering selected' : 'Utility connection']
            ];
            diagramLabels.forEach(([title, subtitle], index) => {
                const x = left + index * (boxWidth + boxGap);
                drawDiagramBox(`${title}\n${subtitle}`, x, diagramY, boxWidth, boxHeight, index === 0 ? colors.paleOrange : colors.paleBlue);
                if (index < diagramLabels.length - 1) drawArrow(x + boxWidth + 2, diagramY + boxHeight / 2, x + boxWidth + boxGap - 3, diagramY + boxHeight / 2);
            });
            if (batteryRequired) {
                const batteryX = left + 2 * (boxWidth + boxGap);
                drawDiagramBox(`Battery\n${proposalData.batteryCapacity || 'Capacity not specified'} kWh`, batteryX, diagramY + 120, boxWidth, boxHeight, colors.paleGreen);
                drawArrow(batteryX + boxWidth / 2, diagramY + 4, batteryX + boxWidth / 2, diagramY + 116);
            }
            const earthY = diagramY + 250;
            drawDiagramBox('Earthing system', left + contentWidth / 2 - 68, earthY, 136, 46, colors.white);
            doc.strokeColor(colors.green).lineWidth(1.5).moveTo(left + contentWidth / 2, earthY).lineTo(left + contentWidth / 2, diagramY + boxHeight + 20).stroke();
            drawParagraph('Design qualification', 'This diagram is illustrative and does not replace the project-specific engineering drawing, protection coordination, wiring schedule or manufacturer installation instructions.', left, 650, contentWidth, 74, { size: 8.5 });

            // 7. Panel and inverter specifications
            nextPage(7);
            drawSectionTitle('Technical schedule', 'Component Specifications: Solar Panels and Inverter', 'Specifications are not inferred from brand names; confirm every value against the selected manufacturer datasheet.');
            let primarySpecs = componentSpecs(componentsFor(['solarPanels', 'inverter']));
            if (!primarySpecs.some((row) => row[0] === 'Solar panels') && (proposalData.panelBrand || proposalData.panelWattage || proposalData.panelCount)) {
                primarySpecs.push(['Solar panels', proposalData.panelBrand, '', '', proposalData.panelWattage ? `${proposalData.panelWattage} W` : '', `${proposalData.panelCount || ''} pcs`, '']);
            }
            if (!primarySpecs.some((row) => row[0] === 'Inverter') && (proposalData.inverterBrand || proposalData.inverterCapacity)) {
                primarySpecs.push(['Inverter', proposalData.inverterBrand, '', '', '', proposalData.inverterCapacity ? `${proposalData.inverterCapacity} kW` : '', '']);
            }
            drawSpecTable(primarySpecs, 210);
            const primaryDatasheets = componentConfiguration.filter((component) => ['solarPanels', 'inverter'].includes(component.category) && component.datasheetFileName);
            if (primaryDatasheets.length) drawParagraph('Datasheets attached to the CRM lead', primaryDatasheets.map((item) => item.datasheetFileName).join('\n'), left, 610, contentWidth, 96, { size: 8 });

            // 8. Other technical specifications
            nextPage(8);
            drawSectionTitle('Technical schedule', 'Other Component Specifications', 'Project components, ratings and warranties are listed only when saved.');
            const secondarySpecs = componentSpecs(componentsFor([
                'battery', 'structure', 'dcCable', 'acCable', 'dcdb', 'acdb', 'mcbMccb', 'spd',
                'earthing', 'lightningProtection', 'connectors', 'junctionBoxes', 'cableTrayConduit',
                'monitoring', 'installationAccessories'
            ]));
            drawSpecTable(secondarySpecs, 205);
            if (designWarnings.length) drawParagraph('Review before issue', designWarnings.join('\n'), left, 620, contentWidth, 100, { size: 7.5, labelColor: colors.orange });

            // 9. Complete bill of materials
            nextPage(9);
            drawSectionTitle('Material schedule', 'Complete Bill of Materials', 'Quantities and descriptions are taken from the saved project configuration.');
            const bom = configuredComponents().map((component, index) => [
                String(index + 1),
                component.component,
                component.brand,
                component.model,
                component.technicalSpecification,
                [component.rating, component.sizeCapacity].filter(Boolean).join(' / '),
                component.quantity,
                component.unit
            ]);
            if (!bom.length) drawField('Bill of materials', 'No component rows have been configured.', left, 210, contentWidth, 64);
            else drawMultiColumnTable(
                ['#', 'Component', 'Brand', 'Model', 'Technical specification', 'Rating / size', 'Qty', 'Unit'],
                bom,
                left,
                205,
                [22, 72, 48, 50, 132, 72, 42, contentWidth - 438],
                { fontSize: 6.6, headerFontSize: 6.2, minRowHeight: 18, headerHeight: 30, lineGap: 0.5 }
            );
            const datasheetNames = componentConfiguration.filter((component) => component.datasheetFileName).map((component) => component.datasheetFileName);
            if (datasheetNames.length) drawParagraph('Datasheet attachments', datasheetNames.join('\n'), left, 704, contentWidth, 45, { size: 7 });

            // 10. Commercials, generation and savings
            nextPage(10);
            drawSectionTitle('Investment & output', 'Commercial Details, Generation and Savings', 'Figures are saved proposal inputs and are not independently forecast.');
            const commercialRows = proposalCommercialLines(pricing, proposalData.systemCapacity)
                .filter(({ label }) => !/^Net Investment$/i.test(label)
                    && (!/estimated PM Surya Ghar benefit/i.test(label) || (eligibilityVerified && subsidyAmount > 0)))
                .map(({ label, amount }) => [label, currency(amount)]);
            const tableEnd = drawTable(commercialRows, left, 198, [contentWidth - 150, 150], { headers: ['Price component', 'Amount (INR)'], rowHeight: 19 });
            const finalProjectPrice = proposalData.finalAmount ?? pricing.finalAmount ?? pricing.finalPayable;
            const generationY = Math.min(tableEnd + 16, 565);
            const generationWidth = (contentWidth - 16) / 3;
            drawField('Daily generation', numberValue(projectMetrics.dailyGenerationKwh) > 0 ? `${projectMetrics.dailyGenerationKwh} kWh` : 'Not provided', left, generationY, generationWidth, 58, { fill: colors.paleBlue, valueSize: 9 });
            drawField('Monthly generation', numberValue(projectMetrics.monthlyGenerationKwh) > 0 ? `${projectMetrics.monthlyGenerationKwh} kWh` : 'Not provided', left + generationWidth + 8, generationY, generationWidth, 58, { fill: colors.paleBlue, valueSize: 9 });
            drawField('Annual generation', numberValue(projectMetrics.annualGenerationKwh) > 0 ? `${projectMetrics.annualGenerationKwh} kWh` : 'Not provided', left + (generationWidth + 8) * 2, generationY, generationWidth, 58, { fill: colors.paleBlue, valueSize: 9 });
            const savingsY = generationY + 72;
            drawField('Monthly savings', currency(proposalData.monthlySavings, true), left, savingsY, generationWidth, 58, { fill: colors.paleGreen, valueSize: 9 });
            drawField('Annual savings', currency(proposalData.annualSavings, true), left + generationWidth + 8, savingsY, generationWidth, 58, { fill: colors.paleGreen, valueSize: 9 });
            const paybackYears = projectMetrics.performanceInputsVerified && numberValue(projectMetrics.paybackYears) > 0
                ? Number(projectMetrics.paybackYears)
                : null;
            drawField('Simple payback', paybackYears ? `${paybackYears.toFixed(1)} years` : 'Not calculated', left + (generationWidth + 8) * 2, savingsY, generationWidth, 58, { fill: colors.paleOrange, valueSize: 9 });
            drawParagraph('Assumptions', projectMetrics.savingsAssumptions || 'Generation and savings assumptions were not provided. Payback is only shown when the entered savings inputs are marked verified; it excludes financing, O&M and future tariff changes.', left, savingsY + 82, contentWidth, 70, { size: 8 });

            // 11. Payment, warranty and support
            nextPage(11);
            drawSectionTitle('Agreement details', 'Payment Terms, Warranty and Support', 'Payment and warranty terms are project-specific and appear only as saved.');
            const paymentTerms = [proposalData.paymentTerms, proposalData.customPaymentTerms].filter((value) => String(value || '').trim()).join(' - ');
            drawField('Payment terms', paymentTerms, left, 202, contentWidth, 58, { fill: colors.paleBlue });
            drawField('Booking amount', currency(proposalData.bookingAmount, true), left, 274, (contentWidth - 14) / 2, 56);
            drawField('Proposal validity', numberValue(proposalData.validityDays) > 0 ? `${proposalData.validityDays} days` : 'Not provided', left + (contentWidth - 14) / 2 + 14, 274, (contentWidth - 14) / 2, 56);
            const paymentRows = Array.isArray(proposalData.paymentSchedule)
                ? proposalData.paymentSchedule.map((milestone) => [
                    milestone.label,
                    milestone.type === 'percentage' ? `${milestone.value}%` : 'Fixed amount',
                    currency(milestone.amount)
                ])
                : [];
            let paymentTableEnd = 396;
            if (paymentRows.length) paymentTableEnd = drawMultiColumnTable(['Milestone', 'Basis', 'Amount'], paymentRows, left, 348, [contentWidth - 215, 75, 140], { fontSize: 8, minRowHeight: 21, headerHeight: 26 });
            else drawField('Structured payment milestones', 'Not provided', left, 348, contentWidth, 48);
            const warrantyY = paymentTableEnd + 20;
            writeText('WARRANTY & SUPPORT', left, warrantyY, contentWidth, { size: 8, bold: true, color: colors.orange });
            const warrantyText = [
                proposalData.warranty ? `Installation / project warranty: ${proposalData.warranty}` : 'Installation / project warranty: Not provided.',
                componentConfiguration.some((component) => component.warranty) ? 'Equipment-specific manufacturer warranties are listed on pages 7 and 8.' : 'Equipment-specific manufacturer warranties: Not provided.'
            ].join('\n');
            drawParagraph('Recorded warranty terms', warrantyText, left, warrantyY + 14, contentWidth, Math.max(30, contentBottom - warrantyY - 38), { size: 8 });

            // 12. Scope, terms and acceptance
            nextPage(12);
            drawSectionTitle('Acceptance', 'Scope, Terms and Acceptance', 'Please review this project-specific proposal and record acceptance below.');
            drawParagraph('Scope of work', proposalData.scopeOfWork, left, 206, contentWidth, 84, { size: 9.5 });
            const includedItems = configuredComponents().filter((component) => component.inclusionStatus === 'included').map((component) => component.component);
            const excludedItems = configuredComponents().filter((component) => component.inclusionStatus === 'excluded').map((component) => component.component);
            drawParagraph('Included equipment / items', includedItems.join(', '), left, 314, contentWidth, 60, { size: 8.5 });
            drawParagraph('Excluded items', excludedItems.join(', '), left, 394, contentWidth, 54, { size: 8.5 });
            const validityText = numberValue(proposalData.validityDays) > 0 ? `Proposal validity: ${proposalData.validityDays} days.` : '';
            drawParagraph('Project terms', [validityText, cleanText(proposalData.termsConditions)].filter(Boolean).join('\n\n'), left, 468, contentWidth, 102, { size: 8.5 });
            const signatureY = 604;
            const signatureWidth = (contentWidth - 28) / 2;
            doc.strokeColor(colors.line).lineWidth(0.8).moveTo(left, signatureY + 48).lineTo(left + signatureWidth, signatureY + 48).stroke();
            doc.strokeColor(colors.line).moveTo(left + signatureWidth + 28, signatureY + 48).lineTo(right, signatureY + 48).stroke();
            writeText('Customer signature / name', left, signatureY + 56, signatureWidth, { size: 8, color: colors.muted });
            writeText('For Inpace Power Pvt Ltd', left + signatureWidth + 28, signatureY + 56, signatureWidth, { size: 8, color: colors.muted });
            writeText('Date: ____________________', left, signatureY + 80, signatureWidth, { size: 8, color: colors.muted });
            writeText('Date: ____________________', left + signatureWidth + 28, signatureY + 80, signatureWidth, { size: 8, color: colors.muted });
            doc.fillColor(colors.navy).roundedRect(left, 713, contentWidth, 46, 7).fill();
            doc.fillColor(colors.orange).rect(left, 713, 5, 46).fill();
            writeText('Thank you', left + 16, 726, contentWidth - 32, { size: 13, bold: true, color: colors.white });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

function generateProposalPDF(proposalData) {
    return new Promise((resolve, reject) => {
        try {
            const companyName = 'Inpace Power Pvt Ltd';
            const companyWebsite = 'https://inpacepowers.com';
            const logoPath = path.resolve(ROOT, 'public', 'assets', 'inpace-power-logo.jpeg');
            const proposalAssetsPath = path.resolve(ROOT, 'assets', 'proposal-assets');
            if (!fs.existsSync(logoPath)) throw new Error('The official Inpace Power logo is unavailable.');
            const proposalImageNames = [
                'luxury-villa-solar-pexels-19065333.jpeg',
                'solar-rooftop.jpeg', 'solar-modules.jpeg', 'solar-inverter.jpeg', 'solar-installation.jpeg',
                'mounting-structure.jpeg', 'electrical-components.jpeg', 'dc-cables.jpeg', 'support-engineer.jpeg'
            ];
            const proposalImages = new Map(proposalImageNames.map((assetName) => {
                const assetPath = path.resolve(proposalAssetsPath, assetName);
                if (!fs.existsSync(assetPath)) throw new Error(`Required proposal image is unavailable: ${assetName}`);
                const imageBytes = fs.readFileSync(assetPath);
                const isJpeg = imageBytes[0] === 0xff && imageBytes[1] === 0xd8;
                const isPng = imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
                if (!isJpeg && !isPng) throw new Error(`Required proposal image is not a valid JPEG or PNG: ${assetName}`);
                return [assetName, imageBytes];
            }));

            const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
            const chunks = [];
            const colors = {
                navy: '#102d50', deepNavy: '#0b2039', blue: '#315b7d', orange: '#f58220',
                ink: '#26364a', muted: '#64748b', line: '#d9e1e7', pale: '#f4f7fa',
                paleOrange: '#fff3e8', paleGreen: '#edf7f1', white: '#ffffff'
            };
            const pageWidth = doc.page.width;
            const pageHeight = doc.page.height;
            const left = 38;
            const right = pageWidth - left;
            const contentWidth = right - left;
            const contentBottom = pageHeight - 54;
            const footerY = pageHeight - 31;
            const proposalDataSafe = proposalData || {};
            const pricing = proposalDataSafe.pricing || {};
            const components = Array.isArray(proposalDataSafe.componentConfiguration)
                ? proposalDataSafe.componentConfiguration
                : Array.isArray(pricing.componentConfiguration) ? pricing.componentConfiguration : [];
            const proposalNumber = proposalDataSafe.proposalNumber || proposalDataSafe.proposalReference;
            const pageTitles = [
                'SOLAR POWER PROPOSAL', 'WELCOME LETTER', 'PROJECT OVERVIEW & BENEFITS',
                'PREMIUM COMPONENTS & SAFETY', 'OPERATIONS & MAINTENANCE', 'SYSTEM DESIGN & TECHNICAL DETAILS',
                'PAYMENT OPTIONS & TERMS', 'AFTER-SALES SERVICE', 'SCOPE OF WORK',
                'COMMERCIAL PROPOSAL', 'BILL OF MATERIALS', 'CUSTOMER ACCEPTANCE & CLOSING'
            ];
            let pageNumber = 1;
            let physicalPageCount = 1;

            doc.on('pageAdded', () => { physicalPageCount += 1; });
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('error', reject);
            doc.on('end', () => {
                try {
                    if (physicalPageCount !== 12) {
                        throw new Error(`Proposal PDF must contain exactly 12 pages; generated ${physicalPageCount}.`);
                    }
                    resolve(Buffer.concat(chunks).toString('base64'));
                } catch (error) {
                    reject(error);
                }
            });

            const textValue = (value, fallback = 'To be confirmed') => {
                if (value === undefined || value === null || String(value).trim() === '') return fallback;
                return String(value).trim();
            };
            const numericValue = (value) => {
                const number = Number(value);
                return Number.isFinite(number) ? number : null;
            };
            const currency = (value, zeroIsMissing = false) => {
                const amount = numericValue(value);
                if (amount === null || (zeroIsMissing && amount === 0)) return 'To be confirmed';
                return `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)}`;
            };
            const isSubsidyVerified = proposalDataSafe.subsidyEligibilityVerified === true
                || proposalDataSafe.subsidyEligibilityVerified === 1
                || pricing.subsidyEligibilityVerified === true;
            const subsidyAmount = Number(proposalDataSafe.subsidyAmount ?? pricing.subsidyAmount ?? pricing.subsidy ?? 0);

            function writeText(value, x, y, width, options = {}) {
                const text = textValue(value, options.fallback || 'To be confirmed');
                let fontSize = options.size || 10;
                const lineGap = options.lineGap ?? 1.5;
                doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
                let height = doc.heightOfString(text, { width, fontSize, lineGap });
                while (height > (options.maxHeight || contentBottom - y) && fontSize > (options.minSize || 7)) {
                    fontSize -= 0.5;
                    doc.fontSize(fontSize);
                    height = doc.heightOfString(text, { width, fontSize, lineGap });
                }
                if (y < 0 || y + height > contentBottom || height > (options.maxHeight || contentBottom - y)) {
                    throw new Error(`Proposal content overflow on page ${pageNumber}: ${text.slice(0, 60)}`);
                }
                doc.fillColor(options.color || colors.ink).fontSize(fontSize);
                doc.text(text, x, y, { width, lineGap, align: options.align || 'left' });
                return y + height;
            }

            function drawCard(x, y, width, height, options = {}) {
                if (y < 0 || y + height > contentBottom) {
                    throw new Error(`Proposal card overflow on page ${pageNumber}.`);
                }
                doc.roundedRect(x, y, width, height, options.radius || 8)
                    .fillAndStroke(options.fill || colors.white, options.stroke || colors.line);
                if (options.accent) doc.fillColor(options.accent).rect(x, y, 4, height).fill();
            }

            function drawApprovalNote(title, message, x, y, width, height) {
                drawCard(x, y, width, height, { fill: colors.paleOrange, stroke: '#f2c08e', accent: colors.orange });
                writeText(title, x + 12, y + 8, width - 24, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
                writeText(message, x + 12, y + 23, width - 24, { size: 7, color: colors.ink, maxHeight: height - 28 });
            }

            function drawHeaderFooter(number) {
                doc.fillColor(colors.deepNavy).rect(0, 0, pageWidth, 7).fill();
                doc.fillColor(colors.orange).rect(0, 7, pageWidth * 0.2, 3).fill();
                doc.image(logoPath, left, 16, { fit: [38, 38], align: 'center', valign: 'center' });
                doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.navy)
                    .text(companyName, left + 47, 21, { lineBreak: false });
                doc.font('Helvetica').fontSize(7.5).fillColor(colors.blue)
                    .text(companyWebsite, left + 47, 34, { lineBreak: false });
                doc.font('Helvetica-Bold').fontSize(7).fillColor(colors.muted)
                    .text(pageTitles[number - 1], right - 245, 27, { width: 245, align: 'right', lineBreak: false });
                doc.strokeColor(colors.line).lineWidth(0.7).moveTo(left, 61).lineTo(right, 61).stroke();
                if (number !== 1) {
                    doc.strokeColor(colors.line).lineWidth(0.7).moveTo(left, footerY - 7).lineTo(right, footerY - 7).stroke();
                    doc.font('Helvetica').fontSize(7).fillColor(colors.muted)
                        .text(`${number} / 12`, left, footerY, { lineBreak: false });
                    doc.font('Helvetica').fontSize(7).fillColor(colors.blue)
                        .text(`${companyName}  |  Solar Proposal`, right - 250, footerY, { width: 250, align: 'right', lineBreak: false });
                }
            }

            function startPage(number) {
                if (number > 1) doc.addPage();
                pageNumber = number;
                drawHeaderFooter(number);
            }

            function drawTitle(title, subtitle = '') {
                writeText(title, left, 78, contentWidth, { size: 23, bold: true, color: colors.navy, maxHeight: 34 });
                if (subtitle) writeText(subtitle, left, 111, contentWidth, { size: 9, color: colors.muted, maxHeight: 25 });
                doc.fillColor(colors.orange).roundedRect(left, 141, 54, 3, 1).fill();
            }

            function drawLabeledValue(label, value, x, y, width, height = 48, options = {}) {
                drawCard(x, y, width, height, options);
                writeText(String(label).toUpperCase(), x + 10, y + 8, width - 20, { size: 7, bold: true, color: colors.muted, maxHeight: 12 });
                writeText(value, x + 10, y + 23, width - 20, {
                    size: options.valueSize || 10, bold: options.bold !== false,
                    color: options.valueColor || colors.navy, maxHeight: height - 27
                });
            }

            function drawTable(headers, rows, x, y, widths, options = {}) {
                const tableWidth = widths.reduce((sum, width) => sum + width, 0);
                const headerHeight = options.headerHeight || 26;
                if (x + tableWidth > right + 0.5) throw new Error(`Proposal table exceeds page width on page ${pageNumber}.`);
                doc.roundedRect(x, y, tableWidth, headerHeight, 5).fill(colors.navy);
                let columnX = x;
                headers.forEach((header, index) => {
                    writeText(header, columnX + 5, y + 7, widths[index] - 10, {
                        size: options.headerSize || 7.5, bold: true, color: colors.white,
                        maxHeight: headerHeight - 8
                    });
                    columnX += widths[index];
                });
                let currentY = y + headerHeight;
                rows.forEach((row, rowIndex) => {
                    const values = headers.map((_, index) => textValue(row[index], '—'));
                    const size = options.size || 8;
                    const heights = values.map((value, index) => {
                        doc.font(options.boldRows?.includes(rowIndex) ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
                        return doc.heightOfString(value, { width: widths[index] - 10, fontSize: size, lineGap: 1 });
                    });
                    const rowHeight = Math.max(options.rowHeight || 22, Math.max(...heights) + 10);
                    if (currentY + rowHeight > contentBottom) {
                        throw new Error(`Proposal table overflow on page ${pageNumber}; ${rows.length} rows do not fit.`);
                    }
                    const highlighted = options.highlightRows?.includes(rowIndex);
                    doc.fillColor(highlighted ? colors.paleOrange : (rowIndex % 2 ? colors.pale : colors.white))
                        .rect(x, currentY, tableWidth, rowHeight).fill();
                    columnX = x;
                    values.forEach((value, index) => {
                        writeText(value, columnX + 5, currentY + 5, widths[index] - 10, {
                            size, bold: highlighted || options.boldRows?.includes(rowIndex),
                            color: highlighted ? colors.navy : colors.ink,
                            align: options.rightAligned?.includes(index) ? 'right' : 'left',
                            maxHeight: rowHeight - 8
                        });
                        columnX += widths[index];
                    });
                    currentY += rowHeight;
                });
                doc.strokeColor(colors.line).lineWidth(0.6).rect(x, y, tableWidth, currentY - y).stroke();
                return currentY;
            }

            function drawProposalImage(assetName, x, y, width, height) {
                const imageBytes = proposalImages.get(assetName);
                if (!imageBytes) throw new Error(`Required proposal image is unavailable: ${assetName}`);
                doc.save();
                try {
                    doc.rect(x, y, width, height).clip();
                    doc.image(imageBytes, x, y, { cover: [width, height], align: 'center', valign: 'center' });
                } finally {
                    doc.restore();
                }
            }

            function drawDiagramBox(title, subtitle, x, y, width, height, fill = colors.white) {
                drawCard(x, y, width, height, { fill, stroke: '#cbd8e4', radius: 7 });
                writeText(title, x + 5, y + 10, width - 10, { size: 8, bold: true, color: colors.navy, align: 'center', maxHeight: 20 });
                writeText(subtitle, x + 5, y + 31, width - 10, { size: 6.5, color: colors.muted, align: 'center', maxHeight: height - 36 });
            }

            function drawArrow(x1, y, x2) {
                doc.strokeColor(colors.orange).lineWidth(2).moveTo(x1, y).lineTo(x2 - 6, y).stroke();
                doc.fillColor(colors.orange).moveTo(x2, y).lineTo(x2 - 7, y - 4).lineTo(x2 - 7, y + 4).fill();
            }

            function configuredComponents() {
                const labels = new Map([
                    ['solarPanels', 'Solar panels'], ['inverter', 'Inverter'], ['battery', 'Battery'],
                    ['structure', 'Mounting structure'], ['dcCable', 'DC cables'], ['acCable', 'AC cables'],
                    ['dcdb', 'DCDB'], ['acdb', 'ACDB'], ['mcbMccb', 'MCB / MCCB'], ['spd', 'Surge protection'],
                    ['earthing', 'Earthing'], ['lightningProtection', 'Lightning protection'],
                    ['connectors', 'Connectors'], ['junctionBoxes', 'Junction boxes'],
                    ['cableTrayConduit', 'Cable trays / conduits'], ['monitoring', 'Monitoring'],
                    ['installationAccessories', 'Installation accessories']
                ]);
                const rows = components.map((item) => ({
                    ...item,
                    label: labels.get(item.category) || item.category,
                    amount: 'To be confirmed'
                }));
                const addIfAbsent = (category, label, values) => {
                    if (!rows.some((item) => item.category === category) && Object.values(values).some(Boolean)) {
                        rows.push({ category, label, ...values, amount: 'To be confirmed' });
                    }
                };
                addIfAbsent('solarPanels', 'Solar panels', { brand: proposalDataSafe.panelBrand, rating: proposalDataSafe.panelWattage ? `${proposalDataSafe.panelWattage} W` : '', quantity: proposalDataSafe.panelCount, unit: 'pcs' });
                addIfAbsent('inverter', 'Inverter', { brand: proposalDataSafe.inverterBrand, sizeCapacity: proposalDataSafe.inverterCapacity ? `${proposalDataSafe.inverterCapacity} kW` : '', quantity: 1, unit: 'pcs' });
                addIfAbsent('structure', 'Mounting structure', { technicalSpecification: proposalDataSafe.structureType, quantity: 1, unit: 'set' });
                return rows;
            }

            function drawPhotoProductPage(pageIndex, title, asset, category, fallbackBrand, productData, note) {
                startPage(pageIndex);
                drawTitle(title, note);
                drawProposalImage(asset, left, 166, 244, 330);
                writeText(
                    'Representative stock photograph; not a model-specific product identification.',
                    left, 502, 244, { size: 6.5, color: colors.muted, align: 'center', maxHeight: 16 }
                );
                const infoX = left + 260;
                const infoWidth = contentWidth - 260;
                drawCard(infoX, 166, infoWidth, 330, { fill: colors.pale });
                writeText(fallbackBrand.toUpperCase(), infoX + 16, 183, infoWidth - 32, { size: 9, bold: true, color: colors.orange, maxHeight: 16 });
                writeText(productData.brand, infoX + 16, 211, infoWidth - 32, { size: 19, bold: true, color: colors.navy, maxHeight: 28 });
                const fields = [
                    ['Model', productData.model], ['Capacity / rating', productData.rating],
                    ['Technical specification', productData.specification], ['Quantity', productData.quantity],
                    ['Warranty', productData.warranty]
                ];
                fields.forEach(([label, value], index) => {
                    const y = 257 + index * 45;
                    writeText(label, infoX + 16, y, infoWidth - 32, { size: 7.5, bold: true, color: colors.muted, maxHeight: 12 });
                    writeText(value, infoX + 16, y + 14, infoWidth - 32, { size: 9, color: colors.ink, maxHeight: 27 });
                });
                if (category === 'inverter' && proposalDataSafe.batteryRequired) {
                    const battery = components.find((item) => item.category === 'battery');
                    const verified = battery?.compatibilityVerified === true;
                    drawCard(left, 520, contentWidth, 82, { fill: colors.paleOrange, stroke: '#f1c18f', accent: colors.orange });
                    writeText('BATTERY COMPATIBILITY', left + 16, 533, contentWidth - 32, { size: 8, bold: true, color: colors.orange, maxHeight: 12 });
                    writeText(verified ? 'Compatibility is recorded as verified in the saved proposal.' : 'To be confirmed against the exact inverter and battery manufacturer documentation.', left + 16, 552, contentWidth - 32, { size: 9, maxHeight: 38 });
                } else {
                    const datasheets = components.filter((item) => item.category === category && item.datasheetFileName).map((item) => item.datasheetFileName);
                    drawCard(left, 520, contentWidth, 82, { fill: colors.pale, accent: colors.orange });
                    writeText('DATASHEET REFERENCE', left + 16, 533, contentWidth - 32, { size: 8, bold: true, color: colors.orange, maxHeight: 12 });
                    writeText(datasheets.length ? datasheets.join(', ') : 'No datasheet attachment is recorded for this component.', left + 16, 552, contentWidth - 32, { size: 9, maxHeight: 38 });
                }
            }

            // 1. Premium cover
            startPage(1);
            const coverHeaderHeight = 70;
            const heroY = coverHeaderHeight;
            const heroHeight = 383;
            const heroBottom = heroY + heroHeight;
            const coverX = 28;
            const coverWidth = pageWidth - coverX * 2;
            const coverLocation = [proposalDataSafe.address, proposalDataSafe.city, proposalDataSafe.pincode]
                .filter(Boolean).join(', ');
            const coverCapacity = proposalDataSafe.systemCapacity
                ? `${textValue(proposalDataSafe.systemCapacity)} kW`
                : 'To be confirmed';
            const coverSystemType = `${textValue(proposalDataSafe.systemType)}${proposalDataSafe.systemCapacity
                ? ` (${textValue(proposalDataSafe.systemCapacity)} kW)` : ''}`;

            doc.fillColor(colors.deepNavy).rect(0, coverHeaderHeight, pageWidth, pageHeight - coverHeaderHeight).fill();
            doc.fillColor(colors.white).rect(0, 0, pageWidth, coverHeaderHeight).fill();
            doc.image(logoPath, 18, 2, { fit: [72, 66], align: 'center', valign: 'center' });
            writeText(companyName, 106, 15, 245, { size: 14, bold: true, color: colors.navy, maxHeight: 20 });
            writeText(companyWebsite, 106, 38, 245, { size: 9, color: colors.blue, maxHeight: 14 });
            doc.fillColor(colors.orange).roundedRect(389, 20, 3, 28, 1).fill();
            writeText('SOLAR POWER PROPOSAL', 404, 27, pageWidth - 442, {
                size: 10.5, bold: true, color: colors.navy, maxHeight: 16
            });
            doc.strokeColor(colors.line).lineWidth(0.7).moveTo(0, coverHeaderHeight).lineTo(pageWidth, coverHeaderHeight).stroke();

            drawProposalImage('luxury-villa-solar-pexels-19065333.jpeg', 0, heroY, pageWidth, heroHeight);
            doc.fillColor(colors.deepNavy).rect(0, 366, pageWidth, heroBottom - 366).fill();
            doc.fillColor(colors.deepNavy)
                .moveTo(0, 292).lineTo(380, 292).lineTo(450, 366).lineTo(0, 366).closePath().fill();
            doc.save();
            doc.fillColor(colors.orange)
                .moveTo(304, heroBottom)
                .bezierCurveTo(395, 441, 493, 383, pageWidth, 330)
                .lineTo(pageWidth, 363)
                .bezierCurveTo(496, 411, 402, 449, 304, heroBottom)
                .closePath().fill();
            doc.restore();
            writeText('SOLAR POWER', 45, 299, 320, { size: 32, bold: true, color: colors.white, maxHeight: 40 });
            writeText('PROPOSAL', 45, 335, 320, { size: 34, bold: true, color: '#ff9a2c', maxHeight: 42 });
            doc.strokeColor(colors.white).lineWidth(0.9).moveTo(45, 380).lineTo(220, 380).stroke();
            writeText('Residential Rooftop Solar System', 45, 389, 300, {
                size: 10, color: colors.white, maxHeight: 18
            });

            drawCard(coverX, 467, coverWidth, 94, { fill: colors.white, stroke: '#d9e1e7', radius: 10 });
            doc.fillColor(colors.orange).roundedRect(coverX + 17, 482, 5, 64, 2).fill();
            writeText('PREPARED FOR', coverX + 35, 480, coverWidth - 55, {
                size: 8.5, bold: true, color: colors.muted, maxHeight: 13
            });
            writeText(proposalDataSafe.customerName, coverX + 35, 497, coverWidth - 55, {
                size: 17, minSize: 9, bold: true, color: colors.navy, maxHeight: 25
            });
            writeText(`System Capacity: ${coverCapacity}     |     Proposal No: ${textValue(proposalNumber)}`,
                coverX + 35, 529, coverWidth - 55, {
                    size: 8.5, minSize: 6, color: colors.ink, maxHeight: 16
                });

            const infoGap = 18;
            const infoWidth = (coverWidth - infoGap) / 2;
            const firstInfoY = 574;
            const infoCardFill = '#f7faff';
            const infoCardStroke = '#dce6ef';
            const drawCalendarIcon = (x, y) => {
                doc.save();
                doc.strokeColor(colors.orange).lineWidth(1.6);
                doc.roundedRect(x, y + 2, 23, 21, 3).stroke();
                doc.moveTo(x + 1, y + 8).lineTo(x + 22, y + 8).stroke();
                doc.moveTo(x + 6, y).lineTo(x + 6, y + 5).stroke();
                doc.moveTo(x + 17, y).lineTo(x + 17, y + 5).stroke();
                doc.fillColor(colors.orange);
                [[6, 13], [12, 13], [6, 18], [12, 18]].forEach(([dx, dy]) => {
                    doc.circle(x + dx, y + dy, 1).fill();
                });
                doc.restore();
            };
            const drawLocationIcon = (x, y) => {
                const centerX = x + 11;
                doc.save();
                doc.strokeColor(colors.orange).lineWidth(1.7);
                doc.circle(centerX, y + 8, 6).stroke();
                doc.moveTo(centerX - 4, y + 12).lineTo(centerX, y + 23).lineTo(centerX + 4, y + 12).stroke();
                doc.fillColor(colors.orange).circle(centerX, y + 8, 1.7).fill();
                doc.restore();
            };
            const drawSystemIcon = (x, y) => {
                doc.save();
                doc.strokeColor(colors.orange).lineWidth(1.5);
                [0, 7, 14].forEach((offset) => {
                    const rowY = y + offset;
                    doc.moveTo(x + 11, rowY).lineTo(x + 21, rowY + 5)
                        .lineTo(x + 11, rowY + 10).lineTo(x + 1, rowY + 5).closePath().stroke();
                });
                doc.restore();
            };
            const drawCoverInfoCard = (label, value, x, y, width, height, icon, fullWidth = false) => {
                drawCard(x, y, width, height, { fill: infoCardFill, stroke: infoCardStroke, radius: 8 });
                const iconX = x + (fullWidth ? 36 : 20);
                const iconY = y + Math.max(12, (height - 24) / 2);
                icon(iconX, iconY);
                const textX = x + (fullWidth ? 72 : 61);
                const valueWidth = width - (fullWidth ? 90 : 74);
                writeText(label, textX, y + 8, valueWidth, {
                    size: 9, bold: true, color: colors.navy, maxHeight: 13
                });
                writeText(value, textX, y + 25, valueWidth, {
                    size: fullWidth ? 12 : 11.5, minSize: 6, bold: true,
                    color: colors.ink, maxHeight: height - 28
                });
            };
            drawCoverInfoCard('Proposal Date', proposalDataSafe.proposalDate,
                coverX, firstInfoY, infoWidth, 76, drawCalendarIcon);
            drawCoverInfoCard('Project Location', coverLocation,
                coverX + infoWidth + infoGap, firstInfoY, infoWidth, 76, drawLocationIcon);
            drawCoverInfoCard('System Type', coverSystemType,
                coverX, 662, coverWidth, 62, drawSystemIcon, true);

            doc.strokeColor(colors.orange).lineWidth(1.1).moveTo(90, 744).lineTo(194, 744).stroke();
            doc.strokeColor(colors.orange).lineWidth(1.1).moveTo(pageWidth - 194, 744).lineTo(pageWidth - 90, 744).stroke();
            writeText(companyWebsite, 194, 737, pageWidth - 388, {
                size: 9, bold: true, color: colors.white, align: 'center', maxHeight: 15
            });
            writeText('Representative photographs are illustrative and do not identify project-selected equipment.',
                coverX, 761, coverWidth, {
                    size: 7, color: '#d8e3ee', align: 'center', maxHeight: 14
                });
            doc.strokeColor('#d8e3ee').lineWidth(0.7).moveTo(left, 789).lineTo(right, 789).stroke();
            doc.font('Helvetica').fontSize(7).fillColor('#d8e3ee').text('1 / 12', left, 801, { lineBreak: false });
            doc.font('Helvetica').fontSize(7).fillColor('#d8e3ee').text(`${companyName}  |  Solar Proposal`, right - 250, 801, { width: 250, align: 'right', lineBreak: false });

            // 2. Welcome and executive summary
            startPage(2);
            drawTitle('Welcome', 'A personal introduction from Inpace Power Pvt Ltd.');
            drawCard(left, 155, contentWidth, 91, { fill: colors.pale, stroke: colors.line });
            const welcomeLocation = textValue(proposalDataSafe.city, proposalDataSafe.address);
            const welcomeDetails = [
                ['REFERENCE', proposalNumber], ['CUSTOMER', proposalDataSafe.customerName],
                ['LOCATION', welcomeLocation],
                ['SYSTEM', `${textValue(proposalDataSafe.systemCapacity ? `${proposalDataSafe.systemCapacity} kW` : '')} ${textValue(proposalDataSafe.systemType)}`],
                ['PROPOSAL DATE', proposalDataSafe.proposalDate], ['LEAD NUMBER', proposalDataSafe.leadNumber]
            ];
            const welcomeColumnWidth = (contentWidth - 30) / 2;
            welcomeDetails.forEach(([label, value], index) => {
                const column = index % 2;
                const row = Math.floor(index / 2);
                const x = left + 12 + column * (welcomeColumnWidth + 6);
                const y = 162 + row * 27;
                writeText(label, x, y, welcomeColumnWidth, { size: 6.5, bold: true, color: colors.muted, maxHeight: 10 });
                writeText(value, x, y + 10, welcomeColumnWidth, { size: 8, bold: true, color: colors.navy, maxHeight: 15 });
            });
            const welcomeLetter = [
                `Subject: Proposal for ${textValue(proposalDataSafe.systemCapacity ? `${proposalDataSafe.systemCapacity} kW` : '')} ${textValue(proposalDataSafe.systemType)}`,
                `Kind Attn: ${textValue(proposalDataSafe.customerName)}`,
                'Hi,',
                'Greetings from Inpace Power Pvt Ltd!',
                'Thank you for your interest in Inpace Energy. We are excited to work with you toward saving the planet.',
                'We can only identify ourselves as a sustainable company by working together with customers like you, who are actually the ones leading the energy transition for the world by choosing sustainable products. Further to the discussions to date, the document herewith contains our final Residential proposal that has been specially curated for you.',
                'At Inpace Energy, the customer always comes first. Our goal is to provide exceptional services to each of our customers and be present at every step of the solar journey that our customers embark upon.',
                'We believe the world will be a safer place and we can save the planet from climate change with individual leaders like you. Once again, thank you for giving us this opportunity to be working together with you to restore and revive our planet.',
                "In case, you have any further questions, please don't hesitate to reach out to us.",
                'Yours sincerely,\nInpace Energy\n+91-8618196685\nEmail: To be confirmed'
            ].join('\n\n');
            const letterEnd = writeText(welcomeLetter, left, 260, contentWidth, { size: 8, minSize: 7, lineGap: 1, maxHeight: 395 });
            const companyProfileY = letterEnd + 10;
            drawCard(left, companyProfileY, contentWidth, 73, { fill: colors.white, stroke: colors.line, accent: colors.orange });
            writeText('COMPANY PROFILE · CONFIRM COPY BEFORE CUSTOMER RELEASE', left + 13, companyProfileY + 9, contentWidth - 26, { size: 6.5, bold: true, color: colors.orange, maxHeight: 11 });
            writeText('We have been in the solar industry for 8 plus years serving clients across India in various sectors to optimize their production efficiency by offering a clean source of energy for electricity generation. Some of our clients include but are not limited to NTPC, BHEL, Wipro, Amway, Indian Railways, Standard Chartered, REIL, etc.', left + 13, companyProfileY + 25, contentWidth - 26, { size: 7.2, maxHeight: 39 });

            // 3. Project overview and benefits
            startPage(3);
            drawTitle('Project Overview & Benefits', 'A clean, cost-effective energy solution for the property.');
            drawProposalImage('solar-rooftop.jpeg', left, 162, contentWidth, 198);
            const benefits = [
                ['Lower electricity bills', 'Solar generation may offset a portion of grid electricity use. Actual savings depend on consumption, tariff and export rules.'],
                ['Renewable energy', 'On-site solar uses a renewable energy source. Actual production varies with weather, shading and orientation.'],
                ['Greater energy independence', 'On-site generation may reduce grid reliance during production hours. Backup is not implied without verified equipment.'],
                ['Long-term savings', 'Long-term value depends on recorded system cost, use, maintenance, tariffs and operating conditions.']
            ];
            const gap = 12;
            const cardW = (contentWidth - gap) / 2;
            benefits.forEach(([heading, copy], index) => {
                const x = left + (index % 2) * (cardW + gap);
                const y = 378 + Math.floor(index / 2) * 132;
                drawCard(x, y, cardW, 116, { fill: index % 2 ? colors.pale : colors.white, accent: index % 2 ? colors.navy : colors.orange });
                writeText(heading, x + 15, y + 14, cardW - 28, { size: 10, bold: true, color: colors.navy, maxHeight: 28 });
                writeText(copy, x + 15, y + 47, cardW - 28, { size: 8, color: colors.ink, maxHeight: 58 });
            });
            const overviewMetrics = pricing.projectMetrics || {};
            writeText(
                `Representative stock photograph only; site-specific production and savings are not guaranteed.\nSavings assumptions: ${textValue(overviewMetrics.savingsAssumptions)}`,
                left, 647, contentWidth, { size: 6.5, color: colors.muted, maxHeight: 30 }
            );
            const overviewMetricRows = [
                ['Daily generation', numericValue(overviewMetrics.dailyGenerationKwh) > 0 ? `${overviewMetrics.dailyGenerationKwh} kWh` : ''],
                ['Monthly generation', numericValue(overviewMetrics.monthlyGenerationKwh) > 0 ? `${overviewMetrics.monthlyGenerationKwh} kWh` : ''],
                ['Annual generation', numericValue(overviewMetrics.annualGenerationKwh) > 0 ? `${overviewMetrics.annualGenerationKwh} kWh` : ''],
                ['Monthly savings', currency(proposalDataSafe.monthlySavings, true)],
                ['Annual savings', currency(proposalDataSafe.annualSavings, true)],
                ['Simple payback', overviewMetrics.performanceInputsVerified && numericValue(overviewMetrics.paybackYears) > 0 ? `${Number(overviewMetrics.paybackYears).toFixed(1)} years` : '']
            ];
            overviewMetricRows.forEach(([label, value], index) => {
                const column = index % 3;
                const row = Math.floor(index / 3);
                const cardWidth = (contentWidth - 16) / 3;
                drawLabeledValue(label, value, left + column * (cardWidth + 8), 681 + row * 50, cardWidth, 44, {
                    fill: row ? colors.paleGreen : colors.pale, valueSize: 8
                });
            });

            // 4. Premium components and safety norms
            startPage(4);
            drawTitle('Premium Components and Strong Adherence to Safety Norms', 'Preferred makes and safety provisions are subject to confirmed selection and project documentation.');
            const componentRows = [
                ['Solar panels', 'ALMM listing and selected model to be verified.', 'Waaree / Saatvik', 'Equivalent approved make', 'Confirm model and rating.'],
                ['Inverter', 'Type and rating to match the approved design.', 'Deye / Feston', 'Local make string inverter', 'Confirm selected topology.'],
                ['Battery storage', 'Lithium-ion (LFP); capacity and compatibility to be confirmed.', 'Deye', 'Lead-acid', 'Warranty subject to OEM proof.'],
                ['Fabricated structures', 'Design and fixing to suit the surveyed site.', 'Local make', 'To be confirmed', 'Site engineering required.'],
                ['Cable ties', 'Specification to approved design.', 'Local make', 'To be confirmed', 'Project schedule applies.'],
                ['Cables', 'Type and rating to approved electrical design.', 'Local make', 'To be confirmed', 'Confirm route and sizing.'],
                ['Screw anchor systems', 'Site-specific anchor selection and design.', 'Local make', 'To be confirmed', 'Structural review required.'],
                ['PVC conduits', 'Type and route to approved design.', 'Local make', 'To be confirmed', 'Confirm site conditions.'],
                ['Fuses', 'Ratings to approved electrical design.', 'Local make', 'To be confirmed', 'Confirm protection study.']
            ];
            const componentTableEnd = drawTable(
                ['Component', 'Features / specifications', 'Preferred make', 'Alternative make', 'Remarks'],
                componentRows, left, 153, [79, 159, 91, 94, 96],
                { size: 6.5, headerSize: 6.1, headerHeight: 28, rowHeight: 27 }
            );
            const safetyY = componentTableEnd + 13;
            const safetyGap = 8;
            const safetyWidth = (contentWidth - safetyGap * 2) / 3;
            const safetyCards = [
                ['SYSTEM SAFETY', 'Check applicable BIS / EN evidence against the selected product documentation. Provide surge protective devices, lightning arresters and other applicable electrical protection as specified by the approved design.'],
                ['PERSONNEL SAFETY', 'Use appropriate safety equipment during construction and maintenance. Safety lines and walkways must be selected for site conditions and documented before rooftop work.'],
                ['CUSTOMER SAFETY', 'Apply customer-safety controls during installation and after handover. MCBs, harnesses, polymer rope and an installed point anchor with rope-grab arrester require site and engineering validation.']
            ];
            safetyCards.forEach(([heading, copy], index) => {
                const x = left + index * (safetyWidth + safetyGap);
                drawCard(x, safetyY, safetyWidth, 207, { fill: index === 1 ? colors.pale : colors.white, accent: index === 2 ? colors.orange : colors.navy });
                writeText(heading, x + 11, safetyY + 13, safetyWidth - 22, { size: 7, bold: true, color: colors.orange, maxHeight: 13 });
                writeText(copy, x + 11, safetyY + 35, safetyWidth - 22, { size: 7.1, maxHeight: 153 });
            });
            writeText('Reputed make equivalent to the above will be used.', left, safetyY + 211, contentWidth, { size: 7, bold: true, color: colors.navy, maxHeight: 12 });
            drawApprovalNote(
                'DOCUMENTATION / APPROVAL REQUIRED',
                'All product, safety and warranty claims require selected-model evidence and company approval before customer release.',
                left, safetyY + 227, contentWidth, 48
            );

            // 5. Operations and maintenance
            startPage(5);
            drawTitle('Operations & Maintenance', 'Service scope, performance and life claims apply only when documented in the approved agreement.');
            drawCard(left, 157, contentWidth, 58, { fill: colors.navy, stroke: colors.navy });
            writeText('“We are your site custodian. Our in-house remote operations team and an on-ground fleet of engineers take care of your system and provide a hassle-free experience.”', left + 15, 169, contentWidth - 30, { size: 8.5, color: colors.white, maxHeight: 38 });
            const claimGap = 9;
            const claimWidth = (contentWidth - claimGap * 2) / 3;
            const claims = [
                ['PERFORMANCE', '“Up to 30% higher performance” is a company claim, not a guaranteed result.'],
                ['LIFE SUPPORT', '“Up to 40% longer life” requires substantiation and approved contractual terms.'],
                ['PR GUARANTEE', 'Only a specified level in a signed performance guarantee is enforceable.']
            ];
            claims.forEach(([heading, copy], index) => {
                const x = left + index * (claimWidth + claimGap);
                drawCard(x, 226, claimWidth, 91, { fill: index === 1 ? colors.pale : colors.white, accent: colors.orange });
                writeText(heading, x + 11, 237, claimWidth - 22, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
                writeText(copy, x + 11, 255, claimWidth - 22, { size: 7.2, maxHeight: 52 });
            });
            drawCard(left, 329, contentWidth, 86, { fill: colors.pale });
            writeText('MONITORING AND MAINTENANCE', left + 13, 340, contentWidth - 26, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            writeText('We will help you measure and track your plant performance through our monitoring portal. We take care of system monitoring, scheduled maintenance visits, breakdown maintenance and cleaning to ensure optimum performance of your solar plant. We believe our systems provide the best performance and we also provide performance ratio guarantee with the below features and benefits.', left + 13, 358, contentWidth - 26, { size: 7.6, maxHeight: 48 });
            drawCard(left, 427, contentWidth, 131, { fill: colors.white, accent: colors.navy });
            writeText('PERFORMANCE-RATIO SERVICE BENEFITS · SUBJECT TO SIGNED TERMS', left + 13, 439, contentWidth - 26, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            const omBenefits = [
                'System performance above a specified level only where the signed guarantee defines it.',
                'Comprehensive AMC for corrective on-site maintenance only when included in the contract.',
                'Generation-shortfall compensation only if expressly covered by the signed guarantee.',
                'Fortnightly cleaning and preventive visits only when specified in the approved service terms.',
                'Response and resolution targets only as stated in the approved service agreement.'
            ];
            writeText(omBenefits.map((item) => `• ${item}`).join('\n'), left + 14, 459, contentWidth - 28, { size: 7.1, maxHeight: 88 });
            const featureY = 570;
            const featureGap = 8;
            const featureWidth = (contentWidth - featureGap * 3) / 4;
            const serviceFeatures = [
                ['SHADOW ANALYSIS', 'SolarLab'],
                ['DESIGN REVIEW', '3D model report'],
                ['FINANCING', 'Easy financing / No Cost EMI, subject to provider approval.'],
                ['3-YEAR O&M', 'Free cleaning and maintenance only under the approved contract.']
            ];
            serviceFeatures.forEach(([heading, copy], index) => {
                const x = left + index * (featureWidth + featureGap);
                drawCard(x, featureY, featureWidth, 95, { fill: index % 2 ? colors.pale : colors.white });
                writeText(heading, x + 8, featureY + 10, featureWidth - 16, { size: 6.4, bold: true, color: colors.orange, maxHeight: 18 });
                writeText(copy, x + 8, featureY + 34, featureWidth - 16, { size: 6.8, maxHeight: 48 });
            });
            drawApprovalNote(
                'COMPANY / CONTRACT APPROVAL REQUIRED',
                'Performance, life, cleaning, financing and response-time statements are not unconditional commitments. Validate evidence, scope, exclusions and the signed agreement before release.',
                left, 677, contentWidth, 83
            );

            // 6. Proposed system design and technical details
            startPage(6);
            drawTitle('Proposed System Design / Technical Details', 'Project-specific configuration shown from the saved proposal; final engineering is subject to site review.');
            drawProposalImage('solar-rooftop.jpeg', left, 163, 187, 119);
            writeText('Representative stock photograph; not a site design.', left, 287, 187, { size: 6.4, color: colors.muted, align: 'center', maxHeight: 14 });
            const selectedPanel = components.find((item) => item.category === 'solarPanels');
            const selectedInverter = components.find((item) => item.category === 'inverter');
            const detailGap = 8;
            const detailWidth = (contentWidth - 195 - detailGap) / 2;
            const detailX = left + 195;
            const systemDetails = [
                ['System type', proposalDataSafe.systemType],
                ['System capacity', proposalDataSafe.systemCapacity ? `${proposalDataSafe.systemCapacity} kW` : ''],
                ['Solar modules', [proposalDataSafe.panelBrand, selectedPanel?.model, proposalDataSafe.panelWattage ? `${proposalDataSafe.panelWattage} W` : '', proposalDataSafe.panelCount ? `${proposalDataSafe.panelCount} pcs` : ''].filter(Boolean).join(' · ')],
                ['Inverter', [proposalDataSafe.inverterBrand, selectedInverter?.model, proposalDataSafe.inverterCapacity ? `${proposalDataSafe.inverterCapacity} kW` : ''].filter(Boolean).join(' · ')]
            ];
            systemDetails.forEach(([label, value], index) => {
                const column = index % 2;
                const row = Math.floor(index / 2);
                drawLabeledValue(label, value, detailX + column * (detailWidth + detailGap), 163 + row * 62, detailWidth, 54, {
                    fill: row ? colors.pale : colors.white, valueSize: 8
                });
            });
            drawCard(left, 321, contentWidth, 31, { fill: colors.navy, stroke: colors.navy });
            writeText('CONCEPTUAL SYSTEM ARCHITECTURE · NOT A FINAL ENGINEERING SINGLE-LINE DIAGRAM', left + 12, 331, contentWidth - 24, { size: 7, bold: true, color: colors.white, maxHeight: 13 });
            const isHybridSystem = String(proposalDataSafe.systemType || '').toLowerCase() === 'hybrid';
            const flowBoxY = 372;
            const flowBoxWidth = 72;
            const flowBoxHeight = 75;
            const flowArrowWidth = (contentWidth - flowBoxWidth * 6) / 5;
            const architectureFlow = [
                ['PV panels', proposalDataSafe.panelCount ? `${proposalDataSafe.panelCount} modules` : 'To be confirmed'],
                ['DC protection', 'Design / rating to confirm'],
                [isHybridSystem ? 'Hybrid inverter' : 'Inverter', [proposalDataSafe.inverterBrand, selectedInverter?.model].filter(Boolean).join(' ') || 'To be confirmed'],
                ['AC protection', 'Design / rating to confirm'],
                ['Site loads', 'Distribution to confirm'],
                ['Grid connection', proposalDataSafe.netMetering ? 'Net metering selected' : 'To be confirmed']
            ];
            architectureFlow.forEach(([heading, detail], index) => {
                const x = left + index * (flowBoxWidth + flowArrowWidth);
                drawDiagramBox(heading, detail, x, flowBoxY, flowBoxWidth, flowBoxHeight, index === 0 ? colors.paleOrange : colors.pale);
                if (index < architectureFlow.length - 1) drawArrow(x + flowBoxWidth + 2, flowBoxY + flowBoxHeight / 2, x + flowBoxWidth + flowArrowWidth - 2);
            });
            const battery = components.find((item) => item.category === 'battery') || {};
            if (isHybridSystem || proposalDataSafe.batteryRequired) {
                const inverterCenter = left + 2 * (flowBoxWidth + flowArrowWidth) + flowBoxWidth / 2;
                const batteryWidth = 220;
                const batteryX = Math.max(left, Math.min(inverterCenter - batteryWidth / 2, right - batteryWidth));
                doc.strokeColor(colors.orange).lineWidth(1.2).moveTo(inverterCenter, flowBoxY + flowBoxHeight).lineTo(inverterCenter, 486).stroke();
                drawCard(batteryX, 486, batteryWidth, 43, { fill: colors.paleOrange, stroke: '#f2c08e', accent: colors.orange });
                writeText('BATTERY STORAGE', batteryX + 10, 493, batteryWidth - 20, { size: 6.7, bold: true, color: colors.orange, maxHeight: 11 });
                writeText([battery.brand, battery.model, battery.sizeCapacity || proposalDataSafe.batteryCapacity].filter(Boolean).join(' · '), batteryX + 10, 507, batteryWidth - 20, { size: 7, maxHeight: 16 });
            }
            drawApprovalNote(
                'TECHNICAL REVIEW REQUIRED',
                'Protection coordination, wiring, metering, earthing, battery compatibility and equipment interfaces must be checked against approved drawings and selected-model documentation. Missing ratings remain To be confirmed.',
                left, 550, contentWidth, 90
            );

            // 7. Payment options and terms
            startPage(7);
            drawTitle('Payment Option and Terms', 'Bank details and the saved proposal payment schedule are shown separately from company-provided reference terms.');
            drawCard(left, 156, contentWidth, 88, { fill: colors.pale, accent: colors.orange });
            writeText('BANK DETAILS', left + 13, 166, contentWidth - 26, { size: 7.5, bold: true, color: colors.orange, maxHeight: 12 });
            const bankDetails = [
                ['Bank name', 'IDFC, Yelahanka Branch - Bangalore'],
                ['Account holder', 'INPACE POWER PVT LTD'],
                ['Account number', '10202029313'],
                ['IFSC', 'IDFB0080191'],
                ['GST', '29AAHC18907N1ZS']
            ];
            bankDetails.forEach(([label, value], index) => {
                const column = index % 2;
                const row = Math.floor(index / 2);
                const x = left + 13 + column * (contentWidth / 2);
                const y = 184 + row * 18;
                writeText(`${label}: ${value}`, x, y, contentWidth / 2 - 20, { size: 7.1, color: colors.ink, maxHeight: 12 });
            });
            writeText(`Saved proposal terms: ${[proposalDataSafe.paymentTerms, proposalDataSafe.customPaymentTerms].filter(Boolean).join(' — ')}`, left, 254, contentWidth, { size: 7.5, maxHeight: 30 });
            writeText(`BOOKING AMOUNT: ${currency(proposalDataSafe.bookingAmount, true)}     |     Validity: ${numericValue(proposalDataSafe.validityDays) > 0 ? `${proposalDataSafe.validityDays} days` : 'To be confirmed'}`, left, 286, contentWidth, { size: 7.5, bold: true, color: colors.navy, maxHeight: 16 });
            const payments = Array.isArray(proposalDataSafe.paymentSchedule) ? proposalDataSafe.paymentSchedule.map((milestone) => [
                milestone.label, milestone.type === 'percentage' ? `${milestone.value}%` : 'Fixed amount', currency(milestone.amount)
            ]) : [];
            writeText('CRM-SAVED PAYMENT SCHEDULE', left, 308, contentWidth, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            let savedScheduleEnd = 338;
            if (payments.length) {
                savedScheduleEnd = drawTable(['Milestone', 'Basis', 'Amount (INR)'], payments, left, 324, [contentWidth - 210, 80, 130], {
                    size: 7.2, rowHeight: 21, rightAligned: [2]
                });
            } else {
                drawCard(left, 324, contentWidth, 35, { fill: colors.pale });
                writeText('Structured payment milestones: To be confirmed.', left + 12, 334, contentWidth - 24, { size: 7.5, maxHeight: 15 });
            }
            const paymentTermsY = Math.max(savedScheduleEnd + 12, 376);
            const companyPaymentTerms = [
                '30% (Thirty Percent) advance on execution of this order.',
                '65% (Sixty Five Percent) less advance payment against Proforma Invoice (PI) before dispatch of solar panels, inverters and other BoS items to be delivered under this order.',
                '5% (Five Percent) after installation and commissioning of the Solar Power Plant.',
                'The order value and payment terms are fixed and will not be subject to any adjustment except as approved in writing by the Company.',
                "The payment shall be made only through bankers' cheque / NEFT / RTGS / online payment portal as intimated by Inpace Energy. No cash payments shall be accepted by Inpace Energy or its representatives.",
                'The Customer may cancel this Order within 7 (seven) days from the date of remittance of advance money or the date of accepting this order, whichever is earlier.',
                'If this Order is cancelled after the expiry of 7 (seven) days from the date of its acceptance but prior to dispatch of Goods, the Customer shall be liable to pay the following amounts to Inpace Energy as a cancellation fee: (a) INR 25,000/- (Indian Rupees Twenty-Five Thousand Only) OR 5% (five percent) of the total order value, whichever is higher; and (b) costs and expenses incurred by Inpace Energy in relation to this Order, including costs for labour, design, return of products, administrative costs and subvention costs.',
                'Notwithstanding the aforesaid, the Customer shall not be entitled to cancel this Order after Inpace Energy has dispatched the Goods to the Customer Site. If Customer chooses to terminate this Order after dispatch, Inpace Energy shall be entitled to forfeit the entire amount paid by the Customer till date.',
                'Inpace shall supply and install the Solar Power Plant within 20 to 30 days from the date of execution of this Order Form or receipt of booking advance or site readiness date, whichever is later.'
            ].join('\n\n');
            const paymentTermsHeight = contentBottom - paymentTermsY;
            drawCard(left, paymentTermsY, contentWidth, paymentTermsHeight, { fill: colors.white, stroke: colors.line });
            writeText('COMPANY-PROVIDED REFERENCE TERMS · LEGAL / COMPANY APPROVAL REQUIRED', left + 12, paymentTermsY + 9, contentWidth - 24, { size: 6.7, bold: true, color: colors.orange, maxHeight: 13 });
            writeText('These supplied terms do not replace or alter the saved proposal schedule above. Confirm applicability and approve before customer release.', left + 12, paymentTermsY + 25, contentWidth - 24, { size: 6.5, bold: true, color: colors.navy, maxHeight: 22 });
            writeText(companyPaymentTerms, left + 12, paymentTermsY + 51, contentWidth - 24, { size: 6.6, minSize: 6.1, maxHeight: paymentTermsHeight - 60 });

            // 8. After-sales service
            startPage(8);
            drawTitle('After-Sales Service', 'Service and warranty statements below are subject to the approved O&M agreement and selected OEM terms.');
            drawProposalImage('support-engineer.jpeg', left, 160, 177, 123);
            writeText('Representative stock photograph.', left, 288, 177, { size: 6.5, color: colors.muted, align: 'center', maxHeight: 13 });
            drawCard(left + 189, 160, contentWidth - 189, 141, { fill: colors.pale });
            writeText('SUPPORT CONTACT', left + 202, 171, contentWidth - 215, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            writeText('Call: +91-8618196685\nSupport email: To be confirmed', left + 202, 190, contentWidth - 215, { size: 8, bold: true, color: colors.navy, maxHeight: 32 });
            writeText('During three years, Inpace Energy shall provide free service visits to attend to system abnormalities, subject to the approved O&M agreement.', left + 202, 231, contentWidth - 215, { size: 7.1, maxHeight: 55 });
            drawCard(left, 316, contentWidth, 84, { fill: colors.white, accent: colors.navy });
            writeText('SERVICE SCOPE · SUBJECT TO AGREEMENT', left + 13, 327, contentWidth - 26, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            writeText('First-year tele-calling support for complaints and queries; online support within 24 hours; service-call response within 72 hours; and three-year O&M with a 90-day cleaning and preventive-maintenance visit. Confirm actual response commitments, visit frequency and included services in the approved contract.', left + 13, 346, contentWidth - 26, { size: 7.3, maxHeight: 42 });
            const warrantyReferenceRows = [
                ['Entire system', 'One year from installation, subject to contract terms.'],
                ['Solar panels', '27-year linear power output warranty; 10-year product warranty, subject to OEM documents.'],
                ['Grid-tied inverter', '7-year warranty; extended warranty may be available at additional cost.'],
                ['Microinverter', '25-year product warranty, subject to selected model.'],
                ['LFP battery pack', '15-year product warranty, subject to selected model.'],
                ['Output degradation', 'Supplied claim: 97.5% in year one, decreasing 0.55% annually; 84.3% by year 25. Verify OEM methodology.']
            ];
            drawTable(['Warranty / reference', 'Supplied duration or statement'], warrantyReferenceRows, left, 415, [153, contentWidth - 153], {
                size: 7, headerSize: 6.7, rowHeight: 29
            });
            drawApprovalNote(
                'OEM VERIFICATION REQUIRED BEFORE CUSTOMER RELEASE',
                'All warranty durations and degradation figures are reference claims only. Verify each selected manufacturer, model, warranty document, exclusions and effective date. “As per OEM Terms & Conditions.”',
                left, 687, contentWidth, 73
            );

            // 9. Scope of work
            startPage(9);
            drawTitle('Scope of Work', 'Responsibility assignments not explicit in the supplied source are marked To be confirmed.');
            const responsibilityRows = [
                ['1', 'Remote monitoring platform and support.', 'To be confirmed', 'To be confirmed', 'Coverage and platform access per approved scope.'],
                ['2', 'Tele-calling for complaints, queries and customer feedback.', 'To be confirmed', 'To be confirmed', 'Confirm support hours and service channels.'],
                ['3', 'Documentation support for statutory clearances.', 'Support', 'To be confirmed', 'Support does not guarantee authority approval.'],
                ['4', 'Shadow-free roof, clear space, equipment area, secure storage and site access.', 'To be confirmed', 'To be confirmed', 'Confirm after site survey.'],
                ['5', 'Feeder, distribution-board connection and internet connectivity to inverter.', 'To be confirmed', 'To be confirmed', 'Confirm interfaces and internet availability.'],
                ['6', 'Power, water, structural changes and earth excavation, as applicable.', 'To be confirmed', 'To be confirmed', 'Confirm exact civil scope and cost owner.'],
                ['7', 'DISCOM changes, meters / CTPT and connected-load increase at actual DISCOM estimate.', '—', 'Customer pays actual estimate', 'Subject to DISCOM assessment and approval.'],
                ['8', 'CEIG approval, if necessary.', 'Support with liaison', 'To be confirmed', 'Approval remains with the authority.'],
                ['9', 'Cleaning once or twice a week depending on local conditions.', 'To be confirmed', 'To be confirmed', 'Only if consistent with module OEM instructions.']
            ];
            const scopeTableEnd = drawTable(
                ['No.', 'Responsibility / scope', 'Inpace Energy', 'Customer', 'Remarks'],
                responsibilityRows, left, 153, [23, 170, 75, 78, 173],
                { size: 6.25, headerSize: 5.9, headerHeight: 29, rowHeight: 27 }
            );
            const exclusionY = scopeTableEnd + 12;
            drawCard(left, exclusionY, contentWidth, 94, { fill: colors.pale });
            writeText('EXCLUSIONS / CUSTOMER-RELEASE CHECK', left + 12, exclusionY + 10, contentWidth - 24, { size: 7, bold: true, color: colors.orange, maxHeight: 12 });
            writeText('SIM / internet charges for GSM access; additional AC / DC / earthing cable and conduits; net-meter / bi-directional meter costs; state DISCOM registration / application fees; system insurance; and any item not explicitly included in the approved project scope. Confirm exclusions, cleaning instructions and responsibility assignments against the signed scope. Detergents, soaps and additives must not be used if prohibited by the module manufacturer.', left + 12, exclusionY + 29, contentWidth - 24, { size: 7, maxHeight: 54 });

            // 10. Commercial proposal
            startPage(10);
            drawTitle('Commercial Proposal', `Investment summary${proposalDataSafe.systemCapacity ? ` for ${proposalDataSafe.systemCapacity} kW` : ''} solar system.`);
            const commercialRows = proposalCommercialLines(pricing, proposalDataSafe.systemCapacity)
                .filter(({ label }) => !/^Net Investment$/i.test(label)
                    && (!/estimated PM Surya Ghar benefit/i.test(label) || (isSubsidyVerified && subsidyAmount > 0)))
                .map(({ label, amount }) => [label, currency(amount)]);
            const finalPayable = proposalDataSafe.finalAmount ?? pricing.finalAmount ?? pricing.finalPayable;
            const rows = commercialRows.length ? commercialRows : [['Final Payable', currency(finalPayable)]];
            const tableEnd = drawTable(['Price component', 'Amount (INR)'], rows, left, 166, [contentWidth - 155, 155], {
                size: 8.5, rowHeight: 24, rightAligned: [1],
                highlightRows: rows.map((row, index) => /^Gross Amount$/i.test(row[0]) ? index : -1).filter((index) => index >= 0)
            });
            drawCard(left, Math.max(tableEnd + 20, 566), contentWidth, 67, { fill: colors.orange, stroke: colors.orange });
            writeText('FINAL PAYABLE AMOUNT', left + 16, Math.max(tableEnd + 31, 577), contentWidth - 32, { size: 8, bold: true, color: colors.white, maxHeight: 14 });
            writeText(currency(finalPayable), left + 16, Math.max(tableEnd + 49, 595), contentWidth - 32, { size: 19, bold: true, color: colors.white, align: 'right', maxHeight: 29 });
            if (isSubsidyVerified && subsidyAmount > 0) {
                const subsidyY = Math.max(tableEnd + 98, 647);
                drawCard(left, subsidyY, contentWidth, 48, { fill: colors.paleGreen, stroke: '#c6e2d0' });
                writeText(`Estimated government benefit: ${currency(subsidyAmount)} — subject to eligibility and official approval; separate from contract price.`, left + 12, subsidyY + 12, contentWidth - 24, { size: 8, bold: true, color: colors.ink, maxHeight: 28 });
            }

            // 11. Bill of materials
            startPage(11);
            drawTitle('Bill of Materials', 'Saved equipment, quantities and datasheet references; photographs are representative only.');
            const photoGap = 8;
            const photoCardWidth = (contentWidth - photoGap * 3) / 4;
            const bomPhotos = [
                ['solar-modules.jpeg', 'Solar modules'],
                ['solar-inverter.jpeg', 'Inverter'],
                ['mounting-structure.jpeg', 'Mounting structure'],
                ['electrical-components.jpeg', 'Electrical components']
            ];
            bomPhotos.forEach(([assetName, caption], index) => {
                const x = left + index * (photoCardWidth + photoGap);
                drawCard(x, 158, photoCardWidth, 100, { fill: colors.pale });
                drawProposalImage(assetName, x + 7, 165, photoCardWidth - 14, 65);
                writeText(caption, x + 7, 235, photoCardWidth - 14, { size: 6.5, bold: true, color: colors.navy, align: 'center', maxHeight: 17 });
            });
            writeText('Representative stock photos do not identify selected models. Mounting photograph: Robert Scoble, “Photovoltaic mounting system,” Wikimedia Commons, CC BY 2.0 (creativecommons.org/licenses/by/2.0/). No unrecorded component prices are allocated.', left, 266, contentWidth, { size: 6.2, color: colors.muted, maxHeight: 27 });
            const bom = configuredComponents().map((item, index) => [
                String(index + 1), item.label,
                [item.brand, item.model].filter(Boolean).join(' / '),
                [item.technicalSpecification, item.rating, item.sizeCapacity, item.datasheetFileName ? `Datasheet: ${item.datasheetFileName}` : ''].filter(Boolean).join(' / '),
                item.quantity ? `${item.quantity} ${item.unit || ''}`.trim() : 'To be confirmed',
                'See quotation'
            ]);
            if (!bom.length) bom.push(['1', 'System equipment', 'To be confirmed', 'To be confirmed', 'To be confirmed', 'See quotation']);
            drawTable(['#', 'Item / component', 'Brand / model', 'Specification / datasheet', 'Qty', 'Amount (INR)'], bom,
                left, 298, [24, 104, 100, 145, 58, 88],
                { size: 6.8, headerSize: 6.2, rowHeight: 23 });

            // 12. Customer acceptance and closing
            startPage(12);
            drawTitle('Customer Acceptance & Closing', 'Review the saved scope and terms before signing this proposal.');
            const included = configuredComponents().filter((item) => !['excluded', 'optional'].includes(item.inclusionStatus)).map((item) => item.label);
            const excluded = configuredComponents().filter((item) => item.inclusionStatus === 'excluded').map((item) => item.label);
            const scopeText = proposalDataSafe.scopeOfWork || 'To be confirmed in the approved project scope.';
            const termsText = proposalDataSafe.termsConditions || 'To be confirmed in the approved project terms.';
            const sections = [
                ['Scope of work', scopeText],
                ['Included equipment / items', included.join(', ') || 'To be confirmed'],
                ['Exclusions', excluded.join(', ') || 'Any items not explicitly included in the saved proposal are to be confirmed.'],
                ['Terms and conditions', termsText]
            ];
            let sectionY = 163;
            sections.forEach(([heading, value], index) => {
                const height = index === 0 || index === 3 ? 81 : 61;
                drawCard(left, sectionY, contentWidth, height, { fill: index % 2 ? colors.pale : colors.white, accent: index === 3 ? colors.orange : colors.navy });
                writeText(heading.toUpperCase(), left + 14, sectionY + 10, contentWidth - 28, { size: 7.5, bold: true, color: colors.orange, maxHeight: 13 });
                writeText(value, left + 14, sectionY + 29, contentWidth - 28, { size: 8.5, maxHeight: height - 36 });
                sectionY += height + 10;
            });
            if (isSubsidyVerified && subsidyAmount > 0) {
                writeText('Government benefit remains subject to applicable eligibility conditions and official approval.', left, 526, contentWidth, { size: 7.5, color: colors.muted, maxHeight: 24 });
            }
            drawCard(left, 574, contentWidth, 156, { fill: colors.paleOrange, stroke: '#f2c08e' });
            writeText('CUSTOMER ACCEPTANCE', left + 14, 587, contentWidth - 28, { size: 9, bold: true, color: colors.navy, maxHeight: 16 });
            writeText('I / We accept the above proposal, scope and terms.', left + 14, 608, contentWidth - 28, { size: 8, color: colors.ink, maxHeight: 18 });
            const signatureWidth = (contentWidth - 38) / 2;
            doc.strokeColor(colors.muted).lineWidth(0.7).moveTo(left + 14, 678).lineTo(left + signatureWidth, 678).stroke();
            doc.strokeColor(colors.muted).moveTo(left + signatureWidth + 24, 678).lineTo(right - 14, 678).stroke();
            writeText('Customer signature / name', left + 14, 687, signatureWidth - 10, { size: 7.5, color: colors.muted, maxHeight: 13 });
            writeText('For Inpace Power Pvt Ltd', left + signatureWidth + 24, 687, signatureWidth - 10, { size: 7.5, color: colors.muted, maxHeight: 13 });
            writeText('Date: ____________________', left + 14, 709, signatureWidth - 10, { size: 7.5, color: colors.muted, maxHeight: 13 });
            writeText('Date: ____________________', left + signatureWidth + 24, 709, signatureWidth - 10, { size: 7.5, color: colors.muted, maxHeight: 13 });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

function proposalPricing(systemCapacity, values = {}) {
    return calculateConfiguredProposalPricing(systemCapacity, migrateLegacySolarPricing(readSettingsRecord().solarPricing), values);
}

function proposalView(row) {
    if (!row) return null;
    let pricing = {};
    let paymentSchedule = [];
    try { pricing = JSON.parse(row.pricing_json || '{}'); } catch (error) { pricing = {}; }
    try { paymentSchedule = JSON.parse(row.payment_schedule_json || '[]'); } catch (error) { paymentSchedule = []; }
    return {
        ...row,
        id: row.id, proposalNumber: row.proposal_number, leadId: row.lead_id, customerName: row.customer_name, email: row.email, address: row.address, pincode: row.pincode, panelBrand: row.panel_brand, panelWattage: row.panel_wattage, panelCount: row.panel_count,
        inverterBrand: row.inverter_brand, inverterCapacity: row.inverter_capacity, structureType: row.structure_type,
        systemType: row.system_type, systemCapacity: row.system_capacity, batteryRequired: Boolean(row.battery_required),
        batteryCapacity: row.battery_capacity, netMetering: Boolean(row.net_metering), contactNumber: row.contact_number,
        proposalDate: row.proposal_date, solarPanels: row.solar_panels, acdbDcdb: row.acdb_dcdb,
        otherCharges: row.other_charges, subtotal: row.subtotal, grossAmount: row.gross_amount,
        finalAmount: row.final_amount, netInvestment: row.net_investment, bookingAmount: row.booking_amount,
        customPaymentTerms: row.custom_payment_terms, leadOwner: row.lead_owner, generationEstimate: row.generation_estimate,
        monthlySavings: row.monthly_savings, annualSavings: row.annual_savings, pricing,
        parentProposalId: row.parent_proposal_id || null, versionNumber: Number(row.version_number || 1),
        paymentSchedule, subsidyEligibilityVerified: row.subsidy_eligibility_verified === null || row.subsidy_eligibility_verified === undefined
            ? null : Boolean(row.subsidy_eligibility_verified),
        validityDays: Number(pricing.validityDays || 15)
    };
}

function buildProposalPayload(body, lead, fallback = {}) {
    let details = {};
    try { details = lead?.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { details = {}; }
    const value = (key, defaultValue) => body[key] !== undefined ? body[key] : (fallback[key] !== undefined ? fallback[key] : defaultValue);
    const systemCapacity = Number(value('systemCapacity', value('system_capacity', details.systemCapacity || details.requiredSolarCapacity || 0))) || 0;
    const systemType = String(value('systemType', fallback.pricing?.systemType || details.systemType || 'On-Grid')).trim();
    const pricingType = String(value('pricingType', fallback.pricing?.pricingType || 'Non-Subsidy')).trim();
    const subsidyEligibilityReviewed = body.subsidyEligibilityReviewed === true || body.subsidyEligibilityReviewed === 'true';
    const requestedSubsidyEligibility = body.subsidyEligibilityVerified === true || body.subsidyEligibilityVerified === 'true';
    const subsidyEligibilityVerified = subsidyEligibilityReviewed
        ? requestedSubsidyEligibility
        : (fallback.id ? (fallback.subsidyEligibilityVerified ?? null) : false);
    const subsidyEligibilityError = subsidyEligibilityReviewed && requestedSubsidyEligibility && systemType !== 'On-Grid'
        ? 'The estimated PM Surya Ghar benefit is only available for eligible On-Grid proposals.'
        : '';
    const subsidyAmount = subsidyEligibilityReviewed
        ? (requestedSubsidyEligibility && systemType === 'On-Grid' ? PM_SURYA_GHAR_SUBSIDY : 0)
        : (fallback.id ? Number(fallback.subsidy ?? fallback.pricing?.subsidy ?? 0) : 0);
    const componentKeys = ['solarPanels', 'inverter', 'structure', 'acdbDcdb', 'earthing', 'cables', 'installation', 'otherCharges'];
    const componentsOverride = body.componentsOverride === true || body.componentsOverride === 'true'
        || (body.componentsOverride === undefined && componentKeys.some((key) => body[key] !== undefined))
        || fallback.pricing?.componentsOverride === true;
    const componentValues = componentsOverride ? {
        solarPanels: value('solarPanels', value('solar_panels', undefined)), inverter: value('inverter'), structure: value('structure'),
        acdbDcdb: value('acdbDcdb', value('acdb_dcdb', undefined)), earthing: value('earthing'), cables: value('cables'),
        installation: value('installation'), otherCharges: value('otherCharges', value('other_charges', undefined))
    } : {};
    const pricing = proposalPricing(systemCapacity, {
        ...componentValues,
        discount: value('discount', fallback.discount ?? fallback.pricing?.discount ?? 0),
        discountOverride: value('discountOverride', fallback.pricing?.discountOverride === true),
        subsidy: subsidyAmount,
        systemType,
        pricingType,
        panelCount: Number(value('panelCount', fallback.panelCount || 0)) || 0,
        inverterPhase: String(value('inverterPhase', fallback.pricing?.inverterPhase || '')),
        extraBattery: value('extraBattery', fallback.pricing?.extraBattery || false)
    });
    let componentConfiguration = [];
    let componentConfigurationError = '';
    try {
        componentConfiguration = normalizeProposalConfiguration(value('componentConfiguration', fallback.pricing?.componentConfiguration || []));
    } catch (error) {
        componentConfigurationError = error.message || 'Equipment configuration is invalid.';
    }
    const configurationWarnings = componentConfigurationError ? [] : getProposalConfigurationWarnings(componentConfiguration, {
        systemCapacity,
        panelWattage: Number(value('panelWattage', 0)) || 0,
        panelCount: Number(value('panelCount', 0)) || 0,
        inverterCapacity: Number(value('inverterCapacity', systemCapacity)) || 0,
        batteryRequired: value('batteryRequired', fallback.batteryRequired),
        batteryCapacity: Number(value('batteryCapacity', fallback.batteryCapacity || 0)) || 0
    });
    let projectMetrics = {};
    let projectMetricsError = '';
    try {
        const rawMetrics = value('projectMetrics', fallback.pricing?.projectMetrics || {});
        projectMetrics = typeof rawMetrics === 'string' ? JSON.parse(rawMetrics || '{}') : rawMetrics;
        if (!projectMetrics || typeof projectMetrics !== 'object' || Array.isArray(projectMetrics)) throw new Error('Generation and savings metrics must be an object.');
        for (const field of ['dailyGenerationKwh', 'monthlyGenerationKwh', 'annualGenerationKwh']) {
            const raw = projectMetrics[field];
            if (raw !== undefined && raw !== null && raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
                throw new Error(`${field} must be a non-negative number.`);
            }
        }
        const savingsAssumptions = String(projectMetrics.savingsAssumptions || '').trim();
        if (savingsAssumptions.length > 1000) throw new Error('Generation and savings assumptions must be 1,000 characters or fewer.');
        const performanceInputsVerified = projectMetrics.performanceInputsVerified === true || projectMetrics.performanceInputsVerified === 'true';
        const annualSavings = Number(value('annualSavings', fallback.annualSavings || 0)) || 0;
        projectMetrics = {
            dailyGenerationKwh: projectMetrics.dailyGenerationKwh === '' ? null : Number(projectMetrics.dailyGenerationKwh) || null,
            monthlyGenerationKwh: projectMetrics.monthlyGenerationKwh === '' ? null : Number(projectMetrics.monthlyGenerationKwh) || null,
            annualGenerationKwh: projectMetrics.annualGenerationKwh === '' ? null : Number(projectMetrics.annualGenerationKwh) || null,
            savingsAssumptions,
            performanceInputsVerified,
            paybackYears: performanceInputsVerified && annualSavings > 0 && pricing?.finalAmount > 0
                ? pricing.finalAmount / annualSavings
                : null
        };
    } catch (error) {
        projectMetricsError = error.message || 'Generation and savings inputs are invalid.';
        projectMetrics = {};
    }
    if (pricing) {
        pricing.componentsOverride = componentsOverride;
        pricing.componentConfiguration = componentConfiguration;
        pricing.configurationWarnings = configurationWarnings;
        pricing.projectMetrics = projectMetrics;
        pricing.subsidyEligibilityVerified = subsidyEligibilityVerified;
        pricing.subsidyBenefitLabel = subsidyAmount > 0
            ? 'Estimated PM Surya Ghar benefit, subject to official approval'
            : 'No subsidy benefit applied; eligibility not verified';
    }
    const validityDays = Number(value('validityDays', fallback.validityDays ?? fallback.pricing?.validityDays ?? 15));
    const rawPaymentSchedule = body.paymentSchedule !== undefined ? body.paymentSchedule : fallback.paymentSchedule;
    const hasPaymentSchedule = body.paymentSchedule !== undefined
        || (Array.isArray(fallback.paymentSchedule) && fallback.paymentSchedule.length > 0);
    const paymentScheduleResult = hasPaymentSchedule
        ? validatePaymentSchedule(rawPaymentSchedule, pricing?.finalAmount, value('bookingAmount', fallback.bookingAmount || 0))
        : { valid: true, structured: false, milestones: [], bookingAmount: Number(value('bookingAmount', fallback.bookingAmount || 0)) || 0 };
    const customerName = String(value('customerName', lead?.customer_name || '')).trim();
    const address = String(value('address', details.address || lead?.location || '')).trim();
    const proposalDate = String(value('proposalDate', value('proposal_date', now().slice(0, 10)))).trim();
    return {
        customerName, contactNumber: String(value('contactNumber', lead?.mobile_number || '')).trim(), email: String(value('email', lead?.email || '')).trim(),
        address, pincode: String(value('pincode', details.pincode || '')).trim(), proposalDate,
        systemType, pricingType, systemCapacity,
        panelBrand: String(value('panelBrand', details.panelBrand || '')).trim(), panelWattage: Number(value('panelWattage', details.panelWattage || 0)) || 0,
        panelCount: Number(value('panelCount', details.panelCount || 0)) || 0, inverterBrand: String(value('inverterBrand', details.inverterBrand || '')).trim(),
        inverterCapacity: Number(value('inverterCapacity', details.inverterCapacity || systemCapacity)) || 0,
        structureType: String(value('structureType', details.structureType || '')).trim(), batteryRequired: value('batteryRequired', details.batteryRequired) ? 1 : 0,
        batteryCapacity: Number(value('batteryCapacity', details.batteryCapacity || 0)) || 0, netMetering: value('netMetering', details.netMetering) ? 1 : 0,
        pricing: pricing ? { ...(fallback.pricing || {}), ...pricing, validityDays } : pricing, validityDays,
        bookingAmount: paymentScheduleResult.valid ? paymentScheduleResult.bookingAmount : Number(value('bookingAmount', fallback.bookingAmount || 0)) || 0,
        paymentSchedule: paymentScheduleResult.valid && paymentScheduleResult.structured ? paymentScheduleResult.milestones : [],
        paymentScheduleError: paymentScheduleResult.valid ? '' : paymentScheduleResult.error,
        subsidyEligibilityVerified, subsidyEligibilityError,
        componentConfigurationError, configurationWarnings, projectMetricsError, projectMetrics,
        paymentTerms: String(value('paymentTerms', '')).trim(),
        customPaymentTerms: String(value('customPaymentTerms', '')).trim(), generationEstimate: String(value('generationEstimate', '')).trim(),
        monthlySavings: Number(value('monthlySavings', 0)) || 0, annualSavings: Number(value('annualSavings', 0)) || 0,
        warranty: String(value('warranty', '')).trim(), scopeOfWork: String(value('scopeOfWork', '')).trim(),
        termsConditions: String(value('termsConditions', 'Proposal validity, payment schedule and warranty are subject to the final order agreement.')).trim()
    };
}


function initializeDatabase() {
    database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS staff (
            id TEXT PRIMARY KEY, employee_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            department TEXT, designation TEXT, login_id TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active',
            account_status TEXT NOT NULL DEFAULT 'ACTIVE', failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            deactivated_at TEXT, deactivation_reason TEXT, blocked_until TEXT, reactivated_at TEXT, reactivated_by TEXT,
            manager_id TEXT REFERENCES staff(id), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'sales_executive',
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS access_requests (
            id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
            request_data TEXT NOT NULL DEFAULT '{}', password_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Pending', created_at TEXT NOT NULL,
            approved_at TEXT, approved_by TEXT, rejected_at TEXT, rejected_by TEXT,
            rejection_reason TEXT, eligible_again_at TEXT
        );
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id),
            expires_at TEXT NOT NULL, used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id),
            user_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, mobile_number TEXT NOT NULL UNIQUE,
            email TEXT, lead_date TEXT NOT NULL, lead_source TEXT NOT NULL, assigned_to TEXT,
            stage TEXT NOT NULL, priority TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'Active',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS follow_ups (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), due_at TEXT NOT NULL,
            type TEXT NOT NULL, assigned_to TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
            notes TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS surveys (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), survey_date TEXT NOT NULL,
            assigned_to TEXT NOT NULL, customer TEXT NOT NULL, address TEXT NOT NULL, sanctioned_load TEXT NOT NULL,
            electricity_details TEXT NOT NULL, roof_information TEXT NOT NULL, feasibility TEXT,
            recommended_capacity TEXT NOT NULL, remarks TEXT, status TEXT NOT NULL DEFAULT 'Scheduled', completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS survey_files (
            id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id), lead_id TEXT NOT NULL REFERENCES leads(id),
            category TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0,
            file_data TEXT, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, latitude TEXT, longitude TEXT
        );
        CREATE TABLE IF NOT EXISTS proposals (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), survey_id TEXT NOT NULL REFERENCES surveys(id),
            amount REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS proposal_records (
            id TEXT PRIMARY KEY, proposal_number TEXT NOT NULL UNIQUE, lead_id TEXT NOT NULL REFERENCES leads(id),
            customer_name TEXT NOT NULL, contact_number TEXT NOT NULL, email TEXT, address TEXT, pincode TEXT,
            proposal_date TEXT NOT NULL, system_type TEXT NOT NULL, system_capacity REAL NOT NULL DEFAULT 0,
            panel_brand TEXT, panel_wattage REAL NOT NULL DEFAULT 0, panel_count INTEGER NOT NULL DEFAULT 0,
            inverter_brand TEXT, inverter_capacity REAL NOT NULL DEFAULT 0, structure_type TEXT,
            battery_required INTEGER NOT NULL DEFAULT 0, battery_capacity REAL NOT NULL DEFAULT 0,
            net_metering INTEGER NOT NULL DEFAULT 0, solar_panels REAL NOT NULL DEFAULT 0, inverter REAL NOT NULL DEFAULT 0,
            structure REAL NOT NULL DEFAULT 0, acdb_dcdb REAL NOT NULL DEFAULT 0, earthing REAL NOT NULL DEFAULT 0,
            cables REAL NOT NULL DEFAULT 0, installation REAL NOT NULL DEFAULT 0, other_charges REAL NOT NULL DEFAULT 0,
            subtotal REAL NOT NULL DEFAULT 0, gst REAL NOT NULL DEFAULT 0, gross_amount REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0, final_amount REAL NOT NULL DEFAULT 0, subsidy REAL NOT NULL DEFAULT 0,
            net_investment REAL NOT NULL DEFAULT 0, booking_amount REAL NOT NULL DEFAULT 0,
            payment_terms TEXT, custom_payment_terms TEXT, lead_owner TEXT, pricing_json TEXT NOT NULL DEFAULT '{}',
            generation_estimate TEXT, monthly_savings REAL NOT NULL DEFAULT 0, annual_savings REAL NOT NULL DEFAULT 0,
            warranty TEXT, scope_of_work TEXT, terms_conditions TEXT, status TEXT NOT NULL DEFAULT 'Draft',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            parent_proposal_id TEXT, version_number INTEGER NOT NULL DEFAULT 1,
            payment_schedule_json TEXT NOT NULL DEFAULT '[]', subsidy_eligibility_verified INTEGER
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), proposal_id TEXT REFERENCES proposals(id),
            status TEXT NOT NULL DEFAULT 'Booked', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), total_amount REAL NOT NULL,
            paid_amount REAL NOT NULL DEFAULT 0, payment_date TEXT, notes TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS opportunities (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id), customer_name TEXT NOT NULL,
            system_capacity TEXT, estimated_value REAL NOT NULL DEFAULT 0, assigned_to TEXT, expected_close_date TEXT,
            probability REAL NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'Qualified', lost_reason TEXT,
            status TEXT NOT NULL DEFAULT 'Active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookings (
            id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL UNIQUE REFERENCES opportunities(id), lead_id TEXT NOT NULL REFERENCES leads(id),
            total_amount REAL NOT NULL DEFAULT 0, booking_amount REAL NOT NULL DEFAULT 0, booking_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Confirmed', created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS installations (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id), status TEXT NOT NULL DEFAULT 'Pending',
            installation_date TEXT, team TEXT, materials TEXT, completion_report TEXT, remarks TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS commissioning (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id), status TEXT NOT NULL DEFAULT 'Documentation Pending',
            application_number TEXT, inspection_date TEXT, meter_status TEXT, commissioning_date TEXT, remarks TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), invoice_number TEXT NOT NULL UNIQUE,
            total_amount REAL NOT NULL DEFAULT 0, gst REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Unpaid', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory (
            id TEXT PRIMARY KEY, product TEXT NOT NULL UNIQUE, opening_stock REAL NOT NULL DEFAULT 0,
            available_stock REAL NOT NULL DEFAULT 0, low_stock_threshold REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS equipment_catalogue (
            id TEXT PRIMARY KEY, catalogue_key TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL, brand TEXT NOT NULL, manufacturer TEXT NOT NULL,
            series TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
            rated_wattage REAL, minimum_wattage REAL, maximum_wattage REAL,
            rated_capacity_kw REAL, inverter_type TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT '',
            source_url TEXT NOT NULL, datasheet_url TEXT NOT NULL DEFAULT '', verification_date TEXT NOT NULL,
            market_applicability TEXT NOT NULL DEFAULT 'Needs verification',
            verification_status TEXT NOT NULL DEFAULT 'Needs verification',
            status TEXT NOT NULL DEFAULT 'Active', notes TEXT NOT NULL DEFAULT '',
            created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), project_id TEXT,
            action TEXT NOT NULL, quantity REAL NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_categories (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, parent_name TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), action TEXT NOT NULL,
            quantity REAL NOT NULL, previous_stock REAL NOT NULL, new_stock REAL NOT NULL, user_id TEXT NOT NULL,
            reference_id TEXT, project_id TEXT, lead_id TEXT, batch_number TEXT, serial_numbers TEXT,
            warehouse TEXT, remarks TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_reservations (
            id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL REFERENCES inventory(id), project_id TEXT,
            lead_id TEXT, order_id TEXT, quantity REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Reserved',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
        );
        CREATE TABLE IF NOT EXISTS material_requests (
            id TEXT PRIMARY KEY, project_id TEXT, lead_id TEXT, order_id TEXT, installation_date TEXT,
            requested_by TEXT NOT NULL, department TEXT, required_date TEXT, priority TEXT NOT NULL DEFAULT 'Medium',
            remarks TEXT, status TEXT NOT NULL DEFAULT 'Draft', rejection_reason TEXT, approved_by TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS material_request_items (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES material_requests(id), inventory_id TEXT NOT NULL REFERENCES inventory(id),
            required_quantity REAL NOT NULL, reserved_quantity REAL NOT NULL DEFAULT 0, issued_quantity REAL NOT NULL DEFAULT 0,
            returned_quantity REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS project_materials (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, lead_id TEXT, order_id TEXT, inventory_id TEXT NOT NULL REFERENCES inventory(id),
            required_quantity REAL NOT NULL, reserved_quantity REAL NOT NULL DEFAULT 0, issued_quantity REAL NOT NULL DEFAULT 0,
            returned_quantity REAL NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(project_id, inventory_id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL,
            record_type TEXT NOT NULL, record_id TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_imports (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES staff(id), status TEXT NOT NULL,
            source_filename TEXT NOT NULL, total_rows INTEGER NOT NULL, processed_rows INTEGER NOT NULL DEFAULT 0,
            created_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0, rows_json TEXT NOT NULL, error_message TEXT,
            source_rows_json TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_import_lock (
            id INTEGER PRIMARY KEY CHECK(id = 1), job_id TEXT NOT NULL UNIQUE REFERENCES lead_imports(id)
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'json',
            updated_by TEXT, updated_at TEXT, description TEXT
        );
        CREATE TABLE IF NOT EXISTS system_errors (
            id TEXT PRIMARY KEY, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_stage_history (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), stage TEXT NOT NULL,
            started_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT, duration_seconds INTEGER,
            remarks TEXT
        );
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
            record_type TEXT, record_id TEXT, read_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_documents (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), document_type TEXT NOT NULL,
            file_name TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_notes (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), note TEXT NOT NULL,
            category TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quotations (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), proposal_id TEXT,
            subtotal REAL NOT NULL, discount REAL NOT NULL, gst REAL NOT NULL, total REAL NOT NULL,
            payment_terms TEXT, validity TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_communications (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), type TEXT NOT NULL,
            recipient TEXT, subject TEXT, message TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_activities (
            id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), activity_type TEXT NOT NULL,
            title TEXT NOT NULL, description TEXT, user_id TEXT, related_record_type TEXT,
            related_record_id TEXT, previous_value TEXT, new_value TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_followers (
            lead_id TEXT NOT NULL REFERENCES leads(id), staff_id TEXT NOT NULL REFERENCES staff(id),
            created_at TEXT NOT NULL, PRIMARY KEY (lead_id, staff_id)
        );
    `);
    const insertCatalogueProduct = database.prepare(`INSERT INTO equipment_catalogue (
        id, catalogue_key, category, brand, manufacturer, series, model,
        rated_wattage, minimum_wattage, maximum_wattage, rated_capacity_kw, inverter_type, phase,
        source_url, datasheet_url, verification_date, market_applicability, verification_status,
        status, notes, created_by, created_at, updated_at
    ) VALUES (${Array(23).fill('?').join(', ')})`);
    for (const sourceProduct of equipmentCatalogueSeed) {
        const product = normalizeEquipmentCatalogueEntry(sourceProduct);
        const catalogueKey = crypto.createHash('sha256')
            .update(`${product.category}\u0000${product.brand.toLowerCase()}\u0000${product.model.toLowerCase()}\u0000${product.phase.toLowerCase()}`)
            .digest('hex');
        if (database.prepare('SELECT id FROM equipment_catalogue WHERE catalogue_key = ?').get(catalogueKey)) continue;
        const timestamp = new Date().toISOString();
        insertCatalogueProduct.run(
            crypto.createHash('sha256').update(catalogueKey).digest('hex').slice(0, 32),
            catalogueKey, product.category, product.brand, product.manufacturer, product.series, product.model,
            product.ratedWattage, product.minimumWattage, product.maximumWattage, product.ratedCapacityKw,
            product.inverterType, product.phase, product.sourceUrl, product.datasheetUrl, product.verificationDate,
            product.marketApplicability, product.verificationStatus, product.status, product.notes, 'system', timestamp, timestamp
        );
    }
    fs.mkdirSync(FILE_STORAGE_ROOT, { recursive: true });
    function safeAddColumn(tableName, columnDefinition) {
        const columnName = String(columnDefinition).trim().split(/\s+/)[0];
        if (!columnName) return;
        const tableInfo = database.prepare(`PRAGMA table_info(${tableName})`).all();
        const hasColumn = tableInfo.some((column) => String(column.name).toLowerCase() === String(columnName).toLowerCase());
        if (!hasColumn) {
            try {
                database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
            } catch (error) {
                console.warn(`Unable to add column ${columnName} to ${tableName}.`, { errorType: safeErrorType(error) });
            }
        }
    }
    safeAddColumn('lead_imports', 'source_rows_json TEXT');
    ['storage_path TEXT', 'original_file_name TEXT', 'mime_type TEXT', 'file_size INTEGER NOT NULL DEFAULT 0', "status TEXT NOT NULL DEFAULT 'UPLOADED'"].forEach((column) => safeAddColumn('lead_documents', column));
    safeAddColumn('lead_documents', 'proposal_record_id TEXT');
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_documents_proposal_record ON lead_documents(proposal_record_id) WHERE proposal_record_id IS NOT NULL AND status = 'UPLOADED'");
    safeAddColumn('proposal_records', 'parent_proposal_id TEXT');
    safeAddColumn('proposal_records', 'version_number INTEGER NOT NULL DEFAULT 1');
    safeAddColumn('proposal_records', "payment_schedule_json TEXT NOT NULL DEFAULT '[]'");
    safeAddColumn('proposal_records', 'subsidy_eligibility_verified INTEGER');
    ['storage_path TEXT', 'original_file_name TEXT', "status TEXT NOT NULL DEFAULT 'UPLOADED'"].forEach((column) => safeAddColumn('survey_files', column));
    database.prepare("SELECT id, file_name AS fileName, mime_type AS mimeType, file_size AS fileSize, file_data AS fileData FROM survey_files WHERE storage_path IS NULL AND file_data IS NOT NULL").all().forEach((file) => {
        try { const stored = saveUploadedFile(file); database.prepare("UPDATE survey_files SET storage_path = ?, original_file_name = ?, mime_type = ?, file_size = ?, status = 'UPLOADED', file_data = NULL WHERE id = ?").run(stored.storagePath, stored.originalFileName, stored.mimeType, stored.fileSize, file.id); } catch (error) { database.prepare("UPDATE survey_files SET status = 'FAILED' WHERE id = ?").run(file.id); }
    });
    safeAddColumn('leads', 'details_json TEXT');
    safeAddColumn('leads', 'lead_score INTEGER NOT NULL DEFAULT 0');
    safeAddColumn('leads', 'lead_category TEXT');
    safeAddColumn('leads', 'monthly_bill REAL');
    safeAddColumn('leads', 'property_type TEXT');
    safeAddColumn('leads', 'roof_available TEXT');
    safeAddColumn('leads', 'interested_in_solar TEXT');
    safeAddColumn('leads', 'decision_maker TEXT');
    safeAddColumn('leads', 'bengaluru_zone TEXT');
    safeAddColumn('staff', 'google_email TEXT');
    safeAddColumn('staff', 'email TEXT');
    safeAddColumn('staff', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
    safeAddColumn('staff', 'locked_until TEXT');
    safeAddColumn('staff', "account_status TEXT NOT NULL DEFAULT 'ACTIVE'");
    safeAddColumn('staff', 'deactivated_at TEXT');
    safeAddColumn('staff', 'deactivation_reason TEXT');
    safeAddColumn('staff', 'blocked_until TEXT');
    safeAddColumn('staff', 'reactivated_at TEXT');
    safeAddColumn('staff', 'reactivated_by TEXT');
    safeAddColumn('staff', 'last_login_at TEXT');
    safeAddColumn('staff', 'last_logout_at TEXT');
    safeAddColumn('staff', 'auth_method TEXT');
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS staff_google_email_unique ON staff (google_email) WHERE google_email IS NOT NULL'); } catch (error) { }
    database.prepare("UPDATE staff SET account_status = CASE WHEN status = 'Active' THEN 'ACTIVE' ELSE 'DEACTIVATED' END WHERE account_status IS NULL OR account_status = ''").run();
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS staff_login_id_ci_unique ON staff (lower(login_id))'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS access_requests_email_created_idx ON access_requests (lower(email), created_at DESC)'); } catch (error) { }
    try { database.exec("CREATE UNIQUE INDEX IF NOT EXISTS access_requests_email_open_unique ON access_requests (lower(email)) WHERE status IN ('Pending', 'Approved')"); } catch (error) { }
    database.prepare("UPDATE staff SET google_email = ? WHERE (id = ? OR lower(login_id) = lower(?)) AND (google_email IS NULL OR google_email = '')").run(GOOGLE_ADMIN_EMAIL, PERMANENT_ADMIN_ID, PERMANENT_ADMIN_LOGIN);
    database.prepare("INSERT OR IGNORE INTO app_settings (key, value, type, updated_by, updated_at, description) VALUES ('crm_settings', ?, 'json', 'system', ?, 'Primary CRM account settings')").run(JSON.stringify(SETTINGS_DEFAULTS), now());
    safeAddColumn('leads', 'lead_number TEXT');
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_lead_number_unique ON leads(lead_number)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS proposal_records_lead_idx ON proposal_records(lead_id, created_at DESC)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS proposal_records_status_idx ON proposal_records(status, created_at DESC)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS proposal_records_parent_idx ON proposal_records(parent_proposal_id, version_number)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS leads_score_idx ON leads(lead_score)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS leads_category_idx ON leads(lead_category)'); } catch (error) { }
    try { database.exec('CREATE INDEX IF NOT EXISTS leads_stage_score_idx ON leads(stage, lead_score)'); } catch (error) { }
    const leadScoreRows = database.prepare('SELECT * FROM leads').all();
    const recalcLeadScore = database.prepare('UPDATE leads SET lead_score = ?, lead_category = ?, monthly_bill = COALESCE(?, monthly_bill), property_type = COALESCE(?, property_type), roof_available = COALESCE(?, roof_available), interested_in_solar = COALESCE(?, interested_in_solar), decision_maker = COALESCE(?, decision_maker), bengaluru_zone = COALESCE(?, bengaluru_zone) WHERE id = ?');
    leadScoreRows.forEach((leadRow) => {
        const snapshot = getLeadScoreSnapshot(leadRow);
        recalcLeadScore.run(snapshot.leadScore, snapshot.leadCategory, snapshot.monthlyBill || null, snapshot.propertyType || null, snapshot.roofAvailable || null, snapshot.interestedInSolar || null, snapshot.decisionMaker || null, snapshot.bengaluruZone || null, leadRow.id);
    });
    safeAddColumn('opportunities', 'closing_date TEXT');
    safeAddColumn('opportunities', 'closing_value REAL');
    safeAddColumn('opportunities', 'closing_remarks TEXT');
    safeAddColumn('surveys', 'survey_type TEXT');
    safeAddColumn('surveys', 'latitude TEXT');
    safeAddColumn('surveys', 'longitude TEXT');
    safeAddColumn('surveys', 'location_accuracy TEXT');
    safeAddColumn('surveys', 'location_captured_at TEXT');
    safeAddColumn('surveys', 'completion_data_json TEXT');
    safeAddColumn('follow_ups', 'completed_at TEXT');
    safeAddColumn('follow_ups', 'completed_by TEXT');
    safeAddColumn('follow_ups', 'outcome TEXT');
    safeAddColumn('follow_ups', 'missed_reason TEXT');
    safeAddColumn('follow_ups', 'task_title TEXT');
    safeAddColumn('follow_ups', "task_status TEXT NOT NULL DEFAULT 'PENDING'");
    safeAddColumn('follow_ups', 'task_completed_at TEXT');
    safeAddColumn('follow_ups', 'task_completed_by TEXT');
    safeAddColumn('follow_ups', 'task_related_type TEXT');
    safeAddColumn('follow_ups', 'task_related_id TEXT');
    database.prepare("UPDATE follow_ups SET task_title = CASE type WHEN 'WhatsApp' THEN 'WhatsApp follow-up with customer' WHEN 'Call' THEN 'Call customer regarding solar proposal' WHEN 'Site Visit' THEN 'Site visit with customer' WHEN 'Meeting' THEN 'Meeting with customer' WHEN 'Proposal Discussion' THEN 'Follow up on quotation' WHEN 'Payment Follow-up' THEN 'Follow up on payment' ELSE 'Follow up with customer' END WHERE task_title IS NULL OR task_title = ''").run();
    database.prepare("UPDATE follow_ups SET task_status = CASE WHEN status = 'Completed' THEN 'COMPLETED' WHEN status = 'Cancelled' THEN 'CANCELLED' WHEN datetime(due_at) < datetime('now') THEN 'OVERDUE' ELSE 'PENDING' END").run();
    const inventoryColumns = [
        ['sku', 'TEXT'], ['category', 'TEXT'], ['subcategory', 'TEXT'], ['brand', 'TEXT'], ['model', 'TEXT'],
        ['specification', 'TEXT'], ['unit', "TEXT NOT NULL DEFAULT 'unit'"], ['purchase_price', 'REAL NOT NULL DEFAULT 0'],
        ['selling_price', 'REAL NOT NULL DEFAULT 0'], ['minimum_stock', 'REAL NOT NULL DEFAULT 0'], ['maximum_stock', 'REAL NOT NULL DEFAULT 0'],
        ['reorder_level', 'REAL NOT NULL DEFAULT 0'], ['total_stock', 'REAL NOT NULL DEFAULT 0'], ['reserved_stock', 'REAL NOT NULL DEFAULT 0'],
        ['issued_stock', 'REAL NOT NULL DEFAULT 0'], ['damaged_stock', 'REAL NOT NULL DEFAULT 0'], ['returned_stock', 'REAL NOT NULL DEFAULT 0'],
        ['warehouse', 'TEXT'], ['rack_bin', 'TEXT'], ['supplier', 'TEXT'], ['warranty_information', 'TEXT'],
        ['requires_serial', 'INTEGER NOT NULL DEFAULT 0'], ['requires_batch', 'INTEGER NOT NULL DEFAULT 0'],
        ['status', "TEXT NOT NULL DEFAULT 'Active'"], ['created_by', 'TEXT']
    ];
    inventoryColumns.forEach(([name, definition]) => safeAddColumn('inventory', `${name} ${definition}`));
    try { database.exec('CREATE UNIQUE INDEX IF NOT EXISTS inventory_sku_unique ON inventory(sku) WHERE sku IS NOT NULL'); } catch (error) { }
    database.prepare("UPDATE inventory SET total_stock = CASE WHEN total_stock = 0 THEN opening_stock ELSE total_stock END, available_stock = CASE WHEN available_stock = 0 THEN opening_stock ELSE available_stock END WHERE total_stock = 0 OR available_stock = 0").run();
    database.prepare("UPDATE follow_ups SET status = 'Scheduled' WHERE status = 'Pending'").run();
    database.prepare('UPDATE leads SET stage = ? WHERE stage = ?').run('New', 'New Lead');
    Object.entries(LEGACY_STAGE_MAP).forEach(([legacy, current]) => database.prepare('UPDATE leads SET stage = ? WHERE stage = ?').run(current, legacy));
    const leadsWithoutHistory = database.prepare('SELECT id, stage, created_at FROM leads WHERE id NOT IN (SELECT lead_id FROM lead_stage_history)').all();
    const insertInitialHistory = database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at) VALUES (?, ?, ?, ?)');
    leadsWithoutHistory.forEach((lead) => insertInitialHistory.run(crypto.randomUUID(), lead.id, lead.stage, lead.created_at));
    const configuredAdminPassword = String(process.env.ADMIN_INITIAL_PASSWORD || '');
    const admin = database.prepare("SELECT * FROM staff WHERE id = ? OR lower(login_id) = lower(?) OR lower(COALESCE(email, '')) = lower(?) OR lower(COALESCE(google_email, '')) = lower(?) ORDER BY CASE WHEN id = ? THEN 0 WHEN lower(login_id) = lower(?) THEN 1 WHEN lower(COALESCE(email, '')) = lower(?) THEN 2 WHEN lower(COALESCE(google_email, '')) = lower(?) THEN 3 ELSE 4 END LIMIT 1").get(PERMANENT_ADMIN_ID, PERMANENT_ADMIN_LOGIN, PERMANENT_ADMIN_LOGIN, GOOGLE_ADMIN_EMAIL, PERMANENT_ADMIN_ID, PERMANENT_ADMIN_LOGIN, PERMANENT_ADMIN_LOGIN, GOOGLE_ADMIN_EMAIL);
    if (!admin && !configuredAdminPassword) throw new Error('ADMIN_INITIAL_PASSWORD must be set when initializing the permanent Admin account.');
    if (configuredAdminPassword && passwordPolicyError(configuredAdminPassword)) throw new Error('ADMIN_INITIAL_PASSWORD must meet the CRM password policy.');
    if (!admin) {
        database.prepare(`INSERT OR IGNORE INTO staff (id, employee_id, name, department, designation, login_id, password_hash, role, status, account_status, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'ACTIVE', 0, ?)`)
            .run(PERMANENT_ADMIN_ID, 'EMP-001', 'Owner Admin', 'Administration', 'Owner', PERMANENT_ADMIN_LOGIN, hashPassword(configuredAdminPassword), 'Admin/Owner', now());
    }

    const adminRecord = database.prepare('SELECT * FROM staff WHERE id = ? OR lower(login_id) = lower(?) OR lower(COALESCE(email, \'\')) = lower(?) OR lower(COALESCE(google_email, \'\')) = lower(?) ORDER BY CASE WHEN id = ? THEN 0 WHEN lower(login_id) = lower(?) THEN 1 WHEN lower(COALESCE(email, \'\')) = lower(?) THEN 2 WHEN lower(COALESCE(google_email, \'\')) = lower(?) THEN 3 ELSE 4 END LIMIT 1').get(PERMANENT_ADMIN_ID, PERMANENT_ADMIN_LOGIN, PERMANENT_ADMIN_LOGIN, GOOGLE_ADMIN_EMAIL, PERMANENT_ADMIN_ID, PERMANENT_ADMIN_LOGIN, PERMANENT_ADMIN_LOGIN, GOOGLE_ADMIN_EMAIL);
    if (adminRecord) {
        database.prepare("UPDATE staff SET login_id = ?, email = ?, google_email = ?, role = 'Admin/Owner', status = 'Active', account_status = 'ACTIVE', blocked_until = NULL, deactivated_at = NULL, deactivation_reason = NULL WHERE id = ?").run(PERMANENT_ADMIN_LOGIN, PERMANENT_ADMIN_LOGIN, GOOGLE_ADMIN_EMAIL, adminRecord.id);
        if (configuredAdminPassword && (!adminRecord.password_hash || !verifyPassword(configuredAdminPassword, adminRecord.password_hash))) database.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(configuredAdminPassword), adminRecord.id);
    }
    safeAddColumn('opportunities', 'source TEXT');
    safeAddColumn('opportunities', "priority TEXT NOT NULL DEFAULT 'Medium'");
    safeAddColumn('opportunities', 'notes TEXT');
    safeAddColumn('follow_ups', 'opportunity_id TEXT');
    safeAddColumn('follow_ups', 'note TEXT');
    database.prepare("UPDATE opportunities SET priority = 'Medium' WHERE priority IS NULL OR priority = ''").run();
    database.prepare("UPDATE opportunities SET source = 'CRM' WHERE source IS NULL OR source = ''").run();
    Object.entries(OPPORTUNITY_STAGE_ALIASES).forEach(([legacyStage, canonicalStage]) => {
        database.prepare('UPDATE opportunities SET stage = ? WHERE lower(trim(stage)) = lower(?)').run(canonicalStage, legacyStage);
    });
    database.prepare("UPDATE follow_ups SET note = notes WHERE note IS NULL AND notes IS NOT NULL").run();
    database.prepare("UPDATE follow_ups SET opportunity_id = lead_id WHERE opportunity_id IS NULL").run();
    const relatedTables = { 'follow-up': 'follow_ups', opportunity: 'opportunities', project: 'projects', survey: 'surveys', proposal: 'proposals', quotation: 'quotations', document: 'lead_documents', note: 'lead_notes', communication: 'lead_communications' };
    const oldEvents = database.prepare('SELECT a.*, s.name AS user_name FROM audit_logs a LEFT JOIN staff s ON s.id = a.user_id ORDER BY a.id').all();
    const insertActivity = database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    oldEvents.forEach((event) => {
        let leadId = event.record_type === 'lead' ? event.record_id : null;
        if (!leadId && relatedTables[event.record_type]) leadId = database.prepare(`SELECT lead_id AS id FROM ${relatedTables[event.record_type]} WHERE id = ?`).get(event.record_id)?.id;
        if (!leadId || !database.prepare('SELECT id FROM leads WHERE id = ?').get(leadId)) return;
        let details = {}; try { details = event.details ? JSON.parse(event.details) : {}; } catch (error) { details = {}; }
        const title = event.action === 'Created' && event.record_type === 'lead' ? 'Lead Created' : event.record_type === 'survey' ? `Survey ${event.action}` : event.action;
        const exists = database.prepare('SELECT id FROM lead_activities WHERE related_record_type = ? AND related_record_id = ? AND title = ? LIMIT 1').get(event.record_type, event.record_id, title);
        if (!exists) insertActivity.run(crypto.randomUUID(), leadId, event.record_type === 'follow-up' ? 'Follow-ups' : event.record_type === 'communication' ? 'Communication' : event.record_type === 'lead' ? 'Lead' : event.record_type.charAt(0).toUpperCase() + event.record_type.slice(1), title, details.description || JSON.stringify(details), event.user_id, event.record_type, event.record_id, details.previous || details.previousStage || details.previousStatus || null, details.next || details.newStage || details.newStatus || null, event.created_at);
    });
}

function json(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    response.end(JSON.stringify(payload));
    return true;
}

function redirect(response, location) {
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    response.end();
    return true;
}

function parseBody(request) {
    if (request.body !== undefined) return Promise.resolve(request.body);
    return new Promise((resolve, reject) => {
        let body = '';
        let totalBytes = 0;
        const contentLength = Number(request.headers['content-length'] || 0);
        if (contentLength > MAX_REQUEST_BODY_BYTES) {
            const error = new Error('Request body exceeds the supported size limit.');
            error.statusCode = 413;
            reject(error);
            request.destroy();
            return;
        }
        request.on('data', (chunk) => {
            totalBytes += Buffer.byteLength(chunk);
            if (totalBytes > MAX_REQUEST_BODY_BYTES) {
                const error = new Error('Request body exceeds the supported size limit.');
                error.statusCode = 413;
                reject(error);
                request.destroy();
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error('Invalid JSON body.')); }
        });
        request.on('error', reject);
    });
}

function saveUploadedFile(file) {
    const fileName = String(file?.fileName || '').trim();
    const mimeType = String(file?.mimeType || '').toLowerCase();
    const fileData = String(file?.fileData || '');
    if (!fileName || fileName.length > 255 || /[\\/\0]/.test(fileName)) throw new Error('Invalid file name.');
    if (!ALLOWED_FILE_TYPES.has(mimeType)) throw new Error('Unsupported file type.');
    const match = fileData.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1].toLowerCase() !== mimeType) throw new Error('The uploaded file data is invalid.');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error('File size must be between 1 byte and 100 MB.');
    const storagePath = `${crypto.randomUUID()}${path.extname(fileName).toLowerCase()}`;
    fs.writeFileSync(path.join(FILE_STORAGE_ROOT, storagePath), buffer, { flag: 'wx' });
    return { storagePath, originalFileName: fileName, mimeType, fileSize: buffer.length };
}

function removeStoredFile(storagePath) {
    if (storagePath) { try { fs.unlinkSync(path.join(FILE_STORAGE_ROOT, storagePath)); } catch (error) { } }
}

function sendProposalPdf(response, buffer, filename, fileId) {
    const safeFilename = String(filename || 'Proposal.pdf').replace(/[\\/"\r\n]/g, '_');
    response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
        'X-CRM-File-Id': String(fileId || ''),
        'X-CRM-File-URL': `/api/files/${encodeURIComponent(fileId)}?download=1`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(buffer);
    return true;
}

async function currentUser(request) {
    const cookies = String(request.headers.cookie || '').split(';').map((cookie) => cookie.trim());
    const cookieToken = cookies.find((cookie) => cookie.startsWith('crm_session='))?.slice('crm_session='.length);
    const token = cookieToken;
    if (!token) return null;
    let expiry = sessionExpiries.get(token);
    let user = sessions.get(token);
    if (!user) {
        const stored = await repository.get('SELECT user_json, expires_at FROM sessions WHERE token_hash = ?', [sessionHash(token)]);
        if (stored) {
            expiry = Date.parse(stored.expires_at);
            try { user = JSON.parse(stored.user_json); } catch (error) { user = null; }
            if (user && expiry > Date.now()) {
                sessions.set(token, user);
                sessionExpiries.set(token, expiry);
            }
        }
    }
    if (!user || !expiry || expiry <= Date.now()) {
        if (token) { sessions.delete(token); sessionExpiries.delete(token); }
        await repository.run('DELETE FROM sessions WHERE token_hash = ?', [sessionHash(token)]);
        return null;
    }
    const staff = await repository.get('SELECT account_status, status, role FROM staff WHERE id = ?', [user.id]);
    if (!staff || staff.account_status !== 'ACTIVE' || staff.status !== 'Active') {
        sessions.delete(token);
        sessionExpiries.delete(token);
        await repository.run('DELETE FROM sessions WHERE token_hash = ?', [sessionHash(token)]);
        return null;
    }
    if (user.role !== staff.role) {
        user = { ...user, role: staff.role };
        sessions.set(token, user);
        await repository.run('UPDATE sessions SET user_json = ? WHERE token_hash = ?', [JSON.stringify(user), sessionHash(token)]);
    }
    return user;
}

async function requireUser(request, response) {
    const user = await currentUser(request);
    if (!user) {
        json(response, 401, { error: 'Authentication required.' });
        return null;
    }
    return user;
}

function googleConfig(request) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`;
    return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}

function sessionUser(staff, authMethod) {
    return { id: staff.id, employeeId: staff.employee_id, name: staff.name, role: staff.role, department: staff.department, designation: staff.designation, authMethod };
}

function getSessionSecret() {
    return SESSION_SECRET || 'development-secret';
}

function sessionHash(token) {
    return crypto.createHmac('sha256', getSessionSecret()).update(String(token || '')).digest('hex');
}

function isPermanentAdmin(staff) {
    return staff?.id === PERMANENT_ADMIN_ID || String(staff?.login_id || '').toLowerCase() === PERMANENT_ADMIN_LOGIN;
}

function auditProtectedAdminAttempt(user, action, staffId, details = {}) {
    audit(user, action, 'staff', staffId, { ...details, result: 'DENIED', reason: 'Protected Admin account' });
}

async function createSession(staff, authMethod, rememberMe = false) {
    const token = crypto.randomBytes(32).toString('hex');
    const user = sessionUser(staff, authMethod);
    const expiresAt = Date.now() + (rememberMe ? 30 * 24 : 8) * 60 * 60 * 1000;
    sessions.set(token, user);
    sessionExpiries.set(token, expiresAt);
    await repository.run('INSERT INTO sessions (token_hash, staff_id, user_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [sessionHash(token), staff.id, JSON.stringify(user), new Date(expiresAt).toISOString(), now()]);
    await repository.run('UPDATE staff SET last_login_at = ?, auth_method = ? WHERE id = ?', [now(), authMethod, staff.id]);
    return { token, user: sessionUser(staff, authMethod) };
}

async function revokeUserSessions(staffId) {
    for (const [token, user] of sessions.entries()) {
        if (user.id === staffId) {
            sessions.delete(token);
            sessionExpiries.delete(token);
        }
    }
    await repository.run('DELETE FROM sessions WHERE staff_id = ?', [staffId]);
}

function sessionCookie(token, rememberMe, secure = false) {
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
    const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
    return `crm_session=${token}; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Path=/; Max-Age=${maxAge}; Expires=${expires}`;
}

function canAccess(user, lead) {
    const access = ROLE_ACCESS[user.role] || 'own';
    if (access === 'all') return true;
    if (access === 'team') {
        const assigned = database.prepare('SELECT manager_id FROM staff WHERE id = ?').get(lead.assigned_to);
        return lead.assigned_to === user.id || assigned?.manager_id === user.id;
    }
    return lead.assigned_to === user.id;
}

function findDuplicateLeadByMobile(mobileNumber, excludingLeadId = '') {
    const normalizedMobile = normalizeIndianMobileNumber(mobileNumber);
    if (!normalizedMobile) return null;
    return database.prepare(`SELECT l.id, l.lead_number, l.customer_name, l.mobile_number, l.stage, l.assigned_to, l.created_at, s.name AS owner
        FROM leads l LEFT JOIN staff s ON s.id = l.assigned_to`).all()
        .find((lead) => lead.id !== excludingLeadId && normalizeIndianMobileNumber(lead.mobile_number) === normalizedMobile) || null;
}

function recordDuplicateLeadAttempt(user, existingLead, mobileNumber, attemptedAction) {
    const details = {
        mobileMasked: maskIndianMobileNumber(mobileNumber),
        existingLeadId: existingLead.id,
        attemptedAction,
        result: 'BLOCKED'
    };
    database.prepare('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, 'Duplicate lead creation blocked', 'lead', existingLead.id, JSON.stringify(details), now());
}

function duplicateLeadDetails(user, lead) {
    if (!canAccess(user, lead)) return null;
    return {
        id: lead.id,
        leadNumber: publicLeadNumber(lead.lead_number),
        customerName: lead.customer_name,
        mobile: maskIndianMobileNumber(lead.mobile_number),
        stage: lead.stage,
        owner: lead.owner || 'Unassigned',
        createdAt: lead.created_at
    };
}

async function canAccessLeadAsync(user, lead) {
    const access = ROLE_ACCESS[user.role] || 'own';
    if (access === 'all') return true;
    if (access === 'team') {
        const assigned = lead.assigned_to ? await repository.get('SELECT manager_id FROM staff WHERE id = ?', [lead.assigned_to]) : null;
        return lead.assigned_to === user.id || assigned?.manager_id === user.id;
    }
    return lead.assigned_to === user.id;
}

function isSurveyManager(user) {
    return ['Admin/Owner', 'Sales Manager', 'GM/AGM'].includes(user?.role);
}

function getSurveyRow(surveyId) {
    return database.prepare(`SELECT s.*, l.lead_number, l.customer_name, l.mobile_number, l.email, l.location, l.assigned_to AS lead_owner_id, l.stage AS lead_stage, l.details_json AS lead_details_json, st.name AS assigned_engineer
        FROM surveys s JOIN leads l ON l.id = s.lead_id LEFT JOIN staff st ON st.id = s.assigned_to WHERE s.id = ?`).get(surveyId) || null;
}

function surveyCanView(user, survey) {
    return canViewSurvey(user, survey, canAccess, isAdminUser);
}

function surveyCanEdit(user, survey) {
    return canEditSurvey(user, survey, canAccess, isAdminUser);
}

function surveyDetailsPayload(survey, user, includeFiles = false) {
    let data = {};
    try { data = survey.completion_data_json ? JSON.parse(survey.completion_data_json) : {}; } catch (error) { data = {}; }
    let leadDetails = {};
    try { leadDetails = survey.lead_details_json ? JSON.parse(survey.lead_details_json) : {}; } catch (error) { leadDetails = {}; }
    const payload = {
        ...data,
        id: survey.id,
        leadId: survey.lead_id,
        leadNumber: publicLeadNumber(survey.lead_number),
        leadNumberStatus: publicLeadNumber(survey.lead_number) ? 'VALID' : 'NEEDS_REVIEW',
        customerName: survey.customer || survey.customer_name,
        mobileNumber: survey.mobile_number,
        alternateNumber: data.alternateNumber || leadDetails.alternateNumber || '',
        email: survey.email || '',
        address: survey.address,
        pincode: data.pincode || leadDetails.pincode || '',
        location: survey.location,
        systemCapacity: data.systemCapacity || data.proposedSystemCapacity || survey.recommended_capacity || '',
        proposedSystemCapacity: data.proposedSystemCapacity || survey.recommended_capacity || '',
        sanctionedLoad: data.sanctionedLoad || survey.sanctioned_load || '',
        surveyType: survey.survey_type,
        status: survey.status,
        surveyDate: survey.survey_date,
        assignedTo: survey.assigned_to,
        assignedEngineer: survey.assigned_engineer,
        engineerPhone: null,
        createdAt: data.createdAt || survey.created_at || null,
        completedAt: survey.completed_at,
        notes: survey.remarks || data.notes || '',
        latitude: survey.latitude,
        longitude: survey.longitude,
        locationAccuracy: survey.location_accuracy,
        canEdit: surveyCanEdit(user, survey),
        canAssign: isSurveyManager(user),
        canDelete: isAdminUser(user),
        canUploadFiles: user.role !== 'Telecaller' && (isSurveyManager(user) || survey.assigned_to === user.id)
    };
    if (user.role === 'Telecaller') {
        return { id: payload.id, leadId: payload.leadId, leadNumber: payload.leadNumber, customerName: payload.customerName, status: payload.status, surveyDate: payload.surveyDate, assignedEngineer: payload.assignedEngineer, canEdit: false, canAssign: false, canDelete: false, canUploadFiles: false };
    }
    if (includeFiles) payload.files = database.prepare("SELECT id, category, original_file_name AS fileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(uploaded_at) DESC").all(survey.id);
    payload.activities = database.prepare("SELECT id, title, description, user_id AS userId, created_at AS createdAt FROM lead_activities WHERE lead_id = ? AND related_record_type = 'survey' AND related_record_id = ? ORDER BY datetime(created_at) DESC").all(survey.lead_id, survey.id);
    return payload;
}

function isAdminUser(user) {
    return user && user.role === 'Admin/Owner';
}

function isLeadOwner(user, lead) {
    if (!user || !lead) return false;
    return String(lead.assigned_to || '').trim() === String(user.id || '').trim() || String(lead.owner_id || '').trim() === String(user.id || '').trim();
}

function canEditLead(user, lead) {
    return isAdminUser(user) || canAccess(user, lead);
}

function canAssignLead(user) {
    return isAdminUser(user);
}

function canManageFollowUp(user, lead, task = null) {
    if (!user || !lead) return false;
    if (isAdminUser(user)) return true;
    if (canAccess(user, lead)) return true;
    const taskAssignee = task && (task.assigned_to || task.assignedTo);
    if (taskAssignee && String(taskAssignee) === String(user.id)) return true;
    const managerRoles = new Set(['Sales Manager', 'GM/AGM']);
    if (managerRoles.has(user.role)) {
        const leadManager = lead.assigned_to ? database.prepare('SELECT manager_id FROM staff WHERE id = ?').get(lead.assigned_to)?.manager_id : null;
        const taskManager = taskAssignee ? database.prepare('SELECT manager_id FROM staff WHERE id = ?').get(taskAssignee)?.manager_id : null;
        if (leadManager === user.id || taskManager === user.id) return true;
    }
    return false;
}

function canAddFollowUp(user, lead, task = null) {
    return canManageFollowUp(user, lead, task);
}

function canAssignToEmployee(user, employeeId) {
    if (!user || !employeeId) return false;
    if (String(employeeId) === String(user.id)) return true;
    if (isAdminUser(user)) return true;
    if (!['Sales Manager', 'GM/AGM'].includes(user.role)) return false;
    return Boolean(database.prepare('SELECT id FROM staff WHERE id = ? AND manager_id = ? AND status = ?').get(employeeId, user.id, 'Active'));
}

function rejectOwnerChangeAttempt(user, lead, body) {
    const forbidden = ['owner_id', 'lead_owner', 'assigned_employee', 'assigned_to', 'ownerId', 'leadOwner', 'assignedEmployee', 'assignedTo'];
    const attemptedOwnerField = forbidden.find((field) => Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined && body[field] !== null && String(body[field]).trim() !== '');
    if (!attemptedOwnerField) return null;
    if (isAdminUser(user)) return null;
    if (!lead) return { status: 403, error: 'Only administrators can change the lead owner.' };
    return { status: 403, error: 'Only administrators can change the lead owner.' };
}

function assertLeadOwnerAccess(user, lead, errorMessage = 'You are not the owner of this lead.') {
    if (isAdminUser(user)) return;
    if (!isLeadOwner(user, lead)) {
        throw { status: 403, error: errorMessage };
    }
}

function audit(user, action, recordType, recordId, details = {}) {
    database.prepare('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, action, recordType, recordId, JSON.stringify(details), now());
    const leadId = recordType === 'lead' ? recordId : database.prepare(`SELECT lead_id AS id FROM ${recordType === 'follow-up' ? 'follow_ups' : recordType === 'opportunity' ? 'opportunities' : recordType === 'project' ? 'projects' : recordType === 'survey' ? 'surveys' : recordType === 'proposal' ? 'proposals' : recordType === 'quotation' ? 'quotations' : recordType === 'document' ? 'lead_documents' : recordType === 'note' ? 'lead_notes' : recordType === 'communication' ? 'lead_communications' : 'lead_activities'} WHERE id = ?`).get(recordId)?.id;
    if (!leadId) return;
    const type = recordType === 'follow-up' ? 'Follow-ups' : recordType === 'communication' ? (action.includes('whatsapp') ? 'WhatsApp' : action.includes('email') ? 'Email' : 'Calls') : recordType === 'lead' ? 'Lead' : recordType.charAt(0).toUpperCase() + recordType.slice(1);
    const title = action === 'Created' && recordType === 'lead' ? 'Lead Created' : action === 'Reassigned' ? 'Lead Reassigned' : `${recordType === 'follow-up' ? 'Follow-up' : recordType.charAt(0).toUpperCase() + recordType.slice(1)} ${action}`;
    database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), leadId, type, title, details.description || JSON.stringify(details), user.id, recordType, recordId, details.previous || details.previousStage || details.previousStatus || null, details.next || details.newStage || details.newStatus || null, now());
}

function readSettingsRecord() {
    const stored = database.prepare("SELECT value FROM app_settings WHERE key = 'crm_settings'").get();
    const parsed = stored ? (() => { try { return JSON.parse(stored.value); } catch (error) { return {}; } })() : {};
    const settings = {
        ...SETTINGS_DEFAULTS,
        ...parsed,
        solarPricing: migrateLegacySolarPricing({
            ...SETTINGS_DEFAULTS.solarPricing,
            ...(parsed.solarPricing || {})
        })
    };
    delete settings.leadSettings?.leadNumberPrefix;
    delete settings.numbering?.leadPrefix;
    delete settings.numbering?.nextLeadNumber;
    return settings;
}

function writeSettingsRecord(user, nextSettings) {
    const merged = { ...SETTINGS_DEFAULTS, ...readSettingsRecord(), ...nextSettings };
    delete merged.leadSettings?.leadNumberPrefix;
    delete merged.numbering?.leadPrefix;
    delete merged.numbering?.nextLeadNumber;
    const updatedBy = user?.id || 'system';
    database.prepare("INSERT INTO app_settings (key, value, type, updated_by, updated_at, description) VALUES (?, ?, 'json', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run('crm_settings', JSON.stringify(merged), updatedBy, now(), 'Primary CRM account settings');
    return merged;
}

function isSensitiveSettingKey(key) {
    return ['emailpassword', 'whatsappapikey', 'integrationapikey', 'integrationwebhookurl', 'webhooksecret', 'apikey', 'password', 'token', 'secret', 'smtppassword'].includes(String(key || '').toLowerCase());
}

function mergeSettingsPreservingSecrets(current, incoming) {
    if (Array.isArray(incoming)) return incoming;
    if (!incoming || typeof incoming !== 'object') return incoming;
    const merged = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    Object.entries(incoming).forEach(([key, value]) => {
        if (isSensitiveSettingKey(key) && typeof value === 'string' && value.includes('•')) return;
        merged[key] = value && typeof value === 'object' ? mergeSettingsPreservingSecrets(merged[key], value) : value;
    });
    return merged;
}

function maskSensitiveSettingValue(key, value) {
    if (value === null || value === undefined || value === '') return value;
    if (!isSensitiveSettingKey(key)) return value;
    if (typeof value === 'string' && value.length > 8) return `${value.slice(0, 2)}••••••${value.slice(-2)}`;
    return '••••••';
}

function maskSettingsPayload(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    const masked = { ...settings };
    Object.keys(masked).forEach((key) => {
        const value = masked[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) masked[key] = maskSettingsPayload(value);
        else if (Array.isArray(value)) masked[key] = value.map((item) => (item && typeof item === 'object' ? maskSettingsPayload(item) : item));
        else if (isSensitiveSettingKey(key)) masked[key] = maskSensitiveSettingValue(key, value);
    });
    return masked;
}

function recordSystemError(message, details = {}) {
    const entry = {
        id: crypto.randomUUID(),
        message: String(message || 'Unknown system error'),
        details: typeof details === 'string' ? details : JSON.stringify(details),
        created_at: now()
    };
    try {
        database.prepare('INSERT INTO system_errors (id, message, details, created_at) VALUES (?, ?, ?, ?)').run(entry.id, entry.message, entry.details, entry.created_at);
    } catch (error) {
        console.error('Unable to record system error.', { errorType: safeErrorType(error) });
    }
}

function notify(userId, type, message, recordType, recordId) {
    if (!userId) return;
    database.prepare('INSERT INTO notifications (id, user_id, type, message, record_type, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), userId, type, message, recordType, recordId, now());
}

function syncLeadScoreFields(leadRecord) {
    if (!leadRecord || !leadRecord.id) return null;
    const snapshot = getLeadScoreSnapshot(leadRecord);
    const scoreColumns = ['lead_score', 'lead_category', 'monthly_bill', 'property_type', 'roof_available', 'interested_in_solar', 'decision_maker', 'bengaluru_zone'];
    const columnCheck = database.prepare('PRAGMA table_info(leads)').all();
    const existingColumns = new Set(columnCheck.map((column) => String(column.name).toLowerCase()));
    if (!scoreColumns.every((column) => existingColumns.has(column))) return snapshot;
    database.prepare('UPDATE leads SET lead_score = ?, lead_category = ?, monthly_bill = ?, property_type = ?, roof_available = ?, interested_in_solar = ?, decision_maker = ?, bengaluru_zone = ? WHERE id = ?')
        .run(snapshot.leadScore, snapshot.leadCategory, snapshot.monthlyBill || null, snapshot.propertyType || null, snapshot.roofAvailable || null, snapshot.interestedInSolar || null, snapshot.decisionMaker || null, snapshot.bengaluruZone || null, leadRecord.id);
    return snapshot;
}

function normalizeLead(row) {
    if (!row) return null;
    row.lead_number = publicLeadNumber(row.lead_number);
    let details = {};
    const owner = row.assigned_to ? database.prepare('SELECT id, name, designation, role, status FROM staff WHERE id = ?').get(row.assigned_to) : null;
    try { details = row.details_json ? JSON.parse(row.details_json) : {}; } catch (error) { details = {}; }
    const followUps = database.prepare('SELECT f.id, f.lead_id AS leadId, f.type, f.due_at AS dueAt, f.assigned_to AS assignedTo, s.name AS assignedEmployee, f.status, f.task_status AS taskStatus, f.task_title AS taskTitle, f.notes, f.created_by AS createdBy, f.created_at AS createdAt, f.completed_at AS completedAt, f.completed_by AS completedBy, f.task_completed_at AS taskCompletedAt, f.task_completed_by AS taskCompletedBy, f.outcome, f.missed_reason AS missedReason FROM follow_ups f LEFT JOIN staff s ON s.id = f.assigned_to WHERE f.lead_id = ? ORDER BY datetime(f.due_at) DESC').all(row.id);
    const communications = database.prepare('SELECT c.id, c.lead_id AS leadId, c.type, c.recipient, c.subject, c.message, c.status, c.created_by AS createdBy, s.name AS createdByName, c.created_at AS createdAt FROM lead_communications c LEFT JOIN staff s ON s.id = c.created_by WHERE c.lead_id = ? ORDER BY datetime(c.created_at) DESC').all(row.id);
    const activities = database.prepare('SELECT a.id, a.lead_id AS leadId, a.activity_type AS activityType, a.title, a.description, a.user_id AS userId, s.name AS userName, s.role AS userRole, a.related_record_type AS relatedRecordType, a.related_record_id AS relatedRecordId, a.previous_value AS previousValue, a.new_value AS newValue, a.created_at AS createdAt FROM lead_activities a LEFT JOIN staff s ON s.id = a.user_id WHERE a.lead_id = ? ORDER BY datetime(a.created_at) DESC').all(row.id);
    activities.forEach((activity) => {
        activity.title = publicLeadNumberText(activity.title);
        activity.description = publicLeadNumberText(activity.description);
        activity.previousValue = publicLeadNumberText(activity.previousValue);
        activity.newValue = publicLeadNumberText(activity.newValue);
    });
    const survey = database.prepare('SELECT s.*, st.name AS assignedEngineer FROM surveys s LEFT JOIN staff st ON st.id = s.assigned_to WHERE s.lead_id = ?').get(row.id) || null;
    const surveyFiles = survey ? database.prepare("SELECT f.id, f.category, f.file_name AS fileName, f.original_file_name AS originalFileName, f.mime_type AS mimeType, f.file_size AS fileSize, f.uploaded_by AS uploadedBy, s.name AS uploadedByName, f.uploaded_at AS uploadedAt, f.status, f.latitude, f.longitude FROM survey_files f LEFT JOIN staff s ON s.id = f.uploaded_by WHERE f.survey_id = ? AND f.status = 'UPLOADED' AND f.storage_path IS NOT NULL ORDER BY datetime(f.uploaded_at) DESC").all(survey.id) : [];
    if (survey) survey.files = surveyFiles;
    const documents = database.prepare("SELECT id, document_type AS documentType, file_name AS fileName, original_file_name AS originalFileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, created_at AS createdAt, status FROM lead_documents WHERE lead_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(created_at) DESC").all(row.id);
    const files = [...documents.map((file) => ({ ...file, category: file.documentType, uploadedAt: file.createdAt, relatedType: 'lead' })), ...surveyFiles.map((file) => ({ ...file, relatedType: 'survey' }))];
    const leadScoreSnapshot = getLeadScoreSnapshot({ ...row, details_json: row.details_json, details });
    return { leadId: row.id, leadNumber: row.lead_number || null, customerName: row.customer_name, mobileNumber: row.mobile_number, email: row.email, leadDate: row.lead_date, leadSource: row.lead_source, assignedTo: row.assigned_to, assignedEmployee: owner?.name || null, owner: owner ? { id: owner.id, name: owner.name, designation: owner.designation, role: owner.role, status: owner.status } : null, leadStage: row.stage, leadStatus: row.status, leadPriority: row.priority, location: row.location, createdBy: row.created_by, createdDate: row.created_at, updatedDate: row.updated_at, details, leadScore: Number(row.lead_score || leadScoreSnapshot.leadScore || 0), leadCategory: row.lead_category || leadScoreSnapshot.leadCategory || 'Low', hotDealPercentage: Number(row.lead_score || leadScoreSnapshot.leadScore || 0), stageRequirements: stageMissing(row, {}), followUps, communications, activities, survey, siteSurvey: survey, documents, files, communication: communications, stageHistory: database.prepare('SELECT stage, started_at AS startedAt, completed_at AS completedAt, completed_by AS completedBy, duration_seconds AS durationSeconds, remarks FROM lead_stage_history WHERE lead_id = ? ORDER BY datetime(started_at)').all(row.id) };
}

function stageMissing(lead, body) {
    const details = (() => { try { return lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { return {}; } })();
    const missing = [];
    const has = (field, fallback = '') => String(body[field] ?? details[field] ?? fallback).trim();
    const hasInteraction = database.prepare("SELECT id FROM lead_communications WHERE lead_id = ? AND status IN ('Attempted', 'Completed', 'Initiated') LIMIT 1").get(lead.id) || database.prepare("SELECT id FROM follow_ups WHERE lead_id = ? AND status IN ('Completed', 'Scheduled', 'Pending') AND task_status NOT IN ('CANCELLED', 'DELETED') LIMIT 1").get(lead.id);
    const requestedFollowUp = body.nextFollowUpDate && body.nextFollowUpTime && `${body.nextFollowUpDate}T${body.nextFollowUpTime}` > new Date().toISOString();
    const futureFollowUp = database.prepare("SELECT id FROM follow_ups WHERE lead_id = ? AND status IN ('Pending', 'Scheduled') AND datetime(due_at) > datetime('now') LIMIT 1").get(lead.id) || requestedFollowUp;
    if (['Working', 'Nurturing'].includes(lead.stage) && body.outcome === 'Lost') {
        if (!has('lostReason')) missing.push('Lost Reason');
        if (!has('remarks')) missing.push('Lost Remarks');
    }
    if (lead.stage === 'New') {
        if (!lead.assigned_to) missing.push('Assigned salesperson');
        if (!lead.customer_name) missing.push('Customer Name');
        if (!lead.mobile_number) missing.push('Mobile Number');
        if (!lead.lead_source) missing.push('Lead Source');
        if (!hasInteraction && !futureFollowUp) missing.push('First contact attempt or follow-up scheduled');
    } else if (lead.stage === 'Working') {
    } else if (lead.stage === 'Nurturing') {
    } else if (lead.stage === 'Opportunity') {
        ['requirement', 'systemCapacity', 'estimatedValue', 'expectedCloseDate'].forEach((field) => { if (!has(field)) missing.push(field); });
        if (!has('siteSurveyRequired')) missing.push('Site survey requirement');
        if (!has('customerAgreesSurvey')) missing.push('Customer agreement to survey');
    } else if (lead.stage === 'Site Survey Scheduled') {
        const survey = database.prepare('SELECT * FROM surveys WHERE lead_id = ?').get(lead.id);
        if (!survey) missing.push('Survey ID', 'Survey date', 'Survey time', 'Surveyor', 'Site address', 'Survey status');
        else {
            const requiredFields = [['latitude', 'Latitude'], ['longitude', 'Longitude'], ['locationAccuracy', 'Location accuracy'], ['electricityProvider', 'Electricity provider'], ['consumerNumber', 'Consumer number'], ['meterNumber', 'Meter number'], ['sanctionedLoad', 'Sanctioned load'], ['phase', 'Phase'], ['proposedCapacity', 'Proposed system capacity'], ['systemType', 'System type'], ['installationType', 'Installation type'], ['roofType', 'Roof type'], ['roofArea', 'Roof area'], ['usableRoofArea', 'Usable roof area'], ['roofCondition', 'Roof condition'], ['shadowCondition', 'Shadow condition'], ['roofDirection', 'Roof direction'], ['existingEarthing', 'Existing earthing'], ['earthingCondition', 'Earthing condition'], ['roofAccess', 'Roof access'], ['engineerObservations', 'Engineer observations']];
            requiredFields.forEach(([field, label]) => { if (!has(field)) missing.push(label); });
            if (!survey.id) missing.push('Survey ID');
            if (!survey.survey_date) missing.push('Survey date and time');
            if (!survey.assigned_to) missing.push('Surveyor');
            if (!survey.address) missing.push('Site address');
            let files = [];
            try { files = Array.isArray(body.surveyFiles) ? body.surveyFiles : JSON.parse(body.surveyFiles || '[]'); } catch (error) { files = []; }
            const existingCategories = new Set(database.prepare("SELECT category FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL").all(survey.id).map((file) => file.category));
            files.forEach((file) => existingCategories.add(file.category));
            ['EAST_SIDE_PHOTO', 'WEST_SIDE_PHOTO', 'NORTH_SIDE_PHOTO', 'SOUTH_SIDE_PHOTO', 'ELECTRICITY_METER_PHOTO', 'ELECTRICITY_BILL', 'EARTHING_LOCATION_PHOTO', 'ROOF_PHOTO', 'ROOF_360_VIDEO'].forEach((category) => { if (!existingCategories.has(category)) missing.push(category); });
        }
    } else if (lead.stage === 'Survey Completed') {
        const survey = database.prepare("SELECT * FROM surveys WHERE lead_id = ? AND status = 'Completed'").get(lead.id);
        if (!survey) missing.push('Survey completed');
        else {
            ['sanctioned_load', 'electricity_details', 'roof_information', 'recommended_capacity', 'remarks'].forEach((field) => { if (!String(survey[field] || '').trim() || survey[field] === 'Pending') missing.push(field); });
            if (!survey.feasibility) missing.push('Site feasibility');
            if (survey.feasibility === 'Site Not Feasible') missing.push('Site feasibility');
        }
        if (!database.prepare('SELECT id FROM proposals WHERE lead_id = ?').get(lead.id)) missing.push('Proposal or quotation');
    } else if (lead.stage === 'Order Booked') {
        const booking = database.prepare('SELECT * FROM bookings WHERE lead_id = ?').get(lead.id);
        const project = database.prepare('SELECT * FROM projects WHERE lead_id = ?').get(lead.id);
        if (!booking && !project) missing.push('Booking/Order ID', 'Proposal or quotation', 'Final project value', 'Booking date', 'Booking amount/status', 'Salesperson', 'Customer confirmation');
    } else if (lead.stage === 'Loan Process') {
        if (body.loanRequired !== false) {
            ['financeProvider', 'loanApplicationNumber', 'loanApplicationDate', 'loanAmount', 'loanDocuments', 'loanStatus'].forEach((field) => { if (!has(field)) missing.push(field); });
        }
    } else if (lead.stage === 'Completed') {
        const completedProject = database.prepare("SELECT projects.id FROM projects JOIN commissioning ON commissioning.project_id = projects.id WHERE projects.lead_id = ? AND commissioning.status IN ('Commissioned', 'Completed')").get(lead.id);
        if (!completedProject) missing.push('Installation', 'Commissioning', 'Project completion confirmation');
        if (!database.prepare('SELECT id FROM lead_documents WHERE lead_id = ?').get(lead.id)) missing.push('Required documents');
    }
    return missing;
}

function completeStage(user, lead, body) {
    const missing = stageMissing(lead, body);
    if (missing.length) return { missing };
    const timestamp = now();

    const existingCompletion = database.prepare("SELECT id FROM lead_activities WHERE lead_id = ? AND activity_type = 'LEAD_COMPLETED' LIMIT 1").get(lead.id);
    if (existingCompletion) {
        return { alreadyCompleted: true, completionActivityId: existingCompletion.id, message: 'Lead is already completed.' };
    }

    const currentIndex = ACTIVE_STAGE_FLOW.indexOf(lead.stage);
    let nextStage = lead.stage === 'Working' ? ({ Nurturing: 'Nurturing', Opportunity: 'Opportunity', Lost: 'Lost' }[body.outcome] || 'Nurturing') : lead.stage === 'Nurturing' ? ({ Working: 'Working', Opportunity: 'Opportunity', Lost: 'Lost' }[body.outcome] || 'Working') : lead.stage === 'Order Booked' && body.loanRequired !== false ? 'Loan Process' : lead.stage === 'Order Booked' ? 'Completed' : ACTIVE_STAGE_FLOW[currentIndex + 1];
    if (lead.stage === 'Working' && !nextStage || lead.stage === 'Nurturing' && !nextStage) return { missing: ['A valid next-stage outcome'] };
    if (lead.stage === 'Lost') return { missing: ['Lost leads cannot be completed'] };
    if (!nextStage) return { missing: ['Final completion requirements'] };
    if (nextStage === 'Lost' && !String(body.lostReason || '').trim()) return { missing: ['Lost Reason'] };
    const currentHistory = database.prepare('SELECT id, started_at FROM lead_stage_history WHERE lead_id = ? AND stage = ? AND completed_at IS NULL ORDER BY datetime(started_at) DESC LIMIT 1').get(lead.id, lead.stage);
    const storedPaths = [];
    database.exec('BEGIN');
    try {
        const surveyForCompletion = lead.stage === 'Site Survey Scheduled' ? database.prepare('SELECT id FROM surveys WHERE lead_id = ?').get(lead.id) : null;
        if (surveyForCompletion) {
            let surveyFiles = [];
            try { surveyFiles = Array.isArray(body.surveyFiles) ? body.surveyFiles : JSON.parse(body.surveyFiles || '[]'); } catch (error) { surveyFiles = []; }
            const completionData = { ...body };
            delete completionData.surveyFiles;
            database.prepare('UPDATE surveys SET latitude = ?, longitude = ?, location_accuracy = ?, location_captured_at = ?, completion_data_json = ?, sanctioned_load = ?, electricity_details = ?, roof_information = ?, recommended_capacity = ?, remarks = ?, status = ?, completed_at = ? WHERE id = ?').run(body.latitude, body.longitude, body.locationAccuracy, body.locationCapturedAt || timestamp, JSON.stringify(completionData), body.sanctionedLoad, JSON.stringify({ provider: body.electricityProvider, consumerNumber: body.consumerNumber, meterNumber: body.meterNumber, phase: body.phase }), JSON.stringify({ roofType: body.roofType, roofArea: body.roofArea, usableRoofArea: body.usableRoofArea, roofCondition: body.roofCondition, shadowCondition: body.shadowCondition, roofDirection: body.roofDirection }), body.proposedCapacity, body.engineerObservations, 'Completed', timestamp, surveyForCompletion.id);
            const insertFile = database.prepare('INSERT INTO survey_files (id, survey_id, lead_id, category, file_name, mime_type, file_size, file_data, uploaded_by, uploaded_at, latitude, longitude, storage_path, original_file_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            surveyFiles.forEach((file) => { const stored = saveUploadedFile(file); storedPaths.push(stored.storagePath); insertFile.run(crypto.randomUUID(), surveyForCompletion.id, lead.id, file.category, stored.originalFileName, stored.mimeType, stored.fileSize, null, user.id, timestamp, body.latitude, body.longitude, stored.storagePath, stored.originalFileName, 'UPLOADED'); });
            const linkedTask = database.prepare("SELECT id FROM follow_ups WHERE task_related_type = 'survey' AND task_related_id = ?").get(surveyForCompletion.id);
            if (linkedTask) database.prepare("UPDATE follow_ups SET status = 'Completed', task_status = 'COMPLETED', task_completed_at = ?, task_completed_by = ?, completed_at = ?, completed_by = ? WHERE id = ?").run(timestamp, user.id, timestamp, user.id, linkedTask.id);
        }
        if (currentHistory) database.prepare('UPDATE lead_stage_history SET completed_at = ?, completed_by = ?, duration_seconds = ?, remarks = ? WHERE id = ?').run(timestamp, user.id, Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(currentHistory.started_at)) / 1000)), body.remarks || null, currentHistory.id);
        database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), lead.id, nextStage, timestamp);
        const details = (() => { try { return lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { return {}; } })();
        const updatedDetails = { ...details, ...body, surveyFiles: undefined, ...(nextStage === 'Lost' ? { lostReason: body.lostReason, lostDate: timestamp, lostBy: user.id } : {}) };
        if (nextStage === 'Opportunity' && !database.prepare('SELECT id FROM opportunities WHERE lead_id = ?').get(lead.id)) database.prepare('INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, expected_close_date, probability, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`OPP-${lead.id}`, lead.id, lead.customer_name, body.systemCapacity || details.systemCapacity || null, Number(body.estimatedValue || details.estimatedValue || 0), lead.assigned_to, body.expectedCloseDate || details.expectedCloseDate || null, Number(body.probability || details.probability || 0), 'Qualified', user.id, timestamp, timestamp);
        database.prepare('UPDATE leads SET stage = ?, status = ?, details_json = ?, updated_at = ? WHERE id = ?').run(nextStage, nextStage === 'Lost' ? 'Lost' : lead.status, JSON.stringify(updatedDetails), timestamp, lead.id);
        const savedLead = database.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id);
        if (!savedLead || savedLead.stage !== nextStage) throw new Error('Stage update verification failed.');

        const completedLeadStatus = nextStage === 'Completed' ? 'Completed' : lead.status === 'Completed' ? 'Completed' : lead.status;
        const completionActivityId = crypto.randomUUID();
        database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(completionActivityId, lead.id, 'LEAD_COMPLETED', 'Lead Completed', 'Lead was completed successfully.', user.id, 'lead', lead.id, lead.stage, nextStage, timestamp);
        database.prepare('UPDATE leads SET status = ?, stage = ?, updated_at = ? WHERE id = ?').run(completedLeadStatus, nextStage, timestamp, lead.id);

        audit(user, 'Stage completed', 'lead', lead.id, { previous: lead.stage, next: nextStage, remarks: body.remarks || null });
        if (surveyForCompletion) audit(user, 'Completed', 'survey', surveyForCompletion.id, { description: 'Site survey completed with mandatory evidence and location.' });
        if (lead.assigned_to) notify(lead.assigned_to, 'stage-changed', `Lead ${lead.id} moved to ${nextStage}.`, 'lead', lead.id);
        database.exec('COMMIT');
        return { nextStage, completionActivityId };
    } catch (error) {
        database.exec('ROLLBACK');
        storedPaths.forEach(removeStoredFile);
        throw error;
    }
}

function accessibleLeadIds(user) {
    const access = ROLE_ACCESS[user.role] || 'own';
    if (access === 'all') return database.prepare('SELECT id FROM leads ORDER BY created_at DESC').all().map((lead) => lead.id);
    if (access === 'team') return database.prepare('SELECT id FROM leads WHERE assigned_to = ? OR assigned_to IN (SELECT id FROM staff WHERE manager_id = ?) ORDER BY created_at DESC').all(user.id, user.id).map((lead) => lead.id);
    return database.prepare('SELECT id FROM leads WHERE assigned_to = ? ORDER BY created_at DESC').all(user.id).map((lead) => lead.id);
}

function markOverdueFollowUps() {
    database.prepare(`UPDATE follow_ups SET status = 'Overdue', task_status = 'OVERDUE' WHERE status IN ('Scheduled', 'Pending') AND task_status = 'PENDING' AND datetime(due_at) < datetime('now')`).run();
}

function toLocalDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dashboardPeriodRange(period, referenceDate = new Date()) {
    if (period === 'all') {
        return {
            startDate: '0000-01-01',
            endDate: '9999-12-31'
        };
    }
    if (!['today', 'week', 'month'].includes(period)) return null;
    const today = new Date(referenceDate);
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    const end = new Date(today);
    if (period === 'week') {
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        end.setDate(start.getDate() + 6);
    } else if (period === 'month') {
        start.setDate(1);
        end.setMonth(end.getMonth() + 1, 0);
    }
    return {
        startDate: toLocalDateKey(start),
        endDate: toLocalDateKey(end)
    };
}

function taskTitle(type) {
    return ({ WhatsApp: 'WhatsApp follow-up with customer', Call: 'Call customer regarding solar proposal', 'Site Visit': 'Site visit with customer', Meeting: 'Meeting with customer', 'Proposal Discussion': 'Follow up on quotation', 'Payment Follow-up': 'Follow up on payment' })[type] || 'Follow up with customer';
}

function normalizeFollowUpStatus(row) {
    const raw = String(row.status || '').trim();
    const taskStatus = String(row.task_status || '').trim().toUpperCase();
    const dueAt = row.due_at ? new Date(row.due_at) : null;
    const isOverdue = dueAt && dueAt < new Date() && !['COMPLETED', 'CANCELLED', 'RESCHEDULED'].includes(taskStatus) && !['Completed', 'Cancelled', 'Rescheduled'].includes(raw);
    if (raw === 'Overdue' || taskStatus === 'OVERDUE' || isOverdue) return 'Overdue';
    if (raw === 'Completed' || taskStatus === 'COMPLETED') return 'Completed';
    if (raw === 'Cancelled' || taskStatus === 'CANCELLED') return 'Cancelled';
    if (raw === 'Rescheduled' || taskStatus === 'RESCHEDULED') return 'Rescheduled';
    return raw || 'Pending';
}

function taskRow(row) {
    const status = row.task_status || (row.status === 'Completed' ? 'COMPLETED' : row.status === 'Overdue' ? 'OVERDUE' : 'PENDING');
    const leadNumber = publicLeadNumber(row.lead_number);
    return { taskId: row.id, followUpId: row.id, leadId: row.lead_id, leadNumber, leadNumberStatus: leadNumber ? 'VALID' : 'NEEDS_REVIEW', leadName: row.customer_name, taskType: row.type, taskTitle: row.task_title || taskTitle(row.type), notes: row.notes || '', dueAt: row.due_at, createdAt: row.created_at, createdBy: row.created_by, assignedTo: row.assigned_to, assignedEmployee: row.assigned_employee || null, status, completedAt: row.task_completed_at || row.completed_at || null, completedBy: row.task_completed_by || row.completed_by || null, relatedRecordType: row.task_related_type || null, relatedRecordId: row.task_related_id || null };
}

function publicLeadNumberFields(row) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'lead_number')) return row;
    const leadNumber = publicLeadNumber(row.lead_number);
    return { ...row, lead_number: leadNumber, leadNumber, leadNumberStatus: leadNumber ? 'VALID' : 'NEEDS_REVIEW' };
}

function publicLeadNumberText(value) {
    return typeof value === 'string' ? value.replace(/\bINP-[0-9]+\b/g, (number) => publicLeadNumber(number) || 'Lead Number unavailable') : value;
}

function accessibleTaskRows(user) {
    return database.prepare(`SELECT f.*, l.lead_number, l.customer_name, s.name AS assigned_employee FROM follow_ups f JOIN leads l ON l.id = f.lead_id LEFT JOIN staff s ON s.id = f.assigned_to ORDER BY datetime(f.due_at) ASC`).all().filter((row) => canAccess(user, { assigned_to: row.assigned_to, created_by: row.created_by })).map(taskRow);
}

function canViewInventory(user) {
    return user && user.role !== 'Telecaller';
}

function canManageInventory(user) {
    return user && ['Admin/Owner', 'GM/AGM', 'Sales Manager'].includes(user.role);
}

function inventoryItem(row) {
    if (!row) return null;
    return { ...row, requiresSerial: Boolean(row.requires_serial), requiresBatch: Boolean(row.requires_batch), availableStock: Math.max(0, Number(row.total_stock || 0) - Number(row.reserved_stock || 0) - Number(row.issued_stock || 0) + Number(row.returned_stock || 0)), reservedStock: Number(row.reserved_stock || 0), issuedStock: Number(row.issued_stock || 0), damagedStock: Number(row.damaged_stock || 0), totalStock: Number(row.total_stock || 0) };
}

function inventoryDashboard() {
    const items = database.prepare('SELECT * FROM inventory ORDER BY product').all().map(inventoryItem);
    const today = new Date().toISOString().slice(0, 10);
    const movementCount = (action) => database.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_movements WHERE action = ? AND date(created_at) = ?').get(action, today).total;
    return {
        totalItems: items.length,
        totalStockQuantity: items.reduce((sum, item) => sum + item.totalStock, 0),
        availableStock: items.reduce((sum, item) => sum + item.availableStock, 0),
        reservedStock: items.reduce((sum, item) => sum + item.reservedStock, 0),
        issuedStock: items.reduce((sum, item) => sum + item.issuedStock, 0),
        lowStockItems: items.filter((item) => item.availableStock > 0 && item.availableStock <= Number(item.minimum_stock || item.low_stock_threshold || 0)).length,
        outOfStockItems: items.filter((item) => item.availableStock <= 0).length,
        damagedStock: items.reduce((sum, item) => sum + item.damagedStock, 0),
        returnedStock: items.reduce((sum, item) => sum + Number(item.returned_stock || 0), 0),
        totalInventoryValue: items.reduce((sum, item) => sum + item.totalStock * Number(item.purchase_price || 0), 0),
        stockInToday: movementCount('Stock In'),
        stockOutToday: movementCount('Stock Out'),
        pendingMaterialRequests: database.prepare("SELECT COUNT(*) AS count FROM material_requests WHERE status IN ('Submitted', 'Pending Approval')").get().count
    };
}

function writeInventoryMovement({ item, action, quantity, user, referenceId = null, projectId = null, leadId = null, batchNumber = null, serialNumbers = [], warehouse = null, remarks = null }) {
    const previous = inventoryItem(database.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id));
    const timestamp = now();
    const movementId = referenceId || `INV-${Date.now()}-${crypto.randomInt(100, 999)}`;
    let total = previous.totalStock;
    let reserved = previous.reservedStock;
    let issued = previous.issuedStock;
    let damaged = previous.damagedStock;
    let returned = Number(previous.returned_stock || 0);
    if (action === 'Stock In') total += quantity;
    if (action === 'Stock Out') issued += quantity;
    if (action === 'Return Good') { issued = Math.max(0, issued - quantity); returned += quantity; }
    if (action === 'Damage') { damaged += quantity; total = Math.max(0, total - quantity); }
    const available = Math.max(0, total - reserved - issued + returned);
    database.prepare('UPDATE inventory SET total_stock = ?, reserved_stock = ?, issued_stock = ?, damaged_stock = ?, returned_stock = ?, available_stock = ?, updated_at = ? WHERE id = ?').run(total, reserved, issued, damaged, returned, available, timestamp, item.id);
    database.prepare('INSERT INTO inventory_movements (id, inventory_id, action, quantity, previous_stock, new_stock, user_id, reference_id, project_id, lead_id, batch_number, serial_numbers, warehouse, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(movementId, item.id, action, quantity, previous.availableStock, available, user.id, referenceId, projectId, leadId, batchNumber, JSON.stringify(serialNumbers), warehouse, remarks, timestamp);
    database.prepare('INSERT INTO inventory_transactions (id, inventory_id, project_id, action, quantity, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(movementId, item.id, projectId, action, quantity, user.id, timestamp);
    if (leadId) database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), leadId, 'Inventory', `${quantity} ${item.product} - ${action}`, JSON.stringify({ quantity, referenceId, projectId, itemId: item.id }), user.id, 'inventory', movementId, timestamp);
    return { movementId, previousStock: previous.availableStock, newStock: available };
}

async function handleInventoryApi(request, response, url, user) {
    if (!url.pathname.startsWith('/api/inventory')) return false;
    if (!canViewInventory(user)) { json(response, 403, { error: 'You do not have permission to view Inventory.' }); return true; }
    if (request.method === 'GET' && url.pathname === '/api/inventory/dashboard') return json(response, 200, { dashboard: inventoryDashboard() });
    if (request.method === 'GET' && url.pathname === '/api/inventory/items') return json(response, 200, { items: database.prepare('SELECT * FROM inventory ORDER BY product').all().map(inventoryItem) });
    if (request.method === 'GET' && url.pathname === '/api/inventory/categories') return json(response, 200, { categories: database.prepare('SELECT * FROM inventory_categories ORDER BY name').all() });
    if (request.method === 'GET' && url.pathname === '/api/inventory/history') {
        const rows = database.prepare('SELECT m.*, i.product, i.sku, s.name AS user_name FROM inventory_movements m JOIN inventory i ON i.id = m.inventory_id LEFT JOIN staff s ON s.id = m.user_id ORDER BY datetime(m.created_at) DESC LIMIT 250').all();
        return json(response, 200, { history: rows });
    }
    if (request.method === 'GET' && url.pathname === '/api/inventory/material-requests') {
        return json(response, 200, { requests: database.prepare('SELECT r.*, s.name AS requested_by_name FROM material_requests r LEFT JOIN staff s ON s.id = r.requested_by ORDER BY datetime(r.created_at) DESC').all() });
    }
    if (request.method === 'GET' && url.pathname === '/api/inventory/projects') {
        const projects = database.prepare('SELECT p.id AS projectId, p.lead_id AS leadId, l.customer_name AS customerName, p.status FROM projects p JOIN leads l ON l.id = p.lead_id ORDER BY datetime(p.created_at) DESC').all().filter((project) => { const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.leadId); return canAccess(user, lead); });
        return json(response, 200, { projects });
    }
    if (!canManageInventory(user)) { json(response, 403, { error: 'You do not have permission to modify Inventory.' }); return true; }
    if (request.method === 'POST' && url.pathname === '/api/inventory/items') {
        const body = await parseBody(request);
        if (!String(body.product || '').trim() || !String(body.sku || '').trim()) return json(response, 422, { error: 'Product Name and SKU are required.' });
        if (database.prepare('SELECT id FROM inventory WHERE sku = ? OR product = ?').get(body.sku.trim(), body.product.trim())) return json(response, 409, { error: 'Item ID/SKU or Product already exists.' });
        const id = body.itemId || `INV-${Date.now()}`;
        database.prepare(`INSERT INTO inventory (id, product, sku, category, subcategory, brand, model, specification, unit, purchase_price, selling_price, minimum_stock, maximum_stock, reorder_level, total_stock, available_stock, warehouse, rack_bin, supplier, warranty_information, requires_serial, requires_batch, status, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`).run(id, body.product.trim(), body.sku.trim(), body.category || null, body.subcategory || null, body.brand || null, body.model || null, body.specification || null, body.unit || 'unit', Number(body.purchasePrice || 0), Number(body.sellingPrice || 0), Number(body.minimumStock || 0), Number(body.maximumStock || 0), Number(body.reorderLevel || 0), body.warehouse || null, body.rackBin || null, body.supplier || null, body.warrantyInformation || null, body.requiresSerial ? 1 : 0, body.requiresBatch ? 1 : 0, user.id, now());
        return json(response, 201, { item: inventoryItem(database.prepare('SELECT * FROM inventory WHERE id = ?').get(id)) });
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/categories') {
        const body = await parseBody(request); if (!String(body.name || '').trim()) return json(response, 422, { error: 'Category name is required.' });
        const id = crypto.randomUUID(); database.prepare('INSERT INTO inventory_categories (id, name, parent_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, body.name.trim(), body.parentName || null, user.id, now()); return json(response, 201, { id });
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/stock-in') {
        const body = await parseBody(request); const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(body.itemId); const quantity = Number(body.quantity);
        if (!item || !Number.isFinite(quantity) || quantity <= 0) return json(response, 422, { error: 'Valid item and quantity are required.' });
        database.exec('BEGIN'); try { const movement = writeInventoryMovement({ item, action: 'Stock In', quantity, user, referenceId: body.stockInId || `SIN-${Date.now()}`, batchNumber: body.batchNumber, serialNumbers: body.serialNumbers || [], warehouse: body.warehouse, remarks: body.remarks }); database.exec('COMMIT'); return json(response, 201, movement); } catch (error) { database.exec('ROLLBACK'); return json(response, 500, { error: 'Stock In could not be recorded.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/stock-out') {
        const body = await parseBody(request); const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(body.itemId); const quantity = Number(body.quantity); const current = inventoryItem(item);
        if (!item || !Number.isFinite(quantity) || quantity <= 0) return json(response, 422, { error: 'Valid item and quantity are required.' });
        if (quantity > current.availableStock) return json(response, 422, { error: 'INSUFFICIENT STOCK', required: quantity, available: current.availableStock, shortage: quantity - current.availableStock });
        database.exec('BEGIN'); try { const movement = writeInventoryMovement({ item, action: 'Stock Out', quantity, user, referenceId: body.stockOutId || `SOUT-${Date.now()}`, projectId: body.projectId, leadId: body.leadId, serialNumbers: body.serialNumbers || [], warehouse: body.warehouse, remarks: body.remarks }); database.exec('COMMIT'); return json(response, 201, movement); } catch (error) { database.exec('ROLLBACK'); return json(response, 500, { error: 'Stock Out could not be recorded.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/material-requests') {
        const body = await parseBody(request); if (!Array.isArray(body.items) || !body.items.length) return json(response, 422, { error: 'At least one material is required.' });
        const requestId = body.requestId || `MR-${Date.now()}`; const timestamp = now(); database.exec('BEGIN'); try { database.prepare('INSERT INTO material_requests (id, project_id, lead_id, order_id, installation_date, requested_by, department, required_date, priority, remarks, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(requestId, body.projectId || null, body.leadId || null, body.orderId || null, body.installationDate || null, user.id, body.department || null, body.requiredDate || null, body.priority || 'Medium', body.remarks || null, body.status === 'Submitted' ? 'Submitted' : 'Draft', timestamp, timestamp); const insert = database.prepare('INSERT INTO material_request_items (id, request_id, inventory_id, required_quantity) VALUES (?, ?, ?, ?)'); body.items.forEach((item) => insert.run(crypto.randomUUID(), requestId, item.itemId, Number(item.quantity))); database.exec('COMMIT'); return json(response, 201, { requestId }); } catch (error) { database.exec('ROLLBACK'); return json(response, 422, { error: 'Material request could not be created.' }); }
    }
    const requestMatch = url.pathname.match(/^\/api\/inventory\/material-requests\/([^/]+)$/);
    if (requestMatch && request.method === 'PATCH') {
        const requestId = decodeURIComponent(requestMatch[1]);
        const body = await parseBody(request);
        const status = body.status;
        if (!['Approved', 'Rejected', 'Cancelled'].includes(status)) return json(response, 422, { error: 'Invalid request status.' });
        if (status === 'Rejected' && !String(body.rejectionReason || '').trim()) return json(response, 422, { error: 'Rejection reason is required.' });
        const materialRequest = database.prepare('SELECT * FROM material_requests WHERE id = ?').get(requestId);
        if (!materialRequest) return json(response, 404, { error: 'Material request not found.' });
        if (status === 'Approved') {
            const requestedItems = database.prepare('SELECT * FROM material_request_items WHERE request_id = ?').all(requestId);
            database.exec('BEGIN');
            try {
                requestedItems.forEach((requested) => {
                    const item = database.prepare('SELECT * FROM inventory WHERE id = ?').get(requested.inventory_id);
                    const current = inventoryItem(item);
                    if (!item || requested.required_quantity > current.availableStock) throw new Error(`INSUFFICIENT STOCK for ${item?.product || requested.inventory_id}`);
                    const reserved = current.reservedStock + Number(requested.required_quantity);
                    database.prepare('UPDATE inventory SET reserved_stock = ?, available_stock = ?, updated_at = ? WHERE id = ?').run(reserved, Math.max(0, current.totalStock - reserved - current.issuedStock + Number(item.returned_stock || 0)), now(), item.id);
                    database.prepare('UPDATE material_request_items SET reserved_quantity = ? WHERE id = ?').run(requested.required_quantity, requested.id);
                    database.prepare('INSERT INTO inventory_movements (id, inventory_id, action, quantity, previous_stock, new_stock, user_id, reference_id, project_id, lead_id, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), item.id, 'Reservation', requested.required_quantity, current.availableStock, Math.max(0, current.availableStock - requested.required_quantity), user.id, requestId, materialRequest.project_id, materialRequest.lead_id, 'Material request approved', now());
                });
                database.prepare('UPDATE material_requests SET status = ?, rejection_reason = NULL, approved_by = ?, updated_at = ? WHERE id = ?').run(status, user.id, now(), requestId);
                database.exec('COMMIT');
            } catch (error) { database.exec('ROLLBACK'); return json(response, 422, { error: error.message }); }
        } else database.prepare('UPDATE material_requests SET status = ?, rejection_reason = ?, approved_by = ?, updated_at = ? WHERE id = ?').run(status, body.rejectionReason || null, user.id, now(), requestId);
        return json(response, 200, { success: true });
    }
    return json(response, 404, { error: 'Inventory route not found.' });
}

async function handleApi(request, response, url) {
    if (request.method === 'GET' && ['/api/health', '/api/health/database'].includes(url.pathname)) {
        try {
            return json(response, 200, { status: 'ok', ...(await repository.health()) });
        } catch (error) {
            console.error('Database health check failed.', { errorType: safeErrorType(error) });
            return json(response, 503, { database: databaseConfig.mode, connected: false });
        }
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/google/config') {
        return json(response, 200, { configured: Boolean(googleConfig(request)) });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/google/start') {
        const config = googleConfig(request);
        if (!config) return json(response, 503, { error: 'Google Sign-In is not configured on the CRM server.' });
        const state = crypto.randomBytes(24).toString('hex');
        googleStates.set(state, Date.now() + 10 * 60 * 1000);
        const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorization.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
        return redirect(response, authorization.toString());
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/google/callback') {
        const config = googleConfig(request);
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const stateExpiry = state && googleStates.get(state);
        googleStates.delete(state);
        if (!config || !stateExpiry || stateExpiry < Date.now() || !code) return redirect(response, '/login.html?authError=Unable%20to%20complete%20Google%20authentication.');
        try {
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }) });
            if (!tokenResponse.ok) throw new Error('Google token exchange failed.');
            const tokenBody = await tokenResponse.json();
            const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokenBody.access_token}` } });
            if (!profileResponse.ok) throw new Error('Google profile lookup failed.');
            const profile = await profileResponse.json();
            const email = String(profile.email || '').trim().toLowerCase();
            if (!email || profile.email_verified !== true) throw new Error('Google email is not verified.');
            let staff = database.prepare('SELECT * FROM staff WHERE lower(google_email) = ?').get(email);
            if (!staff && email === GOOGLE_ADMIN_EMAIL) staff = database.prepare('SELECT * FROM staff WHERE id = ?').get(PERMANENT_ADMIN_ID);
            if (!staff) { console.warn('Unauthorized Google login:', email); return redirect(response, '/login.html?authError=Your%20Google%20account%20is%20not%20registered%20as%20an%20active%20CRM%20employee.'); }
            if (staff.status !== 'Active' || staff.account_status !== 'ACTIVE') { audit({ id: staff.id }, 'Google Login Denied', 'staff', staff.id, { email, status: staff.status, accountStatus: staff.account_status, result: 'DENIED' }); return redirect(response, `/login.html?authError=${encodeURIComponent('Your account has been deactivated. Please contact your administrator to continue.')}`); }
            if (!staff.google_email) database.prepare('UPDATE staff SET google_email = ? WHERE id = ?').run(email, staff.id);
            const session = await createSession(staff, 'Google');
            audit(session.user, 'Google Login Successful', 'staff', staff.id, { email, method: 'Google' });
            response.setHeader('Set-Cookie', sessionCookie(session.token, false, request.secure || request.headers['x-forwarded-proto'] === 'https'));
            return redirect(response, '/login.html');
        } catch (error) {
            console.error('Google authentication failed.', { errorType: safeErrorType(error) });
            return redirect(response, '/login.html?authError=Unable%20to%20sign%20in%20with%20Google.%20Please%20try%20again.');
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseBody(request);
        const loginId = String(body.loginId || '').trim().toLowerCase();
        const password = String(body.password || '');
        const pendingAccessRequest = database.prepare("SELECT created_at FROM access_requests WHERE lower(email) = ? AND status = 'Pending' ORDER BY datetime(created_at) DESC LIMIT 1").get(loginId);
        if (pendingAccessRequest) return json(response, 403, { error: 'Your CRM access request is already pending admin approval.' });
        const recentRejectedRequest = database.prepare("SELECT eligible_again_at FROM access_requests WHERE lower(email) = ? AND status = 'Rejected' ORDER BY datetime(rejected_at) DESC LIMIT 1").get(loginId);
        if (recentRejectedRequest?.eligible_again_at && Date.parse(recentRejectedRequest.eligible_again_at) > Date.now()) return json(response, 403, { error: 'Your CRM access request has been rejected. Please contact the administrator.' });
        const staff = database.prepare('SELECT * FROM staff WHERE lower(login_id) = ? OR lower(COALESCE(email, \'\')) = ? OR lower(COALESCE(google_email, \'\')) = ?').get(loginId, loginId, loginId);
        const securityDetails = { email: staff?.email || staff?.google_email || loginId, ipAddress: request.socket.remoteAddress || null, userAgent: request.headers['user-agent'] || null, result: 'DENIED' };
        if (staff && staff.account_status === 'PENDING') return json(response, 403, { code: 'ACCOUNT_PENDING', title: 'Approval Pending', error: 'Your account is pending admin approval. Please wait.' });
        if (staff && (staff.account_status !== 'ACTIVE' || staff.status !== 'Active')) return json(response, 423, { code: 'ACCOUNT_DEACTIVATED', title: 'Account Deactivated', error: 'Your account has been deactivated. Please contact your administrator to continue.' });
        if (staff?.locked_until && Date.parse(staff.locked_until) > Date.now()) {
            return json(response, 401, { error: 'Invalid email or password. Please try again.' });
        }
        if (staff?.locked_until) {
            await repository.run('UPDATE staff SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [staff.id]);
            staff.failed_login_attempts = 0;
        }
        if (!(staff && verifyPassword(password, staff.password_hash))) {
            if (staff) {
                const failedAttempts = Number(staff.failed_login_attempts || 0) + 1;
                const configuredThreshold = Number(readSettingsRecord().security?.autoLockAfterFailedAttempts);
                const lockThreshold = Number.isFinite(configuredThreshold) && configuredThreshold > 0
                    ? Math.min(100, Math.max(1, Math.ceil(configuredThreshold)))
                    : 5;
                const lockedUntil = failedAttempts >= lockThreshold ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
                await repository.run('UPDATE staff SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [failedAttempts, lockedUntil, staff.id]);
            }
            return json(response, 401, { error: 'Invalid email or password. Please try again.' });
        }
        await repository.run('UPDATE staff SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [staff.id]);
        if (!staff.password_hash.startsWith('scrypt$')) await repository.run('UPDATE staff SET password_hash = ? WHERE id = ?', [hashPassword(password), staff.id]);
        const session = await createSession(staff, 'Employee', body.rememberMe === true);
        const user = session.user;
        audit(user, 'Login Successful', 'staff', staff.id, { ...securityDetails, result: 'SUCCESS' });
        const isHttps = request.secure || request.socket.encrypted;
        response.setHeader('Set-Cookie', sessionCookie(session.token, body.rememberMe === true, isHttps));
        return json(response, 200, { user });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
        const body = await parseBody(request);
        const loginId = String(body.loginId || '').trim().toLowerCase();
        const staff = database.prepare('SELECT id, email, google_email, status, account_status FROM staff WHERE lower(login_id) = ? OR lower(COALESCE(email, \'\')) = ?').get(loginId, loginId);
        if (staff && (staff.email || staff.google_email)) {
            const canReset = staff.id !== PERMANENT_ADMIN_ID && staff.status === 'Active' && staff.account_status === 'ACTIVE';
            if (canReset) {
                const token = crypto.randomBytes(32).toString('hex');
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                database.prepare('INSERT INTO password_reset_tokens (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, staff.id, new Date(Date.now() + 30 * 60 * 1000).toISOString());
                let delivered = false;
                if (process.env.PASSWORD_RESET_BASE_URL) {
                    try {
                        const resetUrl = new URL(process.env.PASSWORD_RESET_BASE_URL);
                        resetUrl.hash = new URLSearchParams({ token }).toString();
                        delivered = await sendEmail({
                            to: staff.email || staff.google_email,
                            subject: 'MP Dashboard CRM password reset',
                            text: `Use this link to reset your password. The link expires in 30 minutes.\n\n${resetUrl.toString()}`
                        });
                    } catch (error) {
                        delivered = false;
                    }
                }
                console.info('Password reset email delivery attempted.', { staffId: staff.id, delivered });
            }
        }
        return json(response, 200, { message: 'If that account exists, we have sent a password reset link to its registered email.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/reset-password') {
        const body = await parseBody(request);
        const token = String(body.token || '').trim();
        const newPassword = String(body.newPassword || '');
        const confirmPassword = String(body.confirmPassword || '');
        if (!token || passwordPolicyError(newPassword) || newPassword !== confirmPassword) {
            return json(response, 422, { error: passwordPolicyError(newPassword) || 'Enter a valid new password and confirmation.' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        database.exec('BEGIN IMMEDIATE');
        let staffId;
        try {
            const reset = database.prepare("SELECT staff_id, expires_at FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')").get(tokenHash);
            const staff = reset && database.prepare("SELECT id, status, account_status, login_id FROM staff WHERE id = ?").get(reset.staff_id);
            if (!reset || !staff || staff.status !== 'Active' || staff.account_status !== 'ACTIVE' || isPermanentAdmin(staff)) {
                database.exec('ROLLBACK');
                return json(response, 400, { error: 'This password reset request is invalid or expired.' });
            }

            const timestamp = now();
            database.prepare('UPDATE staff SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(hashPassword(newPassword), staff.id);
            const consumed = database.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')").run(timestamp, tokenHash);
            if (Number(consumed.changes || 0) !== 1) throw new Error('Reset token could not be consumed.');
            database.prepare('DELETE FROM sessions WHERE staff_id = ?').run(staff.id);
            audit({ id: staff.id }, 'Password changed via reset', 'staff', staff.id);
            database.exec('COMMIT');
            staffId = staff.id;
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch (rollbackError) { }
            return json(response, 400, { error: 'This password reset request is invalid or expired.' });
        }
        for (const [sessionToken, sessionUser] of sessions.entries()) {
            if (sessionUser.id === staffId) {
                sessions.delete(sessionToken);
                sessionExpiries.delete(sessionToken);
            }
        }
        return json(response, 200, { message: 'Password changed successfully. You can now sign in.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/signup') {
        const body = await parseBody(request);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const phone = String(body.phone || '').trim();
        const password = String(body.password || '');
        if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[+\d][\d\s().-]{6,}$/.test(phone) || passwordPolicyError(password)) {
            return json(response, 422, { error: 'Please provide a valid name, email, and strong password.' });
        }
        const existing = database.prepare("SELECT * FROM staff WHERE lower(email) = ? OR lower(login_id) = ?").get(email, email);
        if (existing && existing.account_status === 'ACTIVE' && existing.status === 'Active') return json(response, 409, { error: 'An active CRM account already exists for this email. Please use the Login page.' });
        if (existing && existing.account_status === 'PENDING') return json(response, 409, { error: 'Your CRM access request is already pending admin approval.' });
        const latestRequest = database.prepare('SELECT * FROM access_requests WHERE lower(email) = ? ORDER BY datetime(created_at) DESC LIMIT 1').get(email);
        if (latestRequest?.status === 'Pending') return json(response, 409, { error: `Your CRM access request is already pending admin approval. Request date: ${latestRequest.created_at}. Email: ${email}.` });
        if (latestRequest?.status === 'Approved') return json(response, 409, { error: 'An active CRM account already exists for this email. Please use the Login page.' });
        if (latestRequest?.status === 'Rejected' && latestRequest.eligible_again_at && Date.parse(latestRequest.eligible_again_at) > Date.now()) return json(response, 429, { error: `You cannot submit another CRM access request using this email yet. You may request CRM access again after ${latestRequest.eligible_again_at}.` });
        const id = `REQ-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const createdAt = now();
        try {
            database.prepare('INSERT INTO access_requests (id, full_name, email, phone, request_data, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'Pending\', ?)')
                .run(id, name, email, phone, JSON.stringify({ phone }), hashPassword(password), createdAt);
            database.prepare("SELECT id FROM staff WHERE role = 'Admin/Owner' AND account_status = 'ACTIVE'").all().forEach((admin) => notify(admin.id, 'NEW_SIGNUP', `New CRM access request from ${name} (${email}). Please review.`, 'access_request', id));
            const requestRecord = database.prepare('SELECT * FROM access_requests WHERE id = ?').get(id);
            sendAccessRequestEmail(request, requestRecord).catch((error) => console.error('Access request email failed.', { errorType: safeErrorType(error) }));
            audit({ id }, 'Signup Request Created', 'access_request', id, { email, result: 'PENDING' });
        } catch (error) {
            return json(response, 409, { error: 'This email already has a CRM access request or account.' });
        }
        return json(response, 201, { success: true, request: { id, fullName: name, email, phone, status: 'Pending', createdAt }, message: 'Request received. Your CRM access will be available after your request is approved.' });
    }

    const user = await requireUser(request, response);
    if (!user) return;

    const importPreviewPath = url.pathname === '/api/lead-imports/preview';
    const importIdMatch = url.pathname.match(/^\/api\/lead-imports\/([^/]+)(?:\/(errors))?$/);
    const importStartPath = /^\/api\/lead-imports\/[^/]+\/start$/.test(url.pathname);
    if (importPreviewPath || importIdMatch || importStartPath) {
        if (!canImportLeads(user)) return json(response, 403, { error: 'Only Admin/Owner users can import leads.' });

        if (importPreviewPath && request.method === 'POST') {
            if (!Buffer.isBuffer(request.body)) return json(response, 400, { error: 'Upload the spreadsheet as a file.' });
            const suppliedFilename = String(request.headers['x-file-name'] || '');
            const filename = path.basename(suppliedFilename.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 180);
            let rawRows;
            try {
                rawRows = parseLeadFile(request.body, filename);
            } catch (error) {
                return json(response, 422, { error: error.message });
            }
            if (!rawRows.length || rawRows.length > MAX_IMPORT_ROWS) return json(response, 422, { error: rawRows.length ? `The spreadsheet exceeds the ${MAX_IMPORT_ROWS} row limit.` : 'The spreadsheet does not contain any customer rows.' });
            const existingLeads = database.prepare('SELECT mobile_number, email FROM leads').all();
            const rows = validateLeadRows(rawRows, existingLeads);
            const id = crypto.randomUUID();
            const timestamp = now();
            try {
                database.prepare("DELETE FROM lead_imports WHERE user_id = ? AND status = 'PREVIEW'").run(user.id);
                database.prepare("DELETE FROM lead_imports WHERE status IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') AND created_at < ?")
                    .run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
                database.prepare('INSERT INTO lead_imports (id, user_id, status, source_filename, total_rows, processed_rows, created_count, duplicate_count, failed_count, rows_json, source_rows_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
                    .run(id, user.id, 'PREVIEW', filename || 'uploaded-leads', rows.length, 0, rows.filter((row) => row.duplicateReason).length, rows.filter((row) => row.errors.length > 0).length, JSON.stringify(rows), JSON.stringify(rawRows), timestamp, timestamp);
            } catch (error) {
                console.error('Lead import preview could not be saved.', { errorType: safeErrorType(error) });
                return json(response, 500, { error: 'Unable to prepare this import. Please try again.' });
            }
            return json(response, 201, {
                previewId: id,
                sourceFilename: filename,
                totalRows: rows.length,
                validRows: rows.filter((row) => row.valid).length,
                invalidRows: rows.filter((row) => row.errors.length > 0).length,
                duplicateRows: rows.filter((row) => row.duplicateReason).length,
                estimatedAssignments: rows.filter((row) => row.valid).length,
                rows
            });
        }

        if (importIdMatch) {
            let importId;
            try { importId = decodeURIComponent(importIdMatch[1]); } catch (error) { return json(response, 400, { error: 'Invalid import identifier.' }); }
            const job = database.prepare('SELECT * FROM lead_imports WHERE id = ? AND user_id = ?').get(importId, user.id);
            if (!job) return json(response, 404, { error: 'Import job not found.' });

            if (importIdMatch[2] && request.method === 'GET') {
                const rows = JSON.parse(job.rows_json);
                const csv = toSafeCsv(rows.filter((row) => row.outcome !== 'created' && (row.errors?.length || row.duplicateReason || row.outcome)));
                response.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': `attachment; filename="lead-import-${importId}-issues.csv"`,
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff'
                });
                response.end(csv);
                return true;
            }

            if (!importIdMatch[2] && request.method === 'GET') return json(response, 200, { job: asPublicStatus(job) });

            if (!importIdMatch[2] && request.method === 'DELETE') {
                if (job.status !== 'PREVIEW') return json(response, 409, { error: 'An import can only be cancelled before processing starts.' });
                database.prepare("DELETE FROM lead_imports WHERE id = ? AND user_id = ? AND status = 'PREVIEW'").run(importId, user.id);
                return json(response, 200, { cancelled: true });
            }

        }

        const startMatch = url.pathname.match(/^\/api\/lead-imports\/([^/]+)\/start$/);
        if (startMatch && request.method === 'POST') {
            let importId;
            try { importId = decodeURIComponent(startMatch[1]); } catch (error) { return json(response, 400, { error: 'Invalid import identifier.' }); }
            const preview = database.prepare("SELECT * FROM lead_imports WHERE id = ? AND user_id = ? AND status = 'PREVIEW'").get(importId, user.id);
            if (!preview) return json(response, 404, { error: 'Import preview not found or it has already been processed.' });
            const rawRows = JSON.parse(preview.source_rows_json || preview.rows_json);
            const rows = validateLeadRows(rawRows, database.prepare('SELECT mobile_number, email FROM leads').all());
            const configuredLeadSource = String(readSettingsRecord().leadSettings?.defaultSource || 'Website').trim() || 'Website';
            rows.forEach((row) => { row.leadSource = configuredLeadSource; });
            const eligible = rows.filter((row) => row.valid);
            if (eligible.length) {
                const salesRoles = ['Sales Executive', 'Sales Manager', 'GM/AGM', 'Telecaller'];
                const employees = database.prepare(`SELECT id FROM staff WHERE status = 'Active' AND account_status = 'ACTIVE' AND role IN (${salesRoles.map(() => '?').join(', ')}) ORDER BY id`).all(...salesRoles);
                if (!employees.length) return json(response, 422, { error: 'No eligible active sales employees are available for assignment.' });
            }

            const timestamp = now();
            const failedCount = rows.filter((row) => row.errors.length > 0).length;
            const duplicateCount = rows.filter((row) => row.duplicateReason).length;
            const activeImport = database.prepare('SELECT job_id FROM lead_import_lock WHERE id = 1').get();
            if (activeImport) return json(response, 409, { error: 'Another lead import is already being processed. Try again after it finishes.' });
            try {
                database.exec('BEGIN IMMEDIATE');
                database.prepare('INSERT INTO lead_import_lock (id, job_id) VALUES (1, ?)').run(importId);
                database.prepare("UPDATE lead_imports SET status = 'QUEUED', total_rows = ?, processed_rows = ?, duplicate_count = ?, failed_count = ?, rows_json = ?, source_rows_json = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'PREVIEW'")
                    .run(rows.length, rows.filter((row) => !row.valid).length, duplicateCount, failedCount, JSON.stringify(rows), timestamp, importId, user.id);
                database.prepare('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(user.id, 'Bulk lead import started', 'lead_import', importId, JSON.stringify({ totalRows: rows.length, filename: preview.source_filename }), timestamp);
                database.exec('COMMIT');
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch (rollbackError) { console.error('Lead import start rollback failed.', { errorType: safeErrorType(rollbackError) }); }
                if (/UNIQUE constraint failed|constraint/i.test(String(error.message || ''))) return json(response, 409, { error: 'Another lead import is already being processed. Try again after it finishes.' });
                console.error('Lead import could not be started.', { errorType: safeErrorType(error) });
                return json(response, 500, { error: 'Unable to start this import. No leads were created.' });
            }
            bulkLeadImportService.schedule(importId);
            return json(response, 202, { job: { id: importId, status: 'QUEUED', totalRows: rows.length, processedRows: rows.filter((row) => !row.valid).length, createdCount: 0, duplicateCount, failedCount } });
        }
    }

    markOverdueFollowUps();

    if (await handleInventoryApi(request, response, url, user)) return;

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        audit(user, 'Logout', 'staff', user.id);
        database.prepare('UPDATE staff SET last_logout_at = ? WHERE id = ?').run(now(), user.id);
        const token = String(request.headers.cookie || '').split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith('crm_session='))?.slice('crm_session='.length);
        sessions.delete(token);
        sessionExpiries.delete(token);
        database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(token));
        const isHttps = request.secure || request.socket.encrypted;
        response.setHeader('Set-Cookie', `crm_session=; HttpOnly; SameSite=Strict;${isHttps ? ' Secure;' : ''} Path=/; Max-Age=0`);
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        return json(response, 200, { user });
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (fileMatch && request.method === 'GET') {
        const fileId = decodeURIComponent(fileMatch[1]);
        const file = database.prepare("SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath, NULL AS surveyId, 'lead_documents' AS source FROM lead_documents WHERE id = ? AND status = 'UPLOADED' UNION ALL SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath, survey_id AS surveyId, 'survey_files' AS source FROM survey_files WHERE id = ? AND status = 'UPLOADED'").get(fileId, fileId);
        const lead = file && database.prepare('SELECT * FROM leads WHERE id = ?').get(file.leadId);
        if (!file || !lead) return json(response, 404, { error: 'File not found.' });
        if (file.source === 'survey_files') {
            const survey = getSurveyRow(file.surveyId);
            if (user.role === 'Telecaller' || !surveyCanView(user, survey)) return json(response, 403, { error: 'Access denied.' });
        } else if (!canAccess(user, lead)) return json(response, 403, { error: 'Access denied.' });
        const storagePath = path.basename(String(file.storagePath || ''));
        const storedPath = path.join(FILE_STORAGE_ROOT, storagePath);
        if (!storagePath || !fs.existsSync(storedPath)) return json(response, 404, { error: 'Stored file is unavailable.' });
        const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
        response.writeHead(200, { 'Content-Type': file.mimeType || 'application/octet-stream', 'Content-Length': fs.statSync(storedPath).size, 'Content-Disposition': `${disposition}; filename="${String(file.fileName || 'download').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(storedPath).pipe(response);
        return;
    }

    const leadFilesMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/files(?:\/([^/]+))?$/);
    if (leadFilesMatch) {
        const requestedLeadId = decodeURIComponent(leadFilesMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(requestedLeadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        const canAccessLeadFiles = canAccess(user, lead);
        const relatedSurvey = database.prepare('SELECT s.*, l.assigned_to AS lead_owner_id FROM surveys s JOIN leads l ON l.id = s.lead_id WHERE s.lead_id = ?').get(requestedLeadId);
        const canAccessSurveyFiles = user.role !== 'Telecaller' && surveyCanView(user, relatedSurvey);
        if (!canAccessLeadFiles && !canAccessSurveyFiles) return json(response, 403, { error: 'You do not have permission to access files for this lead.' });

        if (request.method === 'GET' && !leadFilesMatch[2]) {
            const files = [
                ...(canAccessLeadFiles ? database.prepare("SELECT d.id, d.lead_id AS leadId, d.proposal_record_id AS proposalId, d.document_type AS category, d.original_file_name AS fileName, d.mime_type AS mimeType, d.file_size AS fileSize, d.uploaded_by AS uploadedBy, s.name AS uploadedByName, d.created_at AS uploadedAt, d.status FROM lead_documents d LEFT JOIN staff s ON s.id = d.uploaded_by WHERE d.lead_id = ? AND d.status = 'UPLOADED' AND d.storage_path IS NOT NULL").all(requestedLeadId) : []),
                ...(user.role === 'Telecaller' ? [] : database.prepare("SELECT f.id, f.survey_id AS surveyId, f.lead_id AS leadId, f.category, f.original_file_name AS fileName, f.mime_type AS mimeType, f.file_size AS fileSize, f.uploaded_by AS uploadedBy, s.name AS uploadedByName, f.uploaded_at AS uploadedAt, f.status FROM survey_files f LEFT JOIN staff s ON s.id = f.uploaded_by WHERE f.lead_id = ? AND f.status = 'UPLOADED' AND f.storage_path IS NOT NULL").all(requestedLeadId).filter((file) => surveyCanView(user, getSurveyRow(file.surveyId))))
            ].sort((left, right) => Date.parse(right.uploadedAt || 0) - Date.parse(left.uploadedAt || 0));
            return json(response, 200, { files });
        }

        if (request.method === 'POST' && !leadFilesMatch[2]) {
            if (!canAccessLeadFiles) return json(response, 403, { error: 'You do not have permission to upload lead documents.' });
            const body = await parseBody(request);
            const category = String(body.category || '').trim();
            const allowedCategories = new Set(['Site Survey Photos', 'Roof 360°', 'Site Survey Documents', 'Other']);
            if (!allowedCategories.has(category)) return json(response, 422, { error: 'Choose a valid file category.' });
            const files = Array.isArray(body.files) ? body.files : [body];
            if (!files.length || files.length > 20) return json(response, 422, { error: 'Select between 1 and 20 files.' });
            const saved = [];
            try {
                for (const file of files) {
                    const stored = saveUploadedFile(file);
                    const fileId = crypto.randomUUID();
                    database.prepare('INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(fileId, requestedLeadId, category, stored.originalFileName, user.id, now(), stored.storagePath, stored.originalFileName, stored.mimeType, stored.fileSize, 'UPLOADED');
                    saved.push({ id: fileId, leadId: requestedLeadId, category, fileName: stored.originalFileName, mimeType: stored.mimeType, fileSize: stored.fileSize, uploadedBy: user.id, uploadedByName: user.name, uploadedAt: now(), status: 'UPLOADED' });
                }
            } catch (error) {
                saved.forEach((file) => { const stored = database.prepare('SELECT storage_path AS storagePath FROM lead_documents WHERE id = ?').get(file.id); removeStoredFile(stored?.storagePath); database.prepare('DELETE FROM lead_documents WHERE id = ?').run(file.id); });
                return json(response, 422, { error: error.message || 'Unable to upload files.' });
            }
            saved.forEach((file) => audit(user, 'Uploaded', 'document', file.id, { fileName: file.fileName, category, description: `File uploaded: ${file.fileName}.` }));
            return json(response, 201, { files: saved });
        }

        const fileId = decodeURIComponent(leadFilesMatch[2] || '');
        const file = database.prepare("SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath, NULL AS surveyId, 'lead_documents' AS source FROM lead_documents WHERE id = ? AND lead_id = ? AND status = 'UPLOADED' UNION ALL SELECT id, lead_id AS leadId, original_file_name AS fileName, mime_type AS mimeType, storage_path AS storagePath, survey_id AS surveyId, 'survey_files' AS source FROM survey_files WHERE id = ? AND lead_id = ? AND status = 'UPLOADED'").get(fileId, requestedLeadId, fileId, requestedLeadId);
        if (!file) return json(response, 404, { error: 'File not found for this lead.' });
        if (file.source === 'survey_files') {
            const survey = getSurveyRow(file.surveyId);
            if (user.role === 'Telecaller' || !surveyCanView(user, survey)) return json(response, 403, { error: 'You do not have permission to access this survey file.' });
        }
        if (request.method === 'DELETE') {
            if (!isAdminUser(user)) return json(response, 403, { error: 'Only Admin can delete files.' });
            removeStoredFile(file.storagePath);
            database.prepare(`UPDATE ${file.source} SET status = 'DELETED' WHERE id = ? AND lead_id = ?`).run(fileId, requestedLeadId);
            if (file.source === 'survey_files') audit(user, 'File Deleted', 'survey', file.surveyId, { fileName: file.fileName, description: `Survey file deleted: ${file.fileName}.` });
            else audit(user, 'Deleted', 'document', fileId, { fileName: file.fileName, description: `File deleted: ${file.fileName}.` });
            return json(response, 200, { success: true });
        }
        if (request.method === 'GET') {
            const storedPath = path.join(FILE_STORAGE_ROOT, path.basename(String(file.storagePath || '')));
            if (!file.storagePath || !fs.existsSync(storedPath)) return json(response, 404, { error: 'Stored file is unavailable.' });
            const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
            response.writeHead(200, { 'Content-Type': file.mimeType || 'application/octet-stream', 'Content-Length': fs.statSync(storedPath).size, 'Content-Disposition': `${disposition}; filename="${String(file.fileName || 'download').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
            fs.createReadStream(storedPath).pipe(response);
            return;
        }
    }

    const historyMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/history$/);
    if (historyMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(historyMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to view this lead history.' });
        const activities = database.prepare('SELECT a.*, s.name AS user_name, s.role AS user_role FROM lead_activities a LEFT JOIN staff s ON s.id = a.user_id WHERE a.lead_id = ? ORDER BY datetime(a.created_at) DESC').all(leadId);
        const followUps = database.prepare('SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY datetime(due_at) DESC').all(leadId);
        const communications = database.prepare('SELECT * FROM lead_communications WHERE lead_id = ? ORDER BY datetime(created_at) DESC').all(leadId);
        const publicActivities = activities.map((activity) => ({ ...activity, title: publicLeadNumberText(activity.title), description: publicLeadNumberText(activity.description), previous_value: publicLeadNumberText(activity.previous_value), new_value: publicLeadNumberText(activity.new_value) }));
        return json(response, 200, { activities: publicActivities, followUps, communications, counts: { activities: activities.length, followUps: followUps.length, communications: communications.length } });
    }

    if (request.method === 'GET' && url.pathname === '/api/staff/assignable') {
        return json(response, 200, { staff: database.prepare("SELECT id, employee_id AS employeeId, name, role, department FROM staff WHERE status = 'Active' AND account_status = 'ACTIVE' ORDER BY name").all() });
    }

    if (url.pathname === '/api/staff' && request.method === 'GET') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can view employee management.' });
        return json(response, 200, { staff: database.prepare("SELECT id, employee_id AS employeeId, name, email, department, designation, login_id AS loginId, google_email AS googleEmail, role, status, account_status AS accountStatus, failed_login_attempts AS failedLoginAttempts, last_login_at AS lastLogin, last_logout_at AS lastLogout, deactivated_at AS deactivatedAt, deactivation_reason AS deactivatedReason, blocked_until AS blockedUntil, reactivated_at AS reactivatedAt, reactivated_by AS reactivatedBy, auth_method AS authMethod, manager_id AS managerId, created_at AS joiningDate FROM staff ORDER BY name").all() });
    }

    if (request.method === 'GET' && url.pathname === '/api/settings') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only the Admin/Owner can access CRM settings.' });
        const settings = readSettingsRecord();
        return json(response, 200, { settings: maskSettingsPayload(settings), canManage: true });
    }

    if (request.method === 'PATCH' && url.pathname === '/api/settings') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only the Admin/Owner can update CRM settings.' });
        const body = await parseBody(request);
        const current = readSettingsRecord();
        const sanitized = { ...current };
        const allowedKeys = Object.keys(SETTINGS_DEFAULTS);
        const nextValues = {};
        for (const [key, value] of Object.entries(body || {})) {
            if (!allowedKeys.includes(key)) continue;
            if (key === 'dashboardWidgets' && Array.isArray(value)) nextValues[key] = value.slice(0, 12);
            else if (value !== null && typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') nextValues[key] = value;
        }
        const merged = mergeSettingsPreservingSecrets(sanitized, nextValues);
        if (body?.emailPassword === '' || body?.whatsappApiKey === '' || body?.integrationApiKey === '') {
            if (body.emailPassword === '') merged.emailPassword = '';
            if (body.whatsappApiKey === '') merged.whatsappApiKey = '';
            if (body.integrationApiKey === '') merged.integrationApiKey = '';
        }
        const saved = writeSettingsRecord(user, merged);
        audit(user, 'Settings Updated', 'settings', 'crm_settings', { keys: Object.keys(nextValues || {}) });
        return json(response, 200, { settings: maskSettingsPayload(saved), message: 'CRM settings saved.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/system-info') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only the Admin/Owner can view system information.' });
        return json(response, 200, {
            systemInfo: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                uptimeSeconds: Math.round(process.uptime()),
                memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                databaseMode: databaseConfig.mode,
                appDirectory: ROOT,
                generatedAt: now()
            }
        });
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/audit-logs') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only the Admin/Owner can view audit logs.' });
        const logs = database.prepare("SELECT a.id, a.user_id AS userId, s.name AS userName, a.action, a.record_type AS recordType, a.record_id AS recordId, a.details, a.created_at AS createdAt FROM audit_logs a LEFT JOIN staff s ON s.id = a.user_id ORDER BY datetime(a.created_at) DESC LIMIT 200").all();
        return json(response, 200, { logs: logs.map((log) => ({ ...log, details: publicLeadNumberText(log.details) })) });
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/error-logs') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only the Admin/Owner can view error logs.' });
        const logs = database.prepare("SELECT id, message, details, created_at AS createdAt FROM system_errors ORDER BY datetime(created_at) DESC LIMIT 200").all();
        return json(response, 200, { logs });
    }

    if (url.pathname === '/api/admin/access-requests' && request.method === 'GET') {
        if (user.id !== PERMANENT_ADMIN_ID) return json(response, 403, { error: 'Only the protected Admin account can manage CRM access requests.' });
        const requests = database.prepare("SELECT id, full_name, email, phone, request_data, status, created_at, approved_at, approved_by, rejected_at, rejected_by, rejection_reason, eligible_again_at FROM access_requests ORDER BY CASE WHEN status = 'Pending' THEN 0 ELSE 1 END, datetime(created_at) DESC").all().map((accessRequest) => ({ ...accessRequest, details: accessRequestDetails(accessRequest) }));
        return json(response, 200, { requests, pendingCount: requests.filter((accessRequest) => accessRequest.status === 'Pending').length });
    }

    const accessRequestMatch = url.pathname.match(/^\/api\/admin\/access-requests\/([^/]+)$/);
    if (accessRequestMatch && request.method === 'GET') {
        if (user.id !== PERMANENT_ADMIN_ID) return json(response, 403, { error: 'Only the protected Admin account can manage CRM access requests.' });
        const accessRequest = database.prepare('SELECT id, full_name, email, phone, request_data, status, created_at, approved_at, approved_by, rejected_at, rejected_by, rejection_reason, eligible_again_at FROM access_requests WHERE id = ?').get(decodeURIComponent(accessRequestMatch[1]));
        if (!accessRequest) return json(response, 404, { error: 'Access request not found.' });
        return json(response, 200, { request: { ...accessRequest, details: accessRequestDetails(accessRequest) } });
    }

    const approveAccessRequestMatch = url.pathname.match(/^\/api\/admin\/access-requests\/([^/]+)\/approve$/);
    if (approveAccessRequestMatch && request.method === 'POST') {
        if (user.id !== PERMANENT_ADMIN_ID) return json(response, 403, { error: 'Only the protected Admin account can approve CRM access requests.' });
        const requestId = decodeURIComponent(approveAccessRequestMatch[1]);
        const accessRequest = database.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId);
        if (!accessRequest) return json(response, 404, { error: 'Access request not found.' });
        if (accessRequest.status !== 'Pending') return json(response, 409, { error: `This request is already ${accessRequest.status.toLowerCase()}.` });
        const existing = database.prepare('SELECT * FROM staff WHERE lower(email) = ? OR lower(login_id) = ?').get(accessRequest.email, accessRequest.email);
        if (existing && isPermanentAdmin(existing)) return json(response, 403, { error: 'The protected Admin account cannot be changed through access requests.' });
        const timestamp = now();
        database.exec('BEGIN IMMEDIATE');
        try {
            if (existing) {
                database.prepare("UPDATE staff SET name = ?, email = ?, login_id = ?, password_hash = ?, role = 'Sales Executive', designation = 'Sales Executive', department = 'Sales', status = 'Active', account_status = 'ACTIVE', failed_login_attempts = 0, locked_until = NULL, blocked_until = NULL, deactivated_at = NULL, deactivation_reason = NULL WHERE id = ?").run(accessRequest.full_name, accessRequest.email, accessRequest.email, accessRequest.password_hash, existing.id);
            } else {
                database.prepare("INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, 'Sales', 'Sales Executive', ?, ?, 'Sales Executive', 'Active', 'ACTIVE', 0, ?)").run(crypto.randomUUID(), `EMP-${Date.now()}`, accessRequest.full_name, accessRequest.email, accessRequest.email, accessRequest.password_hash, timestamp);
            }
            database.prepare("UPDATE access_requests SET status = 'Approved', approved_at = ?, approved_by = ? WHERE id = ?").run(timestamp, user.id, requestId);
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            return json(response, 409, { error: 'Unable to approve this request. The email may already be in use.' });
        }
        audit(user, 'Access Request Approved', 'access_request', requestId, { approvedBy: user.id, email: accessRequest.email });
        sendDecisionEmail(request, { ...accessRequest, status: 'Approved' }, true).catch((error) => console.error('Approval email failed.', { errorType: safeErrorType(error) }));
        return json(response, 200, { success: true, message: 'CRM access approved.' });
    }

    const rejectAccessRequestMatch = url.pathname.match(/^\/api\/admin\/access-requests\/([^/]+)\/reject$/);
    if (rejectAccessRequestMatch && request.method === 'POST') {
        if (user.id !== PERMANENT_ADMIN_ID) return json(response, 403, { error: 'Only the protected Admin account can reject CRM access requests.' });
        const requestId = decodeURIComponent(rejectAccessRequestMatch[1]);
        const accessRequest = database.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId);
        if (!accessRequest) return json(response, 404, { error: 'Access request not found.' });
        if (accessRequest.status !== 'Pending') return json(response, 409, { error: `This request is already ${accessRequest.status.toLowerCase()}.` });
        const timestamp = now();
        const eligibleAgainAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const body = await parseBody(request);
        const rejectionReason = String(body.reason || '').trim().slice(0, 500) || null;
        database.prepare("UPDATE access_requests SET status = 'Rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ?, eligible_again_at = ? WHERE id = ? AND status = 'Pending'").run(timestamp, user.id, rejectionReason, eligibleAgainAt, requestId);
        audit(user, 'Access Request Rejected', 'access_request', requestId, { rejectedBy: user.id, email: accessRequest.email, reason: rejectionReason });
        sendDecisionEmail(request, { ...accessRequest, status: 'Rejected', eligible_again_at: eligibleAgainAt }, false, rejectionReason || '').catch((error) => console.error('Rejection email failed.', { errorType: safeErrorType(error) }));
        return json(response, 200, { success: true, message: 'CRM access request rejected.' });
    }

    if (url.pathname === '/api/staff' && request.method === 'POST') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can create employees.' });
        const body = await parseBody(request);
        const required = ['employeeId', 'name', 'loginId', 'password', 'role'];
        const missing = required.filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: 'Required employee fields are missing.', fields: missing });
        const passwordError = passwordPolicyError(body.password);
        if (passwordError) return json(response, 422, { error: passwordError });
        const id = crypto.randomUUID();
        try {
            database.prepare(`INSERT INTO staff (id, employee_id, name, department, designation, login_id, password_hash, role, status, manager_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, body.employeeId, body.name, body.department || null, body.designation || body.role, body.loginId, hashPassword(body.password), body.role, body.status || 'Active', body.managerId || null, now());
        } catch (error) {
            return json(response, 409, { error: 'Employee ID or Login ID already exists.' });
        }
        audit(user, 'Created', 'staff', id, { employeeId: body.employeeId });
        return json(response, 201, { id });
    }

    if (url.pathname === '/api/opportunities' && request.method === 'GET') {
        const rows = database.prepare("SELECT opportunities.*, leads.assigned_to AS lead_owner FROM opportunities JOIN leads ON leads.id = opportunities.lead_id ORDER BY opportunities.updated_at DESC").all().filter((opportunity) => canAccess(user, { assigned_to: opportunity.lead_owner, created_by: opportunity.created_by }));
        return json(response, 200, { opportunities: rows });
    }

    if (url.pathname === '/api/opportunities' && request.method === 'POST') {
        const body = await parseBody(request);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(body.leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this opportunity.' });
        if (lead.stage !== 'Opportunity') return json(response, 422, { error: 'Complete the Opportunity stage before creating an opportunity record.' });
        if (database.prepare('SELECT id FROM opportunities WHERE lead_id = ?').get(lead.id)) return json(response, 409, { error: 'This lead already has an opportunity.' });
        const opportunityId = body.opportunityId || `OPP-${Date.now()}`;
        database.prepare('INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, expected_close_date, probability, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(opportunityId, lead.id, lead.customer_name, body.systemCapacity || null, Number(body.estimatedValue || 0), lead.assigned_to, body.expectedCloseDate || null, Number(body.probability || 0), 'Qualified', user.id, now(), now());
        audit(user, 'Created', 'opportunity', opportunityId, { leadId: lead.id });
        return json(response, 201, { opportunityId });
    }

    const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)$/);
    if (opportunityMatch && request.method === 'PATCH') {
        const opportunityId = decodeURIComponent(opportunityMatch[1]);
        const opportunity = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(opportunityId);
        if (!opportunity) return json(response, 404, { error: 'Opportunity not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(opportunity.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this opportunity.' });
        const body = await parseBody(request);
        const normalizedStage = normalizeOpportunityStage(body.stage);
        if (!normalizedStage || !OPPORTUNITY_STAGES.includes(normalizedStage)) return json(response, 422, { error: 'Invalid opportunity stage.' });
        if (normalizedStage === 'Lost' && !String(body.lostReason || '').trim()) return json(response, 422, { error: 'Lost Reason is required.' });
        database.prepare('UPDATE opportunities SET stage = ?, lost_reason = ?, status = ?, closing_date = ?, closing_value = ?, closing_remarks = ?, updated_at = ? WHERE id = ?').run(normalizedStage, body.lostReason || opportunity.lost_reason, normalizedStage === 'Lost' ? 'Archived' : 'Active', body.closingDate || null, body.closingValue || null, body.closingRemarks || null, now(), opportunityId);
        audit(user, normalizedStage === 'Lost' ? 'Archived' : 'Status changed', 'opportunity', opportunityId, { previousStage: opportunity.stage, newStage: normalizedStage, lostReason: body.lostReason || null });
        if (normalizedStage === 'Won') notify(lead.assigned_to, 'opportunity-won', `Opportunity ${opportunityId} is won and ready for booking.`, 'opportunity', opportunityId);
        return json(response, 200, { opportunityId, stage: normalizedStage });
    }

    const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
    if (staffMatch && request.method === 'DELETE') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can delete employees.' });
        const staffId = decodeURIComponent(staffMatch[1]);
        const existing = database.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
        if (!existing) return json(response, 404, { error: 'Employee not found.' });
        if (isPermanentAdmin(existing)) {
            auditProtectedAdminAttempt(user, 'Delete Protected Admin Attempt', staffId);
            return json(response, 403, { error: 'The permanent Admin account cannot be deleted.' });
        }
        database.exec('BEGIN');
        try {
            const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
            for (const table of tables) {
                const columns = database.prepare(`PRAGMA table_info(${table.name})`).all().map((column) => column.name);
                if (table.name === 'staff' && columns.includes('manager_id')) database.prepare('UPDATE staff SET manager_id = NULL WHERE manager_id = ?').run(staffId);
                const referencesStaff = ['user_id', 'created_by', 'completed_by', 'task_completed_by', 'uploaded_by', 'approved_by', 'rejected_by', 'reactivated_by', 'staff_id'].filter((column) => columns.includes(column));
                for (const column of referencesStaff) database.prepare(`DELETE FROM ${table.name} WHERE ${column} = ?`).run(staffId);
            }
            database.prepare('DELETE FROM staff WHERE id = ?').run(staffId);
            database.exec('COMMIT');
            return json(response, 200, { success: true });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Employee delete failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to delete employee. No changes were saved.' });
        }
    }

    if (staffMatch && request.method === 'PATCH') {
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Owner/Super Admin can update employees.' });
        const staffId = decodeURIComponent(staffMatch[1]);
        const body = await parseBody(request);
        const existing = database.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
        if (!existing) return json(response, 404, { error: 'Employee not found.' });
        if (isPermanentAdmin(existing)) {
            auditProtectedAdminAttempt(user, 'Modify Protected Admin Attempt', staffId, { fields: Object.keys(body) });
            return json(response, 403, { error: 'The permanent Admin account cannot be modified.' });
        }
        const passwordError = body.password ? passwordPolicyError(body.password) : null;
        if (passwordError) return json(response, 422, { error: passwordError });
        const requestedAccountStatus = body.accountStatus || (body.status === 'Active' ? 'ACTIVE' : body.status === 'Inactive' ? 'DEACTIVATED' : null);
        if (requestedAccountStatus) {
            if (!['ACTIVE', 'DEACTIVATED', 'DECLINED', 'SUSPENDED', 'PENDING'].includes(requestedAccountStatus)) return json(response, 422, { error: 'Invalid account status.' });
            const timestamp = now();
            const isActive = requestedAccountStatus === 'ACTIVE';
            const isDeclined = requestedAccountStatus === 'DECLINED';
            const reason = body.reason || (isDeclined ? 'Declined by administrator' : 'Deactivated by administrator');
            const blockedUntil = isDeclined ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
            database.prepare('UPDATE staff SET account_status = ?, status = ?, failed_login_attempts = ?, locked_until = ?, blocked_until = ?, deactivated_at = ?, deactivation_reason = ?, reactivated_at = ?, reactivated_by = ? WHERE id = ?').run(requestedAccountStatus, isActive ? 'Active' : 'Inactive', isActive ? 0 : Number(existing.failed_login_attempts || 0), isActive ? null : existing.locked_until, blockedUntil, isActive ? null : (existing.deactivated_at || timestamp), isActive ? null : reason, isActive ? timestamp : existing.reactivated_at, isActive ? user.id : existing.reactivated_by, staffId);
            if (!isActive) await revokeUserSessions(staffId);
            if (isActive) notify(staffId, 'APPROVED', 'Your account has been approved! You can now log in.', 'staff', staffId);
            if (isDeclined) notify(staffId, 'DECLINED', 'Your account was declined. You can try again after 24 hours.', 'staff', staffId);
            audit(user, isActive ? 'Account Reactivated' : isDeclined ? 'Account Declined' : 'Account Manually Deactivated', 'staff', staffId, { adminId: user.id, reason, blockedUntil, result: 'SUCCESS' });
            return json(response, 200, { success: true, message: isActive ? 'Account Reactivated' : isDeclined ? 'User declined successfully.' : 'Account Deactivated' });
        }
        if (body.password) database.prepare('UPDATE staff SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(hashPassword(body.password), staffId);
        if (body.googleEmail !== undefined) {
            const email = String(body.googleEmail || '').trim().toLowerCase() || null;
            if (email && database.prepare('SELECT id FROM staff WHERE lower(google_email) = ? AND id <> ?').get(email, staffId)) return json(response, 409, { error: 'Google account is already linked to another employee.' });
            database.prepare('UPDATE staff SET google_email = ? WHERE id = ?').run(email, staffId);
            audit(user, email ? 'Google Account Linked' : 'Google Account Unlinked', 'staff', staffId, { email });
        }
        if (body.status || body.name || body.department || body.role || body.managerId) database.prepare('UPDATE staff SET name = COALESCE(?, name), department = COALESCE(?, department), role = COALESCE(?, role), designation = COALESCE(?, designation), status = COALESCE(?, status), manager_id = COALESCE(?, manager_id) WHERE id = ?').run(body.name || null, body.department || null, body.role || null, body.designation || null, body.status || null, body.managerId || null, staffId);
        audit(user, body.status ? 'Status changed' : body.password ? 'Password reset' : 'Updated', 'staff', staffId, { fields: Object.keys(body) });
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const today = toLocalDateKey(new Date());
        const period = url.searchParams.get('period') || 'today';
        const range = dashboardPeriodRange(period);
        if (!range) return json(response, 400, { error: 'Period must be all, today, week, or month.' });
        const dateClause = " AND date(l.created_at) BETWEEN ? AND ?";
        const opportunityDateClause = " AND date(o.created_at) BETWEEN ? AND ?";
        const leadPeriodParams = [...ids, range.startDate, range.endDate];
        const opportunityPeriodParams = [...ids, range.startDate, range.endDate];
        const count = (query, params = []) => database.prepare(query).get(...params).count || 0;
        const totalLeads = count(`SELECT COUNT(*) AS count FROM leads l WHERE l.id IN (${placeholders})${dateClause}`, leadPeriodParams);
        const convertedLeads = count(`
            SELECT COUNT(DISTINCT l.id) AS count
            FROM leads l
            WHERE l.id IN (${placeholders})${dateClause}
              AND (
                  EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = l.id AND lower(b.status) = 'confirmed')
                  OR lower(COALESCE(l.status, '')) IN ('won', 'closed', 'converted')
                  OR lower(COALESCE(l.stage, '')) IN ('won', 'closed', 'converted')
                  OR EXISTS (
                      SELECT 1 FROM opportunities o
                      WHERE o.lead_id = l.id
                        AND (
                            lower(COALESCE(o.status, '')) IN ('won', 'closed', 'converted')
                            OR lower(COALESCE(o.stage, '')) IN ('won', 'closed', 'converted')
                        )
                  )
              )
        `, leadPeriodParams);
        const cycle = database.prepare(`SELECT AVG((julianday(b.created_at) - julianday(l.created_at))) AS average FROM leads l JOIN bookings b ON b.lead_id = l.id WHERE l.id IN (${placeholders})${dateClause} AND b.status = 'Confirmed'`).get(...leadPeriodParams).average;
        const myLeads = ids.filter((id) => database.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(id)?.assigned_to === user.id).length;
        const hotLeads = count(`SELECT COUNT(*) AS count FROM leads l WHERE l.id IN (${placeholders})${dateClause} AND COALESCE(l.lead_score, 0) BETWEEN 70 AND 100 AND l.status = 'Active'`, leadPeriodParams);
        const hotPipeline = database.prepare(`SELECT COALESCE(SUM(COALESCE(o.estimated_value, 0)), 0) AS total FROM leads l LEFT JOIN opportunities o ON o.lead_id = l.id WHERE l.id IN (${placeholders})${dateClause} AND COALESCE(l.lead_score, 0) BETWEEN 70 AND 100 AND l.status = 'Active'`).get(...leadPeriodParams).total;
        const hotAverageScore = database.prepare(`SELECT COALESCE(AVG(CAST(l.lead_score AS REAL)), 0) AS average FROM leads l WHERE l.id IN (${placeholders})${dateClause} AND COALESCE(l.lead_score, 0) BETWEEN 70 AND 100 AND l.status = 'Active'`).get(...leadPeriodParams).average;
        const visibleSurveys = database.prepare('SELECT s.*, l.assigned_to AS lead_owner_id FROM surveys s JOIN leads l ON l.id = s.lead_id').all().filter((survey) => surveyCanView(user, survey));
        const todaySurveys = visibleSurveys.filter((survey) => String(survey.survey_date || '').slice(0, 10) === today);
        const activeSurveyStatuses = ['Scheduled', 'Assigned', 'In Progress', 'Rescheduled'];
        const periodSurveys = visibleSurveys.filter((survey) => {
            const surveyDate = String(survey.survey_date || '').slice(0, 10);
            return surveyDate >= range.startDate && surveyDate <= range.endDate;
        });
        return json(response, 200, {
            period,
            startDate: range.startDate,
            endDate: range.endDate,
            metrics: {
                totalLeads,
                newLeads: count(`SELECT COUNT(*) AS count FROM leads l WHERE l.id IN (${placeholders})${dateClause} AND l.stage = 'New' AND l.status = 'Active'`, leadPeriodParams),
                convertedLeads,
                opportunities: count(`SELECT COUNT(*) AS count FROM opportunities o WHERE o.lead_id IN (${placeholders}) AND o.status = 'Active' AND o.stage NOT IN ('Won', 'Lost')${opportunityDateClause}`, opportunityPeriodParams),
                pipelineValue: database.prepare(`SELECT COALESCE(SUM(o.estimated_value), 0) AS total FROM opportunities o WHERE o.lead_id IN (${placeholders}) AND o.status = 'Active' AND o.stage NOT IN ('Won', 'Lost')${opportunityDateClause}`).get(...opportunityPeriodParams).total,
                conversionRate: totalLeads ? (convertedLeads / totalLeads) * 100 : 0,
                averageCycleDays: cycle === null ? null : cycle,
                myLeads,
                hotLeads,
                hotPipeline,
                hotAverageScore,
                todaysFollowUps: count(`SELECT COUNT(*) AS count FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.lead_id IN (${placeholders}) AND date(f.due_at) = ? AND f.status IN ('Pending', 'Scheduled', 'Overdue') AND f.task_status NOT IN ('COMPLETED', 'CANCELLED') AND l.stage NOT IN ('Lost', 'Completed')`, [...ids, today]),
                overdueFollowUps: count(`SELECT COUNT(*) AS count FROM follow_ups WHERE lead_id IN (${placeholders}) AND status = 'Overdue'`, ids),
                siteSurveys: periodSurveys.filter((survey) => activeSurveyStatuses.includes(survey.status)).length,
                todaysSurveys: todaySurveys.length,
                upcomingSurveys: periodSurveys.filter((survey) => String(survey.survey_date || '').slice(0, 10) > today && activeSurveyStatuses.includes(survey.status)).length,
                pendingSurveys: periodSurveys.filter((survey) => activeSurveyStatuses.includes(survey.status)).length,
                completedSurveys: periodSurveys.filter((survey) => survey.status === 'Completed').length,
                rescheduledSurveys: periodSurveys.filter((survey) => survey.status === 'Rescheduled').length,
                proposals: count(`SELECT COUNT(*) AS count FROM proposals WHERE lead_id IN (${placeholders}) AND status NOT IN ('Rejected', 'Expired')`, ids),
                bookings: count(`SELECT COUNT(*) AS count FROM bookings WHERE lead_id IN (${placeholders})`, ids),
                installationPending: count(`SELECT COUNT(*) AS count FROM installations JOIN projects ON projects.id = installations.project_id WHERE projects.lead_id IN (${placeholders}) AND installations.status = 'Pending'`, ids),
                installationInProgress: count(`SELECT COUNT(*) AS count FROM installations JOIN projects ON projects.id = installations.project_id WHERE projects.lead_id IN (${placeholders}) AND installations.status = 'In Progress'`, ids),
                commissioningPending: count(`SELECT COUNT(*) AS count FROM commissioning JOIN projects ON projects.id = commissioning.project_id WHERE projects.lead_id IN (${placeholders}) AND commissioning.status <> 'Completed'`, ids),
                paymentsPending: count(`SELECT COUNT(*) AS count FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders}) AND paid_amount < total_amount`, ids),
                revenue: database.prepare(`SELECT COALESCE(SUM(paid_amount), 0) AS total FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders})`).get(...ids).total,
                outstandingAmount: database.prepare(`SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS total FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders})`).get(...ids).total,
                pendingProposals: count(`SELECT COUNT(*) AS count FROM proposal_records p WHERE p.lead_id IN (${placeholders}) AND lower(p.status) NOT IN ('accepted', 'rejected', 'expired', 'closed', 'won') AND date(p.created_at) BETWEEN ? AND ?`, [...ids, range.startDate, range.endDate]),
                pendingPayments: count(`SELECT COUNT(*) AS count FROM payments JOIN projects ON projects.id = payments.project_id WHERE projects.lead_id IN (${placeholders}) AND paid_amount < total_amount`, ids)
            }
        });
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard/analytics') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const period = url.searchParams.get('period') || 'today';
        const range = dashboardPeriodRange(period);
        if (!range) return json(response, 400, { error: 'Period must be all, today, week, or month.' });
        const dateFilter = "AND date(created_at) BETWEEN ? AND ?";
        const stageRows = database.prepare(`
            SELECT COALESCE(stage, 'Unassigned') AS label, COUNT(*) AS value
            FROM leads
            WHERE id IN (${placeholders}) ${dateFilter}
            GROUP BY stage
            ORDER BY value DESC, label ASC
        `).all(...ids, range.startDate, range.endDate);
        const sourceRows = database.prepare(`
            SELECT COALESCE(lead_source, 'Unknown') AS label, COUNT(*) AS value
            FROM leads
            WHERE id IN (${placeholders}) ${dateFilter}
            GROUP BY lead_source
            ORDER BY value DESC, label ASC
        `).all(...ids, range.startDate, range.endDate);
        const priorityRows = database.prepare(`
            SELECT COALESCE(lead_category, 'Low') AS label, COUNT(*) AS value
            FROM leads
            WHERE id IN (${placeholders}) ${dateFilter}
            GROUP BY COALESCE(lead_category, 'Low')
            ORDER BY CASE COALESCE(lead_category, 'Low')
                WHEN 'Very Hot' THEN 1 WHEN 'Hot' THEN 1 WHEN 'Warm' THEN 2
                WHEN 'Cold' THEN 3 WHEN 'Low' THEN 4 ELSE 5
            END, value DESC
        `).all(...ids, range.startDate, range.endDate);
        const trendRows = database.prepare(`
            SELECT date(created_at) AS label, COUNT(*) AS value
            FROM leads
            WHERE id IN (${placeholders})
              AND date(created_at) BETWEEN ? AND ?
            GROUP BY date(created_at)
            ORDER BY date(created_at) ASC
        `).all(...ids, range.startDate, range.endDate);
        let trends;
        if (period === 'all') {
            trends = trendRows.map((row) => ({
                label: row.label,
                value: Number(row.value || 0)
            }));
        } else {
            const trendValues = new Map(trendRows.map((row) => [row.label, Number(row.value || 0)]));
            trends = [];
            const trendDate = new Date(`${range.startDate}T00:00:00`);
            const trendEnd = new Date(`${range.endDate}T00:00:00`);
            while (trendDate <= trendEnd) {
                const label = toLocalDateKey(trendDate);
                trends.push({ label, value: trendValues.get(label) || 0 });
                trendDate.setDate(trendDate.getDate() + 1);
            }
        }
        const analytics = {
            stageFunnel: stageRows.map((row) => ({ label: String(row.label || 'Unassigned'), value: Number(row.value || 0) })),
            leadSources: sourceRows.map((row) => ({ label: String(row.label || 'Unknown'), value: Number(row.value || 0) })),
            leadPriority: priorityRows.map((row) => ({ label: String(row.label || 'Warm'), value: Number(row.value || 0) })),
            trends
        };
        return json(response, 200, { analytics, period, startDate: range.startDate, endDate: range.endDate, generatedAt: now() });
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
        const tasks = accessibleTaskRows(user);
        const todayKey = toLocalDateKey(new Date());
        return json(response, 200, { tasks, counts: { all: tasks.length, upcoming: tasks.filter((task) => task.status === 'PENDING' && new Date(task.dueAt) >= new Date()).length, today: tasks.filter((task) => task.status === 'PENDING' && toLocalDateKey(task.dueAt) === todayKey).length, overdue: tasks.filter((task) => task.status === 'OVERDUE').length, completed: tasks.filter((task) => task.status === 'COMPLETED').length, cancelled: tasks.filter((task) => task.status === 'CANCELLED').length } });
    }

    const closeTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/close$/);
    if (closeTaskMatch && request.method === 'POST') {
        const taskId = decodeURIComponent(closeTaskMatch[1]);
        const task = database.prepare('SELECT f.*, l.lead_number, l.customer_name FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead || !canAddFollowUp(user, lead, task)) return json(response, 403, { error: 'You do not have permission to close this follow-up.' });
        if (task.task_status && !['PENDING', 'OVERDUE'].includes(task.task_status)) return json(response, 409, { error: 'This follow-up is no longer pending.' });
        const body = await parseBody(request);
        const outcome = String(body.outcome || '').trim();
        const notes = String(body.notes || '').trim();
        const allowedOutcomes = ['Interested', 'Not Interested', 'Call Back Later', 'Meeting Scheduled', 'Quotation Requested', 'Proposal Sent', 'Negotiation', 'Won', 'Lost', 'No Response', 'Wrong Number', 'Not Reachable', 'Other'];
        if (!allowedOutcomes.includes(outcome)) return json(response, 422, { error: 'Select a valid follow-up outcome.' });
        const nextDate = String(body.nextDate || '').trim();
        const nextTime = String(body.nextTime || '').trim();
        if ((nextDate && !nextTime) || (!nextDate && nextTime)) return json(response, 422, { error: 'Enter both a next follow-up date and time.' });
        const timestamp = now();
        const nextDueAt = nextDate ? `${nextDate}T${nextTime}` : null;
        database.exec('BEGIN');
        try {
            database.prepare("UPDATE follow_ups SET status = 'Completed', task_status = 'COMPLETED', notes = ?, outcome = ?, completed_at = ?, completed_by = ?, task_completed_at = ?, task_completed_by = ? WHERE id = ?")
                .run(notes, outcome, timestamp, user.id, timestamp, user.id, taskId);
            audit(user, 'Completed', 'follow-up', taskId, { outcome, notes, previousDueAt: task.due_at, completedAt: timestamp, customer: task.customer_name, opportunityNumber: task.lead_number, description: `Follow-up completed. Outcome: ${outcome}.` });
            let nextTaskId = null;
            if (nextDueAt) {
                nextTaskId = crypto.randomUUID();
                database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(nextTaskId, task.lead_id, nextDueAt, task.type, task.assigned_to, 'Scheduled', '', user.id, timestamp, task.task_title || taskTitle(task.type), 'PENDING');
                audit(user, 'Created', 'follow-up', nextTaskId, { previousDueAt: task.due_at, nextDueAt, description: 'Next follow-up scheduled after completion.', outcome });
            }
            database.exec('COMMIT');
            return json(response, 200, { status: 'COMPLETED', completedAt: timestamp, nextTaskId });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Follow-up close failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to close follow-up. No changes were saved.' });
        }
    }

    const rescheduleTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reschedule$/);
    if (rescheduleTaskMatch && request.method === 'POST') {
        const taskId = decodeURIComponent(rescheduleTaskMatch[1]);
        const task = database.prepare('SELECT f.*, l.lead_number, l.customer_name FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead) return json(response, 404, { error: 'Task not found.' });
        if (!canAddFollowUp(user, lead, task)) return json(response, 403, { error: 'Only the assigned lead owner or assignee can reschedule this follow-up.' });
        const body = await parseBody(request);
        const nextDate = String(body.nextDate || '').trim();
        const nextTime = String(body.nextTime || '').trim();
        const reason = String(body.reason || '').trim();
        if (!nextDate || !nextTime) return json(response, 422, { error: 'New date and time are required.' });
        const nextDueAt = `${nextDate}T${nextTime}`;
        const timestamp = now();
        database.exec('BEGIN');
        try {
            database.prepare("UPDATE follow_ups SET status = 'Rescheduled', task_status = 'RESCHEDULED', notes = CASE WHEN ? <> '' THEN ? ELSE notes END WHERE id = ?").run(reason, reason, taskId);
            const nextTaskId = crypto.randomUUID();
            database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(nextTaskId, task.lead_id, nextDueAt, task.type, task.assigned_to, 'Scheduled', reason, user.id, timestamp, task.task_title || taskTitle(task.type), 'PENDING');
            audit(user, 'Rescheduled', 'follow-up', taskId, { previousDueAt: task.due_at, nextDueAt, reason, newFollowUpId: nextTaskId, customer: task.customer_name, opportunityNumber: task.lead_number, description: 'Follow-up rescheduled.' });
            database.exec('COMMIT');
            return json(response, 200, { status: 'RESCHEDULED', nextTaskId, nextDueAt });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Follow-up reschedule failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to reschedule follow-up. No changes were saved.' });
        }
    }

    if (request.method === 'GET' && url.pathname === '/api/surveys') {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
        const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
        const engineer = String(url.searchParams.get('engineer') || '').trim();
        const leadId = String(url.searchParams.get('leadId') || '').trim();
        const from = String(url.searchParams.get('from') || '').trim();
        const to = String(url.searchParams.get('to') || '').trim();
        const surveys = database.prepare('SELECT s.*, l.lead_number, l.customer_name, l.mobile_number, l.location, l.stage AS lead_stage, l.assigned_to AS lead_owner_id, l.details_json AS lead_details_json, st.name AS assigned_engineer FROM surveys s JOIN leads l ON l.id = s.lead_id LEFT JOIN staff st ON st.id = s.assigned_to ORDER BY datetime(s.survey_date) ASC').all()
            .filter((survey) => surveyCanView(user, survey))
            .filter((survey) => !status || String(survey.status || '').toLowerCase() === status)
            .filter((survey) => !engineer || survey.assigned_to === engineer)
            .filter((survey) => !leadId || survey.lead_id === leadId)
            .filter((survey) => !from || String(survey.survey_date || '').slice(0, 10) >= from)
            .filter((survey) => !to || String(survey.survey_date || '').slice(0, 10) <= to)
            .filter((survey) => !query || [survey.id, survey.lead_number, survey.customer_name, survey.mobile_number, survey.assigned_engineer].some((value) => String(value || '').toLowerCase().includes(query)));
        return json(response, 200, { surveys: surveys.slice((page - 1) * limit, page * limit).map((survey) => surveyDetailsPayload(survey, user)), total: surveys.length, page, limit });
    }

    if (request.method === 'POST' && url.pathname === '/api/surveys') {
        const body = await parseBody(request);
        const leadId = String(body.leadId || body.lead_id || '').trim();
        if (!leadId) return json(response, 422, { error: 'Lead ID is required.', fields: ['leadId'] });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canCreateSurveyRequest(user, lead, canAccess, isAdminUser)) return json(response, 403, { error: 'You do not have permission to request a survey for this lead.' });
        const surveyDate = String(body.surveyDate || body.scheduledDate || body.dueAt || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(surveyDate) || Number.isNaN(Date.parse(surveyDate))) return json(response, 422, { error: 'A valid scheduled date and time are required.', fields: ['surveyDate'] });
        if (Date.parse(surveyDate) <= Date.now()) return json(response, 422, { error: 'Survey date and time must be in the future.', fields: ['surveyDate'] });
        if (body.assignedTo && !canAssignToEmployee(user, body.assignedTo)) return json(response, 403, { error: 'You can only assign surveys to employees in your team.' });
        const assignedTo = isSurveyManager(user) ? String(body.assignedTo || lead.assigned_to || user.id).trim() : String(user.id);
        const engineer = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(assignedTo);
        if (!engineer) return json(response, 422, { error: 'Select an active survey executive.', fields: ['assignedTo'] });
        if (!canAssignToEmployee(user, assignedTo)) return json(response, 403, { error: 'You can only assign surveys to employees in your team.' });
        const conflict = database.prepare("SELECT id FROM surveys WHERE assigned_to = ? AND survey_date = ? AND status NOT IN ('Completed', 'Cancelled') LIMIT 1").get(assignedTo, surveyDate);
        if (conflict) return json(response, 409, { error: 'This survey executive already has a survey at this date and time.', existingSurveyId: conflict.id });
        const existing = database.prepare('SELECT * FROM surveys WHERE lead_id = ?').get(leadId);
        if (existing && existing.status !== 'Cancelled') return json(response, 409, { error: 'A survey already exists for this lead.', surveyId: existing.id });
        const timestamp = now();
        const surveyId = existing?.id || `SUR-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const leadDetails = (() => { try { return JSON.parse(lead.details_json || '{}'); } catch (error) { return {}; } })();
        const priorData = (() => { try { return existing?.completion_data_json ? JSON.parse(existing.completion_data_json) : {}; } catch (error) { return {}; } })();
        const data = { ...priorData, ...body, createdBy: existing ? priorData.createdBy : user.id, createdAt: existing ? priorData.createdAt : timestamp, updatedAt: timestamp };
        delete data.leadId;
        delete data.lead_id;
        delete data.surveyFiles;
        delete data.files;
        try {
            if (existing) {
                database.prepare("UPDATE surveys SET survey_date = ?, assigned_to = ?, customer = ?, address = ?, remarks = ?, survey_type = ?, status = 'Scheduled', completed_at = NULL, completion_data_json = ? WHERE id = ?").run(surveyDate, assignedTo, lead.customer_name, String(body.address || leadDetails.address || lead.location || 'Not provided'), String(body.notes || body.remarks || ''), String(body.surveyType || body.type || 'Site Survey'), JSON.stringify(data), surveyId);
            } else {
                database.prepare("INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, recommended_capacity, remarks, status, survey_type, completion_data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?)").run(surveyId, leadId, surveyDate, assignedTo, lead.customer_name, String(body.address || leadDetails.address || lead.location || 'Not provided'), 'Pending', '{}', '{}', '', String(body.notes || body.remarks || ''), String(body.surveyType || body.type || 'Site Survey'), JSON.stringify(data));
            }
            audit(user, existing ? 'Rescheduled' : 'Created', 'survey', surveyId, { date: surveyDate, engineer: engineer.name, description: existing ? 'Cancelled site survey was rescheduled.' : 'Site survey created.' });
            if (!existing) audit(user, 'Assigned', 'survey', surveyId, { engineer: engineer.name, description: `Site survey assigned to ${engineer.name}.` });
            notify(assignedTo, 'survey-assigned', `Site survey ${surveyId} assigned for lead ${leadId}.`, 'lead', leadId);
        } catch (error) {
            console.error('Survey creation failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to create the survey. No survey data was saved.' });
        }
        return json(response, existing ? 200 : 201, { surveyId, status: 'Scheduled', assignedEngineer: engineer.name });
    }

    const surveyFileMatch = url.pathname.match(/^\/api\/surveys\/([^/]+)\/files(?:\/([^/]+))?$/);
    if (surveyFileMatch) {
        const surveyId = decodeURIComponent(surveyFileMatch[1]);
        const survey = getSurveyRow(surveyId);
        if (!survey) return json(response, 404, { error: 'Survey not found.' });
        if (!surveyCanView(user, survey)) return json(response, 403, { error: 'You do not have permission to access this survey.' });
        if (user.role === 'Telecaller') return json(response, 403, { error: 'Telecallers cannot access survey files.' });
        const fileId = surveyFileMatch[2] ? decodeURIComponent(surveyFileMatch[2]) : '';
        if (request.method === 'GET' && !fileId) {
            const files = database.prepare("SELECT id, category, original_file_name AS fileName, mime_type AS mimeType, file_size AS fileSize, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM survey_files WHERE survey_id = ? AND status = 'UPLOADED' AND storage_path IS NOT NULL ORDER BY datetime(uploaded_at) DESC").all(surveyId);
            return json(response, 200, { files });
        }
        if (request.method === 'POST' && !fileId) {
            if (!surveyCanEdit(user, survey)) return json(response, 403, { error: 'Only the assigned survey executive or a manager can upload files.' });
            const body = await parseBody(request);
            const categories = new Set(['Roof Photos', 'Meter Photos', 'Electricity Bill', 'Inverter Location Photo', 'Structure/Location Photos', 'Other Documents', 'EAST_SIDE_PHOTO', 'WEST_SIDE_PHOTO', 'NORTH_SIDE_PHOTO', 'SOUTH_SIDE_PHOTO', 'ELECTRICITY_METER_PHOTO', 'ELECTRICITY_BILL', 'EARTHING_LOCATION_PHOTO', 'ROOF_PHOTO', 'ROOF_360_VIDEO']);
            const category = String(body.category || '').trim();
            const files = Array.isArray(body.files) ? body.files : [];
            if (!categories.has(category)) return json(response, 422, { error: 'Choose a valid survey file category.', fields: ['category'] });
            if (!files.length || files.length > 20) return json(response, 422, { error: 'Select between 1 and 20 files.', fields: ['files'] });
            const saved = [];
            const storedPaths = [];
            database.exec('BEGIN');
            try {
                for (const file of files) {
                    const stored = saveUploadedFile(file);
                    storedPaths.push(stored.storagePath);
                    const id = crypto.randomUUID();
                    const timestamp = now();
                    try {
                        database.prepare('INSERT INTO survey_files (id, survey_id, lead_id, category, file_name, mime_type, file_size, file_data, uploaded_by, uploaded_at, storage_path, original_file_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)').run(id, surveyId, survey.lead_id, category, stored.originalFileName, stored.mimeType, stored.fileSize, user.id, timestamp, stored.storagePath, stored.originalFileName, 'UPLOADED');
                    } catch (error) {
                        removeStoredFile(stored.storagePath);
                        throw error;
                    }
                    saved.push({ id, category, fileName: stored.originalFileName, mimeType: stored.mimeType, fileSize: stored.fileSize, uploadedBy: user.id, uploadedAt: timestamp });
                    audit(user, 'File Uploaded', 'survey', surveyId, { fileName: stored.originalFileName, category, description: `Survey file uploaded: ${stored.originalFileName}.` });
                }
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                storedPaths.forEach(removeStoredFile);
                console.error('Survey file upload failed.', { errorType: safeErrorType(error) });
                return json(response, 422, { error: error.message || 'Unable to upload survey files.' });
            }
            return json(response, 201, { files: saved });
        }
        if (fileId && request.method === 'DELETE') {
            if (!isAdminUser(user)) return json(response, 403, { error: 'Only Admin/Owner can permanently delete survey files.' });
            const file = database.prepare("SELECT id, original_file_name AS fileName, storage_path AS storagePath FROM survey_files WHERE id = ? AND survey_id = ? AND status = 'UPLOADED'").get(fileId, surveyId);
            if (!file) return json(response, 404, { error: 'Survey file not found.' });
            removeStoredFile(file.storagePath);
            database.prepare("UPDATE survey_files SET status = 'DELETED' WHERE id = ? AND survey_id = ?").run(fileId, surveyId);
            audit(user, 'File Deleted', 'survey', surveyId, { fileName: file.fileName, description: `Survey file deleted: ${file.fileName}.` });
            return json(response, 200, { success: true });
        }
        return json(response, 405, { error: 'Survey file method not allowed.' });
    }

    const surveyDetailMatch = url.pathname.match(/^\/api\/surveys\/([^/]+)$/);
    if (surveyDetailMatch && request.method === 'GET') {
        const survey = getSurveyRow(decodeURIComponent(surveyDetailMatch[1]));
        if (!survey) return json(response, 404, { error: 'Survey not found.' });
        if (!surveyCanView(user, survey)) return json(response, 403, { error: 'You do not have permission to view this survey.' });
        return json(response, 200, { survey: surveyDetailsPayload(survey, user, true) });
    }

    if (surveyDetailMatch && request.method === 'PATCH') {
        const surveyId = decodeURIComponent(surveyDetailMatch[1]);
        const survey = getSurveyRow(surveyId);
        if (!survey) return json(response, 404, { error: 'Survey not found.' });
        if (!surveyCanEdit(user, survey)) return json(response, 403, { error: 'You do not have permission to edit this survey.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(survey.lead_id);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        const body = await parseBody(request);
        const validStatuses = ['Scheduled', 'Assigned', 'In Progress', 'Completed', 'Rescheduled', 'Cancelled'];
        const dataPatch = body.data && typeof body.data === 'object' ? { ...body.data } : {};
        const reserved = new Set(['status', 'surveyDate', 'scheduledDate', 'dueAt', 'assignedTo', 'surveyType', 'type', 'address', 'notes', 'remarks', 'data', 'reschedule']);
        Object.entries(body).forEach(([key, value]) => { if (!reserved.has(key)) dataPatch[key] = value; });
        const numericFields = ['numberOfFloors', 'parapetHeight', 'availableRoofArea', 'roofArea', 'usableRoofArea', 'shadedArea', 'nonUsableArea', 'sanctionedLoad', 'monthlyUnits', 'electricityBill', 'systemCapacity', 'proposedSystemCapacity', 'panelWattage', 'numberOfPanels', 'panelCount', 'inverterCapacity', 'batteryCapacity', 'estimatedMonthlyGeneration', 'estimatedAnnualGeneration', 'estimatedMonthlySavings', 'estimatedAnnualSavings', 'approximateCableLength'];
        for (const field of numericFields) {
            if (dataPatch[field] === '' || dataPatch[field] === null || dataPatch[field] === undefined) continue;
            const value = Number(dataPatch[field]);
            if (!Number.isFinite(value) || value < 0) return json(response, 422, { error: `${field} must be a valid non-negative number.`, fields: [field] });
            dataPatch[field] = value;
        }
        let nextDate = String(body.surveyDate || body.scheduledDate || body.dueAt || survey.survey_date).trim();
        if (body.date || body.time) nextDate = `${String(body.date || survey.survey_date.slice(0, 10))}T${String(body.time || survey.survey_date.slice(11, 16))}`;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(nextDate) || Number.isNaN(Date.parse(nextDate))) return json(response, 422, { error: 'Enter a valid survey date and time.', fields: ['surveyDate'] });
        const assignedTo = String(body.assignedTo || survey.assigned_to).trim();
        if (body.assignedTo && String(body.assignedTo) !== String(survey.assigned_to) && !canAssignToEmployee(user, body.assignedTo)) return json(response, 403, { error: 'Only Admin or a manager can reassign a survey within their team.' });
        const engineer = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(assignedTo);
        if (!engineer) return json(response, 422, { error: 'Select an active survey executive.', fields: ['assignedTo'] });
        const conflict = database.prepare("SELECT id FROM surveys WHERE assigned_to = ? AND survey_date = ? AND status NOT IN ('Completed', 'Cancelled') AND id <> ? LIMIT 1").get(assignedTo, nextDate, surveyId);
        if (conflict) return json(response, 409, { error: 'This survey executive already has a survey at this date and time.', existingSurveyId: conflict.id });
        let nextStatus = String(body.status || survey.status);
        if (body.reschedule || nextDate !== survey.survey_date) nextStatus = 'Rescheduled';
        if (!validStatuses.includes(nextStatus)) return json(response, 422, { error: 'Invalid survey status.', fields: ['status'] });
        if (nextStatus === 'Completed') {
            if (lead.stage !== 'Site Survey Scheduled') return json(response, 422, { error: 'The lead must be in the scheduled survey stage before survey completion.' });
            let storedData = {};
            try { storedData = survey.completion_data_json ? JSON.parse(survey.completion_data_json) : {}; } catch (error) { storedData = {}; }
            const completionBody = { ...storedData, ...dataPatch, ...body, surveyFiles: [] };
            const missing = stageMissing(lead, completionBody);
            if (missing.length) return json(response, 422, { error: 'Survey cannot be completed until required information and evidence are provided.', fields: missing });
        }
        if (nextDate !== survey.survey_date && !['Completed', 'Cancelled'].includes(nextStatus) && Date.parse(nextDate) <= Date.now()) return json(response, 422, { error: 'A rescheduled survey must be in the future.', fields: ['surveyDate'] });
        const requiresBattery = ['yes', 'true', '1'].includes(String(dataPatch.batteryRequired ?? '').toLowerCase());
        if (requiresBattery && dataPatch.batteryCapacity !== undefined && Number(dataPatch.batteryCapacity) <= 0) return json(response, 422, { error: 'Battery capacity must be greater than zero when a battery is required.', fields: ['batteryCapacity'] });
        if (requiresBattery && nextStatus === 'Completed' && !(Number(dataPatch.batteryCapacity) > 0)) return json(response, 422, { error: 'Enter a battery capacity before completing a survey that requires a battery.', fields: ['batteryCapacity'] });
        if (nextStatus === 'Cancelled' && !isSurveyManager(user)) return json(response, 403, { error: 'Only a manager can cancel a survey.' });
        const timestamp = now();
        let existingData = {};
        try { existingData = survey.completion_data_json ? JSON.parse(survey.completion_data_json) : {}; } catch (error) { existingData = {}; }
        const nextData = { ...existingData, ...dataPatch, updatedAt: timestamp, updatedBy: user.id };
        const oldStatus = survey.status;
        const changedAssignment = assignedTo !== survey.assigned_to;
        database.exec('BEGIN');
        try {
            database.prepare('UPDATE surveys SET survey_date = ?, assigned_to = ?, address = ?, remarks = ?, survey_type = ?, status = ?, completed_at = ?, sanctioned_load = ?, recommended_capacity = ?, completion_data_json = ? WHERE id = ?')
                .run(nextDate, assignedTo, String(body.address ?? survey.address), String(body.notes ?? body.remarks ?? survey.remarks ?? ''), String(body.surveyType || body.type || survey.survey_type || 'Site Survey'), nextStatus, nextStatus === 'Completed' ? (survey.completed_at || timestamp) : null, String(nextData.sanctionedLoad ?? survey.sanctioned_load ?? ''), String(nextData.proposedSystemCapacity ?? nextData.systemCapacity ?? survey.recommended_capacity ?? ''), JSON.stringify(nextData), surveyId);
            if (nextStatus === 'Completed') database.prepare("UPDATE leads SET stage = 'Survey Completed', updated_at = ? WHERE id = ?").run(timestamp, survey.lead_id);
            if (changedAssignment) {
                audit(user, 'Assigned', 'survey', surveyId, { previousEngineer: survey.assigned_engineer, engineer: engineer.name, description: `Survey assigned to ${engineer.name}.` });
                notify(assignedTo, 'survey-assigned', `Survey ${surveyId} assigned to you.`, 'lead', survey.lead_id);
            }
            if (body.reschedule || nextDate !== survey.survey_date || nextStatus === 'Rescheduled') {
                audit(user, 'Rescheduled', 'survey', surveyId, { previousDate: survey.survey_date, nextDate, description: `Survey rescheduled to ${nextDate}.` });
                notify(survey.assigned_to, 'survey-rescheduled', `Survey ${surveyId} was rescheduled.`, 'lead', survey.lead_id);
            } else if (nextStatus !== oldStatus) {
                const action = nextStatus === 'In Progress' ? 'Started' : nextStatus === 'Completed' ? 'Completed' : nextStatus === 'Cancelled' ? 'Cancelled' : 'Updated';
                audit(user, action, 'survey', surveyId, { previousStatus: oldStatus, newStatus: nextStatus, description: `Survey ${action.toLowerCase()}.` });
                if (nextStatus === 'Completed') notify(survey.lead_owner_id, 'survey-completed', `Survey ${surveyId} has been completed.`, 'lead', survey.lead_id);
                if (nextStatus === 'Cancelled') notify(survey.assigned_to, 'survey-cancelled', `Survey ${surveyId} was cancelled.`, 'lead', survey.lead_id);
            } else if (Object.keys(dataPatch).length || body.notes !== undefined || body.address !== undefined) {
                audit(user, 'Updated', 'survey', surveyId, { fields: Object.keys(dataPatch), description: 'Survey information updated.' });
            }
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Survey update failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to update the survey. No changes were saved.' });
        }
        const updated = getSurveyRow(surveyId);
        return json(response, 200, { survey: surveyDetailsPayload(updated, user, false) });
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'PATCH') {
        const taskId = decodeURIComponent(taskMatch[1]);
        const task = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead) return json(response, 404, { error: 'Task not found.' });
        if (!canAddFollowUp(user, lead, task)) return json(response, 403, { error: 'Only the assigned lead owner or assignee can update this task.' });
        const body = await parseBody(request);
        const changes = [];
        const values = [];
        if (body.title !== undefined) { changes.push('task_title = ?'); values.push(String(body.title).trim() || taskTitle(task.type)); }
        if (body.notes !== undefined) { changes.push('notes = ?'); values.push(String(body.notes)); }
        if (body.dueAt !== undefined) { if (!String(body.dueAt).trim()) return json(response, 422, { error: 'Due date and time are required.' }); changes.push('due_at = ?'); values.push(body.dueAt); }
        if (body.assignedTo !== undefined) {
            const employee = database.prepare("SELECT id FROM staff WHERE id = ? AND status = 'Active'").get(body.assignedTo);
            if (!employee) return json(response, 422, { error: 'Select an active assigned employee.' });
            if (String(body.assignedTo) !== String(task.assigned_to || '') && !canAssignToEmployee(user, body.assignedTo)) return json(response, 403, { error: 'Only Admin or a manager can reassign this task within their team.' });
            changes.push('assigned_to = ?');
            values.push(body.assignedTo);
        }
        if (body.status === 'CANCELLED') { changes.push("task_status = 'CANCELLED'"); changes.push("status = 'Cancelled'"); }
        if (body.status === 'PENDING') { changes.push("task_status = 'PENDING'"); changes.push("status = 'Scheduled'"); }
        if (!changes.length) return json(response, 422, { error: 'No task changes were provided.' });
        values.push(taskId);
        database.prepare(`UPDATE follow_ups SET ${changes.join(', ')} WHERE id = ?`).run(...values);
        const action = body.status === 'CANCELLED' ? 'Cancelled' : body.dueAt ? 'Rescheduled' : 'Updated';
        audit(user, action, 'follow-up', taskId, { description: `Task ${action.toLowerCase()}.`, previousDueAt: task.due_at, nextDueAt: body.dueAt || task.due_at });
        return json(response, 200, { task: taskRow(database.prepare('SELECT f.*, l.lead_number, l.customer_name, s.name AS assigned_employee FROM follow_ups f JOIN leads l ON l.id = f.lead_id LEFT JOIN staff s ON s.id = f.assigned_to WHERE f.id = ?').get(taskId)) });
    }

    const surveyRecordMatch = url.pathname.match(/^\/api\/surveys\/([^/]+)$/);
    if (surveyRecordMatch && request.method === 'PATCH') {
        const surveyId = decodeURIComponent(surveyRecordMatch[1]);
        const survey = database.prepare('SELECT * FROM surveys WHERE id = ?').get(surveyId);
        const lead = survey && database.prepare('SELECT * FROM leads WHERE id = ?').get(survey.lead_id);
        if (!survey || !lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this site survey.' });
        const body = await parseBody(request);
        const nextStatus = body.status || survey.status;
        if (!['Scheduled', 'Completed', 'Cancelled'].includes(nextStatus)) return json(response, 422, { error: 'Invalid site survey status.' });
        const assignedTo = body.assignedTo || survey.assigned_to;
        const engineer = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(assignedTo);
        if (!engineer) return json(response, 422, { error: 'The selected survey engineer is not active or does not exist.', fields: ['assignedTo'] });
        const dueAt = body.dueAt || body.surveyDate || survey.survey_date;
        const timestamp = now();
        const relatedTask = database.prepare("SELECT * FROM follow_ups WHERE task_related_type = 'survey' AND task_related_id = ?").get(surveyId);
        database.exec('BEGIN');
        try {
            database.prepare('UPDATE surveys SET survey_date = ?, assigned_to = ?, address = ?, remarks = ?, survey_type = ?, status = ?, completed_at = ? WHERE id = ?').run(dueAt, engineer.id, body.address || survey.address, body.remarks || survey.remarks, body.type || survey.survey_type, nextStatus, nextStatus === 'Completed' ? (survey.completed_at || timestamp) : null, surveyId);
            if (nextStatus === 'Completed') database.prepare("UPDATE leads SET stage = 'Survey Completed', updated_at = ? WHERE id = ?").run(timestamp, lead.id);
            if (relatedTask) {
                const taskStatus = nextStatus === 'Completed' ? 'COMPLETED' : nextStatus === 'Cancelled' ? 'CANCELLED' : 'PENDING';
                database.prepare('UPDATE follow_ups SET due_at = ?, assigned_to = ?, notes = ?, status = ?, task_status = ?, task_completed_at = ?, task_completed_by = ? WHERE id = ?').run(dueAt, engineer.id, body.remarks || survey.remarks, nextStatus === 'Completed' ? 'Completed' : nextStatus === 'Cancelled' ? 'Cancelled' : 'Scheduled', taskStatus, nextStatus === 'Completed' ? (relatedTask.task_completed_at || timestamp) : null, nextStatus === 'Completed' ? (relatedTask.task_completed_by || user.id) : null, relatedTask.id);
            }
            const action = nextStatus === 'Completed' ? 'Completed' : nextStatus === 'Cancelled' ? 'Cancelled' : dueAt !== survey.survey_date ? 'Rescheduled' : 'Updated';
            audit(user, action, 'survey', surveyId, { previousDate: survey.survey_date, nextDate: dueAt, engineer: engineer.name, description: `Site survey ${action.toLowerCase()}.` });
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Site survey update failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to update site survey. No changes were saved.' });
        }
        return json(response, 200, { surveyId, status: nextStatus, assignedEngineer: engineer.name, dueAt });
    }

    const completeTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (completeTaskMatch && request.method === 'POST') {
        const taskId = decodeURIComponent(completeTaskMatch[1]);
        const task = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(taskId);
        const lead = task && database.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id);
        if (!task || !lead) return json(response, 404, { error: 'Task not found.' });
        if (!canAddFollowUp(user, lead, task)) return json(response, 403, { error: 'Only the assigned lead owner or assignee can complete this task.' });
        const timestamp = now();
        database.prepare("UPDATE follow_ups SET status = 'Completed', task_status = 'COMPLETED', completed_at = COALESCE(completed_at, ?), completed_by = COALESCE(completed_by, ?), task_completed_at = ?, task_completed_by = ? WHERE id = ?").run(timestamp, user.id, timestamp, user.id, taskId);
        audit(user, 'Completed', 'follow-up', taskId, { status: 'COMPLETED', description: `Task completed by ${user.name}.` });
        return json(response, 200, { status: 'COMPLETED', completedAt: timestamp });
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard/groups') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const today = toLocalDateKey(new Date());
        const period = url.searchParams.get('period') || 'today';
        const range = dashboardPeriodRange(period);
        if (!range) return json(response, 400, { error: 'Period must be all, today, week, or month.' });
        const dashboardSurveys = database.prepare(`SELECT s.id AS survey_id, s.lead_id, s.survey_date, s.survey_type, s.status, s.assigned_to, s.customer, s.address, s.sanctioned_load, s.recommended_capacity, s.completion_data_json, l.id AS lead_id_value, l.lead_number, l.customer_name, l.mobile_number, l.details_json AS lead_details_json, l.assigned_to AS lead_owner_id, st.name AS assigned_engineer, EXISTS (SELECT 1 FROM survey_files sf WHERE sf.survey_id = s.id AND sf.status = 'UPLOADED') AS has_report FROM surveys s JOIN leads l ON l.id = s.lead_id LEFT JOIN staff st ON st.id = s.assigned_to ORDER BY datetime(s.survey_date)`).all()
            .filter((survey) => surveyCanView(user, survey))
            .filter((survey) => {
                const surveyDate = String(survey.survey_date || '').slice(0, 10);
                return surveyDate >= range.startDate && surveyDate <= range.endDate;
            }).map((survey) => {
                let completion = {};
                let leadDetails = {};
                try { completion = JSON.parse(survey.completion_data_json || '{}'); } catch (error) { completion = {}; }
                try { leadDetails = JSON.parse(survey.lead_details_json || '{}'); } catch (error) { leadDetails = {}; }
                return {
                    ...survey,
                    lead_id: survey.lead_id_value,
                    lead_number: publicLeadNumber(survey.lead_number),
                    leadNumber: publicLeadNumber(survey.lead_number),
                    can_edit: surveyCanEdit(user, survey),
                    property_type: completion.propertyType || completion.installationType || leadDetails.propertyType || leadDetails.installationType || '',
                    system_capacity: survey.recommended_capacity || completion.proposedSystemCapacity || completion.systemCapacity || leadDetails.requiredSolarCapacity || '',
                    has_report: Boolean(survey.has_report)
                };
            });
        const query = (sql, params = ids) => database.prepare(sql).all(...params);
        const groups = {
            todaysFollowUps: query(`
                SELECT f.id, f.lead_id, l.customer_name, l.mobile_number, l.lead_number, l.stage AS lead_stage, l.priority,
                       f.type AS follow_up_type, f.notes, COALESCE(f.assigned_to, l.assigned_to) AS assigned_to,
                       COALESCE(a.name, assigned_owner.name) AS assigned_employee,
                       f.due_at,
                       f.status,
                       f.task_status,
                       CASE
                           WHEN f.status = 'Overdue' OR f.task_status = 'OVERDUE' OR (datetime(f.due_at) < datetime('now') AND f.status IN ('Pending', 'Scheduled')) THEN 'Overdue'
                           WHEN f.status IN ('Pending', 'Scheduled') OR f.task_status IN ('PENDING', 'SCHEDULED') THEN 'Pending'
                           ELSE f.status
                       END AS effective_status,
                       datetime(f.due_at) AS due_at_dt
                FROM follow_ups f
                JOIN leads l ON l.id = f.lead_id
                LEFT JOIN staff a ON a.id = f.assigned_to
                LEFT JOIN staff assigned_owner ON assigned_owner.id = l.assigned_to
                WHERE l.id IN (${placeholders})
                                    AND date(f.due_at) BETWEEN ? AND ?
                  AND f.status IN ('Pending', 'Scheduled', 'Overdue')
                  AND f.task_status NOT IN ('COMPLETED', 'CANCELLED')
                  AND l.stage NOT IN ('Lost', 'Completed')
                ORDER BY datetime(f.due_at) ASC
            `, [...ids, range.startDate, range.endDate]),
            newLeads: query(`SELECT l.id AS lead_id, l.lead_number, l.customer_name, l.mobile_number, l.lead_source, l.stage, l.status, l.created_at, l.assigned_to, COALESCE(st.name, 'Unassigned') AS assigned_employee FROM leads l LEFT JOIN staff st ON st.id = l.assigned_to WHERE l.id IN (${placeholders}) AND l.stage = 'New' AND l.status = 'Active' AND date(l.created_at) BETWEEN ? AND ? ORDER BY datetime(l.created_at) DESC LIMIT 25`, [...ids, range.startDate, range.endDate]),
            hotDeals: query(`SELECT l.id AS lead_id, l.lead_number, l.customer_name, l.mobile_number, l.assigned_to, COALESCE(st.name, 'Unassigned') AS assigned_employee, l.lead_score, l.lead_category, l.priority, l.stage, l.created_at, l.updated_at, COALESCE(o.estimated_value, 0) AS estimated_value, (SELECT MIN(f.due_at) FROM follow_ups f WHERE f.lead_id = l.id AND f.status IN ('Pending', 'Scheduled', 'Overdue') AND f.task_status NOT IN ('COMPLETED', 'CANCELLED') AND datetime(f.due_at) >= datetime('now')) AS next_follow_up FROM leads l LEFT JOIN staff st ON st.id = l.assigned_to LEFT JOIN opportunities o ON o.lead_id = l.id WHERE l.id IN (${placeholders}) AND COALESCE(l.lead_score, 0) BETWEEN 70 AND 100 AND l.status = 'Active' AND date(l.created_at) BETWEEN ? AND ? ORDER BY l.lead_score DESC, COALESCE(o.estimated_value, 0) DESC LIMIT 25`, [...ids, range.startDate, range.endDate]),
            scheduledSurveys: dashboardSurveys,
            pendingProposals: query(`SELECT p.id AS proposal_id, p.proposal_number, p.lead_id, p.customer_name, p.system_capacity, p.final_amount, p.created_at, p.status, l.lead_number FROM proposal_records p JOIN leads l ON l.id = p.lead_id WHERE p.lead_id IN (${placeholders}) AND lower(p.status) NOT IN ('accepted', 'rejected', 'expired', 'closed', 'won') AND date(p.created_at) BETWEEN ? AND ? ORDER BY datetime(p.created_at) DESC LIMIT 25`, [...ids, range.startDate, range.endDate]),
            futureInterested: query(`SELECT l.id AS lead_id, l.lead_number, l.customer_name, l.mobile_number, l.priority, l.stage, l.created_at, COALESCE(st.name, 'Unassigned') AS assigned_employee, MIN(f.due_at) AS next_follow_up FROM leads l JOIN follow_ups f ON f.lead_id = l.id LEFT JOIN staff st ON st.id = l.assigned_to WHERE l.id IN (${placeholders}) AND l.status = 'Active' AND l.stage = 'Nurturing' AND f.status IN ('Pending', 'Scheduled', 'Overdue') AND date(f.due_at) > ? AND date(l.created_at) BETWEEN ? AND ? GROUP BY l.id ORDER BY datetime(next_follow_up)`, [...ids, today, range.startDate, range.endDate])
        };
        for (const [groupName, items] of Object.entries(groups)) {
            if (Array.isArray(items)) groups[groupName] = items.map(publicLeadNumberFields);
        }
        return json(response, 200, { groups, period, startDate: range.startDate, endDate: range.endDate, generatedAt: now() });
    }

    if (request.method === 'GET' && url.pathname === '/api/follow-ups/today') {
        const ids = accessibleLeadIds(user);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
        const today = toLocalDateKey(new Date());
        const items = database.prepare(`
            SELECT f.id, f.lead_id, l.customer_name, l.mobile_number, l.lead_number, l.stage AS lead_stage, l.priority,
                   f.type AS follow_up_type, f.notes, f.status, f.task_status, f.due_at,
                   COALESCE(f.assigned_to, l.assigned_to) AS assigned_to,
                   COALESCE(st.name, owner.name) AS assigned_employee
            FROM follow_ups f
            JOIN leads l ON l.id = f.lead_id
            LEFT JOIN staff st ON st.id = f.assigned_to
            LEFT JOIN staff owner ON owner.id = l.assigned_to
            WHERE l.id IN (${placeholders})
              AND date(f.due_at) = ?
              AND f.status IN ('Pending', 'Scheduled', 'Overdue')
              AND f.task_status NOT IN ('COMPLETED', 'CANCELLED')
              AND l.stage NOT IN ('Lost', 'Completed')
            ORDER BY datetime(f.due_at) ASC
        `).all(...ids, today);
        return json(response, 200, { items: items.map(publicLeadNumberFields), count: items.length, generatedAt: now() });
    }

    if (request.method === 'GET' && url.pathname === '/api/search') {
        const query = String(url.searchParams.get('q') || '').trim();
        if (!query) return json(response, 200, { results: [] });
        const term = `%${query}%`;
        const results = database.prepare(`SELECT l.id, l.lead_number, l.customer_name, l.mobile_number, l.email, l.stage, l.assigned_to, s.name AS assigned_employee FROM leads l LEFT JOIN staff s ON s.id = l.assigned_to WHERE (l.id LIKE ? OR l.lead_number LIKE ? OR l.customer_name LIKE ? OR l.mobile_number LIKE ? OR l.email LIKE ?) ORDER BY l.updated_at DESC LIMIT 25`).all(term, term, term, term, term).filter((lead) => canAccess(user, lead)).map((lead) => ({ recordType: 'Lead', id: lead.id, leadNumber: publicLeadNumber(lead.lead_number), customerName: lead.customer_name, status: lead.stage, assignedEmployee: lead.assigned_employee || 'Unassigned', url: `lead-details.html?lead=${encodeURIComponent(lead.id)}` }));
        return json(response, 200, { results });
    }

    if (request.method === 'GET' && url.pathname === '/api/leads') {
        const leads = await leadService.list(user);
        const hotOnly = url.searchParams.get('filter') === 'hot' || url.searchParams.get('module') === 'hot-deals';
        const visibleLeads = hotOnly ? leads.filter((lead) => lead.hotDealPercentage >= 70 && lead.hotDealPercentage <= 100).sort((left, right) => right.hotDealPercentage - left.hotDealPercentage) : leads;
        return json(response, 200, { leads: visibleLeads });
    }

    if (request.method === 'POST' && url.pathname === '/api/leads') {
        const body = await parseBody(request);
        const required = ['customerName', 'mobileNumber', 'leadDate', 'leadSource', 'assignedTo'];
        const missing = required.filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: 'Required fields are missing.', fields: missing });
        if (!isAdminUser(user) && String(body.assignedTo) !== String(user.id)) return json(response, 403, { error: 'Only Admin/Owner users can assign a new lead to another employee.' });
        const normalizedMobile = normalizeIndianMobileNumber(body.mobileNumber);
        if (!normalizedMobile) return json(response, 422, { error: 'INVALID_MOBILE', message: 'Enter a valid 10-digit Indian mobile number.', fields: ['mobileNumber'] });
        const duplicate = findDuplicateLeadByMobile(normalizedMobile);
        if (duplicate) {
            recordDuplicateLeadAttempt(user, duplicate, normalizedMobile, 'create');
            return json(response, 409, {
                error: 'DUPLICATE_MOBILE',
                message: 'A lead with this mobile number already exists.',
                existingLead: duplicateLeadDetails(user, duplicate)
            });
        }
        const duplicateEmail = body.email ? database.prepare('SELECT id FROM leads WHERE email = ? AND email <> ?').get(String(body.email).trim(), '') : null;
        if (duplicateEmail) return json(response, 409, { error: 'DUPLICATE_EMAIL', message: 'A lead with this email already exists.' });
        const assignedEmployee = database.prepare("SELECT id FROM staff WHERE id = ? AND status = 'Active'").get(body.assignedTo);
        if (!assignedEmployee) return json(response, 422, { error: 'Please assign this lead to an active employee.' });
        const timestamp = now();
        const details = { alternateNumber: body.alternateNumber || '', address: body.address || '', city: body.city || '', pincode: body.pincode || '', leadType: body.leadType || '', initialRequirement: body.initialRequirement || '', remarks: body.remarks || '', electricityBill: body.electricityBill || '', monthlyUnits: body.monthlyUnits || '', sanctionedLoad: body.sanctionedLoad || '', requiredSolarCapacity: body.requiredSolarCapacity || '', batteryRequirement: body.batteryRequirement || '', roofType: body.roofType || '', otherInitialRequirements: body.otherInitialRequirements || '', propertyType: body.propertyType || body.property_type || '', monthlyBill: body.monthlyBill || body.monthly_bill || body.electricityBill || '', roofAvailable: body.roofAvailable || body.roof_available || '', interestedInSolar: body.interestedInSolar || body.interested_in_solar || '', decisionMaker: body.decisionMaker || body.decision_maker || '', bengaluruZone: body.bengaluruZone || body.bengaluru_zone || '', stage: 'New' };
        const scoreSnapshot = getLeadScoreSnapshot({ ...details, location: details.city || body.location || null, property_type: body.propertyType || body.property_type || details.propertyType || '', monthly_bill: body.monthlyBill || body.monthly_bill || details.monthlyBill || details.electricityBill || 0, roof_available: body.roofAvailable || body.roof_available || '', interested_in_solar: body.interestedInSolar || body.interested_in_solar || '', decision_maker: body.decisionMaker || body.decision_maker || '', stage: 'New' });
        let id;
        let transactionStarted = false;
        try {
            database.exec('BEGIN IMMEDIATE');
            transactionStarted = true;
            const validNumbers = database.prepare('SELECT lead_number FROM leads WHERE lead_number GLOB ?').all(SQLITE_LEAD_NUMBER_GLOB).map((row) => row.lead_number);
            let leadNumber = nextLeadNumber(validNumbers);
            while (leadNumber && database.prepare('SELECT id FROM leads WHERE lead_number = ?').get(leadNumber)) {
                validNumbers.push(leadNumber);
                leadNumber = nextLeadNumber(validNumbers);
            }
            if (!leadNumber || !isValidLeadNumber(leadNumber)) {
                database.exec('ROLLBACK');
                transactionStarted = false;
                return json(response, 422, { error: 'Lead number capacity has been reached.' });
            }
            do { id = `INP-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`; } while (database.prepare('SELECT id FROM leads WHERE id = ?').get(id));
            database.prepare(`INSERT INTO leads (id, lead_number, customer_name, mobile_number, email, lead_date, lead_source, assigned_to, stage, priority, location, created_by, created_at, updated_at, details_json, lead_score, lead_category, monthly_bill, property_type, roof_available, interested_in_solar, decision_maker, bengaluru_zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, leadNumber, body.customerName.trim(), normalizedMobile, body.email || null, body.leadDate, body.leadSource, assignedEmployee.id, 'New', body.leadPriority || 'Warm', details.city || body.location || null, user.id, timestamp, timestamp, JSON.stringify(details), scoreSnapshot.leadScore, scoreSnapshot.leadCategory, scoreSnapshot.monthlyBill || null, scoreSnapshot.propertyType || null, scoreSnapshot.roofAvailable || null, scoreSnapshot.interestedInSolar || null, scoreSnapshot.decisionMaker || null, scoreSnapshot.bengaluruZone || null);
            audit(user, 'Created', 'lead', id, { leadNumber, stage: 'New', assignedTo: assignedEmployee.id, leadScore: scoreSnapshot.leadScore, leadCategory: scoreSnapshot.leadCategory });
            notify(assignedEmployee.id, 'lead-assigned', `New lead ${leadNumber} assigned to you.`, 'lead', id);
            database.exec('COMMIT');
            transactionStarted = false;
        } catch (error) {
            if (transactionStarted) database.exec('ROLLBACK');
            const concurrentDuplicate = findDuplicateLeadByMobile(normalizedMobile);
            if (concurrentDuplicate) {
                recordDuplicateLeadAttempt(user, concurrentDuplicate, normalizedMobile, 'create');
                return json(response, 409, {
                    error: 'DUPLICATE_MOBILE',
                    message: 'A lead with this mobile number already exists.',
                    existingLead: duplicateLeadDetails(user, concurrentDuplicate)
                });
            }
            return json(response, 500, { error: 'Unable to create lead. Please try again.' });
        }
        return json(response, 201, { lead: normalizeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(id)) });
    }

    const leadMatch = url.pathname.match(/^\/api\/leads\/([^/]+)$/);
    if (leadMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(leadMatch[1]);
        const lead = await leadService.get(user, leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (lead.forbidden) return json(response, 403, { error: 'You do not have permission to view this lead.' });
        return json(response, 200, { lead });
    }
    const leadActionMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/actions$/);
    const leadStageMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/stage$/);
    if (leadStageMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(leadStageMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this lead stage.' });
        try {
            assertLeadOwnerAccess(user, lead, 'Only the assigned lead owner can change the lead stage.');
        } catch (error) {
            return json(response, error.status || 403, { error: error.error || 'Only the assigned lead owner can change the lead stage.' });
        }
        const body = await parseBody(request);
        const targetStage = String(body.stage || '').trim();
        if (!['New', 'Contacted', 'Qualified', 'Site Survey', 'Survey Scheduled', 'Survey Completed', 'Negotiation', 'Converted'].includes(targetStage)) {
            return json(response, 422, { error: 'Invalid lead stage.', stage: targetStage });
        }
        if (lead.stage === targetStage) return json(response, 200, { success: true, previousStage: lead.stage, stage: targetStage, unchanged: true });
        const timestamp = now();
        database.exec('BEGIN');
        try {
            const previousStage = lead.stage;
            const currentHistory = database.prepare('SELECT id, started_at FROM lead_stage_history WHERE lead_id = ? AND stage = ? AND completed_at IS NULL ORDER BY datetime(started_at) DESC LIMIT 1').get(lead.id, previousStage);
            if (currentHistory) database.prepare('UPDATE lead_stage_history SET completed_at = ?, completed_by = ?, duration_seconds = ? WHERE id = ?').run(timestamp, user.id, Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(currentHistory.started_at)) / 1000)), currentHistory.id);
            database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), lead.id, targetStage, timestamp);
            database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(targetStage, timestamp, lead.id);
            database.prepare('INSERT INTO lead_activities (id, lead_id, activity_type, title, description, user_id, related_record_type, related_record_id, previous_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(crypto.randomUUID(), lead.id, 'STAGE_CHANGED', 'Stage Changed', `Lead stage changed from ${previousStage} to ${targetStage}.`, user.id, 'lead', lead.id, previousStage, targetStage, timestamp);
            audit(user, 'Stage changed', 'lead', lead.id, { previousStage, newStage: targetStage, description: `Lead stage changed from ${previousStage} to ${targetStage}.` });
            notify(lead.assigned_to, 'lead-stage-changed', `Lead ${lead.id} moved from ${previousStage} to ${targetStage}.`, 'lead', lead.id);
            database.exec('COMMIT');
            return json(response, 200, { success: true, previousStage, stage: targetStage, activityType: 'STAGE_CHANGED' });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Lead stage change failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to update lead stage.' });
        }
    }

    if (leadActionMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(leadActionMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to act on this lead.' });
        const body = await parseBody(request);
        const ownerAttempt = rejectOwnerChangeAttempt(user, lead, body);
        if (ownerAttempt) return json(response, ownerAttempt.status, { error: ownerAttempt.error });
        const action = body.action;
        const timestamp = now();
        if (action === 'complete-stage') {
            try { assertLeadOwnerAccess(user, lead, 'Only the assigned lead owner can change the lead stage.'); } catch (error) { return json(response, error.status || 403, { error: error.error || 'Only the assigned lead owner can change the lead stage.' }); }
            const result = completeStage(user, lead, body);
            if (result.missing) return json(response, 422, { error: 'Cannot complete this stage. Please complete:', missing: result.missing });
            return json(response, 200, { success: true, previousStage: lead.stage, stage: result.nextStage });
        }
        if (action === 'stage') return json(response, 422, { error: 'Stages can only change through Mark Complete after validation.' });
        if (action === 'status') {
            try { assertLeadOwnerAccess(user, lead, 'Only the assigned lead owner can change the lead status.'); } catch (error) { return json(response, error.status || 403, { error: error.error || 'Only the assigned lead owner can change the lead status.' }); }
            const statuses = ['Active', 'In Progress', 'On Hold', 'Converted', 'Won', 'Lost', 'Closed'];
            if (!statuses.includes(body.value)) return json(response, 422, { error: 'Invalid lead status.' });
            if (body.value === 'Lost' && (!String(body.reason || '').trim() || !String(body.notes || '').trim())) return json(response, 422, { error: 'Lost Reason and Lost Notes are required.', fields: ['reason', 'notes'] });
            if (body.value === 'Won' && (!String(body.finalAmount || '').trim() || !String(body.closingDate || '').trim() || !String(body.conversionDetails || '').trim())) return json(response, 422, { error: 'Final Amount, Closing Date, and Conversion Details are required.', fields: ['finalAmount', 'closingDate', 'conversionDetails'] });
            let details = {};
            try { details = lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { details = {}; }
            const statusDetails = body.value === 'Lost' ? { lostReason: body.reason, lostNotes: body.notes } : body.value === 'Won' ? { finalAmount: body.finalAmount, closingDate: body.closingDate, conversionDetails: body.conversionDetails } : {};
            database.prepare('UPDATE leads SET status = ?, details_json = ?, updated_at = ? WHERE id = ?').run(body.value, JSON.stringify({ ...details, ...statusDetails }), timestamp, leadId);
            audit(user, 'Status changed', 'lead', leadId, { previous: lead.status, next: body.value, reason: body.reason || null, notes: body.notes || null });
            if (lead.assigned_to && lead.assigned_to !== user.id) notify(lead.assigned_to, 'lead-status-changed', `Lead ${lead.lead_number} status changed from ${lead.status} to ${body.value}.`, 'lead', leadId);
            return json(response, 200, { success: true });
        }
        if (action === 'schedule-survey') {
            if (!['Opportunity', 'Site Survey Scheduled'].includes(lead.stage)) return json(response, 422, { error: 'A survey can only be scheduled from the Opportunity or Site Survey Scheduled stage.' });
            if (!['Admin/Owner', 'Sales Manager', 'GM/AGM', 'Sales Executive', 'Telecaller'].includes(user.role)) return json(response, 403, { error: 'Your role cannot request a site survey.' });
            const required = ['date', 'time', 'type', 'surveyor', 'address', 'remarks'];
            const missing = required.filter((field) => !String(body[field] || '').trim());
            if (missing.length) return json(response, 422, { error: 'Survey date, time, type, surveyor, address, and remarks are required.', fields: missing });
            const surveyAt = new Date(`${body.date}T${body.time}`);
            if (Number.isNaN(surveyAt.getTime()) || surveyAt <= new Date()) return json(response, 422, { error: 'Survey date and time must be valid and in the future.', fields: ['date', 'time'] });
            if (!isSurveyManager(user) && body.surveyor !== user.id) return json(response, 403, { error: 'Only a manager can assign a different survey executive.' });
            const surveyor = database.prepare("SELECT id, name FROM staff WHERE id = ? AND status = 'Active'").get(isSurveyManager(user) ? body.surveyor : user.id);
            if (!surveyor) return json(response, 422, { error: 'The selected survey engineer is not active or does not exist.', fields: ['surveyor'] });
            if (!canAssignToEmployee(user, surveyor.id)) return json(response, 403, { error: 'You can only assign surveys to employees in your team.' });
            const conflictingSurvey = database.prepare("SELECT id FROM surveys WHERE assigned_to = ? AND survey_date = ? AND status NOT IN ('Cancelled', 'Completed') LIMIT 1").get(surveyor.id, `${body.date}T${body.time}`);
            if (conflictingSurvey) return json(response, 409, { error: 'The selected surveyor already has an active survey at this date and time.', fields: ['date', 'time', 'surveyor'] });
            const existingSurvey = database.prepare('SELECT id FROM surveys WHERE lead_id = ?').get(leadId);
            if (existingSurvey) return json(response, 409, { error: 'This lead already has an active site survey.', surveyId: existingSurvey.id });
            const surveyId = `SUR-${Date.now()}-${Math.floor(Math.random() * 100)}`;
            const taskId = crypto.randomUUID();
            const timestamp = now();
            database.exec('BEGIN');
            try {
                database.prepare('INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, recommended_capacity, remarks, status, survey_type, completion_data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(surveyId, leadId, `${body.date}T${body.time}`, surveyor.id, lead.customer_name, body.address.trim(), 'Pending', '{}', '{}', '', body.remarks.trim(), 'Scheduled', body.type, JSON.stringify({ createdBy: user.id, createdAt: timestamp, updatedAt: timestamp }));
                database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status, task_related_type, task_related_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(taskId, leadId, `${body.date}T${body.time}`, 'Site Visit', surveyor.id, 'Scheduled', body.remarks.trim(), user.id, timestamp, `Site Survey - ${lead.customer_name}`, 'PENDING', 'survey', surveyId);
                audit(user, 'Created', 'survey', surveyId, { date: body.date, time: body.time, engineer: surveyor.name, description: `Site survey scheduled for ${body.date} at ${body.time}.` });
                audit(user, 'Assigned', 'survey', surveyId, { engineer: surveyor.name, description: `Survey assigned to ${surveyor.name}.` });
                audit(user, 'Created', 'follow-up', taskId, { relatedRecordType: 'survey', relatedRecordId: surveyId, description: `Task created for site survey on ${body.date} at ${body.time}.` });
                notify(surveyor.id, 'survey-assigned', `Survey ${surveyId} assigned for lead ${leadId}.`, 'lead', leadId);
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                console.error('Site survey transaction failed.', { errorType: safeErrorType(error) });
                return json(response, 500, { error: 'Unable to schedule site survey. No survey or task was saved.' });
            }
            return json(response, 201, { surveyId, taskId, leadNumber: publicLeadNumber(lead.lead_number), assignedEngineer: surveyor.name, status: 'Scheduled' });
        }
        if (action === 'document') {
            if (!String(body.fileName || '').trim() || !String(body.documentType || '').trim() || !body.fileData) return json(response, 422, { error: 'Document type and file are required.' });
            const documentId = `DOC-${Date.now()}`;
            const stored = saveUploadedFile(body);
            try {
                database.prepare('INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(documentId, leadId, body.documentType, stored.originalFileName, user.id, timestamp, stored.storagePath, stored.originalFileName, stored.mimeType, stored.fileSize, 'UPLOADED');
            } catch (error) { removeStoredFile(stored.storagePath); throw error; }
            audit(user, 'Uploaded', 'document', documentId, { fileName: body.fileName, description: `Document uploaded: ${body.fileName}.` });
            return json(response, 201, { documentId });
        }
        if (action === 'note') {
            if (!String(body.note || '').trim()) return json(response, 422, { error: 'Note text is required.' });
            const noteId = `NOTE-${Date.now()}`;
            database.prepare('INSERT INTO lead_notes (id, lead_id, note, category, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(noteId, leadId, body.note, body.category || 'Internal', user.id, timestamp);
            audit(user, 'Added', 'note', noteId, { description: 'Note added to the lead.' });
            return json(response, 201, { noteId });
        }
        if (action === 'quotation') {
            const values = ['subtotal', 'discount', 'gst'].map((field) => Number(body[field]));
            if (values.some((value) => !Number.isFinite(value) || value < 0)) return json(response, 422, { error: 'Quotation amounts must be valid non-negative numbers.' });
            const [subtotal, discount, gst] = values;
            const total = subtotal - discount + gst;
            if (total < 0) return json(response, 422, { error: 'Quotation total cannot be negative.' });
            const quotationId = `QT-${leadId}-${Date.now()}`;
            database.prepare('INSERT INTO quotations (id, lead_id, proposal_id, subtotal, discount, gst, total, payment_terms, validity, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(quotationId, leadId, body.proposalId || null, subtotal, discount, gst, total, body.paymentTerms || '', body.validity || '', user.id, timestamp);
            audit(user, 'Created', 'quotation', quotationId, { total, description: `Quotation ${quotationId} created.` });
            return json(response, 201, { quotationId, total });
        }
        if (['call', 'whatsapp', 'email'].includes(action)) {
            if (action === 'email' && !lead.email) return json(response, 422, { error: 'No email address is available for this lead.' });
            const communicationId = `COM-${Date.now()}`;
            const status = action === 'email' ? 'Attempted' : 'Initiated';
            database.prepare('INSERT INTO lead_communications (id, lead_id, type, recipient, subject, message, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(communicationId, leadId, action, action === 'email' ? lead.email : lead.mobile_number, body.subject || null, body.message || null, status, user.id, timestamp);
            audit(user, `${action} initiated`, 'communication', communicationId, { leadId, status, description: `${action} communication initiated.` });
            return json(response, 201, { communicationId, status, recipient: action === 'email' ? lead.email : lead.mobile_number });
        }
        return json(response, 422, { error: 'Unsupported lead action.' });
    }
    const convertMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/convert$/);
    if (convertMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(convertMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canEditLead(user, lead)) return json(response, 403, { error: 'You do not have permission to convert this lead.' });
        const survey = database.prepare("SELECT id FROM surveys WHERE lead_id = ? AND status = 'Completed'").get(leadId);
        const proposal = database.prepare("SELECT id FROM proposals WHERE lead_id = ? AND status NOT IN ('Rejected', 'Expired') LIMIT 1").get(leadId);
        const missing = [];
        if (!survey) missing.push('Completed site survey');
        if (!proposal) missing.push('Active proposal');
        if (missing.length) return json(response, 422, { error: 'Lead cannot be converted yet.', missing });
        const timestamp = now();
        database.exec('BEGIN');
        try {
            let opportunity = database.prepare('SELECT * FROM opportunities WHERE lead_id = ?').get(leadId);
            if (!opportunity) {
                const details = lead.details_json ? JSON.parse(lead.details_json) : {};
                const opportunityId = `OPP-${leadId}`;
                database.prepare('INSERT INTO opportunities (id, lead_id, customer_name, system_capacity, estimated_value, assigned_to, expected_close_date, probability, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(opportunityId, leadId, lead.customer_name, details.systemCapacity || details.requiredSolarCapacity || null, Number(details.estimatedValue || 0), lead.assigned_to, details.expectedCloseDate || null, Number(details.probability || 0), 'Won', user.id, timestamp, timestamp);
                opportunity = { id: opportunityId };
            } else database.prepare("UPDATE opportunities SET stage = 'Won', status = 'Active', updated_at = ? WHERE id = ?").run(timestamp, opportunity.id);
            database.prepare("UPDATE leads SET stage = 'Completed', status = 'Converted', updated_at = ? WHERE id = ?").run(timestamp, leadId);
            database.prepare('INSERT INTO lead_stage_history (id, lead_id, stage, started_at, completed_at, completed_by, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), leadId, 'Completed', timestamp, timestamp, user.id, 'Lead converted.');
            audit(user, 'Converted', 'lead', leadId, { opportunityId: opportunity.id, description: 'Lead converted to an opportunity.' });
            database.exec('COMMIT');
            return json(response, 200, { success: true, leadId, opportunityId: opportunity.id, stage: 'Completed', status: 'Converted' });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Lead conversion failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Lead conversion failed. No changes were saved.' });
        }
    }
    const followMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/follow$/);
    if (followMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(followMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to follow this lead.' });
        const existing = database.prepare('SELECT lead_id FROM lead_followers WHERE lead_id = ? AND staff_id = ?').get(leadId, user.id);
        database.exec('BEGIN');
        try {
            if (existing) database.prepare('DELETE FROM lead_followers WHERE lead_id = ? AND staff_id = ?').run(leadId, user.id);
            else database.prepare('INSERT INTO lead_followers (lead_id, staff_id, created_at) VALUES (?, ?, ?)').run(leadId, user.id, now());
            audit(user, existing ? 'Unfollowed' : 'Followed', 'lead', leadId, { description: existing ? 'Lead unfollowed.' : 'Lead followed.' });
            database.exec('COMMIT');
            return json(response, 200, { success: true, followed: !existing });
        } catch (error) {
            database.exec('ROLLBACK');
            return json(response, 500, { error: 'Unable to update lead follow state.' });
        }
    }
    if (leadMatch && request.method === 'PATCH') {
        const leadId = decodeURIComponent(leadMatch[1]);
        const lead = await repository.get('SELECT * FROM leads WHERE id = ?', [leadId]);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        const body = await parseBody(request);
        const match = rejectOwnerChangeAttempt(user, lead, body);
        if (match) return json(response, match.status, { error: match.error });
        if (!canEditLead(user, lead)) return json(response, 403, { error: 'You are not the owner of this lead.' });
        const result = await leadService.update(user, lead, body, { now });
        if (result.code === 'DUPLICATE_MOBILE' && result.existingLead) {
            recordDuplicateLeadAttempt(user, result.existingLead, body.mobileNumber || body.mobile_number || lead.mobile_number, 'update');
            return json(response, 409, { error: 'DUPLICATE_MOBILE', message: result.message, existingLead: duplicateLeadDetails(user, result.existingLead) });
        }
        if (result.error) return json(response, result.status, { error: result.error, ...(result.fields ? { fields: result.fields } : {}), ...(result.existingLeadId ? { existingLeadId: result.existingLeadId } : {}) });
        return json(response, result.status, { lead: result.lead });
    }

    const assignMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/assignment$/);
    if (assignMatch && request.method === 'POST') {
        if (!canAssignLead(user)) return json(response, 403, { error: 'Only administrators can change the lead owner.' });
        let leadId;
        try {
            leadId = decodeURIComponent(assignMatch[1]).trim();
        } catch (error) {
            return json(response, 400, { error: 'Invalid lead identifier.' });
        }
        if (!leadId) return json(response, 400, { error: 'A lead identifier is required.' });
        const lead = await repository.get('SELECT * FROM leads WHERE id = ?', [leadId]);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        let body;
        try {
            body = await parseBody(request);
        } catch (error) {
            return json(response, 400, { error: 'Invalid assignment request body.' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return json(response, 422, { error: 'Assignment request must be a JSON object.' });
        }
        const assignedTo = typeof body.assignedTo === 'string' ? body.assignedTo.trim() : '';
        if (!assignedTo || assignedTo.length > 128) return json(response, 422, { error: 'Please select an active employee using their staff ID.' });
        const eligibleRoles = ['Sales Executive', 'Sales Manager', 'GM/AGM', 'Telecaller'];
        const employee = await repository.get(
            `SELECT id, name FROM staff WHERE id = ? AND status = 'Active' AND account_status = 'ACTIVE' AND role IN (${eligibleRoles.map(() => '?').join(', ')})`,
            [assignedTo, ...eligibleRoles]
        );
        if (!employee) return json(response, 422, { error: 'Select an active assigned employee.' });
        if (employee.id === lead.assigned_to) {
            const currentLead = await leadService.get(user, lead.id);
            if (!currentLead || currentLead.forbidden || currentLead.assignedTo !== employee.id) {
                return json(response, 500, { error: 'Unable to verify the current lead assignment.' });
            }
            return json(response, 200, { lead: currentLead, unchanged: true });
        }
        const previousOwner = lead.assigned_to ? (await repository.get('SELECT name FROM staff WHERE id = ?', [lead.assigned_to]))?.name : 'Unassigned';
        const result = await leadService.assign(user, lead, employee, previousOwner, { now, randomUUID: crypto.randomUUID.bind(crypto) });
        if (result.error) return json(response, result.status, { error: result.error });
        if (!result.lead || result.lead.assignedTo !== employee.id) {
            return json(response, 500, { error: 'Assignment could not be verified after saving.' });
        }
        return json(response, result.status, { lead: result.lead, ...(result.unchanged ? { unchanged: true } : {}) });
    }

    const followUpMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/follow-ups$/);
    if (followUpMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(followUpMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (!canAddFollowUp(user, lead)) return json(response, 403, { error: 'Only the assigned lead owner, assignee, or manager can create a task for this lead.' });
        const body = await parseBody(request);
        const missing = ['taskTitle', 'date', 'time', 'type'].filter((field) => !String(body[field] || '').trim());
        if (missing.length) return json(response, 422, { error: missing.includes('taskTitle') ? 'Task headline is required.' : 'Follow-up date, time, and type are required.', fields: missing });
        if (!FOLLOW_UP_TYPES.includes(body.type)) return json(response, 422, { error: 'Invalid follow-up type.' });
        const taskOwnerId = isAdminUser(user) ? (body.assignedTo || lead.assigned_to || user.id) : user.id;
        if (!taskOwnerId) return json(response, 422, { error: 'Lead owner is unavailable.' });
        if (!isAdminUser(user) && taskOwnerId !== user.id) return json(response, 403, { error: 'Only the assigned lead owner can create a task for this lead.' });
        const id = crypto.randomUUID();
        database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, leadId, `${body.date}T${body.time}`, body.type, taskOwnerId, 'Scheduled', body.notes || null, user.id, now(), String(body.taskTitle).trim(), 'PENDING');
        audit(user, 'Created', 'follow-up', id, { leadId, description: `Follow-up scheduled for ${body.date} at ${body.time}.` });
        notify(taskOwnerId, 'follow-up-due', `Follow-up scheduled for lead ${leadId}.`, 'lead', leadId);
        return json(response, 201, { id });
    }

    const completeFollowUpMatch = url.pathname.match(/^\/api\/follow-ups\/([^/]+)\/complete$/);
    if (completeFollowUpMatch && request.method === 'POST') {
        const followUpId = decodeURIComponent(completeFollowUpMatch[1]);
        const followUp = database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(followUpId);
        const lead = followUp && database.prepare('SELECT * FROM leads WHERE id = ?').get(followUp.lead_id);
        if (!followUp || !lead) return json(response, 404, { error: 'Follow-up not found.' });
        if (!canAddFollowUp(user, lead, followUp)) return json(response, 403, { error: 'Only the assigned lead owner or assignee can complete this follow-up.' });
        const body = await parseBody(request);
        if (followUp.status === 'Completed' || followUp.status === 'Cancelled' || followUp.task_status === 'COMPLETED' || followUp.task_status === 'CANCELLED') return json(response, 409, { error: 'This follow-up is already completed or cancelled.' });
        const remarks = String(body.remarks || body.notes || '').trim();
        const nextAction = String(body.nextAction || '').trim();
        if (!remarks && !nextAction) return json(response, 422, { error: 'Remarks and next action are required to complete a follow-up.', fields: ['remarks', 'nextAction'] });
        const timestamp = now();
        const completionNotes = remarks ? `${remarks}${nextAction ? ` | Next action: ${nextAction}` : ''}` : (nextAction ? `Next action: ${nextAction}` : '');
        database.prepare('UPDATE follow_ups SET status = ?, task_status = ?, notes = ?, outcome = ?, completed_at = ?, completed_by = ?, task_completed_at = ?, task_completed_by = ? WHERE id = ?').run('Completed', 'COMPLETED', completionNotes, body.outcome || body.customerResponse || null, timestamp, user.id, timestamp, user.id, followUpId);
        audit(user, 'Completed', 'follow-up', followUpId, { status: 'Completed', remarks, nextAction, description: `Follow-up completed. Outcome: ${body.outcome || body.customerResponse || 'Recorded'}.` });
        return json(response, 200, { status: 'Completed', completedAt: timestamp });
    }

    const rescheduleFollowUpMatch = url.pathname.match(/^\/api\/follow-ups\/([^/]+)\/reschedule$/);
    if (rescheduleFollowUpMatch && request.method === 'POST') {
        const followUpId = decodeURIComponent(rescheduleFollowUpMatch[1]);
        const followUp = database.prepare('SELECT f.*, l.customer_name, l.lead_number FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = ?').get(followUpId);
        const lead = followUp && database.prepare('SELECT * FROM leads WHERE id = ?').get(followUp.lead_id);
        if (!followUp || !lead || !canAddFollowUp(user, lead, followUp)) return json(response, 403, { error: 'Only the assigned employee or a manager can reschedule this follow-up.' });
        const body = await parseBody(request);
        const nextDate = String(body.date || body.nextDate || '').trim();
        const nextTime = String(body.time || body.nextTime || '').trim();
        const followUpType = String(body.type || followUp.type || '').trim();
        const reason = String(body.note || body.reason || '').trim();
        if (!nextDate || !nextTime) return json(response, 422, { error: 'New date and time are required.' });
        if (!followUpType || !FOLLOW_UP_TYPES.includes(followUpType)) return json(response, 422, { error: 'Invalid follow-up type.' });
        const nextDueAt = `${nextDate}T${nextTime}`;
        const dateCheck = new Date(nextDueAt);
        if (Number.isNaN(dateCheck.getTime())) return json(response, 422, { error: 'Please enter a valid follow-up date and time.' });
        const timestamp = now();
        database.exec('BEGIN');
        try {
            database.prepare("UPDATE follow_ups SET status = 'Rescheduled', task_status = 'RESCHEDULED', notes = CASE WHEN ? <> '' THEN ? ELSE notes END WHERE id = ?").run(reason, reason, followUpId);
            const nextTaskId = crypto.randomUUID();
            database.prepare('INSERT INTO follow_ups (id, lead_id, due_at, type, assigned_to, status, notes, created_by, created_at, task_title, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(nextTaskId, followUp.lead_id, nextDueAt, followUpType, followUp.assigned_to, 'Scheduled', reason, user.id, timestamp, taskTitle(followUpType), 'PENDING');
            audit(user, 'Rescheduled', 'follow-up', followUpId, { previousDueAt: followUp.due_at, nextDueAt, reason, newFollowUpId: nextTaskId, customer: followUp.customer_name, opportunityNumber: followUp.lead_number, description: 'Follow-up rescheduled.' });
            database.exec('COMMIT');
            return json(response, 200, { status: 'Rescheduled', nextTaskId, nextDueAt });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Follow-up reschedule failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to reschedule follow-up. No changes were saved.' });
        }
    }

    const cancelFollowUpMatch = url.pathname.match(/^\/api\/follow-ups\/([^/]+)\/cancel$/);
    if (cancelFollowUpMatch && request.method === 'POST') {
        const followUpId = decodeURIComponent(cancelFollowUpMatch[1]);
        const followUp = database.prepare('SELECT f.*, l.customer_name, l.lead_number FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = ?').get(followUpId);
        const lead = followUp && database.prepare('SELECT * FROM leads WHERE id = ?').get(followUp.lead_id);
        if (!followUp || !lead || !canAddFollowUp(user, lead, followUp)) return json(response, 403, { error: 'Only the assigned employee or a manager can cancel this follow-up.' });
        if (followUp.status === 'Completed' || followUp.status === 'Cancelled' || followUp.task_status === 'COMPLETED' || followUp.task_status === 'CANCELLED') return json(response, 409, { error: 'This follow-up is already completed or cancelled.' });
        const body = await parseBody(request);
        const reason = String(body.note || body.reason || 'Cancelled by user').trim();
        const timestamp = now();
        database.prepare("UPDATE follow_ups SET status = 'Cancelled', task_status = 'CANCELLED', notes = CASE WHEN ? <> '' THEN ? ELSE notes END, completed_at = COALESCE(completed_at, ?), completed_by = COALESCE(completed_by, ?) WHERE id = ?").run(reason, reason, timestamp, user.id, followUpId);
        audit(user, 'Cancelled', 'follow-up', followUpId, { status: 'Cancelled', reason, description: 'Follow-up cancelled.' });
        return json(response, 200, { status: 'Cancelled', cancelledAt: timestamp });
    }

    const surveyMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/survey$/);
    if (surveyMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(surveyMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this survey.' });
        const body = await parseBody(request);
        if (!['Site Survey Scheduled', 'Opportunity'].includes(lead.stage)) return json(response, 422, { error: 'Survey updates are only allowed for an active survey workflow.' });
        if (body.status === 'Completed' && lead.stage !== 'Site Survey Scheduled') return json(response, 422, { error: 'Schedule the survey before completing it.' });
        const existingSurvey = database.prepare('SELECT * FROM surveys WHERE lead_id = ?').get(leadId);
        const assignedTo = String(body.assignedTo || existingSurvey?.assigned_to || lead.assigned_to || user.id).trim();
        if (body.assignedTo && String(body.assignedTo) !== String(existingSurvey?.assigned_to || '') && !canAssignToEmployee(user, assignedTo)) return json(response, 403, { error: 'You can only assign surveys to employees in your team.' });
        const assignedEmployee = database.prepare("SELECT id FROM staff WHERE id = ? AND status = 'Active'").get(assignedTo);
        if (!assignedEmployee) return json(response, 422, { error: 'Select an active survey executive.', fields: ['assignedTo'] });
        let leadDetails = {};
        try { leadDetails = lead.details_json ? JSON.parse(lead.details_json) : {}; } catch (error) { leadDetails = {}; }
        const inherited = { customer: lead.customer_name, address: leadDetails.address || lead.location, ...existingSurvey };
        const surveyData = { ...inherited, ...body, assignedTo };
        const required = ['customer', 'address', 'surveyDate', 'sanctionedLoad', 'electricityDetails', 'roofInformation', 'recommendedCapacity', 'remarks'];
        const missing = required.filter((field) => !String(surveyData[field] || '').trim() || surveyData[field] === 'Pending');
        if (body.status === 'Completed' && missing.length) return json(response, 422, { error: 'Survey cannot be completed until required information is provided.', fields: missing });
        if (body.feasibility === 'Site Not Feasible' && !String(body.remarks || '').trim()) return json(response, 422, { error: 'A reason is required when the site is not feasible.', fields: ['remarks'] });
        const status = body.status === 'Completed' ? 'Completed' : 'Scheduled';
        const existing = existingSurvey?.id;
        if (existing) database.prepare(`UPDATE surveys SET survey_date = ?, assigned_to = ?, customer = ?, address = ?, sanctioned_load = ?, electricity_details = ?, roof_information = ?, feasibility = ?, recommended_capacity = ?, remarks = ?, status = ?, completed_at = ? WHERE lead_id = ?`).run(surveyData.surveyDate, surveyData.assignedTo, surveyData.customer, surveyData.address, surveyData.sanctionedLoad, surveyData.electricityDetails, surveyData.roofInformation, surveyData.feasibility || null, surveyData.recommendedCapacity, surveyData.remarks, status, status === 'Completed' ? now() : null, leadId);
        else database.prepare(`INSERT INTO surveys (id, lead_id, survey_date, assigned_to, customer, address, sanctioned_load, electricity_details, roof_information, feasibility, recommended_capacity, remarks, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), leadId, surveyData.surveyDate, surveyData.assignedTo, surveyData.customer, surveyData.address, surveyData.sanctionedLoad, surveyData.electricityDetails, surveyData.roofInformation, surveyData.feasibility || null, surveyData.recommendedCapacity, surveyData.remarks, status);
        const nextStage = status === 'Completed' ? 'Survey Completed' : lead.stage;
        if (status === 'Completed') database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(nextStage, now(), leadId);
        const surveyRecord = database.prepare('SELECT id FROM surveys WHERE lead_id = ?').get(leadId);
        audit(user, status === 'Completed' ? 'Completed' : 'Updated', 'survey', surveyRecord?.id, { stage: nextStage, description: status === 'Completed' ? 'Site survey completed.' : 'Site survey updated.' });
        notify(body.assignedTo, 'survey-assigned', `Site survey ${status.toLowerCase()} for lead ${leadId}.`, 'lead', leadId);
        return json(response, 200, { stage: nextStage });
    }

    if (url.pathname === '/api/equipment-catalogue' && request.method === 'GET') {
        const admin = isAdminUser(user);
        const rows = database.prepare(`SELECT * FROM equipment_catalogue
            ORDER BY category, brand, series, model`).all();
        const products = rows.map((row) => {
            const product = {
                id: row.id,
                category: row.category,
                brand: row.brand,
                manufacturer: row.manufacturer,
                series: row.series,
                model: row.model,
                ratedWattage: row.rated_wattage,
                minimumWattage: row.minimum_wattage,
                maximumWattage: row.maximum_wattage,
                ratedCapacityKw: row.rated_capacity_kw,
                inverterType: row.inverter_type,
                phase: row.phase,
                sourceUrl: row.source_url,
                datasheetUrl: row.datasheet_url,
                verificationDate: row.verification_date,
                marketApplicability: row.market_applicability,
                verificationStatus: row.verification_status,
                status: row.status,
                notes: row.notes
            };
            return { ...product, selectable: isSelectableCatalogueEntry(product) };
        });
        return json(response, 200, { products, canManage: admin });
    }

    if (url.pathname === '/api/equipment-catalogue' && request.method === 'POST') {
        if (!isAdminUser(user)) return json(response, 403, { error: 'Only Admin/Owner users can add equipment catalogue products.' });
        let product;
        try {
            product = normalizeEquipmentCatalogueEntry(await parseBody(request));
            if (product.verificationStatus !== 'Verified' || !isSelectableCatalogueEntry({ ...product, status: 'Active' })) {
                return json(response, 422, { error: 'A new catalogue product must have a verified, exact rating, type and phase before it can be added.' });
            }
        } catch (error) {
            return json(response, 422, { error: error.message || 'Equipment catalogue product is invalid.' });
        }
        const catalogueKey = crypto.createHash('sha256')
            .update(`${product.category}\u0000${product.brand.toLowerCase()}\u0000${product.model.toLowerCase()}\u0000${product.phase.toLowerCase()}`)
            .digest('hex');
        if (database.prepare('SELECT id FROM equipment_catalogue WHERE catalogue_key = ?').get(catalogueKey)) {
            return json(response, 409, { error: 'This manufacturer model and phase are already in the equipment catalogue. Existing records were not changed.' });
        }
        const id = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        database.prepare(`INSERT INTO equipment_catalogue (
            id, catalogue_key, category, brand, manufacturer, series, model,
            rated_wattage, minimum_wattage, maximum_wattage, rated_capacity_kw, inverter_type, phase,
            source_url, datasheet_url, verification_date, market_applicability, verification_status,
            status, notes, created_by, created_at, updated_at
        ) VALUES (${Array(23).fill('?').join(', ')})`).run(
            id, catalogueKey, product.category, product.brand, product.manufacturer, product.series, product.model,
            product.ratedWattage, product.minimumWattage, product.maximumWattage, product.ratedCapacityKw,
            product.inverterType, product.phase, product.sourceUrl, product.datasheetUrl, product.verificationDate,
            product.marketApplicability, product.verificationStatus, product.status, product.notes, user.id, timestamp, timestamp
        );
        audit(user, 'Added', 'equipment_catalogue', id, { category: product.category, brand: product.brand, model: product.model });
        return json(response, 201, { product: { id, ...product, selectable: true } });
    }

    const catalogueProductMatch = url.pathname.match(/^\/api\/equipment-catalogue\/([^/]+)$/);
    if (catalogueProductMatch && request.method === 'PATCH') {
        if (!isAdminUser(user)) return json(response, 403, { error: 'Only Admin/Owner users can manage equipment catalogue products.' });
        const id = decodeURIComponent(catalogueProductMatch[1]);
        const existing = database.prepare('SELECT * FROM equipment_catalogue WHERE id = ?').get(id);
        if (!existing) return json(response, 404, { error: 'Equipment catalogue product not found.' });
        const body = await parseBody(request);
        const status = body.status === undefined ? existing.status : String(body.status).trim();
        const verificationStatus = body.verificationStatus === undefined ? existing.verification_status : String(body.verificationStatus).trim();
        const marketApplicability = body.marketApplicability === undefined
            ? existing.market_applicability
            : String(body.marketApplicability).trim();
        if (!['Active', 'Inactive'].includes(status)) return json(response, 422, { error: 'Catalogue status must be Active or Inactive.' });
        if (!['Verified', 'Needs verification'].includes(verificationStatus)) {
            return json(response, 422, { error: 'Verification status must be Verified or Needs verification.' });
        }
        if (!marketApplicability || marketApplicability.length > 240) {
            return json(response, 422, { error: 'Market applicability is required and must be 240 characters or fewer.' });
        }
        const product = {
            category: existing.category,
            ratedWattage: existing.rated_wattage,
            ratedCapacityKw: existing.rated_capacity_kw,
            inverterType: existing.inverter_type,
            phase: existing.phase,
            status,
            verificationStatus
        };
        if (status === 'Active' && !isSelectableCatalogueEntry(product)) {
            return json(response, 422, { error: 'A product can only be active for proposals when its exact rating, type, phase and verification are complete.' });
        }
        const timestamp = new Date().toISOString();
        database.prepare(`UPDATE equipment_catalogue
            SET status = ?, verification_status = ?, market_applicability = ?, updated_at = ?
            WHERE id = ?`).run(status, verificationStatus, marketApplicability, timestamp, id);
        audit(user, status === 'Active' ? 'Activated' : 'Deactivated', 'equipment_catalogue', id, {
            verificationStatus,
            marketApplicability
        });
        return json(response, 200, { success: true, id, status, verificationStatus, marketApplicability });
    }

    if (request.method === 'GET' && url.pathname === '/api/proposals/pricing') {
        const capacity = Number(url.searchParams.get('capacity') || 0);
        const systemType = url.searchParams.get('systemType') || 'On-Grid';
        const subsidyEligibilityVerified = url.searchParams.get('subsidyEligibilityVerified') === 'true';
        const pricing = proposalPricing(capacity, {
            systemType,
            pricingType: url.searchParams.get('pricingType') || 'Non-Subsidy',
            panelCount: Number(url.searchParams.get('panelCount') || 0),
            inverterPhase: url.searchParams.get('inverterPhase') || '',
            extraBattery: url.searchParams.get('extraBattery') === 'true',
            subsidy: systemType === 'On-Grid' && subsidyEligibilityVerified ? PM_SURYA_GHAR_SUBSIDY : 0,
            basePriceOverride: url.searchParams.has('basePriceOverride') ? Number(url.searchParams.get('basePriceOverride')) : undefined
        });
        if (!pricing) return json(response, 422, { error: 'No configured pricing is available for this system capacity or GST rate.' });
        return json(response, 200, { pricing });
    }

    if (request.method === 'GET' && url.pathname === '/api/proposals') {
        const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const status = String(url.searchParams.get('status') || '').trim();
        const closedProposalStatuses = new Set(['accepted', 'rejected', 'expired', 'closed', 'won']);
        const owner = String(url.searchParams.get('owner') || '').trim();
        const from = String(url.searchParams.get('from') || '').trim();
        const to = String(url.searchParams.get('to') || '').trim();
        const rows = database.prepare(`SELECT p.*, l.lead_number, l.assigned_to, s.name AS lead_owner_name, c.name AS created_by_name
            FROM proposal_records p JOIN leads l ON l.id = p.lead_id LEFT JOIN staff s ON s.id = l.assigned_to
            LEFT JOIN staff c ON c.id = p.created_by ORDER BY datetime(p.created_at) DESC`).all()
            .filter((row) => canAccess(user, row))
            .filter((row) => !query || [row.proposal_number, row.customer_name, row.lead_number, row.email].some((value) => String(value || '').toLowerCase().includes(query)))
            .filter((row) => !status || (String(status).toLowerCase() === 'pending' ? !closedProposalStatuses.has(String(row.status || '').toLowerCase()) : row.status === status))
            .filter((row) => !owner || row.assigned_to === owner)
            .filter((row) => !from || String(row.proposal_date) >= from)
            .filter((row) => !to || String(row.proposal_date) <= to)
            .map((row) => ({ ...proposalView(row), leadNumber: publicLeadNumber(row.lead_number), leadOwnerName: row.lead_owner_name, createdByName: row.created_by_name }));
        return json(response, 200, { proposals: rows, statuses: ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired'] });
    }

    const proposalRecordMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)$/);
    const proposalPdfMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/pdf$/);
    const proposalSendMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/send$/);
    const proposalDuplicateMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/duplicate$/);
    if (proposalPdfMatch && request.method === 'POST') {
        const proposal = database.prepare('SELECT p.*, l.lead_number, l.details_json AS lead_details_json, l.assigned_to, s.name AS lead_owner_name FROM proposal_records p JOIN leads l ON l.id = p.lead_id LEFT JOIN staff s ON s.id = l.assigned_to WHERE p.id = ?').get(decodeURIComponent(proposalPdfMatch[1]));
        if (!proposal || !canAccess(user, proposal)) return json(response, 404, { error: 'Proposal not found.' });
        const leadNumber = String(publicLeadNumber(proposal.lead_number)).replace(/[^A-Za-z0-9-]/g, '_');
        const filename = `Proposal_${leadNumber}_${proposal.proposal_number}.pdf`;
        const existingFile = database.prepare("SELECT id, storage_path AS storagePath FROM lead_documents WHERE proposal_record_id = ? AND status = 'UPLOADED'").get(proposal.id);
        const existingPath = existingFile?.storagePath ? path.join(FILE_STORAGE_ROOT, path.basename(existingFile.storagePath)) : '';
        if (existingFile && existingPath && fs.existsSync(existingPath)) {
            const storedBuffer = fs.readFileSync(existingPath);
            if (storedBuffer.length > 100 && storedBuffer.subarray(0, 4).toString() === '%PDF' && storedBuffer.subarray(-16).includes(Buffer.from('%%EOF'))) {
                return sendProposalPdf(response, storedBuffer, filename, existingFile.id);
            }
        }

        let pricing = {};
        try { pricing = JSON.parse(proposal.pricing_json || '{}'); } catch (error) { pricing = {}; }
        let leadDetails = {};
        try { leadDetails = JSON.parse(proposal.lead_details_json || '{}'); } catch (error) { leadDetails = {}; }
        try {
            const pdfBase64 = await generateProposalPDF({
                customerName: proposal.customer_name, contactNumber: proposal.contact_number, customerEmail: proposal.email,
                address: proposal.address, pincode: proposal.pincode, systemCapacity: proposal.system_capacity,
                inverterCapacity: proposal.inverter_capacity, panelBrand: proposal.panel_brand, panelWattage: proposal.panel_wattage,
                panelCount: proposal.panel_count, inverterBrand: proposal.inverter_brand, structureType: proposal.structure_type,
                systemType: proposal.system_type, proposalDate: proposal.proposal_date, proposalReference: proposal.proposal_number,
                proposalNumber: proposal.proposal_number, leadNumber: publicLeadNumber(proposal.lead_number),
                versionNumber: proposal.version_number, validityDays: Number(pricing.validityDays || 0),
                batteryRequired: Boolean(proposal.battery_required), netMetering: Boolean(proposal.net_metering),
                subsidyEligibilityVerified: Boolean(proposal.subsidy_eligibility_verified) || pricing.subsidyEligibilityVerified === true,
                subsidyAmount: proposal.subsidy,
                paymentTerms: proposal.payment_terms, customPaymentTerms: proposal.custom_payment_terms,
                bookingAmount: proposal.booking_amount, paymentSchedule: proposalView(proposal).paymentSchedule,
                generationEstimate: proposal.generation_estimate,
                monthlySavings: proposal.monthly_savings, annualSavings: proposal.annual_savings,
                warranty: proposal.warranty, scopeOfWork: proposal.scope_of_work, termsConditions: proposal.terms_conditions,
                omDuration: pricing.omDuration, discomWork: pricing.discomWork,
                addons: Array.isArray(pricing.addons) ? pricing.addons : [],
                pricing: {
                    ...pricing,
                    systemType: proposal.system_type,
                    calculatedTotal: proposal.gross_amount,
                    grossAmount: proposal.gross_amount,
                    finalAmount: proposal.final_amount,
                    discount: proposal.discount,
                    subsidyAmount: proposal.subsidy,
                    netInvestment: proposal.net_investment,
                    pricingType: pricing.pricingType || (proposal.subsidy > 0 ? 'Subsidy' : 'Non-Subsidy'),
                    baseAmount: proposal.subtotal,
                    gstAmount: proposal.gst
                },
                batteryCapacity: proposal.battery_capacity, city: pricing.city || leadDetails.city,
                componentConfiguration: Array.isArray(pricing.componentConfiguration) ? pricing.componentConfiguration : []
            });
            const buffer = Buffer.from(pdfBase64, 'base64');
            if (buffer.length < 100 || buffer.subarray(0, 4).toString() !== '%PDF') throw new Error('Generated proposal PDF is invalid.');

            const storagePath = `${crypto.randomUUID()}.pdf`;
            fs.writeFileSync(path.join(FILE_STORAGE_ROOT, storagePath), buffer, { flag: 'wx' });
            const fileId = existingFile?.id || crypto.randomUUID();
            try {
                if (existingFile) {
                    database.prepare("UPDATE lead_documents SET storage_path = ?, original_file_name = ?, file_name = ?, mime_type = 'application/pdf', file_size = ?, uploaded_by = ?, created_at = ?, status = 'UPLOADED' WHERE id = ?").run(storagePath, filename, filename, buffer.length, user.id, now(), existingFile.id);
                } else {
                    database.prepare("INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status, proposal_record_id) VALUES (?, ?, 'Proposal', ?, ?, ?, ?, ?, 'application/pdf', ?, 'UPLOADED', ?)").run(fileId, proposal.lead_id, filename, user.id, now(), storagePath, filename, buffer.length, proposal.id);
                }
            } catch (error) {
                removeStoredFile(storagePath);
                throw error;
            }
            audit(user, 'Generated', 'proposal-record', proposal.id, { leadId: proposal.lead_id, proposalNumber: proposal.proposal_number, fileName: filename });
            return sendProposalPdf(response, buffer, filename, fileId);
        } catch (error) {
            console.error('Proposal PDF generation failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Failed to generate and save the proposal PDF. Please try again.' });
        }
    }
    if (proposalSendMatch && request.method === 'POST') {
        const proposal = database.prepare('SELECT p.*, l.lead_number, l.details_json AS lead_details_json, l.assigned_to FROM proposal_records p JOIN leads l ON l.id = p.lead_id WHERE p.id = ?').get(decodeURIComponent(proposalSendMatch[1]));
        if (!proposal || !canAccess(user, proposal)) return json(response, 404, { error: 'Proposal not found.' });
        if (!proposal.email) return json(response, 422, { error: 'This proposal has no customer email address.' });
        const savedPricing = proposalView(proposal).pricing;
        let leadDetails = {};
        try { leadDetails = JSON.parse(proposal.lead_details_json || '{}'); } catch (error) { leadDetails = {}; }
        const pdfBase64 = await generateProposalPDF({
            customerName: proposal.customer_name,
            contactNumber: proposal.contact_number,
            address: proposal.address,
            pincode: proposal.pincode,
            systemCapacity: proposal.system_capacity,
            inverterCapacity: proposal.inverter_capacity,
            structureType: proposal.structure_type,
            systemType: proposal.system_type,
            proposalDate: proposal.proposal_date,
            proposalReference: proposal.proposal_number,
            proposalNumber: proposal.proposal_number,
            leadNumber: publicLeadNumber(proposal.lead_number),
            versionNumber: proposal.version_number,
            validityDays: Number(savedPricing.validityDays || 0),
            batteryRequired: Boolean(proposal.battery_required),
            batteryCapacity: proposal.battery_capacity,
            netMetering: Boolean(proposal.net_metering),
            subsidyEligibilityVerified: Boolean(proposal.subsidy_eligibility_verified) || savedPricing.subsidyEligibilityVerified === true,
            subsidyAmount: proposal.subsidy,
            paymentTerms: proposal.payment_terms,
            customPaymentTerms: proposal.custom_payment_terms,
            paymentSchedule: proposalView(proposal).paymentSchedule,
            omDuration: savedPricing.omDuration,
            discomWork: savedPricing.discomWork,
            addons: Array.isArray(savedPricing.addons) ? savedPricing.addons : [],
            city: savedPricing.city || leadDetails.city,
            inverterPhase: savedPricing.inverterPhase,
            pricing: {
                ...savedPricing,
                systemType: proposal.system_type,
                calculatedTotal: proposal.gross_amount,
                baseAmount: proposal.subtotal,
                gstAmount: proposal.gst,
                discount: proposal.discount,
                finalAmount: proposal.final_amount,
                subsidyAmount: proposal.subsidy,
                netInvestment: proposal.net_investment
            },
            componentConfiguration: Array.isArray(savedPricing.componentConfiguration) ? savedPricing.componentConfiguration : []
        });
        const sent = await sendEmail({ to: proposal.email, subject: `Solar Proposal ${proposal.proposal_number}`, text: `Dear ${proposal.customer_name},\n\nPlease find your Inpace Power solar proposal ${proposal.proposal_number} attached.\n\nRegards,\nInpace Power`, attachments: [{ filename: `${proposal.proposal_number}.pdf`, content: Buffer.from(pdfBase64, 'base64') }] });
        if (!sent) return json(response, 503, { error: 'Email delivery is not configured. Configure EMAIL_HOST, EMAIL_USER and EMAIL_PASSWORD to send proposals.' });
        const timestamp = now();
        database.prepare("UPDATE proposal_records SET status = 'Sent', updated_at = ? WHERE id = ?").run(timestamp, proposal.id);
        database.prepare('INSERT INTO lead_communications (id, lead_id, type, recipient, subject, message, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), proposal.lead_id, 'email', proposal.email, `Solar Proposal ${proposal.proposal_number}`, 'Proposal sent from CRM.', 'Completed', user.id, timestamp);
        audit(user, 'Sent', 'proposal-record', proposal.id, { proposalNumber: proposal.proposal_number });
        return json(response, 200, { sent: true, status: 'Sent' });
    }
    if (proposalDuplicateMatch && request.method === 'POST') {
        const original = database.prepare('SELECT p.*, l.assigned_to FROM proposal_records p JOIN leads l ON l.id = p.lead_id WHERE p.id = ?').get(decodeURIComponent(proposalDuplicateMatch[1]));
        if (!original || !canAccess(user, original)) return json(response, 404, { error: 'Proposal not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(original.lead_id);
        if (!lead || !canAccess(user, lead)) return json(response, 404, { error: 'Proposal not found.' });
        const timestamp = now(); const year = new Date().getFullYear();
        const last = database.prepare("SELECT proposal_number FROM proposal_records WHERE proposal_number LIKE ? ORDER BY proposal_number DESC LIMIT 1").get(`IP-${year}-%`);
        const nextNumber = `IP-${year}-${String((last ? Number(String(last.proposal_number).slice(-5)) : 0) + 1).padStart(5, '0')}`;
        const parentProposalId = original.parent_proposal_id || original.id;
        const version = database.prepare('SELECT MAX(version_number) AS maximum FROM proposal_records WHERE id = ? OR parent_proposal_id = ?').get(parentProposalId, parentProposalId);
        const versionNumber = Number(version?.maximum || 1) + 1;
        const originalView = proposalView(original);
        const pricingType = original.system_type === 'Hybrid'
            ? (Number(originalView.pricing.hybridSubsidyCharge || 0) > 0 ? 'Subsidy' : 'Non-Subsidy')
            : (originalView.subsidyEligibilityVerified ? 'Subsidy' : 'Non-Subsidy');
        const copy = { ...originalView, proposalDate: timestamp.slice(0, 10), pricingType, paymentSchedule: originalView.paymentSchedule.length ? originalView.paymentSchedule : undefined, status: 'Draft' };
        const data = buildProposalPayload(copy, lead, copy);
        if (data.subsidyEligibilityError) return json(response, 422, { error: data.subsidyEligibilityError });
        if (data.paymentScheduleError) return json(response, 422, { error: data.paymentScheduleError });
        if (data.componentConfigurationError) return json(response, 422, { error: data.componentConfigurationError });
        if (data.projectMetricsError) return json(response, 422, { error: data.projectMetricsError });
        if (!data.pricing) return json(response, 422, { error: 'No configured pricing is available for this system capacity or GST rate.' });
        const id = crypto.randomUUID();
        database.prepare(`INSERT INTO proposal_records (id, proposal_number, lead_id, customer_name, contact_number, email, address, pincode, proposal_date, system_type, system_capacity, panel_brand, panel_wattage, panel_count, inverter_brand, inverter_capacity, structure_type, battery_required, battery_capacity, net_metering, solar_panels, inverter, structure, acdb_dcdb, earthing, cables, installation, other_charges, subtotal, gst, gross_amount, discount, final_amount, subsidy, net_investment, booking_amount, payment_terms, custom_payment_terms, lead_owner, pricing_json, generation_estimate, monthly_savings, annual_savings, warranty, scope_of_work, terms_conditions, status, created_by, created_at, updated_at, parent_proposal_id, version_number, payment_schedule_json, subsidy_eligibility_verified) VALUES (${Array(54).fill('?').join(', ')})`).run(id, nextNumber, original.lead_id, data.customerName, data.contactNumber, data.email, data.address, data.pincode, data.proposalDate, data.systemType, data.systemCapacity, data.panelBrand, data.panelWattage, data.panelCount, data.inverterBrand, data.inverterCapacity, data.structureType, data.batteryRequired, data.batteryCapacity, data.netMetering, data.pricing.solarPanels, data.pricing.inverter, data.pricing.structure, data.pricing.acdbDcdb, data.pricing.earthing, data.pricing.cables, data.pricing.installation, data.pricing.otherCharges, data.pricing.subtotal, data.pricing.gst, data.pricing.grossAmount, data.pricing.discount, data.pricing.finalAmount, data.pricing.subsidy, data.pricing.netInvestment, data.bookingAmount, data.paymentTerms, data.customPaymentTerms, data.leadOwner || '', JSON.stringify(data.pricing), data.generationEstimate, data.monthlySavings, data.annualSavings, data.warranty, data.scopeOfWork, data.termsConditions, 'Draft', user.id, timestamp, timestamp, parentProposalId, versionNumber, JSON.stringify(data.paymentSchedule), data.subsidyEligibilityVerified === null ? null : Number(data.subsidyEligibilityVerified));
        return json(response, 201, { proposal: proposalView(database.prepare('SELECT * FROM proposal_records WHERE id = ?').get(id)) });
    }
    if (proposalRecordMatch && request.method === 'GET') {
        const proposal = database.prepare('SELECT p.*, l.lead_number, l.assigned_to, s.name AS lead_owner_name, c.name AS created_by_name FROM proposal_records p JOIN leads l ON l.id = p.lead_id LEFT JOIN staff s ON s.id = l.assigned_to LEFT JOIN staff c ON c.id = p.created_by WHERE p.id = ?').get(decodeURIComponent(proposalRecordMatch[1]));
        if (!proposal || !canAccess(user, proposal)) return json(response, 404, { error: 'Proposal not found.' });
        return json(response, 200, { proposal: { ...proposalView(proposal), leadNumber: publicLeadNumber(proposal.lead_number), leadOwnerName: proposal.lead_owner_name, createdByName: proposal.created_by_name } });
    }
    if (proposalRecordMatch && request.method === 'DELETE') {
        if (!isAdminUser(user)) return json(response, 403, { error: 'Only Admin/Owner users can permanently delete proposals.' });
        const proposalId = decodeURIComponent(proposalRecordMatch[1]);
        const proposal = database.prepare('SELECT id FROM proposal_records WHERE id = ?').get(proposalId);
        if (!proposal) return json(response, 404, { error: 'Proposal not found.' });
        database.prepare('DELETE FROM proposal_records WHERE id = ?').run(proposalId);
        return json(response, 200, { deleted: true });
    }
    if (proposalRecordMatch && request.method === 'POST') {
        const body = await parseBody(request);
        const existing = database.prepare('SELECT * FROM proposal_records WHERE id = ?').get(decodeURIComponent(proposalRecordMatch[1]));
        if (!existing) return json(response, 404, { error: 'Proposal not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(existing.lead_id);
        if (!lead || !canAccess(user, lead) || (!isAdminUser(user) && existing.created_by !== user.id && existing.status !== 'Draft')) return json(response, 403, { error: 'You do not have permission to edit this proposal.' });
        const data = buildProposalPayload(body, lead, proposalView(existing));
        if (data.subsidyEligibilityError) return json(response, 422, { error: data.subsidyEligibilityError });
        if (data.paymentScheduleError) return json(response, 422, { error: data.paymentScheduleError });
        if (data.componentConfigurationError) return json(response, 422, { error: data.componentConfigurationError });
        if (data.projectMetricsError) return json(response, 422, { error: data.projectMetricsError });
        if (body.pricingChanged !== true && body.pricingChanged !== 'true') {
            data.pricing = {
                ...proposalView(existing).pricing,
                solarPanels: existing.solar_panels,
                inverter: existing.inverter,
                structure: existing.structure,
                acdbDcdb: existing.acdb_dcdb,
                earthing: existing.earthing,
                cables: existing.cables,
                installation: existing.installation,
                otherCharges: existing.other_charges,
                subtotal: existing.subtotal,
                gst: existing.gst,
                grossAmount: existing.gross_amount,
                discount: existing.discount,
                finalAmount: existing.final_amount,
                subsidy: existing.subsidy,
                netInvestment: existing.net_investment
            };
        }
        if (!data.pricing) return json(response, 422, { error: 'No configured pricing is available for this system capacity or GST rate.' });
        if (!Number.isInteger(data.validityDays) || data.validityDays < 1 || data.validityDays > 365) return json(response, 422, { error: 'Proposal validity must be between 1 and 365 days.' });
        const status = ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired'].includes(body.status) ? body.status : existing.status;
        const timestamp = now();
        database.prepare(`UPDATE proposal_records SET customer_name=?, contact_number=?, email=?, address=?, pincode=?, proposal_date=?, system_type=?, system_capacity=?, panel_brand=?, panel_wattage=?, panel_count=?, inverter_brand=?, inverter_capacity=?, structure_type=?, battery_required=?, battery_capacity=?, net_metering=?, solar_panels=?, inverter=?, structure=?, acdb_dcdb=?, earthing=?, cables=?, installation=?, other_charges=?, subtotal=?, gst=?, gross_amount=?, discount=?, final_amount=?, subsidy=?, net_investment=?, booking_amount=?, payment_terms=?, custom_payment_terms=?, generation_estimate=?, monthly_savings=?, annual_savings=?, warranty=?, scope_of_work=?, terms_conditions=?, status=?, pricing_json=?, payment_schedule_json=?, subsidy_eligibility_verified=?, updated_at=? WHERE id=?`).run(data.customerName, data.contactNumber, data.email, data.address, data.pincode, data.proposalDate, data.systemType, data.systemCapacity, data.panelBrand, data.panelWattage, data.panelCount, data.inverterBrand, data.inverterCapacity, data.structureType, data.batteryRequired, data.batteryCapacity, data.netMetering, data.pricing.solarPanels, data.pricing.inverter, data.pricing.structure, data.pricing.acdbDcdb, data.pricing.earthing, data.pricing.cables, data.pricing.installation, data.pricing.otherCharges, data.pricing.subtotal, data.pricing.gst, data.pricing.grossAmount, data.pricing.discount, data.pricing.finalAmount, data.pricing.subsidy, data.pricing.netInvestment, data.bookingAmount, data.paymentTerms, data.customPaymentTerms, data.generationEstimate, data.monthlySavings, data.annualSavings, data.warranty, data.scopeOfWork, data.termsConditions, status, JSON.stringify(data.pricing), JSON.stringify(data.paymentSchedule), data.subsidyEligibilityVerified === null ? null : Number(data.subsidyEligibilityVerified), timestamp, existing.id);
        return json(response, 200, { proposal: proposalView(database.prepare('SELECT * FROM proposal_records WHERE id = ?').get(existing.id)) });
    }
    if (request.method === 'POST' && url.pathname === '/api/proposals') {
        const body = await parseBody(request);
        const leadId = String(body.leadId || '').trim();
        if (!leadId) return json(response, 422, { error: 'Select a CRM lead before creating a proposal.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ? LIMIT 1').get(leadId);
        if (!lead) return json(response, 404, { error: 'Selected lead was not found.' });
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create a proposal for this lead.' });
        const data = buildProposalPayload({ ...body, customerName: lead.customer_name, contactNumber: lead.mobile_number, email: lead.email || '' }, lead);
        if (data.subsidyEligibilityError) return json(response, 422, { error: data.subsidyEligibilityError });
        if (data.paymentScheduleError) return json(response, 422, { error: data.paymentScheduleError });
        if (data.componentConfigurationError) return json(response, 422, { error: data.componentConfigurationError });
        if (data.projectMetricsError) return json(response, 422, { error: data.projectMetricsError });
        if (!data.pricing) return json(response, 422, { error: 'No configured pricing is available for this system capacity or GST rate.' });
        if (!Number.isInteger(data.validityDays) || data.validityDays < 1 || data.validityDays > 365) return json(response, 422, { error: 'Proposal validity must be between 1 and 365 days.' });
        if (!data.customerName || !data.contactNumber || !data.systemType || data.systemCapacity <= 0 || data.inverterCapacity <= 0) return json(response, 422, { error: 'Customer, system type, system capacity and inverter capacity are required.' });
        const year = new Date().getFullYear();
        const last = database.prepare("SELECT proposal_number FROM proposal_records WHERE proposal_number LIKE ? ORDER BY proposal_number DESC LIMIT 1").get(`IP-${year}-%`);
        const nextNumber = `IP-${year}-${String((last ? Number(String(last.proposal_number).slice(-5)) : 0) + 1).padStart(5, '0')}`;
        const id = crypto.randomUUID(); const timestamp = now();
        database.prepare(`INSERT INTO proposal_records (id, proposal_number, lead_id, customer_name, contact_number, email, address, pincode, proposal_date, system_type, system_capacity, panel_brand, panel_wattage, panel_count, inverter_brand, inverter_capacity, structure_type, battery_required, battery_capacity, net_metering, solar_panels, inverter, structure, acdb_dcdb, earthing, cables, installation, other_charges, subtotal, gst, gross_amount, discount, final_amount, subsidy, net_investment, booking_amount, payment_terms, custom_payment_terms, lead_owner, pricing_json, generation_estimate, monthly_savings, annual_savings, warranty, scope_of_work, terms_conditions, status, created_by, created_at, updated_at, payment_schedule_json, subsidy_eligibility_verified) VALUES (${Array(52).fill('?').join(', ')})`).run(id, nextNumber, lead.id, data.customerName, data.contactNumber, data.email, data.address, data.pincode, data.proposalDate, data.systemType, data.systemCapacity, data.panelBrand, data.panelWattage, data.panelCount, data.inverterBrand, data.inverterCapacity, data.structureType, data.batteryRequired, data.batteryCapacity, data.netMetering, data.pricing.solarPanels, data.pricing.inverter, data.pricing.structure, data.pricing.acdbDcdb, data.pricing.earthing, data.pricing.cables, data.pricing.installation, data.pricing.otherCharges, data.pricing.subtotal, data.pricing.gst, data.pricing.grossAmount, data.pricing.discount, data.pricing.finalAmount, data.pricing.subsidy, data.pricing.netInvestment, data.bookingAmount, data.paymentTerms, data.customPaymentTerms, lead.assigned_to || '', JSON.stringify(data.pricing), data.generationEstimate, data.monthlySavings, data.annualSavings, data.warranty, data.scopeOfWork, data.termsConditions, 'Draft', user.id, timestamp, timestamp, JSON.stringify(data.paymentSchedule), Number(data.subsidyEligibilityVerified));
        audit(user, 'Created', 'proposal-record', id, { leadId: lead.id, proposalNumber: nextNumber });
        return json(response, 201, { proposal: proposalView(database.prepare('SELECT * FROM proposal_records WHERE id = ?').get(id)) });
    }

    const proposalMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/proposals$/);
    if (proposalMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(proposalMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        const survey = database.prepare("SELECT * FROM surveys WHERE lead_id = ? AND status = 'Completed'").get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this proposal.' });
        if (!survey || lead.stage !== 'Survey Completed') return json(response, 422, { error: 'Proposal can be created only after the survey is completed.' });
        const body = await parseBody(request);
        if (database.prepare("SELECT id FROM proposals WHERE lead_id = ? AND status NOT IN ('Rejected', 'Expired') LIMIT 1").get(leadId)) return json(response, 409, { error: 'An active proposal already exists for this lead.', code: 'ACTIVE_PROPOSAL_EXISTS' });
        const amount = Number(body.amount);
        const discount = Number(body.discount || 0);
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(discount) || discount < 0 || discount > amount) return json(response, 422, { error: 'Proposal amount and discount must be valid.' });
        const proposalId = body.proposalId || `PROP-${Date.now()}`;
        database.prepare('INSERT INTO proposals (id, lead_id, survey_id, amount, discount, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(proposalId, leadId, survey.id, amount, discount, 'Draft', user.id, now());
        audit(user, 'Created', 'proposal', proposalId, { leadId, surveyId: survey.id });
        return json(response, 201, { proposalId, stage: lead.stage });
    }

    const bookingMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/booking$/);
    if (bookingMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(bookingMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to create this booking.' });
        if (lead.stage !== 'Survey Completed') return json(response, 422, { error: 'Booking is allowed only after a feasible completed site survey.' });
        const body = await parseBody(request);
        const proposal = database.prepare('SELECT * FROM proposals WHERE id = ? AND lead_id = ?').get(body.proposalId, leadId);
        if (!proposal) return json(response, 422, { error: 'Booking must be created from a valid proposal.' });
        const existing = database.prepare('SELECT id FROM projects WHERE lead_id = ?').get(leadId);
        if (existing) return json(response, 409, { error: 'This lead already has a project.', projectId: existing.id });
        const projectId = body.projectId || `PROJ-${Date.now()}`;
        database.prepare('INSERT INTO projects (id, lead_id, proposal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, leadId, proposal.id, 'Booked', now(), now());
        database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run('Order Booked', now(), leadId);
        audit(user, 'Created', 'project', projectId, { leadId, proposalId: proposal.id });
        return json(response, 201, { projectId, stage: 'Order Booked' });
    }

    const generateProposalMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/generate-proposal$/);
    if (generateProposalMatch && request.method === 'POST') {
        const leadId = decodeURIComponent(generateProposalMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to generate a proposal for this lead.' });

        const body = await parseBody(request);

        // Validate required fields
        const customerName = String(lead.customer_name || '').trim();
        const contactNumber = String(lead.mobile_number || '').trim();
        const customerEmail = String(lead.email || '').trim();
        const submittedCustomerName = String(body.customerName || '').trim();
        const submittedContactNumber = String(body.contactNumber || '').trim();
        const submittedCustomerEmail = String(body.customerEmail || '').trim();
        if (submittedCustomerName !== customerName
            || submittedContactNumber !== contactNumber
            || submittedCustomerEmail.toLowerCase() !== customerEmail.toLowerCase()) {
            return json(response, 409, { error: 'Customer details changed or do not match the selected lead. Reload the lead before generating a proposal.' });
        }
        const address = String(body.customerAddress || body.address || '').trim();
        const pincode = String(body.pincode || '').trim();
        const systemCapacity = Number(body.systemSize || body.systemCapacity || 0);
        const inverterCapacity = Number(body.inverterSize || body.inverterCapacity || 0);
        const structureType = String(body.structureType || '').trim() || 'Not Available';
        const systemType = String(body.systemType || '').trim();
        const proposalDate = String(body.proposalDate || '').trim();
        const pricingType = String(body.pricingType || '').trim();
        const subsidyEligibilityVerified = body.subsidyEligibilityVerified === true || body.subsidyEligibilityVerified === 'true';
        const totalAmount = Number(body.totalAmount || 0);
        const validityDays = Number(body.validityDays ?? 15);
        const addons = Array.isArray(body.addOns) ? body.addOns : (Array.isArray(body.addons) ? body.addons : []);

        if (Number.isFinite(systemCapacity) && systemCapacity < 3) return json(response, 422, { error: 'System size must be at least 3 kW.' });
        if (Number.isFinite(systemCapacity) && systemCapacity > 15) return json(response, 422, { error: 'System size cannot exceed 15 kW for this pricing calculation.' });
        if (!customerName || !contactNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || !address || !/^\d{6}$/.test(pincode) || !Number.isFinite(systemCapacity) || !Number.isFinite(inverterCapacity) || inverterCapacity <= 0 || !Number.isInteger(validityDays) || validityDays < 1 || validityDays > 365 || (structureType !== 'Not Available' && !['RCC', 'Metal Roof', 'Ground Mount', 'Flush Mount / High Rise', 'Aluminium Rails', 'Other'].includes(structureType)) || !['On-Grid', 'Hybrid'].includes(systemType) || !/^\d{4}-\d{2}-\d{2}$/.test(proposalDate) || !['Non-Subsidy', 'Subsidy'].includes(pricingType) || !Number.isFinite(totalAmount) || totalAmount <= 0) {
            return json(response, 422, { error: 'All required fields must be provided with valid values.' });
        }
        if (subsidyEligibilityVerified && systemType !== 'On-Grid') {
            return json(response, 422, { error: 'The estimated PM Surya Ghar benefit is only available for eligible On-Grid proposals.' });
        }
        const panelCount = Number(body.panelCount || 0);
        const pricing = calculateProposalPricing(systemCapacity, pricingType, {
            systemType,
            panelCount,
            inverterPhase: body.inverterPhase,
            extraBattery: body.extraBattery === true || body.extraBattery === 'true',
            basePriceOverride: totalAmount,
            subsidy: systemType === 'On-Grid' && subsidyEligibilityVerified ? PM_SURYA_GHAR_SUBSIDY : 0
        });
        if (!pricing) return json(response, 422, { error: systemCapacity < 3 ? 'System size must be at least 3 kW.' : systemCapacity > 15 ? 'System size cannot exceed 15 kW for this pricing calculation.' : 'The selected subsidy rate is not available for this slab.' });
        pricing.panelCount = panelCount;
        pricing.extraBattery = body.extraBattery === true || body.extraBattery === 'true';
        const year = new Date().getFullYear();
        const last = database.prepare("SELECT proposal_number FROM proposal_records WHERE proposal_number LIKE ? ORDER BY proposal_number DESC LIMIT 1").get(`IP-${year}-%`);
        const proposalNumber = `IP-${year}-${String((last ? Number(String(last.proposal_number).slice(-5)) : 0) + 1).padStart(5, '0')}`;
        const proposalReference = proposalNumber;

        try {
            const pdfBase64 = await generateProposalPDF({
                customerName,
                contactNumber,
                address,
                pincode,
                systemCapacity,
                inverterCapacity,
                panelBrand: body.panelBrand,
                panelWattage: Number(body.panelWattage || 0),
                panelCount,
                inverterBrand: body.inverterBrand,
                structureType,
                systemType,
                proposalDate,
                proposalNumber,
                leadNumber: publicLeadNumber(lead.lead_number),
                versionNumber: 1,
                validityDays,
                subsidyEligibilityVerified,
                subsidyAmount: pricing.subsidyAmount,
                totalAmount: pricing.grossTotal,
                customerEmail: customerEmail || null,
                addons,
                pricing,
                generationEstimate: body.generationEstimate,
                monthlySavings: body.monthlySavings,
                annualSavings: body.annualSavings,
                paymentTerms: body.paymentTerms,
                customPaymentTerms: body.customPaymentTerms,
                bookingAmount: body.bookingAmount,
                paymentSchedule: Array.isArray(body.paymentSchedule) ? body.paymentSchedule : [],
                warranty: body.warranty,
                scopeOfWork: body.scopeOfWork,
                termsConditions: body.termsConditions,
                inverterPhase: body.inverterPhase,
                batterySize: body.batterySize,
                batteryRequired: Boolean(body.batterySize),
                netMetering: addons.includes('Net Metering'),
                discomWork: body.discomWork,
                omDuration: body.omDetails || body.omDuration,
                city: body.city,
                proposalReference
            });
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            if (pdfBuffer.length < 100 || pdfBuffer.subarray(0, 4).toString() !== '%PDF') throw new Error('Generated proposal PDF is invalid.');

            const proposalId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            const storagePath = `${crypto.randomUUID()}.pdf`;
            const leadNumber = String(publicLeadNumber(lead.lead_number)).replace(/[^A-Za-z0-9-]/g, '_');
            const filename = `Proposal_${leadNumber}_${proposalNumber}_v1.pdf`;
            const persistedPricing = {
                ...pricing,
                validityDays,
                panelCount,
                subsidyEligibilityVerified,
                subsidyBenefitLabel: subsidyEligibilityVerified
                    ? 'Estimated PM Surya Ghar benefit, subject to official approval'
                    : 'No subsidy benefit applied; eligibility not verified',
                inverterPhase: String(body.inverterPhase || ''),
                batterySize: String(body.batterySize || ''),
                discomWork: String(body.discomWork || ''),
                omDuration: String(body.omDetails || body.omDuration || ''),
                city: String(body.city || ''),
                addons
            };
            const batteryCapacity = Number.parseFloat(String(body.batterySize || '').replace(',', '.')) || 0;
            fs.writeFileSync(path.join(FILE_STORAGE_ROOT, storagePath), pdfBuffer, { flag: 'wx', mode: 0o600 });
            let transactionOpen = false;
            let databaseCommitted = false;
            try {
                database.exec('BEGIN IMMEDIATE');
                transactionOpen = true;
                const currentLast = database.prepare("SELECT proposal_number FROM proposal_records WHERE proposal_number LIKE ? ORDER BY proposal_number DESC LIMIT 1").get(`IP-${year}-%`);
                const currentNumber = `IP-${year}-${String((currentLast ? Number(String(currentLast.proposal_number).slice(-5)) : 0) + 1).padStart(5, '0')}`;
                if (currentNumber !== proposalNumber) throw new Error('Proposal numbering changed during generation; retry the request.');
                const timestamp = now();
                database.prepare(`INSERT INTO proposal_records (id, proposal_number, lead_id, customer_name, contact_number, email, address, pincode, proposal_date, system_type, system_capacity, panel_brand, panel_wattage, panel_count, inverter_brand, inverter_capacity, structure_type, battery_required, battery_capacity, net_metering, solar_panels, inverter, structure, acdb_dcdb, earthing, cables, installation, other_charges, subtotal, gst, gross_amount, discount, final_amount, subsidy, net_investment, booking_amount, payment_terms, custom_payment_terms, lead_owner, pricing_json, generation_estimate, monthly_savings, annual_savings, warranty, scope_of_work, terms_conditions, status, created_by, created_at, updated_at, subsidy_eligibility_verified) VALUES (${Array(51).fill('?').join(', ')})`).run(
                    proposalId, proposalNumber, lead.id, customerName, contactNumber, customerEmail, address, pincode, proposalDate, systemType, systemCapacity,
                    String(body.panelBrand || ''), Number(body.panelWattage || 0), panelCount, String(body.inverterBrand || ''), inverterCapacity, structureType, body.batterySize ? 1 : 0, batteryCapacity, addons.includes('Net Metering') ? 1 : 0,
                    pricing.panelAmount, pricing.inverterAmount, 0, pricing.acdbAmount, 0, 0, 0, 0, pricing.baseAmount, pricing.gstAmount,
                    pricing.grossTotal, pricing.discount, pricing.finalAmount, pricing.subsidyAmount, pricing.netInvestment, 0, '', '', lead.assigned_to || '',
                    JSON.stringify(persistedPricing), '', 0, 0, '', '', `This proposal is valid for ${validityDays} days.`, 'Draft', user.id, timestamp, timestamp, Number(subsidyEligibilityVerified)
                );
                database.prepare("INSERT INTO lead_documents (id, lead_id, document_type, file_name, uploaded_by, created_at, storage_path, original_file_name, mime_type, file_size, status, proposal_record_id) VALUES (?, ?, 'Proposal', ?, ?, ?, ?, ?, 'application/pdf', ?, 'UPLOADED', ?)")
                    .run(fileId, lead.id, filename, user.id, timestamp, storagePath, filename, pdfBuffer.length, proposalId);
                audit(user, 'Created', 'proposal-record', proposalId, { leadId: lead.id, proposalNumber });
                const savedProposal = proposalView(database.prepare('SELECT * FROM proposal_records WHERE id = ?').get(proposalId));
                if (!savedProposal) throw new Error('The saved proposal could not be verified.');
                database.exec('COMMIT');
                transactionOpen = false;
                databaseCommitted = true;
                return json(response, 200, {
                    pdfFileId: fileId,
                    pdfUrl: `/api/files/${encodeURIComponent(fileId)}?download=1`,
                    document: { id: fileId, leadId: lead.id, proposalId, fileName: filename, mimeType: 'application/pdf', fileSize: pdfBuffer.length, url: `/api/files/${encodeURIComponent(fileId)}` },
                    filename,
                    grossTotal: pricing.grossTotal,
                    subsidyAmount: pricing.subsidyAmount,
                    netInvestment: pricing.netInvestment,
                    proposalId,
                    proposalNumber,
                    proposal: savedProposal
                });
            } catch (error) {
                if (transactionOpen) database.exec('ROLLBACK');
                if (!databaseCommitted) removeStoredFile(storagePath);
                throw error;
            }
        } catch (error) {
            console.error('PDF generation failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Failed to generate proposal PDF. Please try again.' });
        }
    }


    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && request.method === 'PATCH') {
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) return json(response, 404, { error: 'Project not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to update this project.' });
        const body = await parseBody(request);
        const projectStages = ['Booked', 'Design', 'Material', 'Installation Scheduled', 'Installation', 'Installed', 'BESCOM', 'Commissioning', 'Completed'];
        if (!projectStages.includes(body.status)) return json(response, 422, { error: 'Invalid project status.' });
        if (body.status === 'BESCOM' && project.status !== 'Installed') return json(response, 422, { error: 'Only installed projects can move to BESCOM.' });
        database.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(body.status, now(), projectId);
        const leadStage = body.status === 'BESCOM' ? 'BESCOM' : body.status === 'Commissioning' ? 'Commissioned' : body.status === 'Completed' ? 'Completed' : body.status === 'Installation' || body.status === 'Installed' ? 'Installation' : lead.stage;
        database.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(leadStage, now(), lead.id);
        audit(user, 'Status changed', 'project', projectId, { previousStatus: project.status, newStatus: body.status, remarks: body.remarks || '' });
        return json(response, 200, { projectId, status: body.status, leadStage });
    }

    const paymentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/payments$/);
    if (paymentMatch && request.method === 'POST') {
        const projectId = decodeURIComponent(paymentMatch[1]);
        const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) return json(response, 404, { error: 'Project not found.' });
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);
        if (!canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to add payment.' });
        const body = await parseBody(request);
        const totalAmount = Number(body.totalAmount);
        const paidAmount = Number(body.paidAmount);
        if (!Number.isFinite(totalAmount) || !Number.isFinite(paidAmount) || totalAmount < 0 || paidAmount < 0) return json(response, 422, { error: 'Payment amounts must be valid non-negative numbers.' });
        if (paidAmount > totalAmount && user.role !== 'Admin/Owner') return json(response, 422, { error: 'Paid amount cannot exceed total amount.' });
        const paymentId = crypto.randomUUID();
        database.prepare('INSERT INTO payments (id, project_id, total_amount, paid_amount, payment_date, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(paymentId, projectId, totalAmount, paidAmount, body.paymentDate || now().slice(0, 10), body.notes || null, user.id, now());
        audit(user, 'Payment added', 'project', projectId, { paymentId, totalAmount, paidAmount, pendingAmount: totalAmount - paidAmount });
        return json(response, 201, { paymentId, totalAmount, paidAmount, pendingAmount: totalAmount - paidAmount });
    }

    const auditMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/audit$/);
    if (auditMatch && request.method === 'GET') {
        const leadId = decodeURIComponent(auditMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead || !canAccess(user, lead)) return json(response, 403, { error: 'You do not have permission to view this audit history.' });
        const events = database.prepare('SELECT audit_logs.*, staff.name AS user_name FROM audit_logs LEFT JOIN staff ON staff.id = audit_logs.user_id WHERE record_id = ? ORDER BY created_at DESC').all(leadId);
        return json(response, 200, { events: events.map((event) => ({ ...event, details: publicLeadNumberText(event.details) })) });
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications') {
        const notifications = database.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
        return json(response, 200, { notifications: notifications.map((notification) => ({ ...notification, message: publicLeadNumberText(notification.message) })) });
    }

    const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notificationMatch && request.method === 'POST') {
        const notificationId = decodeURIComponent(notificationMatch[1]);
        database.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), notificationId, user.id);
        return json(response, 200, { success: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/read-all') {
        database.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
        return json(response, 200, { success: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/profile') {
        const profile = database.prepare('SELECT id, employee_id AS employeeId, name, COALESCE(NULLIF(email, \'\'), login_id) AS email, department, designation, role, status, account_status AS accountStatus, last_login_at AS lastLogin, manager_id AS managerId, created_at AS joiningDate FROM staff WHERE id = ?').get(user.id);
        if (!profile) return json(response, 404, { error: 'Unable to load profile.' });
        return json(response, 200, { profile });
    }

    if (request.method === 'PATCH' && url.pathname === '/api/profile') {
        const body = await parseBody(request);
        const current = database.prepare('SELECT id, name, email, login_id AS loginId FROM staff WHERE id = ?').get(user.id);
        if (!current) return json(response, 404, { error: 'Unable to load profile.' });
        const name = body.name === undefined ? current.name : String(body.name || '').trim();
        const email = body.email === undefined ? (current.email || current.loginId) : String(body.email || '').trim().toLowerCase();
        if (name.length < 2 || name.length > 100) return json(response, 422, { error: 'Name must be between 2 and 100 characters.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(response, 422, { error: 'Enter a valid email address.' });
        const duplicate = database.prepare('SELECT id FROM staff WHERE id <> ? AND (lower(COALESCE(email, \'\')) = ? OR lower(login_id) = ?)').get(user.id, email, email);
        if (duplicate) return json(response, 409, { error: 'That email address is already in use.' });
        database.prepare('UPDATE staff SET name = ?, email = ? WHERE id = ?').run(name, email, user.id);
        audit(user, 'Profile Updated', 'staff', user.id, { fields: ['name', 'email'] });
        const profile = database.prepare('SELECT id, employee_id AS employeeId, name, COALESCE(NULLIF(email, \'\'), login_id) AS email, department, designation, role, status, account_status AS accountStatus, last_login_at AS lastLogin, manager_id AS managerId, created_at AS joiningDate FROM staff WHERE id = ?').get(user.id);
        return json(response, 200, { profile, message: 'Profile updated.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/password') {
        const body = await parseBody(request);
        const staff = database.prepare('SELECT id, login_id, password_hash FROM staff WHERE id = ?').get(user.id);
        if (isPermanentAdmin(staff)) {
            auditProtectedAdminAttempt(user, 'Change Protected Admin Password Attempt', user.id);
            return json(response, 403, { error: 'The permanent Admin password cannot be changed through the CRM.' });
        }
        if (!staff || !verifyPassword(body.currentPassword, staff.password_hash)) return json(response, 422, { error: 'Current password is incorrect.' });
        const passwordError = passwordPolicyError(body.newPassword);
        if (passwordError) return json(response, 422, { error: passwordError });
        if (body.newPassword !== body.confirmPassword) return json(response, 422, { error: 'New password and confirmation do not match.' });
        database.prepare('UPDATE staff SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(hashPassword(body.newPassword), user.id);
        audit(user, 'Password changed', 'staff', user.id);
        return json(response, 200, { message: 'Password changed successfully.' });
    }

    if (leadMatch && request.method === 'DELETE') {
        const leadId = decodeURIComponent(leadMatch[1]);
        const lead = database.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) return json(response, 404, { error: 'Lead not found.' });
        if (user.role !== 'Admin/Owner') return json(response, 403, { error: 'Only Admin/Owner users can permanently delete leads.' });

        database.exec('BEGIN');
        try {
            const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
            for (const table of tables) {
                const columns = database.prepare(`PRAGMA table_info(${table.name})`).all();
                if (table.name === 'leads') continue;
                if (columns.some((column) => column.name === 'lead_id')) {
                    database.prepare(`DELETE FROM ${table.name} WHERE lead_id = ?`).run(leadId);
                }
            }
            database.prepare("DELETE FROM audit_logs WHERE record_type = 'lead' AND record_id = ?").run(leadId);
            database.prepare("DELETE FROM notifications WHERE record_type = 'lead' AND record_id = ?").run(leadId);
            database.prepare('DELETE FROM leads WHERE id = ?').run(leadId);
            database.exec('COMMIT');
            return json(response, 200, { success: true, leadId, deleted: true, permanent: true });
        } catch (error) {
            database.exec('ROLLBACK');
            console.error('Permanent lead delete failed.', { errorType: safeErrorType(error) });
            return json(response, 500, { error: 'Unable to permanently delete the lead. No changes were saved.' });
        }
    }

    return json(response, 404, { error: 'API route not found.' });
}

function serveStatic(request, response, url) {
    let requested = url.pathname === '/' ? '/index.html' : url.pathname;
    if (url.pathname === '/staff.html' && url.searchParams.get('module') === 'settings') requested = '/settings.html';
    if (requested.includes('..') || requested.includes('\\') || requested.includes('\0')) return json(response, 403, { error: 'Forbidden.' });
    const normalizedRequest = path.posix.normalize(requested);
    const isAllowedPublicPath = PUBLIC_STATIC_PATHS.has(normalizedRequest) || PUBLIC_STATIC_PREFIXES.some((prefix) => normalizedRequest.startsWith(prefix));
    if (!isAllowedPublicPath || normalizedRequest.startsWith('/.') || normalizedRequest.startsWith('/crm-files') || normalizedRequest.startsWith('/database') || normalizedRequest.includes('/.git') || normalizedRequest.includes('/.env')) {
        return json(response, 403, { error: 'Forbidden.' });
    }
    const extension = path.extname(normalizedRequest).toLowerCase();
    if (!SAFE_STATIC_EXTENSIONS.has(extension)) return json(response, 403, { error: 'Forbidden.' });
    const filePath = path.resolve(ROOT, `.${normalizedRequest}`);
    if (!filePath.startsWith(ROOT) || path.relative(ROOT, filePath).startsWith('..')) return json(response, 403, { error: 'Forbidden.' });
    const forbiddenRoots = [path.join(ROOT, 'crm-files'), path.join(ROOT, 'database'), path.join(ROOT, 'mysql'), path.join(ROOT, 'supabase'), path.join(ROOT, 'integrations'), path.join(ROOT, 'repositories'), path.join(ROOT, 'services')];
    const isPublicProposalService = ['/services/proposal-configuration.js', '/services/equipment-catalogue.js'].includes(normalizedRequest);
    if (!isPublicProposalService && forbiddenRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`))) return json(response, 403, { error: 'Forbidden.' });
    fs.readFile(filePath, (error, content) => {
        if (error) return json(response, 404, { error: 'File not found.' });
        const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
        response.writeHead(200, {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'X-Robots-Tag': 'index, follow, max-image-preview:large'
        });
        response.end(content);
    });
}

initializeDatabase();

const app = express();
app.disable('x-powered-by');
if (NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://fonts.googleapis.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
            connectSrc: ["'self'", 'https://oauth2.googleapis.com', 'https://openidconnect.googleapis.com'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null
        }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: NODE_ENV === 'production',
    noSniff: true,
    referrerPolicy: { policy: 'same-origin' }
}));

const authRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many authentication attempts. Please wait a few minutes and try again.' },
    statusCode: 429
});

const passwordResetRateLimitOptions = {
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset attempts. Please try again later.' },
    statusCode: 429
};
const forgotPasswordRateLimiter = rateLimit(passwordResetRateLimitOptions);
const resetPasswordRateLimiter = rateLimit(passwordResetRateLimitOptions);

const generalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down and try again shortly.' },
    statusCode: 429
});

const leadImportRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many import previews. Please wait before uploading another file.' },
    statusCode: 429
});

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (CLIENT_ORIGINS.size === 0 || CLIENT_ORIGINS.has(normalizeOrigin(origin))) return callback(null, true);
        return callback(new Error('CORS policy denied this origin.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-File-Name']
}));
app.use('/api/lead-imports/preview', leadImportRateLimiter);
app.use('/api/lead-imports/preview', express.raw({ type: 'application/octet-stream', limit: MAX_IMPORT_BYTES }));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(morgan((tokens, request, response) => [
    tokens.method(request, response),
    sanitizeRequestTarget(request.originalUrl || request.url),
    tokens.status(request, response),
    `${tokens['response-time'](request, response)} ms`,
    tokens.res(request, response, 'content-length') || '-'
].join(' ')));

app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/signup', authRateLimiter);
app.use('/api/auth/forgot-password', forgotPasswordRateLimiter);
app.use('/api/auth/reset-password', resetPasswordRateLimiter);
app.use('/api', generalApiLimiter);

app.use(async (request, response, next) => {
    try {
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && request.headers.origin) {
            const origin = normalizeOrigin(request.headers.origin);
            if (origin && !CLIENT_ORIGINS.has(origin)) {
                return json(response, 403, { error: 'Origin not allowed.' });
            }
        }
        request.user = await currentUser(request);
        next();
    } catch (error) {
        next(error);
    }
});

app.use('/api', createPipelineRouter(database));

app.use(async (request, response) => {
    const url = new URL(request.originalUrl, `${request.protocol}://${request.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) {
            await handleApi(request, response, url);
            return;
        }
        serveStatic(request, response, url);
    } catch (error) {
        console.error('Request failed.', { errorType: error?.name || 'Error' });
        if (!response.headersSent) json(response, 500, { error: 'Internal server error.' });
    }
});

app.use((error, request, response, next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413 || error?.statusCode === 413) {
        console.warn('Request body rejected: configured size limit exceeded.', { path: sanitizeRequestTarget(request?.originalUrl || request?.url) });
        if (!response.headersSent) return json(response, 413, { error: 'Request body exceeds the supported size limit.' });
        return;
    }
    console.error('Express error.', { errorType: error?.name || 'Error' });
    recordSystemError('Unhandled request error', {
        errorType: error?.name || 'Error',
        path: sanitizeRequestTarget(request?.originalUrl || request?.url)
    });
    if (!response.headersSent) json(response, 500, { error: 'Internal server error.' });
});

const server = app.listen(PORT, HOST, () => {
    console.log(`INPACE POWER CRM server running at http://${HOST}:${PORT}`);
    console.log(`Database mode: ${DATABASE_MODE === 'sqlite' ? 'SQLite' : 'PostgreSQL'}`);
    if (NODE_ENV === 'production') console.log('Production mode enabled.');
    if (NODE_ENV === 'production') {
        if (DATABASE_MODE === 'sqlite' && String(process.env.CRM_BACKUP_ROOT || '').trim()) {
            const { startScheduledBackups } = require('./database/automated-backup');
            stopBackupScheduler = startScheduledBackups();
        } else {
            console.error('Automatic CRM backups are not configured.', { databaseMode: DATABASE_MODE, backupRootConfigured: false });
        }
    }
    bulkLeadImportService.resume().catch((error) => {
        console.error('Unable to resume persisted lead imports.', { errorType: safeErrorType(error) });
    });
});

let shutdownStarted = false;
let stopBackupScheduler = () => { };
async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopBackupScheduler();
    server.close(async (serverError) => {
        let shutdownError = serverError || null;
        try {
            await Promise.all([...new Set([database, repository])].map((connection) => connection.close()));
        } catch (error) {
            shutdownError = shutdownError || error;
        }
        if (shutdownError) {
            console.error('CRM shutdown failed:', shutdownError.code || shutdownError.name || 'unknown error');
            process.exitCode = 1;
        }
    });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

module.exports = { app, server };
