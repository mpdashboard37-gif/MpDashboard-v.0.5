(() => {
    const PANEL_BRANDS = window.EquipmentCatalogue.PANEL_BRANDS;
    const INVERTER_BRANDS = window.EquipmentCatalogue.INVERTER_BRANDS;
    const $ = (selector, root = document) => root.querySelector(selector);
    const state = { products: [], canManage: false, ready: null, selectedPanelId: '', selectedInverterId: '' };
    const today = new Date().toISOString().slice(0, 10);

    function productById(id) {
        return state.products.find((product) => product.id === id);
    }

    function componentRows() {
        return window.ProposalComponentEditor?.getValue?.() || [];
    }

    function selectedComponent(category) {
        return componentRows().find((item) => item.category === category);
    }

    function setBrandOptions(select, brands, selectedValue = '') {
        const previous = selectedValue || select.value;
        select.replaceChildren(new Option('Select manufacturer', ''));
        brands.forEach((brand) => select.add(new Option(brand, brand)));
        if (previous && !brands.includes(previous)) {
            select.add(new Option(`Legacy: ${previous}`, previous));
        }
        select.value = previous;
    }

    function activeAndMatchingProducts(category, brand, search, type, phase) {
        return window.EquipmentCatalogue.filterEquipmentCatalogue(state.products, {
            category, brand, search, inverterType: type, phase
        });
    }

    function productOptionLabel(product) {
        const rating = product.category === 'solarPanels'
            ? Number(product.ratedWattage) > 0
                ? `${product.ratedWattage} Wp`
                : Number(product.minimumWattage) > 0 && Number(product.maximumWattage) > 0
                    ? `${product.minimumWattage}-${product.maximumWattage} Wp range`
                    : 'exact wattage needs verification'
            : Number(product.ratedCapacityKw) > 0
                ? `${product.ratedCapacityKw} kW AC · ${product.inverterType || 'type needs verification'} · ${product.phase || 'phase needs verification'}`
                : `${product.inverterType || 'type needs verification'} · ${product.phase || 'phase needs verification'} · AC capacity needs verification`;
        const availability = /needs verification/i.test(product.marketApplicability || '')
            ? ' · regional availability needs verification'
            : '';
        const lifecycle = product.status === 'Inactive' ? ' · inactive' : '';
        const dataState = product.verificationStatus !== 'Verified' ? ' · needs verification' : '';
        return `${product.model} · ${rating}${availability}${dataState}${lifecycle}`;
    }

    function addOption(select, value, label, disabled = false) {
        const option = new Option(label, value);
        option.disabled = disabled;
        select.add(option);
        return option;
    }

    function renderProductSelect(category, selectedId = '') {
        const isPanel = category === 'solarPanels';
        const select = $(isPanel ? '#panelModelSelect' : '#inverterModelSelect');
        const brand = $(isPanel ? '#panelBrandSelect' : '#inverterBrandSelect').value;
        const search = $(isPanel ? '#panelModelSearch' : '#inverterModelSearch').value;
        const type = isPanel ? '' : $('#inverterTypeFilter').value;
        const phase = isPanel ? '' : $('#inverterPhaseFilter').value;
        const products = activeAndMatchingProducts(category, brand, search, type, phase);
        select.replaceChildren();
        if (!brand) {
            addOption(select, '', 'Select brand first');
            select.disabled = true;
            return;
        }
        if (!products.length) {
            addOption(select, '', 'No catalogue models match these filters');
            select.disabled = true;
            return;
        }
        addOption(select, '', 'Select a model');
        products.forEach((product) => {
            addOption(select, product.id, productOptionLabel(product), !product.selectable);
        });
        const savedId = selectedId || (isPanel ? state.selectedPanelId : state.selectedInverterId);
        if (savedId && !products.some((product) => product.id === savedId)) {
            const selectedProduct = productById(savedId);
            if (selectedProduct) {
                addOption(select, savedId, `${productOptionLabel(selectedProduct)} · current selection outside filters`);
            }
        }
        select.disabled = false;
        select.value = savedId && [...select.options].some((option) => option.value === savedId) ? savedId : '';
    }

    function updatePanelCapacity() {
        const wattage = Number($('[name="panelWattage"]').value || 0);
        const count = Number($('[name="panelCount"]').value || 0);
        $('#panelDcCapacity').textContent = `Total panel DC capacity: ${(wattage * count / 1000).toFixed(2)} kW`;
    }

    function setCatalogueStatus(category, product, savedSnapshot = false) {
        const status = $(`#${category === 'solarPanels' ? 'panel' : 'inverter'}CatalogueStatus`);
        if (!product) {
            status.textContent = category === 'solarPanels'
                ? 'Select an exact, verified panel model to populate wattage.'
                : 'Select a manufacturer, then filter and choose a verified model.';
            return;
        }
        const snapshotLabel = savedSnapshot ? 'Saved proposal specification' : product.verificationStatus;
        const availability = product.marketApplicability || 'Regional availability needs verification';
        status.textContent = `${snapshotLabel} · ${availability} · Verified ${product.verificationDate || 'date not recorded'}`;
    }

    function syncProposalComponent(category, product, snapshot = null) {
        const rows = componentRows();
        const index = rows.findIndex((item) => item.category === category);
        const current = index >= 0 ? rows[index] : {};
        const row = {
            ...current,
            category,
            brand: product?.brand || snapshot?.brand || current.brand || '',
            manufacturer: product?.manufacturer || snapshot?.manufacturer || current.manufacturer || '',
            series: product?.series || snapshot?.series || current.series || '',
            model: product?.model || snapshot?.model || '',
            technicalSpecification: product
                ? category === 'inverter'
                    ? [product.inverterType, product.phase, product.marketApplicability].filter(Boolean).join('; ')
                    : [product.series, product.marketApplicability].filter(Boolean).join('; ')
                : snapshot?.technicalSpecification || '',
            rating: category === 'solarPanels'
                ? product ? `${product.ratedWattage} Wp` : snapshot?.rating || ''
                : product ? `${product.ratedCapacityKw} kW AC` : snapshot?.rating || '',
            sizeCapacity: category === 'inverter'
                ? product ? `${product.ratedCapacityKw} kW` : snapshot?.sizeCapacity || ''
                : current.sizeCapacity || '',
            quantity: category === 'solarPanels'
                ? Math.max(1, Number($('[name="panelCount"]').value) || Number(current.quantity) || 1)
                : Number(current.quantity) || 1,
            unit: current.unit || 'pcs',
            inclusionStatus: current.inclusionStatus || 'included',
            catalogueProductId: product?.id || snapshot?.catalogueProductId || '',
            catalogueSourceUrl: product?.sourceUrl || snapshot?.catalogueSourceUrl || '',
            catalogueDatasheetUrl: product?.datasheetUrl || snapshot?.catalogueDatasheetUrl || '',
            catalogueVerificationDate: product?.verificationDate || snapshot?.catalogueVerificationDate || '',
            catalogueMarketApplicability: product?.marketApplicability || snapshot?.catalogueMarketApplicability || '',
            catalogueVerificationStatus: product?.verificationStatus || snapshot?.catalogueVerificationStatus || '',
            inverterType: category === 'inverter' ? product?.inverterType || snapshot?.inverterType || '' : '',
            phase: category === 'inverter' ? product?.phase || snapshot?.phase || '' : '',
            remarks: product
                ? `Catalogue source: ${product.sourceUrl} · Verification date: ${product.verificationDate} · ${product.marketApplicability}`
                : snapshot?.remarks || current.remarks || ''
        };
        if (index >= 0) rows[index] = row;
        else rows.push(row);
        window.ProposalComponentEditor.setValue(rows);
    }

    function clearProposalComponentSelection(category) {
        const rows = componentRows();
        const index = rows.findIndex((item) => item.category === category);
        if (index < 0) return;
        rows[index] = {
            ...rows[index],
            brand: '',
            manufacturer: '',
            series: '',
            model: '',
            technicalSpecification: '',
            rating: '',
            sizeCapacity: '',
            catalogueProductId: '',
            catalogueSourceUrl: '',
            catalogueDatasheetUrl: '',
            catalogueVerificationDate: '',
            catalogueMarketApplicability: '',
            catalogueVerificationStatus: '',
            inverterType: '',
            phase: '',
            remarks: ''
        };
        window.ProposalComponentEditor.setValue(rows);
    }

    function applyProduct(category, product) {
        const isPanel = category === 'solarPanels';
        const quantity = isPanel
            ? Number($('[name="panelCount"]').value) || 1
            : 1;
        const selection = window.EquipmentCatalogue.getEquipmentSelection(product, quantity);
        if (isPanel) {
            state.selectedPanelId = product.id;
            $('[name="panelBrand"]').value = product.brand;
            $('[name="panelWattage"]').value = selection.ratedWattage;
            if (!(Number($('[name="panelCount"]').value) > 0)) $('[name="panelCount"]').value = '1';
            renderProductSelect(category, product.id);
            updatePanelCapacity();
        } else {
            state.selectedInverterId = product.id;
            $('[name="inverterBrand"]').value = product.brand;
            $('[name="inverterCapacity"]').value = selection.ratedCapacityKw;
            $('[name="inverterPhase"]').value = selection.phase;
            renderProductSelect(category, product.id);
            $('[name="inverterPhase"]').dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncProposalComponent(category, product);
        setCatalogueStatus(category, product);
    }

    function restoreSelection(proposal) {
        const rows = Array.isArray(proposal?.componentConfiguration)
            ? proposal.componentConfiguration
            : Array.isArray(proposal?.pricing?.componentConfiguration)
                ? proposal.pricing.componentConfiguration
                : componentRows();
        const panel = rows.find((item) => item.category === 'solarPanels');
        const inverter = rows.find((item) => item.category === 'inverter');
        const panelBrand = proposal?.panelBrand || panel?.brand || '';
        const inverterBrand = proposal?.inverterBrand || inverter?.brand || '';
        setBrandOptions($('#panelBrandSelect'), PANEL_BRANDS, panelBrand);
        setBrandOptions($('#inverterBrandSelect'), INVERTER_BRANDS, inverterBrand);

        const panelMatch = state.products.find((product) => (
            product.category === 'solarPanels'
            && (product.id === panel?.catalogueProductId
                || (product.brand === panelBrand && product.model === panel?.model
                    && Number(product.ratedWattage) === Number(proposal?.panelWattage || panel?.rating?.match(/[\d.]+/)?.[0])))
        ));
        const inverterMatch = state.products.find((product) => (
            product.category === 'inverter'
            && (product.id === inverter?.catalogueProductId
                || (product.brand === inverterBrand && product.model === inverter?.model))
        ));

        state.selectedPanelId = panel?.catalogueProductId || panelMatch?.id || '';
        state.selectedInverterId = inverter?.catalogueProductId || inverterMatch?.id || '';
        if (inverter?.inverterType) $('#inverterTypeFilter').value = inverter.inverterType;
        if (inverter?.phase) $('#inverterPhaseFilter').value = inverter.phase;
        renderProductSelect('solarPanels', state.selectedPanelId);
        renderProductSelect('inverter', state.selectedInverterId);

        if (panel && !panelMatch) {
            addOption($('#panelModelSelect'), `saved-panel-${panel.model}`, `${panel.model} · saved proposal snapshot (not in active catalogue)`);
            $('#panelModelSelect').value = `saved-panel-${panel.model}`;
            setCatalogueStatus('solarPanels', {
                verificationStatus: panel.catalogueVerificationStatus || 'Needs verification',
                marketApplicability: panel.catalogueMarketApplicability || 'Regional availability needs verification',
                verificationDate: panel.catalogueVerificationDate || ''
            }, true);
        } else {
            $('#panelModelSelect').value = panelMatch?.id || '';
            if (panelMatch) setCatalogueStatus('solarPanels', panelMatch);
        }
        if (inverter && !inverterMatch) {
            addOption($('#inverterModelSelect'), `saved-inverter-${inverter.model}`, `${inverter.model} · saved proposal snapshot (not in active catalogue)`);
            $('#inverterModelSelect').value = `saved-inverter-${inverter.model}`;
            setCatalogueStatus('inverter', {
                verificationStatus: inverter.catalogueVerificationStatus || 'Needs verification',
                marketApplicability: inverter.catalogueMarketApplicability || 'Regional availability needs verification',
                verificationDate: inverter.catalogueVerificationDate || ''
            }, true);
        } else {
            $('#inverterModelSelect').value = inverterMatch?.id || '';
            if (inverterMatch) setCatalogueStatus('inverter', inverterMatch);
        }
        updatePanelCapacity();
        $('#proposalForm').dispatchEvent(new Event('input'));
    }

    async function loadCatalogue() {
        const result = await crmApi.request('/api/equipment-catalogue');
        state.products = result.products || [];
        state.canManage = result.canManage === true;
        $('#manageEquipmentCatalogueButton').classList.toggle('hidden', !state.canManage);
        setBrandOptions($('#panelBrandSelect'), PANEL_BRANDS);
        setBrandOptions($('#inverterBrandSelect'), INVERTER_BRANDS);
        renderProductSelect('solarPanels');
        renderProductSelect('inverter');
    }

    function catalogueReady() {
        if (!state.ready) state.ready = loadCatalogue();
        return state.ready;
    }

    function formatProductSpecifications(product) {
        if (product.category === 'solarPanels') {
            if (Number(product.ratedWattage) > 0) return `${product.ratedWattage} Wp`;
            if (Number(product.minimumWattage) > 0 && Number(product.maximumWattage) > 0) {
                return `${product.minimumWattage}-${product.maximumWattage} Wp range`;
            }
            return 'Exact Wp needs verification';
        }
        return `${product.ratedCapacityKw || 'Capacity needs verification'} kW AC · ${product.inverterType || 'type needs verification'} · ${product.phase || 'phase needs verification'}`;
    }

    function productCanActivate(product) {
        return product.category === 'solarPanels'
            ? product.verificationStatus === 'Verified' && Number(product.ratedWattage) > 0
            : product.verificationStatus === 'Verified'
                && Number(product.ratedCapacityKw) > 0
                && Boolean(product.inverterType)
                && Boolean(product.phase);
    }

    function productRowsForManager() {
        const query = String($('#catalogueManagerSearch')?.value || '').trim().toLowerCase();
        const category = $('#catalogueManagerCategory')?.value || '';
        const brand = $('#catalogueManagerBrand')?.value || '';
        const status = $('#catalogueManagerStatus')?.value || '';
        return state.products.filter((product) => (
            (!category || product.category === category)
            && (!brand || product.brand === brand)
            && (!status || product.status === status)
            && (!query || `${product.brand} ${product.series} ${product.model} ${product.notes}`.toLowerCase().includes(query))
        ));
    }

    function renderManagerRows() {
        const body = $('#catalogueManagerRows');
        if (!body) return;
        const rows = productRowsForManager();
        body.innerHTML = rows.map((product) => {
            const activateDisabled = product.status === 'Inactive' && !productCanActivate(product);
            const buttonText = product.status === 'Active' ? 'Deactivate' : 'Activate';
            return `<tr class="border-t border-slate-200 align-top">
                <td class="px-3 py-3"><strong>${esc(product.brand)}</strong><div class="text-xs text-slate-500">${esc(product.series || '')}</div></td>
                <td class="px-3 py-3">${esc(product.model)}<div class="text-xs text-slate-500">${esc(formatProductSpecifications(product))}</div><div class="text-xs text-slate-500">${esc(product.inverterType || '')}${product.phase ? ` · ${esc(product.phase)}` : ''}</div></td>
                <td class="px-3 py-3">${esc(product.verificationStatus)}<div class="text-xs text-slate-500">${esc(product.marketApplicability)}</div></td>
                <td class="px-3 py-3"><a class="text-blue-700 underline" href="${esc(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a><div class="text-xs text-slate-500">Verified ${esc(product.verificationDate)}</div></td>
                <td class="px-3 py-3"><button type="button" data-catalogue-status="${esc(product.id)}" data-status="${product.status === 'Active' ? 'Inactive' : 'Active'}" ${activateDisabled ? 'disabled title="Verify exact specifications and add the model as a verified catalogue entry first."' : ''} class="rounded border border-slate-300 px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">${buttonText}</button></td>
            </tr>`;
        }).join('');
        $('#catalogueManagerCount').textContent = `${rows.length} products`;
    }

    function managerMarkup() {
        const brands = [...new Set(state.products.map((product) => product.brand))];
        const brandOptions = ['<option value="">All brands</option>', ...brands.map((brand) => `<option value="${esc(brand)}">${esc(brand)}</option>`)].join('');
        return `<div class="border-b border-slate-200 px-6 py-5"><div class="flex items-start justify-between gap-4"><div><p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-700">Admin catalogue</p><h2 class="mt-1 text-xl font-bold">Equipment catalogue</h2><p class="mt-1 text-sm text-slate-500">Existing records are never overwritten. Only verified exact specifications can be activated for proposals.</p></div><button type="button" data-close class="rounded-lg p-2" aria-label="Close catalogue manager"><span class="material-symbols-outlined">close</span></button></div></div>
            <div class="space-y-5 p-6">
                <section class="rounded-lg border border-slate-200 p-4">
                    <h3 class="font-bold">Add verified model</h3>
                    <form id="catalogueAddForm" class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <label><span class="label">Category</span><select class="field" name="category" id="catalogueAddCategory" required><option value="solarPanels">Solar panel</option><option value="inverter">Inverter</option></select></label>
                        <label><span class="label">Brand</span><select class="field" name="brand" id="catalogueAddBrand" required></select></label>
                        <label><span class="label">Manufacturer</span><input class="field" name="manufacturer" maxlength="120" placeholder="Defaults to brand"></label>
                        <label><span class="label">Product series</span><input class="field" name="series" maxlength="200"></label>
                        <label class="sm:col-span-2"><span class="label">Exact model / SKU</span><input class="field" name="model" maxlength="200" required></label>
                        <label data-catalogue-panel-field><span class="label">Rated panel wattage (Wp)</span><input class="field" name="ratedWattage" type="number" min="1" step="any"></label>
                        <label data-catalogue-panel-field><span class="label">Minimum series wattage (Wp)</span><input class="field" name="minimumWattage" type="number" min="1" step="any"></label>
                        <label data-catalogue-panel-field><span class="label">Maximum series wattage (Wp)</span><input class="field" name="maximumWattage" type="number" min="1" step="any"></label>
                        <label data-catalogue-inverter-field class="hidden"><span class="label">Rated AC capacity (kW)</span><input class="field" name="ratedCapacityKw" type="number" min="0.1" step="0.1"></label>
                        <label data-catalogue-inverter-field class="hidden"><span class="label">Inverter type</span><select class="field" name="inverterType"><option value="">Select type</option><option>On-grid</option><option>Hybrid</option><option>Off-grid</option><option>Micro</option></select></label>
                        <label data-catalogue-inverter-field class="hidden"><span class="label">Phase</span><select class="field" name="phase"><option value="">Select phase</option><option>Single Phase</option><option>Three Phase</option></select></label>
                        <label><span class="label">Market / region</span><input class="field" name="marketApplicability" value="Needs verification" maxlength="240" required></label>
                        <label><span class="label">Official source URL</span><input class="field" name="sourceUrl" type="url" required></label>
                        <label><span class="label">Datasheet URL</span><input class="field" name="datasheetUrl" type="url"></label>
                        <label><span class="label">Verification date</span><input class="field" name="verificationDate" type="date" value="${today}" required></label>
                        <label class="sm:col-span-2"><span class="label">Verification notes</span><input class="field" name="notes" maxlength="1000"></label>
                        <div class="flex items-end"><button class="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">Add verified model</button></div>
                    </form>
                </section>
                <section>
                    <div class="mb-3 flex flex-wrap items-end gap-3">
                        <label class="min-w-52 flex-1"><span class="label">Search</span><input class="field" id="catalogueManagerSearch" type="search" placeholder="Brand, series or model"></label>
                        <label><span class="label">Category</span><select class="field" id="catalogueManagerCategory"><option value="">All categories</option><option value="solarPanels">Solar panels</option><option value="inverter">Inverters</option></select></label>
                        <label><span class="label">Brand</span><select class="field" id="catalogueManagerBrand">${brandOptions}</select></label>
                        <label><span class="label">Status</span><select class="field" id="catalogueManagerStatus"><option value="">All</option><option>Active</option><option>Inactive</option></select></label>
                        <span class="pb-2 text-xs text-slate-500" id="catalogueManagerCount"></span>
                    </div>
                    <div class="max-h-96 overflow-auto rounded-lg border border-slate-200">
                        <table class="w-full min-w-[850px] text-left text-xs"><thead class="sticky top-0 bg-slate-50"><tr><th class="px-3 py-2">Manufacturer</th><th class="px-3 py-2">Model / specification</th><th class="px-3 py-2">Verification / region</th><th class="px-3 py-2">Source / date</th><th class="px-3 py-2">Catalogue status</th></tr></thead><tbody id="catalogueManagerRows"></tbody></table>
                    </div>
                </section>
            </div>`;
    }

    function updateCatalogueAddForm() {
        const category = $('#catalogueAddCategory')?.value;
        const brands = category === 'inverter' ? INVERTER_BRANDS : PANEL_BRANDS;
        const brandSelect = $('#catalogueAddBrand');
        if (!brandSelect) return;
        const previous = brandSelect.value;
        brandSelect.replaceChildren(new Option('Select brand', ''));
        brands.forEach((brand) => brandSelect.add(new Option(brand, brand)));
        if (brands.includes(previous)) brandSelect.value = previous;
        document.querySelectorAll('[data-catalogue-panel-field]').forEach((field) => field.classList.toggle('hidden', category !== 'solarPanels'));
        document.querySelectorAll('[data-catalogue-inverter-field]').forEach((field) => field.classList.toggle('hidden', category !== 'inverter'));
        const ratedWattage = $('#catalogueAddForm [name="ratedWattage"]');
        const ratedCapacity = $('#catalogueAddForm [name="ratedCapacityKw"]');
        const inverterType = $('#catalogueAddForm [name="inverterType"]');
        const phase = $('#catalogueAddForm [name="phase"]');
        if (ratedWattage) ratedWattage.required = category === 'solarPanels';
        if (ratedCapacity) ratedCapacity.required = category === 'inverter';
        if (inverterType) inverterType.required = category === 'inverter';
        if (phase) phase.required = category === 'inverter';
        if (category === 'solarPanels') {
            if (ratedCapacity) ratedCapacity.value = '';
            if (inverterType) inverterType.value = '';
            if (phase) phase.value = '';
        } else {
            ['ratedWattage', 'minimumWattage', 'maximumWattage'].forEach((field) => {
                const input = $(`#catalogueAddForm [name="${field}"]`);
                if (input) input.value = '';
            });
        }
    }

    async function openManager() {
        await catalogueReady();
        if (!state.canManage) throw new Error('You do not have permission to manage the equipment catalogue.');
        modal(managerMarkup());
        updateCatalogueAddForm();
        renderManagerRows();
    }

    async function refreshCatalogue() {
        state.ready = loadCatalogue();
        await state.ready;
        renderProductSelect('solarPanels');
        renderProductSelect('inverter');
        restoreSelection(state.current || {});
    }

    function addCatalogMetadataToPreview(proposal) {
        const rows = proposal?.componentConfiguration || proposal?.pricing?.componentConfiguration || [];
        const selected = rows.filter((item) => ['solarPanels', 'inverter'].includes(item.category));
        if (!selected.length) return;
        const modalContent = $('#modalContent');
        const section = document.createElement('section');
        section.className = 'mx-6 mb-6 rounded-xl border border-slate-200 p-4';
        const heading = document.createElement('h3');
        heading.className = 'mb-2 font-bold text-slate-900';
        heading.textContent = 'Selected catalogue equipment';
        section.appendChild(heading);
        selected.forEach((item) => {
            const line = document.createElement('p');
            line.className = 'text-sm text-slate-700';
            const rating = item.category === 'solarPanels'
                ? `${item.rating || ''} · ${item.quantity || 0} panels`
                : `${item.sizeCapacity || item.rating || ''} · ${item.inverterType || ''} · ${item.phase || ''}`;
            line.textContent = `${item.manufacturer || item.brand || ''} ${item.model || ''} · ${rating} · ${item.catalogueVerificationStatus || 'Saved specification'}`;
            section.appendChild(line);
        });
        modalContent.appendChild(section);
    }

    function initialize() {
        const baseForm = window.form;
        if (typeof baseForm === 'function') {
            window.form = async function formWithEquipmentCatalogue(...args) {
                await catalogueReady();
                return baseForm.apply(this, args);
            };
        }

        const baseFill = window.fill;
        if (typeof baseFill === 'function') {
            window.fill = function fillWithEquipmentCatalogue(proposal, lead) {
                baseFill(proposal, lead);
                restoreSelection(proposal || {});
            };
        }

        const basePayload = window.payload;
        if (typeof basePayload === 'function') {
            window.payload = function payloadWithEquipmentCatalogue() {
                const proposal = basePayload();
                proposal.componentConfiguration = componentRows();
                return proposal;
            };
        }

        const basePreview = window.preview;
        if (typeof basePreview === 'function') {
            window.preview = function previewWithEquipmentCatalogue(proposal) {
                basePreview(proposal);
                addCatalogMetadataToPreview(proposal);
            };
        }

        $('#panelBrandSelect').addEventListener('change', () => {
            state.selectedPanelId = '';
            renderProductSelect('solarPanels');
            $('[name="panelWattage"]').value = '';
            clearProposalComponentSelection('solarPanels');
            updatePanelCapacity();
            setCatalogueStatus('solarPanels');
        });
        $('#inverterBrandSelect').addEventListener('change', () => {
            state.selectedInverterId = '';
            renderProductSelect('inverter');
            $('[name="inverterCapacity"]').value = '';
            $('[name="inverterPhase"]').value = '';
            clearProposalComponentSelection('inverter');
            setCatalogueStatus('inverter');
        });
        $('#panelModelSelect').addEventListener('change', (event) => {
            const product = productById(event.target.value);
            if (product?.selectable) applyProduct('solarPanels', product);
        });
        $('#inverterModelSelect').addEventListener('change', (event) => {
            const product = productById(event.target.value);
            if (product?.selectable) applyProduct('inverter', product);
        });
        $('#panelModelSearch').addEventListener('input', () => renderProductSelect('solarPanels'));
        $('#inverterModelSearch').addEventListener('input', () => renderProductSelect('inverter'));
        $('#inverterTypeFilter').addEventListener('change', () => renderProductSelect('inverter'));
        $('#inverterPhaseFilter').addEventListener('change', () => renderProductSelect('inverter'));
        $('[name="panelCount"]').addEventListener('input', () => {
            updatePanelCapacity();
            const index = componentRows().findIndex((item) => item.category === 'solarPanels');
            if (index >= 0) window.ProposalComponentEditor.updateField(index, 'quantity', Number($('[name="panelCount"]').value) || null);
        });
        $('[name="panelWattage"]').addEventListener('input', updatePanelCapacity);
        $('[name="panelCount"]').addEventListener('change', updatePanelCapacity);
        $('[name="systemType"]').addEventListener('change', () => {
            const systemType = String($('[name="systemType"]').value || '').replace('-', '').toLowerCase();
            const mappedType = { ongrid: 'On-grid', hybrid: 'Hybrid', offgrid: 'Off-grid' }[systemType];
            if (mappedType && [...$('#inverterTypeFilter').options].some((option) => option.value === mappedType)) {
                $('#inverterTypeFilter').value = mappedType;
                renderProductSelect('inverter');
            }
        });
        $('#manageEquipmentCatalogueButton').addEventListener('click', () => openManager().catch((error) => toast(error.message, true)));

        document.addEventListener('input', (event) => {
            if (event.target.matches('#catalogueManagerSearch')) renderManagerRows();
        });
        document.addEventListener('change', (event) => {
            if (event.target.matches('#catalogueManagerCategory')) renderManagerRows();
            if (event.target.matches('#catalogueManagerBrand')) renderManagerRows();
            if (event.target.matches('#catalogueManagerStatus')) renderManagerRows();
            if (event.target.matches('#catalogueAddCategory')) updateCatalogueAddForm();
        });
        document.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-catalogue-status]');
            if (!button) return;
            button.disabled = true;
            try {
                await crmApi.request(`/api/equipment-catalogue/${encodeURIComponent(button.dataset.catalogueStatus)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: button.dataset.status })
                });
                await refreshCatalogue();
                await openManager();
                toast(`Catalogue product ${button.dataset.status === 'Active' ? 'activated' : 'deactivated'}.`);
            } catch (error) {
                button.disabled = false;
                toast(error.message, true);
            }
        });
        document.addEventListener('submit', async (event) => {
            if (event.target.id !== 'catalogueAddForm') return;
            event.preventDefault();
            const form = event.target;
            if (!form.reportValidity()) return;
            const values = Object.fromEntries(new FormData(form).entries());
            ['ratedWattage', 'minimumWattage', 'maximumWattage', 'ratedCapacityKw'].forEach((field) => {
                values[field] = values[field] === '' ? null : Number(values[field]);
            });
            values.verificationStatus = 'Verified';
            values.status = 'Active';
            try {
                await crmApi.request('/api/equipment-catalogue', { method: 'POST', body: JSON.stringify(values) });
                form.reset();
                $('#catalogueAddForm [name="marketApplicability"]').value = 'Needs verification';
                $('#catalogueAddForm [name="verificationDate"]').value = today;
                await refreshCatalogue();
                await openManager();
                toast('Verified equipment model added to the catalogue.');
            } catch (error) {
                toast(error.message, true);
            }
        });

        catalogueReady().then(() => {
            if (!$('#formView').classList.contains('hidden')) restoreSelection(state.current || {});
        }).catch((error) => toast(`Unable to load equipment catalogue: ${error.message}`, true));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
