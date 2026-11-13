const PANEL_BRANDS = ['Saatvik', 'Waaree', 'V-Guard'];
const INVERTER_BRANDS = ['Deye', 'Feston', 'V-Guard', 'Solinteg', 'Sungrow', 'Enphase'];
const INVERTER_TYPES = ['On-grid', 'Hybrid', 'Off-grid', 'Micro'];
const PHASES = ['Single Phase', 'Three Phase'];

const CATEGORY_BRANDS = {
    solarPanels: PANEL_BRANDS,
    inverter: INVERTER_BRANDS
};

function optionalPositiveNumber(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number.`);
    return number;
}

function normalizeEquipmentCatalogueEntry(input = {}) {
    const category = String(input.category || '').trim();
    if (!CATEGORY_BRANDS[category]) throw new Error('Choose a supported equipment category.');

    const brand = String(input.brand || '').trim();
    if (!CATEGORY_BRANDS[category].includes(brand)) throw new Error('Choose a supported manufacturer for this category.');

    const model = String(input.model || '').trim();
    if (!model || model.length > 200) throw new Error('Model or official product-series name is required and must be 200 characters or fewer.');

    const sourceUrl = String(input.sourceUrl || '').trim();
    let parsedSource;
    try {
        parsedSource = new URL(sourceUrl);
    } catch (error) {
        throw new Error('An official HTTPS source URL is required.');
    }
    if (parsedSource.protocol !== 'https:') throw new Error('An official HTTPS source URL is required.');

    const verificationDate = String(input.verificationDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(verificationDate) || Number.isNaN(Date.parse(`${verificationDate}T00:00:00Z`))) {
        throw new Error('Verification date must use YYYY-MM-DD format.');
    }

    const ratedWattage = optionalPositiveNumber(input.ratedWattage, 'Rated panel wattage');
    const minimumWattage = optionalPositiveNumber(input.minimumWattage, 'Minimum panel wattage');
    const maximumWattage = optionalPositiveNumber(input.maximumWattage, 'Maximum panel wattage');
    if ((minimumWattage === null) !== (maximumWattage === null)
        || (minimumWattage !== null && maximumWattage < minimumWattage)) {
        throw new Error('Panel wattage ranges must include valid minimum and maximum values.');
    }
    const ratedCapacityKw = optionalPositiveNumber(input.ratedCapacityKw, 'Rated inverter AC capacity');

    let inverterType = '';
    let phase = '';
    if (category === 'inverter') {
        inverterType = String(input.inverterType || '').trim();
        if (!INVERTER_TYPES.includes(inverterType)) throw new Error('Choose a supported inverter type.');
        phase = String(input.phase || '').trim();
        if (phase && !PHASES.includes(phase)) throw new Error('Choose a supported inverter phase or leave it blank for verification.');
    } else if (ratedCapacityKw !== null || input.inverterType || input.phase) {
        throw new Error('Inverter specifications cannot be saved on a solar panel record.');
    }

    const verificationStatus = String(input.verificationStatus || 'Needs verification').trim();
    if (!['Verified', 'Needs verification'].includes(verificationStatus)) {
        throw new Error('Verification status must be Verified or Needs verification.');
    }
    const status = String(input.status || 'Active').trim();
    if (!['Active', 'Inactive'].includes(status)) throw new Error('Catalogue status must be Active or Inactive.');

    return {
        category,
        brand,
        manufacturer: String(input.manufacturer || brand).trim().slice(0, 120),
        series: String(input.series || '').trim().slice(0, 200),
        model,
        ratedWattage,
        minimumWattage,
        maximumWattage,
        ratedCapacityKw,
        inverterType,
        phase,
        sourceUrl,
        datasheetUrl: String(input.datasheetUrl || '').trim(),
        verificationDate,
        marketApplicability: String(input.marketApplicability || 'Needs verification').trim().slice(0, 240),
        verificationStatus,
        status,
        notes: String(input.notes || '').trim().slice(0, 1000)
    };
}

function isSelectableCatalogueEntry(entry) {
    if (!entry || entry.status !== 'Active' || entry.verificationStatus !== 'Verified') return false;
    if (entry.category === 'solarPanels') return Number(entry.ratedWattage) > 0;
    return entry.category === 'inverter'
        && Number(entry.ratedCapacityKw) > 0
        && INVERTER_TYPES.includes(entry.inverterType)
        && PHASES.includes(entry.phase);
}

function filterEquipmentCatalogue(products, filters = {}) {
    const category = String(filters.category || '');
    const brand = String(filters.brand || '');
    const search = String(filters.search || '').trim().toLowerCase();
    const inverterType = String(filters.inverterType || '');
    const phase = String(filters.phase || '');
    return (Array.isArray(products) ? products : []).filter((product) => (
        (!category || product.category === category)
        && (!brand || product.brand === brand)
        && (!search || `${product.model || ''} ${product.series || ''} ${product.manufacturer || ''}`.toLowerCase().includes(search))
        && (!inverterType || product.category !== 'inverter' || product.inverterType === inverterType)
        && (!phase || product.category !== 'inverter' || product.phase === phase)
    ));
}

function getEquipmentSelection(product, quantity = 1) {
    if (!isSelectableCatalogueEntry(product)) throw new Error('Only active products with verified exact specifications can be selected.');
    const itemQuantity = Number(quantity);
    if (!Number.isInteger(itemQuantity) || itemQuantity < 1 || itemQuantity > 1000000) {
        throw new Error('Equipment quantity must be a positive whole number.');
    }
    if (product.category === 'solarPanels') {
        return {
            category: product.category,
            brand: product.brand,
            manufacturer: product.manufacturer,
            model: product.model,
            ratedWattage: Number(product.ratedWattage),
            quantity: itemQuantity,
            totalDcCapacityKw: Number(product.ratedWattage) * itemQuantity / 1000
        };
    }
    return {
        category: product.category,
        brand: product.brand,
        manufacturer: product.manufacturer,
        model: product.model,
        inverterType: product.inverterType,
        phase: product.phase,
        ratedCapacityKw: Number(product.ratedCapacityKw)
    };
}

const equipmentCatalogueApi = {
    PANEL_BRANDS,
    INVERTER_BRANDS,
    INVERTER_TYPES,
    PHASES,
    normalizeEquipmentCatalogueEntry,
    isSelectableCatalogueEntry,
    filterEquipmentCatalogue,
    getEquipmentSelection
};

if (typeof module !== 'undefined' && module.exports) module.exports = equipmentCatalogueApi;
if (typeof window !== 'undefined') window.EquipmentCatalogue = equipmentCatalogueApi;
