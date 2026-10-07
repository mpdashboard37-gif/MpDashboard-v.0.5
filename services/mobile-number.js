function normalizeIndianMobileNumber(value) {
    let digits = String(value || '').replace(/[^0-9]/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

function maskIndianMobileNumber(value) {
    const normalized = normalizeIndianMobileNumber(value);
    return normalized ? `XXXXXXX${normalized.slice(-3)}` : 'XXXXXXXXXX';
}

module.exports = { normalizeIndianMobileNumber, maskIndianMobileNumber };