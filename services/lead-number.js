const LEAD_NUMBER_PATTERN = /^INP-[0-9]{6}$/;
const SQLITE_LEAD_NUMBER_GLOB = 'INP-[0-9][0-9][0-9][0-9][0-9][0-9]';

function isValidLeadNumber(value) {
    return LEAD_NUMBER_PATTERN.test(String(value || ''));
}

function publicLeadNumber(value) {
    return isValidLeadNumber(value) ? String(value) : null;
}

function nextLeadNumber(values) {
    let highest = null;
    for (const value of values || []) {
        if (!isValidLeadNumber(value)) continue;
        const sequence = Number(String(value).slice(4));
        if (highest === null || sequence > highest) highest = sequence;
    }
    const next = highest === null ? 100001 : highest + 1;
    return next > 999999 ? null : `INP-${String(next).padStart(6, '0')}`;
}

module.exports = { LEAD_NUMBER_PATTERN, SQLITE_LEAD_NUMBER_GLOB, isValidLeadNumber, publicLeadNumber, nextLeadNumber };