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
    { minimum: 3, maximum: 5, label: '3-4.99 kW', rateKey: 'tier3', subsidyRateKey: 'subsidyTier3', defaultSubsidyRate: 80000 },
    { minimum: 5, maximum: 8, label: '5-7.99 kW', rateKey: 'tier5', subsidyRateKey: 'subsidyTier5', defaultSubsidyRate: 75000 },
    { minimum: 8, maximum: 10, label: '8-9.99 kW', rateKey: 'tier8', subsidyRateKey: 'subsidyTier8', defaultSubsidyRate: 65000 },
    { minimum: 10, maximum: 15, inclusiveMaximum: true, label: '10-15 kW', rateKey: 'tier10', subsidyRateKey: null, defaultSubsidyRate: null }
];

const HYBRID_SLABS = [
    { minimum: 5, maximum: 8, label: '5-7.99 kW', rateKey: 'hybridTier5', batteryConfiguration: 'Single Battery' },
    { minimum: 8, maximum: 10, label: '8-9.99 kW', rateKey: 'hybridTier8', batteryConfiguration: 'Single Battery' },
    { minimum: 10, maximum: 10, inclusiveMaximum: true, label: '10 kW', rateKey: 'hybridTier10', batteryConfiguration: 'Double Battery' }
];

const LEGACY_PRICING = {
    tier3: [70000, 75000],
    tier5: [63000, 68000],
    tier8: [55000, 60000],
    tier10: [50000, 55000]
};

function amountInCents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * 100);
}

function migrateLegacySolarPricing(solarPricing = {}) {
    const migrated = { ...solarPricing };
    for (const [key, [oldRate, newRate]] of Object.entries(LEGACY_PRICING)) {
        if (Number(migrated[key]) === oldRate) migrated[key] = newRate;
    }
    return migrated;
}

function getProposalPricingSlab(systemCapacity, solarPricing = {}) {
    const capacity = Number(systemCapacity);
    const slab = CAPACITY_SLABS.find(({ minimum, maximum, inclusiveMaximum }) => capacity >= minimum && (inclusiveMaximum ? capacity <= maximum : capacity < maximum));
    if (!slab) return null;
    const rate = Number(solarPricing[slab.rateKey]);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const subsidyRate = slab.subsidyRateKey
        ? Number(solarPricing[slab.subsidyRateKey] ?? slab.defaultSubsidyRate)
        : null;
    return {
        ...slab,
        nonSubsidyRate: rate,
        subsidyRate: subsidyRate !== null && Number.isFinite(subsidyRate) && subsidyRate > 0 ? subsidyRate : null
    };
}

function allocateComponents(baseCents, otherChargesCents = 0) {
    const components = {};
    let allocatedCents = otherChargesCents;
    for (const [key, ratio] of Object.entries(COMPONENT_RATIOS)) {
        if (key === 'otherCharges') {
            components[key] = otherChargesCents;
            continue;
        }
        const cents = key === 'installation'
            ? baseCents - (allocatedCents - otherChargesCents)
            : Math.round(baseCents * ratio);
        components[key] = cents;
        allocatedCents += cents;
    }
    return components;
}

