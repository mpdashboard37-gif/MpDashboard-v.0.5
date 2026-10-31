const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getProposalPricingSlab, migrateLegacySolarPricing, proposalCommercialLines, proposalPricing } = require('./proposal-pricing');

const solarPricing = {
    tier3: 75000,
    tier5: 68000,
    tier8: 60000,
    tier10: 55000,
    subsidyTier3: 80000,
    subsidyTier5: 75000,
    subsidyTier8: 65000,
    hybridTier5: 97000,
    hybridTier8: 90000,
    hybridTier10: 90000,
    hybridThreePhaseCharge: 35000,
    hybridExtraBatteryCharge: 115000,
    hybridSubsidyPerPanel: 15000,
    onGridDiscountRate: 5,
    gstRate: 5
};

test('selects on-grid slab rates at every capacity boundary', () => {
    for (const [capacity, nonSubsidyRate, subsidyRate, slab] of [
        [3, 75000, 80000, '3-4.99 kW'],
        [3.9, 75000, 80000, '3-4.99 kW'],
        [4, 75000, 80000, '3-4.99 kW'],
        [4.99, 75000, 80000, '3-4.99 kW'],
        [4.999, 75000, 80000, '3-4.99 kW'],
        [5, 68000, 75000, '5-7.99 kW'],
        [6, 68000, 75000, '5-7.99 kW'],
        [7, 68000, 75000, '5-7.99 kW'],
        [7.999, 68000, 75000, '5-7.99 kW'],
        [8, 60000, 65000, '8-9.99 kW'],
        [9, 60000, 65000, '8-9.99 kW'],
        [9.999, 60000, 65000, '8-9.99 kW'],
        [10, 55000, null, '10-15 kW'],
        [12, 55000, null, '10-15 kW'],
        [15, 55000, null, '10-15 kW']
    ]) {
        const slabResult = getProposalPricingSlab(capacity, solarPricing);
        assert.equal(slabResult.label, slab);
        assert.equal(slabResult.nonSubsidyRate, nonSubsidyRate);
        assert.equal(slabResult.subsidyRate, subsidyRate);
        const result = proposalPricing(capacity, solarPricing);
        assert.equal(result.rate, nonSubsidyRate);
        assert.equal(result.slab, slab);
        assert.equal(result.grossAmount, capacity * nonSubsidyRate);
        assert.equal(result.discount, Math.round(result.grossAmount * 5) / 100);
        assert.equal(result.finalAmount, result.grossAmount - result.discount);
    }
});

test('selects subsidy rates and discounts the GST-inclusive price exactly once', () => {
    for (const [capacity, rate] of [[3, 80000], [4, 80000], [5, 75000], [6, 75000], [7, 75000], [8, 65000], [9, 65000]]) {
        const result = proposalPricing(capacity, solarPricing, { pricingType: 'Subsidy' });
        assert.equal(result.rate, rate);
        assert.equal(result.grossAmount, capacity * rate);
        assert.equal(result.discount, Math.round(result.grossAmount * 5) / 100);
        assert.equal(result.finalAmount, result.grossAmount - result.discount);
    }
    assert.equal(proposalPricing(10, solarPricing, { pricingType: 'Subsidy' }), null);
});

test('hybrid pricing selects single- and double-battery capacity bands without auto-discount', () => {
    for (const [capacity, rate, batteryConfiguration, slab] of [
        [5, 97000, 'Single Battery', '5-7.99 kW'],
        [7.99, 97000, 'Single Battery', '5-7.99 kW'],
        [7, 97000, 'Single Battery', '5-7.99 kW'],
        [8, 90000, 'Single Battery', '8-9.99 kW'],
        [8.01, 90000, 'Single Battery', '8-9.99 kW'],
        [9.99, 90000, 'Single Battery', '8-9.99 kW'],
        [9, 90000, 'Single Battery', '8-9.99 kW'],
        [10, 90000, 'Double Battery', '10 kW']
    ]) {
        const result = proposalPricing(capacity, solarPricing, { systemType: 'Hybrid', panelCount: 0 });
        assert.equal(result.rate, rate);
        assert.equal(result.batteryConfiguration, batteryConfiguration);
        assert.equal(result.slab, slab);
        assert.equal(result.discount, 0);
        assert.equal(result.isNegotiable, true);
        assert.equal(result.negotiableMessage, 'Contact GM for final pricing');
    }
    assert.equal(proposalPricing(4, solarPricing, { systemType: 'Hybrid' }), null);
    assert.equal(proposalPricing(10.01, solarPricing, { systemType: 'Hybrid' }), null);
    assert.equal(proposalPricing(12, solarPricing, { systemType: 'Hybrid' }), null);
});

