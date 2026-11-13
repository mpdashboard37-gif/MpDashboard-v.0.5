const COMPONENT_CATEGORIES = [
    { id: 'solarPanels', label: 'Solar panels', defaultBrand: 'Waaree' },
    { id: 'inverter', label: 'Inverter', defaultBrand: 'Deye' },
    { id: 'battery', label: 'Battery and accessories', defaultBrand: '' },
    { id: 'structure', label: 'Mounting structure', defaultBrand: 'HDG structure' },
    { id: 'dcCable', label: 'DC solar cables', defaultBrand: 'Polycab' },
    { id: 'acCable', label: 'AC cables', defaultBrand: 'Polycab' },
    { id: 'dcdb', label: 'DCDB', defaultBrand: '' },
    { id: 'acdb', label: 'ACDB', defaultBrand: '' },
    { id: 'mcbMccb', label: 'MCB / MCCB', defaultBrand: '' },
    { id: 'spd', label: 'DC and AC SPD', defaultBrand: '' },
    { id: 'earthing', label: 'Earthing system', defaultBrand: '' },
    { id: 'lightningProtection', label: 'Lightning protection', defaultBrand: '' },
    { id: 'connectors', label: 'Solar connectors', defaultBrand: '' },
    { id: 'junctionBoxes', label: 'Junction boxes', defaultBrand: '' },
    { id: 'cableTrayConduit', label: 'Cable trays and conduits', defaultBrand: '' },
    { id: 'monitoring', label: 'Monitoring and communication', defaultBrand: '' },
    { id: 'installationAccessories', label: 'Other installation accessories', defaultBrand: '' }
];

const CATEGORY_IDS = new Set(COMPONENT_CATEGORIES.map(({ id }) => id));
const INCLUSION_STATUSES = new Set(['included', 'optional', 'excluded']);
const COMPONENT_LIMIT = 80;
const FIELD_LIMITS = {
    brand: 120,
    manufacturer: 120,
    model: 120,
    technicalSpecification: 600,
    rating: 160,
    sizeCapacity: 120,
    series: 200,
    catalogueProductId: 120,
    catalogueSourceUrl: 1000,
    catalogueDatasheetUrl: 1000,
    catalogueVerificationDate: 10,
    catalogueMarketApplicability: 240,
    catalogueVerificationStatus: 30,
    inverterType: 30,
    phase: 30,
    unit: 40,
    warranty: 160,
    datasheetFileId: 120,
    datasheetFileName: 255,
    remarks: 600
};

function normalizeProposalConfiguration(configuration) {
    if (configuration === undefined || configuration === null || configuration === '') return [];
    let rows = configuration;
    if (typeof rows === 'string') {
        try {
            rows = JSON.parse(rows);
        } catch (error) {
            throw new Error('Equipment configuration must be valid JSON.');
        }
    }
    if (!Array.isArray(rows) || rows.length > COMPONENT_LIMIT) {
        throw new Error(`Equipment configuration must contain no more than ${COMPONENT_LIMIT} component rows.`);
    }

    return rows.map((row, index) => {
        const category = String(row?.category || '');
        if (!CATEGORY_IDS.has(category)) throw new Error(`Component row ${index + 1} has an unsupported category.`);
        const normalized = { id: String(row.id || '').trim().slice(0, 120), category };
        for (const [field, maximum] of Object.entries(FIELD_LIMITS)) {
            const value = String(row?.[field] ?? '').trim();
            if (value.length > maximum) throw new Error(`${field} in component row ${index + 1} must be ${maximum} characters or fewer.`);
            normalized[field] = value;
        }
        const quantity = row?.quantity === '' || row?.quantity === null || row?.quantity === undefined
            ? null
            : Number(row.quantity);
        if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000)) {
            throw new Error(`Quantity in component row ${index + 1} must be greater than zero.`);
        }
        normalized.quantity = quantity;
        normalized.inclusionStatus = String(row?.inclusionStatus || 'included').toLowerCase();
        if (!INCLUSION_STATUSES.has(normalized.inclusionStatus)) {
            throw new Error(`Component row ${index + 1} has an invalid inclusion status.`);
        }
        normalized.compatibilityVerified = row?.compatibilityVerified === true || row?.compatibilityVerified === 'true';
        return normalized;
    });
}

function getProposalConfigurationWarnings(configuration, system = {}) {
    const components = normalizeProposalConfiguration(configuration);
    const active = components.filter((component) => (
        component.inclusionStatus !== 'excluded'
        && Object.entries(component).some(([key, value]) => key !== 'id' && key !== 'category' && key !== 'inclusionStatus' && value !== '' && value !== null && value !== false)
    ));
    const warnings = [];
    for (const component of active) {
        const label = COMPONENT_CATEGORIES.find(({ id }) => id === component.category)?.label || component.category;
        if (!component.model) warnings.push(`${label}: model number is not specified.`);
        if (!component.technicalSpecification) warnings.push(`${label}: technical specification is not specified.`);
        if (component.quantity === null) warnings.push(`${label}: quantity is not specified.`);
        if (['dcCable', 'acCable', 'dcdb', 'acdb', 'mcbMccb', 'spd'].includes(component.category)
            && !component.rating && !component.sizeCapacity) {
            warnings.push(`${label}: electrical rating or size is not specified.`);
        }
    }

    const systemCapacity = Number(system.systemCapacity);
    const panelWattage = Number(system.panelWattage);
    const panelCount = Number(system.panelCount);
    if (systemCapacity > 0 && panelWattage > 0 && Number.isInteger(panelCount) && panelCount > 0) {
        const calculatedDcCapacity = panelWattage * panelCount / 1000;
        if (Math.abs(calculatedDcCapacity - systemCapacity) > Math.max(0.1, systemCapacity * 0.05)) {
            warnings.push(`Panel count × wattage gives ${calculatedDcCapacity.toFixed(2)} kW DC, which differs from the entered ${systemCapacity} kW system capacity.`);
        }
        const inverterCapacity = Number(system.inverterCapacity);
        if (inverterCapacity > 0) {
            warnings.push(`The entered DC/AC ratio is ${(calculatedDcCapacity / inverterCapacity).toFixed(2)}; verify it against the exact inverter model datasheet and project design.`);
        }
    }

    const hasBattery = system.batteryRequired === true || system.batteryRequired === 1 || system.batteryRequired === 'true';
    const batteries = active.filter(({ category }) => category === 'battery');
    if (hasBattery && (!Number(system.batteryCapacity) || !batteries.length)) {
        warnings.push('Battery is selected but its capacity or component configuration is missing.');
    }
    if (hasBattery && batteries.length && !batteries.every(({ compatibilityVerified }) => compatibilityVerified)) {
        warnings.push('Battery compatibility with the exact inverter model has not been confirmed against manufacturer documentation.');
    }
    return [...new Set(warnings)];
}

const proposalConfigurationApi = {
    COMPONENT_CATEGORIES,
    COMPONENT_LIMIT,
    normalizeProposalConfiguration,
    getProposalConfigurationWarnings
};

if (typeof module !== 'undefined' && module.exports) module.exports = proposalConfigurationApi;
if (typeof window !== 'undefined') window.ProposalConfiguration = proposalConfigurationApi;
