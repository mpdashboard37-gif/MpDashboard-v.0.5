function amountInCents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Math.round(amount * 100);
}

function validatePaymentSchedule(schedule, projectAmount, bookingAmount = 0) {
    if (schedule === undefined || schedule === null || schedule === '') {
        return { valid: true, structured: false, milestones: [], bookingAmount: Number(bookingAmount || 0) };
    }

    let rows = schedule;
    if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch (error) {
            return { valid: false, error: 'Payment milestones must be valid JSON.' };
        }
    }
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12) {
        return { valid: false, error: 'Enter between 1 and 12 payment milestones.' };
    }

    const projectCents = amountInCents(projectAmount);
    if (!projectCents) return { valid: false, error: 'The final project amount must be greater than zero.' };
    const bookingValue = Number(bookingAmount || 0);
    if (!Number.isFinite(bookingValue) || bookingValue < 0) {
        return { valid: false, error: 'Booking amount must be a valid non-negative currency amount.' };
    }

    const milestones = [];
    let percentageCount = 0;
    let percentageTotal = 0;
    let amountTotal = 0;
    let bookingIndex = -1;
    for (const [index, row] of rows.entries()) {
        const label = String(row?.label || '').trim();
        const type = String(row?.type || '').trim().toLowerCase();
        const value = Number(row?.value);
        if (!label || !Number.isFinite(value) || value <= 0) {
            return { valid: false, error: 'Every payment milestone needs a label and a positive amount.' };
        }

        let amountCents;
        if (type === 'percentage') {
            if (value > 100) return { valid: false, error: 'A payment percentage cannot exceed 100%.' };
            percentageCount += 1;
            percentageTotal += value;
            amountCents = Math.round(projectCents * value / 100);
        } else if (type === 'fixed') {
            amountCents = amountInCents(value);
            if (!amountCents) return { valid: false, error: 'Fixed payment amounts must be greater than zero.' };
        } else {
            return { valid: false, error: 'Choose percentage or fixed amount for every milestone.' };
        }

        if (row.isBooking === true || row.isBooking === 'true') {
            if (bookingIndex >= 0) return { valid: false, error: 'Only one milestone can be the booking payment.' };
            bookingIndex = index;
        }
        milestones.push({ label, type, value, amountCents, isBooking: row.isBooking === true || row.isBooking === 'true' });
        amountTotal += amountCents;
    }

    if (percentageTotal > 100) return { valid: false, error: 'Payment percentages cannot add up to more than 100%.' };
    const difference = projectCents - amountTotal;
    const roundingTolerance = Math.floor(percentageCount / 2);
    if (difference !== 0) {
        if (!percentageCount || Math.abs(difference) > roundingTolerance) {
            return { valid: false, error: 'Payment milestones must add up to the final project amount.' };
        }
        const lastPercentage = milestones.findLastIndex((milestone) => milestone.type === 'percentage');
        if (lastPercentage < 0 || milestones[lastPercentage].amountCents + difference <= 0) {
            return { valid: false, error: 'Payment milestone rounding could not be reconciled safely.' };
        }
        milestones[lastPercentage].amountCents += difference;
        amountTotal += difference;
    }

    const suppliedBookingCents = bookingValue > 0 ? amountInCents(bookingValue) : 0;
    if (bookingValue > 0 && !suppliedBookingCents) {
        return { valid: false, error: 'Booking amount must be a positive currency amount.' };
    }
    if (suppliedBookingCents && bookingIndex < 0) {
        return { valid: false, error: 'Mark the booking milestone so it can be matched to the booking amount.' };
    }
    if (bookingIndex >= 0 && suppliedBookingCents && milestones[bookingIndex].amountCents !== suppliedBookingCents) {
        return { valid: false, error: 'Booking amount must match the booking milestone.' };
    }
    const resolvedBookingCents = bookingIndex >= 0 ? milestones[bookingIndex].amountCents : 0;
    if (amountTotal !== projectCents) return { valid: false, error: 'Payment milestones must add up to the final project amount.' };

    return {
        valid: true,
        structured: true,
        milestones: milestones.map(({ amountCents, ...milestone }) => ({ ...milestone, amount: amountCents / 100 })),
        bookingAmount: resolvedBookingCents / 100,
        totalAmount: amountTotal / 100
    };
}

module.exports = { validatePaymentSchedule };
