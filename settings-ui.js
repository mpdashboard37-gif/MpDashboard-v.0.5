(function () {
    'use strict';

    const RESOURCE_PERMISSIONS = [
        { id: 'leads', label: 'Leads', actions: ['View', 'Create', 'Edit', 'Delete', 'Assign', 'Export'] },
        { id: 'customers', label: 'Customers', actions: ['View', 'Create', 'Edit', 'Delete'] },
        { id: 'tasks', label: 'Tasks', actions: ['View', 'Create', 'Edit', 'Delete'] },
        { id: 'siteSurvey', label: 'Site Survey', actions: ['View', 'Create', 'Edit', 'Delete', 'Assign'] },
        { id: 'proposals', label: 'Proposals', actions: ['View', 'Create', 'Edit', 'Delete', 'Export'] },
        { id: 'payments', label: 'Payments', actions: ['View', 'Create', 'Edit', 'Delete'] },
        { id: 'files', label: 'Files', actions: ['View', 'Upload', 'Download', 'Delete'] },
        { id: 'reports', label: 'Reports', actions: ['View', 'Export'] },
        { id: 'settings', label: 'Settings', actions: ['View', 'Edit'] },
        { id: 'users', label: 'Users', actions: ['View', 'Create', 'Edit', 'Delete'] }
    ];

    const ROLE_SCOPES = {
        'Admin/Owner': 'Full access',
        'Sales Manager': 'Team-level access',
        'Sales Executive': 'Own / assigned leads',
        Telecaller: 'Assigned leads and contacts'
    };

    const ROLE_NAMES = Object.keys(ROLE_SCOPES);

    function buildDefaultPermissions() {
        const all = Object.fromEntries(RESOURCE_PERMISSIONS.map((resource) => [resource.id, Object.fromEntries(resource.actions.map((action) => [action, true]))]));
        const manager = JSON.parse(JSON.stringify(all));
        const executive = JSON.parse(JSON.stringify(all));
        const telecaller = JSON.parse(JSON.stringify(all));
        const restrict = (matrix, resourceIds, deniedActions) => resourceIds.forEach((resourceId) => deniedActions.forEach((action) => {
            if (matrix[resourceId]) matrix[resourceId][action] = false;
        }));
        restrict(executive, ['leads'], ['Delete', 'Assign', 'Export']);
        restrict(executive, ['customers', 'tasks', 'siteSurvey', 'proposals', 'payments', 'files'], ['Delete']);
        restrict(executive, ['siteSurvey'], ['Assign']);
        restrict(executive, ['proposals'], ['Export']);
        restrict(executive, ['files'], ['Download']);
        restrict(executive, ['reports'], ['Export']);
        restrict(executive, ['settings'], ['View', 'Edit']);
        restrict(executive, ['users'], ['View', 'Create', 'Edit', 'Delete']);
        restrict(telecaller, ['leads'], ['Delete', 'Assign', 'Export']);
        restrict(telecaller, ['customers', 'tasks', 'files'], ['Delete']);
        restrict(telecaller, ['siteSurvey', 'proposals', 'payments', 'reports', 'settings', 'users'], ['View', 'Create', 'Edit', 'Delete', 'Assign', 'Export', 'Upload', 'Download']);
        return {
            'Admin/Owner': all,
            'Sales Manager': manager,
            'Sales Executive': executive,
            Telecaller: telecaller
        };
    }

    const DEFAULT_PERMISSIONS = buildDefaultPermissions();
    const sectionGroups = [
        {
            label: 'ACCOUNT', items: [
                { id: 'my-profile', label: 'My Profile', category: 'myProfile', icon: 'person', description: 'Personal details and preferences for your CRM account.', mode: 'profile' },
                { id: 'security', label: 'Security', category: 'security', icon: 'shield_lock', description: 'Password, session, sign-in protection, and account security.', mode: 'security' },
                { id: 'notifications', label: 'Notifications', category: 'notifications', icon: 'notifications', description: 'Choose which CRM events trigger notifications.' }
            ]
        },
        {
            label: 'USERS & ACCESS', items: [
                { id: 'staff-management', label: 'Staff Management', category: 'staffManagement', icon: 'groups', description: 'Default onboarding and team-management settings.', source: 'staff' },
                { id: 'roles-permissions', label: 'Roles & Permissions', category: 'rolesPermissions', icon: 'admin_panel_settings', description: 'Configure action permissions by role while keeping record scope enforced.', mode: 'permissions' },
                { id: 'signup-requests', label: 'Signup Requests', category: 'signupRequests', icon: 'person_add', description: 'Approval policy and recent CRM access requests.', source: 'requests' }
            ]
        },
        {
            label: 'CRM', items: [
                { id: 'lead-settings', label: 'Lead Settings', category: 'leadSettings', icon: 'recent_actors', description: 'Lead capture, duplicate checks, and assignment defaults.' },
                { id: 'pipeline-stages', label: 'Pipeline Stages', category: 'pipelineStages', icon: 'account_tree', description: 'Default sales stage and progression labels.' },
                { id: 'locations', label: 'Locations', category: 'locations', icon: 'location_on', description: 'Territory defaults and location capture.' },
                { id: 'tasks-follow-ups', label: 'Tasks & Follow-ups', category: 'tasksFollowUps', icon: 'task_alt', description: 'Follow-up timing and task reminder defaults.' },
                { id: 'activity-settings', label: 'Activity Settings', category: 'activitySettings', icon: 'history', description: 'Activity tracking and retention preferences.' }
            ]
        },
        {
            label: 'SOLAR', items: [
                { id: 'solar-panels', label: 'Solar Panels', category: 'solarPanels', icon: 'solar_power', description: 'Panel product and warranty defaults.' },
                { id: 'inverters', label: 'Inverters', category: 'inverters', icon: 'electrical_services', description: 'Inverter brands, phases, and warranty defaults.' },
                { id: 'batteries', label: 'Batteries', category: 'batteries', icon: 'battery_charging_full', description: 'Battery chemistry, sizing, and warranty defaults.' },
                { id: 'structures', label: 'Structures', category: 'structures', icon: 'architecture', description: 'Mounting types and structural safety checks.' },
                { id: 'solar-pricing', label: 'Solar Pricing', category: 'solarPricing', icon: 'payments', description: 'Pricing tiers, tax, and commission defaults.' }
            ]
        },
        {
            label: 'SALES', items: [
                { id: 'proposal-settings', label: 'Proposal Settings', category: 'proposalSettings', icon: 'description', description: 'Proposal generation, revision, and customer approval.' },
                { id: 'payment-settings', label: 'Payment Settings', category: 'paymentSettings', icon: 'account_balance_wallet', description: 'Payment terms, reminders, and invoice requirements.' },
                { id: 'terms-conditions', label: 'Terms & Conditions', category: 'termsConditions', icon: 'gavel', description: 'Standard legal text included in customer proposals.' }
            ]
        },
        {
            label: 'COMMUNICATION', items: [
                { id: 'email-settings', label: 'Email', category: 'emailSettings', keys: ['enabled', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'fromAddress', 'sendLeadAlerts', 'sendTaskReminders'], icon: 'mail', description: 'SMTP delivery and email notification settings.' },
                { id: 'whatsapp-settings', label: 'WhatsApp', category: 'whatsappSettings', icon: 'chat', description: 'WhatsApp gateway and customer notification settings.' }
            ]
        },
        {
            label: 'OPERATIONS', items: [
                { id: 'site-survey-settings', label: 'Site Survey', category: 'siteSurveySettings', icon: 'travel_explore', description: 'Survey evidence, status, and location requirements.' },
                { id: 'file-management', label: 'File Management', category: 'fileManagement', icon: 'folder_managed', description: 'Upload limits, permitted formats, and retention.' }
            ]
        },
        {
            label: 'COMPANY', items: [
                { id: 'company-profile', label: 'Company Profile', category: 'companyProfile', icon: 'business', description: 'Business identity and registered contact information.' },
                { id: 'branding', label: 'Branding', category: 'branding', icon: 'palette', description: 'Brand colors and report presentation preferences.' },
                { id: 'numbering', label: 'Numbering', category: 'numbering', icon: 'tag', description: 'Prefixes and next numbers for CRM documents.' }
            ]
        },
        {
            label: 'DATA', items: [
                { id: 'import-export', label: 'Import / Export', category: 'importExport', icon: 'import_export', description: 'Bulk transfer format and batch settings.' },
                { id: 'database-backup', label: 'Database & Backup', category: 'databaseBackup', icon: 'database', description: 'Backup schedule and retention preferences.' }
            ]
        },
        {
            label: 'INTEGRATIONS', items: [
                { id: 'meta-lead-ads', label: 'Meta Lead Ads', category: 'integrations', keys: ['metaLeadAdsEnabled', 'metaPageId', 'metaFormId', 'metaAccessToken'], icon: 'campaign', description: 'Configuration fields for Meta lead capture.' },
                { id: 'google', label: 'Google', category: 'integrations', keys: ['enableGoogleSync', 'googleClientId', 'googleClientSecret'], icon: 'cloud_sync', description: 'Google account and sync configuration.' },
                { id: 'zapier', label: 'Zapier', category: 'integrations', keys: ['enableZapier', 'zapierWebhookUrl', 'zapierApiKey'], icon: 'bolt', description: 'Zapier automation connection settings.' },
                { id: 'other-integrations', label: 'Other Integrations', category: 'integrations', keys: ['webhookUrl', 'apiKey', 'enableWhatsAppSync', 'enableCrmApi'], icon: 'hub', description: 'Webhook and CRM API configuration.' }
            ]
        },
        {
            label: 'SYSTEM', items: [
                { id: 'dashboard-settings', label: 'Dashboard Settings', category: 'dashboardSettings', icon: 'dashboard', description: 'Default dashboard view and visible widgets.' },
                { id: 'audit-logs', label: 'Audit Logs', category: 'auditLogs', icon: 'fact_check', description: 'Recent authenticated CRM actions.', mode: 'audit' },
                { id: 'error-logs', label: 'Error Logs', category: 'errorLogs', icon: 'bug_report', description: 'Recent application errors and diagnostics.', mode: 'errors' },
                { id: 'system-information', label: 'System Information', category: 'systemInfo', icon: 'info', description: 'Current server runtime and database health.', mode: 'system' }
            ]
        }
    ];

    const selectOptions = {
        role: ['Admin/Owner', 'Sales Manager', 'Sales Executive', 'Telecaller'],
        language: ['English', 'Hindi', 'Kannada'],
        passwordPolicy: ['Strong', 'Medium', 'Weak'],
        digestFrequency: ['Instant', 'Hourly', 'Daily', 'Weekly'],
        defaultTaskType: ['Call', 'WhatsApp', 'Meeting', 'Site Visit', 'Payment Follow-up'],
        currency: ['INR', 'USD', 'EUR'],
        defaultStatus: ['Scheduled', 'In Progress', 'Completed'],
        exportFormat: ['CSV', 'Excel', 'JSON'],
        backupFrequency: ['Hourly', 'Daily', 'Weekly'],
        defaultView: ['Overview', 'Pipeline', 'Tasks', 'Inventory'],
        onboardingWorkflow: ['Manual approval', 'Automatic'],
        defaultRole: ['Sales Executive', 'Telecaller', 'Sales Manager']
    };

    const state = { currentSettings: {}, activeId: 'my-profile', filter: '', saving: false, draftPermissions: null, profilePhoneDraft: '', profilePhotoDraft: '', extraData: {} };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    }

    const iconShapes = {
        person: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c.8-3.2 3.2-5 7-5s6.2 1.8 7 5"/>',
        shield: '<path d="M12 3 19 6v5c0 4.4-2.8 8-7 10-4.2-2-7-5.6-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
        notifications: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
        group: '<path d="M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 18.5V20"/><circle cx="10" cy="7.5" r="3.5"/><path d="M17 4.5a3.5 3.5 0 0 1 0 6.8M20 20v-1.5a4.5 4.5 0 0 0-3.2-4.3"/>',
        verified_user: '<path d="M12 3 19 6v5c0 4.4-2.8 8-7 10-4.2-2-7-5.6-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
        how_to_reg: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.2A4.8 4.8 0 0 1 8.3 14h1.4a4.8 4.8 0 0 1 4.8 4.8V20M16 10l1.5 1.5L21 8"/>',
        leaderboard: '<path d="M4 20V11h4v9M10 20V5h4v15M16 20v-7h4v7M3 20h18"/>',
        timeline: '<path d="M4 6h5l3 6h7"/><circle cx="4" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M12 14v4h7"/><circle cx="19" cy="18" r="2"/>',
        location_on: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/>',
        task_alt: '<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/>',
        history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
        solar_power: '<circle cx="8" cy="7" r="2.6"/><path d="M8 1v2M8 11v2M2 7H0M16 7h-2M3.8 2.8l1.4 1.4M10.8 9.8l1.4 1.4M3 15h13l2 6H5l-2-6ZM7 15l1 6m5-6-1 6m-9-3h16"/>',
        electrical_services: '<path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z"/>',
        battery_charging_full: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M10 2h4v3h-4zM13 8l-3 5h3l-2 5 5-7h-3l2-3"/>',
        architecture: '<path d="m3 17 7-12 11 14H5l-2-2Z"/><path d="m8 14 2 1m1-5 2 1m1 5 2 1"/>',
        payments: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 15h4"/>',
        search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        arrow_back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
        lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
        warning: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
        search_off: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5M4 4l16 16"/>',
        arrow_outward: '<path d="M7 17 17 7M7 7h10v10"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
        error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
        check_circle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
        inbox: '<path d="M4 4h16l2 11h-6l-2 3h-4l-2-3H2L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
        save: '<path d="M5 3h12l4 4v14H3V3h2Z"/><path d="M7 3v6h9V3M7 21v-8h10v8"/>',
        tune: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
        account_circle: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6.5 19a6 6 0 0 1 11 0"/>',
        shield_lock: '<path d="M12 3 19 6v5c0 4.4-2.8 8-7 10-4.2-2-7-5.6-7-10V6l7-3Z"/><rect x="9" y="10" width="6" height="5" rx="1"/><path d="M10 10V8a2 2 0 0 1 4 0v2"/>',
        admin_panel_settings: '<path d="M12 3 19 6v5c0 4.4-2.8 8-7 10-4.2-2-7-5.6-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
        recent_actors: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M17 8h4m-2-2v4"/>',
        account_tree: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v4h12V8M12 12v4"/>',
        gavel: '<path d="m14 5 5 5m-8-2 5-5 3 3-5 5m-8 2 5-5 3 3-5 5m-7 7h12"/>',
        mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
        chat: '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 9 9 0 0 1-4-.9L4 20l1.3-3.4A7.2 7.2 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3.1 8 7Z"/>',
        travel_explore: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6m-3-3v6m7-10h4m-2-2v4"/>',
        folder_managed: '<path d="M3 6h7l2 2h9v11H3V6Z"/><path d="m9 14 2 2 4-4"/>',
        business: '<path d="M4 21V5l8-3v19M12 8h8v13M2 21h20M7 7h2m-2 4h2m-2 4h2m7-3h2m-2 4h2"/>',
        palette: '<path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.4-3.4 1.7 1.7 0 0 1 1.2-2.9H18a3 3 0 0 0 3-3c0-4.8-4-8.7-9-8.7Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="10" cy="7.5" r=".8"/><circle cx="15" cy="8" r=".8"/>',
        tag: '<path d="M20 13 13 20 3 10V4h6l11 9Z"/><circle cx="7" cy="8" r="1"/>',
        import_export: '<path d="M7 3v12m0 0-4-4m4 4 4-4M17 21V9m0 0-4 4m4-4 4 4"/>',
        database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
        campaign: '<path d="M4 13V9h4l9-4v12l-9-4H4Zm4 0 2 6h4l-2-7m7-4a5 5 0 0 1 0 8"/>',
        cloud_sync: '<path d="M7 17a4 4 0 0 1-.2-8A6 6 0 0 1 18 8a4.5 4.5 0 0 1 .8 9H15"/><path d="m12 12-3 3 3 3m-3-3h8"/>',
        bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
        hub: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 7 3 3m7-3-3 3m-7 7 3-3m7 3-3-3"/>',
        dashboard: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/>',
        fact_check: '<path d="M6 3h12v18H6zM9 8l1.5 1.5L13 7m-4 6h6m-6 3h6"/>',
        bug_report: '<path d="M8 8h8v8a4 4 0 0 1-8 0V8ZM9 4l3 3 3-3M4 10h4m8 0h4M4 15h4m8 0h4m-12 5-2 2m12-2 2 2"/>',
        task_alt: '<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/>',
        description: '<path d="M6 3h8l5 5v13H6zM14 3v5h5m-9 4h6m-6 4h6"/>',
        account_balance_wallet: '<path d="M4 6h15a2 2 0 0 1 2 2v12H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h13"/><path d="M21 11h-5a2 2 0 0 0 0 4h5m-5-2h.01"/>',
        solar_power: '<circle cx="8" cy="7" r="2.6"/><path d="M8 1v2M8 11v2M2 7H0M16 7h-2M3.8 2.8l1.4 1.4M10.8 9.8l1.4 1.4M3 15h13l2 6H5l-2-6ZM7 15l1 6m5-6-1 6m-8-3h16"/>'
    };

    function iconSvg(name, className = 'settings-icon') {
        const shape = iconShapes[name] || iconShapes.tune;
        return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shape}</svg>`;
    }

    function deepMerge(base, incoming) {
        if (!base || typeof base !== 'object' || Array.isArray(base)) return incoming;
        const merged = { ...base };
        Object.entries(incoming || {}).forEach(([key, value]) => {
            merged[key] = value && typeof value === 'object' && !Array.isArray(value)
                ? deepMerge(merged[key] || {}, value)
                : value;
        });
        return merged;
    }

    function makeLabel(key) {
        const labels = {
            smtpHost: 'SMTP host', smtpPort: 'SMTP port', smtpUser: 'SMTP username', smtpPassword: 'SMTP password',
            gstRate: 'GST rate (%)', salesCommissionRate: 'Sales commission rate (%)',
            tier3: '3-4.99 kW rate', tier5: '5-7.99 kW rate', tier8: '8-9.99 kW rate', tier10: '10-15 kW rate',
            defaultFollowUpDays: 'Default follow-up days', reminderLeadTimeMinutes: 'Reminder lead time (minutes)',
            maxUploadSizeMb: 'Maximum upload size (MB)', nextLeadNumber: 'Next lead number', nextProposalNumber: 'Next proposal number', nextInvoiceNumber: 'Next invoice number',
            standardText: 'Standard terms text', apiKey: 'API key', metaAccessToken: 'Meta access token', googleClientSecret: 'Google client secret', zapierApiKey: 'Zapier API key'
        };
        if (labels[key]) return labels[key];
        return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());
    }

    function fieldType(key, value) {
        const lower = key.toLowerCase();
        if (typeof value === 'boolean' || /enabled|allow|require|track|show|auto|preserve|capture|duplicatecheck|approval|scan|archive|sensitive|recurring|escalation|generatepdf|customeraccept|footer|revision|partialpayments|invoice|branding|darkmode/.test(lower)) return 'checkbox';
        if (/password|secret|token|apikey/.test(lower)) return 'password';
        if (/color/.test(lower)) return 'color';
        if (typeof value === 'number' || /days|minutes|rate|months|port|size|batch|next.*number|retention|count|limit/.test(lower)) return 'number';
        if (Array.isArray(value)) return 'array';
        if (/text|address|signature|terms|mapping|labels/.test(lower)) return 'textarea';
        if (selectOptions[key]) return 'select';
        return 'text';
    }

    function getItem(id) {
        for (const group of sectionGroups) {
            const item = group.items.find((entry) => entry.id === id);
            if (item) return { ...item, group: group.label };
        }
        return null;
    }

    function renderShell() {
        document.body.className = 'settings-page';
        document.body.innerHTML = `
            <div id="settingsApp" class="settings-app">
                <header class="settings-header">
                    <div class="header-brand">
                        <button id="backBtn" class="icon-button" type="button" aria-label="Back to dashboard" title="Back to dashboard">${iconSvg('arrow_back')}</button>
                        <div class="header-titles"><div class="breadcrumbs"><span>Administration</span><span aria-hidden="true">/</span><strong>Settings</strong></div><h1>CRM Settings</h1></div>
                    </div>
                    <div class="header-actions"><span class="admin-badge">${iconSvg('lock')}<span>Admin Only</span></span><div class="user-block"><strong id="currentUserName">Admin</strong><span id="currentUserRole">Admin/Owner</span></div><button id="logoutBtn" class="secondary-button" type="button">Logout</button></div>
                </header>
                <div class="settings-workspace">
                    <aside class="settings-sidebar" aria-label="Settings navigation">
                        <label class="search-wrap">${iconSvg('search')}<input id="settingsSearch" type="search" placeholder="Search settings..." autocomplete="off" aria-label="Search settings" /><button id="clearSearch" type="button" aria-label="Clear search" title="Clear search" hidden>${iconSvg('close')}</button></label>
                        <nav id="settingsNav" class="settings-nav"></nav>
                    </aside>
                    <main class="settings-content" id="settingsContent" tabindex="-1">
                        <div id="accessWarning" class="access-warning" role="status" hidden></div>
                        <div id="settingsBreadcrumb" class="section-breadcrumb"></div>
                        <div id="settingsSection"></div>
                    </main>
                </div>
                <div id="toastRegion" class="toast-region" aria-live="polite" aria-atomic="true"></div>
                <div id="confirmLayer" class="confirm-layer" hidden>
                    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
                        <span class="dialog-icon">${iconSvg('warning')}</span>
                        <h2 id="confirmTitle">Confirm sensitive change</h2><p id="confirmMessage"></p>
                        <div class="dialog-actions"><button id="confirmCancel" class="secondary-button" type="button">Cancel</button><button id="confirmAccept" class="primary-button" type="button">Continue</button></div>
                    </section>
                </div>
            </div>`;
        const user = JSON.parse(localStorage.getItem('solarflow_crm_current_user') || sessionStorage.getItem('solarflow_crm_current_user') || 'null');
        if (user?.name) document.getElementById('currentUserName').textContent = user.name;
        if (user?.role) document.getElementById('currentUserRole').textContent = user.role;
    }

    function renderNavigation() {
        const nav = document.getElementById('settingsNav');
        const query = state.filter.trim().toLowerCase();
        let visibleCount = 0;
        nav.innerHTML = sectionGroups.map((group) => {
            const items = group.items.filter((item) => !query || `${item.label} ${group.label} ${item.description}`.toLowerCase().includes(query));
            visibleCount += items.length;
            if (!items.length) return '';
            return `<div class="nav-group"><h2>${escapeHtml(group.label)}</h2>${items.map((item) => `<button class="settings-nav-item nav-item ${item.id === state.activeId ? 'is-active' : ''}" type="button" data-target="${item.id}" aria-current="${item.id === state.activeId ? 'page' : 'false'}" title="${escapeHtml(item.label)}"><span class="settings-nav-icon nav-icon">${iconSvg(item.icon)}</span><span class="settings-nav-label nav-label">${escapeHtml(item.label)}</span></button>`).join('')}</div>`;
        }).join('');
        if (!visibleCount) nav.innerHTML = `<div class="empty-state compact">${iconSvg('search_off')}<strong>No settings found</strong><span>Try a different name or category.</span></div>`;
        nav.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => selectSection(button.dataset.target)));
    }

    function getKeys(item) {
        if (item.keys) return item.keys;
        const value = state.currentSettings[item.category];
        return value && typeof value === 'object' ? Object.keys(value).filter((key) => value[key] === null || typeof value[key] !== 'object' || Array.isArray(value[key])) : [];
    }

    function getProfileStorageKey(profile, suffix) {
        return `inpace_crm_profile_${profile?.id || 'current'}_${suffix}`;
    }

    function renderProfileForm() {
        const profile = state.extraData.profile?.profile;
        if (state.extraData.profile?.error) return `<div class="empty-state content-empty">${iconSvg('error')}<strong>Profile unavailable</strong><span>${escapeHtml(state.extraData.profile.error)}</span></div>`;
        if (!profile) return `<div class="loading-state"><span class="spinner"></span>Loading profile...</div>`;
        const photo = state.profilePhotoDraft || '';
        const initials = String(profile.name || 'User').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
        const rawStatus = String(profile.accountStatus || profile.status || 'Unknown');
        const status = ({ ACTIVE: 'Active', DEACTIVATED: 'Deactivated', DECLINED: 'Declined', SUSPENDED: 'Suspended', PENDING: 'Pending' })[rawStatus.toUpperCase()] || rawStatus;
        const lastLogin = profile.lastLogin ? new Date(profile.lastLogin).toLocaleString() : 'Not recorded';
        const preferences = state.currentSettings.myProfile || {};
        const photoSource = photo ? `src="${escapeHtml(photo)}"` : '';
        return `<div class="profile-editor">
            <section class="profile-photo-row" aria-label="Profile photo">
            <div class="profile-photo-preview"><img id="profilePhotoImage" alt="Profile photo" ${photoSource} ${photo ? '' : 'hidden'} /><span id="profilePhotoInitials" ${photo ? 'hidden' : ''}>${escapeHtml(initials || 'U')}</span></div>
                <div class="profile-photo-copy"><strong>Profile Photo</strong><p>Shown only in this browser. Use a square image up to 1 MB.</p><div class="profile-photo-actions"><button type="button" class="secondary-button" data-photo-change>Change Photo</button><button type="button" class="text-button" data-photo-remove ${photo ? '' : 'disabled'}>Remove Photo</button></div><input type="file" accept="image/png,image/jpeg,image/webp" data-profile-photo hidden /></div>
            </section>
            <div class="field-grid profile-fields">
                ${profileInput('Full Name', 'name', profile.name || '', false, 'text')}
                ${profileInput('Employee ID', 'employeeId', profile.employeeId || '', true)}
                ${profileInput('Email', 'email', profile.email || '', false, 'email')}
                ${profileInput('Phone Number', 'phone', state.profilePhoneDraft || '', false, 'tel')}
                ${profileInput('Designation', 'designation', profile.designation || '', true)}
                ${profileInput('Department', 'department', profile.department || '', true)}
                ${profileInput('Role', 'role', profile.role || '', true)}
                ${profileInput('Account Status', 'accountStatus', status, true)}
                ${profileInput('Last Login', 'lastLogin', lastLogin, true)}
            </div>
            <section class="profile-preferences"><h3>Preferences</h3><div class="field-grid">${['timezone', 'language', 'signature'].map((key) => renderField({ id: 'my-profile', category: 'myProfile' }, key)).join('')}</div></section>
        </div>`;
    }

    function profileInput(label, key, value, readOnly, type = 'text') {
        return `<label class="field" for="profile-${key}"><span class="field-label">${escapeHtml(label)}</span><input id="profile-${key}" data-profile-field="${key}" type="${type}" value="${escapeHtml(value)}" ${readOnly ? 'readonly aria-readonly="true"' : ''} /></label>`;
    }

    function securityConfigControl(key, label, description, type = 'number') {
        const value = state.currentSettings.security?.[key];
        const path = `security.${key}`;
        const id = `security-${key}`;
        if (type === 'checkbox') {
            return `<label class="toggle-field security-toggle" for="${id}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><input id="${id}" type="checkbox" data-setting-path="${path}" ${value ? 'checked' : ''} /><span class="toggle-track" aria-hidden="true"></span></label>`;
        }
        if (type === 'select') {
            return `<label class="security-config-field" for="${id}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><select id="${id}" data-setting-path="${path}">${(selectOptions.passwordPolicy || []).map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
        }
        return `<label class="security-config-field" for="${id}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><input id="${id}" type="number" min="1" step="1" data-setting-path="${path}" value="${escapeHtml(value ?? '')}" /></label>`;
    }

    function renderLoginHistory() {
        const result = state.extraData.securityAudit;
        if (result?.error) return `<div class="empty-state">${iconSvg('error')}<strong>Login history unavailable</strong><span>${escapeHtml(result.error)}</span></div>`;
        if (!result) return '<div class="loading-state"><span class="spinner"></span>Loading login history...</div>';
        const entries = (result.logs || []).filter((entry) => String(entry.action || '').toLowerCase().includes('login')).slice(0, 20);
        if (!entries.length) return `<div class="empty-state">${iconSvg('history')}<strong>No login history</strong><span>Login events will appear here when recorded.</span></div>`;
        return `<div class="table-wrap"><table><thead><tr><th>User</th><th>Event</th><th>Time</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${escapeHtml(entry.userName || entry.userId || 'System')}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(new Date(entry.createdAt).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderSecuritySettings() {
        const permanentAdmin = state.extraData.profile?.profile?.id === 'staff-admin';
        const passwordSection = permanentAdmin
            ? `<div class="security-notice">Password changes for the protected permanent Admin account are not supported by the existing password API.</div>`
            : `<div class="security-form-grid">
                <label class="field" for="securityCurrentPassword"><span class="field-label">Current password</span><input id="securityCurrentPassword" type="password" autocomplete="current-password" /></label>
                <label class="field" for="securityNewPassword"><span class="field-label">New password</span><input id="securityNewPassword" type="password" autocomplete="new-password" /></label>
                <label class="field" for="securityConfirmPassword"><span class="field-label">Confirm new password</span><input id="securityConfirmPassword" type="password" autocomplete="new-password" /></label>
                <div class="security-action"><button type="button" class="secondary-button" data-change-password>Change Password</button></div>
            </div>`;
        return `<div class="security-sections">
            <section class="security-panel"><header><h3>Password</h3><p>Update your sign-in password using the current password.</p></header>${passwordSection}</section>
            <section class="security-panel"><header><h3>Session Security</h3><p>Set a preferred timeout and review available session controls.</p></header>
                <div class="security-controls">${securityConfigControl('sessionTimeoutMinutes', 'Session timeout', 'Preferred idle timeout in minutes. Existing server expiry behavior is unchanged.')}<div class="security-setting"><span><strong>Active sessions</strong><small>The current API does not expose a session list.</small></span><span class="security-status">Unavailable</span></div><div class="security-setting"><span><strong>Logout all devices</strong><small>The current logout API only ends this device session.</small></span><button type="button" class="secondary-button" data-logout-all disabled>Unavailable</button></div><div class="security-setting"><span><strong>Current device</strong><small>End this browser session.</small></span><button type="button" class="secondary-button" data-logout-current>Log out this device</button></div></div>
            </section>
            <section class="security-panel"><header><h3>Two-Factor Authentication</h3><p>The existing API stores this policy preference but does not issue a 2FA challenge.</p></header><div class="security-controls">${securityConfigControl('requireMfa', 'Require two-factor authentication', 'Save the organization policy preference.', 'checkbox')}</div></section>
            <section class="security-panel"><header><h3>Login Security</h3><p>Configure existing failed-login and password policy settings.</p></header><div class="security-controls">${securityConfigControl('autoLockAfterFailedAttempts', 'Failed login protection', 'Number of failed attempts before account protection applies.')}${securityConfigControl('passwordPolicy', 'Password policy', 'Policy preference used for account security.', 'select')}${securityConfigControl('allowSelfSignup', 'Allow self-signup', 'Allow new users to request CRM access.', 'checkbox')}${securityConfigControl('requireManagerApproval', 'Require manager approval', 'Require review before new accounts are activated.', 'checkbox')}</div></section>
            <section class="security-panel"><header><h3>Login History</h3><p>Recent login events recorded in the existing audit log.</p></header>${renderLoginHistory()}</section>
            <section class="security-panel"><header><h3>Additional Security Preferences</h3><p>Existing audit and sensitive-field preferences.</p></header><div class="security-controls">${securityConfigControl('hideSensitiveFields', 'Hide sensitive fields', 'Mask sensitive values in CRM views.', 'checkbox')}${securityConfigControl('auditRetentionDays', 'Audit retention (days)', 'Configured audit record retention preference.')}</div></section>
        </div>`;
    }

    function renderField(item, key) {
        const group = state.currentSettings[item.category] || {};
        const value = group[key];
        const type = fieldType(key, value);
        const path = `${item.category}.${key}`;
        const label = makeLabel(key);
        const fieldId = `field-${item.id}-${key}`;
        if (type === 'checkbox') return `<label class="toggle-field" for="${fieldId}"><span><strong>${escapeHtml(label)}</strong></span><input id="${fieldId}" data-setting-path="${path}" type="checkbox" ${value ? 'checked' : ''} /><span class="toggle-track" aria-hidden="true"></span></label>`;
        if (type === 'select') {
            const options = selectOptions[key] || [];
            const allOptions = value && !options.includes(value) ? [value, ...options] : options;
            return `<label class="field" for="${fieldId}"><span class="field-label">${escapeHtml(label)}</span><select id="${fieldId}" data-setting-path="${path}">${allOptions.map((option) => `<option value="${escapeHtml(option)}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
        }
        if (type === 'textarea' || type === 'array') {
            const textValue = Array.isArray(value) ? value.join(', ') : value ?? '';
            return `<label class="field field-wide" for="${fieldId}"><span class="field-label">${escapeHtml(label)}</span><textarea id="${fieldId}" data-setting-path="${path}" rows="${type === 'array' ? 2 : 3}" placeholder="${type === 'array' ? 'Separate items with commas' : ''}">${escapeHtml(textValue)}</textarea></label>`;
        }
        const displayValue = type === 'password' ? '' : value ?? '';
        const placeholder = type === 'password' && value ? 'Configured; leave blank to keep current' : '';
        return `<label class="field" for="${fieldId}"><span class="field-label">${escapeHtml(label)}</span><input id="${fieldId}" data-setting-path="${path}" type="${type}" value="${escapeHtml(displayValue)}" placeholder="${placeholder}" ${type === 'number' ? 'step="any"' : ''} /></label>`;
    }

    function renderStaffList() {
        const data = state.extraData.staff;
        if (data?.error) return `<div class="empty-state">${iconSvg('lock')}<strong>Staff list unavailable</strong><span>${escapeHtml(data.error)}</span></div>`;
        if (!data?.staff?.length) return `<div class="empty-state">${iconSvg('group')}<strong>No staff records found</strong><span>New team members will appear here.</span></div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Status</th></tr></thead><tbody>${data.staff.map((staff) => `<tr><td>${escapeHtml(staff.name)}</td><td>${escapeHtml(staff.role)}</td><td>${escapeHtml(staff.department || '-')}</td><td>${escapeHtml(staff.accountStatus || staff.status || 'Unknown')}</td></tr>`).join('')}</tbody></table></div><a class="text-link" href="staff.html">Open staff management ${iconSvg('arrow_outward')}</a>`;
    }

    function renderSignupRequests() {
        const data = state.extraData.requests;
        if (data?.error) return `<div class="empty-state">${iconSvg('lock')}<strong>Requests unavailable</strong><span>${escapeHtml(data.error)}</span></div>`;
        if (!data?.requests?.length) return `<div class="empty-state">${iconSvg('inbox')}<strong>No signup requests</strong><span>There are no access requests to review.</span></div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Applicant</th><th>Email</th><th>Status</th><th>Requested</th></tr></thead><tbody>${data.requests.slice(0, 20).map((request) => `<tr><td>${escapeHtml(request.full_name)}</td><td>${escapeHtml(request.email)}</td><td>${escapeHtml(request.status)}</td><td>${escapeHtml(new Date(request.created_at).toLocaleDateString())}</td></tr>`).join('')}</tbody></table></div><a class="text-link" href="staff.html">Review access requests ${iconSvg('arrow_outward')}</a>`;
    }

    function renderPermissions(item) {
        const permissions = state.draftPermissions || normalizePermissionMatrix(state.currentSettings.rolesPermissions?.permissions);
        return `<div class="permission-intro">${iconSvg('info')}<p>Admin/Owner is locked to full access. Existing server checks continue to restrict record visibility to team or assigned records for other roles.</p></div>
            <div class="role-cards">${ROLE_NAMES.map((role) => {
            const admin = role === 'Admin/Owner';
            const adminBadge = admin ? `<span class="locked-badge">${iconSvg('lock')}<span>Unrestricted</span></span>` : '';
            return `<section class="role-card"><header><div><h3>${escapeHtml(role)}</h3><p>${escapeHtml(ROLE_SCOPES[role])}</p></div>${adminBadge}</header><div class="permission-table-wrap"><table class="permission-table"><thead><tr><th>Area</th>${RESOURCE_PERMISSIONS[0].actions.map((action) => `<th>${escapeHtml(action)}</th>`).join('')}</tr></thead><tbody>${RESOURCE_PERMISSIONS.map((resource) => `<tr><th scope="row">${escapeHtml(resource.label)}</th>${RESOURCE_PERMISSIONS[0].actions.map((action) => {
                if (!resource.actions.includes(action)) return '<td><span class="not-applicable" aria-label="Not applicable">-</span></td>';
                const checked = permissions[role]?.[resource.id]?.[action] === true || admin;
                return `<td><input type="checkbox" data-permission-role="${escapeHtml(role)}" data-permission-resource="${resource.id}" data-permission-action="${action}" aria-label="${escapeHtml(`${role} ${resource.label} ${action}`)}" ${checked ? 'checked' : ''} ${admin ? 'disabled' : ''} /></td>`;
            }).join('')}</tr>`).join('')}</tbody></table></div></section>`;
        }).join('')}</div>`;
    }

    function normalizePermissionMatrix(incoming) {
        const defaults = buildDefaultPermissions();
        ROLE_NAMES.forEach((role) => {
            RESOURCE_PERMISSIONS.forEach((resource) => {
                resource.actions.forEach((action) => {
                    const saved = incoming?.[role]?.[resource.id]?.[action];
                    if (typeof saved === 'boolean') defaults[role][resource.id][action] = saved;
                });
            });
        });
        defaults['Admin/Owner'] = buildDefaultPermissions()['Admin/Owner'];
        return defaults;
    }

    function renderLogTable(kind) {
        const data = state.extraData[kind];
        if (data?.error) return `<div class="empty-state">${iconSvg('error')}<strong>Unable to load records</strong><span>${escapeHtml(data.error)}</span></div>`;
        const rows = data?.rows || [];
        if (!rows.length) return `<div class="empty-state">${iconSvg(kind === 'audit' ? 'history' : 'check_circle')}<strong>${kind === 'audit' ? 'No audit entries yet' : 'No system errors'}</strong><span>${kind === 'audit' ? 'Recorded admin and CRM actions will appear here.' : 'The system has no recorded errors.'}</span></div>`;
        if (kind === 'audit') return `<div class="table-wrap"><table><thead><tr><th>User</th><th>Action</th><th>Record</th><th>Time</th></tr></thead><tbody>${rows.slice(0, 50).map((row) => `<tr><td>${escapeHtml(row.userName || row.userId || 'System')}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.recordType || 'General')} / ${escapeHtml(row.recordId || '-')}</td><td>${escapeHtml(new Date(row.createdAt).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Message</th><th>Created</th></tr></thead><tbody>${rows.slice(0, 50).map((row) => `<tr><td>${escapeHtml(row.message)}${row.details ? `<small class="log-details">${escapeHtml(row.details)}</small>` : ''}</td><td>${escapeHtml(new Date(row.createdAt).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderSystemInfo() {
        const info = state.extraData.system?.systemInfo;
        if (state.extraData.system?.error) return `<div class="empty-state">${iconSvg('error')}<strong>System information unavailable</strong><span>${escapeHtml(state.extraData.system.error)}</span></div>`;
        if (!info) return '<div class="loading-state"><span class="spinner"></span>Loading system information...</div>';
        const entries = [['Node.js', info.nodeVersion], ['Platform', `${info.platform} (${info.arch})`], ['Uptime', `${info.uptimeSeconds}s`], ['Memory', `${info.memoryUsageMb} MB`], ['Database', info.databaseMode], ['Health check', new Date(info.generatedAt).toLocaleString()]];
        return `<div class="info-grid">${entries.map(([label, value]) => `<div class="info-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`;
    }

    function renderSection() {
        const item = getItem(state.activeId) || getItem('my-profile');
        state.activeId = item.id;
        if (item.mode === 'permissions' && !state.draftPermissions) state.draftPermissions = normalizePermissionMatrix(state.currentSettings.rolesPermissions?.permissions);
        const breadcrumbGroup = item.group === 'ACCOUNT' ? 'Account' : item.group === 'USERS & ACCESS' ? 'Users & Access' : item.group;
        document.getElementById('settingsBreadcrumb').innerHTML = `<span>Settings</span><span aria-hidden="true">/</span><span>${escapeHtml(breadcrumbGroup)}</span><span aria-hidden="true">/</span><strong>${escapeHtml(item.label)}</strong>`;
        renderNavigation();
        const root = document.getElementById('settingsSection');
        if (state.filter && !`${item.label} ${item.group} ${item.description}`.toLowerCase().includes(state.filter.toLowerCase())) {
            root.innerHTML = `<div class="empty-state content-empty">${iconSvg('search_off')}<strong>No matching setting selected</strong><span>Choose a visible result from the sidebar.</span></div>`;
            return;
        }
        let body = '';
        if (item.mode === 'profile') body = renderProfileForm();
        else if (item.mode === 'security') body = renderSecuritySettings();
        else if (item.mode === 'permissions') body = renderPermissions(item);
        else if (item.mode === 'audit') body = renderLogTable('audit');
        else if (item.mode === 'errors') body = renderLogTable('errors');
        else if (item.mode === 'system') body = renderSystemInfo();
        else {
            const keys = getKeys(item);
            body = keys.length ? `<div class="field-grid">${keys.map((key) => renderField(item, key)).join('')}</div>` : `<div class="empty-state">${iconSvg('tune')}<strong>No settings are configured</strong><span>This category does not currently contain editable settings.</span></div>`;
            if (item.source === 'staff') body += `<div class="related-data"><h3>Current team</h3>${renderStaffList()}</div>`;
            if (item.source === 'requests') body += `<div class="related-data"><h3>Recent access requests</h3>${renderSignupRequests()}</div>`;
        }
        const readOnly = ['audit', 'errors', 'system'].includes(item.mode);
        root.innerHTML = `<section class="settings-card" data-category="${escapeHtml(item.group)}">
            <header class="card-heading"><div><div class="title-line"><span class="section-icon">${iconSvg(item.icon)}</span><h2>${escapeHtml(item.label)}</h2></div><p>${escapeHtml(item.description)}</p></div></header>
            ${body}
            ${readOnly ? '' : `<footer class="card-actions"><button type="button" class="secondary-button" data-cancel>Cancel</button><button type="button" class="primary-button" data-save ${item.mode === 'profile' && !state.extraData.profile?.profile ? 'disabled' : ''}>Save Changes</button></footer>`}
        </section>`;
        root.querySelector('[data-save]')?.addEventListener('click', () => item.mode === 'profile' ? saveProfile() : saveSection(item));
        root.querySelector('[data-cancel]')?.addEventListener('click', () => cancelSection(item));
        root.querySelector('[data-profile-save]')?.addEventListener('click', saveProfile);
        root.querySelector('[data-profile-cancel]')?.addEventListener('click', () => cancelSection(item));
        root.querySelector('[data-photo-change]')?.addEventListener('click', () => root.querySelector('[data-profile-photo]').click());
        root.querySelector('[data-profile-photo]')?.addEventListener('change', handleProfilePhoto);
        root.querySelector('[data-photo-remove]')?.addEventListener('click', removeProfilePhoto);
        root.querySelector('[data-change-password]')?.addEventListener('click', changeSecurityPassword);
        root.querySelector('[data-logout-current]')?.addEventListener('click', logoutCurrentDevice);
        root.querySelectorAll('[data-permission-role]').forEach((input) => input.addEventListener('change', () => {
            const { permissionRole, permissionResource, permissionAction } = input.dataset;
            if (permissionRole === 'Admin/Owner') { input.checked = true; return; }
            state.draftPermissions[permissionRole][permissionResource][permissionAction] = input.checked;
        }));
        root.querySelectorAll('[data-setting-path]').forEach((input) => input.addEventListener('change', () => input.closest('.settings-card')?.classList.add('is-dirty')));
        if (item.mode === 'permissions') root.querySelector('.settings-card')?.classList.add('is-dirty');
    }

    function selectSection(id) {
        state.activeId = id;
        state.draftPermissions = null;
        renderSection();
        loadExtra(getItem(id));
        const content = document.getElementById('settingsContent');
        if (content) content.scrollTop = 0;
    }

    function parseField(input) {
        if (input.type === 'checkbox') return input.checked;
        if (input.type === 'number') return input.value === '' ? '' : Number(input.value);
        if (input.dataset.settingPath.endsWith('.stages') || input.dataset.settingPath.endsWith('.allowedWattage') || input.dataset.settingPath.endsWith('.allowedPhases') || input.dataset.settingPath.endsWith('.allowedTypes') || input.dataset.settingPath.endsWith('.paymentReminderDays') || input.dataset.settingPath.endsWith('.fileCategoryLabels') || input.dataset.settingPath.endsWith('.widgets')) {
            return input.value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => /^\d+$/.test(entry) ? Number(entry) : entry);
        }
        return input.value;
    }

    function collectSettings(item) {
        const patch = {};
        document.querySelectorAll('#settingsSection [data-setting-path]').forEach((input) => {
            const path = input.dataset.settingPath.split('.');
            const key = path[1];
            const value = parseField(input);
            if (input.type === 'password' && !value) return;
            patch[key] = value;
        });
        if (item.mode === 'permissions') {
            patch.permissions = normalizePermissionMatrix(state.draftPermissions || state.currentSettings.rolesPermissions?.permissions);
            patch.roleScopes = ROLE_SCOPES;
        }
        return { [item.category]: patch };
    }

    function isSensitivePatch(payload) {
        const security = payload.security || {};
        const integration = payload.integrations || {};
        const email = payload.emailSettings || {};
        const whatsapp = payload.whatsappSettings || {};
        const roles = payload.rolesPermissions || {};
        return Object.keys(security).length > 0
            || Object.keys(integration).some((key) => /enabled|token|secret|apikey|webhook/i.test(key))
            || Object.keys(email).some((key) => /password|enabled/i.test(key))
            || Object.keys(whatsapp).some((key) => /apikey|enabled/i.test(key))
            || Boolean(roles.permissions);
    }

    function confirmChange(message) {
        return new Promise((resolve) => {
            const layer = document.getElementById('confirmLayer');
            document.getElementById('confirmMessage').textContent = message;
            layer.hidden = false;
            const finish = (answer) => {
                layer.hidden = true;
                document.getElementById('confirmCancel').removeEventListener('click', cancel);
                document.getElementById('confirmAccept').removeEventListener('click', accept);
                layer.removeEventListener('click', backdrop);
                resolve(answer);
            };
            const cancel = () => finish(false);
            const accept = () => finish(true);
            const backdrop = (event) => { if (event.target === layer) finish(false); };
            document.getElementById('confirmCancel').addEventListener('click', cancel);
            document.getElementById('confirmAccept').addEventListener('click', accept);
            layer.addEventListener('click', backdrop);
            document.getElementById('confirmAccept').focus();
        });
    }

    async function saveSection(item) {
        const button = document.querySelector('[data-save]');
        const payload = collectSettings(item);
        if (isSensitivePatch(payload) && !(await confirmChange('This section changes access controls or connected services. Save these changes?'))) return;
        button.disabled = true;
        button.classList.add('is-loading');
        button.innerHTML = '<span class="spinner small"></span>Saving...';
        try {
            const result = await crmApi.request('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
            state.currentSettings = deepMerge(state.currentSettings, result.settings || payload);
            state.draftPermissions = null;
            showToast(`${item.label} saved successfully.`, 'success');
            renderSection();
        } catch (error) {
            showToast(error.message || 'Unable to save settings.', 'error');
            button.disabled = false;
            button.classList.remove('is-loading');
            button.textContent = 'Save Changes';
        }
    }

    function cancelSection(item) {
        state.draftPermissions = null;
        if (item.mode === 'profile') {
            const profile = state.extraData.profile?.profile;
            state.profilePhoneDraft = localStorage.getItem(getProfileStorageKey(profile, 'phone')) || '';
            state.profilePhotoDraft = localStorage.getItem(getProfileStorageKey(profile, 'photo')) || '';
        }
        renderSection();
        showToast(`${item.label} changes cancelled.`, 'neutral');
    }

    async function saveProfile() {
        const profile = state.extraData.profile?.profile;
        const saveButton = document.querySelector('[data-save]');
        if (!profile || !saveButton) return;
        const name = document.getElementById('profile-name').value.trim();
        const email = document.getElementById('profile-email').value.trim();
        const phone = document.getElementById('profile-phone').value.trim();
        const preferences = {};
        ['timezone', 'language', 'signature'].forEach((key) => {
            const input = document.querySelector(`[data-setting-path="myProfile.${key}"]`);
            if (input) preferences[key] = parseField(input);
        });
        saveButton.disabled = true;
        saveButton.innerHTML = 'Saving...';
        try {
            const result = await crmApi.updateProfile({ name, email });
            if (Object.keys(preferences).length) {
                const settingsResult = await crmApi.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ myProfile: preferences }) });
                state.currentSettings = deepMerge(state.currentSettings, settingsResult.settings || { myProfile: preferences });
            }
            state.extraData.profile = { profile: result.profile };
            state.profilePhoneDraft = phone;
            localStorage.setItem(getProfileStorageKey(result.profile, 'phone'), phone);
            if (state.profilePhotoDraft) localStorage.setItem(getProfileStorageKey(result.profile, 'photo'), state.profilePhotoDraft);
            else localStorage.removeItem(getProfileStorageKey(result.profile, 'photo'));
            document.getElementById('currentUserName').textContent = result.profile.name || 'Admin';
            showToast('Profile saved successfully.', 'success');
            renderSection();
        } catch (error) {
            showToast(error.message || 'Unable to save profile.', 'error');
            saveButton.disabled = false;
            saveButton.textContent = 'Save Changes';
        }
    }

    async function changeSecurityPassword() {
        const button = document.querySelector('[data-change-password]');
        const currentPassword = document.getElementById('securityCurrentPassword').value;
        const newPassword = document.getElementById('securityNewPassword').value;
        const confirmPassword = document.getElementById('securityConfirmPassword').value;
        if (!currentPassword || !newPassword || !confirmPassword) {
            showToast('Complete all password fields.', 'error');
            return;
        }
        button.disabled = true;
        button.textContent = 'Changing...';
        try {
            const result = await crmApi.changePassword({ currentPassword, newPassword, confirmPassword });
            ['securityCurrentPassword', 'securityNewPassword', 'securityConfirmPassword'].forEach((id) => { document.getElementById(id).value = ''; });
            showToast(result.message || 'Password changed successfully.', 'success');
        } catch (error) {
            showToast(error.message || 'Unable to change password.', 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'Change Password';
        }
    }

    async function logoutCurrentDevice() {
        try { await crmApi.request('/api/auth/logout', { method: 'POST' }); } catch (error) { console.error(error); }
        ['solarflow_crm_current_user', 'solarflow_crm_api_token'].forEach((key) => { localStorage.removeItem(key); sessionStorage.removeItem(key); });
        window.top.location.href = 'login.html';
    }

    function handleProfilePhoto(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
            showToast('Choose a JPG, PNG, or WebP image under 1 MB.', 'error');
            event.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            state.profilePhotoDraft = String(reader.result || '');
            const image = document.getElementById('profilePhotoImage');
            const initials = document.getElementById('profilePhotoInitials');
            image.src = state.profilePhotoDraft;
            image.hidden = false;
            initials.hidden = true;
            document.querySelector('[data-photo-remove]').disabled = false;
        });
        reader.addEventListener('error', () => showToast('Unable to read the selected photo.', 'error'));
        reader.readAsDataURL(file);
    }

    function removeProfilePhoto() {
        state.profilePhotoDraft = '';
        const image = document.getElementById('profilePhotoImage');
        const initials = document.getElementById('profilePhotoInitials');
        image.removeAttribute('src');
        image.hidden = true;
        initials.hidden = false;
        document.querySelector('[data-photo-remove]').disabled = true;
    }

    function showToast(message, type) {
        const region = document.getElementById('toastRegion');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `${iconSvg(type === 'error' ? 'error' : type === 'success' ? 'check_circle' : 'info')}<span>${escapeHtml(message)}</span>`;
        region.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4000);
    }

    async function loadExtra(item) {
        if (!item.source && !item.mode) return;
        try {
            if (item.mode === 'profile') {
                const result = await crmApi.getProfile();
                state.extraData.profile = { profile: result.profile };
                state.profilePhoneDraft = localStorage.getItem(getProfileStorageKey(result.profile, 'phone')) || '';
                state.profilePhotoDraft = localStorage.getItem(getProfileStorageKey(result.profile, 'photo')) || '';
                document.getElementById('currentUserName').textContent = result.profile.name || 'Admin';
                document.getElementById('currentUserRole').textContent = result.profile.role || 'Admin/Owner';
            }
            if (item.mode === 'security') state.extraData.securityAudit = await crmApi.request('/api/settings/audit-logs');
            if (item.source === 'staff') state.extraData.staff = await crmApi.getStaff();
            if (item.source === 'requests') state.extraData.requests = await crmApi.getAccessRequests();
            if (item.mode === 'audit') state.extraData.audit = await crmApi.request('/api/settings/audit-logs');
            if (item.mode === 'errors') state.extraData.errors = await crmApi.request('/api/settings/error-logs');
            if (item.mode === 'system') state.extraData.system = await crmApi.request('/api/settings/system-info');
        } catch (error) {
            const key = item.source || (item.mode === 'security' ? 'securityAudit' : item.mode);
            state.extraData[key] = { error: error.message || 'Unable to load data.' };
        }
        if (state.activeId === item.id) renderSection();
    }

    function renderSearchResults() {
        renderNavigation();
        const visibleItems = sectionGroups.flatMap((group) => group.items.filter((item) => !state.filter || `${item.label} ${group.label} ${item.description}`.toLowerCase().includes(state.filter.toLowerCase())));
        if (visibleItems.length && !visibleItems.some((item) => item.id === state.activeId)) selectSection(visibleItems[0].id);
        else renderSection();
    }

    function bindEvents() {
        document.getElementById('backBtn').addEventListener('click', () => { window.top.location.href = 'index.html'; });
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            try { await crmApi.request('/api/auth/logout', { method: 'POST' }); } catch (error) { console.error(error); }
            ['solarflow_crm_current_user', 'solarflow_crm_api_token'].forEach((key) => { localStorage.removeItem(key); sessionStorage.removeItem(key); });
            window.top.location.href = 'login.html';
        });
        const search = document.getElementById('settingsSearch');
        const clear = document.getElementById('clearSearch');
        search.addEventListener('input', () => { state.filter = search.value.trim(); clear.hidden = !state.filter; renderSearchResults(); });
        clear.addEventListener('click', () => { search.value = ''; state.filter = ''; clear.hidden = true; renderSearchResults(); search.focus(); });
        document.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                const item = getItem(state.activeId);
                if (item && !['audit', 'errors', 'system'].includes(item.mode)) saveSection(item);
            }
            if (event.key === 'Escape' && !document.getElementById('confirmLayer').hidden) document.getElementById('confirmCancel').click();
        });
    }

    async function loadSettings() {
        const warning = document.getElementById('accessWarning');
        try {
            const result = await crmApi.request('/api/settings');
            state.currentSettings = result.settings || {};
            warning.hidden = true;
            renderSection();
            loadExtra(getItem(state.activeId));
        } catch (error) {
            warning.textContent = error.message || 'Unable to load settings. Admin access is required.';
            warning.hidden = false;
            renderSection();
            loadExtra(getItem(state.activeId));
        }
    }

    function init() {
        renderShell();
        bindEvents();
        renderSection();
        loadSettings();
    }

    window.SettingsUI = { init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