test('adds hybrid three-phase, extra-battery, and per-panel surcharge before GST', () => {
    const baseOnly = proposalPricing(8, solarPricing, { systemType: 'Hybrid', panelCount: 0 });
    assert.equal(baseOnly.hybridSubsidyCharge, 0);
    assert.equal(baseOnly.grossAmount, 720000);

    for (const [panelCount, expectedSurcharge] of [[1, 15000], [16, 240000]]) {
        const panelPricing = proposalPricing(8, solarPricing, {
            systemType: 'Hybrid',
            pricingType: 'Subsidy',
            panelCount
        });
        assert.equal(panelPricing.hybridSubsidyCharge, expectedSurcharge);
        assert.equal(panelPricing.grossAmount, 720000 + expectedSurcharge * 1.05);
    }

    const threePhaseOnly = proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        inverterPhase: 'Three Phase'
    });
    assert.equal(threePhaseOnly.hybridThreePhaseCharge, 35000);
    assert.equal(threePhaseOnly.gst, 36035.71);
    assert.equal(threePhaseOnly.grossAmount, 756750);

    const extraBatteryOnly = proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        extraBattery: true
    });
    assert.equal(extraBatteryOnly.hybridExtraBatteryCharge, 115000);
    assert.equal(extraBatteryOnly.gst, 40035.71);
    assert.equal(extraBatteryOnly.grossAmount, 840750);

    const subsidyOnly = proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        pricingType: 'Subsidy',
        panelCount: 16
    });
    assert.equal(subsidyOnly.hybridSubsidyCharge, 240000);
    assert.equal(subsidyOnly.gst, 46285.71);
    assert.equal(subsidyOnly.grossAmount, 972000);
    assert.equal(proposalPricing(8, solarPricing, { systemType: 'Hybrid', pricingType: 'Subsidy', panelCount: 0 }), null);

    const result = proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        pricingType: 'Subsidy',
        panelCount: 16,
        inverterPhase: 'Three Phase',
        extraBattery: true
    });
    assert.equal(result.hybridSubsidyCharge, 240000);
    assert.equal(result.hybridThreePhaseCharge, 35000);
    assert.equal(result.hybridExtraBatteryCharge, 115000);
    assert.equal(result.otherCharges, 390000);
    assert.equal(result.subtotal, 1075714.29);
    assert.equal(result.gst, 53785.71);
    assert.equal(result.grossAmount, 1129500);
    assert.equal(result.subtotal + result.gst, result.grossAmount);
    assert.equal(result.discount, 0);
    assert.equal(result.netInvestment, 1129500);

    assert.equal(proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        pricingType: 'Subsidy',
        panelCount: 1.5
    }), null);

    const nonSubsidy = proposalPricing(8, solarPricing, { systemType: 'Hybrid', panelCount: 16 });
    assert.equal(nonSubsidy.hybridSubsidyCharge, 0);
    assert.equal(nonSubsidy.subtotal, 685714.29);
    assert.equal(nonSubsidy.gst, 34285.71);
    assert.equal(nonSubsidy.grossAmount, 720000);
    assert.equal(nonSubsidy.subtotal + nonSubsidy.gst, nonSubsidy.grossAmount);

    const commercialLines = Object.fromEntries(proposalCommercialLines(result, 8).map(({ label, amount }) => [label, amount]));
    assert.equal(commercialLines['GST on additional charges'], 19500);
    assert.equal(commercialLines.Subtotal, result.subtotal);
    assert.equal(commercialLines['GST @ 5%'], result.gst);
    assert.equal(commercialLines['Gross Amount'], result.grossAmount);
});

