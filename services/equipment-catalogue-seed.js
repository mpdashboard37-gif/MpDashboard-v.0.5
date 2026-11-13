const verifiedAt = '2026-05-01';
const official = {
    saatvikMono: 'https://www.saatvikgroup.com/modules/mono-perc',
    saatvikBifacial: 'https://www.saatvikgroup.com/modules/bifacial-g2tb',
    saatvikTopcon: 'https://www.saatvikgroup.com/modules/n-topcon',
    saatvikM10r: 'https://www.saatvikgroup.com/modules/bifacial-g2g-m10r',
    saatvikG12r: 'https://www.saatvikgroup.com/modules/bifacial-g12r',
    waaree: 'https://www.waaree.com/solar-pv-modules/',
    waareeArka: 'https://shop.waaree.com/arka-series-mono-perc/',
    waareeAhnay: 'https://shop.waaree.com/ahnay-series--bifacial/',
    waaree710: 'https://shop.waaree.com/waaree-710-wp-dcr-132-cells-24-volts-g12r-n-type-framed-dual-glass-bifacial-dcr-solar-module/',
    waaree580: 'https://shop.waaree.com/waaree-580wp-144cells-24-volts-n-type-framed-dual-glass-bifacial-non-dcr-solar-module/',
    vguardPanel585: 'https://www.vguard.in/product-details/vguard-solar-panel-585-rs-topcon-n-type-gg-non-dcr',
    vguardPanel550: 'https://www.vguard.in/product-details/vguard-solar-panel-550-ax',
    deye: 'https://deyeindia.com/products/hybrid-inverters/sun-3-3-6-4-4-6-5-6k-sg04lp1-eu',
    festonSingle: 'https://festonsev.com/demo-details/',
    festonSingleDatasheet: 'https://festonsev.com/wp-content/uploads/2026/08/FE-OG-1P1.5-4KW-Inverter-Data-Sheet.pdf',
    festonThree: 'https://festonsev.com/12kw-ongrid/',
    festonThreeDatasheet: 'https://festonsev.com/wp-content/uploads/2026/08/FE-OG-3P-4kW-to12kW-Inverter-Data-Sheet-1.pdf',
    vguard3400: 'https://www.vguard.in/product-details/solar-on-grid-system-solrigo-3400-1p',
    vguard5000: 'https://www.vguard.in/product-details/solar-on-grid-system-solrigo-5000-3p',
    solinteg: 'https://www.solinteg.com/integ-m/mhs-3-8kw',
    sungrow: 'https://www.sungrowpower.com/en/products/string-inverter',
    enphaseIq8hc: 'https://enphase.com/en-in/store/microinverters/iq8-series/iq8hc-microinverter',
    enphaseIq8p: 'https://enphase.com/en-in/store/microinverters/iq8-series/iq8p-microinverter'
};

