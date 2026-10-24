const XLSX = require('xlsx');
const { normalizeIndianMobileNumber } = require('./mobile-number');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10000;
const IMPORT_BATCH_SIZE = 500;
const IMPORT_COLUMNS = ['Customer Name', 'Contact Number', 'Email ID', 'Customer Address', 'Pincode'];
const HEADER_KEYS = new Map(IMPORT_COLUMNS.map((column) => [column.toLowerCase(), column]));

function cellText(cell) {
    if (!cell) return '';
    if (cell.f) return `=${String(cell.f)}`;
    if (cell.v === undefined || cell.v === null) return '';
    const value = cell.w !== undefined ? cell.w : cell.v;
    return String(value).trim();
}

function parseLeadFile(buffer, filename) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('The uploaded file is empty.');
    if (buffer.length > MAX_IMPORT_BYTES) throw new Error(`File exceeds the ${MAX_IMPORT_BYTES / 1024 / 1024} MB limit.`);

    const extension = String(filename || '').toLowerCase().match(/\.(xlsx|xls|csv)$/)?.[1];
    if (!extension) throw new Error('Unsupported file type. Upload an .xlsx, .xls, or .csv file.');
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isOle = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if ((extension === 'xlsx' && !isZip) || (extension === 'xls' && !isOle) || (extension === 'csv' && (buffer.includes(0) || isZip || isOle))) {
        throw new Error('File contents do not match the selected spreadsheet format.');
    }

    let workbook;
    try {
        workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true, sheetRows: MAX_IMPORT_ROWS + 2, WTF: true });
    } catch (error) {
        throw new Error('Unable to parse the spreadsheet. Check that it is not malformed or password protected.');
    }
    const firstSheetName = workbook.SheetNames[0];
    const sheet = firstSheetName && workbook.Sheets[firstSheetName];
    if (!sheet || !sheet['!ref']) throw new Error('The spreadsheet does not contain any rows.');
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.s.r !== 0 || range.s.c !== 0) throw new Error('The required column headers must start in cell A1.');
    const dataRowCount = Math.max(0, range.e.r - range.s.r);
    if (dataRowCount > MAX_IMPORT_ROWS) throw new Error(`The spreadsheet exceeds the ${MAX_IMPORT_ROWS} row limit.`);
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    if (!matrix.length) throw new Error('The spreadsheet does not contain a header row.');

    const headerIndexes = new Map();
    for (let index = 0; index < matrix[0].length; index += 1) {
        const key = String(matrix[0][index] || '').trim().toLowerCase();
        const column = HEADER_KEYS.get(key);
        if (column) {
            if (headerIndexes.has(column)) throw new Error(`The spreadsheet contains the ${column} column more than once.`);
            headerIndexes.set(column, index);
        }
    }
    const missing = IMPORT_COLUMNS.filter((column) => !headerIndexes.has(column));
    if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}.`);

    return matrix.slice(1).map((_, index) => {
        const rawRowNumber = index + 2;
        const record = {};
        const formulaColumns = [];
        for (const column of IMPORT_COLUMNS) {
            const cell = sheet[XLSX.utils.encode_cell({ r: rawRowNumber - 1, c: headerIndexes.get(column) })];
            record[column] = cellText(cell);
            if (cell?.f) formulaColumns.push(column);
        }
        return { rowNumber: rawRowNumber, ...record, formulaColumns };
    });
}

function validateLeadRows(rows, existingLeads = []) {
    const knownMobiles = new Set();
    const knownEmails = new Set();
    const incomingMobiles = new Set();
    const incomingEmails = new Set();

    for (const lead of existingLeads) {
        const mobile = normalizeIndianMobileNumber(lead.mobile_number);
        if (mobile) knownMobiles.add(mobile);
        const email = String(lead.email || '').trim();
        if (email) knownEmails.add(email);
    }

    return rows.map((row) => {
        const customerName = String(row['Customer Name'] ?? row.customerName ?? '').trim().replace(/\s+/g, ' ');
        const inputContact = String(row['Contact Number'] ?? row.mobileNumber ?? '').trim();
        const mobileNumber = normalizeIndianMobileNumber(inputContact);
        const email = String(row['Email ID'] ?? row.email ?? '').trim();
        const address = String(row['Customer Address'] ?? row.address ?? '').trim();
        const pincode = String(row.Pincode ?? row.pincode ?? '').trim();
        const errors = [];
        if (Array.isArray(row.formulaColumns) && row.formulaColumns.length) errors.push('Formula values are not supported.');
        if (!customerName) errors.push('Customer Name is required.');
        if (!inputContact) errors.push('Contact Number is required.');
        else if (!mobileNumber) errors.push('Contact Number must be a valid 10-digit Indian mobile number.');
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email ID must be a valid email address.');
        if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) errors.push('Pincode must be a valid 6-digit Indian pincode.');

        let duplicateReason = '';
        if (mobileNumber && incomingMobiles.has(mobileNumber)) duplicateReason = 'Duplicate contact number within this file.';
        else if (mobileNumber && knownMobiles.has(mobileNumber)) duplicateReason = 'A lead with this contact number already exists.';
        else if (email && incomingEmails.has(email)) duplicateReason = 'Duplicate email address within this file.';
        else if (email && knownEmails.has(email)) duplicateReason = 'A lead with this email address already exists.';

        if (mobileNumber) incomingMobiles.add(mobileNumber);
        if (email) incomingEmails.add(email);
        return {
            rowNumber: Number(row.rowNumber),
            customerName,
            mobileNumber: mobileNumber || inputContact,
            email,
            address,
            pincode,
            errors,
            duplicateReason,
            valid: errors.length === 0 && !duplicateReason
        };
    });
}

function splitImportBatches(rows, batchSize = IMPORT_BATCH_SIZE) {
    const batches = [];
    for (let index = 0; index < rows.length; index += batchSize) batches.push(rows.slice(index, index + batchSize));
    return batches;
}

function assignRoundRobin(rows, employees, startingIndex = 0) {
    if (!employees.length && rows.length) throw new Error('No eligible active sales employees are available for assignment.');
    const orderedEmployees = [...employees].sort((left, right) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0);
    return rows.map((row, index) => ({ ...row, assignedTo: orderedEmployees[(startingIndex + index) % orderedEmployees.length].id }));
}

function toSafeCsv(rows) {
    const headers = ['Excel Row', ...IMPORT_COLUMNS, 'Issue'];
    const escape = (value) => {
        let text = String(value ?? '');
        if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    return [headers, ...rows.map((row) => [
        row.rowNumber,
        row.customerName,
        row.mobileNumber,
        row.email,
        row.address,
        row.pincode,
        [...(row.errors || []), row.duplicateReason].filter(Boolean).join(' ')
    ])].map((line) => line.map(escape).join(',')).join('\r\n');
}

module.exports = {
    IMPORT_BATCH_SIZE,
    IMPORT_COLUMNS,
    MAX_IMPORT_BYTES,
    MAX_IMPORT_ROWS,
    assignRoundRobin,
    parseLeadFile,
    splitImportBatches,
    toSafeCsv,
    validateLeadRows
};
