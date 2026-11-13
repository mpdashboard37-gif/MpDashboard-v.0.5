const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validatePaymentSchedule } = require('./payment-schedule');

test('validates percentage milestones and reconciles currency rounding to the project total', () => {
    const result = validatePaymentSchedule([
        { label: 'Booking', type: 'percentage', value: 30, isBooking: true },
        { label: 'Delivery', type: 'percentage', value: 60 },
        { label: 'Commissioning', type: 'percentage', value: 10 }
    ], 850001, 255000.3);

    assert.equal(result.valid, true);
    assert.equal(result.totalAmount, 850001);
    assert.equal(result.bookingAmount, 255000.3);
    assert.equal(result.milestones.reduce((total, milestone) => total + Math.round(milestone.amount * 100), 0), 85000100);
});

test('validates mixed percentage and fixed milestones with a matched booking amount', () => {
    const result = validatePaymentSchedule([
        { label: 'Booking', type: 'fixed', value: 100000, isBooking: true },
        { label: 'Delivery', type: 'percentage', value: 50 },
        { label: 'Commissioning', type: 'fixed', value: 325000 }
    ], 850000, 100000);

    assert.equal(result.valid, true);
    assert.equal(result.totalAmount, 850000);
});

test('rejects invalid amounts, invalid percentages, mismatched totals, and booking mismatches', () => {
    assert.equal(validatePaymentSchedule([{ label: 'Booking', type: 'fixed', value: 0 }], 1000).valid, false);
    assert.equal(validatePaymentSchedule([{ label: 'Booking', type: 'fixed', value: 1000 }], 1000, -1).valid, false);
    assert.equal(validatePaymentSchedule([{ label: 'Booking', type: 'fixed', value: 1000 }], 1000, 'not-an-amount').valid, false);
    assert.equal(validatePaymentSchedule([{ label: 'Booking', type: 'percentage', value: 101 }], 1000).valid, false);
    assert.equal(validatePaymentSchedule([{ label: 'Booking', type: 'percentage', value: 50 }], 1000).valid, false);
    assert.equal(validatePaymentSchedule([
        { label: 'Booking', type: 'fixed', value: 500, isBooking: true },
        { label: 'Final', type: 'fixed', value: 500 }
    ], 1000, 400).valid, false);
});

test('leaves existing free-text schedules unvalidated unless structured rows are supplied', () => {
    const result = validatePaymentSchedule(undefined, 1000, 250);
    assert.deepEqual(result, { valid: true, structured: false, milestones: [], bookingAmount: 250 });
});