test('PDF commercial rows use the exact calculated totals and payable amounts', () => {
    for (const [result, capacity] of [
        [proposalPricing(3, solarPricing, { pricingType: 'Subsidy' }), 3],
        [proposalPricing(8, solarPricing, { systemType: 'Hybrid', pricingType: 'Subsidy', panelCount: 16, inverterPhase: 'Three Phase', extraBattery: true }), 8]
    ]) {
        const rows = Object.fromEntries(proposalCommercialLines(result, capacity).map(({ label, amount }) => [label, amount]));
        assert.equal(rows['Gross Amount'], result.grossAmount);
        assert.equal(rows.Discount, result.discount);
        assert.equal(rows['Final Payable'], result.finalAmount);
        assert.equal(rows['Net Investment'], result.netInvestment);
    }
});

test('supports negotiated discounts while retaining an automatic five-percent default', () => {
    const automatic = proposalPricing(3, solarPricing);
    const negotiated = proposalPricing(3, solarPricing, { discount: 1000, discountOverride: true });
    assert.equal(automatic.discount, 11250);
    assert.equal(automatic.discountRate, 5);
    assert.equal(negotiated.discount, 1000);
    assert.equal(negotiated.discountRate, 0);
    assert.equal(negotiated.finalAmount, negotiated.grossAmount - 1000);
});

test('applies configured GST and discounts to negotiated base-price overrides', () => {
    const onGrid = proposalPricing(3, solarPricing, { basePriceOverride: 270000 });
    assert.equal(onGrid.grossAmount, 270000);
    assert.equal(onGrid.gst, 12857.14);
    assert.equal(onGrid.discount, 13500);
    assert.equal(onGrid.finalAmount, 256500);

    const hybrid = proposalPricing(8, solarPricing, {
        systemType: 'Hybrid',
        pricingType: 'Subsidy',
        panelCount: 16,
        inverterPhase: 'Three Phase',
        extraBattery: true,
        basePriceOverride: 700000
    });
    assert.equal(hybrid.hybridBasePrice, 700000);
    assert.equal(hybrid.otherCharges, 390000);
    assert.equal(hybrid.gst, 52833.33);
    assert.equal(hybrid.grossAmount, 1109500);
    assert.equal(hybrid.subtotal + hybrid.gst, hybrid.grossAmount);
    assert.equal(hybrid.discount, 0);
});

test('preserves component overrides and explicit customer subsidy deductions', () => {
    const result = proposalPricing(3, solarPricing, {
        solarPanels: 100000,
        inverter: 50000,
        structure: 25000,
        acdbDcdb: 20000,
        earthing: 5000,
        cables: 5000,
        installation: 20000,
        otherCharges: 0,
        discount: 1000,
        discountOverride: true,
        subsidy: 2000
    });
    assert.equal(result.subtotal, 225000);
    assert.equal(result.gst, 11250);
    assert.equal(result.grossAmount, 236250);
    assert.equal(result.finalAmount, 235250);
    assert.equal(result.netInvestment, 233250);
});

test('migrates only known legacy rates and rejects unsupported capacities or missing rates', () => {
    assert.deepEqual(migrateLegacySolarPricing({ tier3: 70000, tier5: 63000, tier8: 55000, tier10: 50000, custom: 123 }), {
        tier3: 75000, tier5: 68000, tier8: 60000, tier10: 55000, custom: 123
    });
    assert.deepEqual(migrateLegacySolarPricing({ tier3: 80000 }).tier3, 80000);
    assert.equal(proposalPricing(2.9, solarPricing), null);
    assert.equal(proposalPricing(15.1, solarPricing), null);
    assert.equal(proposalPricing(10, { ...solarPricing, tier10: undefined }), null);
});
