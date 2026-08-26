const ZAPIER_EVENTS = new Set([
    'lead.created',
    'lead.assigned',
    'lead.updated',
    'lead.stage_changed',
    'followup.created',
    'followup.completed',
    'followup.rescheduled',
    'task.created',
    'task.completed',
    'site_survey.scheduled',
    'proposal.created',
    'opportunity.won',
    'opportunity.lost'
]);

function safePayload(payload = {}) {
    const forbidden = /password|token|secret|credential|database_url|webhook/i;
    const clean = (value) => {
        if (Array.isArray(value)) return value.map(clean);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).map(([key, child]) => [key, clean(child)]));
    };
    return clean(payload);
}

function triggerZapierEvent(eventType, payload = {}) {
    if (!ZAPIER_EVENTS.has(eventType)) return Promise.resolve({ sent: false, skipped: 'unsupported_event' });
    const webhookUrl = String(process.env.ZAPIER_WEBHOOK_URL || '').trim();
    if (!webhookUrl) return Promise.resolve({ sent: false, skipped: 'not_configured' });
    const body = JSON.stringify({ event: eventType, ...safePayload(payload) });
    return fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })
        .then((response) => ({ sent: response.ok, status: response.status }))
        .catch((error) => {
            console.error(`Zapier event ${eventType} failed:`, error.message);
            return { sent: false, skipped: 'unavailable' };
        });
}

module.exports = { ZAPIER_EVENTS, triggerZapierEvent };
