const COMPONENT_RATIOS = {
    solarPanels: 0.40,
    inverter: 0.25,
    structure: 0.10,
    acdbDcdb: 0.08,
    earthing: 0.03,
    cables: 0.04,
    installation: 0.10,
    otherCharges: 0
};

const CAPACITY_SLABS = [
    { minimum: 3, maximum: 5, label: '3-4.99 kW', rateKey: 'tier3', subsidyRate: 80000 },
    { minimum: 5, maximum: 8, label: '5-7.99 kW', rateKey: 'tier5', subsidyRate: 75000 },
    { minimum: 8, maximum: 10, label: '8-9.99 kW', rateKey: 'tier8', subsidyRate: 65000 },
    { minimum: 10, maximum: 15, inclusiveMaximum: true, label: '10-15 kW', rateKey: 'tier10', subsidyRate: null }
];

function amountInCents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * 100);
}

function getProposalPricingSlab(systemCapacity, solarPricing = {}) {
    const capacity = Number(systemCapacity);
    const slab = CAPACITY_SLABS.find(({ minimum, maximum, inclusiveMaximum }) => capacity >= minimum && (inclusiveMaximum ? capacity <= maximum : capacity < maximum));
    if (!slab) return null;
    const rate = Number(solarPricing[slab.rateKey]);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return { ...slab, nonSubsidyRate: rate };
}

function proposalPricing(systemCapacity, solarPricing = {}, values = {}) {
    const capacity = Number(systemCapacity);
    const slab = getProposalPricingSlab(capacity, solarPricing);
    const gstRate = Number(solarPricing.gstRate);
    if (!slab || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) return null;

    const baseCents = Math.round(capacity * slab.nonSubsidyRate * 100);
    const components = {};
    let allocatedCents = 0;
    const hasOverrides = Object.keys(COMPONENT_RATIOS).some((key) => values[key] !== undefined);
    for (const [key, ratio] of Object.entries(COMPONENT_RATIOS)) {
        if (values[key] !== undefined) {
            const cents = amountInCents(values[key]);
            if (cents === null) return null;
            components[key] = cents;
        } else {
            const cents = key === 'installation' && !hasOverrides
                ? baseCents - allocatedCents
                : Math.round(baseCents * ratio);
            components[key] = cents;
        }
        allocatedCents += components[key];
    }

    const subtotalCents = Object.values(components).reduce((total, cents) => total + cents, 0);
    const gstCents = Math.round(subtotalCents * gstRate / 100);
    const discountCents = amountInCents(values.discount ?? 0);
    const subsidyCents = amountInCents(values.subsidy ?? 0);
    if (discountCents === null || subsidyCents === null) return null;

    const grossCents = subtotalCents + gstCents;
    const finalCents = Math.max(0, grossCents - discountCents);
    const netCents = Math.max(0, finalCents - subsidyCents);
    const asAmount = (cents) => cents / 100;
    return {
        rate: slab.nonSubsidyRate,
        slab: slab.label,
        gstRate,
        ...Object.fromEntries(Object.entries(components).map(([key, cents]) => [key, asAmount(cents)])),
        subtotal: asAmount(subtotalCents),
        gst: asAmount(gstCents),
        grossAmount: asAmount(grossCents),
        discount: asAmount(discountCents),
        finalAmount: asAmount(finalCents),
        subsidy: asAmount(subsidyCents),
        netInvestment: asAmount(netCents)
    };
}

module.exports = { getProposalPricingSlab, proposalPricing };