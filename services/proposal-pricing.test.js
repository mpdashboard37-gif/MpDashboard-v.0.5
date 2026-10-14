const assert = require('node:assert/strict');
const { test } = require('node:test');
const { proposalPricing } = require('./proposal-pricing');

const solarPricing = { tier3: 75000, tier5: 68000, tier8: 60000, tier10: 55000, gstRate: 5 };

test('uses the configured tier rate and GST for each capacity slab', () => {
    for (const [capacity, rate, slab] of [
        [3, 75000, '3-4.99 kW'],
        [5, 68000, '5-7.99 kW'],
        [8, 60000, '8-9.99 kW'],
        [10, 55000, '10-15 kW'],
        [15, 55000, '10-15 kW']
    ]) {
        const result = proposalPricing(capacity, solarPricing);
        assert.equal(result.rate, rate);
        assert.equal(result.slab, slab);
        assert.equal(result.subtotal, capacity * rate);
        assert.equal(result.gst, Math.round(capacity * rate * 5) / 100);
        assert.equal(result.grossAmount, result.subtotal + result.gst);
        assert.equal(result.solarPanels + result.inverter + result.structure + result.acdbDcdb + result.earthing + result.cables + result.installation + result.otherCharges, result.subtotal);
    }
});

test('applies discount and subsidy once and rounds each amount to cents', () => {
    const result = proposalPricing(3.1, solarPricing, { gst: 0, discount: 100.105, subsidy: 200.105 });
    assert.equal(result.gst, Math.round(result.subtotal * 5) / 100);
    assert.equal(result.discount, 100.11);
    assert.equal(result.subsidy, 200.11);
    assert.equal(Math.round(result.finalAmount * 100), Math.round((result.grossAmount - 100.11) * 100));
    assert.equal(Math.round(result.netInvestment * 100), Math.round((result.finalAmount - 200.11) * 100));
});

test('does not substitute missing prices or accept unsupported capacities', () => {
    assert.equal(proposalPricing(4, { ...solarPricing, tier3: undefined }), null);
    assert.equal(proposalPricing(2.9, solarPricing), null);
    assert.equal(proposalPricing(15.1, solarPricing), null);
});

test('uses configured defaults when component keys are present but undefined', () => {
    const values = Object.fromEntries(['solarPanels', 'inverter', 'structure', 'acdbDcdb', 'earthing', 'cables', 'installation', 'otherCharges'].map((key) => [key, undefined]));
    const result = proposalPricing(3, solarPricing, values);
    assert.equal(result.subtotal, 225000);
    assert.equal(result.gst, 11250);
});