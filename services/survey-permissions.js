const SURVEY_REQUEST_ROLES = new Set(['Admin/Owner', 'Sales Manager', 'GM/AGM', 'Sales Executive', 'Telecaller']);
const SURVEY_MANAGER_ROLES = new Set(['Admin/Owner', 'Sales Manager', 'GM/AGM']);

function canViewSurvey(user, survey, canAccessLead, isAdminUser) {
    if (!user || !survey) return false;
    if (isAdminUser(user)) return true;
    const lead = { assigned_to: survey.lead_owner_id };
    if (user.role === 'Sales Manager' || user.role === 'GM/AGM' || user.role === 'Telecaller') return canAccessLead(user, lead);
    if (user.role === 'Sales Executive') return survey.assigned_to === user.id || survey.lead_owner_id === user.id;
    return survey.assigned_to === user.id;
}

function canEditSurvey(user, survey, canAccessLead, isAdminUser) {
    if (!canViewSurvey(user, survey, canAccessLead, isAdminUser) || user.role === 'Telecaller') return false;
    return SURVEY_MANAGER_ROLES.has(user.role) || survey.assigned_to === user.id;
}

function canCreateSurveyRequest(user, lead, canAccessLead, isAdminUser) {
    return !!user && !!lead && SURVEY_REQUEST_ROLES.has(user.role) && canAccessLead(user, lead);
}

function canAssignSurvey(user, isAdminUser) {
    return !!user && (isAdminUser(user) || user.role === 'Sales Manager' || user.role === 'GM/AGM');
}

module.exports = { canViewSurvey, canEditSurvey, canCreateSurveyRequest, canAssignSurvey };
