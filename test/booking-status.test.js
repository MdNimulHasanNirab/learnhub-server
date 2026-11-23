const test = require("node:test");
const assert = require("node:assert/strict");
const { bookingStatusError } = require("../src/utils/booking-status");

test("only paid bookings can be marked completed", () => {
  assert.equal(bookingStatusError({ nextStatus: "completed", paymentStatus: "paid" }), null);
  assert.equal(bookingStatusError({ nextStatus: "completed", paymentStatus: "unpaid" }).status, 409);
});

test("booking status updates accept only completed or cancelled", () => {
  assert.equal(bookingStatusError({ nextStatus: "pending", paymentStatus: "paid" }).status, 400);
  assert.equal(bookingStatusError({ nextStatus: "cancelled", paymentStatus: "unpaid" }), null);
});
