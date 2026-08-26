# Zapier Integration

The server-side helper in `integrations/zapier.js` exposes `triggerZapierEvent(eventType, payload)`. It supports:

- `lead.created`
- `lead.assigned`
- `lead.updated`
- `lead.stage_changed`
- `followup.created`
- `followup.completed`
- `followup.rescheduled`
- `task.created`
- `task.completed`
- `site_survey.scheduled`
- `proposal.created`
- `opportunity.won`
- `opportunity.lost`

Set `ZAPIER_WEBHOOK_URL` only in the server environment. It must never be placed in HTML, `crm-api.js`, browser storage, or committed to Git.

The helper filters secret-like keys, uses a five-second timeout, and resolves with a failure result when Zapier is unavailable. CRM database writes must remain the primary operation; callers should trigger events after a successful commit and must not await Zapier as part of the transaction.

Example server-side usage:

```js
const { triggerZapierEvent } = require('./integrations/zapier');

await triggerZapierEvent('followup.completed', {
    leadId,
    opportunityNumber,
    customerName,
    ownerId,
    outcome,
    completedAt
});
```

The current CRM routes are intentionally unchanged in this preparation phase. Event calls should be added as a follow-up to each successful database mutation during the repository refactor.
