const test = require('node:test');
const assert = require('node:assert/strict');
const {
    COMPONENT_CATEGORIES,
    normalizeProposalConfiguration,
    getProposalConfigurationWarnings
} = require('./proposal-configuration');

test('exposes all proposal equipment categories and configurable brand defaults', () => {
    assert.equal(COMPONENT_CATEGORIES.length, 17);
    assert.equal(COMPONENT_CATEGORIES.find(({ id }) => id === 'solarPanels').defaultBrand, 'Waaree');
    assert.equal(COMPONENT_CATEGORIES.find(({ id }) => id === 'inverter').defaultBrand, 'Deye');
    assert.equal(COMPONENT_CATEGORIES.find(({ id }) => id === 'structure').defaultBrand, 'HDG structure');
    assert.equal(COMPONENT_CATEGORIES.find(({ id }) => id === 'dcCable').defaultBrand, 'Polycab');
});

test('normalizes multiple component rows without inventing technical specifications', () => {
    const components = normalizeProposalConfiguration([
        { category: 'solarPanels', brand: 'Customer selected brand', model: 'Project model', quantity: '8', unit: 'pcs' },
        { category: 'inverter', brand: 'Deye', quantity: '1', unit: 'pcs', inclusionStatus: 'optional' }
    ]);
    assert.equal(components.length, 2);
    assert.equal(components[0].brand, 'Customer selected brand');
    assert.equal(components[0].quantity, 8);
    assert.equal(components[0].technicalSpecification, '');
    assert.equal(components[1].inclusionStatus, 'optional');
});

test('preserves selected catalogue model, ratings and verification sources when a proposal is saved', () => {
    const [panel, inverter] = normalizeProposalConfiguration([
        {
            category: 'solarPanels', brand: 'Saatvik', manufacturer: 'Saatvik',
            series: 'TEJ Plus', model: 'TEJ-640', rating: '640 Wp',
            quantity: 10, unit: 'pcs', catalogueProductId: 'panel-catalogue-id',
            catalogueSourceUrl: 'https://manufacturer.example/panel.pdf',
            catalogueDatasheetUrl: 'https://manufacturer.example/panel-datasheet.pdf',
            catalogueVerificationDate: '2026-05-01',
            catalogueMarketApplicability: 'India',
            catalogueVerificationStatus: 'Verified'
        },
        {
            category: 'inverter', brand: 'Deye', model: 'SUN-6K',
            rating: '6 kW AC', sizeCapacity: '6 kW',
            technicalSpecification: 'Hybrid; Single Phase; India',
            inverterType: 'Hybrid', phase: 'Single Phase',
            catalogueProductId: 'inverter-catalogue-id',
            catalogueSourceUrl: 'https://manufacturer.example/inverter.pdf',
            catalogueVerificationDate: '2026-05-01',
            catalogueVerificationStatus: 'Verified'
        }
    ]);

    assert.equal(panel.manufacturer, 'Saatvik');
    assert.equal(panel.model, 'TEJ-640');
    assert.equal(panel.quantity, 10);
    assert.equal(panel.catalogueProductId, 'panel-catalogue-id');
    assert.equal(panel.catalogueSourceUrl, 'https://manufacturer.example/panel.pdf');
    assert.equal(inverter.model, 'SUN-6K');
    assert.equal(inverter.inverterType, 'Hybrid');
    assert.equal(inverter.phase, 'Single Phase');
    assert.equal(inverter.catalogueVerificationStatus, 'Verified');
});

test('rejects invalid component categories, quantities and oversized configurations', () => {
    assert.throws(() => normalizeProposalConfiguration([{ category: 'invented' }]), /unsupported category/);
    assert.throws(() => normalizeProposalConfiguration([{ category: 'battery', quantity: 0 }]), /quantity/i);
    assert.throws(() => normalizeProposalConfiguration(Array.from({ length: 81 }, () => ({ category: 'battery' }))), /no more than 80/);
});

test('warns on missing technical details, DC capacity mismatch and unverified battery compatibility', () => {
    const warnings = getProposalConfigurationWarnings([
        { category: 'battery', model: 'Model B', quantity: 1, compatibilityVerified: false },
        { category: 'inverter', model: 'Model I', quantity: 1 }
    ], { systemCapacity: 5, panelWattage: 400, panelCount: 10, inverterCapacity: 5, batteryRequired: true, batteryCapacity: 12 });
    assert.ok(warnings.some((warning) => warning.includes('technical specification is not specified')));
    assert.ok(warnings.some((warning) => warning.includes('differs from the entered 5 kW')));
    assert.ok(warnings.some((warning) => warning.includes('compatibility')));
});

test('does not warn about a matching DC capacity and compatible recorded battery selection', () => {
    const warnings = getProposalConfigurationWarnings([
        { category: 'battery', model: 'Model B', technicalSpecification: 'Verified for selected inverter', quantity: 1, compatibilityVerified: true },
        { category: 'inverter', model: 'Model I', technicalSpecification: 'Manufacturer specification', quantity: 1 }
    ], { systemCapacity: 4, panelWattage: 400, panelCount: 10, inverterCapacity: 4, batteryRequired: true, batteryCapacity: 10 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /DC\/AC ratio/);
});