const products = [
    {
        category: 'solarPanels', brand: 'Saatvik', series: 'VEGA Mono PERC',
        model: 'VEGA Mono Facial G2WB', minimumWattage: 380, maximumWattage: 555,
        sourceUrl: official.saatvikMono, datasheetUrl: 'https://www.saatvikgroup.com/docs/datasheets/Saatvik-Mono-PERC-Module-Datasheet.pdf',
        marketApplicability: 'India; manufacturer states BIS and MNRE ALMM listing',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'Official sources publish a 380–555 Wp series range, but no model-by-model wattage schedule was verified. Select only after exact model and wattage are confirmed.'
    },
    {
        category: 'solarPanels', brand: 'Saatvik', series: 'VEGA Plus Mono PERC bifacial',
        model: 'VEGA Plus Bifacial G2TB', minimumWattage: 525, maximumWattage: 550,
        sourceUrl: official.saatvikBifacial, datasheetUrl: 'https://www.saatvikgroup.com/docs/datasheets/Saatvik-Mono-PERC-Bifacial-G2TB-Module-Datasheet.pdf',
        marketApplicability: 'India; BIS certification stated on manufacturer page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'Official source confirms a 525–550 Wp range but does not expose a model-by-model wattage schedule.'
    },
    {
        category: 'solarPanels', brand: 'Saatvik', series: 'TEJ N-TOPCon bifacial',
        model: 'TEJ BiFacial M10R', minimumWattage: 560, maximumWattage: 585,
        sourceUrl: official.saatvikM10r, datasheetUrl: 'https://www.saatvikgroup.com/docs/datasheets/Saatvik-N-TOPCon-Bifacial-Module-Datasheet.pdf',
        marketApplicability: 'India; BIS certification stated on manufacturer page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The current official product page states a 560–585 Wp series range. Exact model-by-model wattages remain unverified.'
    },
    {
        category: 'solarPanels', brand: 'Saatvik', series: 'TEJ Plus N-TOPCon bifacial',
        model: 'TEJ Plus BiFacial G12R', minimumWattage: 600, maximumWattage: 640,
        sourceUrl: official.saatvikG12r, datasheetUrl: 'https://www.saatvikgroup.com/docs/datasheets/Saatvik-TejPlus-N-TOPCon-G12R-Datasheet-600-640Wp.pdf',
        marketApplicability: 'India; BIS certification stated on manufacturer page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'Official source confirms a 600–640 Wp range but does not expose a model-by-model wattage schedule.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Elite N-type',
        model: 'Elite N-type (exact model not verified)', sourceUrl: official.waaree,
        marketApplicability: 'Needs verification', verificationStatus: 'Needs verification', status: 'Inactive',
        notes: 'The requested series and 555–715 Wp range were not confirmed on the official manufacturer pages reviewed.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Plexus HJT',
        model: 'Plexus HJT (exact model not verified)', sourceUrl: official.waaree,
        marketApplicability: 'Needs verification', verificationStatus: 'Needs verification', status: 'Inactive',
        notes: 'The requested series and 570–730 Wp range were not confirmed on the official manufacturer pages reviewed.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Anhay',
        model: 'Anhay (exact model not verified)', sourceUrl: official.waaree,
        marketApplicability: 'Needs verification', verificationStatus: 'Needs verification', status: 'Inactive',
        notes: 'The official store page reviewed spells a similarly named series “Ahnay”; the requested Anhay range was not verified.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Arka',
        model: 'Arka (exact model not verified)', sourceUrl: official.waareeArka,
        marketApplicability: 'India official store category; exact model availability needs verification',
        verificationStatus: 'Needs verification', status: 'Inactive',
        notes: 'The official store category is visible, but the requested 400–665 Wp range and exact models were not verified.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Official store listing',
        model: 'WAAREE 710 Wp DCR 132 Cells G12R N-Type Framed Dual Glass Bifacial DCR Solar Module',
        sourceUrl: official.waaree710, marketApplicability: 'India official store listing',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The store title states 710 Wp, but associated product image names conflict with the title. Keep unavailable until the exact rating is confirmed.'
    },
    {
        category: 'solarPanels', brand: 'Waaree', series: 'Official store listing',
        model: 'WAAREE 580 Wp 144 Cells N-Type Framed Dual Glass Bifacial Non-DCR Solar Module',
        sourceUrl: official.waaree580, marketApplicability: 'India official store listing',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The store title states 580 Wp, but associated product image names conflict with the title. Keep unavailable until the exact rating is confirmed.'
    },
    {
        category: 'solarPanels', brand: 'V-Guard', series: 'TOPCon N-type bifacial',
        model: 'PANEL 585 (RS) TOPCON N-TYPE GG NON-DCR',
        sourceUrl: official.vguardPanel585,
        datasheetUrl: 'https://www.vguard.in/uploads/Documents/PANEL-585-RS-TOPCON-N-TYPE-GG-NON-DCR.pdf',
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The manufacturer page lists the model and links a datasheet, but the rated Wp could not be verified from the accessible datasheet text.'
    },
    {
        category: 'solarPanels', brand: 'V-Guard', series: 'Mono PERC',
        model: 'Panel 550 (AX)',
        sourceUrl: official.vguardPanel550,
        datasheetUrl: 'https://www.vguard.in/uploads/Documents/Panel-550-AX.pdf',
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The manufacturer page lists the model and links a datasheet, but the rated Wp could not be verified from the accessible datasheet text.'
    },
    ...[
        ['SUN-3K-SG04LP1-EU', 3],
        ['SUN-3.6K-SG04LP1-EU', 3.6],
        ['SUN-5K-SG04LP1-EU', 5],
        ['SUN-6K-SG04LP1-EU', 6]
    ].map(([model, ratedCapacityKw]) => ({
        category: 'inverter', brand: 'Deye', series: 'SUN SG04LP1-EU',
        model, ratedCapacityKw, inverterType: 'Hybrid', phase: 'Single Phase',
        sourceUrl: official.deye,
        datasheetUrl: 'https://media.deyeindia.com/documents/datasheets/sun-3-6k-sg04lp1-eu-inverter-datasheet-970daa99.pdf',
        marketApplicability: 'India; Deye India product page and India datasheet',
        verificationStatus: 'Verified', status: 'Active'
    })),
    ...[
        [1.5, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [2.2, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [2.7, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [3, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [3.3, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [3.6, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [4, official.festonSingle, official.festonSingleDatasheet, 'Single Phase'],
        [4, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [5, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [6, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [7, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [8, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [10, official.festonThree, official.festonThreeDatasheet, 'Three Phase'],
        [12, official.festonThree, official.festonThreeDatasheet, 'Three Phase']
    ].map(([capacity, sourceUrl, datasheetUrl, phase]) => ({
        category: 'inverter', brand: 'Feston',
        series: phase === 'Single Phase' ? 'FE On-grid single-phase' : 'FE On-grid three-phase',
        model: `FE-${capacity}`, ratedCapacityKw: capacity,
        inverterType: 'On-grid', phase, sourceUrl, datasheetUrl,
        marketApplicability: 'India; manufacturer India site, grid-approval details not verified',
        verificationStatus: 'Verified', status: 'Active',
        notes: 'Capacity and phase are listed by the manufacturer for this model series; confirm local utility approval for each project.'
    })),
    {
        category: 'inverter', brand: 'V-Guard', series: 'SOLRIGO on-grid PV inverter',
        model: 'SOLRIGO 3400 1P', inverterType: 'On-grid', phase: 'Single Phase',
        sourceUrl: official.vguard3400,
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The 3600 W figure on the manufacturer page is recommended PV input power, not rated AC output. AC capacity needs verification.'
    },
    {
        category: 'inverter', brand: 'V-Guard', series: 'SOLRIGO on-grid PV inverter',
        model: 'SOLRIGO 5000 3P', inverterType: 'On-grid', phase: 'Three Phase',
        sourceUrl: official.vguard5000,
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'The 6000 W figure on the manufacturer page is recommended PV input power, not rated AC output. AC capacity needs verification.'
    },
    ...[
        ['MHS-3K-30', 3],
        ['MHS-3.6K-30', 3.6],
        ['MHS-4.2K-30', 4.2],
        ['MHS-5K-30', 5],
        ['MHS-6K-30', 6],
        ['MHS-8K-30', 8]
    ].map(([model, ratedCapacityKw]) => ({
        category: 'inverter', brand: 'Solinteg', series: 'MHS-3–8kW',
        model, ratedCapacityKw, inverterType: 'Hybrid', phase: 'Single Phase',
        sourceUrl: official.solinteg,
        marketApplicability: 'Global manufacturer listing; India availability needs verification',
        verificationStatus: 'Needs verification', status: 'Active'
    })),
    ...[
        ['SG3.0RS', 3],
        ['SG3.6RS', 3.6],
        ['SG4.0RS', 4],
        ['SG5.0RS', 5],
        ['SG6.0RS', 6]
    ].map(([model, ratedCapacityKw]) => ({
        category: 'inverter', brand: 'Sungrow', series: 'RS single-phase string inverter',
        model, ratedCapacityKw, inverterType: 'On-grid', phase: 'Single Phase',
        sourceUrl: official.sungrow,
        marketApplicability: 'Global manufacturer catalogue; India availability for these exact models needs verification',
        verificationStatus: 'Needs verification', status: 'Active'
    })),
    {
        category: 'inverter', brand: 'Enphase', series: 'IQ8',
        model: 'IQ8HC-72-M-INT', inverterType: 'Micro',
        sourceUrl: official.enphaseIq8hc,
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'Official India SKU is listed; rated AC output and phase were not verified from the accessible product page.'
    },
    {
        category: 'inverter', brand: 'Enphase', series: 'IQ8',
        model: 'IQ8P-72-2-INT', inverterType: 'Micro',
        sourceUrl: official.enphaseIq8p,
        marketApplicability: 'India product page',
        verificationStatus: 'Needs verification', status: 'Active',
        notes: 'Official India SKU is listed; rated AC output and phase were not verified from the accessible product page.'
    }
].map((product) => ({ ...product, manufacturer: product.brand, verificationDate: verifiedAt }));

module.exports = products;
