const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateRental, hasQuantityForPeriod } = require("../src/utils/rental");

test("rental amount uses unit duration and requested quantity", () => {
  const result = calculateRental({ price: 1200, rentalType: "weekly", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-09"), quantity: 2 });
  assert.deepEqual(result, { durationDays: 8, totalAmount: 4800 });
});

test("rental quote rejects invalid prices, periods, dates and quantities", () => {
  const validDates = { startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") };
  for (const input of [
    { price: 0, rentalType: "daily", quantity: 1, ...validDates },
    { price: Number.NaN, rentalType: "daily", quantity: 1, ...validDates },
    { price: 100, rentalType: "hourly", quantity: 1, ...validDates },
    { price: 100, rentalType: "daily", quantity: 0, ...validDates },
    { price: 100, rentalType: "daily", quantity: 1, startDate: validDates.endDate, endDate: validDates.startDate },
  ]) assert.throws(() => calculateRental(input));
});

test("availability counts overlapping paid and recent pending bookings only", () => {
  const startDate = new Date("2026-12-01"); const endDate = new Date("2026-12-05"); const now = new Date("2026-11-22T00:00:00Z");
  const bookings = [
    { startDate: new Date("2026-12-02"), endDate: new Date("2026-12-03"), quantity: 1, paymentStatus: "paid", status: "confirmed" },
    { startDate: new Date("2026-12-01"), endDate: new Date("2026-12-05"), quantity: 1, paymentStatus: "unpaid", status: "pending_payment", createdAt: now },
    { startDate: new Date("2026-12-01"), endDate: new Date("2026-12-05"), quantity: 5, paymentStatus: "paid", status: "cancelled" },
  ];
  assert.equal(hasQuantityForPeriod({ stock: 2, bookings, startDate, endDate, quantity: 1, now }), false);
  assert.equal(hasQuantityForPeriod({ stock: 2, bookings: bookings.slice(2), startDate, endDate, quantity: 2, now }), true);
});

test("availability treats adjacent dates as non-overlapping and releases expired holds", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const startDate = new Date("2026-12-04T00:00:00Z");
  const endDate = new Date("2026-12-06T00:00:00Z");
  const bookings = [
    { startDate: new Date("2026-12-02T00:00:00Z"), endDate: startDate, quantity: 1, paymentStatus: "paid", status: "confirmed" },
    { startDate, endDate, quantity: 1, paymentStatus: "unpaid", status: "pending_payment", createdAt: new Date(now.getTime() - 31 * 60 * 1000) },
  ];
  assert.equal(hasQuantityForPeriod({ stock: 1, bookings, startDate, endDate, quantity: 1, now }), true);
});
