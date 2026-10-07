function normalizeLeadScoreValue(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value).trim();
    if (!text) return 0;
    const numeric = Number(text.replace(/[₹,\s]/g, '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : 0;
}

function parseLeadDetails(lead) {
    if (!lead) return {};
    if (lead.details && typeof lead.details === 'object' && !Array.isArray(lead.details)) return lead.details;
    if (lead.details_json && typeof lead.details_json === 'string') {
        try {
            const parsed = JSON.parse(lead.details_json);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (error) {
            return {};
        }
    }
    if (lead.detailsJson && typeof lead.detailsJson === 'object') return lead.detailsJson;
    return {};
}

function getLeadScoreSnapshot(lead) {
    const details = parseLeadDetails(lead);
    const monthlyBill = normalizeLeadScoreValue(
        lead?.monthly_bill ??
        lead?.monthlyBill ??
        details.monthly_bill ??
        details.monthlyBill ??
        details.electricityBill ??
        details.monthlyElectricityBill ??
        details.currentBill ??
        details.electricity_bill
    );
    const propertyType = String(
        lead?.property_type ??
        lead?.propertyType ??
        details.property_type ??
        details.propertyType ??
        details.property ??
        ''
    ).trim();
    const location = String(
        lead?.location ??
        lead?.bengaluru_zone ??
        details.location ??
        details.city ??
        details.bengaluruZone ??
        details.bengaluru_zone ??
        ''
    ).trim();
    const roofAvailable = String(
        lead?.roof_available ??
        lead?.roofAvailable ??
        details.roof_available ??
        details.roofAvailable ??
        details.roofAvailableStatus ??
        ''
    ).trim().toLowerCase();
    const solarInterest = String(
        lead?.interested_in_solar ??
        lead?.interestedInSolar ??
        details.interested_in_solar ??
        details.interestedInSolar ??
        details.solarInterest ??
        ''
    ).trim().toLowerCase();
    const decisionMaker = String(
        lead?.decision_maker ??
        lead?.decisionMaker ??
        details.decision_maker ??
        details.decisionMaker ??
        ''
    ).trim().toLowerCase();
    const surveyStatus = String(
        lead?.site_survey_status ??
        lead?.siteSurveyStatus ??
        details.site_survey_status ??
        details.siteSurveyStatus ??
        details.surveyStatus ??
        lead?.stage ??
        ''
    ).trim().toLowerCase();

    let score = 0;

    if (monthlyBill > 10000) score += 30;
    else if (monthlyBill > 5000) score += 20;
    else if (monthlyBill > 3000) score += 15;
    else if (monthlyBill > 1500) score += 10;
    else if (monthlyBill > 0) score += 5;

    if (propertyType && /own|house|villa|individual|home/i.test(propertyType)) score += 20;

    if (location && /bengaluru|bangalore/i.test(location)) score += 10;

    if (roofAvailable && /yes|true|available|present|ready|roof/i.test(roofAvailable)) score += 10;

    if (solarInterest && /yes|true|interested|ready|install|solar/i.test(solarInterest)) score += 10;

    if (decisionMaker && /yes|true|owner|decision|yes,|decision-maker|self/i.test(decisionMaker)) score += 10;

    if (surveyStatus && /(site survey|survey.*(agreed|scheduled|started|completed)|agreed|completed)/i.test(surveyStatus)) score += 20;

    const boundedScore = Math.max(0, Math.min(100, Number(score) || 0));
    return {
        leadScore: boundedScore,
        leadCategory: getLeadCategory(boundedScore),
        monthlyBill,
        propertyType,
        location,
        roofAvailable: roofAvailable ? (roofAvailable.includes('yes') || roofAvailable.includes('true') || roofAvailable.includes('available') ? 'Yes' : 'No') : null,
        interestedInSolar: solarInterest ? (solarInterest.includes('yes') || solarInterest.includes('true') || solarInterest.includes('interested') ? 'Yes' : 'No') : null,
        decisionMaker: decisionMaker ? (decisionMaker.includes('yes') || decisionMaker.includes('true') || decisionMaker.includes('owner') ? 'Yes' : 'No') : null,
        bengaluruZone: location && /north/i.test(location) ? 'North Bangalore' : location && /south/i.test(location) ? 'South Bangalore' : location && /east/i.test(location) ? 'East Bangalore' : location && /west/i.test(location) ? 'West Bangalore' : location && /central/i.test(location) ? 'Central Bangalore' : null,
        siteSurveyStatus: surveyStatus || null
    };
}

function getLeadCategory(score) {
    if (score >= 80) return 'Very Hot';
    if (score >= 70) return 'Hot';
    if (score >= 50) return 'Warm';
    if (score >= 30) return 'Cold';
    return 'Low';
}

function calculateLeadScore(lead) {
    return getLeadScoreSnapshot(lead).leadScore;
}

module.exports = {
    calculateLeadScore,
    getLeadCategory,
    getLeadScoreSnapshot,
    parseLeadDetails,
    normalizeLeadScoreValue
};