function proposalPricing(systemCapacity, solarPricing = {}, values = {}) {
    const capacity = Number(systemCapacity);
    const gstRate = Number(solarPricing.gstRate);
    if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) return null;

    const systemType = String(values.systemType || 'On-Grid');
    const pricingType = String(values.pricingType || 'Non-Subsidy');
    const isHybrid = systemType === 'Hybrid';
    const isOnGrid = systemType === 'On-Grid';
    const onGridSlab = getProposalPricingSlab(capacity, solarPricing);
    let slab;
    let rate;
    let pricingLabel = pricingType;
    let baseGrossCents;
    let surchargeCents = 0;

    if (isHybrid) {
        slab = HYBRID_SLABS.find(({ minimum, maximum, inclusiveMaximum }) => capacity >= minimum && (inclusiveMaximum ? capacity <= maximum : capacity < maximum));
        if (!slab || !['Non-Subsidy', 'Subsidy'].includes(pricingType)) return null;
        rate = Number(solarPricing[slab.rateKey]);
        if (!Number.isFinite(rate) || rate <= 0) return null;
        baseGrossCents = Math.round(capacity * rate * 100);
        const panelCount = Number(values.panelCount || 0);
        if (!Number.isInteger(panelCount) || panelCount < 0) return null;
        if (pricingType === 'Subsidy' && panelCount === 0) return null;
        const threePhase = /three[\s-]*phase/i.test(String(values.inverterPhase || ''));
        const extraBattery = values.extraBattery === true || values.extraBattery === 1 || values.extraBattery === 'true';
        if (pricingType === 'Subsidy') {
            surchargeCents = Math.round(panelCount * Number(solarPricing.hybridSubsidyPerPanel ?? 15000) * 100);
        }
        if (threePhase) surchargeCents += Math.round(Number(solarPricing.hybridThreePhaseCharge ?? 35000) * 100);
        if (extraBattery) surchargeCents += Math.round(Number(solarPricing.hybridExtraBatteryCharge ?? 115000) * 100);
        if (!Number.isSafeInteger(surchargeCents) || surchargeCents < 0) return null;
        pricingLabel = 'Hybrid';
    } else {
        if (!['On-Grid', 'Off-Grid'].includes(systemType) || !onGridSlab || !['Non-Subsidy', 'Subsidy'].includes(pricingType)) return null;
        slab = onGridSlab;
        rate = isOnGrid && pricingType === 'Subsidy' ? slab.subsidyRate : slab.nonSubsidyRate;
        if (!rate) return null;
        baseGrossCents = Math.round(capacity * rate * 100);
    }

    if (values.basePriceOverride !== undefined && values.basePriceOverride !== null && values.basePriceOverride !== '') {
        baseGrossCents = amountInCents(values.basePriceOverride);
        if (baseGrossCents === null || baseGrossCents <= 0) return null;
    }

    const hasOverrides = Object.keys(COMPONENT_RATIOS).some((key) => values[key] !== undefined && values[key] !== null && values[key] !== '');
    let components;
    let subtotalCents;
    let gstCents;
    let grossCents;
    if (hasOverrides) {
        components = {};
        for (const key of Object.keys(COMPONENT_RATIOS)) {
            const cents = amountInCents(values[key] ?? 0);
            if (cents === null) return null;
            components[key] = cents;
        }
        subtotalCents = Object.values(components).reduce((total, cents) => total + cents, 0);
        gstCents = Math.round(subtotalCents * gstRate / 100);
        grossCents = subtotalCents + gstCents;
    } else {
        const includedGstCents = gstRate === 0 ? 0 : Math.round(baseGrossCents * gstRate / (100 + gstRate));
        const baseNetCents = baseGrossCents - includedGstCents;
        components = allocateComponents(baseNetCents, surchargeCents);
        subtotalCents = Object.values(components).reduce((total, cents) => total + cents, 0);
        gstCents = includedGstCents + Math.round(surchargeCents * gstRate / 100);
        grossCents = subtotalCents + gstCents;
    }

    const discountRate = isOnGrid ? Number(solarPricing.onGridDiscountRate ?? 5) : 0;
    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) return null;
    const discountOverride = values.discountOverride === true || values.discountOverride === 'true';
    const discountCents = discountOverride
        ? amountInCents(values.discount ?? 0)
        : isHybrid
            ? 0
            : Math.round(grossCents * discountRate / 100);
    const subsidyCents = amountInCents(values.subsidy ?? 0);
    if (discountCents === null || subsidyCents === null) return null;

    const finalCents = Math.max(0, grossCents - discountCents);
    if (subsidyCents > finalCents) return null;
    const netCents = finalCents - subsidyCents;
    const asAmount = (cents) => cents / 100;
    return {
        pricingModel: 'updated-solar-pricing-v2',
        rate,
        slab: slab.label,
        systemType,
        pricingType: pricingLabel,
        gstRate,
        discountRate: discountOverride ? 0 : discountRate,
        discountOverride,
        batteryConfiguration: isHybrid ? slab.batteryConfiguration : '',
        hybridBasePrice: isHybrid ? asAmount(baseGrossCents) : 0,
        inverterPhase: String(values.inverterPhase || ''),
        extraBattery: isHybrid && (values.extraBattery === true || values.extraBattery === 1 || values.extraBattery === 'true'),
        isNegotiable: isHybrid,
        negotiableMessage: isHybrid ? 'Contact GM for final pricing' : '',
        hybridSubsidyPerPanel: isHybrid ? Number(solarPricing.hybridSubsidyPerPanel ?? 15000) : 0,
        hybridSubsidyCharge: isHybrid && pricingType === 'Subsidy' ? asAmount(Math.round(Number(values.panelCount || 0) * Number(solarPricing.hybridSubsidyPerPanel ?? 15000) * 100)) : 0,
        hybridThreePhaseCharge: isHybrid && /three[\s-]*phase/i.test(String(values.inverterPhase || '')) ? Number(solarPricing.hybridThreePhaseCharge ?? 35000) : 0,
        hybridExtraBatteryCharge: isHybrid && (values.extraBattery === true || values.extraBattery === 1 || values.extraBattery === 'true') ? Number(solarPricing.hybridExtraBatteryCharge ?? 115000) : 0,
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

function proposalCommercialLines(pricing, systemCapacity) {
    const format = (label, amount) => ({ label, amount: Number(amount || 0) });
    if (pricing.pricingModel === 'updated-solar-pricing-v2' && pricing.systemType === 'Hybrid') {
        const basePrice = Number(pricing.hybridBasePrice ?? Number(pricing.rate || 0) * Number(systemCapacity || 0));
        const includedGst = pricing.gstRate ? Math.round(basePrice * pricing.gstRate / (100 + pricing.gstRate) * 100) / 100 : 0;
        return [
            format('Hybrid system price (incl. GST)', basePrice),
            format('Per-panel hybrid charge', pricing.hybridSubsidyCharge),
            format('Three-phase charge', pricing.hybridThreePhaseCharge),
            format('Extra battery charge', pricing.hybridExtraBatteryCharge),
            format('GST on additional charges', Math.max(0, Number(pricing.gstAmount ?? pricing.gst) - includedGst)),
            format('Subtotal', pricing.baseAmount ?? pricing.subtotal),
            format(`GST @ ${pricing.gstRate}%`, pricing.gstAmount ?? pricing.gst),
            format('Gross Amount', pricing.calculatedTotal ?? pricing.grossAmount),
            format('Discount', pricing.discount),
            format('Final Payable', pricing.finalAmount),
            format('Net Investment', pricing.netInvestment)
        ];
    }

    if (pricing.solarPanels !== undefined) {
        return [
            format('Solar Panels', pricing.solarPanels),
            format('Inverter', pricing.inverter),
            format('Structure', pricing.structure),
            format('ACDB / DCDB', pricing.acdbDcdb),
            format('Earthing', pricing.earthing),
            format('Cables', pricing.cables),
            format('Installation', pricing.installation),
            format('Other Charges', pricing.otherCharges),
            format('Subtotal', pricing.baseAmount ?? pricing.subtotal),
            format(`GST @ ${pricing.gstRate}%`, pricing.gstAmount ?? pricing.gst),
            format('Gross Amount', pricing.calculatedTotal ?? pricing.grossAmount),
            format('Discount', pricing.discount),
            format('Final Payable', pricing.finalAmount),
            format('Subsidy Deduction', pricing.subsidyAmount ?? pricing.subsidy),
            format('Net Investment', pricing.netInvestment)
        ];
    }

    return [
        format('Rooftop solar Panels', pricing.panelAmount),
        format('Solar Inverter, Structure', pricing.inverterAmount),
        format('ACDB, DCDB, Earthing, Cables, ETC', pricing.acdbAmount),
        format('Total Price Before GST', pricing.baseAmount),
        format(`GST @ ${pricing.gstRate}%`, pricing.gstAmount),
        format('TOTAL PRICE INCLUDING GST', pricing.calculatedTotal),
        format('Discount', pricing.discount),
        format('Final Payable', pricing.finalAmount),
        format('Subsidy Deduction', pricing.subsidyAmount),
        format('Net Investment', pricing.netInvestment)
    ];
}

module.exports = { getProposalPricingSlab, migrateLegacySolarPricing, proposalCommercialLines, proposalPricing };
