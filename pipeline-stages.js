const OPPORTUNITY_STAGES = [
    'Qualified',
    'Survey Pending',
    'Survey Completed',
    'Proposal',
    'Negotiation',
    'Decision Pending',
    'Won',
    'Lost'
];

const OPPORTUNITY_STAGE_ALIASES = {
    Qualification: 'Qualified',
    'Site Visit Scheduled': 'Survey Pending',
    'Site Visit Completed': 'Survey Completed',
    'Order Booked': 'Decision Pending',
    'Loan Approval': 'Decision Pending',
    Closed: 'Won',
    Converted: 'Won'
};

function normalizeOpportunityStage(stage) {
    const value = String(stage || '').trim();
    if (OPPORTUNITY_STAGES.includes(value)) return value;
    return OPPORTUNITY_STAGE_ALIASES[value] || null;
}

module.exports = { OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_ALIASES, normalizeOpportunityStage };
