window.crmApi = {
    token() {
        return localStorage.getItem('solarflow_crm_api_token') || sessionStorage.getItem('solarflow_crm_api_token') || '';
    },
    async request(path, options = {}) {
        const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
        const token = this.token();
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(path, { ...options, headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body.error || 'Unable to complete CRM request.');
            error.fields = Array.isArray(body.fields) ? body.fields : [];
            error.missing = Array.isArray(body.missing) ? body.missing : [];
            throw error;
        }
        return body;
    },
    getLeads() {
        return this.request('/api/leads');
    },
    getLead(leadId) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}`);
    },
    getLeadHistory(leadId) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/history`);
    },
    leadAction(leadId, action, details = {}) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/actions`, { method: 'POST', body: JSON.stringify({ action, ...details }) });
    },
    completeStage(leadId, details = {}) {
        return this.leadAction(leadId, 'complete-stage', details);
    },
    getDashboard(period = 'all') {
        return this.request(`/api/dashboard?period=${encodeURIComponent(period)}`);
    },
    getTasks() {
        return this.request('/api/tasks');
    },
    getSurveys() {
        return this.request('/api/surveys');
    },
    updateSurvey(surveyId, changes) {
        return this.request(`/api/surveys/${encodeURIComponent(surveyId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    },
    updateTask(taskId, changes) {
        return this.request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    },
    completeTask(taskId) {
        return this.request(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST', body: JSON.stringify({}) });
    },
    search(query) {
        return this.request(`/api/search?q=${encodeURIComponent(query)}`);
    },
    getNotifications() {
        return this.request('/api/notifications');
    },
    markNotificationRead(notificationId) {
        return this.request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' });
    },
    markAllNotificationsRead() {
        return this.request('/api/notifications/read-all', { method: 'POST' });
    },
    getProfile() {
        return this.request('/api/profile');
    },
    changePassword(details) {
        return this.request('/api/profile/password', { method: 'POST', body: JSON.stringify(details) });
    },
    getCurrentUser() {
        return this.request('/api/auth/me');
    },
    getAssignableStaff() {
        return this.request('/api/staff/assignable');
    },
    getStaff() {
        return this.request('/api/staff');
    },
    getAccessRequests() {
        return this.request('/api/admin/access-requests');
    },
    getAccessRequest(requestId) {
        return this.request(`/api/admin/access-requests/${encodeURIComponent(requestId)}`);
    },
    approveAccessRequest(requestId) {
        return this.request(`/api/admin/access-requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST', body: JSON.stringify({}) });
    },
    rejectAccessRequest(requestId, reason = '') {
        return this.request(`/api/admin/access-requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    },
    createStaff(staff) {
        return this.request('/api/staff', { method: 'POST', body: JSON.stringify(staff) });
    },
    updateStaff(staffId, changes) {
        return this.request(`/api/staff/${encodeURIComponent(staffId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    },
    deleteStaff(staffId) {
        return this.request(`/api/staff/${encodeURIComponent(staffId)}`, { method: 'DELETE' });
    },
    updateLead(leadId, changes) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    },
    addFollowUp(leadId, followUp) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/follow-ups`, { method: 'POST', body: JSON.stringify(followUp) });
    },
    assignLead(leadId, assignedTo) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/assignment`, { method: 'POST', body: JSON.stringify({ assignedTo }) });
    },
    completeFollowUp(followUpId, details) {
        return this.request(`/api/follow-ups/${encodeURIComponent(followUpId)}/complete`, { method: 'POST', body: JSON.stringify(details) });
    },
    saveSurvey(leadId, survey) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/survey`, { method: 'POST', body: JSON.stringify(survey) });
    },
    getAudit(leadId) {
        return this.request(`/api/leads/${encodeURIComponent(leadId)}/audit`);
    },
    getInventoryDashboard() {
        return this.request('/api/inventory/dashboard');
    },
    getInventoryItems() {
        return this.request('/api/inventory/items');
    },
    createInventoryItem(item) {
        return this.request('/api/inventory/items', { method: 'POST', body: JSON.stringify(item) });
    },
    stockIn(details) {
        return this.request('/api/inventory/stock-in', { method: 'POST', body: JSON.stringify(details) });
    },
    stockOut(details) {
        return this.request('/api/inventory/stock-out', { method: 'POST', body: JSON.stringify(details) });
    },
    getInventoryHistory() {
        return this.request('/api/inventory/history');
    },
    getMaterialRequests() {
        return this.request('/api/inventory/material-requests');
    },
    createMaterialRequest(details) {
        return this.request('/api/inventory/material-requests', { method: 'POST', body: JSON.stringify(details) });
    },
    updateMaterialRequest(requestId, changes) {
        return this.request(`/api/inventory/material-requests/${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    }
};
