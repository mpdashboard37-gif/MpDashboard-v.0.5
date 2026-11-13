const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('./equipment-catalogue-seed');
const {
    PANEL_BRANDS,
    INVERTER_BRANDS,
    normalizeEquipmentCatalogueEntry,
    isSelectableCatalogueEntry,
    filterEquipmentCatalogue,
    getEquipmentSelection
} = require('./equipment-catalogue');

test('researched catalogue rows have official sources and verification dates', () => {
    assert.ok(seed.length > 0);
    for (const product of seed) {
        assert.match(product.sourceUrl, /^https:\/\/.+/);
        assert.match(product.verificationDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.doesNotThrow(() => normalizeEquipmentCatalogueEntry(product));
    }
    for (const brand of PANEL_BRANDS) {
        assert.ok(filterEquipmentCatalogue(seed, { category: 'solarPanels', brand }).length > 0, `${brand} panels`);
    }
    for (const brand of INVERTER_BRANDS) {
        assert.ok(filterEquipmentCatalogue(seed, { category: 'inverter', brand }).length > 0, `${brand} inverters`);
    }
});

test('panel catalogue filters by brand and search and calculates exact total DC capacity', () => {
    for (const brand of PANEL_BRANDS) {
        const product = normalizeEquipmentCatalogueEntry({
            category: 'solarPanels',
            brand,
            model: `${brand} Verified Test Model`,
            ratedWattage: 520,
            sourceUrl: 'https://manufacturer.example/datasheet',
            verificationDate: '2026-05-01',
            verificationStatus: 'Verified',
            status: 'Active'
        });
        const results = filterEquipmentCatalogue([product], {
            category: 'solarPanels',
            brand,
            search: 'verified test'
        });
        assert.deepEqual(results.map(({ model }) => model), [product.model]);
        assert.equal(getEquipmentSelection(results[0], 12).totalDcCapacityKw, 6.24);
    }
});

test('inverter catalogue filters each brand by type and phase and returns exact capacity', () => {
    for (const [index, brand] of INVERTER_BRANDS.entries()) {
        const inverterType = ['Hybrid', 'On-grid', 'Off-grid', 'Micro'][index % 4];
        const product = normalizeEquipmentCatalogueEntry({
            category: 'inverter',
            brand,
            model: `${brand} Verified Inverter`,
            ratedCapacityKw: 5,
            inverterType,
            phase: 'Three Phase',
            sourceUrl: 'https://manufacturer.example/inverter-datasheet',
            verificationDate: '2026-05-01',
            verificationStatus: 'Verified',
            status: 'Active'
        });
        const filtered = filterEquipmentCatalogue([product], {
            category: 'inverter',
            brand,
            inverterType,
            phase: 'Three Phase'
        });
        assert.equal(filtered.length, 1, `${brand} type and phase filters`);
        assert.equal(getEquipmentSelection(filtered[0]).ratedCapacityKw, 5);
        assert.equal(getEquipmentSelection(filtered[0]).phase, 'Three Phase');
    }
});

test('series ranges and unverified regional or model ratings cannot be selected as exact products', () => {
    const series = seed.find((product) => product.brand === 'Saatvik' && product.minimumWattage === 380);
    assert.equal(isSelectableCatalogueEntry({ ...series, status: 'Active' }), false);
    const unverified = seed.find((product) => product.brand === 'Enphase');
    assert.equal(isSelectableCatalogueEntry({ ...unverified, status: 'Active' }), false);
    for (const product of seed.filter((entry) => /availability needs verification/i.test(entry.marketApplicability))) {
        assert.equal(isSelectableCatalogueEntry(product), false, `${product.brand} ${product.model} regional availability`);
    }
    assert.throws(() => getEquipmentSelection(series), /verified exact specifications/);
    assert.throws(() => getEquipmentSelection({ ...unverified, status: 'Active' }), /verified exact specifications/);
});

test('catalogue validation rejects unsupported manufacturers, missing sources and invalid specifications', () => {
    assert.throws(() => normalizeEquipmentCatalogueEntry({
        category: 'solarPanels', brand: 'Unknown', model: 'Model X',
        sourceUrl: 'https://example.com', verificationDate: '2026-11-13'
    }), /supported manufacturer/);
    assert.throws(() => normalizeEquipmentCatalogueEntry({
        category: 'solarPanels', brand: 'Saatvik', model: 'Model X',
        sourceUrl: 'http://example.com', verificationDate: '2026-11-13'
    }), /HTTPS source/);
    assert.throws(() => normalizeEquipmentCatalogueEntry({
        category: 'inverter', brand: 'Deye', model: 'Model X', ratedCapacityKw: 5,
        inverterType: 'Hybrid', phase: 'Dual Phase',
        sourceUrl: 'https://example.com', verificationDate: '2026-11-13'
    }), /phase/);
});
