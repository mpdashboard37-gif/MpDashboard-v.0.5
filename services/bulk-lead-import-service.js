const crypto = require('node:crypto');
const { isValidLeadNumber } = require('./lead-number');
const { IMPORT_BATCH_SIZE, assignRoundRobin, validateLeadRows } = require('./lead-import');

const SALES_ROLES = ['Sales Executive', 'Sales Manager', 'GM/AGM', 'Telecaller'];

function canImportLeads(user) {
    return user?.role === 'Admin/Owner';
}

async function nextLeadId(transaction) {
    let id;
    do {
        id = `INP-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`;
    } while (await transaction.get('SELECT id FROM leads WHERE id = ?', [id]));
    return id;
}

function asPublicStatus(job) {
    return {
        id: job.id,
        status: job.status,
        totalRows: Number(job.total_rows),
        processedRows: Number(job.processed_rows),
        createdCount: Number(job.created_count),
        duplicateCount: Number(job.duplicate_count),
        failedCount: Number(job.failed_count),
        sourceFilename: job.source_filename,
        error: job.error_message || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
    };
}

function createBulkLeadImportService(repository, leadRepository) {
    const runningJobs = new Set();

    async function process(jobId) {
        if (runningJobs.has(jobId)) return;
        runningJobs.add(jobId);
        try {
            const job = await repository.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
            if (!job || !['QUEUED', 'PROCESSING'].includes(job.status)) return;
            await repository.run("UPDATE lead_imports SET status = 'PROCESSING', updated_at = ? WHERE id = ? AND status = 'QUEUED'", [new Date().toISOString(), jobId]);

            while (true) {
                const current = await repository.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
                if (!current || current.status !== 'PROCESSING') return;
                const rows = JSON.parse(current.rows_json);
                const pending = rows.filter((row) => row.valid && !row.outcome).slice(0, IMPORT_BATCH_SIZE);
                if (!pending.length) break;

                try {
                    await repository.transaction(async (tx) => {
                        const lockedJob = await tx.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
                        if (!lockedJob || lockedJob.status !== 'PROCESSING') return;
                        const currentRows = JSON.parse(lockedJob.rows_json);
                        const currentPending = currentRows.filter((row) => row.valid && !row.outcome).slice(0, IMPORT_BATCH_SIZE);
                        if (!currentPending.length) return;
                        const existingLeads = await tx.all('SELECT mobile_number, email FROM leads');
                        const checked = validateLeadRows(currentPending, existingLeads);
                        const rejected = checked.filter((row) => row.duplicateReason);
                        const validRows = checked.filter((row) => row.valid);
                        const leadSources = new Map(currentPending.map((row) => [row.rowNumber, row.leadSource || 'Website']));
                        const employeeRows = await tx.all(
                            `SELECT id FROM staff WHERE status = 'Active' AND account_status = 'ACTIVE' AND role IN (${SALES_ROLES.map(() => '?').join(', ')}) ORDER BY id`,
                            SALES_ROLES
                        );
                        if (validRows.length && !employeeRows.length) throw new Error('NO_ELIGIBLE_EMPLOYEES');
                        const assignedRows = assignRoundRobin(validRows, employeeRows, Number(lockedJob.created_count));
                        const timestamp = new Date().toISOString();

                        for (const row of assignedRows) {
                            const leadNumber = (await leadRepository.nextLeadNumber(tx)).nextNumber;
                            if (!isValidLeadNumber(leadNumber)) throw new Error('Lead number capacity has been reached.');
                            const details = { address: row.address, pincode: row.pincode, stage: 'New' };
                            const lead = {
                                id: await nextLeadId(tx),
                                leadNumber,
                                customerName: row.customerName,
                                mobileNumber: row.mobileNumber,
                                email: row.email || null,
                                leadDate: timestamp.slice(0, 10),
                                leadSource: leadSources.get(row.rowNumber) || 'Website',
                                assignedTo: row.assignedTo,
                                priority: 'Warm',
                                location: row.address || null,
                                createdBy: current.user_id,
                                timestamp,
                                activityId: crypto.randomUUID(),
                                notificationId: crypto.randomUUID()
                            };
                            await leadRepository.createLead(tx, lead, details);
                            const rowState = currentRows.find((item) => item.rowNumber === row.rowNumber);
                            rowState.outcome = 'created';
                            rowState.assignedTo = row.assignedTo;
                        }

                        for (const row of rejected) {
                            const rowState = currentRows.find((item) => item.rowNumber === row.rowNumber);
                            rowState.outcome = 'duplicate';
                            rowState.duplicateReason = row.duplicateReason;
                            rowState.valid = false;
                        }
                        const processedRows = currentPending.length;
                        const failedCount = Number(lockedJob.failed_count);
                        const duplicateCount = Number(lockedJob.duplicate_count) + rejected.length;
                        const createdCount = Number(lockedJob.created_count) + assignedRows.length;
                        await tx.run(
                            'UPDATE lead_imports SET rows_json = ?, processed_rows = processed_rows + ?, created_count = ?, duplicate_count = ?, failed_count = ?, updated_at = ? WHERE id = ? AND status = ?',
                            [JSON.stringify(currentRows), processedRows, createdCount, duplicateCount, failedCount, timestamp, jobId, 'PROCESSING']
                        );
                    });
                } catch (error) {
                    const currentAfterFailure = await repository.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
                    if (!currentAfterFailure || currentAfterFailure.status !== 'PROCESSING') return;
                    const failedRows = JSON.parse(currentAfterFailure.rows_json);
                    const originalBatchNumbers = new Set(pending.map((row) => row.rowNumber));
                    const batch = failedRows.filter((row) => originalBatchNumbers.has(row.rowNumber) && row.valid && !row.outcome);
                    if (!batch.length) continue;
                    for (const row of batch) {
                        row.outcome = 'failed';
                        row.valid = false;
                        row.errors = [...(row.errors || []), error.message === 'NO_ELIGIBLE_EMPLOYEES'
                            ? 'No eligible active sales employees are available for assignment.'
                            : 'This batch could not be committed; no leads from this batch were created.'];
                    }
                    await repository.transaction(async (tx) => {
                        await tx.run(
                            'UPDATE lead_imports SET rows_json = ?, processed_rows = processed_rows + ?, failed_count = failed_count + ?, error_message = ?, updated_at = ? WHERE id = ? AND status = ?',
                            [JSON.stringify(failedRows), batch.length, batch.length, error.message === 'NO_ELIGIBLE_EMPLOYEES' ? 'No eligible active sales employees are available for assignment.' : null, new Date().toISOString(), jobId, 'PROCESSING']
                        );
                    });
                }
            }

            await repository.transaction(async (tx) => {
                const finished = await tx.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
                if (!finished || finished.status !== 'PROCESSING') return;
                const terminalStatus = Number(finished.failed_count) === 0 && Number(finished.duplicate_count) === 0 ? 'COMPLETED' : 'PARTIAL';
                const timestamp = new Date().toISOString();
                await tx.run('UPDATE lead_imports SET status = ?, processed_rows = total_rows, updated_at = ? WHERE id = ? AND status = ?', [terminalStatus, timestamp, jobId, 'PROCESSING']);
                await tx.run('DELETE FROM lead_import_lock WHERE job_id = ?', [jobId]);
                await tx.run('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
                    finished.user_id,
                    terminalStatus === 'COMPLETED' ? 'Bulk lead import completed' : 'Bulk lead import partially completed',
                    'lead_import',
                    jobId,
                    JSON.stringify({ totalRows: finished.total_rows, createdCount: finished.created_count, duplicateCount: finished.duplicate_count, failedCount: finished.failed_count }),
                    timestamp
                ]);
            });
        } finally {
            runningJobs.delete(jobId);
        }
    }

    function schedule(jobId) {
        setImmediate(() => {
            process(jobId).catch(async (error) => {
                console.error('Lead import worker failed.', { jobId, error: error.message || error.name });
                try {
                    await repository.transaction(async (tx) => {
                        const job = await tx.get('SELECT * FROM lead_imports WHERE id = ?', [jobId]);
                        if (!job || !['QUEUED', 'PROCESSING'].includes(job.status)) return;
                        let rows = [];
                        try { rows = JSON.parse(job.rows_json); } catch (parseError) { }
                        const pendingRows = rows.filter((row) => row.valid && !row.outcome);
                        for (const row of pendingRows) {
                            row.outcome = 'failed';
                            row.valid = false;
                            row.errors = [...(row.errors || []), 'Import stopped unexpectedly; this row was not confirmed as created.'];
                        }
                        const remainingCount = Math.max(0, Number(job.total_rows) - Number(job.processed_rows));
                        const finalStatus = Number(job.created_count) > 0 ? 'PARTIAL' : 'FAILED';
                        const timestamp = new Date().toISOString();
                        await tx.run(
                            'UPDATE lead_imports SET status = ?, rows_json = ?, processed_rows = total_rows, failed_count = failed_count + ?, error_message = ?, updated_at = ? WHERE id = ? AND status IN (?, ?)',
                            [finalStatus, JSON.stringify(rows), remainingCount, 'Import stopped unexpectedly; unconfirmed rows were not counted as successful.', timestamp, jobId, 'QUEUED', 'PROCESSING']
                        );
                        await tx.run('DELETE FROM lead_import_lock WHERE job_id = ?', [jobId]);
                        await tx.run('INSERT INTO audit_logs (user_id, action, record_type, record_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
                            job.user_id,
                            'Bulk lead import stopped',
                            'lead_import',
                            jobId,
                            JSON.stringify({ totalRows: job.total_rows, createdCount: job.created_count, failedCount: Number(job.failed_count) + remainingCount }),
                            timestamp
                        ]);
                    });
                } catch (persistError) {
                    console.error('Unable to persist lead import failure status.', { jobId, error: persistError.message || persistError.name });
                }
            });
        });
    }

    async function resume() {
        const jobs = await repository.all("SELECT id FROM lead_imports WHERE status IN ('QUEUED', 'PROCESSING') ORDER BY created_at, id");
        jobs.forEach((job) => schedule(job.id));
    }

    return { process, resume, schedule };
}

module.exports = { asPublicStatus, canImportLeads, createBulkLeadImportService };
