const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const seed = require('./equipment-catalogue-seed');
const equipmentCatalogue = require('./equipment-catalogue');

function createProposalEditor(products) {
    const dom = new JSDOM(`<!doctype html><form id="proposalForm">
        <div id="formView" class="hidden"></div><div id="formTitle"></div>
        <select id="panelBrandSelect" name="panelBrand"></select><input id="panelModelSearch">
        <select id="panelModelSelect"></select><input name="panelWattage"><input name="panelCount">
        <output id="panelDcCapacity"></output><p id="panelCatalogueStatus"></p>
        <select id="inverterBrandSelect" name="inverterBrand"></select><input id="inverterModelSearch">
        <select id="inverterModelSelect"></select><select id="inverterTypeFilter"><option value="">All types</option>
        <option>On-grid</option><option>Hybrid</option><option>Off-grid</option><option>Micro</option></select>
        <select id="inverterPhaseFilter"><option value="">All phases</option><option>Single Phase</option><option>Three Phase</option></select>
        <input name="inverterCapacity"><input name="inverterPhase"><p id="inverterCatalogueStatus"></p>
        <select name="systemType"><option>On-Grid</option><option>Hybrid</option><option>Off-Grid</option></select>
        <button id="manageEquipmentCatalogueButton"></button><input name="componentConfiguration">
    </form>`, { runScripts: 'outside-only' });
    const { window } = dom;
    let rows = [];
    window.EquipmentCatalogue = equipmentCatalogue;
    window.ProposalComponentEditor = {
        getValue: () => rows.map((row) => ({ ...row })),
        setValue: (value) => { rows = value.map((row) => ({ ...row })); },
        updateField: (index, field, value) => { rows[index][field] = value; }
    };
    window.crmApi = {
        request: async () => ({
            products: products.map((product, index) => ({
                ...product,
                id: `catalogue-${index}`,
                selectable: equipmentCatalogue.isSelectableCatalogueEntry(product)
            })),
            canManage: false
        })
    };
    window.form = async () => {};
    window.fill = (proposal = {}) => {
        for (const field of ['panelBrand', 'panelWattage', 'panelCount', 'inverterBrand', 'inverterCapacity', 'inverterPhase']) {
            const input = window.document.querySelector(`[name="${field}"]`);
            if (input) input.value = proposal[field] ?? '';
        }
        rows = proposal.componentConfiguration || [];
    };
    window.payload = () => ({});
    window.preview = () => {};
    window.toast = () => {};
    window.modal = () => {};
    window.esc = (value) => String(value);
    const script = fs.readFileSync(path.join(__dirname, '..', 'js', 'equipment-catalogue.js'), 'utf8');
    window.eval(script);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    return { dom, window };
}

test('all manufacturer dropdowns filter their records; inverter type and phase filters narrow results', async () => {
    const products = [...seed];
    const { dom, window } = createProposalEditor(products);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const brand of equipmentCatalogue.PANEL_BRANDS) {
        const select = window.document.querySelector('#panelBrandSelect');
        select.value = brand;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        const models = [...window.document.querySelector('#panelModelSelect').options].map(({ textContent }) => textContent);
        assert.ok(models.some((label) => seed.some((product) => product.brand === brand && label.startsWith(product.model))), `${brand} model list`);
    }

    const inverterBrand = window.document.querySelector('#inverterBrandSelect');
    for (const brand of equipmentCatalogue.INVERTER_BRANDS) {
        inverterBrand.value = brand;
        inverterBrand.dispatchEvent(new window.Event('change', { bubbles: true }));
        const options = [...window.document.querySelector('#inverterModelSelect').options].map(({ textContent }) => textContent);
        assert.ok(options.some((label) => seed.some((product) => product.brand === brand && label.startsWith(product.model))), `${brand} model list`);
    }

    inverterBrand.value = 'Deye';
    inverterBrand.dispatchEvent(new window.Event('change', { bubbles: true }));
    const typeFilter = window.document.querySelector('#inverterTypeFilter');
    const phaseFilter = window.document.querySelector('#inverterPhaseFilter');
    typeFilter.value = 'Hybrid';
    phaseFilter.value = 'Single Phase';
    typeFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    phaseFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    const filtered = [...window.document.querySelector('#inverterModelSelect').options].map(({ textContent }) => textContent);
    assert.ok(filtered.some((label) => label.startsWith('SUN-3K-SG04LP1-EU')));
    assert.ok(!filtered.some((label) => label.startsWith('FE-')));

    dom.window.close();
});

test('verified panel selection calculates DC capacity and survives proposal save and reopen', async () => {
    const syntheticPanel = {
        category: 'solarPanels',
        brand: 'Saatvik',
        manufacturer: 'Saatvik',
        series: 'Synthetic test series',
        model: 'SYNTHETIC-540',
        ratedWattage: 540,
        sourceUrl: 'https://manufacturer.example/panel',
        verificationDate: '2026-05-01',
        verificationStatus: 'Verified',
        marketApplicability: 'Synthetic test fixture',
        status: 'Active'
    };
    const { dom, window } = createProposalEditor([...seed, syntheticPanel]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const brand = window.document.querySelector('#panelBrandSelect');
    brand.value = 'Saatvik';
    brand.dispatchEvent(new window.Event('change', { bubbles: true }));
    const model = window.document.querySelector('#panelModelSelect');
    model.value = `catalogue-${seed.length}`;
    model.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.querySelector('[name="panelCount"]').value = '10';
    window.document.querySelector('[name="panelCount"]').dispatchEvent(new window.Event('input', { bubbles: true }));

    assert.equal(window.document.querySelector('[name="panelWattage"]').value, '540');
    assert.equal(window.document.querySelector('#panelDcCapacity').textContent, 'Total panel DC capacity: 5.40 kW');
    const saved = window.payload().componentConfiguration;
    assert.equal(saved[0].model, 'SYNTHETIC-540');
    assert.equal(saved[0].rating, '540 Wp');
    assert.equal(saved[0].quantity, 10);
    assert.equal(saved[0].catalogueSourceUrl, 'https://manufacturer.example/panel');

    window.fill({
        panelBrand: 'Saatvik',
        panelWattage: 540,
        panelCount: 10,
        componentConfiguration: saved
    });
    assert.equal(window.document.querySelector('#panelModelSelect').value, `catalogue-${seed.length}`);
    assert.equal(window.payload().componentConfiguration[0].model, 'SYNTHETIC-540');

    brand.value = 'Waaree';
    brand.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(window.payload().componentConfiguration[0].model, '');

    dom.window.close();
});
